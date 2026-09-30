"use strict";
/* ============================ dPMR (ETSI TS 102 658, 4FSK 2400 Бод, 6,25 кГц) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js). Разбор голосовых кадров по логике dsd-fme: синхро FS2 (12 дибитов) + 2 полукадра по 180 дибитов
   (CCH 36 + 4 канала TCH по 36), между ними цветовой код CC (12 дибитов). CCH: 72 бита → скремблер x⁹+x⁵+1 → перемежение 12×6 →
   6 слов Хэмминга (12,8) → 48 бит (номер кадра, 12 бит адреса, режим, версия, формат, срочность, медленные данные, CRC-7).
   Адрес вызываемого — в кадрах 0/1 суперкадра, вызывающего — в 2/3 (по 12 бит из двух CCH), 24 бита → 7 знаков. Голос AMBE не декодируется
   — отдаются сырые кадры TCH (72 бита). Заголовок (FS1: два слова HI по 60 дибитов, Хэмминг (12,8) ×10, CRC-8) и конец передачи (FS3) — по dsdcc; заголовок пакетных данных FS4 (та же структура HI0 / CC / HI1, ETSI TS 102 658 п. 5.4) — только он, пакетные кадры за ним не разбираются. Кодеры — для генератора и тестов. */

const DPMR_BAUD=2400, DPMR_UNIT=384;
const dpmrDib=s=>s.split('').map(c=>c==='1' ? '01' : c==='3' ? '11' : c==='0' ? '00' : '10').join('');
const DPMR_FS2=fsk4Sync(dpmrDib('113333131331'));
const DPMR_FS1=fsk4Sync(fsk4Bits('57FF5F75D577')), DPMR_FS4=fsk4Sync(fsk4Bits('FD55F5DF7FDD')), DPMR_FS3=fsk4Sync(dpmrDib('133131333311'));
// цветовые коды 0…63: 24 бита, младшие биты дибитов всегда 1
const DPMR_CC=[0x575F77,0x577577,0x57DD75,0x57F775,0x55577D,0x557D7D,0x55D57F,0x55FF7F,0x5F555F,0x5F7F5F,0x5FD75D,0x5FFD5D,0x5D5D55,0x5D7755,0x5DDF57,0x5DF557,
  0x775DD7,0x7777D7,0x77DFD5,0x77F5D5,0x7555DD,0x757FDD,0x75D7DF,0x75FDDF,0x7F57FF,0x7F7DFF,0x7FD5FD,0x7FFFFD,0x7D5FF5,0x7D75F5,0x7DDDF7,0x7DF7F7,
  0xD755F7,0xD77FF7,0xD7D7F5,0xD7FDF5,0xD55DFD,0xD577FD,0xD5DFFF,0xD5F5FF,0xDF5FDF,0xDF75DF,0xDFDDDD,0xDFF7DD,0xDD57D5,0xDD7DD5,0xDDD5D7,0xDDFFD7,
  0xF75757,0xF77D57,0xF7D555,0xF7FF55,0xF55F5D,0xF5755D,0xF5DD5F,0xF5F75F,0xFF5D7F,0xFF777F,0xFFDF7D,0xFFF57D,0xFD5575,0xFD7F75,0xFDD777,0xFDFD77];
