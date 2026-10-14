"use strict";
/* ============================ MPEG-TS: демукс ============================
   Транспортный поток (DVB, файлы .ts) → PAT/PMT → PES выбранной программы → кадры видео и аудио.
   Видео: H.264 (Annex B), HEVC, MPEG-2. Аудио разбирается до пакетов (PTS, данные), декодирует его узел.
   Без DOM: файл грузит и тест (tools/test-ts.mjs). */

const TS_VTYPES={0x1b:'avc',0x24:'hevc',0x02:'mpeg2'};
const TS_ATYPES={0x0f:'aac',0x11:'aac-latm',0x03:'mp2',0x04:'mp2',0x81:'ac3',0x06:'private'};

// PES: PTS (90 кГц) → секунды; не 33-битное переполнение, а просто число
function tsPts(b,o){
  return ((b[o]&14)*536870912 + b[o+1]*4194304 + (b[o+2]>>1)*32768 + b[o+3]*128 + (b[o+4]>>1))/90000;
}

// SPS H.264 → {profile, compat, level, w, h}; ширина и высота с учётом обрезки. null, если не разобрать
function tsAvcSps(nal){
  if(nal.length<8) return null;
  const rb=[]; for(let i=1;i<nal.length;i++){                      // убрать emulation prevention (00 00 03)
    if(i>2 && nal[i]===3 && nal[i-1]===0 && nal[i-2]===0) continue; rb.push(nal[i]); }
  let pos=24;
  const bit=()=>{ const v=(rb[pos>>3]>>(7-(pos&7)))&1; pos++; return v; };
  const bits=n=>{ let v=0; while(n--) v=v*2+bit(); return v; };
  const ue=()=>{ let z=0; while(!bit()){ if(++z>32 || pos>rb.length*8) return 0; } return (2**z-1)+bits(z); };
  const se=()=>{ const k=ue(); return k&1 ? (k+1)/2 : -k/2; };
  const profile=rb[0], compat=rb[1], level=rb[2];
  ue();
  let chroma=1;
  if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
    chroma=ue(); if(chroma===3) bit(); ue(); ue(); bit();
    if(bit()) for(let i=0;i<(chroma!==3?8:12);i++) if(bit()){ let last=8,next=8; for(let j=0;j<(i<6?16:64);j++){
      if(next!==0) next=(last+se()+256)%256; last=next===0 ? last : next; } }
  }
  ue();
  const poc=ue();
  if(poc===0) ue(); else if(poc===1){ bit(); se(); se(); const n=ue(); for(let i=0;i<n;i++) se(); }
  ue(); bit();
  const mbw=ue()+1, mbh=ue()+1, frameMbs=bit();
  if(!frameMbs) bit();
  bit();
  let cl=0,cr=0,ct=0,cb=0;
  if(bit()){ cl=ue(); cr=ue(); ct=ue(); cb=ue(); }
  const cux=chroma===0||chroma===3 ? 1 : 2, cuy=(chroma===1 ? 2 : 1)*(2-frameMbs);
  const w=mbw*16-(cl+cr)*cux, h=(2-frameMbs)*mbh*16-(ct+cb)*cuy;
  if(!(w>0 && h>0 && w<=8192 && h<=8192)) return null;
  return {profile, compat, level, w, h, mbs:mbw*mbh*(2-frameMbs), mbw, mbh, frameMbs, crop:[cl,cr,ct,cb]};
}
// предел размера кадра уровня H.264 в макроблоках (MaxFS); заявленный уровень IPTV-потоков часто занижен
function tsAvcMaxFs(level){
  const t=[[10,99],[11,396],[13,396],[20,396],[21,792],[22,1620],[30,1620],[31,3600],[32,5120],[40,8192],[41,8192],[42,8704],[50,22080],[51,36864],[52,36864]];
  for(const [l,m] of t) if(level<=l) return m;
  return 139264;
}
// PES звука AAC (ADTS) → кадры без заголовка: [{d, sr, ch, asc, dt}] (dt — сдвиг по времени от PTS, с); asc — AudioSpecificConfig для декодера
const TS_AAC_SR=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
function tsAdtsSplit(es){
  const out=[]; let i=0, t=0;
  while(i+7<=es.length){
    if(es[i]!==0xff || (es[i+1]&0xf6)!==0xf0){ i++; continue; }
    const hl=(es[i+1]&1) ? 7 : 9, len=((es[i+3]&3)<<11)|(es[i+4]<<3)|(es[i+5]>>5);
    const sr=TS_AAC_SR[(es[i+2]>>2)&15], ch=((es[i+2]&1)<<2)|(es[i+3]>>6), obj=((es[i+2]>>6)&3)+1;
    if(!sr || len<hl || i+len>es.length) break;
    const idx=(es[i+2]>>2)&15;
    out.push({d:es.subarray(i+hl,i+len), sr, ch:ch||2, asc:new Uint8Array([(obj<<3)|(idx>>1), ((idx&1)<<7)|((ch||2)<<3)]), dt:t});
    t+=1024/sr; i+=len;
  }
  return out;
}
const tsHex2=v=>(v<16?'0':'')+v.toString(16);

