"use strict";
/* ============================ NXDN 9600 (NXDN TS 1-A, 12,5 кГц, 4FSK 4800 Бод) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js). Кадр 192 дибита (40 мс): FSW 10 + LICH 8 + SACCH 30 + два слота по 72 дибита
   (голос AMBE+2 или FACCH1) либо UDCH/FACCH2 на все 174. Скремблер — PN-последовательность на старших битах дибитов после FSW.
   Кодирование: перемежение, выкалывание, свёрточный код K=5 r=½, CRC-6 / 12 / 15. Слой 3 (сообщения): вызовы, освобождение, данные.
   Голос не декодируется — отдаются сырые кадры (72 бита). Кодеры для генератора и тестов; сверка с MMDVMHost. */

const NXDN_BAUD=4800, NXDN_FR=192, NXDN_SYNC=fsk4Sync(fsk4Bits('CDF59').slice(0,20));
// скремблер MMDVMHost: бит на старший бит дибита кадра (первые 12 символов — без изменений)
const NXDN_SCR=[0x00,0x00,0x00,0x82,0xA0,0x88,0x8A,0x00,0xA2,0xA8,0x82,0x8A,0x82,0x02,0x20,0x08,0x8A,0x20,0xAA,0xA2,0x82,0x08,0x22,0x8A,
  0xAA,0x08,0x28,0x88,0x28,0x28,0x00,0x0A,0x02,0x82,0x20,0x28,0x82,0x2A,0xAA,0x20,0x22,0x80,0xA8,0x8A,0x08,0xA0,0xAA,0x02];
const nxdnScrBit=s=>(NXDN_SCR[s>>2]>>(7-2*(s&3)))&1;
const NXDN_CALLTYPE=['broadcast','conference','unspecified','','individual','','interconnect','speed dial'];
const NXDN_MSG={0x00:'CALL_RESP', 0x01:'VCALL', 0x02:'VCALL_REC_REQ', 0x03:'VCALL_IV', 0x04:'VCALL_ASSGN', 0x05:'VCALL_ASSGN_DUP', 0x06:'CALL_CONN_RESP', 0x07:'TX_REL_EX',
  0x08:'TX_REL', 0x09:'DCALL_HEADER', 0x0A:'DCALL_REC_REQ', 0x0B:'DCALL_DATA', 0x0C:'DCALL_ACK', 0x0D:'DCALL_ASSGN_DUP', 0x0E:'DCALL_ASSGN', 0x0F:'HEAD_DLY',
  0x10:'IDLE', 0x11:'DISC', 0x17:'DST_ID_INFO', 0x18:'SITE_INFO', 0x19:'SRV_INFO', 0x1A:'CCH_INFO', 0x1B:'ADJ_SITE_INFO', 0x1C:'FAIL_STAT_INFO', 0x20:'REG_RESP',
  0x22:'REG_C_RESP', 0x23:'REG_COMM', 0x24:'GRP_REG_RESP', 0x28:'AUTH_INQ_REQ', 0x29:'AUTH_INQ_RESP', 0x30:'STAT_INQ_REQ', 0x31:'STAT_INQ_RESP', 0x32:'STAT_REQ',
  0x33:'STAT_RESP', 0x34:'REM_CON_REQ', 0x35:'REM_CON_RESP', 0x38:'SDCALL_REQ_HEADER', 0x39:'SDCALL_REQ_DATA', 0x3A:'SDCALL_IV', 0x3B:'SDCALL_RESP', 0x3F:'PROP_FORM'};

/* ---- CRC (MMDVMHost NXDNCRC): начальное значение из единиц, без инверсии; биты MSB первыми ---- */
function nxdnCrc(bits,n,w,poly){ return crcBits(bits,n,w,poly,(1<<w)-1); }
// CAC: сдвиговая схема dsd-fme / спецификации, начало 0xC3EE, конец инвертируется; поле CRC — 16 нулей после данных
function nxdnCrcCac(bits,n){
  let c=0xC3EE;
  for(let i=0;i<n+16;i++){ c=((c<<1)|(i<n ? bits[i] : 0))&0x1FFFF; if(c&0x10000) c=(c&0xFFFF)^0x1021; }
  return (c^0xFFFF)&0xFFFF;
}
const nxdnCrc6=(b,n)=>nxdnCrc(b,n,6,0x27), nxdnCrc12=(b,n)=>nxdnCrc(b,n,12,0x80F), nxdnCrc15=(b,n)=>nxdnCrc(b,n,15,0x4CC5);

