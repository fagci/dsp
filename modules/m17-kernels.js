"use strict";
/* ============================ M17 (M17 Specification, 4FSK 4800 Бод, RRC α=0.5) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js). Кадр 192 дибита (40 мс): синхро 8 (тип кадра: LSF / поток / пакет / BERT) + 184
   данных: рандомизатор → перемежитель QPP → выкалывание P1 / P2 / P3 → свёрточный код K=5 (как у NXDN), LICH — Golay(24,12).
   Кадры: LSF (адреса, TYPE, META, CRC-16), потоковый (LICH, номер кадра, 16 байт Codec 2), пакетный (25 байт + EOF/счётчик), BERT (PRBS9).
   Голос Codec 2 не декодируется — отдаются сырые 16 байт кадра. Кодеры — для генератора и тестов (сверка с libm17). */

const M17_BAUD=4800;
const M17_SYNCS=[['55F7','lsf'],['FF5D','str'],['75FF','pkt'],['DF55','bert']].map(([h,k])=>fsk4Sync(fsk4Bits(h),{kind:k}));
const M17_RAND=[0xD6,0xB5,0xE2,0x30,0x82,0xFF,0x84,0x62,0xBA,0x4E,0x96,0x90,0xD8,0x98,0xDD,0x5D,0x0C,0xC8,0x52,0x43,0x91,0x1D,0xF8,
  0x6E,0x68,0x2F,0x35,0xDA,0x14,0xEA,0xCD,0x76,0x19,0x8D,0xD5,0x80,0xD1,0x33,0x87,0x13,0x57,0x18,0x2D,0x29,0x78,0xC3];
const M17_IL=Array.from({length:368},(_,i)=>(45*i+92*i*i)%368);
const M17_P1=[1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1];
const M17_P2=[1,1,1,1,1,1,1,1,1,1,1,0], M17_P3=[1,1,1,1,1,1,1,0];
const M17_CHARS=' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.';
const M17_GOLAY_M=[0x8EB,0x93E,0xA97,0xDC6,0x367,0x6CD,0xD99,0x3DA,0x7B4,0xF68,0x63B,0xC75];
const M17_DTYPE=['','data','voice','voice+data'], M17_ENC=['none','scrambler','AES','other'];

/* ---- CRC-16 (0x5935, начальное 0xFFFF, без отражения) ---- */
function m17Crc(bytes,n){
  let c=0xFFFF;
  for(let i=0;i<n;i++){ c^=bytes[i]<<8; for(let k=0;k<8;k++) c=(c&0x8000) ? ((c<<1)^0x5935)&0xFFFF : (c<<1)&0xFFFF; }
  return c;
}
/* ---- позывные: основание 40, первый символ — младший ---- */
function m17CallEnc(cs){
  let a=0n;
  for(let i=Math.min(cs.length,9)-1;i>=0;i--){
    const ch=cs[i].toUpperCase(); let v=M17_CHARS.indexOf(ch);
    if(v<0) v=0;
    a=a*40n+BigInt(v);
  }
  const r=new Uint8Array(6);
  for(let i=5;i>=0;i--){ r[i]=Number(a&255n); a>>=8n; }
  return r;
}
function m17CallDec(b){
  let a=0n; for(let i=0;i<6;i++) a=a*256n+BigInt(b[i]);
  if(a===0xFFFFFFFFFFFFn) return 'BROADCAST';
  if(a>=0xEE6B28000000n) return '#'+bytesHex(b);
  let s=''; while(a){ s+=M17_CHARS[Number(a%40n)]; a/=40n; }
  return s;
}

/* ---- Golay(24,12): систематический, 12 бит данных + 12 проверочных ---- */
function m17Golay(d){ let c=0; for(let i=0;i<12;i++) if((d>>i)&1) c^=M17_GOLAY_M[i]; return (d<<12)|c; }
let M17_GT=null;
function m17GolayDec(w){                                           // 24 бита → {v, err} (до 3 ошибок)
  if(!M17_GT){ M17_GT=new Uint32Array(4096); for(let d=0;d<4096;d++) M17_GT[d]=m17Golay(d); }
  let bd=99, best=0;
  for(let d=0;d<4096;d++){ const e=popcnt32((M17_GT[d]^w)>>>0); if(e<bd){ bd=e; best=d; } }
  return bd<=3 ? {v:best, err:bd} : null;
}

