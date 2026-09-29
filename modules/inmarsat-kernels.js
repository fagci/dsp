"use strict";
/* ============================ Inmarsat STD-C (NCS / LES TDM, 1.5 ГГц) ============================
   Ядро IQK (страница и воркер), без DOM. По SatDump (GPLv3) plugins/inmarsat_support/stdc:
   decode_utils (синхрослово — из Scytale-C, перестановка, перемежение, скремблер), pkt_structs
   (дескрипторы, контрольная сумма), egc_parser. BPSK 1200 Бод, RRC α=0.6 (PSK Demodulator в режиме BPSK).
   Кадр 8.64 с: 64 строки × 162 символа; в строке 2 символа синхрослова и 160 данных; строки переставлены
   (строка i ← принятая (23·i) mod 64), данные перемежены по столбцам; свёрточный код K=7 r=1/2
   (полиномы 109, 79 — в обратном к CCSDS порядке), от нулевого состояния; 640 байт, каждый развёрнут
   по битам и инвертирован по скремблеру (по 4 байта на бит). Внутри — пакеты: дескриптор, данные,
   контрольная сумма (сумма и сумма сумм). EGC (SafetyNET / FleetNET) — широковещательные сообщения. */

const STDC_UW='0000011111101010110011011101101001001110001011110010100011000010';
const STDC_SCR='0000000100011100010010111000000110010010011011100100000101011011010110010110000111110110111101011101000100001101100011110011100110001011010010001010010101001110';
const STDC_SYMS=10368, STDC_ROW=162, STDC_BYTES=640, STDC_BAUD=1200;
function stdcRev8(b){ b=((b&0xF0)>>4)|((b&0x0F)<<4); b=((b&0xCC)>>2)|((b&0x33)<<2); return ((b&0xAA)>>1)|((b&0x55)<<1); }
// контрольная сумма пакета длиной len (последние 2 байта считаются нулями) → [старший, младший]
function stdcCrc(p,off,len){
  let c0=0, c1=0;
  for(let i=0;i<len;i++){ const b=i<len-2 ? p[off+i] : 0; c0=(c0+b)&0xFFFF; c1=(c1+c0)&0xFFFF; }
  return [(c0-c1)&0xFF, (c1-2*c0)&0xFF];
}
// совпадение синхрослова: по 2 символа в начале каждой из 64 строк; → [совпало, инверсия]
function stdcMatch(get){
  let nrm=0;
  for(let i=0;i<64;i++){ const u=STDC_UW.charCodeAt(i)-48;
    if((get(i*STDC_ROW)>0 ? 1 : 0)===u) nrm++;
    if((get(i*STDC_ROW+1)>0 ? 1 : 0)===u) nrm++; }
  return nrm>=64 ? [nrm,false] : [128-nrm,true];
}
// символы кадра в порядке приёма (плюс — бит 1) → 640 байт
function stdcDecodeFrame(sym){
  const dep=new Float32Array(STDC_SYMS), enc=new Float32Array(64*160);
  for(let i=0;i<64;i++) dep.set(sym.subarray(((i*23)%64)*STDC_ROW,((i*23)%64+1)*STDC_ROW),i*STDC_ROW);
  for(let r=0;r<64;r++) for(let c=0;c<160;c++) enc[c*64+r]=dep[r*STDC_ROW+c+2];
  // Витерби: первый символ пары — полином 109 (у нас CC_E2), второй — 79 (CC_E1); бит 0 — «+»
  const steps=enc.length/2, v=vitNew(steps,0);
  v.m.fill(-1e9); v.m[0]=0;
  for(let t=0;t<steps;t++) vitStep(v,-enc[2*t+1],-enc[2*t]);
  const bits=vitTrace(v), out=new Uint8Array(STDC_BYTES);
  for(let i=0;i<STDC_BYTES;i++){
    let b=0; for(let k=0;k<8;k++) b=(b<<1)|bits[8*i+k];
    out[i]=stdcRev8(b)^(STDC_SCR.charCodeAt(i>>2)===49 ? 0xFF : 0);
  }
  // ошибки перекодирования — оценка качества
  let r=0, e=0, n=0;
  for(let t=0;t<steps;t++){ r=((r<<1)|bits[t])&0x7F; if((CC_E2[r]>0)!==(-enc[2*t]>0)) e++; if((CC_E1[r]>0)!==(-enc[2*t+1]>0)) e++; n+=2; }
  return {bytes:out, ber:e/n};
}
// обратно (генератор): 640 байт → символы кадра в порядке передачи (±1, плюс — бит 1)
function stdcEncodeFrame(bytes){
  const bits=new Uint8Array(STDC_BYTES*8);
  for(let i=0;i<STDC_BYTES;i++){
    const b=stdcRev8(bytes[i]^(STDC_SCR.charCodeAt(i>>2)===49 ? 0xFF : 0));
    for(let k=0;k<8;k++) bits[8*i+k]=(b>>(7-k))&1;
  }
  const c=ccEncode({r:0},bits), enc=new Int8Array(c.length);
  for(let t=0;t<c.length/2;t++){ enc[2*t]=c[2*t+1] ? 1 : -1; enc[2*t+1]=c[2*t] ? 1 : -1; }   // 109, затем 79
  const dep=new Int8Array(STDC_SYMS), sym=new Int8Array(STDC_SYMS);
  for(let r=0;r<64;r++){ for(let cc=0;cc<160;cc++) dep[r*STDC_ROW+cc+2]=enc[cc*64+r]; }
  for(let i=0;i<64;i++){
    const j=(i*23)%64;
    sym.set(dep.subarray(i*STDC_ROW,(i+1)*STDC_ROW),j*STDC_ROW);
    const u=STDC_UW.charCodeAt(j)===49 ? 1 : -1; sym[j*STDC_ROW]=u; sym[j*STDC_ROW+1]=u;
  }
  return sym;
}

