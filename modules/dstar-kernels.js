"use strict";
/* ============================ D-STAR (JARL, GMSK 4800 Бод, 2FSK) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js), два уровня. Передача: битовая синхронизация 0101…, заголовок (синхро 15 бит + 660 бит FEC),
   голосовые кадры по 96 бит (72 бита AMBE + 24 бита медленных данных, каждый 21-й кадр — синхро 0x55 0x2D 0x16), конец 0x55 55 55 55 C8 7A.
   Заголовок: 41 байт (флаги 3, RPT2, RPT1, YOUR, MY 8+8+8+8, MY2 4, CRC-16 X.25) → свёртка K=3 → перемежение 24×28 → скремблер.
   Биты в байтах идут младшим первым; бит 1 — отрицательное отклонение. Медленные данные: текст (20 знаков), копия заголовка, GPS (NMEA).
   Голос AMBE не декодируется — отдаются сырые 9 байт кадра. Кодеры — для генератора и тестов (сверка с прошивкой и MMDVMHost). */

const DSTAR_BAUD=4800, DSTAR_FR=96, DSTAR_SUPER=21;
// синхро заголовка (хвост битовой синхронизации + 15 бит), синхро данных, конец передачи
const DSTAR_HDR_SYNC=fsk2Sync('010101010111011001010000',{kind:'hdr'});
const DSTAR_DAT_SYNC=fsk2Sync(bitsLsb([0x55,0x2D,0x16],3).join(''),{kind:'dat'});
const DSTAR_END=bitsLsb([0x55,0x55,0x55,0x55,0xC8,0x7A],6);
const DSTAR_SCR=[0,247,52,9,68,70,215,6,179,114,222,66,245,165,216,241,135,123,154,4,34,163,107,131,89,57,111,161,250,82,236,248,195,61,77,2,145,209,181,193,172,156,183,80,125,41,118,252,225,158,38,129,200,232,218,96,86,206,91,168,190,20,59,254,112,79,147,64,100,116,109,48,43,231,45,84,95,138,29,127,184,167,73,32,50,186,54,152,149,243,6];
const DSTAR_SLOW_SCR=[0x70,0x4F,0x93];
// перемежитель: i-й бит свёртки → позиция в блоке (байты по 8 бит, младший первым), первые 4 бита блока — хвост синхро
const DSTAR_IL=Array.from({length:660},(_,i)=>{ const c=i%24; return 4+((i/24)|0)+(c<=12 ? 28*c : 336+27*(c-12)); });

// CRC-16 X.25 (отражённый 0x8408, начальное значение и итог инвертируются), младший байт первым
function dstarCrc(b,n){ let c=0xFFFF; for(let i=0;i<n;i++){ c^=b[i]; for(let k=0;k<8;k++) c=(c&1) ? (c>>1)^0x8408 : c>>1; } return (~c)&0xFFFF; }
// свёртка K=3: g0 = d ⊕ d₂, g1 = d ⊕ d₁ ⊕ d₂; порядок вывода g1, g0
function dstarConvEnc(bits){
  const o=[]; let d1=0, d2=0;
  for(const d of bits){ o.push((d^d1^d2)&1, (d^d2)&1); d2=d1; d1=d; }
  return o;
}
function dstarConvDec(rx,n){                                       // rx — 2n принятых бит; путь заканчивается в состоянии 0 → {bits, err}
  let cost=[0,1e9,1e9,1e9]; const dec=[];
  for(let i=0;i<n;i++){
    const a=rx[2*i], b=rx[2*i+1], nc=[1e9,1e9,1e9,1e9], ds=new Uint8Array(4);
    for(let s=0;s<4;s++){
      if(cost[s]>=1e9) continue;
      const d1=s>>1, d2=s&1;
      for(let d=0;d<2;d++){
        const m=cost[s]+((d^d1^d2)!==a ? 1 : 0)+((d^d2)!==b ? 1 : 0), ns=(d<<1)|d1;
        if(m<nc[ns]){ nc[ns]=m; ds[ns]=s; }
      }
    }
    dec.push(ds); cost=nc;
  }
  const bits=new Uint8Array(n); let s=0;
  for(let i=n-1;i>=0;i--){ bits[i]=s>>1; s=dec[i][s]; }
  return {bits, err:cost[0]};
}
// заголовок 41 байт → 660 бит FEC в порядке передачи (после 24-символьного синхро)
function dstarHeaderEncode(h41){
  const coded=dstarConvEnc([...bitsLsb(h41,41),0,0]), out=new Uint8Array(664);
  for(let i=0;i<660;i++) out[DSTAR_IL[i]]=coded[i];
  for(let p=0;p<664;p++) out[p]^=(DSTAR_SCR[p>>3]>>(p&7))&1;
  return out.subarray(4);
}
function dstarHeaderDecode(sym){                                   // 660 бит → {h (41 байт), err, ok}
  const blk=new Uint8Array(664); blk.set(sym,4);
  for(let p=4;p<664;p++) blk[p]^=(DSTAR_SCR[p>>3]>>(p&7))&1;
  const rx=new Int8Array(660); for(let i=0;i<660;i++) rx[i]=blk[DSTAR_IL[i]];
  const r=dstarConvDec(rx,330), h=new Uint8Array(41);
  for(let i=0;i<41;i++) for(let j=0;j<8;j++) h[i]|=r.bits[8*i+j]<<j;
  return {h, err:r.err, ok:dstarCrc(h,39)===(h[39]|(h[40]<<8))};
}
const dstarText=(b,o,n)=>String.fromCharCode(...Array.from(b.subarray(o,o+n)).map(c=>(c&127)>=32 ? c&127 : 32)).trimEnd();
const dstarBytes=bits=>{ const r=new Uint8Array(bits.length>>3); for(let i=0;i<r.length;i++) for(let j=0;j<8;j++) r[i]|=bits[8*i+j]<<j; return r; };