const dpmrColor=bits24=>{ const v=(dmrNum(bits24,0,24)|0x555555)>>>0; return DPMR_CC.indexOf(v); };
// Хэмминг (12,8): проверочные биты H = [P | I₄]; синдром → позиция ошибки
const DPMR_H=[[1,0,1,0,1,1,0,0,1,0,0,0],[1,1,0,1,0,1,1,0,0,1,0,0],[1,1,1,0,1,0,1,1,0,0,1,0],[0,1,0,1,1,0,0,1,0,0,0,1]];
const DPMR_HC=(()=>{ const t=new Array(16).fill(-1); [0b1110,0b0111,0b1010,0b0101,0b1011,0b1100,0b0110,0b0011,0b1000,0b0100,0b0010,0b0001].forEach((s,i)=>t[s]=i); return t; })();
const DPMR_G=[[1,1,1,0],[0,1,1,1],[1,0,1,0],[0,1,0,1],[1,0,1,1],[1,1,0,0],[0,1,1,0],[0,0,1,1]];
function dpmrHamDec(w){                                            // 12 бит → {d (8), ok}
  let syn=0;
  for(let s=0;s<4;s++){ let p=0; for(let i=0;i<12;i++) p^=w[i]&DPMR_H[s][i]; syn|=p<<(3-s); }
  const o=Array.from(w); let ok=true;
  if(syn){ if(DPMR_HC[syn]<0) ok=false; else o[DPMR_HC[syn]]^=1; }
  return {d:o.slice(0,8), ok};
}
function dpmrHamEnc(d8){ const o=d8.slice(); for(let j=0;j<4;j++){ let p=0; for(let i=0;i<8;i++) p^=d8[i]&DPMR_G[i][j]; o.push(p); } return o; }
// скремблер x⁹+x⁵+1, начальное состояние — все единицы (XOR симметричен)
function dpmrScr(bits){
  const S=new Array(9).fill(1), o=new Uint8Array(bits.length);
  for(let i=0;i<bits.length;i++){ o[i]=bits[i]^S[0]; const t=S[4]^S[0]; for(let k=0;k<8;k++) S[k]=S[k+1]; S[8]=t; }
  return o;
}
const dpmrDeint=b=>{ const o=new Uint8Array(72); for(let i=0;i<12;i++) for(let j=0;j<6;j++) o[12*j+i]=b[6*i+j]; return o; };
const dpmrInter=o=>{ const b=new Uint8Array(72); for(let i=0;i<12;i++) for(let j=0;j<6;j++) b[6*i+j]=o[12*j+i]; return b; };
function dpmrCrc7(b,n){ let r=0; for(let i=0;i<n;i++){ r=(((r>>6)&1)^b[i]) ? ((r<<1)^0x09)&0x7F : (r<<1)&0x7F; } return r; }
// 72 бита CCH (в порядке приёма) → {bits (48), ok (CRC), ham (все слова исправимы)}
function dpmrCch(b72){
  const d=dpmrDeint(dpmrScr(b72)), bits=new Uint8Array(48); let ham=true;
  for(let i=0;i<6;i++){ const r=dpmrHamDec(Array.from(d.subarray(12*i,12*i+12))); ham=ham && r.ok; bits.set(r.d,8*i); }
  return {bits, ham, ok:dpmrCrc7(bits,41)===dmrNum(bits,41,7)};
}
function dpmrCchEncode(fn,id12,mode,ver,fmt,emerg,slow){
  const b=new Uint8Array(48), put=(v,n,o)=>{ for(let i=0;i<n;i++) b[o+i]=(v>>(n-1-i))&1; };
  put(fn,2,0); put(id12,12,2); put(mode,3,14); put(ver,2,17); put(fmt,2,19); b[21]=emerg; put(slow,18,23);
  put(dpmrCrc7(b,41),7,41);
  const w=[]; for(let i=0;i<6;i++) w.push(...dpmrHamEnc(Array.from(b.subarray(8*i,8*i+8))));
  return dpmrScr(dpmrInter(Uint8Array.from(w)));
}
// заголовок: слово HI — 60 дибитов → скремблер → перемежение 12·(i mod 10)+i/10 → 10 слов Хэмминга (12,8) → 80 бит: тип, адреса (24+24), режим, формат, CRC-8
function dpmrCrc8(b,n){ const w=Array.from(b.subarray(0,n)).concat(new Array(8).fill(0)); for(let i=0;i<n;i++) if(w[i]){ w[i]=0; w[i+6]^=1; w[i+7]^=1; w[i+8]^=1; } return w.slice(n); }
const DPMR_HTYPE=['communication start','connection request','unconnect request','ACK','system request','ACK reply','system delivery','status response','status request'];
const DPMR_MODE=['voice','voice + slow data','data 1','data 2','packet data','voice + data'];
function dpmrHi(b120){                                             // 120 принятых бит → {bits (80), ok, f}
  const d=dpmrScr(b120), bits=new Uint8Array(80); let ham=true;
  for(let w=0;w<10;w++){
    const cw=new Array(12); for(let k=0;k<12;k++) cw[k]=d[10*k+w];   // слово w: биты потока w, w+10, …
    const r=dpmrHamDec(cw); ham=ham && r.ok; bits.set(r.d,8*w);
  }
  const ok=dpmrCrc8(bits,72).join('')===Array.from(bits.subarray(72)).join('');
  const f={htype:dmrNum(bits,0,4), called:dpmrAiToStr(dmrNum(bits,4,24)), own:dpmrAiToStr(dmrNum(bits,28,24)), mode:dmrNum(bits,52,3), version:dmrNum(bits,55,2), format:dmrNum(bits,57,2), emergency:bits[59], info:dmrNum(bits,61,11)};
  return {bits, ok, ham, f};
}
function dpmrHiEncode(o){
  const b=new Uint8Array(80), put=(v,n,p)=>{ for(let i=0;i<n;i++) b[p+i]=Math.floor(v/Math.pow(2,n-1-i))&1; };
  put(o.htype,4,0); put(dpmrStrToAi(o.called),24,4); put(dpmrStrToAi(o.own),24,28); put(o.mode,3,52); put(o.version||0,2,55); put(o.format,2,57); put(o.emergency||0,1,59); put(o.info||0,11,61);
  b.set(dpmrCrc8(b,72),72);
  const st=new Uint8Array(120);
  for(let w=0;w<10;w++){ const cw=dpmrHamEnc(Array.from(b.subarray(8*w,8*w+8))); for(let k=0;k<12;k++) st[10*k+w]=cw[k]; }
  return dpmrScr(st);
}
// адрес (24 бита) ↔ 7 знаков: веса 1464100, 146410, 14641, 1331, 121, 11, 1; цифра 10 — «*»
const DPMR_W=[1464100,146410,14641,1331,121,11,1];
function dpmrAiToStr(v){ let s='', r=v; for(const w of DPMR_W){ const d=Math.floor(r/w); r%=w; s+=d===10 ? '*' : String(d); } return s; }
function dpmrStrToAi(s){ let v=0; for(let i=0;i<7;i++) v+=(s[i]==='*' ? 10 : +s[i])*DPMR_W[i]; return v; }

