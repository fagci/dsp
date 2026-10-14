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
    this.stat={packets:0, lost:0, sync:0, cc:0, frames:0, bytes:0};
    this.sps=null; this.vcodec='';
  }
  select(n){ this.sel=n|0; this.cur=null; for(const p of this.pids.values()){ p.chunks=[]; } this.vid.length=0; this.aud.length=0; }

  // Подать байты; возвращает число принятых пакетов
  push(chunk){
    let b=chunk;
    if(this.buf.length){ b=new Uint8Array(this.buf.length+chunk.length); b.set(this.buf); b.set(chunk,this.buf.length); }
    let i=0, n=0;
    for(;;){
      while(i<b.length && b[i]!==0x47) i++;                           // поиск синхробайта
      if(i+188>b.length) break;
      // три подряд идущих 0x47 через 188 — настоящая синхронизация
      if((i+188<b.length && b[i+188]!==0x47) || (i+376<b.length && b[i+376]!==0x47)){ i++; this.stat.sync++; continue; }
      this._pkt(b.subarray(i,i+188)); i+=188; n++;
    }
    this.buf=b.slice(i);
    this.stat.bytes+=chunk.length;
    return n;
  }

  _pkt(p){
    this.stat.packets++;
    if(p[1]&0x80) return;                                              // ошибка транспорта
    const pusi=!!(p[1]&0x40), pid=((p[1]&0x1f)<<8)|p[2], afc=(p[3]>>4)&3, cc=p[3]&15;
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
    if(s.bad || n<9 || d[0]!==0 || d[1]!==0 || d[2]!==1) return;
    const hl=d[8], hasPts=(d[7]&0x80)!==0;
    if(9+hl>n) return;
    const pts=hasPts && hl>=5 ? tsPts(d,9) : -1, es=d.subarray(9+hl);
    if(s.kind==='v') this._video(es,pts); else this.aud.push({pts, d:es, type:this.cur.atype});
  }

  _video(es,pts){
    const t=this.cur.vtype;
    let key=false;
    if(t==='avc'){
      for(const nal of tsNals(es)){
        const k=nal[0]&31;
        if(k===7 && !this.sps){ const sp=tsAvcSps(nal); if(sp){ this.sps=sp;
          this.vcodec='avc1.'+tsHex2(sp.profile)+tsHex2(sp.compat)+tsHex2(sp.level); } }
        if(k===5) key=true;
      }
    }else if(t==='hevc'){
      for(const nal of tsNals(es)){ const k=(nal[0]>>1)&63; if(k>=16 && k<=21) key=true; }
      this.vcodec='hev1.1.6.L93.B0';
    }else{
      for(let i=0;i+5<es.length && i<es.length;i++)
        if(es[i]===0 && es[i+1]===0 && es[i+2]===1 && es[i+3]===0){ key=((es[i+5]>>3)&7)===1; break; }
      this.vcodec='mpeg2video';
    }
    this.vid.push({pts, key, d:es}); this.stat.frames++;
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
  flush(){ for(const s of this.pids.values()) this._flush(s); }
  // Забрать накопленные кадры
  takeVideo(){ const v=this.vid; this.vid=[]; return v; }
  takeAudio(){ const v=this.aud; this.aud=[]; return v; }
  list(){ return [...this.programs.values()].filter(p=>p.vpid || p.apid); }
}