/* ---- свёрточный код K=5, r=½: g1 = 1+D³+D⁴, g2 = 1+D+D²+D⁴ (регистр d1 — предыдущий бит) ---- */
function nxdnConvEnc(bits){
  const out=new Uint8Array(2*bits.length); let d1=0, d2=0, d3=0, d4=0;
  for(let i=0;i<bits.length;i++){
    const d=bits[i];
    out[2*i]=(d^d3^d4)&1; out[2*i+1]=(d^d1^d2^d4)&1;
    d4=d3; d3=d2; d2=d1; d1=d;
  }
  return out;
}
// принятые биты (0/1, −1 — стёртый) → n информационных бит; конец пути — состояние 0 (хвост из нулей). {bits, err}
function nxdnConvDec(rx,n){
  let cost=new Float64Array(16).fill(1e9); cost[0]=0;
  const dec=[];
  for(let i=0;i<n;i++){
    const a=rx[2*i], b=rx[2*i+1], nc=new Float64Array(16).fill(1e9), dcs=new Uint8Array(16);
    for(let s=0;s<16;s++){
      if(cost[s]>=1e9) continue;
      const d1=(s>>3)&1, d2=(s>>2)&1, d3=(s>>1)&1, d4=s&1;
      for(let d=0;d<2;d++){
        const g1=(d^d3^d4)&1, g2=(d^d1^d2^d4)&1, m=cost[s]+(a>=0 && a!==g1 ? 1 : 0)+(b>=0 && b!==g2 ? 1 : 0), ns=(d<<3)|(s>>1);
        if(m<nc[ns]){ nc[ns]=m; dcs[ns]=s; }
      }
    }
    dec.push(dcs); cost=nc;
  }
  const bits=new Uint8Array(n); let s=0;
  for(let i=n-1;i>=0;i--){ bits[i]=(s>>3)&1; s=dec[i][s]; }
  return {bits, err:cost[0]};
}

/* ---- каналы: перемежение (матрица), выкалывание, шаги кода, CRC ---- */
const nxdnIl=(cols,len)=>Array.from({length:len},(_,i)=>(i%cols)*(len/cols)+((i/cols)|0));
const NXDN_CH={
  sacch:{len:60, il:nxdnIl(12,60), punct:Array.from({length:12},(_,k)=>5+6*k), steps:36, data:26, crc:nxdnCrc6, cw:6, at:36},
  facch1:{len:144, il:nxdnIl(16,144), punct:Array.from({length:48},(_,k)=>1+4*k), steps:96, data:80, crc:nxdnCrc12, cw:12},
  cac:{len:300, il:nxdnIl(12,300), punct:Array.from({length:50},(_,k)=>3+14*(k>>1)+8*(k&1)), steps:175, data:155, crc:nxdnCrcCac, cw:16},
  udch:{len:348, il:nxdnIl(12,348), punct:Array.from({length:58},(_,k)=>3+14*(k>>1)+8*(k&1)), steps:203, data:184, crc:nxdnCrc15, cw:15, at:36}
};
// биты канала (после перемежения — в порядке кадра) → {bits (data+crc), ok, err}
function nxdnChDecode(ch,raw){
  const rx=new Int8Array(2*ch.steps).fill(0), P=new Set(ch.punct);
  let n=0, k=0;
  const des=new Uint8Array(ch.len);
  for(let i=0;i<ch.len;i++) des[i]=raw[ch.il[i]];
  for(let i=0;i<2*ch.steps;i++) rx[i]=P.has(i) ? -1 : des[k++];
  const r=nxdnConvDec(rx,ch.steps), ok=ch.crc(r.bits,ch.data)===bitsNum(r.bits,ch.data,ch.cw);
  return {bits:r.bits, ok, err:r.err};
}
// data — ch.data бит; → ch.len бит канала в порядке кадра
function nxdnChEncode(ch,data){
  const b=new Uint8Array(ch.steps); b.set(data);
  const c=ch.crc(b,ch.data); for(let i=0;i<ch.cw;i++) b[ch.data+i]=(c>>(ch.cw-1-i))&1;
  const cod=nxdnConvEnc(b), P=new Set(ch.punct), kept=[];
  for(let i=0;i<cod.length;i++) if(!P.has(i)) kept.push(cod[i]);
  const out=new Uint8Array(ch.len);
  for(let i=0;i<ch.len;i++) out[ch.il[i]]=kept[i];
  return out;
}