// slice_type первого среза H.264 (NAL 1 или 5): после заголовка NAL идут first_mb_in_slice и slice_type, оба ue(v). I-срез: 2, 7 (и SI: 4, 9)
function tsAvcSliceType(nal){
  const rb=[]; for(let i=1;i<nal.length && rb.length<8;i++){ if(i>2 && nal[i]===3 && nal[i-1]===0 && nal[i-2]===0) continue; rb.push(nal[i]); }
  let pos=0;
  const bit=()=>{ const v=(rb[pos>>3]>>(7-(pos&7)))&1; pos++; return v; };
  const ue=()=>{ let z=0; while(!bit()){ if(++z>16 || pos>=rb.length*8) return -1; } let v=1; for(let i=0;i<z;i++) v=v*2+bit(); return v-1; };
  ue();
  return ue();
}

// Разбить Annex B на NAL: [{t, d}] (d — с начала NAL, без стартового кода)
function tsNals(d){
  const out=[]; let s=-1;
  for(let i=0;i+2<d.length;i++){
    if(d[i]===0 && d[i+1]===0 && d[i+2]===1){
      if(s>=0){ let e=i; if(e>s && d[e-1]===0) e--; out.push(d.subarray(s,e)); }
      s=i+3; i+=2; }
  }
  if(s>=0 && s<d.length) out.push(d.subarray(s));
  return out;
}


// Текст DVB (EN 300 468, приложение A): первый байт < 0x20 выбирает таблицу символов
function tsDvbText(b){
  if(!b.length) return '';
  let i=0, cs='latin';
  if(b[0]<0x20){
    i=1;
    if(b[0]===0x01) cs='8859-5';
    else if(b[0]===0x15) cs='utf8';
    else if(b[0]===0x11) cs='ucs2';
    else if(b[0]===0x10){ i=3; cs=b[2]===5 ? '8859-5' : 'latin'; }
  }
  let o='';
  if(cs==='ucs2'){ for(;i+1<b.length;i+=2){ const c=(b[i]<<8)|b[i+1]; if(c>=0xe080 && c<=0xe09f) continue; o+=c===0xe08a ? ' ' : String.fromCharCode(c); } return o.trim(); }
  if(cs==='utf8'){
    for(;i<b.length;){
      const c=b[i++];
      if(c<0x80){ o+=String.fromCharCode(c); continue; }
      let n=c>=0xf0 ? 3 : c>=0xe0 ? 2 : 1, v=c&(0x3f>>n);
      for(let k=0;k<n && i<b.length;k++) v=(v<<6)|(b[i++]&63);
      if(v>=0x80 && v<=0x9f) continue;                               // управляющие коды DVB (выделение, перенос)
      o+=String.fromCodePoint ? String.fromCodePoint(v) : '?';
    }
    return o.trim();
  }
  for(;i<b.length;i++){
    const c=b[i];
    if(c===0x8a){ o+=' '; continue; }
    if(c>=0x80 && c<=0x9f) continue;
    if(cs==='8859-5' && c>=0xa1){
      o+=String.fromCharCode(c===0xad ? 0xad : c===0xf0 ? 0x2116 : c===0xfd ? 0xa7 : 0x360+c);   // 0xA1 → Ё (0x401), 0xB0 → А (0x410)
    }else o+=String.fromCharCode(c);
  }
  return o.trim();
}
// MJD + BCD → «ГГГГ-ММ-ДД ЧЧ:ММ» (UTC)
function tsDvbTime(b,o){
  const mjd=(b[o]<<8)|b[o+1];
  const y0=Math.floor((mjd-15078.2)/365.25), m0=Math.floor((mjd-14956.1-Math.floor(y0*365.25))/30.6001);
  const d=mjd-14956-Math.floor(y0*365.25)-Math.floor(m0*30.6001), k=(m0===14||m0===15) ? 1 : 0;
  const y=1900+y0+k, m=m0-1-k*12, bcd=v=>(v>>4)*10+(v&15), p2=v=>(v<10 ? '0' : '')+v;
  return {y,m,d,h:bcd(b[o+2]),mi:bcd(b[o+3]),s:bcd(b[o+4]),
    str:y+'-'+p2(m)+'-'+p2(d)+' '+p2(bcd(b[o+2]))+':'+p2(bcd(b[o+3]))};
}
const TS_SVC_TYPES={1:'TV SD',2:'Radio',3:'Teletext',0x0a:'Radio',0x11:'TV MPEG-2 HD',0x16:'TV SD',0x19:'TV HD',0x1f:'TV UHD',0x0c:'Data'};
const TS_STREAM_NAMES={0x01:'MPEG-1 video',0x02:'MPEG-2 video',0x03:'MP2',0x04:'MP2',0x06:'private',0x0f:'AAC',0x11:'AAC-LATM',0x1b:'H.264',0x24:'HEVC',0x81:'AC-3',0x87:'E-AC-3'};


