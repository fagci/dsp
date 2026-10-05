"use strict";
/* ============================ Yaesu System Fusion (YSF, C4FM 4800 Бод) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js). Кадр 480 дибитов (100 мс): синхро 40 бит (D471C9634D) + FICH 200 бит + 5 блоков по 144 бита.
   FICH: 4 слова Golay(24,12) (32 бита полей + CRC-16) → свёртка K=5 (как у NXDN) → перемежение. Данные (позывные): DCH — свёртка,
   перемежение, CRC-16, отбеливание; V/D режим 1 — по 9 байт в блоке (20 байт данных), режим 2 — по 5 байт (10 байт).
   Голос AMBE не декодируется — отдаются сырые кадры. GPS (радио + широта / долгота) — из блоков данных FN 3…FT (V/D 1) или FN 6, 7 (V/D 2). Кодеры — для генератора и тестов (сверка с MMDVMHost). */

const YSF_BAUD=4800, YSF_FR=480, YSF_SYNC=fsk4Sync(fsk4Bits('D471C9634D'));
const YSF_WH=[0x93,0xD7,0x51,0x21,0x9C,0x2F,0x6C,0xD0,0xEF,0x0F,0xF8,0x3D,0xF1,0x73,0x20,0x94,0xED,0x1E,0x7C,0xD8];
const YSF_FI=['header','communications','terminator','test'], YSF_DT=['V/D mode 1','data FR','V/D mode 2','voice FR'];
// перемежители: пары бит по (rows×cols) — n(i) = 2·строка + 40·столбец; для VCH — поразрядный 26×4
const ysfIl=(cols,rows)=>Array.from({length:cols*rows},(_,i)=>2*((i/cols)|0)+40*(i%cols));
const YSF_IL5=ysfIl(5,20), YSF_IL9=ysfIl(9,20), YSF_IL26=Array.from({length:104},(_,i)=>4*(i%26)+((i/26)|0));

function ysfDeint(bits,off,il,steps){                              // → принятые биты (пары) для свёрточного декодера
  const rx=new Int8Array(2*steps);
  for(let i=0;i<steps;i++){ const n=off+il[i]; rx[2*i]=bits[n]; rx[2*i+1]=bits[n+1]; }
  return rx;
}
function ysfInter(coded,il,out,off){                               // coded — 2·steps бит → out[off + il[i]], +1
  for(let i=0;i<coded.length/2;i++){ const n=off+il[i]; out[n]=coded[2*i]; out[n+1]=coded[2*i+1]; }
}
/* ---- FICH ---- */
function ysfFichDecode(bits){                                      // bits — 200 бит FICH (после синхро) → {f (6 байт), err} или null
  const r=nxdnConvDec(ysfDeint(bits,0,YSF_IL5,100),100), w=[];
  for(let i=0;i<4;i++){ const g=m17GolayDec(bitsNum(r.bits,24*i,24)); if(!g) return null; w.push(g.v); }
  const f=Uint8Array.of(w[0]>>4, ((w[0]<<4)&0xF0)|(w[1]>>8), w[1]&255, w[2]>>4, ((w[2]<<4)&0xF0)|(w[3]>>8), w[3]&255);
  if(dmrCrc16(f,4)!==f[4]*256+f[5]) return null;
  return {f, err:r.err};
}
function ysfFichEncode(f4){                                        // 4 байта полей → 200 бит
  const f=new Uint8Array(6); f.set(f4); const c=dmrCrc16(f,4); f[4]=c>>8; f[5]=c&255;
  const b=[(f[0]<<4)|(f[1]>>4), ((f[1]&15)<<8)|f[2], (f[3]<<4)|(f[4]>>4), ((f[4]&15)<<8)|f[5]], bits=new Uint8Array(100);
  for(let i=0;i<4;i++){ const g=m17Golay(b[i]); for(let k=0;k<24;k++) bits[24*i+k]=(g>>(23-k))&1; }
  const out=new Uint8Array(200); ysfInter(nxdnConvEnc(bits),YSF_IL5,out,0);
  return out;
}
const ysfFich=f=>({fi:f[0]>>6, cs:(f[0]>>4)&3, cm:(f[0]>>2)&3, bn:f[0]&3, bt:f[1]>>6, fn:(f[1]>>3)&7, ft:f[1]&7, dev:(f[2]>>6)&1, mr:(f[2]>>3)&7, dt:f[2]&3, sql:f[3]>>7, dgid:f[3]&127});
/* ---- каналы данных: pieces — куски по (72 | 40) бита из блоков, склеенные ---- */
function ysfDchGather(bits,base,len){                              // 5 блоков по len бит с начала каждого 144-битного блока
  const o=new Uint8Array(5*len);
  for(let k=0;k<5;k++) o.set(bits.subarray(base+144*k,base+144*k+len),len*k);
  return o;
}
function ysfDchDecode(bits,base,mode){                             // mode 1: 20 байт (9 байт в блоке), mode 2: 10 байт (5 байт) → байты (уже без отбеливания) или null
  const n=mode===1 ? 20 : 10, len=mode===1 ? 72 : 40, il=mode===1 ? YSF_IL9 : YSF_IL5, steps=(n+2)*8+4;
  const r=nxdnConvDec(ysfDeint(ysfDchGather(bits,base,len),0,il,steps),steps), by=bytesFromBits(r.bits.subarray(0,(n+2)*8));
  if(dmrCrc16(by,n)!==by[n]*256+by[n+1]) return null;
  return by.map((v,i)=>i<n ? v^YSF_WH[i] : v).subarray(0,n);
}
function ysfDchEncode(data,mode,out,base){                         // data: 20 или 10 байт → out (биты кадра) в блоки
  const n=mode===1 ? 20 : 10, len=mode===1 ? 72 : 40, il=mode===1 ? YSF_IL9 : YSF_IL5, w=new Uint8Array(n+2);
  for(let i=0;i<n;i++) w[i]=data[i]^YSF_WH[i];
  const c=dmrCrc16(w,n); w[n]=c>>8; w[n+1]=c&255;
  const src=new Uint8Array((n+2)*8+4); src.set(bitsMsb(w));
  const coded=nxdnConvEnc(src), ch=new Uint8Array(coded.length); ysfInter(coded,il,ch,0);
  for(let k=0;k<5;k++) out.set(ch.subarray(len*k,len*k+len),base+144*k);
}
// 13 байт голосового канала V/D режима 2 (после снятия перемежения и отбеливания)
function ysfVch(bits,base){ const v=new Uint8Array(104); for(let i=0;i<104;i++) v[i]=bits[base+YSF_IL26[i]]; const by=bytesFromBits(v); return by.map((x,i)=>x^YSF_WH[i]); }
function ysfVchEncode(b13,out,base){ const v=bitsMsb(b13.map((x,i)=>x^YSF_WH[i])); for(let i=0;i<104;i++) out[base+YSF_IL26[i]]=v[i]; }
const ysfText=b=>String.fromCharCode(...Array.from(b).map(c=>c>=32 && c<127 ? c : 32)).trim();

