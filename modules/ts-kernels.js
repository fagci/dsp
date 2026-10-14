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
  return {profile, compat, level, w, h};
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
  }
  select(n){ this.sel=n|0; this.cur=null; for(const p of this.pids.values()){ p.chunks=[]; } this.vid.length=0; this.aud.length=0; }

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
    const body=p.subarray(o);
    if(pid===0){ this._psi(body,pusi,'pat'); return; }
    if(this.pmtPids.has(pid)){ this._psi(body,pusi,'pmt',pid); return; }
    const cur=this.cur;
    if(!cur || (pid!==cur.vpid && pid!==cur.apid)) return;
    let s=this.pids.get(pid); if(!s){ s={chunks:[], cc:-1, kind:pid===cur.vpid ? 'v' : 'a'}; this.pids.set(pid,s); }
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
    if(s.kind==='v') this._video(es,pts); else{ this.stat.apes=(this.stat.apes||0)+1; this.aud.push({pts, d:es, type:this.cur.atype}); }
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
      pr.vpid=0; pr.apid=0; pr.vtype=''; pr.atype='';
      while(i+5<=end){
        const st=s[i], ep=((s[i+1]&0x1f)<<8)|s[i+2], il=((s[i+3]&15)<<8)|s[i+4];
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