/* ---- приёмник ---- */
function dpmrEmit(P,L,out,kind,f,text){
  const r={t:Date.now(), src:'dPMR', kind, cc:P.cc, ...f, text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}
FSK4.protos.dpmr={
  id:'dpmr', name:'dPMR', baud:DPMR_BAUD, alpha:.2, lp:4500, levels:4, thrAcq:2, thrLock:5, maxRq:.15, syncs:[DPMR_FS2,DPMR_FS1,DPMR_FS4,DPMR_FS3],
  init(P){
    P.now=0; P.cc=null; P.called=null; P.calling=null; P.call=null; P.recent=[]; P.lastAct=0;
    P.st={units:0, headers:0, voice:0, cch:0, calls:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; },
  // какой синхрослов найден: FS2 — кадр данных, FS1 — заголовок (132 дибита), FS3 — конец передачи
  kind(L,bp){
    L.packet=bp===DPMR_FS4; L.kind=bp===DPMR_FS1 || L.packet ? 'head' : bp===DPMR_FS3 ? 'end' : 'unit';
    L.after=L.kind==='head' ? 132 : L.kind==='end' ? 1 : DPMR_UNIT-12;
  },
  lock(P,L,bp){ P.st.locks++; this.kind(L,bp); return {first:true, blind:true, kind:L.kind}; },
  resync(P,L,bp){ this.kind(L,bp); },
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head='dPMR · '+(L ? 'CC '+(P.cc==null ? '?' : P.cc)+(L.g<0 ? ', inverted' : '') : 'searching sync')+(P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.units+' payload units · '+s.headers+' headers · '+s.voice+' voice · '+s.cch+' CCH ok · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, cc:P.cc, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8),
      text:head+'\n'+cnt+'\n'+(c ? (c.from||'?')+' → '+(c.to||'?') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*DPMR_BAUD)*1000;
    const synced=L.first || L.best!==99;
    if(synced) L.miss=0; else if(++L.miss>2){ fsk4Drop(L); return; }
    L.blind=!synced;
    const kind=L.kind||'unit';
    if(kind==='end'){                                            // FS3: конец передачи (без проверки — по одному синхрослову ложный захват не принимаем)
      if(L.first || L.blind){ fsk4Drop(L); return; }
      P.lastAct=Date.now(); this.end(P,L,out,'FS3'); fsk4Drop(L); return;
    }
    if(kind==='head') return this.header(P,L,e,out);
    const F=fsk4Slice(L,e,DPMR_UNIT), bits=fsk4Unpack(F,0,DPMR_UNIT);
    const cch0=dpmrCch(bits.subarray(24,96)), cch1=dpmrCch(bits.subarray(408,480));
    const cc=dpmrColor(bits.subarray(384,408));
    if((L.first || L.blind) && !(cch0.ok || cch1.ok)){ fsk4Drop(L); return; }         // предварительный захват без верного CCH — ложный
    L.first=false; L.blind=false; P.lastAct=Date.now(); P.st.units++;
    if(cc>=0) P.cc=cc;
    if(cch0.ok) P.st.cch++; else P.st.bad++;
    if(cch1.ok) P.st.cch++; else P.st.bad++;
    // адреса: кадры 0/1 — вызываемый, 2/3 — вызывающий; по 12 бит из двух CCH
    const fn0=dmrNum(cch0.bits,0,2), fn1=dmrNum(cch1.bits,0,2);
    if(cch0.ok && cch1.ok){
      const id=(dmrNum(cch0.bits,2,12)<<12)|dmrNum(cch1.bits,2,12);
      if(fn0===0 && fn1===1) P.called=dpmrAiToStr(id);
      else if(fn0===2 && fn1===3) P.calling=dpmrAiToStr(id);
      const info={mode:dmrNum(cch0.bits,14,3), version:dmrNum(cch0.bits,17,2), format:dmrNum(cch0.bits,19,2), emergency:cch0.bits[21]};
      if(P.called!=null && P.calling!=null) this.setCall(P,L,out,P.calling,P.called,info);
    }
    for(let t=0;t<8;t++){
      const o=t<4 ? 96+72*t : 480+72*(t-4);
      out.voice.push({t:P.now, src:'dPMR', kind:'ambe', n:t, cc:P.cc, from:P.call?P.call.from:null, to:P.call?P.call.to:null, ambe:dmrHex(p25Bytes(bits.subarray(o,o+72)))});
      P.st.voice++;
    }
    L.next+=8*DPMR_UNIT; L.best=99; L.bestRq=1e9; L.kind='unit'; L.after=DPMR_UNIT-12;
  },
  // FS1 / FS4 + HI0 (60) + CC (12) + HI1 (60): оба слова несут одно и то же; дальше FS2 и кадры данных.
  // FS4 — FS1 с перевёрнутыми уровнями, поэтому синхрослово полярность не решает: слово читается как принято, а если CRC не сходится — в инвертированном
  // виде (тогда синхрослово другое, а спектр перевёрнут)
  header(P,L,e,out){
    const F=fsk4Slice(L,e,156), raw=fsk4Unpack(F,0,156);
    const read=b=>({h:[dpmrHi(b.subarray(48,168)), dpmrHi(b.subarray(192,312))], cc:dpmrColor(b.subarray(168,192))});
    let inv=false, r=read(raw), good=r.h.find(x=>x.ok);
    if(!good){ const b=raw.slice(); for(let i=0;i<b.length;i+=2) b[i]^=1; const r2=read(b), g2=r2.h.find(x=>x.ok); if(g2){ inv=true; r=r2; good=g2; } }
    const h=r.h, cc=r.cc, packet=inv ? !L.packet : L.packet;
    if((L.first || L.blind) && !good){ fsk4Drop(L); return; }
    if(inv) L.g=-L.g;
    L.first=false; L.blind=false; P.lastAct=Date.now(); P.st.headers++;
    if(cc>=0) P.cc=cc;
    if(good){
      const f=good.f, type=DPMR_HTYPE[f.htype]||'reserved', mode=DPMR_MODE[f.mode]||'reserved';
      dpmrEmit(P,L,out,'header',{htype:f.htype, type, from:f.own, to:f.called, mode:f.mode, modeName:mode, format:f.format, version:f.version, emergency:f.emergency, info:f.info, packet, both:h[0].ok && h[1].ok},
        (packet ? 'PACKET HEADER ' : 'HEADER ')+type+' '+f.own+' → '+f.called+' · '+mode+(P.cc!=null ? ' · CC '+P.cc : ''));
      if(!packet && (f.htype===0 || f.htype===5 || f.htype===6)) this.setCall(P,L,out,f.own,f.called,{mode:f.mode, format:f.format, version:f.version, emergency:f.emergency, source:'HEADER'});
    } else P.st.bad++;
    if(packet){ fsk4Drop(L); return; }                        // после FS4 идут пакетные кадры: не разбираются
    L.next+=8*(132+12); L.best=99; L.bestRq=1e9; L.kind='unit'; L.after=DPMR_UNIT-12;
  },
  setCall(P,L,out,from,to,info){
    const c=P.call;
    if(c && c.from===from && c.to===to) return;
    if(c) this.end(P,L,out,'new call');
    P.call={from, to, ...info, t0:P.now}; P.st.calls++;
    dpmrEmit(P,L,out,'call',{from, to, ...info, scrambler:info.version===3 ? 1 : 0},(info.emergency ? 'EMERGENCY ' : '')+from+' → '+to+(P.cc!=null ? ' · CC '+P.cc : '')+(info.version===3 ? ' · scrambled' : ''));
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    dpmrEmit(P,L,out,'end',{from:c.from, to:c.to, seconds:+((P.now-c.t0)/1000).toFixed(1), by},'END '+c.from+' → '+c.to+' ('+by+')');
    P.call=null;
  }};
FSK4.order.push('dpmr');

/* ---- генератор ---- */
function dpmrUnit(cch0,cch1,cc,rnd){
  const b=new Uint8Array(768);
  const fs=dpmrDib('113333131331').split('').map(Number); b.set(fs,0);
  b.set(cch0,24); b.set(cch1,408);
  const c24=DPMR_CC[cc]; for(let i=0;i<24;i++) b[384+i]=(c24>>(23-i))&1;
  for(let t=0;t<8;t++){ const o=t<4 ? 96+72*t : 480+72*(t-4); for(let i=0;i<72;i++) b[o+i]=rnd()&1; }
  return fsk4Dib(b);
}
function dpmrHeaderFrame(o,cc,fs4){
  const fs=Uint8Array.from(fsk4Bits(fs4 ? 'FD55F5DF7FDD' : '57FF5F75D577'),c=>+c), b=new Uint8Array(312); b.set(fs);
  const hi=dpmrHiEncode(o); b.set(hi,48); b.set(hi,192);
  const c24=DPMR_CC[cc]; for(let i=0;i<24;i++) b[168+i]=(c24>>(23-i))&1;
  return fsk4Dib(b);
}
function dpmrScript(){
  const rnd=(()=>{ let x=0xD9312A; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&255; }; })(), seq=[];
  const called=dpmrStrToAi('1234567'), calling=dpmrStrToAi('7654321');
  const cchs=(id,f0)=>[dpmrCchEncode(f0,id>>12,0,1,0,0,0), dpmrCchEncode(f0+1,id&4095,0,1,0,0,0)];
  seq.push(dpmrHeaderFrame({htype:0, called:'1234567', own:'7654321', mode:0, format:1},5));
  for(let n=0;n<6;n++){
    const [a,b]=cchs(n&1 ? calling : called, n&1 ? 2 : 0);
    seq.push(dpmrUnit(a,b,5,rnd));
  }
  seq.push(fsk4Dib(Uint8Array.from(dpmrDib('133131333311'),c=>+c)));                    // FS3: конец передачи
  return fsk4LevelsOf(p25Cat(new Uint8Array(40),...seq,new Uint8Array(40)));
}
function dpmrPacketScript(){
  return fsk4LevelsOf(p25Cat(new Uint8Array(40),dpmrHeaderFrame({htype:0, called:'2468135', own:'5312468', mode:4, format:1, version:1, emergency:1, info:0x2A5},9,true),new Uint8Array(40)));
}
FSK4.gen['dPMR packet data header (FS4)']={baud:DPMR_BAUD, alpha:.2, dev:350, script:dpmrPacketScript};
FSK4.gen['dPMR voice']={baud:DPMR_BAUD, alpha:.2, dev:350, script:dpmrScript};
