"use strict";
/* ============================ IQ в файлы: чистая логика ============================
   Без DOM и движка (её же гоняет tools/test-iqfiles.mjs). Выбор кусков потока для записи — по меткам декодера (голос DMR),
   по уровню go или всё подряд; упаковка в int16; имена файлов и описание записи для менеджера файлов.
   Узлы IQ Recorder / IQ File Player и сохранение в Files — в iqfiles.js. */

const IQF_VOICE_MS=60;          // голосовой пакет DMR на слот — 60 мс: окно метки тянется назад на столько же

// float → int16 с насыщением; I и Q чередуются
function iqfPack(re, im){
  const n=re.length, o=new Int16Array(2*n);
  for(let i=0;i<n;i++){
    let a=re[i]*32767, b=im ? im[i]*32767 : 0;
    o[2*i]=a>32767 ? 32767 : a<-32768 ? -32768 : a;
    o[2*i+1]=b>32767 ? 32767 : b<-32768 ? -32768 : b;
  }
  return o;
}

/* ---- выбор кусков ----
   Кольцо хранит последние чанки потока (int16). Решение по чанку откладывается на lag отсчётов: запись декодера
   приходит позже самих отсчётов. Метка — отрезок [a, b) в номерах отсчётов потока (как t0 чанков); у записей без
   номера отсчёта — по времени прихода чанка (мс). */
function iqfCutNew(){ return {ring:[], marks:[], end:0, gate:false}; }
function iqfCutReset(c){ c.ring=[]; c.marks=[]; c.end=0; }
function iqfCutMark(c, a, b, label){ if(b>a) c.marks.push({a, b, label:label||''}); }
// wall — время прихода чанка, мс
function iqfCutPush(c, t0, re, im, wall){
  const n=re.length;
  if(c.end && t0<c.end) iqfCutReset(c);               // поток начался заново
  c.ring.push({t0, n, a:iqfPack(re,im), wall});
  c.end=t0+n;
  if(c.gate) iqfCutMark(c, t0, t0+n, c.gateLabel);
}
function iqfCutGate(c, on, label){ c.gate=!!on; c.gateLabel=label||''; }
// запись декодера с номером отсчёта st (конец пакета) в потоке частоты sr; pad* — запас, мс
function iqfCutMarkAt(c, st, sr, padB, padA, label){
  const a=Math.round(st-(IQF_VOICE_MS+padB)*sr/1000), b=Math.round(st+padA*sr/1000);
  iqfCutMark(c, a, b, label);
}
// номер отсчёта правдоподобен для этого потока (запись пришла с того же провода)
function iqfCutHas(c, st, sr){
  const first=c.ring.length ? c.ring[0].t0 : c.end;
  return Number.isFinite(st) && st>=first-sr && st<=c.end+sr;
}
// без номера отсчёта — по времени (мс): чанки, пришедшие в [wa, wb]
function iqfCutMarkWall(c, wa, wb, label, sr){
  let prev=null;
  for(const ch of c.ring){
    const w1=ch.wall, w0=prev!=null ? prev : w1-ch.n/sr*1000;
    if(w1>=wa && w0<=wb) iqfCutMark(c, ch.t0, ch.t0+ch.n, label);
    prev=w1;
  }
}
// достаёт решённые чанки (старше lag отсчётов; flush — все); отдаёт куски в метках: {t0, n, a, wall, label}
function iqfCutTake(c, lag, flush, sr){
  const out=[], limit=flush ? Infinity : c.end-lag;
  while(c.ring.length && c.ring[0].t0+c.ring[0].n<=limit){
    const ch=c.ring.shift(), e=ch.t0+ch.n, iv=[];
    for(const m of c.marks){ const a=Math.max(m.a,ch.t0), b=Math.min(m.b,e); if(b>a) iv.push([a,b,m.label]); }
    iv.sort((x,y)=>x[0]-y[0]);
    const piece=v=>({t0:v[0], n:v[1]-v[0], a:ch.a.subarray(2*(v[0]-ch.t0), 2*(v[1]-ch.t0)), wall:ch.wall-(e-v[0])/sr*1000, label:v[2]});
    let cur=null;
    for(const v of iv){
      if(cur && v[0]<=cur[1]){ cur[1]=Math.max(cur[1],v[1]); if(!cur[2]) cur[2]=v[2]; }
      else{ if(cur) out.push(piece(cur)); cur=[v[0],v[1],v[2]]; }
    }
    if(cur) out.push(piece(cur));
  }
  const floor=c.ring.length ? c.ring[0].t0 : c.end;
  c.marks=c.marks.filter(m=>m.b>floor);
  return out;
}