/* ---- свёртка и выкалывание (код общий с NXDN: nxdnConvEnc / nxdnConvDec) ---- */
function m17Enc(bits,steps,pat){                                   // bits — данные; хвост из 4 нулей; → выколотые биты
  const b=new Uint8Array(steps); b.set(bits);
  const cod=nxdnConvEnc(b), out=[];
  for(let i=0;i<cod.length;i++) if(pat[i%pat.length]) out.push(cod[i]);
  return Uint8Array.from(out);
}
function m17Dec(rx,steps,pat){                                     // rx — принятые (выколотые) биты
  const m=new Int8Array(2*steps).fill(-1); let k=0;
  for(let i=0;i<2*steps && k<rx.length;i++) if(pat[i%pat.length]) m[i]=rx[k++];
  return nxdnConvDec(m,steps);
}
// 368 бит типа 4 ↔ 368 бит типа 2/3 (перемежитель — инволюция), рандомизатор
const m17Il=b=>{ const o=new Uint8Array(368); for(let i=0;i<368;i++) o[i]=b[M17_IL[i]]; return o; };
const m17Rnd=b=>{ const o=new Uint8Array(368); for(let i=0;i<368;i++) o[i]=b[i]^((M17_RAND[i>>3]>>(7-(i&7)))&1); return o; };
const m17Bits=(bytes,n)=>bitsMsb(bytes).subarray(0,n);

/* ---- кодеры кадров: → 368 бит на выход физического уровня (после рандомизатора) ---- */
const m17Wire=t=>m17Rnd(m17Il(t));
function m17EncLsf(lsf30){ return m17Wire(m17Enc(m17Bits(lsf30,240),244,M17_P1)); }
function m17Lich(lsf30,cnt){                                       // 48 бит LICH: 40 бит куска LSF + счётчик
  const b=new Uint8Array(48); b.set(m17Bits(lsf30,240).subarray(40*cnt,40*cnt+40));
  for(let i=0;i<3;i++) b[40+i]=(cnt>>(2-i))&1;
  return b;
}
function m17EncStream(lsf30,cnt,fn,data16){
  const lich=m17Lich(lsf30,cnt), t=new Uint8Array(368);
  for(let w=0;w<4;w++){ const g=m17Golay(bitsNum(lich,12*w,12)); for(let i=0;i<24;i++) t[24*w+i]=(g>>(23-i))&1; }
  const d=new Uint8Array(144); for(let i=0;i<16;i++) d[i]=(fn>>(15-i))&1; d.set(bitsMsb(data16),16);
  t.set(m17Enc(d,148,M17_P2),96);
  return m17Wire(t);
}
function m17EncPacket(b26){ return m17Wire(m17Enc(m17Bits(b26,206),210,M17_P3)); }    // 25 байт + 6 бит (EOF, счётчик)
function m17EncBert(b25){ const e=m17Enc(m17Bits(b25,197),201,M17_P2), t=new Uint8Array(368); t.set(e.subarray(0,368)); return m17Wire(t); }
// кадр целиком: синхро + 368 бит → 192 дибита
function m17Frame(kind,wire){ return u8cat(fsk4Dib(Uint8Array.from(M17_SYNCS.find(s=>s.kind===kind).bits,c=>+c)),fsk4Dib(wire)); }