/* ---- пакеты ---- */
const STDC_SAT=['AOR-W','AOR-E','POR','IOR'];
const STDC_SERVICE={0x00:'All ships', 0x02:'FleetNET group call', 0x04:'SafetyNET: rectangular area', 0x11:'Inmarsat system message',
  0x13:'SafetyNET: coastal warning', 0x14:'SafetyNET: distress alert, circular area', 0x23:'EGC system message',
  0x24:'SafetyNET: circular area', 0x31:'SafetyNET: NAVAREA/METAREA', 0x33:'Download group identity',
  0x34:'SafetyNET: SAR, rectangular area', 0x44:'SafetyNET: SAR, circular area', 0x72:'FleetNET: chart correction',
  0x73:'SafetyNET: chart correction'};
const STDC_PRIO=['Routine','Safety','Urgency','Distress'];
function stdcAddrLen(code){ return {0x00:3, 0x11:4, 0x31:4, 0x02:5, 0x72:5, 0x13:6, 0x23:6, 0x33:6, 0x73:6, 0x04:7, 0x14:7, 0x24:7, 0x34:7, 0x44:7}[code] ?? 3; }
function stdcText(d,pres){
  let s='';
  for(const b of d){ const c=pres===7 ? b : b&0x7F; s+=c===10 || c===13 ? '\n' : c>=32 && c<127 ? String.fromCharCode(c) : ' '; }
  return s.replace(/\n\n+/g,'\n');
}
// дескриптор: короткий (0xxx llll), средний (10tt tttt, длина), длинный (11tt tttt, длина 16 бит)
function stdcDesc(p,o){
  const b=p[o];
  if(!(b>>7)) return {type:(b>>4)&7, len:(b&15)+1};
  if(b>>6===2) return {type:b&63, len:p[o+1]+2};
  return {type:b&63, len:((p[o+1]<<8)|p[o+2])+3};
}
// разбор кадра (или собранного многокадрового пакета): вызывает on(тип, пакет) для пакетов с верной суммой
function stdcPackets(st,p,len,on){
  let o=0;
  while(o<len){
    if(p[o]===0) return;
    const d=stdcDesc(p,o);
    if(d.len<3 || o+d.len>len){ st.badPkt++; return; }
    const sent=(p[o+d.len-2]<<8)|p[o+d.len-1], [c1,c2]=stdcCrc(p,o,d.len);
    if(sent && sent!==((c1<<8)|c2)){ st.badPkt++; o+=d.len; continue; }
    const q=p.subarray(o,o+d.len);
    if(d.type===0x3D){                               // начало многокадрового пакета
      const m=q[2], L=!(m>>7) ? (m&15)+1 : m>>6===2 ? q[3]+2 : 0;
      st.multi={buf:new Uint8Array(L), got:Math.min(L,d.len-4)};
      st.multi.buf.set(q.subarray(2,2+st.multi.got));
    } else if(d.type===0x3E){                        // продолжение
      const m=st.multi;
      if(m){ const n=Math.min(d.len-4,m.buf.length-m.got); m.buf.set(q.subarray(2,2+n),m.got); m.got+=n;
        if(m.got>=m.buf.length-2){ st.multi=null; stdcPackets(st,m.buf,m.buf.length,on); } }
    } else on(d.type,q);
    o+=d.len;
  }
}
function stdcState(){ return {badPkt:0, multi:null, egc:new Map(), bb:null}; }
// кадр → {bb, msgs: готовые EGC-сообщения}
function stdcParse(st,f){
  const msgs=[];
  stdcPackets(st,f,STDC_BYTES,(type,q)=>{
    if(type===0x07 && q.length>=14){                  // Bulletin Board
      st.bb={frame:(q[2]<<8)|q[3], chType:q[6]>>5, sat:(q[7]>>6)&3, les:q[7]&63, net:q[1]};
    } else if(type>=0x30 && type<=0x32 && q.length>10){   // EGC: одинарный заголовок или части двойного
      const code=q[2], cont=q[3]>>7, prio=(q[3]>>5)&3, seq=(q[4]<<8)|q[5], pno=q[6], pres=q[7], al=stdcAddrLen(code);
      if(8+al>=q.length-2) return;
      const text=stdcText(q.subarray(8+al,q.length-2),pres);
      let m=st.egc.get(seq);
      if(!m){ m={seq, code, prio, addr:[...q.subarray(8,8+al)], parts:new Map(), t:Date.now()}; st.egc.set(seq,m); }
      m.parts.set(pno*2+(type===0x32 ? 1 : 0),text);
      if(!cont && type!==0x31){                       // последняя часть: собрать по порядку номеров
        st.egc.delete(seq);
        msgs.push({seq, service:STDC_SERVICE[code]||('code 0x'+code.toString(16)), code, priority:STDC_PRIO[prio],
          text:[...m.parts.keys()].sort((a,b)=>a-b).map(k=>m.parts.get(k)).join('').trim()});
      }
    }
  });
  for(const [k,m] of st.egc) if(Date.now()-m.t>1800000) st.egc.delete(k);
  return {bb:st.bb, msgs};
}

