// GSM: приёмный тракт (порт gr-gsm / libosmocore). Проверяем тяжёлые узлы без эфира —
// SCH-декодер, оценку канала + MLSE на синтетическом бёрсте, поиск FCCH и смещения частоты.

export default [
  // --- SCH: свёрточный код + CRC-10 + разбор BSIC/FN (round-trip и известный вектор) ---
  {name:'gsm: SCH conv/CRC round-trip decodes back', fn(){
    const rnd=()=>Math.random()<0.5?0:1;
    for(let trial=0;trial<100;trial++){
      const data=Array.from({length:25},rnd), crc=gsmSchCrc10(data,25);
      const u=new Int8Array(35);
      for(let i=0;i<25;i++) u[i]=data[i];
      for(let i=0;i<10;i++) u[25+i]=(crc>>(9-i))&1;
      const coded=gsmSchConvEncode(u), eb=new Uint8Array(148);
      for(let i=0;i<39;i++){ eb[3+i]=coded[i]; eb[3+39+64+i]=coded[39+i]; }
      const r=gsmDecodeSch(eb);
      if(!r) return 'trial '+trial+': CRC/decode failed';
    }
    return true;
  }},

  {name:'gsm: SCH parses known BSIC and frame number', fn(){
    const ncc=5, bcc=2, t1=1337, t2=7, t3p=3, t3=10*t3p+1;
    const d=new Int8Array(25);
    d[7]=(ncc>>2)&1; d[6]=(ncc>>1)&1; d[5]=ncc&1;
    d[4]=(bcc>>2)&1; d[3]=(bcc>>1)&1; d[2]=bcc&1;
    const t1bit=[10,9,8,7,6,5,4,3,2,1,0], t1idx=[1,0,15,14,13,12,11,10,9,8,23];
    for(let i=0;i<11;i++) d[t1idx[i]]=(t1>>t1bit[i])&1;
    d[22]=(t2>>4)&1; d[21]=(t2>>3)&1; d[20]=(t2>>2)&1; d[19]=(t2>>1)&1; d[18]=t2&1;
    d[17]=(t3p>>2)&1; d[16]=(t3p>>1)&1; d[24]=t3p&1;
    const crc=gsmSchCrc10(d,25), u=new Int8Array(35);
    for(let i=0;i<25;i++) u[i]=d[i];
    for(let i=0;i<10;i++) u[25+i]=(crc>>(9-i))&1;
    const coded=gsmSchConvEncode(u), eb=new Uint8Array(148);
    for(let i=0;i<39;i++){ eb[3+i]=coded[i]; eb[3+39+64+i]=coded[39+i]; }
    const r=gsmDecodeSch(eb);
    return (r && r.t1===t1 && r.t2===t2 && r.t3===t3 && r.ncc===ncc && r.bcc===bcc)
      || 'got '+JSON.stringify(r);
  }},

  // --- канал + MLSE: синтетический нормальный бёрст восстанавливается целиком ---
  {name:'gsm: channel estimation + MLSE recovers a normal burst', fn(){
    const OSR=GSM_OSR, bcc=3, rnd=()=>Math.random()<0.5?0:1;
    const e=new Uint8Array(148); let p=0;
    for(let i=0;i<3;i++) e[p++]=0;
    const d1=Array.from({length:57},rnd); for(const b of d1) e[p++]=b; e[p++]=0;
    for(let i=0;i<26;i++) e[p++]=GSM_TRAIN_SEQ[bcc][i]; e[p++]=0;
    const d2=Array.from({length:57},rnd); for(const b of d2) e[p++]=b;
    for(let i=0;i<3;i++) e[p++]=0;
    const g=gsmGmskMapper(e,148, e[0]===0?1:-1, 0);
    const LEAD=300, N=LEAD+148*OSR+300, re=new Float32Array(N), im=new Float32Array(N);
    const ang=i=>Math.atan2(g.im[i],g.re[i]);
    for(let k=0;k<147;k++){ let da=ang(k+1)-ang(k);
      while(da>Math.PI) da-=2*Math.PI; while(da<-Math.PI) da+=2*Math.PI;
      for(let s=0;s<OSR;s++){ const a=ang(k)+da*s/OSR, idx=LEAD+k*OSR+s; re[idx]=Math.cos(a); im[idx]=Math.sin(a); } }
    for(let s=0;s<OSR;s++){ const idx=LEAD+147*OSR+s; re[idx]=g.re[147]; im[idx]=g.im[147]; }
    const rx=new GsmReceiver(); rx.push(re,im);
    rx.head=LEAD-Math.floor(GSM_GUARD*OSR);   // input[0] — за guard-период до бёрста
    const chanRe=new Float32Array(GSM_CHAN_IMP*OSR), chanIm=new Float32Array(GSM_CHAN_IMP*OSR);
    const bs=rx.getNormImp(bcc,chanRe,chanIm);
    const out=new Uint8Array(148); rx.detectBurst(chanRe,chanIm,bs,out);
    const cmp=(a,b)=>{ let d=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++; return d; };
    const oArr=Array.from(out), oInv=oArr.map(x=>x^1);   // возможна глобальная инверсия
    const d=Math.min(cmp(oArr,Array.from(e)), cmp(oInv,Array.from(e)));
    return d===0 || 'burst mismatches '+d+'/148';
  }},

  // --- BCCH: xCCH-декодер (deinterleave + Viterbi + FIRE CRC) + разбор SI3 ---
  {name:'gsm: BCCH SI3 encode→decode gives Cell ID and PLMN/LAC', fn(){
    const mcc=250, mnc=1, lac=0x2715, ci=0x1a2b;
    const b=new Uint8Array(23);
    b[0]=(0x12<<2)|1; b[1]=0x06; b[2]=0x1b;             // header: len, PD=RR, SI3
    b[3]=ci>>8; b[4]=ci&0xff;
    b[5]=0x52; b[6]=0xf0; b[7]=0x10;                    // LAI digits: MCC 250, MNC 01 (2-digit)
    b[8]=lac>>8; b[9]=lac&0xff;
    for(let i=10;i<23;i++) b[i]=0x2b;
    const bursts=gsmBcchEncode(b);
    const l2=gsmBcchDecode(bursts);
    if(!l2) return 'FIRE CRC failed';
    const si=gsmParseSI(l2);
    return (si.type==='SI3' && si.ci===ci && si.mcc===250 && si.mnc===1 && si.lac===lac)
      || 'got '+JSON.stringify(si);
  }},

  {name:'gsm: BCCH decode rejects a corrupted block (CRC)', fn(){
    const b=new Uint8Array(23); b[1]=0x06; b[2]=0x1b; b[3]=0x12; b[4]=0x34;
    const bursts=gsmBcchEncode(b).map(x=>Int8Array.from(x));
    for(let B=0;B<4;B++) for(let j=0;j<114;j+=4) bursts[B][j]^=1;   // ~25% ошибок — за пределом коррекции
    return gsmBcchDecode(bursts)===null || 'CRC should have rejected';
  }},

  // --- FCCH: тон обнаружен, смещение несущей оценено ---
  {name:'gsm: FCCH found, carrier offset estimated', fn(){
    const OSR=GSM_OSR, target=GSM_TARGET_SR, foff=1500;
    const NB=148, LEAD=300, N=LEAD+NB*OSR+300, re=new Float32Array(N), im=new Float32Array(N);
    for(let i=0;i<N;i++){ re[i]=1e-3*(Math.random()-.5); im[i]=1e-3*(Math.random()-.5); }
    let ph=0; const dTone=(Math.PI/2)/OSR, dOff=2*Math.PI*foff/target;
    for(let s=0;s<NB*OSR;s++){ ph+=dTone+dOff; re[LEAD+s]=Math.cos(ph); im[LEAD+s]=Math.sin(ph); }
    const rx=new GsmReceiver();
    rx.push(re,im);
    const found=rx.findFcch();
    return (found && Math.abs(rx.freqOffset-foff)<200) || 'found='+found+' off='+(rx.freqOffset||0).toFixed(1);
  }},

  // --- узел: ресемплер и разбор гоняются без ошибок на живом IQ ---
  {name:'gsm: gsmRx node runs on an IQ stream without errors', arg:[
    [['iqGen',{sr:'2048000',fc:945e6,mode:'FM',off:100000,lvl:-20,noise:-50}],['gsmRx',{}]],
    ['0.iq>1.in']], fn([g,w]){
    const ns=T.build(g,w);
    T.run(0.2);
    const e=T.errors(); if(e.length) return e.join('; ');
    const rx=ns[1];
    return (typeof rx.out.freq==='number' && rx.rx && rx.rx.dCounter>0) || 'no output: dCounter='+(rx.rx&&rx.rx.dCounter);
  }},
];