/* ---- GPS из канала данных (V/D 1: FN 3…FT по 20 байт, V/D 2: FN 6, 7 по 10 байт); разбор как в YSFGateway/GPS.cpp ---- */
const YSF_RADIO={0x20:'DR-2X',0x24:'FT-1D',0x25:'FTM-400D',0x26:'DR-1X',0x27:'FT-991A',0x28:'FT-2D',0x29:'FTM-100D',0x30:'FT-3D',0x31:'FTM-300D',0x33:'FT-5D'};
function ysfGps(b,len){                                            // b — собранные данные, len — их длина → {lat, lon, radio} или null
  let e=-1;
  for(let i=len;i>0;i--) if(b[i]===3){ e=i; break; }
  if(e<0 || e+1>=b.length) return null;
  let sum=0; for(let i=0;i<=e;i++) sum=(sum+b[i])&255;
  if(sum!==b[e+1]) return null;
  if(!((b[1]===0x22 && b[2]===0x62) || (b[1]===0x47 && b[2]===0x64))) return null;
  for(let i=5;i<11;i++){ const h=b[i]&0xF0; if(h!==0x50 && h!==0x30) return null; }
  const d=i=>(b[i]&15), two=i=>[(b[i]&15),(b[i+1]&15)];
  if(two(5).some(v=>v>9) || two(7).some(v=>v>9) || (b[9]&15)>9 || (b[10]&15)>10) return null;
  const latDeg=d(5)*10+d(6), latMin=d(7)*10+d(8), latFr=d(9)*10+d(10);
  if(latDeg>89 || latMin>59 || latFr>99) return null;
  const latSign=(b[8]&0xF0)===0x50 ? 1 : -1;
  let lonDeg, v=b[11];
  if((b[9]&0xF0)===0x50){
    if(v>=0x76 && v<=0x7F) lonDeg=v-0x76; else if(v>=0x6C && v<=0x75) lonDeg=100+v-0x6C; else if(v>=0x26 && v<=0x6B) lonDeg=110+v-0x26; else return null;
  } else { if(v>=0x26 && v<=0x7F) lonDeg=10+v-0x26; else return null; }
  v=b[12]; let lonMin;
  if(v>=0x58 && v<=0x61) lonMin=v-0x58; else if(v>=0x26 && v<=0x57) lonMin=10+v-0x26; else return null;
  v=b[13]; if(v<0x1C || v>0x7F) return null;
  const lonFr=v-0x1C, lonSign=(b[10]&0xF0)===0x30 ? 1 : -1;
  return {lat:+(latSign*(latDeg+(latMin+latFr*.01)/60)).toFixed(5), lon:+(lonSign*(lonDeg+(lonMin+lonFr*.01)/60)).toFixed(5), radio:YSF_RADIO[b[4]]||('0x'+b[4].toString(16).toUpperCase())};
}
function ysfGpsPack(lat,lon,radio){                                // обратное — для генератора (короткий пакет, 16 байт)
  const b=new Uint8Array(20), la=Math.abs(lat), lo=Math.abs(lon);
  const lt=Math.round(la*6000), ln=Math.round(lo*6000);              // сотые доли минуты
  const ld=(lt/6000)|0, lm=((lt%6000)/100)|0, lf=lt%100, od=(ln/6000)|0, om=((ln%6000)/100)|0, of=ln%100;
  b[1]=0x22; b[2]=0x62; b[4]=radio;
  b[5]=0x30|((ld/10)|0); b[6]=0x30|(ld%10); b[7]=0x30|((lm/10)|0); b[8]=(lat>=0 ? 0x50 : 0x30)|(lm%10);
  b[9]=(od<10 || od>=100 ? 0x50 : 0x30)|((lf/10)|0); b[10]=(lon>=0 ? 0x30 : 0x50)|(lf%10);
  b[11]=od<10 ? 0x76+od : od<110 && od>=100 ? 0x6C+od-100 : od>=110 ? 0x26+od-110 : 0x26+od-10;
  b[12]=om<10 ? 0x58+om : 0x26+om-10; b[13]=0x1C+of; b[14]=3;
  let c=0; for(let i=0;i<15;i++) c=(c+b[i])&255;
  b[15]=c; return b;
}
function ysfGpsFeed(P,F,d,out){                                    // d — один блок данных (уже без отбеливания)
  const m2=F.dt===2, first=m2 ? 6 : 3, sz=m2 ? 10 : 20;
  if(F.fn<first || F.fn>7) return;
  if(!P.gps || F.fn===first) P.gps={b:new Uint8Array(m2 ? 20 : 100), got:0};
  P.gps.b.set(d,(F.fn-first)*sz); P.gps.got|=1<<(F.fn-first);
  if(F.fn!==F.ft || P.gps.got!==(1<<(F.fn-first+1))-1) return;
  const g=ysfGps(P.gps.b,(F.fn-first+1)*sz), c=P.call;
  if(!g || (c && c.gpsLat===g.lat && c.gpsLon===g.lon)) return;
  if(c){ c.gpsLat=g.lat; c.gpsLon=g.lon; }
  ysfEmit(P,null,out,'gps',{from:c?c.src:null, to:c?c.dst:null, ...g, dgid:F.dgid},'GPS '+(c&&c.src||'?')+' · '+g.lat.toFixed(5)+', '+g.lon.toFixed(5)+' · '+g.radio);
}