/* ---- разбор ---- */
function m17Lsf(b){                                                // 30 байт → поля
  const t=b[12]*256+b[13], f={dst:m17CallDec(b.subarray(0,6)), src:m17CallDec(b.subarray(6,12)), type:t, packet:(t&1)^1,
    dtype:(t>>1)&3, enc:(t>>3)&3, sub:(t>>5)&3, can:(t>>7)&15, signed:(t>>11)&1, meta:bytesHex(b,14,14)};
  f.mode=f.packet ? 'packet' : M17_DTYPE[f.dtype]||'stream';
  f.encName=M17_ENC[f.enc];
  if(!f.packet && f.enc===0){
    const m=b.subarray(14,28);
    if(f.sub===0 && m[0]){ f.metaText=String.fromCharCode(...Array.from(m.subarray(1)).filter(c=>c>=32 && c<127)).trim(); }
    else if(f.sub===2){ f.cf1=m17CallDec(m.subarray(0,6)); if(m[6]) f.cf2=m17CallDec(m.subarray(6,12)); }
    else if(f.sub===1){
      const bits=bitsMsb(m), s24=v=>v&0x800000 ? v-0x1000000 : v, F=(o,n)=>bitsNum(bits,o,n);
      const valid=F(8,4);
      f.gnss={source:F(0,4), station:F(4,4), valid};
      if(valid&8){ f.lat=+(s24(F(24,24))/8388607*90).toFixed(5); f.lon=+(s24(F(48,24))/8388607*180).toFixed(5); }
      if(valid&4) f.alt=F(72,16)*.5-500;
      if(valid&2){ f.bearing=F(15,9)-0; f.speed=F(88,12)*.5; }
    }
  }
  return f;
}
const M17_MISS=2;
function m17Emit(P,L,out,kind,f,text){
  const r={t:Date.now(), kind, ...f, src:'M17', text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}

FSK4.protos.m17={
  id:'m17', name:'M17', baud:M17_BAUD, alpha:.5, lp:5500, levels:4, thrAcq:1, thrLock:3, maxRq:.12, syncs:M17_SYNCS,
  init(P){
    P.now=0; P.lsf=null; P.lich=null; P.call=null; P.pkt=null; P.recent=[]; P.lastAct=0;
    P.st={frames:0, lsf:0, stream:0, packet:0, bert:0, voice:0, calls:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; P.pkt=null; P.lich=null; },
  lock(P,L,sync){ P.st.locks++; L.after=184; return {first:true, blind:true, kind:sync.kind}; },   // захват предварительный — до первого верного кадра
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head='M17 · '+(L ? (c ? c.mode : 'locked')+(L.g<0 ? ', inverted' : '') : 'searching sync')+(P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.frames+' frames · '+s.lsf+' LSF · '+s.voice+' voice · '+s.packet+' packet · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8),
      text:head+'\n'+cnt+'\n'+(c ? c.src+' → '+c.dst+' · CAN '+c.can+(c.enc ? ' · '+c.encName : '') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  // синхрослова LSF/поток и пакет/BERT — инверсии друг друга (как голос/данные у DMR): полярность определяется по FEC
  gain(L,f){ return L.polOk && Math.sign(f.g)!==Math.sign(L.g) ? -f.g : f.g; },
  syncKind(F,prev){
    let kind=prev, bd=3;
    for(const s of M17_SYNCS){ let d=0; for(let i=0;i<8;i++) d+=popcnt32(F[i]^(s.syms[i]===3 ? 1 : s.syms[i]===1 ? 0 : s.syms[i]===-1 ? 2 : 3)); if(d<bd){ bd=d; kind=s.kind; } }
    return bd<3 ? kind : null;
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*M17_BAUD)*1000;
    const synced=L.first || L.best!==99;
    if(synced) L.miss=0; else if(++L.miss>M17_MISS){ fsk4Drop(L); return; }
    let F=fsk4Slice(L,e,192), kind=this.syncKind(F,L.kind);
    if(!kind && !synced){ fsk4Drop(L); return; }
    L.blind=!synced;
    const run=(F,kind)=>this.decode(P,L,kind||L.kind,m17Il(m17Rnd(fsk4Unpack(F,8,184))),out);
    let ok=run(F,kind);
    if(!ok && !L.polOk){                                         // возможно, полярность перевёрнута
      const G=F.map(d=>d^2);
      if(run(G,this.syncKind(G,L.kind))){ ok=true; L.g=-L.g; L.polOk=true; }
    } else if(ok) L.polOk=true;
    if(!ok){ if(L.blind || L.first){ fsk4Drop(L); return; } P.st.bad++; }
    else { L.blind=false; L.first=false; P.lastAct=Date.now(); }
    P.st.frames++; if(kind) L.kind=kind;
    L.next+=8*192; L.best=99; L.bestRq=1e9;
  },
  decode(P,L,kind,t,out){
    if(kind==='lsf'){
      const r=m17Dec(t,244,M17_P1), b=bytesFromBits(r.bits.subarray(0,240));
      if(r.err>40 || m17Crc(b,30)!==0) return false;
      P.st.lsf++; this.setLsf(P,L,out,b,'LSF'); return true;
    }
    if(kind==='str'){
      const lich=new Uint8Array(48);
      for(let w=0;w<4;w++){ let v=0; for(let i=0;i<24;i++) v=v*2+t[24*w+i]; const g=m17GolayDec(v); if(!g) return false; for(let i=0;i<12;i++) lich[12*w+i]=(g.v>>(11-i))&1; }
      const cnt=bitsNum(lich,40,3), r=m17Dec(t.subarray(96),148,M17_P2);
      if(cnt>5 || r.err>30) return false;
      const fn=bitsNum(r.bits,0,16), data=bytesFromBits(r.bits.subarray(16,144));
      P.st.stream++;
      // куски LSF из LICH: за шесть кадров — весь LSF (для поздно подключившихся)
      if(!P.lich) P.lich={m:0, b:new Uint8Array(240)};
      P.lich.b.set(lich.subarray(0,40),40*cnt); P.lich.m|=1<<cnt;
      if(P.lich.m===63){
        const b=bytesFromBits(P.lich.b);
        if(m17Crc(b,30)===0 && (!P.lsf || bytesHex(P.lsf.raw)!==bytesHex(b))) this.setLsf(P,L,out,b,'LICH');
        P.lich=null;
      }
      const c=P.call;
      out.voice.push({t:P.now, src:'M17', kind:'codec2', fn:fn&0x7FFF, from:c?c.src:null, to:c?c.dst:null, can:c?c.can:null, dtype:P.lsf?P.lsf.f.dtype:null, codec2:bytesHex(data)});
      P.st.voice++;
      if(fn&0x8000) this.end(P,L,out,'last frame');
      return true;
    }
    if(kind==='pkt'){
      const r=m17Dec(t,210,M17_P3), by=bytesFromBits(r.bits.subarray(0,208));
      if(r.err>40) return false;
      const meta=r.bits.subarray(200,206), eof=meta[0], cnt=bitsNum(meta,1,5);
      P.st.packet++;
      if(!P.pkt || cnt===0 && !eof && P.pkt.n>0) P.pkt={n:0, data:[]};
      P.pkt.data.push(...by.subarray(0,25).subarray(0,eof ? Math.min(25,cnt) : 25)); P.pkt.n++;
      if(eof){
        const d=Uint8Array.from(P.pkt.data), body=d.subarray(0,d.length-2), c=P.call;
        const crc=m17Crc(d,d.length)===0 ? 'ok' : 'bad';
        const proto=body[0], text=proto===5 ? String.fromCharCode(...body.subarray(1).filter(x=>x>=32 && x<127)) : null;
        m17Emit(P,L,out,'packet',{from:c?c.src:null, to:c?c.dst:null, bytes:d.length-2, proto, crc, message:text, hex:bytesHex(body,0,Math.min(body.length,64))},
          'PACKET '+(c ? c.src+' → '+c.dst+' ' : '')+(d.length-2)+' bytes'+(text ? ' "'+text+'"' : '')+(crc==='ok' ? '' : ' [CRC bad]'));
        P.pkt=null;
      }
      return true;
    }
    if(kind==='bert'){
      const r=m17Dec(t,201,M17_P2), b=r.bits.subarray(0,197);
      if(r.err>40) return false;
      // PRBS9 (x⁹+x⁵+1): каждый бит — сумма по модулю 2 битов 9 и 5 назад; несоответствия ≈ до 3 на каждую ошибку
      let mis=0; for(let i=9;i<197;i++) if(b[i]!==(b[i-9]^b[i-5])) mis++;
      P.st.bert++;
      m17Emit(P,L,out,'bert',{bits:197, mismatches:mis, ber:+(mis/3/188).toFixed(4)},'BERT '+mis+' mismatches in 188 bits');
      return true;
    }
    return false;
  },
  setLsf(P,L,out,b,by){
    const f=m17Lsf(b);
    if(P.call && P.call.src===f.src && P.call.dst===f.dst && P.call.type===f.type){ P.lsf={raw:b,f}; return; }
    if(P.call) this.end(P,L,out,'new call');
    P.lsf={raw:b,f}; P.call={...f, t0:P.now, frames:0};
    P.st.calls++;
    const {meta,...rest}=f;
    m17Emit(P,L,out,'call',{from:f.src, to:f.dst, call:f.mode, ...rest, meta, source:by},
      f.src+' → '+f.dst+' · '+f.mode+' · CAN '+f.can+(f.enc ? ' · '+f.encName : '')+(f.metaText ? ' · "'+f.metaText+'"' : '')+(f.cf1 ? ' · '+f.cf1+(f.cf2 ? ' / '+f.cf2 : '') : '')+(f.lat!=null ? ' · '+f.lat+', '+f.lon : ''));
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    const dur=(P.now-c.t0)/1000;
    m17Emit(P,L,out,'end',{from:c.src, to:c.dst, call:c.mode, seconds:+dur.toFixed(1), by},'END '+c.src+' → '+c.dst+' · '+dur.toFixed(1)+' s ('+by+')');
    P.call=null; P.lich=null;
  }};
FSK4.order.push('m17');
// описание цепочки блоков для «Expand into blocks» (Digital Voice Decoder): FM → RRC → слайсер → синхрослова → разбор кадров
FSK4.protos.m17.chain={baud:M17_BAUD, alpha:.5, lp:5500, words:'55F7 FF5D 75FF DF55', len:184, tol:1, parser:'m17Parse'};

/* ---- генератор ---- */
function m17MakeLsf(src,dst,type,meta){
  const b=new Uint8Array(30); b.set(m17CallEnc(dst),0); b.set(m17CallEnc(src),6); b[12]=type>>8; b[13]=type&255; b.set(meta,14);
  const c=m17Crc(b,28); b[28]=c>>8; b[29]=c&255; return b;
}
const M17_PRE=Uint8Array.from({length:192},(_,i)=>i&1 ? 3 : 1), M17_EOT=Uint8Array.from({length:192},(_,i)=>[1,1,1,1,1,1,3,1][i&7]);
function m17Script(mode){
  const rnd=(()=>{ let x=0x13579BD; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&255; }; })(), seq=[];
  if(mode==='voice'){
    const meta=new Uint8Array(14); meta.set(m17CallEnc('SP5WWP'),0); meta.set(m17CallEnc('M17-M17 C'),6);
    const lsf=m17MakeLsf('SP5WWP','W2FBI',0x0005|(3<<7)|(2<<5),meta);        // поток, голос, CAN 3, расширенный позывной
    seq.push(M17_PRE,m17Frame('lsf',m17EncLsf(lsf)));
    for(let f=0;f<12;f++) seq.push(m17Frame('str',m17EncStream(lsf,f%6,f===11 ? 0x8000|f : f,Uint8Array.from({length:16},rnd))));
    seq.push(M17_EOT);
  } else {
    const meta=new Uint8Array(14), lsf=m17MakeLsf('N0CALL','ECHO',(1<<7),meta);   // пакетный режим, CAN 1
    const text='Hello from M17', body=Uint8Array.from([5,...Array.from(text,c=>c.charCodeAt(0)),0]), crc=m17Crc(body,body.length), all=u8cat(body,Uint8Array.of(crc>>8,crc&255));
    seq.push(M17_PRE,m17Frame('lsf',m17EncLsf(lsf)));
    for(let i=0,fnum=0;i<all.length;i+=25,fnum++){
      const chunk=all.subarray(i,i+25), last=i+25>=all.length, b=new Uint8Array(26); b.set(chunk);
      b[25]=last ? (0x80|(chunk.length<<2)) : (fnum<<2);
      seq.push(m17Frame('pkt',m17EncPacket(b)));
    }
    seq.push(M17_EOT);
  }
  return fsk4LevelsOf(u8cat(new Uint8Array(40),...seq,new Uint8Array(40)));
}
FSK4.gen['M17 voice stream']={baud:M17_BAUD, alpha:.5, dev:800, script:()=>m17Script('voice')};
FSK4.gen['M17 packet (SMS)']={baud:M17_BAUD, alpha:.5, dev:800, script:()=>m17Script('packet')};

/* ---- разбор кадров M17 из blk (Symbol Sync Search): та же канальная часть, что у плагина, без физики ---- */
// blk — payload 184 дибита после синхрослова; тип кадра — по самому слову (LSF 55F7, поток FF5D, пакет 75FF, BERT DF55)
const M17_KIND_OF=Object.fromEntries(M17_SYNCS.map(s=>[s.bits ? parseInt(s.bits,2).toString(16).toUpperCase().padStart(4,'0') : '',s.kind]));
IQK.m17Parse={
  init(n){ n.pr=null; n.lastFid=0; n.recent=[]; },
  process(n,I){
    if(!n.pr){ n.pr={}; FSK4.protos.m17.init(n.pr); n.pr.stats={frames:0, bad:0, other:0}; }
    const P=n.pr, out={recs:[], voice:[]}, f=I.blk;
    if(f && f.id!==n.lastFid && f.dib && f.dib.length>=184){
      n.lastFid=f.id;
      const kind=M17_KIND_OF[String(f.word).toUpperCase()];
      if(!kind) P.stats.other++;
      else {
        P.now=f.t/M17_BAUD*1000;
        const t=m17Il(m17Rnd(fsk4Unpack(f.dib,0,184)));
        if(FSK4.protos.m17.decode(P,null,kind,t,out)){ P.stats.frames++; P.lastAct=Date.now(); } else P.stats.bad++;
      }
    }
    const s=P.st, c=P.call, ps=P.stats;
    n.ui={text:'M17 · '+ps.frames+' frames · '+s.lsf+' LSF · '+s.voice+' voice · '+s.packet+' packet · '+s.calls+' calls · '+ps.bad+' bad'+
      '\n'+(c ? c.src+' → '+c.dst+' · '+c.mode+' · CAN '+c.can+(c.enc ? ' · '+c.encName : '') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
    return {rec:out.recs.length ? out.recs : null, voice:out.voice.length ? out.voice : null};
  }};

/* ---- передача: пакетный кадр SMS (LSF + кадры пакета) → дибиты: преамбула, LSF, пакеты, EOT ---- */
// can — 0…15, текст UTF-8 с нулевым байтом (протокол 5 — SMS), CRC-16 по телу
function m17BuildPacket(src,dst,can,text){
  const meta=new Uint8Array(14), lsf=m17MakeLsf(src,dst,(can&15)<<7,meta);        // пакетный режим: бит 0 типа = 0
  const body=Uint8Array.from([5,...new TextEncoder().encode(text),0]), crc=m17Crc(body,body.length);
  const all=u8cat(body,Uint8Array.of(crc>>8,crc&255)), seq=[M17_PRE,m17Frame('lsf',m17EncLsf(lsf))];
  for(let i=0,fnum=0;i<all.length;i+=25,fnum++){
    const chunk=all.subarray(i,i+25), last=i+25>=all.length, b=new Uint8Array(26); b.set(chunk);
    b[25]=last ? (0x80|(chunk.length<<2)) : ((fnum&31)<<2);
    seq.push(m17Frame('pkt',m17EncPacket(b)));
  }
  seq.push(M17_EOT);
  return u8cat(...seq);
}

/* ---- передача: голосовой поток (Codec 2 3200, два кадра по 8 байт на кадр M17 в 40 мс) ---- */
// старт: преамбула + LSF (поток, голос, CAN); дальше кадр на каждые 16 байт; последний кадр помечается флагом конца (бит 15 номера кадра)
function m17StreamStart(src,dst,can){
  const lsf=m17MakeLsf(src,dst,0x0005|((can&15)<<7),new Uint8Array(14));
  return {lsf, fn:0, dib:u8cat(M17_PRE,m17Frame('lsf',m17EncLsf(lsf)))};
}
function m17StreamFrame(st,data16,last){
  const fn=st.fn++&0x7FFF;
  return m17Frame('str',m17EncStream(st.lsf,fn%6,last ? (0x8000|fn) : fn,data16));
}