/* ---- LICH ---- */
// dibits — 8 дибитов LICH (после снятия скремблера) → {rfct, fct, opt, dir, ok} (ok — чётность верна)
function nxdnLich(F){
  let v=0; for(let i=0;i<8;i++) v=(v<<1)|(F[i]>>1);
  const par=((v>>7)^(v>>6)^(v>>5)^(v>>4))&1;
  return {rfct:v>>6, fct:(v>>4)&3, opt:(v>>2)&3, dir:(v>>1)&1, raw:v, ok:par===(v&1)};
}
const nxdnLichBits=(rfct,fct,opt,dir)=>{ const v=(rfct<<6)|(fct<<4)|(opt<<2)|(dir<<1), p=((v>>7)^(v>>6)^(v>>5)^(v>>4))&1; return v|p; };

/* ---- слой 3 (биты сообщения: 0–1 флаги, 2–7 тип) ---- */
function nxdnL3(b){
  const type=bitsNum(b,2,6), f={type, name:NXDN_MSG[type]||'0x'+type.toString(16), f1:b[0], f2:b[1]};
  if(type===0x01 || type===0x07 || type===0x08 || type===0x11 || type===0x09 || type===0x0B || type===0x38 || type===0x04 || type===0x05 || type===0x0E || type===0x0D){
    const ct=bitsNum(b,16,3);
    Object.assign(f,{ccopt:bitsNum(b,8,8), ctype:ct, call:NXDN_CALLTYPE[ct]||'type '+ct, opt:bitsNum(b,19,5), from:bitsNum(b,24,16), to:bitsNum(b,40,16),
      emergency:b[8], cipher:bitsNum(b,56,2), key:bitsNum(b,58,6)});
    if(type===0x04 || type===0x05 || type===0x0E || type===0x0D){ delete f.cipher; delete f.key; f.timer=bitsNum(b,56,6); f.channel=bitsNum(b,62,10); }
  } else if(type===0x18 && b.length>=128){
    Object.assign(f,{location:bitsNum(b,8,24).toString(16).toUpperCase().padStart(6,'0'), cs:bitsNum(b,32,16), svc:bitsNum(b,48,16), rst:bitsNum(b,64,24), ca:bitsNum(b,88,24),
      version:bitsNum(b,112,8), adj:bitsNum(b,120,4), ch1:bitsNum(b,124,10), ch2:bitsNum(b,134,10)});
  } else if(type===0x03) f.iv=bytesHex(bytesFromBits(b.subarray(8,72)));
  else f.hex=bytesHex(bytesFromBits(b.subarray(8,b.length&~7)));
  return f;
}