/* ---- Телетекст DVB (EN 300 472 в PES, страницы по EN 300 706) ---- */
const TTX_REV=(()=>{ const t=new Uint8Array(256); for(let i=0;i<256;i++){ let v=0; for(let k=0;k<8;k++) if(i&(1<<k)) v|=0x80>>k; t[i]=v; } return t; })();
const ttxUnham=b=>((b>>1)&1)|(((b>>3)&1)<<1)|(((b>>5)&1)<<2)|(((b>>7)&1)<<3);
// Кириллица G0 (вариант 1, как КОИ-7): 0x40–0x5F строчные, 0x60–0x7F прописные
const TTX_KOI='юабцдефгхийклмнопярстужвьызшэщчъЮАБЦДЕФГХИЙКЛМНОПЯРСТУЖВЬЫЗШЭЩЧЪ';
class TsTeletext{
  constructor(){ this.reset(); }
  reset(){ this.pages=new Map(); this.live=new Map(); this.units=0; this.rev=0; }
  // es: данные PES (data_identifier + блоки данных)
  feed(es){
    if(es.length<3 || es[0]<0x10 || es[0]>0x1f) return;
    for(let i=1;i+2<=es.length;){
      const id=es[i], len=es[i+1];
      if(i+2+len>es.length) break;
      if((id===0x02 || id===0x03) && len===44) this._unit(es.subarray(i+2,i+2+len));
      i+=2+len;
    }
  }
  _unit(u){
    const a0=ttxUnham(TTX_REV[u[2]]), a1=ttxUnham(TTX_REV[u[3]]);
    let mag=a0&7; if(mag===0) mag=8;
    const row=(a0>>3)|(a1<<1);
    const d=new Uint8Array(40); for(let k=0;k<40;k++) d[k]=TTX_REV[u[4+k]];
    this.units++;
    if(row===0){
      const un=ttxUnham(d[0]), te=ttxUnham(d[1]);
      const cur=this.live.get(mag); if(cur) this._commit(cur);
      if(un>9 || te>9){ this.live.delete(mag); return; }                // 0xFF: заполнитель, не страница
      const num=mag*100+te*10+un;
      const pg={num, sub:(ttxUnham(d[2])|(ttxUnham(d[3])&7)<<4)|((ttxUnham(d[4])|(ttxUnham(d[5])&3)<<4)<<8), rows:new Array(25).fill(null), erase:!!(ttxUnham(d[3])&8), sub6:!!(ttxUnham(d[5])&8), nat:(ttxUnham(d[7])>>1)&7};
      pg.rows[0]=d.subarray(8).map(c=>c&0x7f);
      this.live.set(mag,pg);
    }else if(row<=24){
      const pg=this.live.get(mag); if(!pg) return;
      pg.rows[row]=d.map(c=>c&0x7f);
    }
  }
  _commit(pg){
    const old=this.pages.get(pg.num);
    this.pages.set(pg.num,pg); this.rev++;
    if(old && old.sub!==pg.sub && !pg.erase) pg.rows.forEach((r,i)=>{ if(!r && old.rows[i]) pg.rows[i]=old.rows[i]; });
  }
  list(){ return [...this.pages.keys()].sort((a,b)=>a-b); }
  // Страница → сетка 25×40 клеток {c, fg, bg, m (мозаика: 0 нет, 1 сплошная, 2 раздельная), h (двойная высота)}
  render(num,cyr){
    const pg=this.pages.get(num); if(!pg) return null;
    const grid=[];
    for(let r=0;r<25;r++){
      const src= r===0 ? null : pg.rows[r];
      const row=[];
      let fg=7, bg=0, gfx=false, sep=false, dbl=false;
      if(r===0){
        const hd=('P'+num+'        ').slice(0,8), rs=pg.rows[0]||new Uint8Array(32);
        for(let k=0;k<8;k++) row.push({c:hd.charCodeAt(k), fg:7, bg:0, m:0, h:false});
        for(let k=0;k<32;k++) row.push({c:rs[k]<0x20 ? 0x20 : rs[k], fg:7, bg:0, m:0, h:false});
        grid.push(row); continue;
      }
      if(!src){ for(let k=0;k<40;k++) row.push({c:0x20, fg:7, bg:0, m:0, h:false}); grid.push(row); continue; }
      for(let k=0;k<40;k++){
        const c=src[k];
        if(c<0x20){
          if(c===0x1c) bg=0; else if(c===0x1d) bg=fg;                     // действуют сразу
          else if(c===0x19) sep=false; else if(c===0x1a) sep=true;
          else if(c===0x0c) dbl=false;
          row.push({c:0x20, fg, bg, m:0, h:dbl});
          if(c<8){ fg=c; gfx=false; }                                      // действуют со следующей клетки
          else if(c>=0x10 && c<=0x17){ fg=c-0x10; gfx=true; }
          else if(c===0x0d) dbl=true;
          continue;
        }
        const cell={c, fg, bg, m:0, h:dbl};
        if(gfx && ((c>=0x20 && c<=0x3f) || (c>=0x60 && c<=0x7f))){
          cell.m=sep ? 2 : 1; cell.c= c<0x60 ? c-0x20 : (c-0x60)|0x20;     // 6 бит: клетки 2×3
        }else if(cyr && c>=0x40) cell.c=TTX_KOI.charCodeAt(c-0x40);
        row.push(cell);
      }
      grid.push(row);
    }
    // двойная высота: следующая строка занята верхней/нижней половиной
    for(let r=1;r<24;r++) if(grid[r].some(c=>c.h)) grid[r+1]=grid[r+1].map(()=>({c:0x20,fg:7,bg:0,m:0,h:false,lower:true}));
    return grid;
  }
  text(num,cyr){
    const g=this.render(num,cyr); if(!g) return '';
    return g.map(r=>r.map(c=>c.m ? ' ' : String.fromCharCode(c.c)).join('').replace(/\s+$/,'')).join('\n').replace(/\n+$/,'');
  }
}