/* ---- приёмник ---- */
const YSF_MISS=2;
function ysfEmit(P,L,out,kind,f,text){
  const r={t:Date.now(), kind, ...f, src:'YSF', text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}
FSK4.protos.ysf={
  id:'ysf', name:'YSF', baud:YSF_BAUD, alpha:.2, lp:5500, levels:4, thrAcq:3, thrLock:7, maxRq:.15, syncs:[YSF_SYNC],
  init(P){
    P.now=0; P.call=null; P.recent=[]; P.lastAct=0; P.dest=null; P.source=null;
    P.st={frames:0, header:0, comm:0, term:0, voice:0, calls:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; },
  lock(P,L){ P.st.locks++; L.after=YSF_FR-20; return {first:true, blind:true}; },
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head='YSF · '+(L ? (P.dgid!=null ? 'DG-ID '+P.dgid : 'locked')+(L.g<0 ? ', inverted' : '') : 'searching sync')+(P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.frames+' frames · '+s.header+' headers · '+s.voice+' voice · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8),
      text:head+'\n'+cnt+'\n'+(c ? (c.src||'?')+' → '+(c.dst||'?')+(c.downlink ? ' · ↓ '+c.downlink : '')+(c.uplink ? ' · ↑ '+c.uplink : '') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*YSF_BAUD)*1000;
    const synced=L.first || L.best!==99;
    if(synced) L.miss=0; else if(++L.miss>YSF_MISS){ fsk4Drop(L); return; }
    L.blind=!synced;
    const bits=fsk4Unpack(fsk4Slice(L,e,YSF_FR),0,YSF_FR), fich=ysfFichDecode(bits.subarray(40,240));
    if(!fich){ if(L.blind || L.first){ fsk4Drop(L); return; } P.st.bad++; }
    else { L.blind=false; L.first=false; P.lastAct=Date.now(); this.payload(P,L,bits,fich,out); }
    P.st.frames++;
    L.next+=8*YSF_FR; L.best=99; L.bestRq=1e9;
  },
  payload(P,L,bits,fich,out){
    const F=ysfFich(fich.f), base=240;
    P.dgid=F.dgid;
    const setCall=(f)=>{
      const c=P.call;
      if(c && c.src===f.src && c.dst===f.dst) { Object.assign(c,f); return; }
      if(c) this.end(P,L,out,'new call');
      P.call={...f, dgid:F.dgid, t0:P.now}; P.st.calls++;
      ysfEmit(P,L,out,'call',{from:f.src, to:f.dst, ...f, dgid:F.dgid, dtype:YSF_DT[F.dt], source:YSF_FI[F.fi]},
        (f.src||'?')+' → '+(f.dst||'?')+' · '+YSF_DT[F.dt]+' · DG-ID '+F.dgid+(f.downlink ? ' · ↓ '+f.downlink : '')+(f.uplink ? ' · ↑ '+f.uplink : ''));
    };
    if(F.fi===0 || F.fi===2){                                     // заголовок / терминатор: CSD1 (dest, src) и CSD2 (downlink, uplink)
      const d1=ysfDchDecode(bits,base,1), d2=ysfDchDecode(bits,base+72,1);
      if(F.fi===0){ P.st.header++; if(d1) setCall({dst:ysfText(d1.subarray(0,10)), src:ysfText(d1.subarray(10,20)), downlink:d2 ? ysfText(d2.subarray(0,10)) : undefined, uplink:d2 ? ysfText(d2.subarray(10,20)) : undefined}); else P.st.bad++; }
      else { P.st.term++; this.end(P,L,out,'terminator'); }
      return;
    }
    P.st.comm++;
    if(F.dt===2){                                                 // V/D режим 2: DCH — 10 байт на кадр (FN 0 — dest, 1 — src, 2 — downlink, 3 — uplink)
      const d=ysfDchDecode(bits,base,2);
      if(d) ysfGpsFeed(P,F,d,out);
      if(d){
        const s=ysfText(d), t=P.pend||(P.pend={});
        if(F.fn===0) t.dst=s; else if(F.fn===1) t.src=s; else if(F.fn===2) t.downlink=s; else if(F.fn===3) t.uplink=s;
        if(F.fn===1 && t.dst!=null){ setCall({dst:t.dst, src:t.src, downlink:t.downlink, uplink:t.uplink}); P.pend=null; }
        else if((F.fn===2 || F.fn===3) && P.call){ P.call[F.fn===2 ? 'downlink' : 'uplink']=s; }
      }
      for(let k=0;k<5;k++){
        out.voice.push({t:P.now, src:'YSF', kind:'ambe', fn:F.fn, n:k+1, dt:F.dt, from:P.call?P.call.src:null, to:P.call?P.call.dst:null, ambe:bytesHex(ysfVch(bits,base+144*k+40))});
        P.st.voice++;
      }
    } else if(F.dt===0){                                          // V/D режим 1: DCH — 20 байт на кадр (FN 0 — dest + src, 1 — downlink + uplink)
      const d=ysfDchDecode(bits,base,1);
      if(d) ysfGpsFeed(P,F,d,out);
      if(d && F.fn===0) setCall({dst:ysfText(d.subarray(0,10)), src:ysfText(d.subarray(10,20))});
      else if(d && F.fn===1 && P.call){ P.call.downlink=ysfText(d.subarray(0,10)); P.call.uplink=ysfText(d.subarray(10,20)); }
      for(let k=0;k<5;k++){
        out.voice.push({t:P.now, src:'YSF', kind:'ambe', fn:F.fn, n:k+1, dt:F.dt, from:P.call?P.call.src:null, to:P.call?P.call.dst:null, ambe:bytesHex(bytesFromBits(bits.subarray(base+144*k+72,base+144*k+144)))});
        P.st.voice++;
      }
    } else {                                                      // данные FR / голос FR: только сырой блок
      out.voice.push({t:P.now, src:'YSF', kind:'raw', fn:F.fn, dt:F.dt, from:P.call?P.call.src:null, to:P.call?P.call.dst:null, ambe:bytesHex(bytesFromBits(bits.subarray(base,base+720)))});
      P.st.voice++;
    }
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    const dur=(P.now-c.t0)/1000;
    ysfEmit(P,L,out,'end',{from:c.src, to:c.dst, seconds:+dur.toFixed(1), by},'END '+(c.src||'?')+' → '+(c.dst||'?')+' · '+dur.toFixed(1)+' s ('+by+')');
    P.call=null; P.pend=null;
  }};
FSK4.order.push('ysf');

/* ---- генератор ---- */
const YSF_SYNC_DIB=fsk4Dib(Uint8Array.from(YSF_SYNC.bits,c=>+c));
function ysfFrame(f4,fill){                                        // f4 — 4 байта FICH; fill(bits) — заполняет payload (с бита 240)
  const b=new Uint8Array(960); b.set(Uint8Array.from(YSF_SYNC.bits,c=>+c)); b.set(ysfFichEncode(f4),40);
  fill(b); return fsk4Dib(b);
}
const ysfPad=(s,n)=>Uint8Array.from({length:n},(_,i)=>i<s.length ? s.charCodeAt(i) : 32);
function ysfScript(mode){
  const dst='CQCQCQ', src='N0CALL', dl='DOWNLINK', ul='UPLINK', seq=[];
  const rnd=(()=>{ let x=0x51EDBA5; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&255; }; })();
  // FICH: [FI, CS, CM, BN], [BT, FN, FT], [DEV, MR, DT], [SQL, DG-ID]
  const fich=(fi,cm,fn,ft,dt,dg)=>Uint8Array.of((fi<<6)|(cm<<2), (0<<6)|(fn<<3)|ft, (0<<6)|(1<<3)|dt, dg);
  const csd=(a,b)=>u8cat(ysfPad(a,10),ysfPad(b,10));
  const header=()=>ysfFrame(fich(0,0,0,6,mode==='vd1' ? 0 : 2,7),b=>{ ysfDchEncode(csd(dst,src),1,b,240); ysfDchEncode(csd(dl,ul),1,b,240+72); });
  seq.push(header(),header());
  const gps=ysfGpsPack(54.9833,82.8964,0x24), last=mode==='vd1' ? 6 : 7;
  for(let fn=0;fn<=last;fn++){
    seq.push(ysfFrame(fich(1,0,fn,last,mode==='vd1' ? 0 : 2,7),b=>{
      if(mode==='vd1'){
        if(fn===0) ysfDchEncode(csd(dst,src),1,b,240); else if(fn===1) ysfDchEncode(csd(dl,ul),1,b,240); else if(fn>=3) ysfDchEncode(fn===3 ? gps : new Uint8Array(20),1,b,240); else ysfDchEncode(Uint8Array.from({length:20},()=>0x20+(rnd()&31)),1,b,240);
        for(let k=0;k<5;k++) for(let i=0;i<72;i++) b[240+144*k+72+i]=rnd()&1;
      } else {
        const t=[dst,src,dl,ul][fn];
        ysfDchEncode(t!=null ? ysfPad(t,10) : fn>=6 ? gps.subarray(10*(fn-6),10*(fn-5)) : Uint8Array.from({length:10},()=>0x30+(rnd()&15)),2,b,240);
        for(let k=0;k<5;k++) ysfVchEncode(Uint8Array.from({length:13},rnd),b,240+144*k+40);
      }
    }));
  }
  seq.push(ysfFrame(fich(2,0,0,6,mode==='vd1' ? 0 : 2,7),b=>{ ysfDchEncode(csd(dst,src),1,b,240); ysfDchEncode(csd(dl,ul),1,b,240+72); }));
  return fsk4LevelsOf(u8cat(new Uint8Array(40),...seq,new Uint8Array(40)));
}
FSK4.gen['YSF V/D mode 2']={baud:YSF_BAUD, alpha:.2, dev:600, script:()=>ysfScript('vd2')};
FSK4.gen['YSF V/D mode 1']={baud:YSF_BAUD, alpha:.2, dev:600, script:()=>ysfScript('vd1')};