/* ---- запись: куски → непрерывные сегменты ----
   rec = {parts:[Int16Array], n (отсчётов), segs:[{start, t, label}], last (номер отсчёта входа за концом прошлого куска)}.
   Новый сегмент — если кусок не продолжает предыдущий. Возвращает true, если начат новый. */
function iqfSegAdd(rec, p, data){
  const fresh=rec.last==null || p.t0!==rec.last;
  if(fresh) rec.segs.push({start:rec.n, t:p.wall, label:p.label||''});
  else if(p.label && !rec.segs[rec.segs.length-1].label) rec.segs[rec.segs.length-1].label=p.label;
  rec.last=p.t0+p.n;
  rec.parts.push(data); rec.n+=data.length>>1;
  return fresh;
}

/* ---- описание ---- */
const iqfTagList=s=>{
  const out=[];
  for(const t of (Array.isArray(s) ? s : String(s||'').split(/[,;\n]+/))){
    const v=String(t).trim().replace(/^#/,'').slice(0,40);
    if(v && !out.includes(v)) out.push(v);
  }
  return out;
};
function iqfFreq(hz){
  if(hz==null || !isFinite(hz)) return '';
  const a=Math.abs(hz);
  return a>=1e9 ? (hz/1e9).toFixed(5)+' GHz' : a>=1e6 ? (hz/1e6).toFixed(4)+' MHz' : a>=1e3 ? (hz/1e3).toFixed(3)+' kHz' : Math.round(hz)+' Hz';
}
function iqfRate(r){ return r>=1e6 ? +(r/1e6).toFixed(3)+' MS/s' : +(r/1e3).toFixed(r%1000 ? 1 : 0)+' kS/s'; }
function iqfDur(s){
  if(!(s>=0)) return '';
  if(s<60) return s.toFixed(s<10 ? 2 : 1)+' s';
  const t=Math.round(s), h=Math.floor(t/3600), m=Math.floor(t/60)%60, z=String(t%60).padStart(2,'0');
  return h ? h+':'+String(m).padStart(2,'0')+':'+z : m+':'+z;
}
const iqfBytes=b=>b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' KB' : b<1073741824 ? (b/1048576).toFixed(1)+' MB' : (b/1073741824).toFixed(2)+' GB';
// строка под именем в менеджере: частота · частота дискретизации · размер на диске · теги
function iqfSub(rec){
  const q=rec.meta?.iq; if(!q) return '';
  return [iqfFreq(q.freq), q.rate ? iqfRate(q.rate) : '', iqfBytes(rec.size||0), (rec.meta.tags||[]).map(t=>'#'+t).join(' ')].filter(Boolean).join(' · ');
}
const iqfStamp=d=>{ const p=v=>String(v).padStart(2,'0');
  return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate())+'_'+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds()); };
const iqfSafe=t=>(t||'').trim().replace(/[^\wЀ-ӿ-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40);
// имя: iq_<метка>_<частота>Hz_<дата>_<время>Z.wav | .sigmf
function iqfFileName(o){
  const wav=o.kind==='wav';
  return (wav ? 'baseband' : 'iq')+(o.label ? '_'+iqfSafe(o.label) : '')+'_'+Math.round(o.freq||0)+'Hz_'+iqfStamp(o.start)+'Z'+(wav ? '.wav' : '.sigmf');
}
// метаданные записи для менеджера: meta.iq — параметры сигнала, meta.tags — теги, meta.duration — длина (колонка размера)
function iqfMeta(o){
  const bps=4, seconds=o.rate>0 ? o.n/o.rate : 0;
  return {iq:{kind:o.kind, dtype:'ci16_le', rate:o.rate, freq:Math.round(o.freq||0), bw:o.bw||null, samples:o.n, seconds, src:o.src||'',
      start:o.start.toISOString(), segments:(o.segs||[]).slice(0,500).map(s=>({start:s.start, t:s.t, label:s.label||''}))},
    tags:iqfTagList(o.tags), note:o.note||'', duration:seconds, bytes:o.n*bps};
}