class TsDemux{
  constructor(){ this.reset(); }
  reset(){
    this.buf=new Uint8Array(0);
    this.pmtPids=new Map();                 // PID → program_number
    this.programs=new Map();                // номер → {pmt, vpid, apid, vtype, atype}
    this.pids=new Map();                    // PID → {chunks, cc, pts, kind}
    this.sel=0;                             // выбранная программа (0 — первая с видео)
    this.cur=null;
    this.vid=[]; this.aud=[];               // готовые кадры: {pts, key, d}
    this.stat={packets:0, lost:0, sync:0, cc:0, frames:0, bytes:0, tei:0, keys:0, idr:0, gaps:{}}; this.gap=0; this.al=false;
    this.sps=null; this.vcodec='';
    this.ttx=[]; this.sec=new Map();                     // PID → собираемая секция служебной таблицы
    this.svc=new Map(); this.events=new Map(); this.net={name:'',id:0,tsid:0,lcn:new Map(),freqs:[]}; this.utc=null; this.pidN=new Map(); this.pidBytes=new Map(); this.t0=0; this.sdtDone=false;
  }
  select(n){ this.sel=n|0; this.cur=null; for(const p of this.pids.values()){ p.chunks=[]; } this.vid.length=0; this.aud.length=0; this.ttx.length=0; }

  // Подать байты; возвращает число принятых пакетов
  push(chunk){
    let b=chunk;
    if(this.buf.length){ b=new Uint8Array(this.buf.length+chunk.length); b.set(this.buf); b.set(chunk,this.buf.length); }
    let i=0, n=0;
    // Пакет идёт сразу за предыдущим (this.al) — его достаточно узнать по 0x47. После лишних байт между пакетами (RTL2832U отдаёт USB-пакетами
    // по 512 байт: два TS-пакета и остаток) границей считается 0x47, за которым через 188 байт снова 0x47.
    while(i+188<=b.length){
      let take=false, wait=false;
      if(b[i]===0x47){
        if(this.al) take=true;
        else if(i+189<=b.length) take= b[i+188]===0x47;
        else wait=true;                                                // кандидат у края порции: ждём следующую
      }
      if(take){
        if(this.gap>0){                                                // между пакетами были лишние байты — запомнить их число
          this.stat.sync++;
          const g=this.stat.gaps, k=this.gap>4096 ? 'big' : String(this.gap);
          if(k in g || Object.keys(g).length<8) g[k]=(g[k]||0)+1; else g.other=(g.other||0)+1;
          this.gap=0;
        }
        this._pkt(b.subarray(i,i+188)); i+=188; n++; this.al=true;
      }else if(wait) break;
      else{ this.al=false; i++; this.gap++; }
    }
    this.buf=b.slice(i);
    this.stat.bytes+=chunk.length;
    return n;
  }