/* ---- приёмник ---- */
function nxdnEmit(P,L,out,kind,f,text){
  const r={t:Date.now(), src:'NXDN', kind, ran:P.ran, ...f, text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}
const NXDN_MISS=2;

FSK4.protos.nxdn={
  id:'nxdn', name:'NXDN', baud:NXDN_BAUD, alpha:.2, lp:5500, levels:4, thrAcq:2, thrLock:4, maxRq:.12, syncs:[NXDN_SYNC],
  init(P){
    P.now=0; P.ran=null; P.call=null; P.recent=[]; P.lastAct=0; P.sf=null; P.eps=0;
    P.st={frames:0, sacch:0, facch:0, udch:0, cac:0, voice:0, calls:0, msgs:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; P.sf=null; },
  lock(P,L){ P.st.locks++; L.after=8; return {stage:0, first:true, lich:null, eps:P.eps, exp:L.next, blind:false}; },
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head=this.name+' · '+(L ? 'RAN '+(P.ran==null ? '?' : P.ran)+(L.g<0 ? ', inverted' : '') : 'searching sync')+(P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.frames+' frames · '+s.voice+' voice · '+s.msgs+' messages · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, ran:P.ran, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8),
      text:head+'\n'+cnt+'\n'+(c ? c.call+' '+c.from+' → '+c.to+(c.emergency ? ' EMERGENCY' : '')+(c.cipher ? ' encrypted' : '') : 'idle')+(P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*this.baud)*1000;
    if(L.stage===0) this.head(P,L,e,out); else this.body(P,L,e,out);
  },
  // LICH (через 8 дибитов после FSW): чётность — быстрая проверка захвата
  head(P,L,e,out){
    const synced=L.first || L.best!==99;
    if(synced) L.miss=0; else if(++L.miss>NXDN_MISS){ fsk4Drop(L); return; }
    const F=fsk4Slice(L,e,18), un=F.slice(10);
    for(let i=0;i<8;i++) un[i]^=nxdnScrBit(10+i)<<1;
    const lich=nxdnLich(un);
    L.blind=!synced;
    if(!lich.ok && synced){ if(L.first){ fsk4Drop(L); return; } P.st.bad++; }
    if(!lich.ok && !synced){ fsk4Drop(L); return; }
    L.lich=lich; L.stage=1; L.after=NXDN_FR-10+Math.max(0,Math.ceil(NXDN_FR*L.eps))+1; P.st.frames++;
  },
  advance(P,L){
    L.next=Math.round(L.next+8*NXDN_FR*(1+L.eps)); L.exp=L.next;
    L.best=99; L.bestRq=1e9; L.stage=0; L.after=8; L.first=false;
  },
  body(P,L,e,out){
    const F=fsk4Slice(L,L.next+8*(NXDN_FR-10),NXDN_FR,L.eps);
    for(let i=10;i<NXDN_FR;i++) F[i]^=nxdnScrBit(i)<<1;
    const bits=fsk4Unpack(F,0,NXDN_FR), lich=L.lich;
    P.lastAct=Date.now();
    const bad=()=>{ if(L.blind || L.first){ fsk4Drop(L); return true; } P.st.bad++; return false; };
    if(lich.rfct===0){                                            // RCCH: CAC 300 бит
      P.st.cac++;
      const r=nxdnChDecode(NXDN_CH.cac,bits.subarray(36));
      if(!r.ok){ if(bad()) return; }
      else { P.ran=bitsNum(r.bits,2,6); this.l3(P,L,out,r.bits.subarray(8,8+147),'CAC'); }
      this.advance(P,L); return;
    }
    if(lich.fct===1){                                             // UDCH / FACCH2
      P.st.udch++;
      const r=nxdnChDecode(NXDN_CH.udch,bits.subarray(36));
      if(!r.ok){ if(bad()) return; }
      else { P.ran=bitsNum(r.bits,2,6); this.l3(P,L,out,r.bits.subarray(8,8+176),'UDCH'); }
    } else if(lich.fct!==3){
      const s=nxdnChDecode(NXDN_CH.sacch,bits.subarray(36));
      if(!s.ok){ if(bad()) return; }
      else {
        P.st.sacch++; P.ran=bitsNum(s.bits,2,6);
        const sr=bitsNum(s.bits,0,2), seg=s.bits.subarray(8,26);
        // суперкадр SACCH: сегменты 1/4 … 4/4 (поле структуры 3, 2, 1, 0) → 72 бита слоя 3
        if(lich.fct===2){
          if(sr===3) P.sf={m:1, b:new Uint8Array(72)};
          else if(P.sf) P.sf.m|=1<<(3-sr);
          if(P.sf){ P.sf.b.set(seg,(3-sr)*18); if(P.sf.m===15){ this.l3(P,L,out,P.sf.b,'SACCH'); P.sf=null; } }
        }
      }
      // слоты по 144 бита: FACCH1 (по LICH) или два кадра голоса по 72 бита
      const opt=lich.opt, fa=[opt===0 || opt===1, opt===0 || opt===2];
      for(let h=0;h<2;h++){
        const off=96+144*h;
        if(fa[h]){
          P.st.facch++;
          const r=nxdnChDecode(NXDN_CH.facch1,bits.subarray(off));
          if(r.ok) this.l3(P,L,out,r.bits.subarray(0,80),'FACCH1'); else if(bad()) return;
        } else {
          for(let v=0;v<2;v++){
            const o=off+72*v, c=P.call;
            out.voice.push({t:P.now, src:'NXDN', kind:'ambe', ran:P.ran, from:c?c.from:null, to:c?c.to:null, ambe:bytesHex(bytesFromBits(bits.subarray(o,o+72)))});
            P.st.voice++;
          }
        }
      }
    }
    this.advance(P,L);
  },
  l3(P,L,out,b,by){
    const f=nxdnL3(b);
    P.st.msgs++;
    if(f.type===0x01){
      const c=P.call;
      if(!c || c.from!==f.from || c.to!==f.to){
        if(c) this.end(P,L,out,'new call');
        P.call={from:f.from, to:f.to, call:f.call, emergency:f.emergency, cipher:f.cipher, t0:P.now, frames:0};
        P.st.calls++;
        nxdnEmit(P,L,out,'call',{from:f.from, to:f.to, call:f.call, opt:f.opt, emergency:f.emergency, cipher:f.cipher, key:f.key, source:by},
          (f.emergency ? 'EMERGENCY ' : '')+f.call+' call '+f.from+' → '+f.to+(f.cipher ? ' [encrypted]' : ''));
      }
    } else if(f.type===0x08 || f.type===0x11 || f.type===0x07){ this.end(P,L,out,f.name); }
    else if(f.type!==0x10){
      const {type,name,...rest}=f;
      nxdnEmit(P,L,out,'msg',{msg:name, type, ...rest, source:by},name+('from' in f ? ' '+f.from+' → '+f.to : '')+('channel' in f ? ' ch '+f.channel : '')+('location' in f ? ' site '+f.location+' ch '+f.ch1+(f.ch2 ? '/'+f.ch2 : '') : '')+(f.hex ? ' '+f.hex : ''));
    }
    if(P.call) P.call.frames++;
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    const dur=(P.now-c.t0)/1000;
    nxdnEmit(P,L,out,'end',{from:c.from, to:c.to, call:c.call, seconds:+dur.toFixed(1), by},'END '+c.from+' → '+c.to+' · '+dur.toFixed(1)+' s ('+by+')');
    P.call=null;
  }};
FSK4.order.push('nxdn');
// NXDN 4800: тот же кадр (192 дибита, LICH, каналы, синхро), но 2400 Бод — кадр идёт 80 мс
FSK4.protos.nxdn48={...FSK4.protos.nxdn, id:'nxdn48', name:'NXDN 4800', baud:NXDN_BAUD/2, lp:2750};
FSK4.order.push('nxdn48');

/* ---- генератор ---- */
const NXDN_FSW=Uint8Array.from('11001101111101011001',c=>+c);
// слоты: массив из двух элементов по 144 бита (FACCH1) или {v:[72 бита, 72 бита]}; ← собирает кадр 384 бита в открытом виде и скремблирует
function nxdnFrame(o){
  const b=new Uint8Array(384); b.set(NXDN_FSW);
  const lb=nxdnLichBits(o.rfct,o.fct,o.opt,o.dir);
  for(let i=0;i<8;i++){ b[20+2*i]=(lb>>(7-i))&1; b[21+2*i]=1; }
  if(o.udch) b.set(nxdnChEncode(NXDN_CH.udch,o.udch),36);
  else if(o.cac) b.set(nxdnChEncode(NXDN_CH.cac,o.cac),36);
  else {
    b.set(nxdnChEncode(NXDN_CH.sacch,o.sacch),36);
    for(let h=0;h<2;h++) b.set(o.slot[h],96+144*h);
  }
  const d=fsk4Dib(b);
  for(let i=10;i<NXDN_FR;i++) d[i]^=nxdnScrBit(i)<<1;
  return d;
}
const nxdnBitsOf=(nums,len)=>{ const b=new Uint8Array(len); nums.forEach(([v,n,o])=>{ for(let i=0;i<n;i++) b[o+i]=(v>>(n-1-i))&1; }); return b; };
// сообщение VCALL / TX_REL и т. п. (слой 3, 64 бита)
function nxdnVcall(type,from,to,ctype,opt,cipher,key){
  return nxdnBitsOf([[type,6,2],[0,8,8],[ctype,3,16],[opt,5,19],[from,16,24],[to,16,40],[cipher||0,2,56],[key||0,6,58]],72);
}
function nxdnSacchData(ran,sr,seg18){ const d=new Uint8Array(26); for(let i=0;i<6;i++) d[2+i]=(ran>>(5-i))&1; d[0]=sr>>1; d[1]=sr&1; d.set(seg18,8); return d; }
function nxdnScript(mode){
  const rnd=(()=>{ let x=0x2468ACE; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&1; }; })();
  const voice=()=>Uint8Array.from({length:72},rnd), seq=[], ran=5;
  if(mode==='voice'){
    const vc=nxdnVcall(0x01,1234,4321,1,0,0,0);
    for(let k=0;k<4;k++){
      const sr=3-k;
      seq.push(nxdnFrame({rfct:2,fct:2,opt:3,dir:1,sacch:nxdnSacchData(ran,sr,vc.subarray(18*k,18*k+18)), slot:[u8cat(voice(),voice()),u8cat(voice(),voice())]}));
    }
    // FACCH1 с TX_REL вместо второго слота
    const tx=nxdnVcall(0x08,1234,4321,1,0,0,0), fa=nxdnChEncode(NXDN_CH.facch1,u8cat(tx.subarray(0,72),new Uint8Array(8)));
    seq.push(nxdnFrame({rfct:2,fct:2,opt:2,dir:1,sacch:nxdnSacchData(ran,3,new Uint8Array(18)), slot:[u8cat(voice(),voice()),fa]}));
  } else if(mode==='cac'){
    // канал управления: SITE_INFO (сайт, каналы) и VCALL_ASSGN
    const cac=(l3)=>{ const d=new Uint8Array(155); for(let i=0;i<6;i++) d[2+i]=(ran>>(5-i))&1; d.set(l3,8); return d; };
    const site=nxdnBitsOf([[0x18,6,2],[0x123456,24,8],[0x0201,16,32],[0x8F01,16,48],[0,24,64],[0,24,88],[3,8,112],[2,4,120],[17,10,124],[433,10,134]],147);
    const asg=nxdnBitsOf([[0x04,6,2],[0,8,8],[1,3,16],[0,5,19],[1234,16,24],[4321,16,40],[9,6,56],[301,10,62]],147);
    for(let k=0;k<2;k++) seq.push(nxdnFrame({rfct:0,fct:0,opt:0,dir:1,cac:cac(site)}), nxdnFrame({rfct:0,fct:0,opt:0,dir:1,cac:cac(asg)}));
  } else {
    // UDCH: заголовок вызова данных (DCALL_HEADER) и произвольное сообщение
    const dh=nxdnVcall(0x09,777,888,4,2,0,0), ud=new Uint8Array(184); for(let i=0;i<6;i++) ud[2+i]=(ran>>(5-i))&1; ud.set(dh,8);
    seq.push(nxdnFrame({rfct:2,fct:1,opt:3,dir:0,udch:ud}));
    const vc=nxdnVcall(0x01,42,43,4,0,0,0), fa=nxdnChEncode(NXDN_CH.facch1,u8cat(vc,new Uint8Array(8)));
    seq.push(nxdnFrame({rfct:1,fct:0,opt:0,dir:1,sacch:nxdnSacchData(ran,0,new Uint8Array(18)), slot:[fa,fa]}));
  }
  return fsk4LevelsOf(u8cat(new Uint8Array(40),...seq,new Uint8Array(40)));
}
FSK4.gen['NXDN 9600 voice']={baud:NXDN_BAUD, alpha:.2, dev:648, script:()=>nxdnScript('voice')};
FSK4.gen['NXDN 9600 data and FACCH1']={baud:NXDN_BAUD, alpha:.2, dev:648, script:()=>nxdnScript('data')};
FSK4.gen['NXDN 9600 control channel (CAC)']={baud:NXDN_BAUD, alpha:.2, dev:648, script:()=>nxdnScript('cac')};
FSK4.gen['NXDN 4800 voice']={baud:NXDN_BAUD/2, alpha:.2, dev:324, script:()=>nxdnScript('voice')};
FSK4.gen['NXDN 4800 control channel (CAC)']={baud:NXDN_BAUD/2, alpha:.2, dev:324, script:()=>nxdnScript('cac')};