/* ---- STD-C Decoder ---- */
// Мягкие символы BPSK (re) → синхрослово (≥ 120 из 128, как в SatDump; любая полярность) → кадр → пакеты.
IQK.stdcDecode={
  init(n){ n.ring=new Float32Array(STDC_SYMS); n.w=0; n.hold=0; n.st=stdcState(); n.frames=0; n.last=null; n.msgs=[]; n.uw=0; n.ber=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, text:null}; }
    const recs=[];
    for(const c of s.chunks){
      const x=c.re;
      for(let i=0;i<x.length;i++){
        n.ring[n.w%STDC_SYMS]=x[i]; n.w++;
        if(n.hold>0){ n.hold--; continue; }
        if(n.w<STDC_SYMS) continue;
        const b=n.w-STDC_SYMS, get=k=>n.ring[(b+k)%STDC_SYMS];
        const [m,inv]=stdcMatch(get);
        if(m<120){ if(n.w%STDC_ROW===0) n.uw=Math.max(n.uw*.9,m); continue; }
        n.uw=m;
        const sym=new Float32Array(STDC_SYMS);
        for(let k=0;k<STDC_SYMS;k++) sym[k]=inv ? -get(k) : get(k);
        const d=stdcDecodeFrame(sym), r=stdcParse(n.st,d.bytes);
        n.frames++; n.ber=d.ber; n.hold=STDC_SYMS-STDC_ROW;
        if(r.bb) n.last={...r.bb, satName:STDC_SAT[r.bb.sat]||'?'};
        const now=Date.now();
        for(const m of r.msgs){
          const rec={t:now, src:'STD-C', seq:m.seq, service:m.service, priority:m.priority, text:m.text};
          if(r.bb){ rec.sat=STDC_SAT[r.bb.sat]; rec.les=r.bb.les; }
          recs.push(rec); n.msgs.push(rec); if(n.msgs.length>20) n.msgs.shift();
        }
      }
    }
    n.ui={frames:n.frames, uw:Math.round(n.uw), ber:n.ber, bb:n.last, bad:n.st.badPkt, msgs:n.msgs.slice(-6), total:n.msgs.length};
    return {rec:recs.length ? recs : null, text:recs.length ? recs.map(r=>'['+r.priority+'] '+r.service+'\n'+r.text).join('\n\n') : null};
  }};