  _pkt(p){
    this.stat.packets++;
    const pusi=!!(p[1]&0x40), pid=((p[1]&0x1f)<<8)|p[2], afc=(p[3]>>4)&3, cc=p[3]&15;
    if(p[1]&0x80){                                                     // ошибка транспорта (демодулятор не исправил пакет)
      this.stat.tei++; const bs=this.pids.get(pid); if(bs) bs.bad=true; return; }
    let o=4;
    if(afc&2) o+=1+p[4];
    if(!(afc&1) || o>=188) return;
    if(pid===0x1fff) return;
    this.pidN.set(pid,(this.pidN.get(pid)||0)+1);
    const body=p.subarray(o);
    if(pid===0x10 || pid===0x11 || pid===0x12 || pid===0x14){ this._sect(pid,body,pusi,cc); return; }
    if(pid===0){ this._psi(body,pusi,'pat'); return; }
    if(this.pmtPids.has(pid)){ this._psi(body,pusi,'pmt',pid); return; }
    const cur=this.cur;
    if(!cur || (pid!==cur.vpid && pid!==cur.apid && pid!==cur.tpid)) return;
    let s=this.pids.get(pid); if(!s){ s={chunks:[], cc:-1, kind:pid===cur.vpid ? 'v' : pid===cur.tpid ? 't' : 'a'}; this.pids.set(pid,s); }
    if(s.cc>=0 && (afc&1) && cc!==((s.cc+1)&15)){ if(cc!==s.cc){ this.stat.cc++; s.bad=true; } else return; } // повтор — отбросить
    s.cc=cc;
    if(pusi){ this._flush(s); s.bad=false; }
    if(s.chunks.length || pusi) s.chunks.push(body.slice());
  }

  // PES целиком → один кадр
  _flush(s){
    if(!s.chunks.length) return;
    let n=0; for(const c of s.chunks) n+=c.length;
    const d=new Uint8Array(n); let o=0; for(const c of s.chunks){ d.set(c,o); o+=c.length; }
    s.chunks=[];
    if(s.bad){ if(s.kind==='v') this.lostVideo=true; return; }       // кадр потерян: следующие ссылаются на него
    if(n<9 || d[0]!==0 || d[1]!==0 || d[2]!==1) return;
    const hl=d[8], hasPts=(d[7]&0x80)!==0;
    if(9+hl>n) return;
    const pts=hasPts && hl>=5 ? tsPts(d,9) : -1, es=d.subarray(9+hl);
    if(s.kind==='v') this._video(es,pts); else if(s.kind==='t') this.ttx.push(es); else{ this.stat.apes=(this.stat.apes||0)+1; this.aud.push({pts, d:es, type:this.cur.atype}); }
  }

  _video(es,pts){
    const t=this.cur.vtype;
    let key=false, idr=false; const nalTypes=[];
    if(t==='avc'){
      let hasSps=false, hasPps=false, sliceSeen=false;
      for(const nal of tsNals(es)){
        const k=nal[0]&31; nalTypes.push(k);
        if(k===7){ hasSps=true; this.spsNal=nal.slice();
          if(!this.sps){ const sp=tsAvcSps(nal); if(sp){ this.sps=sp; this.vcodec='avc1.'+tsHex2(sp.profile)+tsHex2(sp.compat)+tsHex2(sp.level); } } }
        else if(k===8){ hasPps=true; this.ppsNal=nal.slice(); }
        else if(k===5){ key=true; idr=true; sliceSeen=true; }
        else if(k===1 && !sliceSeen){                                  // вещание часто начинает GOP не с IDR, а с обычного I-кадра
          sliceSeen=true; const st=tsAvcSliceType(nal); if(st===2 || st===7 || st===4 || st===9) key=true;
        }
      }
      // точка входа без SPS / PPS в этом же кадре: декодер без описания их не знает — взять последние виденные
      if(key && (!hasSps || !hasPps) && this.spsNal && this.ppsNal){
        const pre=[]; for(const n of [hasSps ? null : this.spsNal, hasPps ? null : this.ppsNal]) if(n) pre.push(0,0,0,1,...n);
        const o=new Uint8Array(pre.length+es.length); o.set(pre); o.set(es,pre.length); es=o;
      }
    }else if(t==='hevc'){
      for(const nal of tsNals(es)){ const k=(nal[0]>>1)&63; if(k>=16 && k<=21) key=true; }
      this.vcodec='hev1.1.6.L93.B0';
    }else{
      for(let i=0;i+5<es.length && i<es.length;i++)
        if(es[i]===0 && es[i+1]===0 && es[i+2]===1 && es[i+3]===0){ key=((es[i+5]>>3)&7)===1; break; }
      this.vcodec='mpeg2video';
    }
    if(t!=='avc') idr=key;
    this.vid.push({pts, key, idr, nals:key ? nalTypes : null, d:es}); this.stat.frames++; if(key) this.stat.keys++; if(idr) this.stat.idr++;
  }