/* ---- приёмник ---- */
const DSTAR_MISS=3;
function dstarEmit(P,L,out,kind,f,text){
  const r={t:Date.now(), src:'D-STAR', kind, ...f, text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}
FSK4.protos.dstar={
  id:'dstar', name:'D-STAR', baud:DSTAR_BAUD, alpha:.5, lp:4000, levels:2, thrAcq:1, thrLock:4, maxRq:.15, syncs:[DSTAR_HDR_SYNC,DSTAR_DAT_SYNC],
  init(P){
    P.now=0; P.eps=0; P.call=null; P.recent=[]; P.lastAct=0; P.sd=null; P.hdrSd=null; P.text=null; P.nmea='';
    P.st={frames:0, headers:0, voice:0, calls:0, texts:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; },
  lock(P,L,sync){
    P.st.locks++;
    if(sync.kind==='hdr'){ L.after=660; return {kind:'hdr', k:-1, first:true, blind:true, eps:P.eps, exp:L.next}; }
    L.after=2; P.sd=null;                                          // синхро данных: заголовка нет — кадры с 0-го
    return {kind:'dat', k:0, first:true, blind:true, eps:P.eps, exp:L.next};
  },
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head='D-STAR · '+(L ? (c ? 'call' : 'locked')+(L.g<0 ? ', inverted' : '') : 'searching sync')+(P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.frames+' frames · '+s.headers+' headers · '+s.voice+' voice · '+s.texts+' messages · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8),
      text:head+'\n'+cnt+'\n'+(c ? c.my+(c.my2 ? '/'+c.my2 : '')+' → '+c.your+(c.rpt1 ? ' · via '+c.rpt1+' / '+c.rpt2 : '') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*DSTAR_BAUD)*1000;
    if(L.k<0) return this.header(P,L,e,out);
    this.voice(P,L,e,out);
  },
  header(P,L,e,out){
    const F=fsk4Slice(L,e,24+660), sym=Uint8Array.from(F.subarray(24),d=>d>>1), r=dstarHeaderDecode(sym);
    if(!r.ok){ P.st.bad++; fsk4Drop(L); return; }
    const h=r.h;
    P.st.headers++; L.first=false; L.blind=false; P.lastAct=Date.now();
    this.setCall(P,L,out,{flags:bytesHex(h,0,3), rpt2:dstarText(h,3,8), rpt1:dstarText(h,11,8), your:dstarText(h,19,8), my:dstarText(h,27,8), my2:dstarText(h,35,4)},'header');
    // первый голосовой кадр заканчивается синхро данных — от него отсчитываем суперкадр
    L.k=0; P.sd=null; P.text=null; P.nmea='';
    L.next+=8*(660+DSTAR_FR); L.exp=L.next; L.after=2; L.best=99; L.bestRq=1e9;
  },
  setCall(P,L,out,f,by){
    const c=P.call;
    if(c && c.my===f.my && c.your===f.your && c.rpt1===f.rpt1) return;
    if(c) this.end(P,L,out,'new call');
    P.call={...f, t0:P.now, frames:0}; P.st.calls++;
    dstarEmit(P,L,out,'call',{from:f.my+(f.my2 ? '/'+f.my2 : ''), to:f.your, ...f, source:by},
      f.my+(f.my2 ? '/'+f.my2 : '')+' → '+f.your+(f.rpt1 ? ' · via '+f.rpt1+' / '+f.rpt2 : '')+' ('+by+')');
  },
  voice(P,L,e,out){
    const k=L.k, F=fsk4Slice(L,k===0 ? e-16 : e,DSTAR_FR), bits=Uint8Array.from(F,d=>d>>1), by=dstarBytes(bits);
    const synced=k>0 || L.first || L.best!==99;
    if(k===0){
      if(synced && !L.first){ L.miss=0; L.eps=P.eps=Math.max(-.002,Math.min(.002,L.eps+.5*(L.next-L.exp)/(8*DSTAR_FR*DSTAR_SUPER))); }   // сдвиг синхро → уход такта
      else if(!L.first && ++L.miss>DSTAR_MISS){ fsk4Drop(L); return; }
    }
    L.blind=k===0 && !synced;
    // конец передачи: 0x55 55 55 55 C8 7A на месте кадра
    let ed=0; for(let i=0;i<48;i++) ed+=bits[i]^DSTAR_END[i];
    if(ed<=6){ this.end(P,L,out,'end pattern'); fsk4Drop(L); return; }
    if(k===0){
      let d=0; for(let i=0;i<24;i++) d+=bits[72+i]^bitsLsb([0x55,0x2D,0x16],3)[i];
      if(d>4 && L.first){ fsk4Drop(L); return; }
      if(d<=4){ L.first=false; L.blind=false; }
    }
    P.lastAct=Date.now(); P.st.frames++;
    const c=P.call;
    if(c) c.frames++;
    out.voice.push({t:P.now, src:'D-STAR', kind:'ambe', n:k, from:c?c.my:null, to:c?c.your:null, ambe:bytesHex(by,0,9)});
    P.st.voice++;
    if(k>0) this.slow(P,L,out,by.subarray(9,12),k);
    if(k<DSTAR_SUPER-1){ L.k=k+1; L.after=Math.round(DSTAR_FR*(k+1)*(1+L.eps)*8)/8; }        // границы кадров — с поправкой на уход такта, с точностью до ⅛ символа
    else { L.next=Math.round(L.next+8*DSTAR_FR*DSTAR_SUPER*(1+L.eps)); L.exp=L.next; L.k=0; L.after=2; L.best=99; L.bestRq=1e9; }
  },
  // медленные данные: два кадра по 3 байта (скремблированы) → элемент из 6 байт: тип/длина + 5 байт
  slow(P,L,out,b3,k){
    const d=Uint8Array.from(b3,(v,i)=>v^DSTAR_SLOW_SCR[i]);
    if(k&1){ P.sd=d; return; }
    if(!P.sd) return;
    const el=u8cat(P.sd,d), type=el[0]&0xF0, n=el[0]&15;
    P.sd=null;
    if(type===0x40 && n<4){                                        // текст: 4 фрагмента по 5 знаков
      if(!P.text) P.text={m:0, b:new Uint8Array(20)};
      P.text.b.set(el.subarray(1,6),5*n); P.text.m|=1<<n;
      if(P.text.m===15){
        const t=dstarText(P.text.b,0,20);
        if(t && t!==P.lastText){ P.lastText=t; P.st.texts++; dstarEmit(P,L,out,'text',{message:t, from:P.call?P.call.my:null},'TEXT "'+t+'"'); }
        P.text=null;
      }
    } else if(type===0x30){                                        // GPS (NMEA): до n знаков за элемент
      P.nmea+=String.fromCharCode(...Array.from(el.subarray(1,1+Math.min(n,5))));
      const m=P.nmea.match(/\$G[PN][A-Z]{3},[^\r\n]*\*[0-9A-F]{2}/);
      if(m){ dstarEmit(P,L,out,'gps',{nmea:m[0], from:P.call?P.call.my:null},'GPS '+m[0]); P.nmea=''; }
      else if(P.nmea.length>120) P.nmea='';
    } else if(type===0x50){                                        // копия заголовка по 5 байт (для поздно подключившихся): выравнивание неизвестно — перебор
      P.hdrSd=(P.hdrSd||[]).concat(Array.from(el.subarray(1,6))).slice(-90);
      for(let o=0;o+41<=P.hdrSd.length && !P.call;o+=5){
        const h=Uint8Array.from(P.hdrSd.slice(o,o+41));
        h[0]&=0x68; h[1]=0; h[2]=0; for(let i=3;i<39;i++) h[i]&=0x7F;
        if(dstarCrc(h,39)===(h[39]|(h[40]<<8))){ this.setCall(P,L,out,{flags:bytesHex(h,0,3), rpt2:dstarText(h,3,8), rpt1:dstarText(h,11,8), your:dstarText(h,19,8), my:dstarText(h,27,8), my2:dstarText(h,35,4)},'slow data'); P.hdrSd=null; break; }
      }
    }
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    const dur=c.frames*.02;
    dstarEmit(P,L,out,'end',{from:c.my, to:c.your, seconds:+dur.toFixed(1), by},'END '+c.my+' → '+c.your+' · '+dur.toFixed(1)+' s ('+by+')');
    P.call=null;
  }};
FSK4.order.push('dstar');

/* ---- генератор ---- */
function dstarHeaderBytes(rpt2,rpt1,your,my,my2){
  const h=new Uint8Array(41), pad=(s,n)=>Uint8Array.from({length:n},(_,i)=>i<s.length ? s.charCodeAt(i) : 32);
  h.set(pad(rpt2,8),3); h.set(pad(rpt1,8),11); h.set(pad(your,8),19); h.set(pad(my,8),27); h.set(pad(my2,4),35);
  const c=dstarCrc(h,39); h[39]=c&255; h[40]=c>>8; return h;
}
// слоты медленных данных на 20 кадров суперкадра: текст «text» (4 элемента), заголовок или NMEA
function dstarSlowElements(text,hdr,gps){
  const els=[];
  for(let n=0;n<4;n++) els.push(Uint8Array.from([0x40|n,...Array.from({length:5},(_,i)=>text.charCodeAt(5*n+i)||32)]));
  if(hdr) for(let n=0;n<9;n++) els.push(Uint8Array.from([0x50|5,...Array.from({length:5},(_,i)=>hdr[5*n+i]||0)]));
  if(gps) for(let i=0;i<gps.length;i+=5){ const s=gps.slice(i,i+5); els.push(Uint8Array.from([0x30|s.length,...Array.from({length:5},(_,j)=>s.charCodeAt(j)||0)])); }
  return els;
}
function dstarScript(mode){
  const rnd=(()=>{ let x=0xD57A4; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&255; }; })();
  const hdr=dstarHeaderBytes('DB0XX  G','DB0XX  B','CQCQCQ','N0CALL','TEST');
  const bits=[];
  if(mode!=='late'){                                               // «поздний вход»: передача без заголовка — только кадры с синхро данных
    for(let i=0;i<64;i++) bits.push(i&1);                          // битовая синхронизация 0101…
    bits.length-=9; bits.push(...[...DSTAR_HDR_SYNC.bits].map(Number));   // синхро заголовка заканчивает битовую синхронизацию (24 бита включают её хвост)
    bits.push(...dstarHeaderEncode(hdr));
  }
  const els=mode==='gps' ? dstarSlowElements('',null,'$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M*47') : dstarSlowElements('Hello D-STAR world!!',hdr,null);
  const frames=mode==='late' ? 63 : 42;                            // два или три суперкадра
  for(let f=0;f<frames;f++){
    const k=f%DSTAR_SUPER, ambe=Uint8Array.from({length:9},rnd);
    bits.push(...bitsLsb(ambe,9));
    if(k===0) bits.push(...bitsLsb([0x55,0x2D,0x16],3));
    else {
      const el=els[(((f/DSTAR_SUPER)|0)*10+((k-1)>>1))%els.length], part=(k-1)&1 ? el.subarray(3,6) : el.subarray(0,3);
      bits.push(...bitsLsb(Uint8Array.from(part,(v,i)=>v^DSTAR_SLOW_SCR[i]),3));
    }
  }
  bits.push(...DSTAR_END);
  for(let i=0;i<48;i++) bits.push(0);
  return fsk4LevelsOf(Uint8Array.from([...new Array(60).fill(0),...bits.map(b=>b ? 2 : 0),...new Array(60).fill(0)]));
}
FSK4.gen['D-STAR voice']={baud:DSTAR_BAUD, alpha:.5, dev:1200, script:()=>dstarScript('text')};
FSK4.gen['D-STAR late entry (header in slow data)']={baud:DSTAR_BAUD, alpha:.5, dev:1200, script:()=>dstarScript('late')};
FSK4.gen['D-STAR GPS']={baud:DSTAR_BAUD, alpha:.5, dev:1200, script:()=>dstarScript('gps')};