/* ---- генератор: несущая TDM STD-C ---- */
// Кадры подряд: Bulletin Board (номер кадра, IOR, LES 12) + части EGC-сообщений (SafetyNET, METAREA),
// по одной части на кадр; BPSK 1200 Бод с RRC α=0.6 (импульс — как у LRPT).
const STDC_SIM_MSGS=[
  'SECURITE\nMETAREA XI FORECAST 291200 UTC\nGALE WARNING: NORTHERN SEA OF JAPAN, NW WINDS 35 KT, SEAS 4 M, VIS POOR IN SNOW.\nNEXT BULLETIN 300000 UTC.',
  'NAVAREA XIII 0412/26\nSEA OF OKHOTSK. DERELICT VESSEL ADRIFT 54-12N 143-40E AT 290600 UTC. VESSELS IN VICINITY KEEP SHARP LOOKOUT AND REPORT.',
];
function stdcSimParts(){
  const parts=[];
  STDC_SIM_MSGS.forEach((t,mi)=>{
    const chunks=t.match(/[\s\S]{1,90}/g);
    chunks.forEach((c,k)=>parts.push({seq:0x1200+mi, pno:k+1, cont:k<chunks.length-1, text:c, prio:mi ? 1 : 2}));
  });
  return parts;
}
const STDC_SIM_PARTS=stdcSimParts();
function stdcSimFrame(k){
  const f=new Uint8Array(STDC_BYTES);
  const put=(o,q)=>{ const [a,b]=stdcCrc(q,0,q.length); q[q.length-2]=a; q[q.length-1]=b; f.set(q,o); return o+q.length; };
  const bb=new Uint8Array(14);
  bb.set([0x7D,1,(k>>8)&0xFF,k&0xFF,8<<2,0x10,(2<<5)|(1<<2),(3<<6)|12,0xE0,0x60,0x00,0x05]);
  let o=put(0,bb);
  const p=STDC_SIM_PARTS[k%STDC_SIM_PARTS.length], txt=[...p.text].map(c=>c==='\n' ? 13 : c.charCodeAt(0));
  const q=new Uint8Array(8+4+txt.length+2);
  q[0]=0xB0; q[1]=q.length-2; q[2]=0x31; q[3]=(p.cont ? 0x80 : 0)|(p.prio<<5)|1; q[4]=p.seq>>8; q[5]=p.seq&0xFF; q[6]=p.pno; q[7]=0;
  q.set([0x0B,0,0,0],8); q.set(txt,12);
  put(o,q);
  return f;
}
function stdcGenerate(n,sr,N){
  let g=n.stdc;
  if(!g || g.sr!==sr) g=n.stdc={sr, t:0, k0:0, sym:[], frame:0};
  const re=new Float32Array(N), im=new Float32Array(N), dt=STDC_BAUD/sr;
  for(let i=0;i<N;i++){
    const t=g.t, hi=Math.ceil(t)+LRPT_SPAN;
    while(g.k0+g.sym.length<=hi){ const s=stdcEncodeFrame(stdcSimFrame(g.frame++)); for(const v of s) g.sym.push(v); }
    let y=0;
    for(let k=Math.max(Math.floor(t)-LRPT_SPAN,g.k0);k<=hi;k++) y+=g.sym[k-g.k0]*lrptPulse(t-k);
    re[i]=y;
    g.t+=dt;
    const drop=Math.floor(g.t)-LRPT_SPAN-1-g.k0;
    if(drop>4096){ g.sym.splice(0,drop); g.k0+=drop; }
  }
  return [re,im];
}