  // Служебные таблицы DVB: NIT (0x10), SDT (0x11), EIT (0x12), TDT / TOT (0x14); секция может занимать несколько пакетов
  _sect(pid,body,pusi,cc){
    let st=this.sec.get(pid);
    if(st && cc!==((st.cc+1)&15)){ this.sec.delete(pid); st=null; }
    if(pusi){
      if(!body.length) return;
      const ptr=body[0];
      if(st && ptr>0) this._secAdd(pid,st,body.subarray(1,1+ptr));
      this.sec.delete(pid);
      let d=body.subarray(1+ptr);
      while(d.length>=3 && d[0]!==0xff){
        const tot=(((d[1]&15)<<8)|d[2])+3;
        if(d.length>=tot){ this._table(pid,d.subarray(0,tot)); d=d.subarray(tot); }
        else{ this.sec.set(pid,{buf:d.slice(), need:tot, cc}); break; }
      }
    }else if(st) this._secAdd(pid,st,body,cc);
  }
  _secAdd(pid,st,body,cc){
    const nb=new Uint8Array(st.buf.length+body.length); nb.set(st.buf); nb.set(body,st.buf.length); st.buf=nb;
    if(cc!==undefined) st.cc=cc;
    if(st.buf.length>=st.need){ this.sec.delete(pid); this._table(pid,st.buf.subarray(0,st.need)); }
  }
  _table(pid,s){
    const t=s[0];
    try{
      if(pid===0x10 && t===0x40) this._nit(s);
      else if(pid===0x11 && t===0x42) this._sdt(s);
      else if(pid===0x12 && (t===0x4e || (t>=0x50 && t<=0x5f))) this._eit(s);
      else if(pid===0x14 && (t===0x70 || t===0x73) && s.length>=8){
        const tm=tsDvbTime(s,3); this.utc=tm; this.utcMs=Date.UTC(tm.y,tm.m-1,tm.d,tm.h,tm.mi,tm.s);
        if(t===0x73){
          let i=10; const end=Math.min(s.length-4, i+(((s[8]&15)<<8)|s[9]));
          while(i+2<=end){ const dt=s[i], dl=s[i+1];
            if(dt===0x58 && dl>=13){ const b=v=>(v>>4)*10+(v&15); this.offMin=(s[i+6]&1 ? -1 : 1)*(b(s[i+7])*60+b(s[i+8])); }
            i+=2+dl; }
        }
      }
    }catch(e){}
  }
  _nit(s){
    const net=this.net; net.id=(s[3]<<8)|s[4];
    let i=8; const nl=((s[i]&15)<<8)|s[i+1]; i+=2;
    for(let k=i;k+2<=i+nl;){ if(s[k]===0x40) net.name=tsDvbText(s.subarray(k+2,k+2+s[k+1])); k+=2+s[k+1]; }
    i+=nl;
    const tl=((s[i]&15)<<8)|s[i+1]; i+=2; const end=Math.min(i+tl,s.length-4);
    while(i+6<=end){
      const tsid=(s[i]<<8)|s[i+1], dl=((s[i+4]&15)<<8)|s[i+5]; i+=6;
      for(let k=i;k+2<=i+dl && k+2<=s.length;){
        const dt=s[k], l=s[k+1];
        if(dt===0x5a && l>=11){ const f=((s[k+2]<<24)|(s[k+3]<<16)|(s[k+4]<<8)|s[k+5])>>>0; const mhz=f/100000; if(!net.freqs.some(x=>Math.abs(x.mhz-mhz)<.01)) net.freqs.push({tsid, mhz}); }
        else if(dt===0x7f && l>=7 && s[k+2]===0x04 && l>4){                // T2: частоты по ячейкам
          const tfs=s[k+7]&1; let q=k+8; const e2=k+2+l;
          while(q+6<=e2){
            const fl=[];
            if(tfs){ const n2=s[q+2]; for(let z=0;z<n2 && q+3+z*4+4<=e2;z+=4) fl.push(((s[q+3+z]<<24)|(s[q+4+z]<<16)|(s[q+5+z]<<8)|s[q+6+z])>>>0); q+=3+n2; }
            else{ fl.push(((s[q+2]<<24)|(s[q+3]<<16)|(s[q+4]<<8)|s[q+5])>>>0); q+=6; }
            for(const f of fl){ const mhz=f/100000; if(mhz>30 && !net.freqs.some(x=>Math.abs(x.mhz-mhz)<.01)) net.freqs.push({tsid, mhz, t2:true}); }
            if(q>=e2) break;
            q+=1+s[q];
          }
        }
        else if(dt===0x83){ for(let q=k+2;q+4<=k+2+l;q+=4){ const sid=(s[q]<<8)|s[q+1]; if(s[q+2]&0x80) net.lcn.set(sid,((s[q+2]&3)<<8)|s[q+3]); } }
        k+=2+l;
      }
      i+=dl;
    }
  }
  _sdt(s){
    this.net.tsid=(s[3]<<8)|s[4];
    let i=11; const end=s.length-4;
    while(i+5<=end){
      const sid=(s[i]<<8)|s[i+1], fl=s[i+3], dl=((fl&15)<<8)|s[i+4];
      const v=this.svc.get(sid) || {sid, type:0, name:'', provider:''};
      v.run=fl>>5; v.ca=!!(fl&0x10);
      for(let k=i+5;k+2<=i+5+dl && k+2<=s.length;){
        const dt=s[k], l=s[k+1];
        if(dt===0x48 && l>=3){ v.type=s[k+2]; const pl=s[k+3]; v.provider=tsDvbText(s.subarray(k+4,k+4+pl)); const nl=s[k+4+pl]; v.name=tsDvbText(s.subarray(k+5+pl,k+5+pl+nl)); }
        k+=2+l;
      }
      this.svc.set(sid,v); i+=5+dl;
    }
    this.sdtDone=true;
  }
  _eit(s){
    if(s.length<18) return;
    const sid=(s[3]<<8)|s[4], num=s[6], pf=s[0]===0x4e;
    let m=this.events.get(sid); if(!m){ m=new Map(); this.events.set(sid,m); }
    let i=14; const end=s.length-4;
    while(i+12<=end){
      const id=(s[i]<<8)|s[i+1], tm=tsDvbTime(s,i+2), dur=((s[i+7]>>4)*10+(s[i+7]&15))*60+((s[i+8]>>4)*10+(s[i+8]&15));
      const dl=((s[i+10]&15)<<8)|s[i+11], run=s[i+10]>>5;
      const ev={id, sid, start:tm.str, ms:Date.UTC(tm.y,tm.m-1,tm.d,tm.h,tm.mi,tm.s), min:dur, run, name:'', text:'', pf:pf ? (num===0 ? 'now' : 'next') : ''};
      for(let k=i+12;k+2<=i+12+dl && k+2<=s.length;){
        const dt=s[k], l=s[k+1];
        if(dt===0x4d && l>=5){ const nl=s[k+5]; ev.name=tsDvbText(s.subarray(k+6,k+6+nl)); const tl=s[k+6+nl]; ev.text=tsDvbText(s.subarray(k+7+nl,k+7+nl+tl)); }
        k+=2+l;
      }
      const old=m.get(id); if(old && !ev.name) ev.name=old.name;
      if(pf) for(const [k2,e2] of m) if(e2.pf===ev.pf) e2.pf='';          // у службы только один «сейчас» и один «следом»
      m.set(id,ev); i+=12+dl;
      if(m.size>96){ const f=[...m.keys()][0]; m.delete(f); }
    }
  }

  _psi(body,pusi,kind,pid){
    if(!pusi) return;                                                  // секции длиннее пакета не собираем: PAT/PMT мелкие
    const o=1+body[0];
    if(o+8>body.length) return;
    const s=body.subarray(o), len=((s[1]&15)<<8)|s[2];
    if(len+3>s.length || len<9) return;
    if(kind==='pat' && s[0]===0){
      for(let i=8;i+4<=3+len-4;i+=4){
        const num=(s[i]<<8)|s[i+1], p=((s[i+2]&0x1f)<<8)|s[i+3];
        if(num!==0){ this.pmtPids.set(p,num); if(!this.programs.has(num)) this.programs.set(num,{num, pmt:p, vpid:0, apid:0}); }
      }
    }else if(kind==='pmt' && s[0]===2){
      const num=(s[3]<<8)|s[4], pr=this.programs.get(num) || {num, pmt:pid, vpid:0, apid:0};
      const pil=((s[10]&15)<<8)|s[11];
      let i=12+pil; const end=3+len-4;
      pr.vpid=0; pr.apid=0; pr.vtype=''; pr.atype=''; pr.es=[]; pr.tpid=0; pr.pcr=((s[8]&0x1f)<<8)|s[9];
      while(i+5<=end){
        const st=s[i], ep=((s[i+1]&0x1f)<<8)|s[i+2], il=((s[i+3]&15)<<8)|s[i+4];
        const e={pid:ep, type:st, name:TS_STREAM_NAMES[st]||('0x'+st.toString(16)), lang:''};
        for(let k=i+5; k+2<=i+5+il; ){                                  // дескрипторы ES: язык, AC-3, телетекст, субтитры
          const dt=s[k], dl=s[k+1];
          if((dt===0x0a || dt===0x56 || dt===0x59) && dl>=3) e.lang=String.fromCharCode(s[k+2],s[k+3],s[k+4]);
          if(dt===0x6a) e.name='AC-3'; else if(dt===0x7a) e.name='E-AC-3'; else if(dt===0x7b) e.name='DTS';
          else if(dt===0x56) e.name='teletext'; else if(dt===0x59) e.name='subtitles';
          k+=2+dl;
        }
        pr.es.push(e);
        if(e.name==='teletext' && !pr.tpid) pr.tpid=ep;
        if(TS_VTYPES[st] && !pr.vpid){ pr.vpid=ep; pr.vtype=TS_VTYPES[st]; }
        else if(TS_ATYPES[st] && !pr.apid && st!==6){ pr.apid=ep; pr.atype=TS_ATYPES[st]; }
        i+=5+il;
      }
      this.programs.set(num,pr);
    }else return;
    if(!this.cur || (this.sel && this.cur.num!==this.sel)){
      let pick=null;
      if(this.sel) pick=this.programs.get(this.sel);
      else for(const pr of this.programs.values()) if(pr.vpid){ pick=pr; break; }
      if(pick && pick.vpid){ this.cur=pick; }
    }else if(this.cur){ const pr=this.programs.get(this.cur.num); if(pr && pr.vpid) this.cur=pr; }
  }

  // Дослать последний PES (конец файла)
  flush(){
    if(this.buf.length===188 && this.buf[0]===0x47){ this._pkt(this.buf); this.buf=new Uint8Array(0); }       // последний пакет файла
    for(const s of this.pids.values()) this._flush(s);
  }
  // Забрать накопленные кадры
  takeVideo(){ const v=this.vid; this.vid=[]; return v; }
  takeAudio(){ const v=this.aud; this.aud=[]; return v; }
  takeTtx(){ const v=this.ttx; this.ttx=[]; return v; }
  list(){ return [...this.programs.values()].filter(p=>p.vpid || p.apid); }
}

// Раскладка потока: серии пакетов через 188 байт и лишние байты между сериями. → [{packets, gap, count}], частые первыми.
// «2 пакета + 136 байт» — USB-пакеты по 512 байт; «много пакетов + 0» — сплошной поток.
function tsLayout(b){
  const L=b.length, h=new Map();
  let p=0, total=0;
  while(p+189<=L && !(b[p]===0x47 && b[p+188]===0x47)) p++;
  let first=true;
  while(p+189<=L){
    let n=0;
    while(p+188<=L && b[p]===0x47 && (n>0 || (p+189<=L && b[p+188]===0x47))){ n++; p+=188; }
    if(n===0) break;
    total+=n;
    let q=p;
    while(q+189<=L && !(b[q]===0x47 && b[q+188]===0x47)) q++;
    if(q+189>L) break;
    const key=(n>40 ? 40 : n)+'/'+(q-p);
    h.set(key,(h.get(key)||0)+1);
    p=q;
  }
  const res=[...h.entries()].map(([k,c])=>{ const [a,g]=k.split('/'); return {packets:+a, gap:+g, count:c}; }).sort((x,y)=>y.count-x.count).slice(0,5);
  res.total=total;                                                   // всего пакетов, найденных подряд
  return res;
}
