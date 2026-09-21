function mseq(n,poly,len){                          // м-последовательность, полиномы проверены на период
  let reg=1; const out=[], mask=(1<<n)-1;
  for(let i=0;i<len;i++){
    out.push(reg&1? 1:-1);
    let fb=reg&poly, p=0; while(fb){ p^=fb&1; fb>>=1; }
    reg=((reg>>1)|(p<<(n-1)))&mask; }
  return out;
}
const PATTERNS={
  'Barker 7'    :'1110010',
  'Barker 11'   :'11100010010',
  'Barker 13'   :'1111100110101',
  'PN sequence 31':null, 'PN sequence 63':null, 'PN sequence 127':null,
  'HFDL: preamble A':null, 'HFDL: M1 (rate)':null, 'custom':null
};
function patBits(n){
  const k=n.p.pat;
  if(k==='PN sequence 31')  return mseq(5,0b10111,31);
  if(k==='PN sequence 63')  return mseq(6,0b100001,63);
  if(k==='PN sequence 127') return mseq(7,0b1000001,127);
  if(k==='HFDL: preamble A') return hfdlA();
  if(k==='HFDL: M1 (rate)') return hfdlM1(clamp(n.p.shift|0,0,7));
  const src=(k==='custom'? n.p.bits : PATTERNS[k])||'';
  const out=[];
  for(const c of String(src)) if(c==='1'||c==='+') out.push(1); else if(c==='0'||c==='-') out.push(-1);
  return out.length? out : [1];
}

def({ id:'corr', title:'Pattern Correlator', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'baud',t:'num'},{n:'thr',t:'num'},{n:'abs',t:'num'},{n:'dead',t:'num'},{n:'shift',t:'num'}], outs:[{n:'corr',t:'sig'},{n:'sync',t:'sig'},{n:'peak',t:'num'}],
  view:{h:80}, resize:true, readout:true,
  params:[{n:'pat',t:'select',opts:Object.keys(PATTERNS),d:'Barker 13'},
          {n:'bits',t:'text',d:'11100010010',label:'custom pattern'},
          {n:'baud',t:'range',min:1,max:4800,step:.01,d:1200,log:true},
          {n:'thr',t:'range',min:.1,max:1,step:.01,d:.8,label:'threshold'},
          {n:'abs',t:'check',d:true,label:'ignore sign'},
          {n:'dead',t:'range',min:0,max:1000,step:1,d:0,label:'dead time, ms'},
          {n:'shift',t:'range',min:0,max:7,step:1,d:0,label:'M1 variant (HFDL)'}],
  init:n=>{n.key='';n.hist=[];n.peak=0;n.cnt=0;n.m1=0;n.m2=0;n.dead=0;},
  process(n,I){
    for(const k of ['baud','thr','dead','shift']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.abs==='number') setMod(n,'abs',I.abs>=0.5);
    const oc=buf(n,'corr'), os=buf(n,'sync');
    const sps=Math.max(1,Eng.sr/n.p.baud);
    const key=n.p.pat+'/'+n.p.bits+'/'+sps.toFixed(3);
    if(n.key!==key){
      n.key=key; n.pat=patBits(n); n.P=n.pat.length;
      n.taps=new Int32Array(n.P);
      for(let k=0;k<n.P;k++) n.taps[k]=Math.round(k*sps);
      n.L=n.taps[n.P-1]+1;
      n.ring=new Float32Array(n.L); n.w=0; n.ss=0; }
    const P=n.P, L=n.L, ring=n.ring, pat=n.pat, taps=n.taps;
    let best=0;
    for(let i=0;i<BLOCK;i++){
      const old=ring[n.w], nv=I.in?I.in[i]:0;
      n.ss += nv*nv - old*old;                       // энергия всего окна, а не только отсчётов образца
      ring[n.w]=nv;
      let acc=0;                                     // корреляция по отсчётам символов
      for(let k=0;k<P;k++) acc+=ring[(n.w-taps[k]+L*2)%L]*pat[P-1-k];
      const rms=Math.sqrt(Math.max(0,n.ss)/L);
      const c=clamp(acc/(P*rms+1e-9),-2,2);
      const m=n.p.abs? Math.abs(c) : c;
      oc[i]=c;
      // импульс на вершине: предыдущий отсчёт выше порога и выше обоих соседей
      let hit=(n.m1>=n.p.thr && n.m1>n.m2 && n.m1>=m);
      if(n.dead>0){ n.dead--; hit=false; }           // не считаем повторы внутри мёртвого времени
      else if(hit) n.dead=Math.round(n.p.dead*Eng.sr/1000);
      os[i]=hit?1:0; if(hit) n.cnt++;
      n.m2=n.m1; n.m1=m;
      if(m>best) best=m;
      n.w=(n.w+1)%L; }
    n.peak=n.peak*.7+best*.3;
    n.hist.push(best); if(n.hist.length>200) n.hist.shift();
    return {corr:oc, sync:os, peak:best}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    cx.strokeStyle=themeColor('--err')+'66'; cx.beginPath();
    const ty=H-n.p.thr*H; cx.moveTo(0,ty); cx.lineTo(W,ty); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/200*W, y=H-clamp(n.hist[i],0,1)*H;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent =
      'peak '+n.peak.toFixed(2)+' · length '+(n.P||0)+' · hits '+n.cnt+
      (n.p.pat==='HFDL: M1 (rate)'? '\n'+HFDL_RATES[clamp(n.p.shift|0,0,7)] : ''); }});


/* ---------- чирп-модем (chirp spread spectrum, идея как у LoRa) ----------
   Символ = ЦИКЛИЧЕСКИЙ СДВИГ одного и того же ЛЧМ-импульса по времени, а не частота/фаза —
   отсюда устойчивость к Допплеру (сдвиг частоты после де-чирпа превращается в предсказуемый
   сдвиг ПО ВРЕМЕНИ пика, а не в потерю сигнала) и к переотражениям (у ЛЧМ узкая
   автокорреляция — лучи с разной задержкой видны как отдельные пики, а не каша). */

def({ id:'chirpTx', title:'Chirp Modem: Transmitter', cat:'Protocols',
  ins:[{n:'sym',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'sf',t:'select',opts:['4','5','6','7','8','9','10'],d:'6',label:'SF (bits/symbol)'},
          {n:'bw',t:'range',min:200,max:8000,step:10,d:2000,log:true,label:'bandwidth, Hz'},
          {n:'f0',t:'range',min:100,max:()=>Eng.sr/2-8000,step:10,d:1000,log:true,label:'base, Hz'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'preN',t:'range',min:0,max:32,step:1,d:8,label:'preamble, symbols (0 = off)'},
          {n:'dataN',t:'range',min:1,max:64,step:1,d:16,label:'data frame, symbols'}],
  // Кадр: [preN символов "0" подряд] → [1 период тишины — граница кадра] → [dataN символов данных] → повтор.
  // Приёмник ловит преамбулу по её ПЕРИОДИЧНОСТИ (стабильный пик БПФ на любом сдвиге фазы —
  // так корректно измерить МОЖНО, даже не зная точного начала символа), а границу кадра — по
  // самой паузе (просад RMS), а не по спецсимволу: пробовал сделать маркером down-чирп
  // (обратный свип), но численно он даёт почти такую же уверенность БПФ, что и обычный —
  // не различить надёжно. Тишина отличается однозначно при любом SF/bw.
  init:n=>{ n.ph=0; n.tPos=0; n.state='pre'; n.cnt=0; n.curSym=0; },
  process(n,I){
    const M=1<<clamp(n.p.sf|0,4,10), bw=n.p.bw, f0=n.p.f0, T=M/bw, amp=n.p.amp;
    const o=buf(n,'out');
    for(let i=0;i<BLOCK;i++){
      const frac=(n.tPos/T)%1;
      if(n.state==='gap') o[i]=0;
      else {
        const shifted=(frac+(n.state==='data'?n.curSym:0)/M)%1;
        n.ph=(n.ph+(f0+bw*shifted)/Eng.sr)%1;
        o[i]=Math.sin(2*Math.PI*n.ph)*amp;
      }
      n.tPos+=1/Eng.sr;
      if(n.tPos>=T){
        n.tPos-=T; n.cnt++;
        if(n.p.preN<=0){                                                     // преамбула выключена — просто гоним данные
          n.state='data'; n.curSym=clamp(Math.round(pv(n,I,'sym')),0,M-1); }
        else if(n.state==='pre' && n.cnt>=n.p.preN){ n.state='gap'; n.cnt=0; }
        else if(n.state==='gap'){ n.state='data'; n.cnt=0; n.curSym=clamp(Math.round(pv(n,I,'sym')),0,M-1); }
        else if(n.state==='data'){
          if(n.cnt>=n.p.dataN){ n.state='pre'; n.cnt=0; }
          else n.curSym=clamp(Math.round(pv(n,I,'sym')),0,M-1);
        }
      } }
    return {out:o}; }});

def({ id:'chirpRx', title:'Chirp Modem: Receiver (de-chirp + FFT)', cat:'Decoders', readout:true,
  ins:[{n:'in',t:'sig'}], outs:[{n:'sym',t:'num'},{n:'level',t:'num'},{n:'locked',t:'num'}],
  params:[{n:'sf',t:'select',opts:['4','5','6','7','8','9','10'],d:'6',label:'SF (bits/symbol)'},
          {n:'bw',t:'range',min:200,max:8000,step:10,d:2000,log:true,label:'bandwidth, Hz'},
          {n:'f0',t:'range',min:100,max:()=>Eng.sr/2-8000,step:10,d:1000,log:true,label:'base, Hz'},
          {n:'preN',t:'range',min:0,max:32,step:1,d:8,label:'preamble, symbols (0 = off, see resync)'},
          {n:'shift',t:'range',min:-50,max:50,step:.5,d:0,label:'manual sync offset, ms (if preamble is off)'},
          {n:'squelch',t:'range',min:0,max:1,step:.01,d:.85,label:'confidence threshold (hold previous symbol below it)'},
          {n:'resync',t:'button',label:'Sync manually now',fn:n=>{
            const M=1<<clamp(n.p.sf|0,4,10), T=M/n.p.bw;
            let t=-(n.p.shift/1000)%T; if(t<0) t+=T;
            n.ph=0; n.gi=0; n.w2=0; n.tPos=t; n.mode='locked'; n.gapSeen=false;
            if(n.ringI){ n.ringI.fill(0); n.ringQ.fill(0); } }}],
  // Приём без знания сдвига разбирается так: умножаем принятый сигнал на СОПРЯЖЁННЫЙ (обратный,
  // "нулевой") опорный чирп — де-чирп. Циклически сдвинутый (символ k) чирп после этого
  // превращается в ОБЫЧНЫЙ ТОН частотой k·BW/M — вместо декодирования сдвига по времени
  // достаточно найти пик БПФ. Ровно так это делает и настоящий LoRa-приёмник.
  //
  // Автозахват (если preN>0 совпадает с передатчиком): 'search' — скользящее (по одному
  // отсчёту, не по M) окно ищет СТАБИЛЬНЫЙ пик БПФ — это признак преамбулы, причём измерить
  // его можно при ЛЮБОМ фазовом сдвиге относительно истинной границы символа (следствие
  // периодичности преамбулы). Дождавшись такой стабильности несколько периодов подряд, ждём
  // провал RMS (пауза-маркер) и её конец — этот момент и есть истинная граница кадра. КРИТИЧНО
  // в этот момент сбросить не только счётчик окна, но и ФАЗУ самого опорного генератора
  // (tPos/ph) — иначе появляется постоянный (но неизвестный per-run) сдвиг бина: скользящее
  // окно само по себе даёт стабильный пик при любом сдвиге, но НЕ обязательно в правильном
  // бине, если опорный генератор не привязан к истинному t=0 передатчика (проверено численно —
  // без сброса фазы бин уезжает на случайную величину, зависящую от сдвига). Иначе (preN=0
  // или sf/bw не совпадают на TX) — только ручная кнопка «Синхронизировать сейчас» (общие часы
  // TX/RX в одном графе, дрейфа нет — фиксированную задержку достаточно скомпенсировать раз).
  //
  // Остаточная погрешность автозахвата — иногда ±1 к символу (квантование по одному
  // децимированному отсчёту в момент обнаружения паузы). Реальные протоколы для этого и держат
  // CRC/избыточность, а не гоняются за идеальным попаданием — здесь то же самое: это не баг,
  // а fundamental предел этого метода поиска границы.
  //
  // Ещё два места, где интуиция обманывает (проверено численно, не на глаз):
  // 1) прореживать нужно РОВНО до bw (комплексные I/Q дают безальясинговый диапазон шириной
  //    именно bw, не bw/2) — БПФ тогда получается ровно M точек без набивки нулями, и разрыв
  //    частоты внутри символа (у чирпа он есть у каждого k, кроме k=0) сам "заворачивается"
  //    обратно в тот же бин за счёт периодичности ДПФ.
  // 2) опорный чирп нужно брать со сдвигом на половину диапазона — тогда полезный сигнал после
  //    де-чирпа лежит симметрично ±bw/2, а не 0..bw, иначе любой фильтр перед прореживанием
  //    подрезает именно крайние символы (0, 1, M-2, M-1) — самая коварная форма этой ошибки.
  init:n=>{ n.ph=0; n.tPos=0; n.gi=0; n.w2=0; n.M=0; n.DEC=0; n.sym=0; n.lvl=0;
            n.mode='search'; n.filled=0; n.hiStreak=0; n.candBin=-1; n.gapSeen=false;
            n.rms=0; n.sigRms=0; n.sqAcc=0; },
  process(n,I){
    const M=1<<clamp(n.p.sf|0,4,10), bw=n.p.bw, f0=n.p.f0, T=M/bw;
    const DEC=Math.max(1,Math.round(Eng.sr/bw));
    const STREAK_NEED=M*2, THRESH_HI=0.30;
    if(n.M!==M||n.DEC!==DEC){
      n.M=M; n.DEC=DEC; n.w2=0; n.mode= n.p.preN>0 ? 'search':'locked';
      n.filled=0; n.hiStreak=0; n.candBin=-1; n.gapSeen=false;
      n.ringI=new Float32Array(M); n.ringQ=new Float32Array(M); }
    const evalWindow=()=>{
      const re=Float32Array.from(n.ringI), im=Float32Array.from(n.ringQ);
      fft(re,im);
      let best=0, sum=0, bestBin=0;
      for(let k=0;k<M;k++){ const mag=Math.hypot(re[k],im[k]); sum+=mag; if(mag>best){ best=mag; bestBin=k; } }
      return {lvl:best/((sum/M)+1e-9)/8, bestBin}; };
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      const frac=(n.tPos/T + 0.5)%1;                          // опорный со сдвигом полдиапазона — см. п.2 выше
      const f=f0+bw*frac;
      n.ph=(n.ph+f/Eng.sr)%1;
      const c=Math.cos(2*Math.PI*n.ph), s=Math.sin(2*Math.PI*n.ph);
      n.sqAcc+=x*x;
      n.tPos+=1/Eng.sr; if(n.tPos>=T) n.tPos-=T;
      if(n.gi%DEC===0){
        const rmsChunk=Math.sqrt(n.sqAcc/DEC); n.sqAcc=0;
        n.rms=n.rms*0.5+rmsChunk*0.5;
        if(n.mode==='search'){
          const vi=x*c, vq=-x*s;
          n.ringI.copyWithin(0,1); n.ringQ.copyWithin(0,1);
          n.ringI[M-1]=vi; n.ringQ[M-1]=vq;
          n.filled=Math.min(n.filled+1,M);
          if(!n.gapSeen){
            if(n.filled>=M){
              const {lvl,bestBin}=evalWindow();
              if(lvl>THRESH_HI){
                if(n.candBin===bestBin) n.hiStreak++; else { n.candBin=bestBin; n.hiStreak=1; }
                n.sigRms=n.sigRms*0.95+n.rms*0.05;             // калибруем типичный RMS, пока уверенно видим преамбулу
              } else { n.hiStreak=0; n.candBin=-1; }
              if(n.hiStreak>=STREAK_NEED) n.gapSeen='waiting_low';
            }
          } else if(n.gapSeen==='waiting_low'){
            if(n.rms<n.sigRms*0.35) n.gapSeen='waiting_high';
          } else if(n.gapSeen==='waiting_high'){
            if(n.rms>n.sigRms*0.5){
              n.mode='locked'; n.w2=0; n.gapSeen=false; n.hiStreak=0; n.candBin=-1;
              n.ringI.fill(0); n.ringQ.fill(0);
              n.tPos=T/M; n.ph=0;                              // критично: выравниваем фазу опорного генератора, не только счётчик окна
            }
          }
        } else {
          n.ringI[n.w2%M]=x*c; n.ringQ[n.w2%M]=-x*s; n.w2++;
          if(n.w2%M===0){
            const {lvl,bestBin}=evalWindow();
            if(lvl>=n.p.squelch) n.sym=(bestBin+(M>>1))%M;    // ниже порога — держим предыдущий символ, не переписываем на вероятный мусор
            n.lvl=clamp(lvl,0,1);
            if(n.p.preN>0 && n.rms<n.sigRms*0.35){             // сами наткнулись на паузу — кадр кончился, ищем следующий
              n.mode='search'; n.filled=0; n.hiStreak=0; n.candBin=-1; n.gapSeen=false; }
          }
        }
      }
      n.gi++; }
    return {sym:n.sym, level:n.lvl, locked:n.mode==='locked'?1:0}; },
  draw(n){
    n.el.querySelector('.readout').textContent =
      (n.mode==='locked'? 'symbol '+n.sym+' / '+((1<<clamp(n.p.sf|0,4,10))-1)+' · confidence '+(n.lvl*100).toFixed(0)+'%'
                         : 'searching preamble… ('+(n.gapSeen||'waiting for a stable peak')+')'); }});


/* ---------- кадры и блочные коды ---------- */
const CRCS={
  'CRC-16/X.25 (HDLC)':{w:16,poly:0x1021,init:0xFFFF,refl:true,xor:0xFFFF},
  'CRC-16/CCITT'      :{w:16,poly:0x1021,init:0xFFFF,refl:false,xor:0},
  'CRC-16/IBM'        :{w:16,poly:0x8005,init:0,     refl:true, xor:0},
  'CRC-32'            :{w:32,poly:0x04C11DB7,init:0xFFFFFFFF,refl:true,xor:0xFFFFFFFF}
};
function revBits(v,n){ let r=0; for(let i=0;i<n;i++){ r=(r<<1)|((v>>>i)&1); } return r>>>0; }
function crcCalc(bytes,spec){
  const {w,poly,init,refl,xor}=spec;
  const top=w===32?0x80000000:0x8000, mask=w===32?0xFFFFFFFF:0xFFFF;
  let c=init>>>0;
  for(let b of bytes){
    if(refl) b=revBits(b,8);
    c=(c^(b<<(w-8)))>>>0;
    for(let k=0;k<8;k++) c=((c&top)? ((c<<1)^poly) : (c<<1))>>>0;
    c=(c&mask)>>>0; }
  c=(c^xor)>>>0;
  if(refl) c=revBits(c,w)>>>0;
  return (c&mask)>>>0;
}
function bitsToBytes(d){                            // мягкие значения → байты, старший бит первым
  const out=[];
  for(let i=0;i+8<=d.length;i+=8){ let v=0;
    for(let k=0;k<8;k++) v=(v<<1)|(d[i+k]>0?1:0);
    out.push(v); }
  return out;
}

function crcBitsToBytes(d,msb){                     // порядок бит внутри байта
  if(msb) return bitsToBytes(d);
  const c=new Float32Array(d.length);
  for(let i=0;i+8<=d.length;i+=8) for(let k=0;k<8;k++) c[i+k]=d[i+7-k];
  return bitsToBytes(c);
}
function bytesToBlk(bytes,id){
  const o=new Float32Array(bytes.length*8);
  for(let i=0;i<bytes.length;i++) for(let k=0;k<8;k++) o[i*8+k]=(bytes[i]>>(7-k))&1?1:-1;
  return {d:o,n:o.length,id};
}

def({ id:'crcAdd', title:'CRC: Add', cat:'Protocols',
  ins:[{n:'blk',t:'blk'},{n:'msb',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'kind',t:'select',opts:Object.keys(CRCS),d:'CRC-16/X.25 (HDLC)'},
          {n:'msb',t:'check',d:true,label:'MSB first'}],
  init:n=>{n.bid=-1;n.text='';},
  process(n,I){
    if(typeof I.msb==='number') setMod(n,'msb',I.msb>=0.5);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,text:n.text};
    n.bid=b.id;
    const spec=CRCS[n.p.kind], W=spec.w/8;
    const bytes=crcBitsToBytes(b.d,n.p.msb);
    const c=crcCalc(bytes,spec), ext=bytes.slice();
    for(let i=W-1;i>=0;i--) ext.push((c>>>(8*i))&0xff);
    n.blkOut=bytesToBlk(ext,b.id);
    n.text='added '+n.p.kind+' = '+c.toString(16);
    return {blk:n.blkOut,text:n.text}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'…'; }});


def({ id:'crcCheck', title:'CRC: Check', cat:'Decoders',
  ins:[{n:'blk',t:'blk'},{n:'msb',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'ok',t:'num'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'kind',t:'select',opts:Object.keys(CRCS),d:'CRC-16/X.25 (HDLC)'},
          {n:'msb',t:'check',d:true,label:'MSB first'}],
  init:n=>{n.bid=-1;n.text='';n.ok=0;},
  process(n,I){
    if(typeof I.msb==='number') setMod(n,'msb',I.msb>=0.5);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,ok:n.ok,text:n.text};
    n.bid=b.id;
    const spec=CRCS[n.p.kind], W=spec.w/8;
    const bytes=crcBitsToBytes(b.d,n.p.msb);
    const body=bytes.slice(0,bytes.length-W), got=bytes.slice(bytes.length-W);
    let g=0; for(const x of got) g=((g<<8)|x)>>>0;
    const want=crcCalc(body,spec);
    n.ok=(g>>>0)===(want>>>0)?1:0;
    n.text=(n.ok?'✓ CRC matches ':'✗ CRC mismatch ')+
      'got '+g.toString(16)+' expected '+want.toString(16)+' · bytes '+bytes.length;
    n.blkOut=bytesToBlk(body,b.id);
    return {blk:n.blkOut,ok:n.ok,text:n.text}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'…'; }});


// Самосинхронизирующийся скремблер: TX прогоняет через регистр СВОЙ выход,
// RX — ПРИНЯТЫЙ бит; отсюда самосинхронизация (регистр сам восстанавливается
// из входного потока, не требуя отдельной привязки фазы к передатчику).
def({ id:'scrambleTx', title:'Scrambler: Transmit', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'len',t:'num'},{n:'tap',t:'num'},{n:'baud',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'additive',t:'check',d:false,label:'additive (not self-sync.)'},
          {n:'len',t:'range',min:5,max:23,step:1,d:17,label:'register length'},
          {n:'tap',t:'range',min:1,max:22,step:1,d:12,label:'second tap'},
          {n:'baud',t:'range',min:1,max:9600,step:.01,d:1200,log:true}],
  init:n=>{n.reg=1;n.ph=0;n.cur=1;},
  process(n,I){
    for(const k of ['len','tap','baud']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.additive==='number') setMod(n,'additive',I.additive>=0.5);
    const o=buf(n,'out'), inc=n.p.baud/Eng.sr;
    const L=n.p.len, T=Math.min(n.p.tap,L-1), mask=(1<<L)-1;
    for(let i=0;i<BLOCK;i++){
      n.ph+=inc;
      if(n.ph>=1){ n.ph-=1;
        const b=(I.in?I.in[i]:0)>0?1:0;
        const fb=(((n.reg>>(L-1))&1)^((n.reg>>(T-1))&1))&1;
        const out=b^fb;
        n.reg=((n.reg<<1)|(n.p.additive?fb:out))&mask;
        n.cur=out?1:-1; }
      o[i]=n.cur; }
    return {out:o}; }});


def({ id:'scrambleRx', title:'Scrambler: Receive (descrambler)', cat:'Decoders',
  ins:[{n:'in',t:'sig'},{n:'len',t:'num'},{n:'tap',t:'num'},{n:'baud',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'additive',t:'check',d:false,label:'additive (not self-sync.)'},
          {n:'len',t:'range',min:5,max:23,step:1,d:17,label:'register length'},
          {n:'tap',t:'range',min:1,max:22,step:1,d:12,label:'second tap'},
          {n:'baud',t:'range',min:1,max:9600,step:.01,d:1200,log:true}],
  init:n=>{n.reg=1;n.ph=0;n.cur=1;},
  process(n,I){
    for(const k of ['len','tap','baud']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.additive==='number') setMod(n,'additive',I.additive>=0.5);
    const o=buf(n,'out'), inc=n.p.baud/Eng.sr;
    const L=n.p.len, T=Math.min(n.p.tap,L-1), mask=(1<<L)-1;
    for(let i=0;i<BLOCK;i++){
      n.ph+=inc;
      if(n.ph>=1){ n.ph-=1;
        const b=(I.in?I.in[i]:0)>0?1:0;
        const fb=(((n.reg>>(L-1))&1)^((n.reg>>(T-1))&1))&1;
        const out=b^fb;
        n.reg=((n.reg<<1)|(n.p.additive?fb:b))&mask;
        n.cur=out?1:-1; }
      o[i]=n.cur; }
    return {out:o}; }});


/* ---------- восстановление такта NRZ (для реального дискриминаторного сигнала, не I/Q) ---------- */
// тот же приём, что внутри hdlc: фронт входа = середина следующего бита.
// нужен, когда 'in' — это уже готовый биполярный поток (например, звук с дискриминатора FM),
// а не квадратурный сигнал (для него — 'gardner').

def({ id:'nrzclk', title:'NRZ Clock (edge-lock)', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'baud',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'clk',t:'sig'},{n:'bit',t:'sig'}],
  params:[{n:'baud',t:'range',min:1,max:9600,step:.01,d:1200,log:true},
          {n:'invert',t:'check',d:false}],
  init:n=>{n.ph=0;n.prevLvl=0;n.cur=0;},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    const oc=buf(n,'clk'), ob=buf(n,'bit');
    const inc=n.p.baud/Eng.sr;
    for(let i=0;i<BLOCK;i++){
      let lvl=(I.in?I.in[i]:0)>0?1:0; if(n.p.invert) lvl^=1;
      if(lvl!==n.prevLvl) n.ph=0.5;                  // фронт входа — фаза на середину следующего бита
      n.prevLvl=lvl;
      n.ph+=inc; let tick=0;
      if(n.ph>=1){ n.ph-=1; tick=1; n.cur=lvl?1:-1; }
      oc[i]=tick; ob[i]=n.cur; }
    return {clk:oc, bit:ob}; }});


/* ---------- синхрослово + кадр в одном узле ---------- */
// syncword+frame раздельно не годятся на высоком бодрейте: sync у syncword — 'num',
// т.е. одно значение на весь блок (128+ сэмплов = несколько битовых тактов на 1200 бод),
// и frame при срабатывании начинает собирать с ПЕРВОГО тика в этом блоке, а не с того,
// на котором реально совпало слово — кадр съезжает на случайное число бит от раза к разу.
// Здесь совпадение и сбор кадра — в одном побитовом цикле, без этого зазора.

def({ id:'syncFrame', title:'Sync Word → Frame', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'clk',t:'sig'}],
  outs:[{n:'blk',t:'blk'},{n:'sync',t:'num'},{n:'errs',t:'num'}],
  readout:true, tall:true,
  params:[{n:'word',t:'text',d:'85CFAB45',label:'sync word (hex)'},
          {n:'tol',t:'range',min:0,max:8,step:1,d:0,label:'error tolerance'},
          {n:'len',t:'range',min:8,max:8192,step:1,d:64,label:'frame length, bits'},
          {n:'fmt',t:'select',opts:['hex','text'],d:'text'}],
  init:n=>{n.reg=0n; n.state=0; n.k=0; n.buf=null; n.text=''; n.bid=0; n.err=0;},
  process(n,I){
    const hex=String(n.p.word).replace(/[^0-9a-fA-F]/g,'')||'85CFAB45';
    const W=hex.length*4, want=BigInt('0x'+hex), mask=(1n<<BigInt(W))-1n;
    const L=n.p.len;
    if(!n.buf||n.buf.length!==L) n.buf=new Float32Array(L);
    let pulse=0;
    for(let i=0;i<BLOCK;i++){
      const c=I.clk?I.clk[i]:0; if(c<=.5) continue;   // тик битового такта — дальше всё побитово
      const b=(I.in?I.in[i]:0)>0?1:0;
      if(n.state===0){
        n.reg=((n.reg<<1n)|BigInt(b))&mask;
        let x=n.reg^want, e=0; while(x){ e+=Number(x&1n); x>>=1n; }
        if(e<=n.p.tol){ pulse=1; n.err=e; n.state=1; n.k=0; }  // слово поймано на ЭТОМ такте — с него и кадр
      } else {
        n.buf[n.k++]=b>0?1:-1;
        if(n.k>=L){
          n.frame={d:n.buf.slice(),n:L,id:++n.bid};
          sfText(n);
          n.state=0; n.reg=0n; } } }
    return {blk:n.frame||null, sync:pulse, errs:n.err}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text){ r.textContent=n.text||'…'; r.scrollTop=0; } }});

function sfText(n){
  const d=n.frame.d;
  let bits=''; for(let i=0;i<d.length;i++) bits+=d[i]>0?'1':'0';
  let str='';
  if(n.p.fmt==='hex'){ for(let i=0;i<bits.length;i+=4) str+=parseInt(bits.substr(i,4).padEnd(4,'0'),2).toString(16); }
  else { for(let i=0;i+8<=bits.length;i+=8){ const c=parseInt(bits.substr(i,8),2);
    str+=(c>=32&&c<127)?String.fromCharCode(c):'·'; } }
  n.text='frame #'+n.frame.id+'\n'+str+'\n'+n.text;
  if(n.text.length>4000) n.text=n.text.slice(0,3000);
}


def({ id:'syncword', title:'Sync Word Search', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'clk',t:'sig'},{n:'tol',t:'num'},{n:'baud',t:'num'},{n:'inv',t:'num'}],
  outs:[{n:'sync',t:'num'},{n:'errs',t:'num'},{n:'bits',t:'sig'}],
  readout:true,
  params:[{n:'word',t:'text',d:'7E',label:'word (hex)'},
          {n:'tol',t:'range',min:0,max:8,step:1,d:0,label:'error tolerance'},
          {n:'baud',t:'range',min:1,max:9600,step:.01,d:1200,log:true},
          {n:'inv',t:'check',d:false,label:'invert'}],
  init:n=>{n.reg=0n;n.ph=0;n.prevC=0;n.cnt=0;n.pulse=0;n.err=0;},
  process(n,I){
    if(typeof I.tol==='number') setMod(n,'tol',I.tol);
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.inv==='number') setMod(n,'inv',I.inv>=0.5);
    const ob=buf(n,'bits');
    const hex=String(n.p.word).replace(/[^0-9a-fA-F]/g,'')||'7E';
    const W=hex.length*4;
    const want=BigInt('0x'+hex);
    const mask=(1n<<BigInt(W))-1n;
    const inc=n.p.baud/Eng.sr;
    let pulse=0;
    for(let i=0;i<BLOCK;i++){
      let tick=false;
      if(I.clk){ const c=I.clk[i]; tick=(c>.5&&n.prevC<=.5); n.prevC=c; }
      else { n.ph+=inc; if(n.ph>=1){ n.ph-=1; tick=true; } }
      if(tick){
        let b=(I.in?I.in[i]:0)>0?1:0; if(n.p.inv) b^=1;
        n.reg=((n.reg<<1n)|BigInt(b))&mask;
        let x=n.reg^want, e=0;
        while(x){ e+=Number(x&1n); x>>=1n; }        // расстояние Хэмминга до образца
        if(e<=n.p.tol){ pulse=1; n.cnt++; n.err=e; }
        n.cur=b?1:-1; }
      ob[i]=n.cur||0; }
    n.pulse=pulse;
    return {sync:pulse, errs:n.err, bits:ob}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'found '+n.cnt+' · errors in last '+n.err; }});


function syncTxQueue(n){
  const hex=String(n.p.word).replace(/[^0-9a-fA-F]/g,'')||'85CFAB45';
  const bits=[]; for(const ch of hex){ const v=parseInt(ch,16); for(let k=3;k>=0;k--) bits.push((v>>k)&1); }
  const payload=[...n.lastBlk.d].map(v=>v>0?1:0);
  n.q=[...bits,...payload];
  n.text='frame: word '+bits.length+' bits + data '+payload.length+' bits';
}
// Пара к syncword/syncFrame: там ищут синхрослово на приёме, здесь его вставляют
// перед кадром на передаче — раньше вставлять было нечем.
def({ id:'syncTx', title:'Sync Word: Insert Before Frame', cat:'Protocols', readout:true,
  ins:[{n:'blk',t:'blk'},{n:'go',t:'num'},{n:'baud',t:'num'},{n:'loop',t:'num'}], outs:[{n:'bit',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'word',t:'text',d:'85CFAB45',label:'sync word (hex)'},
          {n:'baud',t:'range',min:1,max:9600,step:.01,d:1200,log:true},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>{n.trig=true;}}],
  init:n=>{n.q=[];n.cur=0;n.left=0;n.bid=-1;n.prevGo=0;n.trig=false;n.text='waiting';},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const o=buf(n,'bit'), spb=Eng.sr/Math.max(1,n.p.baud);
    const b=I.blk, go=I.go||0;
    if(b && b.id!==n.bid){ n.bid=b.id; n.lastBlk=b; }
    if((go>.5&&n.prevGo<=.5)||n.trig){ n.trig=false; if(n.lastBlk) syncTxQueue(n); }
    n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){
        if(!n.q.length && n.p.loop && n.lastBlk) syncTxQueue(n);
        if(n.q.length){ n.cur=n.q.shift(); n.left=spb; }
        else n.left=spb; }
      n.left--; o[i]=n.cur?1:-1; }
    return {bit:o, busy:n.q.length?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting'; }});


def({ id:'ax25Rx', title:'Receive AX.25/HDLC', cat:'Decoders',
  ins:[{n:'in',t:'sig'},{n:'clk',t:'sig'},{n:'baud',t:'num'},{n:'nrzi',t:'num'},{n:'inv',t:'num'},{n:'ax25',t:'num'}],
  outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'},{n:'frames',t:'num'},{n:'crcOk',t:'num'}],
  readout:true, tall:true,
  params:[{n:'baud',t:'range',min:50,max:9600,step:.01,d:1200,log:true},
          {n:'nrzi',t:'check',d:true,label:'NRZI'},
          {n:'inv',t:'check',d:false,label:'invert'},
          {n:'ax25',t:'check',d:true,label:'parse AX.25'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';n.ok=0;n.bad=0;}}],
  init:n=>{ n.ph=0; n.prevLvl=0; n.lastS=1; n.prevC=0; n.sr=0; n.bitc=0; n.ones=0;
            n.bytes=[]; n.cur=0; n.nb=0; n.inFrame=false; n.text=''; n.ok=0; n.bad=0; n.bid=0; },
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    for(const k of ['nrzi','inv','ax25']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const inc=n.p.baud/Eng.sr;
    for(let i=0;i<BLOCK;i++){
      let lvl=(I.in?I.in[i]:0)>0?1:0; if(n.p.inv) lvl^=1;
      let tick=false;
      if(I.clk){ const c=I.clk[i]; tick=(c>.5&&n.prevC<=.5); n.prevC=c; }
      else {
        if(lvl!==n.prevLvl) n.ph=0.5;               // подстройка фазы по переходу
        n.ph+=inc; if(n.ph>=1){ n.ph-=1; tick=true; } }
      n.prevLvl=lvl;
      if(!tick) continue;
      // NRZI сравнивает соседние ВЫБОРКИ, а не мгновенный фронт
      const bit=n.p.nrzi? (lvl===n.lastS?1:0) : lvl;
      n.lastS=lvl;
      n.sr=((n.sr>>1)|(bit<<7))&0xff;
      if(n.sr===0x7e){                              // флаг кадра
        if(n.inFrame && n.bytes.length>=17) hdlcFrame(n);
        n.inFrame=true; n.bytes=[]; n.cur=0; n.nb=0; n.ones=0;
        continue; }
      if(bit===1){ n.ones++; if(n.ones>6){ n.inFrame=false; n.bytes=[]; } }
      else { if(n.ones===5){ n.ones=0; continue; }  // снятие вставленного нуля
             n.ones=0; }
      if(!n.inFrame) continue;
      n.cur=(n.cur>>1)|(bit<<7); n.nb++;            // байты приходят младшим битом вперёд
      if(n.nb===8){ n.bytes.push(n.cur&0xff); n.cur=0; n.nb=0;
        if(n.bytes.length>512){ n.inFrame=false; n.bytes=[]; } }
    }
    return {blk:n.frame||null, text:n.text, frames:n.ok, crcOk:n.lastOk?1:0}; },
  draw(n){ const r=n.el.querySelector('.readout');
    const t='frames '+n.ok+' / bad '+n.bad+'\n'+n.text;
    if(r.textContent!==t){ r.textContent=t; r.scrollTop=r.scrollHeight; } }});


function hdlcFrame(n){
  const b=n.bytes.slice();
  const body=b.slice(0,b.length-2), fcsL=b[b.length-2], fcsH=b[b.length-1];
  const got=((fcsH<<8)|fcsL)>>>0;
  const want=crcCalc(body,CRCS['CRC-16/X.25 (HDLC)']);
  const ok=got===want;
  n.lastOk=ok;
  if(ok) n.ok++; else { n.bad++; return; }
  const o=new Float32Array(body.length*8);
  for(let i=0;i<body.length;i++) for(let k=0;k<8;k++) o[i*8+k]=(body[i]>>(7-k))&1?1:-1;
  n.frame={d:o,n:o.length,id:++n.bid};
  n.text += (n.p.ax25? ax25(body) : body.map(x=>x.toString(16).padStart(2,'0')).join(' '))+'\n';
  if(n.text.length>4000) n.text=n.text.slice(-3000);
}
function ax25(b){                                   // адреса по 7 байт, сдвиг влево на 1
  if(b.length<15) return '(short frame)';
  const addr=i=>{
    let s='';
    for(let k=0;k<6;k++){ const c=(b[i+k]>>1)&0x7f; if(c!==32) s+=String.fromCharCode(c); }
    const ss=(b[i+6]>>1)&0x0f;
    return s+(ss?'-'+ss:'');
  };
  const dst=addr(0), src=addr(7);
  let p=14, path=[];
  while(p>=14 && !(b[p-1]&1) && p+7<=b.length){ path.push(addr(p)); p+=7; }
  const info=b.slice(p+2).map(c=>(c>=32&&c<127)?String.fromCharCode(c):'·').join('');
  return src+'>'+dst+(path.length?','+path.join(','):'')+':'+info;
}

def({ id:'frame', title:'Frame', cat:'Protocols',
  ins:[{n:'in',t:'sig'},{n:'clk',t:'sig'},{n:'trig',t:'num'},{n:'len',t:'num'},{n:'skip',t:'num'},{n:'auto',t:'num'}],
  outs:[{n:'blk',t:'blk'},{n:'ready',t:'num'},{n:'text',t:'txt'}],
  readout:true, tall:true,
  params:[{n:'len',t:'range',min:8,max:8192,step:1,d:174,label:'frame length'},
          {n:'src',t:'select',opts:['on clk','every sample'],d:'on clk'},
          {n:'skip',t:'range',min:0,max:1024,step:1,d:0,label:'skip symbols'},
          {n:'fmt',t:'select',opts:['bits','hex','soft'],d:'hex'},
          {n:'auto',t:'check',d:true,label:'wait for trigger again'},
          {n:'go',t:'button',label:'Capture frame now',fn:n=>{n.state=1;n.k=0;n.sk=n.p.skip;}}],
  init:n=>{n.state=0;n.k=0;n.sk=0;n.buf=null;n.prevT=0;n.prevC=0;n.blkOut=null;n.text='';n.bid=0;},
  process(n,I){
    if(typeof I.len==='number') setMod(n,'len',I.len);
    if(typeof I.skip==='number') setMod(n,'skip',I.skip);
    if(typeof I.auto==='number') setMod(n,'auto',I.auto>=0.5);
    const L=n.p.len;
    if(!n.buf||n.buf.length!==L) n.buf=new Float32Array(L);
    const t=I.trig||0;
    if(t>.5&&n.prevT<=.5&&n.state===0){ n.state=1; n.k=0; n.sk=n.p.skip; }
    n.prevT=t;
    if(n.state===1){
      for(let i=0;i<BLOCK;i++){
        let tick=true;
        if(n.p.src==='on clk'){ const c=I.clk?I.clk[i]:0; tick=(c>.5&&n.prevC<=.5); n.prevC=c; }
        if(!tick) continue;
        if(n.sk>0){ n.sk--; continue; }
        n.buf[n.k++]=I.in?I.in[i]:0;
        if(n.k>=L){                                  // кадр собран
          n.frame={d:n.buf.slice(), n:L, id:++n.bid};
          n.state=n.p.auto?0:2; frText(n); break; } }
    }
    return {blk:n.frame||null, ready:n.state===0&&n.frame?1:0, text:n.text}; },
  draw(n){ const r=n.el.querySelector('.readout');
    const t=(n.state===1? 'capturing '+n.k+'/'+n.p.len+'\n':'')+n.text;
    if(r.textContent!==t) r.textContent=t||'…'; }});


function frText(n){
  const d=n.frame.d, f=n.p.fmt;
  if(f==='soft') n.text=[...d].slice(0,400).map(v=>v.toFixed(2)).join(' ');
  else {
    let bits='';
    for(let i=0;i<d.length;i++) bits+= d[i]>0?'1':'0';
    if(f==='bits') n.text=bits;
    else { let h='';
      for(let i=0;i<bits.length;i+=4) h+=parseInt(bits.substr(i,4).padEnd(4,'0'),2).toString(16);
      n.text=h; } }
  n.text='frame #'+n.frame.id+' ('+n.frame.n+')\n'+n.text;
}

function interleavePerm(d,R,C,forward){
  const L=d.length, o=new Float32Array(L);
  for(let i=0;i<L;i++){
    const r=Math.floor(i/C)%R, c=i%C, j=(c*R+r)%L;   // построчная запись, постолбцовое чтение
    if(forward) o[j]=d[i]; else o[i]=d[j]; }
  return o;
}

def({ id:'interleaveTx', title:'Interleaver: Transmit', cat:'Protocols',
  ins:[{n:'blk',t:'blk'},{n:'rows',t:'num'},{n:'cols',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'rows',t:'range',min:1,max:256,step:1,d:9},
          {n:'cols',t:'range',min:1,max:256,step:1,d:20}],
  init:n=>{n.bid=-1;n.txt='';},
  process(n,I){
    for(const k of ['rows','cols']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,text:n.txt};
    n.bid=b.id;
    n.blkOut={d:interleavePerm(b.d,n.p.rows,n.p.cols,true),n:b.n,id:b.id};
    n.txt='block '+b.n+' → '+n.p.rows+'×'+n.p.cols;
    return {blk:n.blkOut,text:n.txt}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt||'…'; }});


def({ id:'interleaveRx', title:'Interleaver: Receive (deinterleave)', cat:'Decoders',
  ins:[{n:'blk',t:'blk'},{n:'rows',t:'num'},{n:'cols',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'rows',t:'range',min:1,max:256,step:1,d:9},
          {n:'cols',t:'range',min:1,max:256,step:1,d:20}],
  init:n=>{n.bid=-1;n.txt='';},
  process(n,I){
    for(const k of ['rows','cols']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,text:n.txt};
    n.bid=b.id;
    n.blkOut={d:interleavePerm(b.d,n.p.rows,n.p.cols,false),n:b.n,id:b.id};
    n.txt='block '+b.n+' ← '+n.p.rows+'×'+n.p.cols;
    return {blk:n.blkOut,text:n.txt}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt||'…'; }});


def({ id:'convEnc', title:'Convolutional Encoder', cat:'Protocols',
  ins:[{n:'blk',t:'blk'},{n:'K',t:'num'},{n:'tail',t:'num'}], outs:[{n:'blk',t:'blk'}],
  params:[{n:'K',t:'range',min:3,max:9,step:1,d:7,label:'constraint length'},
          {n:'g1',t:'text',d:'171',label:'polynomial 1 (octal)'},
          {n:'g2',t:'text',d:'133',label:'polynomial 2 (octal)'},
          {n:'tail',t:'check',d:true,label:'zero tail'}],
  init:n=>{n.bid=-1;},
  process(n,I){
    if(typeof I.K==='number') setMod(n,'K',I.K);
    if(typeof I.tail==='number') setMod(n,'tail',I.tail>=0.5);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null};
    n.bid=b.id;
    const K=n.p.K, g1=parseInt(n.p.g1,8)||0o171, g2=parseInt(n.p.g2,8)||0o133;
    const L=b.n+(n.p.tail?K-1:0), o=new Float32Array(L*2);
    let reg=0;
    for(let i=0;i<L;i++){
      const bit=i<b.n? (b.d[i]>0?1:0) : 0;
      reg=((reg<<1)|bit)&((1<<K)-1);
      o[2*i]  = par(reg&g1)? 1:-1;
      o[2*i+1]= par(reg&g2)? 1:-1; }
    n.blkOut={d:o,n:L*2,id:b.id};
    return {blk:n.blkOut}; }});

function par(v){ let p=0; while(v){ p^=v&1; v>>=1; } return p; }

def({ id:'viterbiDec', title:'Viterbi (convolutional decoder)', cat:'Protocols',
  ins:[{n:'blk',t:'blk'},{n:'K',t:'num'},{n:'tail',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'},{n:'metric',t:'num'}],
  readout:true, tall:true,
  params:[{n:'K',t:'range',min:3,max:9,step:1,d:7,label:'constraint length'},
          {n:'g1',t:'text',d:'171',label:'polynomial 1 (octal)'},
          {n:'g2',t:'text',d:'133',label:'polynomial 2 (octal)'},
          {n:'tail',t:'check',d:true,label:'zero tail'},
          {n:'fmt',t:'select',opts:['hex','bits','text'],d:'hex'}],
  init:n=>{n.bid=-1;n.text='';},
  process(n,I){
    if(typeof I.K==='number') setMod(n,'K',I.K);
    if(typeof I.tail==='number') setMod(n,'tail',I.tail>=0.5);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,text:n.text,metric:n.m||0};
    n.bid=b.id;
    const K=n.p.K, S=1<<(K-1), g1=parseInt(n.p.g1,8)||0o171, g2=parseInt(n.p.g2,8)||0o133;
    const steps=Math.floor(b.n/2);
    if(steps<2) return {blk:null,text:'',metric:0};
    // таблица выходов: из состояния s по биту u
    const out1=new Int8Array(S*2), out2=new Int8Array(S*2);
    for(let s=0;s<S;s++) for(let u=0;u<2;u++){
      const reg=((s<<1)|u)&((1<<K)-1);
      out1[s*2+u]=par(reg&g1)?1:-1; out2[s*2+u]=par(reg&g2)?1:-1; }
    const INF=1e18;
    let cost=new Float64Array(S).fill(INF); cost[0]=0;
    const tb=new Uint8Array(steps*S);                // траектория решений
    let next=new Float64Array(S);
    for(let t=0;t<steps;t++){
      next.fill(INF);
      const r1=b.d[2*t], r2=b.d[2*t+1];
      for(let s=0;s<S;s++){
        const c=cost[s]; if(c>=INF) continue;
        for(let u=0;u<2;u++){
          const m=c-(r1*out1[s*2+u]+r2*out2[s*2+u]); // мягкая метрика: минус корреляция
          const ns=((s<<1)|u)&(S-1);
          // храним решение и старший бит предшественника — он теряется при сдвиге
          if(m<next[ns]){ next[ns]=m; tb[t*S+ns]=u|(((s>>(K-2))&1)<<1); } } }
      const tmp=cost; cost=next; next=tmp; }
    let s=0;                                          // хвост нулей приводит в состояние 0
    if(!n.p.tail){ let bv=INF; for(let k=0;k<S;k++) if(cost[k]<bv){ bv=cost[k]; s=k; } }
    n.m=cost[s];
    const bits=new Uint8Array(steps);
    for(let t=steps-1;t>=0;t--){
      const rec=tb[t*S+s];
      bits[t]=rec&1;
      s=((s>>1)|(((rec>>1)&1)<<(K-2)))&(S-1); }
    const L=n.p.tail? Math.max(0,steps-(K-1)) : steps;
    const o=new Float32Array(L);
    for(let i=0;i<L;i++) o[i]=bits[i]?1:-1;
    n.blkOut={d:o,n:L,id:b.id};
    let str='';
    for(let i=0;i<L;i++) str+=bits[i];
    if(n.p.fmt==='bits') n.text=str;
    else if(n.p.fmt==='hex'){ let h='';
      for(let i=0;i<str.length;i+=4) h+=parseInt(str.substr(i,4).padEnd(4,'0'),2).toString(16);
      n.text=h; }
    else { let s2='';
      for(let i=0;i+8<=str.length;i+=8){ const c=parseInt(str.substr(i,8),2);
        s2+= (c>=32&&c<127)? String.fromCharCode(c) : '·'; }
      n.text=s2; }
    n.text='metric '+n.m.toFixed(1)+' · bits '+L+'\n'+n.text;
    return {blk:n.blkOut,text:n.text,metric:n.m}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text||'…'; }});


/* ---------- протоколы ---------- */
const ITA2_L=['','E','\n','A',' ','S','I','U','\r','D','R','J','N','F','C','K',
  'T','Z','L','W','H','Y','P','Q','O','B','G','','M','X','V',''];
const ITA2_F=['','3','\n','-',' ',"'",'8','7','\r','$','4','',',','!',':','(',
  '5','"',')','2','#','6','0','1','9','?','&','','.','/',';',''];
function ita2(code,figs){ return (figs?ITA2_F:ITA2_L)[code]||''; }
function ita2enc(ch){                              // char → [needs figures shift, code]
  let i=ITA2_L.indexOf(ch); if(i>0&&i!==27&&i!==31) return [false,i];
  i=ITA2_F.indexOf(ch); if(i>0&&i!==27&&i!==31) return [true,i];
  return null;
}

def({ id:'serialRx', title:'Receive Chars (async serial)', cat:'Decoders', ins:[{n:'soft',t:'sig'},{n:'baud',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'busy',t:'num'}], readout:true, tall:true,
  params:[{n:'baud',t:'range',min:10,max:2400,step:.01,d:45.45,log:true},
          {n:'code',t:'select',opts:['Baudot (RTTY)','ASCII 8N1','ASCII 7N1'],d:'Baudot (RTTY)'},
          {n:'invert',t:'check',d:false},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{n.st=0;n.prev=true;n.pos=0;n.bi=0;n.acc=0;n.sum=0;n.figs=false;n.text='';},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    const spb=Eng.sr/Math.max(1,n.p.baud);
    const bits=n.p.code==='Baudot (RTTY)'?5:(n.p.code==='ASCII 7N1'?7:8);
    for(let i=0;i<BLOCK;i++){
      let v=I.soft?I.soft[i]:0; if(n.p.invert) v=-v;
      const mark=v>0;
      if(!n.st){
        if(n.prev&&!mark){ n.st=1; n.pos=0; n.bi=0; n.acc=0; n.sum=0; }
      } else {
        n.pos++;
        const c=(n.bi+1.5)*spb;                    // середина бита от начала старт-бита
        if(n.pos>=c-spb*.25 && n.pos<=c+spb*.25) n.sum+=v;
        if(n.bi<bits && n.pos>c+spb*.25){
          if(n.sum>0) n.acc|=1<<n.bi;
          n.bi++; n.sum=0; }
        if(n.bi>=bits){                            // стоп-бит должен быть марком, иначе кадр битый
          const sc=(bits+1.5)*spb;
          if(n.pos>=sc-spb*.25 && n.pos<=sc+spb*.25) n.sum+=v;
          if(n.pos>sc+spb*.25){
            if(n.sum>0) uartEmit(n,n.acc,bits); else n.bad=(n.bad||0)+1;
            n.st=0; n.sum=0; } } }
      n.prev=mark; }
    return {busy:n.st?1:0}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text){ r.textContent=n.text||'…'; r.scrollTop=r.scrollHeight; } }});


function uartEmit(n,code,bits){
  let ch='';
  if(bits===5){
    if(code===27){ n.figs=true; return; }
    if(code===31){ n.figs=false; return; }
    ch=ita2(code,n.figs);
  } else ch=String.fromCharCode(code&(bits===7?0x7f:0xff));
  if(ch==='\0'||ch==='') return;
  n.text+=ch; if(n.text.length>4000) n.text=n.text.slice(-3000);
}

def({ id:'serialTx', title:'Transmit Chars (async serial)', cat:'Protocols', outs:[{n:'bit',t:'sig'}],
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'baud',t:'num'},{n:'loop',t:'num'}], readout:true,
  params:[{n:'text',t:'text',d:'RYRY DE TEST'},
          {n:'baud',t:'range',min:10,max:2400,step:.01,d:45.45,log:true},
          {n:'code',t:'select',opts:['Baudot (RTTY)','ASCII 8N1'],d:'Baudot (RTTY)'},
          {n:'stop',t:'select',opts:['1','1.5','2'],d:'1.5'},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>uartQueue(n)}],
  init:n=>{n.q=[];n.left=0;n.cur=1;n.prevGo=0;},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const o=buf(n,'bit'), spb=Eng.sr/Math.max(1,n.p.baud);
    n.src=(typeof I.text==='string'&&I.text)? I.text : n.p.text;
    const go=I.go||0; if(go>.5&&n.prevGo<=.5) uartQueue(n); n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){
        if(!n.q.length){ if(n.p.loop) uartQueue(n); }
        if(n.q.length){ const b=n.q.shift(); n.cur=b[0]; n.left=b[1]*spb; }
        else { n.cur=1; n.left=spb; } }
      n.left--; o[i]=n.cur; }
    return {bit:o}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.q.length? 'sending… '+n.q.length : 'waiting'; }});


/* ---------- авто-декодер aFSK ---------- */
// сам находит марк/спейс сканом Гёрцеля и бодрейт автокорреляцией огибающей,
// демодулирует как в 'fsk' и сразу режет на знаки как в uartRx (общий uartEmit/ita2).

function afskGoertzel(buf,f,sr){
  const k=2*Math.cos(2*Math.PI*f/sr); let s1=0,s2=0;
  for(let i=0;i<buf.length;i++){ const s0=buf[i]+k*s1-s2; s2=s1; s1=s0; }
  return s1*s1+s2*s2-k*s1*s2;
}
function afskScan(n){                                 // скан спектра окна → пара тонов
  const N=n.rn; if(N<512) return;
  const buf=new Float32Array(N);
  for(let i=0;i<N;i++) buf[i]=n.ring[(n.rw-N+i+n.ring.length)%n.ring.length]*(.5-.5*Math.cos(2*Math.PI*i/(N-1)));
  const nb=48, lo=Math.log(n.p.fmin), hi=Math.log(n.p.fmax);
  const pw=new Float32Array(nb), fr=new Float32Array(nb);
  for(let b=0;b<nb;b++){ fr[b]=Math.exp(lo+(hi-lo)*b/(nb-1)); pw[b]=afskGoertzel(buf,fr[b],Eng.sr); }
  const idx=[...pw.keys()].sort((a,b)=>pw[b]-pw[a]);
  let i2=-1; for(const i of idx){ if(Math.abs(i-idx[0])>=3){ i2=i; break; } }
  if(i2<0){                                            // виден один тон — держим прежний сдвиг (годится и для OOK)
    const shift=Math.max(10,n.fMark-n.fSpace);
    n.fMark=n.fMark*.7+fr[idx[0]]*.3; n.fSpace=n.fMark-shift; return; }
  const hiI=fr[idx[0]]>fr[i2]?idx[0]:i2, loI=hiI===idx[0]?i2:idx[0];
  n.fMark=n.fMark*.7+fr[hiI]*.3; n.fSpace=n.fSpace*.7+fr[loI]*.3;
}
function afskBaudEst(n,dr){                            // NSDF-автокорреляция децимированной огибающей
  const N=n.en; if(N<64) return;
  const x=new Float32Array(N); let mean=0;
  for(let i=0;i<N;i++){ x[i]=n.env[(n.ew-N+i+n.env.length)%n.env.length]; mean+=x[i]; }
  mean/=N; for(let i=0;i<N;i++) x[i]-=mean;
  let e=0; for(let i=0;i<N;i++) e+=x[i]*x[i]; if(e/N<1e-9) return;
  const lo=Math.max(2,Math.floor(dr/n.p.baudMax)), hi=Math.min(N>>1,Math.ceil(dr/n.p.baudMin));
  let best=0,bl=lo;
  for(let L=lo;L<=hi;L++){ let r=0,ea=0,eb=0;
    for(let i=0;i<N-L;i++){ r+=x[i]*x[i+L]; ea+=x[i]*x[i]; eb+=x[i+L]*x[i+L]; }
    const v=2*r/(ea+eb+1e-9); if(v>best){ best=v; bl=L; } }
  if(best>0.3){ n.baud=n.baud*.7+(dr/bl)*.3; n.lock=n.lock*.8+best*.2; } else n.lock*=.8;
}

def({ id:'afskRx', title:'aFSK: Auto-Receive (auto)', cat:'Decoders', readout:true, tall:true, view:{h:44},
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'soft',t:'sig'},{n:'fMark',t:'num'},{n:'fSpace',t:'num'},{n:'baud',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'fmin',t:'range',min:100,max:5000,step:1,d:300,log:true},
          {n:'fmax',t:'range',min:200,max:10000,step:1,d:3000,log:true},
          {n:'baudMin',t:'range',min:5,max:600,step:1,d:20,log:true},
          {n:'baudMax',t:'range',min:5,max:1200,step:1,d:300,log:true},
          {n:'code',t:'select',opts:['Baudot (RTTY)','ASCII 8N1','ASCII 7N1'],d:'ASCII 8N1'},
          {n:'invert',t:'check',d:false},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{
    n.ring=new Float32Array(8192); n.rw=0; n.rn=0; n.scanCd=0;
    n.fMark=1000; n.fSpace=800; n.m=[0,0]; n.s=[0,0]; n.p1=0; n.p2=0;
    n.env=new Float32Array(4000); n.ew=0; n.en=0; n.eAcc=0; n.eCnt=0; n.baudCd=0;
    n.baud=45.45; n.lock=0; n.hm=[]; n.hs=[];
    n.st=0; n.prev=true; n.pos=0; n.bi=0; n.acc=0; n.sum=0; n.figs=false; n.text=''; },
  process(n,I){
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    const so=buf(n,'soft');
    const fS=n.fSpace, fM=n.fMark, bw=clamp(Math.abs(fM-fS)/3,5,300);
    const a=Math.exp(-2*Math.PI*bw/Eng.sr);
    const DECIM=Math.max(1,Math.round(Eng.sr/clamp(4*n.p.baudMax,50,4000)));
    let sm=0,ssum=0;
    for(let i=0;i<BLOCK;i++){
      n.ring[n.rw]=I.in?I.in[i]:0; n.rw=(n.rw+1)%n.ring.length;
      const x=I.in?I.in[i]:0, w1=2*Math.PI*n.p1, w2=2*Math.PI*n.p2;
      n.s[0]=n.s[0]*a+x*Math.cos(w1)*(1-a); n.s[1]=n.s[1]*a-x*Math.sin(w1)*(1-a);
      n.m[0]=n.m[0]*a+x*Math.cos(w2)*(1-a); n.m[1]=n.m[1]*a-x*Math.sin(w2)*(1-a);
      const ms=Math.hypot(n.m[0],n.m[1]), ss=Math.hypot(n.s[0],n.s[1]);
      let d=(ms-ss)/(ms+ss+1e-9); if(n.p.invert) d=-d;
      so[i]=d; sm+=ms; ssum+=ss;
      n.p1=(n.p1+fS/Eng.sr)%1; n.p2=(n.p2+fM/Eng.sr)%1;
      n.eAcc+=Math.abs(d); n.eCnt++;
      if(n.eCnt>=DECIM){ n.env[n.ew]=n.eAcc/n.eCnt; n.ew=(n.ew+1)%n.env.length;
        n.en=Math.min(n.env.length,n.en+1); n.eAcc=0; n.eCnt=0; } }
    n.rn=Math.min(n.ring.length,n.rn+BLOCK);
    n.hm.push(sm/BLOCK); n.hs.push(ssum/BLOCK);
    if(n.hm.length>150){ n.hm.shift(); n.hs.shift(); }
    if(++n.scanCd>=Math.round(.2*Eng.sr/BLOCK)){ n.scanCd=0; afskScan(n); }
    if(++n.baudCd>=Math.round(.4*Eng.sr/BLOCK)){ n.baudCd=0; afskBaudEst(n,Eng.sr/DECIM); }
    const spb=Eng.sr/Math.max(1,n.baud);
    const bits=n.p.code==='Baudot (RTTY)'?5:(n.p.code==='ASCII 7N1'?7:8);
    for(let i=0;i<BLOCK;i++){                          // char decode — same as uartRx, on auto-baud
      const v=so[i], mark=v>0;
      if(!n.st){ if(n.prev&&!mark){ n.st=1; n.pos=0; n.bi=0; n.acc=0; n.sum=0; } }
      else {
        n.pos++;
        const c=(n.bi+1.5)*spb;
        if(n.pos>=c-spb*.25 && n.pos<=c+spb*.25) n.sum+=v;
        if(n.bi<bits && n.pos>c+spb*.25){ if(n.sum>0) n.acc|=1<<n.bi; n.bi++; n.sum=0; }
        if(n.bi>=bits){
          const sc=(bits+1.5)*spb;
          if(n.pos>=sc-spb*.25 && n.pos<=sc+spb*.25) n.sum+=v;
          if(n.pos>sc+spb*.25){ if(n.sum>0) uartEmit(n,n.acc,bits); n.st=0; n.sum=0; } } }
      n.prev=mark; }
    return {soft:so, fMark:n.fMark, fSpace:n.fSpace, baud:n.baud, lock:clamp(n.lock,0,1)}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height,h=H/2-2; cx.clearRect(0,0,W,H);
    const peak=Math.max(1e-6,...n.hm,...n.hs);
    const bar=(hist,y,col)=>{ cx.strokeStyle=col; cx.beginPath();
      for(let i=0;i<hist.length;i++){ const x=i/150*W, yy=y+h-hist[i]/peak*h;
        i?cx.lineTo(x,yy):cx.moveTo(x,yy); }
      cx.stroke(); };
    bar(n.hs,0,getComputedStyle(document.body).getPropertyValue('--t-num'));
    bar(n.hm,H/2,getComputedStyle(document.body).getPropertyValue('--t-sig'));
    cx.fillStyle=themeColor('--axis'); cx.font='9px monospace';
    cx.fillText('space '+n.fSpace.toFixed(0),3,10);
    cx.fillText('mark  '+n.fMark.toFixed(0),3,H/2+10);
    const r=n.el.querySelector('.readout');
    const info=`${n.baud.toFixed(1)} baud · lock ${(n.lock*100).toFixed(0)}%`;
    const full=info+'\n'+(n.text||'…');
    if(r.textContent!==full){ r.textContent=full; r.scrollTop=r.scrollHeight; } }});


/* ---------- преобразование текста ---------- */
const B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encB64(str){
  const b=new TextEncoder().encode(str); let o='';
  for(let i=0;i<b.length;i+=3){
    const x=(b[i]<<16)|((b[i+1]||0)<<8)|(b[i+2]||0);
    o+=B64[(x>>18)&63]+B64[(x>>12)&63]+(i+1<b.length?B64[(x>>6)&63]:'=')+(i+2<b.length?B64[x&63]:'=');
  }
  return o;
}
function decB64(str){
  const c=str.replace(/[^A-Za-z0-9+/]/g,''); const out=[];
  for(let i=0;i<c.length;i+=4){
    const v=[0,1,2,3].map(k=>B64.indexOf(c[i+k]||'A'));
    const x=(v[0]<<18)|(v[1]<<12)|(v[2]<<6)|v[3];
    out.push((x>>16)&255); if(c[i+2]) out.push((x>>8)&255); if(c[i+3]) out.push(x&255);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}
// Бодо ITA2 и PSK31 varicode отсюда убраны — это представление текста в БИТАХ,
// и им место в общем слое txt2bits/bits2txt (там же и переиспользуются с FEC).
// Здесь остались только представления-для-чтения-глазами и текстовые шифры.
const CODINGS=['Morse','ASCII binary','ASCII hex','Base64','ROT13'];
function textEncode(t,mode){
  t=String(t);
  switch(mode){
    case 'Morse': return t.toUpperCase().split('').map(c=>
      c===' '?'/':(MORSE_TX[c]||'')).filter(Boolean).join(' ');
    case 'ASCII binary': return t.split('').map(c=>
      c.charCodeAt(0).toString(2).padStart(8,'0')).join(' ');
    case 'ASCII hex': return t.split('').map(c=>
      c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
    case 'Base64': return encB64(t);
    case 'ROT13': return t.replace(/[a-z]/gi,c=>{
      const b=c<='Z'?65:97; return String.fromCharCode((c.charCodeAt(0)-b+13)%26+b); });
  }
  return t;
}
function textDecode(t,mode){
  t=String(t);
  switch(mode){
    case 'Morse': return t.trim().split(/\s+/).map(c=>
      c==='/'?' ':(MORSE[c]||'')).join('');
    case 'ASCII binary': return t.trim().split(/\s+/).map(b=>
      String.fromCharCode(parseInt(b,2)||0)).join('');
    case 'ASCII hex': return t.trim().replace(/0x/gi,'').split(/[\s,]+/).map(h=>
      String.fromCharCode(parseInt(h,16)||0)).join('');
    case 'Base64': try{ return decB64(t); }catch(e){ return '(not Base64)'; }
    case 'ROT13': return textEncode(t,'ROT13');
  }
  return t;
}

def({ id:'textcode', title:'Text: Ciphers/Representations', cat:'Misc',
  ins:[{n:'text',t:'txt'}], outs:[{n:'out',t:'txt'}], readout:true, tall:true,
  params:[{n:'text',t:'text',d:'SOS'},
          {n:'mode',t:'select',opts:['encode','decode'],d:'encode'},
          {n:'coding',t:'select',opts:CODINGS,d:'Morse'}],
  init:n=>{n.res='';},
  process(n,I){
    const src=(typeof I.text==='string'&&I.text)? I.text : n.p.text;
    if(src!==n.src||n.m!==n.p.mode||n.c!==n.p.coding){
      n.src=src; n.m=n.p.mode; n.c=n.p.coding;
      n.res = n.p.mode==='encode'? textEncode(src,n.p.coding) : textDecode(src,n.p.coding); }
    return {out:n.res}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.res) r.textContent=n.res||'…'; }});


def({ id:'morseTx', title:'Morse: Transmit', cat:'Protocols',
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'wpm',t:'num'},{n:'loop',t:'num'}],
  outs:[{n:'bit',t:'sig'},{n:'key',t:'num'}], readout:true,
  params:[{n:'text',t:'text',d:'CQ CQ DE TEST'},
          {n:'wpm',t:'range',min:3,max:60,step:.5,d:15},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>morseQueue(n)}],
  init:n=>{n.q=[];n.left=0;n.cur=-1;n.prevGo=0;},
  process(n,I){
    if(typeof I.wpm==='number') setMod(n,'wpm',I.wpm);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const o=buf(n,'bit'), unit=1200/n.p.wpm*Eng.sr/1000;
    n.src=(typeof I.text==='string'&&I.text)? I.text : n.p.text;
    const go=I.go||0; if(go>.5&&n.prevGo<=.5) morseQueue(n); n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){
        if(!n.q.length&&n.p.loop) morseQueue(n);
        if(n.q.length){ const e=n.q.shift(); n.cur=e[0]; n.left=e[1]*unit; }
        else { n.cur=-1; n.left=unit; } }
      n.left--; o[i]=n.cur; }
    return {bit:o, key:n.cur>0?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.q.length? 'sending… '+n.q.length : 'waiting'; }});


const MORSE_TX={}; for(const k in MORSE) MORSE_TX[MORSE[k]]=k;
function morseQueue(n){
  const q=[[-1,3]];
  for(const ch of String(n.src!=null?n.src:n.p.text).toUpperCase()){
    if(ch===' '){ q.push([-1,4]); continue; }
    const c=MORSE_TX[ch]; if(!c) continue;
    for(const s of c){ q.push([1,s==='.'?1:3]); q.push([-1,1]); }
    q.push([-1,2]); }
  q.push([-1,7]); n.q=q;
}

const SSTV={
  'Martin M1'   :{lineMs:446.446,width:'960',height:'256',rgb:true, sync:'edge'},
  'Martin M2'   :{lineMs:226.798,width:'480',height:'256',rgb:true, sync:'edge'},
  'Scottie S1'  :{lineMs:428.22, width:'960',height:'256',rgb:true, sync:'edge'},
  'Scottie S2'  :{lineMs:277.692,width:'640',height:'256',rgb:true, sync:'edge'},
  'Scottie DX'  :{lineMs:1050.3, width:'960',height:'256',rgb:true, sync:'edge'},
  'Robot 36'    :{lineMs:150.0,  width:'480',height:'240',rgb:false,sync:'edge'},
  'WEFAX 120 lpm IOC576':{lineMs:500,    width:'1810',height:'600',rgb:false,sync:'free'},
  'WEFAX 120 lpm IOC288':{lineMs:500,    width:'905', height:'600',rgb:false,sync:'free'},
  'WEFAX 90 lpm'        :{lineMs:666.667,width:'1810',height:'600',rgb:false,sync:'free'},
  'WEFAX 60 lpm'        :{lineMs:1000,   width:'1810',height:'600',rgb:false,sync:'free'},
  'NOAA APT'            :{lineMs:500,    width:'2080',height:'600',rgb:false,sync:'free'},
  'Feld Hell'           :{lineMs:114.2857,width:'640', height:'14', rgb:false,sync:'free',
                          dir:'columns',palette:'gray'}
};

const DTMF_ROWS=[697,770,852,941], DTMF_COLS=[1209,1336,1477,1633], DTMF_KEYS='123A456B789C*0#D';

function dtmfQueue(n){                               // строка → очередь [индекс_клавиши|-1, длит._сэмплов]
  const digits=String(n.p.text).toUpperCase().split('').filter(c=>DTMF_KEYS.includes(c));
  const tone=Math.round(n.p.toneMs/1000*Eng.sr), gap=Math.round(n.p.gapMs/1000*Eng.sr);
  n.q=[];
  for(const c of digits){ n.q.push([DTMF_KEYS.indexOf(c),tone]); n.q.push([-1,gap]); }
  n.text='dialed: '+digits.join('');
}
def({ id:'dtmfTx', title:'DTMF: Transmit', cat:'Protocols', readout:true,
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'toneMs',t:'num'},{n:'gapMs',t:'num'},{n:'loop',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'text',t:'text',d:'123A'},
          {n:'toneMs',t:'range',min:20,max:500,step:5,d:100},
          {n:'gapMs',t:'range',min:20,max:500,step:5,d:60},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.3},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>dtmfQueue(n)}],
  init:n=>{n.q=[];n.idx=-1;n.left=0;n.p1=0;n.p2=0;n.prevGo=0;n.text='waiting';},
  process(n,I){
    for(const k of ['toneMs','gapMs']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const o=buf(n,'out');
    if(typeof I.text==='string'&&I.text) n.p.text=I.text;
    const go=I.go||0; if(go>.5&&n.prevGo<=.5) dtmfQueue(n); n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){
        if(!n.q.length && n.p.loop) dtmfQueue(n);
        if(n.q.length){ const seg=n.q.shift(); n.idx=seg[0]; n.left=seg[1]; }
        else { n.idx=-1; n.left=Eng.sr/100; } }
      let v=0;
      if(n.idx>=0){
        const r=DTMF_ROWS[Math.floor(n.idx/4)], c=DTMF_COLS[n.idx%4];
        n.p1=(n.p1+r/Eng.sr)%1; n.p2=(n.p2+c/Eng.sr)%1;
        v=(Math.sin(2*Math.PI*n.p1)+Math.sin(2*Math.PI*n.p2))*.5*n.p.amp; }
      n.left--; o[i]=v; }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting'; }});


def({ id:'dtmfRx', title:'DTMF: Receive', cat:'Decoders', ins:[{n:'in',t:'sig'},{n:'thr',t:'num'},{n:'minMs',t:'num'}],
  outs:[{n:'digit',t:'num'},{n:'gate',t:'num'}], readout:true, tall:true,
  params:[{n:'thr',t:'range',min:1.5,max:30,step:.1,d:6},
          {n:'minMs',t:'range',min:20,max:200,step:5,d:40},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{n.text='';n.cur='';n.run=0;n.last='';n.gap=0;},
  process(n,I){
    if(typeof I.thr==='number') setMod(n,'thr',I.thr);
    if(typeof I.minMs==='number') setMod(n,'minMs',I.minMs);
    const dt=BLOCK/Eng.sr*1000;
    const rows=[697,770,852,941], cols=[1209,1336,1477,1633];
    const g=f=>{                                     // Goertzel over the block length
      const k=2*Math.cos(2*Math.PI*f/Eng.sr);
      let s1=0,s2=0;
      for(let i=0;i<BLOCK;i++){ const s0=(I.in?I.in[i]:0)+k*s1-s2; s2=s1; s1=s0; }
      return s1*s1+s2*s2-k*s1*s2; };
    const R=rows.map(g), C=cols.map(g);
    const pick=a=>{ let bi=0; for(let i=1;i<a.length;i++) if(a[i]>a[bi]) bi=i;
      const rest=a.reduce((s,v,i)=>i===bi?s:s+v,0)/(a.length-1);
      return [bi, a[bi]/(rest+1e-12)]; };
    const [ri,rq]=pick(R), [ci,cq]=pick(C);
    const tot=R.reduce((a,b)=>a+b,0)+C.reduce((a,b)=>a+b,0);
    const ok = rq>n.p.thr && cq>n.p.thr && tot>1e-6;
    const ch = ok ? '123A456B789C*0#D'[ri*4+ci] : '';
    if(ch && ch===n.cur){ n.run+=dt;
      if(n.run>=n.p.minMs && n.last!==ch){ n.text+=ch; n.last=ch;
        if(n.text.length>2000) n.text=n.text.slice(-1500); } }
    else { n.cur=ch; n.run=ch?dt:0; }
    if(!ch){ n.gap+=dt; if(n.gap>n.p.minMs) n.last=''; } else n.gap=0;
    return {digit: ch? '0123456789ABCD*#'.indexOf(ch) : -1, gate: ch?1:0}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==(n.text||'…')){ r.textContent=n.text||'…'; r.scrollTop=r.scrollHeight; } }});

// ЧЕРНОВИК, НЕ ПРОВЕРЕН в браузере — тестируй как обычно, наверняка что-то вылезет.
// Раскладка RGB зеркалит то, что уже делает paint при приёме: buffer шириной W —
// это не W пикселей, а 3 подряд идущие полосы по oW=W/3 (R, потом G, потом B),
// никаких отдельных пер-канальных sync-импульсов внутри строки нет — как и на приёме,
// это упрощение (реальные Martin/Scottie чуть сложнее по таймингу), но раз оно
// уже принято для приёма — держим ту же модель и для передачи, чтобы декодировалось само собой.

function imgResample(img,W,H,rgb){                   // источник произвольного размера → Float32Array[W*H], 0..1
  const out=new Float32Array(W*H);
  const sw=img.w, sh=img.h;
  const px=img.gray?null:img.data.data, gb=img.buf;
  const gray=(sx,sy)=> px ? (px[(sy*sw+sx)*4]*.299+px[(sy*sw+sx)*4+1]*.587+px[(sy*sw+sx)*4+2]*.114)/255
                          : gb[sy*sw+sx];
  const chan=(sx,sy,c)=> px ? px[(sy*sw+sx)*4+c]/255 : gray(sx,sy);   // c=0..2 R/G/B; для gray-источника канала нет — дублируем яркость
  if(!rgb){
    for(let y=0;y<H;y++){ const sy=Math.min(sh-1,Math.floor(y/H*sh));
      for(let x=0;x<W;x++){ const sx=Math.min(sw-1,Math.floor(x/W*sw));
        out[y*W+x]=gray(sx,sy); } }
    return out;
  }
  const oW=Math.floor(W/3);                          // ширина одной цветовой полосы
  for(let y=0;y<H;y++){ const sy=Math.min(sh-1,Math.floor(y/H*sh));
    for(let c=0;c<3;c++) for(let x=0;x<oW;x++){
      const sx=Math.min(sw-1,Math.floor(x/oW*sw));
      out[y*W+c*oW+x]=chan(sx,sy,c); } }
  return out;
}

def({ id:'paintTx', title:'Raster (transmit)', cat:'Video',
  ins:[{n:'img',t:'img'},{n:'lineMs',t:'num'},{n:'slant',t:'num'},{n:'shift',t:'num'}],
  outs:[{n:'level',t:'sig'},{n:'sync',t:'sig'}],
  view:{h:40}, readout:true,
  params:[{n:'std',t:'select',opts:['manual',...Object.keys(SSTV)],d:'manual',
           fn:n=>{ const p=SSTV[n.p.std]; if(!p) return; Object.assign(n.p,p); n.tbuf=null; }},
          {n:'lineMs',t:'range',min:1,max:2000,step:.001,d:500},
          {n:'slant',t:'range',min:-20,max:20,step:.001,d:0},
          {n:'shift',t:'range',min:0,max:1,step:.0005,d:0},
          {n:'width',t:'select',opts:['160','256','320','480','512','640','800','905','960','1024','1810','2080'],d:'1810'},
          {n:'height',t:'select',opts:['14','28','56','120','160','240','256','320','480','600'],d:'600'},
          {n:'dir',t:'select',opts:['rows','columns'],d:'rows'},
          {n:'rgb',t:'check',d:false},
          {n:'invert',t:'check',d:false},
          {n:'loop',t:'check',d:true,label:'loop'},
          {n:'restart',t:'button',label:'Restart from beginning',fn:n=>{n.px=0;n.py=0;n.done=false;}}],
  init:n=>{n.px=0;n.py=0;n.W=0;n.H=0;n.cols=false;n.rgb=false;n.tbuf=null;n.srcImg=null;n.done=false;},
  process(n,I){
    for(const k of ['lineMs','slant','shift']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'level'), os=buf(n,'sync');
    const W=+n.p.width, H=+n.p.height, cols=n.p.dir==='columns', rgb=n.p.rgb;
    if(n.W!==W||n.H!==H||n.cols!==cols||n.rgb!==rgb){  // смена размера/ориентации/режима — пересчёт буфера и сброс луча
      n.W=W; n.H=H; n.cols=cols; n.rgb=rgb; n.tbuf=null; n.px=0; n.py=0; n.done=false; }
    const img=I.img;
    if(img && n.srcImg!==img){                        // новый кадр источника (по ссылке) — пересэмплировать один раз
      n.srcImg=img; n.tbuf=imgResample(img,W,H,rgb); }
    const len=cols?H:W, lineCount=cols?W:H;
    const per=len/Math.max(1e-6,(n.p.lineMs+n.p.slant)/1000*Eng.sr);
    const off=Math.round((n.p.shift||0)*len);
    for(let i=0;i<BLOCK;i++){
      os[i]=0;
      if(n.done || !n.tbuf){ o[i]=0; continue; }
      const p=(Math.min(len-1,Math.max(0,Math.floor(n.px)))+off)%len;
      let v = cols ? n.tbuf[p*n.W+n.py] : n.tbuf[n.py*n.W+p];
      if(n.p.invert) v=1-v;
      o[i]=clamp(v,0,1)*2-1;                           // -1..1 — сразу на вход osc.fm
      n.px+=per;
      if(n.px>=len){
        n.px-=len; os[i]=1;                            // импульс начала строки
        n.py++;
        if(n.py>=lineCount){ if(n.p.loop) n.py=0; else { n.done=true; break; } } }
    }
    return {level:o, sync:os}; },
  draw(n){ const r=n.el.querySelector('.readout');
    r.textContent = !n.tbuf ? 'no image'
      : n.done ? 'transmission complete'
      : 'line '+n.py+'/'+(n.cols?n.W:n.H); }});

def({ id:'paint', title:'Raster (line by line)', cat:'Video',
  ins:[{n:'level',t:'sig'},{n:'sync',t:'sig'},{n:'lineMs',t:'num'},{n:'slant',t:'num'},
       {n:'offset',t:'num'},{n:'shift',t:'num'},{n:'rgb',t:'num'},{n:'invert',t:'num'}], outs:[{n:'img',t:'img'}],
  view:{h:200}, resize:true, pick:true, readout:true,
  params:[{n:'std',t:'select',opts:['manual',...Object.keys(SSTV)],d:'manual',
           fn:n=>{ const p=SSTV[n.p.std]; if(!p) return;
                   Object.assign(n.p,p); n.W=0; rebuildNode(n); }},
          {n:'lineMs',t:'range',min:1,max:2000,step:.001,d:446.446},
          {n:'slant',t:'range',min:-20,max:20,step:.001,d:0},
          {n:'offset',t:'range',min:0,max:100,step:.1,d:0},
          {n:'shift',t:'range',min:0,max:1,step:.0005,d:0},
          {n:'width',t:'select',opts:['160','256','320','480','512','640','800','905','960','1024','1810','2080'],d:'320'},
          {n:'height',t:'select',opts:['14','28','56','120','160','240','256','320','480','600'],d:'256'},
          {n:'sync',t:'select',opts:['free','edge'],d:'edge'},
          {n:'dir',t:'select',opts:['rows','columns'],d:'rows'},
          {n:'rgb',t:'check',d:false},
          {n:'invert',t:'check',d:false},
          {n:'mirror',t:'check',d:false,label:'mirror'},
          {n:'palette',t:'select',opts:['gray','heat','blue-yellow'],d:'gray'},
          {n:'png',t:'button',label:'Save snapshot',fn:n=>paintSave(n)},
          {n:'clr',t:'button',label:'Clear raster',fn:n=>{
            n.buf&&n.buf.fill(0); n.px=0; n.py=0; n.acc=0; n.accN=0; n.skip=0; }}],
  // px/py — позиция сканирующего луча (столбец/строка растра). НЕ n.x/n.y — те заняты
  // движком под координаты узла на холсте, совпадение имён двигало узел вместе с лучом.
  init:n=>{n.px=0;n.py=0;n.acc=0;n.accN=0;n.prevSync=0;n.W=0;n.skip=0;},
  process(n,I){
    for(const k of ['lineMs','slant','offset','shift']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['rgb','invert']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const W=+n.p.width, H=+n.p.height, cols=n.p.dir==='columns';
    if(n.W!==W||n.H!==H||n.cols!==cols){              // смена ориентации меняет адресацию буфера — нужен сброс, как при смене размера
      n.W=W; n.H=H; n.cols=cols; n.buf=new Float32Array(W*H);
      n.px=0; n.py=0; n.acc=0; n.accN=0; n.skip=0; n.id2=null; }
    const len=cols?H:W;                              // длина одной «строки» в пикселях
    const per=len/Math.max(1e-6,(n.p.lineMs+n.p.slant)/1000*Eng.sr);
    const skipN=n.p.offset/1000*Eng.sr;
    for(let i=0;i<BLOCK;i++){
      let v=I.level?I.level[i]:0; if(n.p.invert) v=1-v;
      const sy=I.sync?I.sync[i]:0;
      if(n.p.sync==='edge' && sy>.5 && n.prevSync<=.5){ pxFlush(n); n.px=0; n.skip=skipN; pLine(n); }
      n.prevSync=sy;
      if(n.skip>0){ n.skip--; continue; }             // площадка после синхроимпульса
      n.acc+=clamp(v,0,1); n.accN++;
      const nx=n.px+per;
      if(Math.floor(nx)>Math.floor(n.px)) pxFlush(n);
      n.px=nx;
      if(n.px>=len){ n.px-=len; if(n.p.sync==='free') pLine(n); else n.px=len-1e-6; } }
    if(n.pickT!=null){                                // тап по растру = выровнять левый край
      const v=(n.p.shift+n.pickT)%1; n.pickT=null;
      if(n.set&&n.set.shift) n.set.shift(v); else n.p.shift=v; }
    n.frame=n.frame||{}; n.frame.buf=n.buf; n.frame.w=W; n.frame.h=H; n.frame.gray=true;
    return {img:n.frame}; },
  draw(n,cv,cx){
    const c=paintImage(n); if(!c) return;
    cx.imageSmoothingEnabled=false;
    cx.clearRect(0,0,cv.width,cv.height);
    cx.drawImage(c,0,0,cv.width,cv.height);
    cx.fillStyle=themeColor('--acc');
    if(n.p.dir==='columns'){
      const off=(n.p.shift||0)*n.W, x=(((n.py-off)%n.W)+n.W)%n.W;
      cx.fillRect(x/n.W*cv.width,0,1,cv.height);
    } else cx.fillRect(0,n.py/n.H*cv.height,cv.width,1);
    n.el.querySelector('.readout').textContent =
      (60000/(n.p.lineMs+n.p.slant)).toFixed(2)+' lines/min · shift '+
      (n.p.shift*100).toFixed(1)+'%'; }});


const VARICODE=('1010101011 1011011011 1011101101 1101110111 1011101011 1101011111 1011101111 1011111101 '+
'1011111111 11101111 11101 1101101111 1011011101 11111 1101110101 1110101011 '+
'1011110111 1011110101 1110101101 1110101111 1101011011 1101101011 1101101101 1101010111 '+
'1101111011 1101111101 1110110111 1101010101 1101011101 1110111011 1011111011 1101111111 '+
'1 111111111 101011111 111110101 111011011 1011010101 1010111011 101111111 '+
'11111011 11110111 101101111 111011111 1110101 110101 1010111 110101111 '+
'10110111 10111101 11101101 11111111 101110111 101011011 101101011 110101101 '+
'110101011 110110111 11110101 110111101 111101101 1010101 111010111 1010101111 '+
'1010111101 1111101 11101011 10101101 10110101 1110111 11011011 11111101 '+
'101010101 1111111 111111101 101111101 11010111 10111011 11011101 10101011 '+
'11010101 111011101 10101111 1101111 1101101 101010111 110110101 101011101 '+
'101110101 101111011 1010101101 111110111 111101111 111111011 1010111111 101101101 '+
'1011011111 1011 1011111 101111 101101 11 111101 1011011 '+
'101011 1101 111101011 10111111 11011 111011 1111 111 '+
'111111 110111111 10101 10111 101 110111 1111011 1101011 '+
'11011111 1011101 111010101 1010110111 110111011 1010110101 1011010111 1110110101').split(/\s+/);
const VARIMAP={}; VARICODE.forEach((c,i)=>{ if(!(c in VARIMAP)) VARIMAP[c]=i; });

def({ id:'pskdec', title:'PSK Slicer', cat:'Protocols',
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'clk',t:'sig'},{n:'diff',t:'num'}],
  outs:[{n:'sym',t:'num'},{n:'evm',t:'num'}],
  readout:true, tall:true,
  params:[{n:'order',t:'select',opts:['2','4','8'],d:'8'},
          {n:'diff',t:'check',d:true},
          {n:'fmt',t:'select',opts:['symbols','hex','bits','PSK31 varicode'],d:'hex'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';n.cnt=0;}}],
  init:n=>{n.prev=0;n.text='';n.sym=0;n.evm=0;n.cnt=0;n.prevClk=0;n.vc='';},
  process(n,I){
    if(typeof I.diff==='number') setMod(n,'diff',I.diff>=0.5);
    const M=+n.p.order, st=2*Math.PI/M;
    for(let i=0;i<BLOCK;i++){
      const c=I.clk?I.clk[i]:0;
      if(c>.5&&n.prevClk<=.5){
        const ii=I.I?I.I[i]:0, qq=I.Q?I.Q[i]:0, ang=Math.atan2(qq,ii);
        let d=n.p.diff? ang-n.prev : ang;
        n.prev=ang;
        d=((d%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
        const k=Math.round(d/st)%M;
        let err=d-Math.round(d/st)*st;              // отклонение до ближайшего луча
        n.evm=n.evm*.95+Math.abs(err)/st*.05;
        n.sym=k; pskPush(n,k,M); }
      n.prevClk=c; }
    return {sym:n.sym, evm:n.evm}; },
  draw(n){ const r=n.el.querySelector('.readout');
    const t=(n.text||'…')+'\nEVM '+(n.evm*100).toFixed(0)+'% · symbols '+n.cnt;
    if(r.textContent!==t){ r.textContent=t; r.scrollTop=r.scrollHeight; } }});


function pskPush(n,k,M){
  n.cnt++;
  const bits=Math.log2(M)|0;
  if(n.p.fmt==='PSK31 varicode'){ variPush(n,k?0:1); return; }   // реверс фазы = 0, её отсутствие = 1
  if(n.p.fmt==='symbols') n.text+=k;
  else if(n.p.fmt==='hex') n.text+=k.toString(16);
  else { let s=''; for(let b=bits-1;b>=0;b--) s+=(k>>b)&1; n.text+=s; }
  if(n.text.length>3000) n.text=n.text.slice(-2400);
}

function variPush(n,bit){                           // varicode: разделитель — два нуля подряд
  n.vc+=bit;
  if(n.vc.length>=2 && n.vc.slice(-2)==='00'){
    const code=n.vc.slice(0,-2).replace(/^0+/,'');
    if(code){ const c=VARIMAP[code];
      n.text += (c==null?'\u25a1':(c===10?'\n':(c<32?'':String.fromCharCode(c)))); }
    n.vc='';
    if(n.text.length>3000) n.text=n.text.slice(-2400);
  }
  if(n.vc.length>24) n.vc=n.vc.slice(-12);
}

/* ---------- FT8: LDPC(174,91), CRC-14, распаковка 77 бит ----------
   Проверочная матрица и генератор взяты из исходников WSJT-X (GPLv3). */
const FT8_NM_RAW='4,31,59,91,92,96,153;5,32,60,93,115,146;6,24,61,94,122,151;7,33,62,95,96,143;8,25,63,83,93,96,148;6,32,64,97,126,138;5,34,65,78,98,107,154;9,35,66,99,139,146;10,36,67,100,107,126;11,37,67,87,101,139,158;12,38,68,102,105,155;13,39,69,103,149,162;8,40,70,82,104,114,145;14,41,71,88,102,123,156;15,42,59,106,123,159;1,33,72,106,107,157;16,43,73,108,141,160;17,37,74,81,109,131,154;11,44,75,110,121,166;45,55,64,111,130,161,173;8,46,71,112,119,166;18,36,76,89,113,114,143;19,38,77,104,116,163;20,47,70,92,138,165;2,48,74,113,128,160;21,45,78,83,117,121,151;22,47,58,118,127,164;16,39,62,112,134,158;23,43,79,120,131,145;19,35,59,73,110,125,161;20,36,63,94,136,161;14,31,79,98,132,164;3,44,80,124,127,169;19,46,81,117,135,167;7,49,58,90,100,105,168;12,50,61,118,119,144;13,51,64,114,118,157;24,52,76,129,148,149;25,53,69,90,101,130,156;20,46,65,80,120,140,170;21,54,77,100,140,171;35,82,133,142,171,174;14,30,83,113,125,170;4,29,68,120,134,173;1,4,52,57,86,136,152;26,51,56,91,122,137,168;52,84,110,115,145,168;7,50,81,99,132,173;23,55,67,95,172,174;26,41,77,109,141,148;2,27,41,61,62,115,133;27,40,56,124,125,126;18,49,55,124,141,167;6,33,85,108,116,156;28,48,70,85,105,129,158;9,54,63,131,147,155;22,53,68,109,121,174;3,13,48,78,95,123;31,69,133,150,155,169;12,43,66,89,97,135,159;5,39,75,102,136,167;2,54,86,101,135,164;15,56,87,108,119,171;10,44,82,91,111,144,149;23,34,71,94,127,153;11,49,88,92,142,157;29,34,87,97,147,162;30,50,60,86,137,142,162;10,53,66,84,112,128,165;22,57,85,93,140,159;28,32,72,103,132,166;28,29,84,88,117,143,150;1,26,45,80,128,147;17,27,89,103,116,153;51,57,98,163,165,172;21,37,73,138,152,169;16,47,76,130,137,154;3,24,30,72,104,139;9,40,90,106,134,151;15,58,60,74,111,150,163;18,42,79,144,146,152;25,38,65,99,122,160;17,42,75,129,170,172';
const FT8_GEN='8329ce11bf31eaf509f27fc761c264e25c259335493132dc265902fb277c6410a1bdc1b3f417858cd2dd33ec7f6209fda4fee04195fd034783a077cccc11b8873ed5c3d48a29b62afe3ca036f4fe1a9da6054faf5f35d96d3b0c8c3ee20798e4310eed27884ae90775c9c08e80e26ddae56318b0b811028c2bf997213487c18a0c9231fc60adf5c5ea3276471e8302a0721e01b12b8ffbccb80ca8341fafb47b2e66a72a158f9325a2bf67170c4243689fe85b1c51363a180dff739414d1a1b34b1c27015b48830636c8b99894972e29a89c0d3de81d665489b0e4f126f37fa51cbe61bd6b9499c47239d0d97d3c84e09401919b75119765621bb4f1e809db12d731faee0b86df6b8488fc33df43fbdeea4eafb4827423ee40b675f756eb5feabe197c484cb74757144a9a2b500e4bc0ec5a6d2bdbdd0c474aa53d702187616693608eba1a13db3390bd6718cec753844673a27782cc42012e06ff83a145c37035a5c12683b37417858cc2dd33ec3f629a4a5a28ee17ca9c324842cbc29f465309c977e89610a42663ae6ddf8b5ce2bb2948846f231efe457034c18144183fb2ce85abe9b0c72e06fbede87481f282c153971a0a2efcd7ccf23c69fa99bba1412f0261447e9490ca8e474cec4410115818196f95cdd7012088fc31df4bfbde2a4eafb4b8fef1b6307729fb0a078c05afea7acccb77bbc9d99a9049a7016ac653f65ecdc90761944d085be4e7da8d6cc7d0251f62adc4032f0ee71400256471f8702a0721e00b12b82b8e4923f2dd51e2d537fa06b550a40a66f4755de95c26a18ad28d4e27fe92a4f6c8410c2e586388cb82a3d80758ef34a41817ee02133db2eb07e9c0c54325a9c15836e0003693e572d1fde4cdf079e86bfb2cec5abe1b0c72e07fbe7ee18230c583cccc57d4b08a066cb2fedafc9f52664126bb23725abc47cc5f4cc4cd2ded9dba3bee40c59b5609b4d9a7016ac653e6decdc90369ad46aed5f707f280ab5fc4e5921c77822587316d7d3c24f14da8242a8b86dca733528b8b507ad467d4441df770e22831c9cf1169467ad04b68213b838fe2ae54c38ee71805d926b6dd71f085181a4e1266ab79d4b29ee6e69509e56958148682d748a38dd68baab8ce020cf069c32a723ab14f4331d6d461607e957527466da23ba424b9596133cf9c8a636bcbc7b30c5fbeae67fe5cb0d86a07df654a9089a20f11f106848780fc9ecdd80a1fbb5364fb8d2c9d730d5bafcb86bc70a50c9d02a5d034a534433029eac15f322e34cc989d9c7c3d3b8c55d751307bb38b2f0186d46643ae9622644ebadeb44b9467d1f42c608cc857594bfbb55d69600';
const FT8_NM=FT8_NM_RAW.split(';').map(r=>r.split(',').map(Number));
const FT8_MN=(()=>{ const m=Array.from({length:174},()=>[]);
  FT8_NM.forEach((row,i)=>row.forEach(c=>{ if(c) m[c-1].push(i); })); return m; })();

function ft8Crc14(bits){                            // полином 0x6757, деление с дополнением
  const p=[1,1,0,0,1,1,1,0,1,0,1,0,1,1,1];
  const mc=bits.slice();
  const r=mc.slice(0,15);
  for(let i=0;i<=mc.length-15;i++){
    r[14]=mc[i+14];
    const f=r[0];
    for(let k=0;k<15;k++) r[k]=(r[k]+f*p[k])%2;
    r.push(r.shift()); }
  let v=0; for(let k=0;k<14;k++) v=(v<<1)|r[k];
  return v;
}
function ft8CrcOk(k91){                             // между сообщением и суммой — 5 нулей
  const m=k91.slice(0,77).concat([0,0,0,0,0]).concat(k91.slice(77,91));
  return ft8Crc14(m)===0;
}
function ft8Encode(msg77){                          // 77 бит → 174, для проверки тракта
  const crc=ft8Crc14(msg77.concat(new Array(19).fill(0)));
  const k91=msg77.slice();
  for(let i=13;i>=0;i--) k91.push((crc>>i)&1);
  const cw=k91.slice();
  for(let i=0;i<83;i++){
    const hex=FT8_GEN.substr(i*23,23);
    let p=0;
    for(let j=0;j<91;j++){
      const nib=parseInt(hex[j>>2],16);
      if((nib>>(3-(j&3)))&1) p^=k91[j]; }
    cw.push(p); }
  return cw;
}
function ft8Ldpc(llr,iters){                        // распространение доверия, min-sum
  const N=174, M=83, IT=iters||40;
  const tov=Array.from({length:N},()=>new Float64Array(FT8_MN[0].length||3));
  for(let i=0;i<N;i++) tov[i]=new Float64Array(FT8_MN[i].length);
  const hard=new Uint8Array(N);
  const tot=new Float64Array(N);
  for(let it=0;it<IT;it++){
    for(let i=0;i<N;i++){
      let s=llr[i]; for(let q=0;q<tov[i].length;q++) s+=tov[i][q];
      tot[i]=s; hard[i]=s>0?0:1; }
    let bad=0;
    for(let m=0;m<M;m++){ let p=0;
      for(const c of FT8_NM[m]) if(c) p^=hard[c-1];
      if(p) bad++; }
    if(!bad) return {ok:true,bits:hard,iters:it};
    for(let m=0;m<M;m++){
      const row=FT8_NM[m].filter(c=>c);
      for(let a=0;a<row.length;a++){
        let mag=1e9, sgn=1;
        for(let b=0;b<row.length;b++){
          if(a===b) continue;
          const i=row[b]-1, k=FT8_MN[i].indexOf(m);
          const s=tot[i]-(k>=0?tov[i][k]:0);
          if(Math.abs(s)<mag) mag=Math.abs(s);
          if(s<0) sgn=-sgn; }
        const i=row[a]-1, k=FT8_MN[i].indexOf(m);
        if(k>=0) tov[i][k]=0.75*sgn*mag; } }
  }
  return {ok:false,bits:hard,iters:IT};
}
const A1=' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A2='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      A3='0123456789', A4=' ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      AF=' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
function bitsNum(b,from,len){ let v=0; for(let i=0;i<len;i++) v=v*2+b[from+i]; return v; }
function ft8Call(n28){
  const NTOK=2063592, MAX22=4194304;
  if(n28<NTOK){
    if(n28===0) return 'DE'; if(n28===1) return 'QRZ'; if(n28===2) return 'CQ';
    if(n28<=1002) return 'CQ '+String(n28-3).padStart(3,'0');
    return 'CQ'; }
  if(n28<NTOK+MAX22) return '<'+(n28-NTOK).toString(36)+'>';
  let n=n28-NTOK-MAX22;
  const i6=n%27; n=(n-i6)/27;
  const i5=n%27; n=(n-i5)/27;
  const i4=n%27; n=(n-i4)/27;
  const i3=n%10; n=(n-i3)/10;
  const i2=n%36; n=(n-i2)/36;
  const i1=n%37;
  return (A1[i1]+A2[i2]+A3[i3]+A4[i4]+A4[i5]+A4[i6]).trim();
}
function ft8Grid(g15,r){
  if(g15<32400){
    let n=g15;
    const j4=n%10; n=(n-j4)/10;
    const j3=n%10; n=(n-j3)/10;
    const j2=n%18; n=(n-j2)/18;
    const j1=n%18;
    return String.fromCharCode(65+j1)+String.fromCharCode(65+j2)+String(j3)+String(j4); }
  const k=g15-32400;
  if(k===1) return 'RRR'; if(k===2) return 'RR73'; if(k===3) return '73';
  if(k===4) return '';
  const db=k-35;
  return (r?'R':'')+(db>=0?'+':'-')+String(Math.abs(db)).padStart(2,'0');
}
function ft8Unpack(b77){
  const i3=bitsNum(b77,74,3);
  if(i3===0){
    const n3=bitsNum(b77,71,3);
    if(n3===0){
      let n=0n; for(let i=0;i<71;i++) n=n*2n+BigInt(b77[i]);
      let s='';
      for(let i=0;i<13;i++){ const k=Number(n%42n); n/=42n; s=AF[k]+s; }
      return s.trim(); }
    if(n3===5){ let h=''; for(let i=0;i<71;i+=4) h+=bitsNum(b77,i,4).toString(16);
      return 'TELEM '+h; }
    return '(type 0.'+n3+')'; }
  if(i3===1||i3===2){
    const c1=bitsNum(b77,0,28), r1=b77[28], c2=bitsNum(b77,29,28), r2=b77[57];
    const R=b77[58], g15=bitsNum(b77,59,15);
    const s1=ft8Call(c1)+(r1?'/R':''), s2=ft8Call(c2)+(r2?'/R':'');
    const g=ft8Grid(g15,R);
    return (s1+' '+s2+(g?' '+g:'')).trim(); }
  return '(type i3='+i3+')';
}

/* ---------- FT8: поиск сигналов в 15-секундном слоте ---------- */
const FT8_COSTAS=[3,1,4,0,6,5,2], FT8_SR=6400, FT8_WIN=1024, FT8_HOP=256, FT8_SYMS=79;
const FT8_FFT=2048, FT8_TS=FT8_FFT/FT8_WIN;   // дополнение нулями: шаг сетки 3.125 Гц
const FT8_GRAY=[0,1,3,2,5,6,4,7];                   // символ → тон (WSJT-X)
const FT8_UNGRAY=(()=>{ const u=new Array(8); FT8_GRAY.forEach((t,v)=>u[t]=v); return u; })();

function ft8Payload(tones){                         // 79 тонов → 174 бита полезной нагрузки
  const data=[];
  for(let s=0;s<FT8_SYMS;s++){
    if((s>=0&&s<7)||(s>=36&&s<43)||(s>=72&&s<79)) continue;   // блоки синхронизации Костаса
    data.push(FT8_UNGRAY[tones[s]&7]); }
  let bits='';
  for(const v of data) bits+=v.toString(2).padStart(3,'0');
  let hex='';
  for(let i=0;i<bits.length;i+=4) hex+=parseInt(bits.substr(i,4).padEnd(4,'0'),2).toString(16);
  return {bits, hex, syms:data.length};
}

def({ id:'ft8Rx', title:'FT8: Receive Slots', cat:'Decoders',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'top',t:'num'},{n:'thr',t:'num'},
       {n:'keep',t:'num'},{n:'tones',t:'num'},{n:'decode',t:'num'},{n:'budget',t:'num'}],
  outs:[{n:'f',t:'num'},{n:'score',t:'num'},{n:'dt',t:'num'},{n:'busy',t:'num'}],
  readout:true, tall:true,
  params:[{n:'fmin',t:'range',min:100,max:3000,step:6.25,d:200},
          {n:'fmax',t:'range',min:200,max:3200,step:6.25,d:2800},
          {n:'top',t:'range',min:1,max:30,step:1,d:8},
          {n:'thr',t:'range',min:1,max:8,step:.1,d:1.6},
          {n:'keep',t:'range',min:1,max:60,step:1,d:12},
          {n:'tones',t:'check',d:false,label:'show tones'},
          {n:'decode',t:'check',d:true,label:'decode (LDPC)'},
          {n:'now',t:'button',label:'Parse now',fn:n=>ft8Run(n,true)},
          {n:'wav',t:'button',label:'Save slot to WAV',fn:n=>{
            const L=n.buf.length, o=new Float32Array(L);
            for(let i=0;i<L;i++) o[i]=n.buf[(n.wp+i)%L];
            wavDownload([o],FT8_SR); }},
          {n:'budget',t:'range',min:100,max:3000,step:50,d:800,label:'parse budget, ms'},
          {n:'save',t:'button',label:'Save log',fn:n=>ft8Save(n)},
          {n:'clr',t:'button',label:'Clear log',fn:n=>{n.log=[];ft8Text(n);}}],
  init:n=>{ n.buf=new Float32Array(FT8_SR*15); n.wp=0; n.acc=0; n.sum=0; n.cnt=0;
            n.slot=-1; n.log=[]; n.text='waiting for slot boundary…'; n.f=0; n.sc=0; n.dt=0; n.busy=0; },
  process(n,I){
    for(const k of ['fmin','fmax','top','thr','keep','budget']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['tones','decode']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const step=FT8_SR/Eng.sr;
    for(let i=0;i<BLOCK;i++){                       // прореживание с усреднением: защита от наложения
      const x=I.in?I.in[i]:0;
      n.sum+=x; n.cnt++;
      n.acc+=step;
      while(n.acc>=1){ n.acc-=1;
        n.buf[n.wp]=n.cnt? n.sum/n.cnt : 0;
        n.sum=0; n.cnt=0;
        n.wp=(n.wp+1)%n.buf.length; } }
    const now=Date.now(), slot=Math.floor(now/15000);   // границы слотов кратны 15 с UTC
    if(n.slot<0){ n.slot=slot; n.filled=0; }
    else if(slot!==n.slot){ n.slot=slot;
      if(n.filled>=FT8_SR*14) ft8Run(n,false,(slot-1)*15000);
      n.filled=0; }
    n.filled=(n.filled||0)+BLOCK*step;
    n.busy=clamp(n.filled/(FT8_SR*15),0,1);
    return {f:n.f, score:n.sc, dt:n.dt, busy:n.busy}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text){ const atTop=r.scrollTop<8;
      r.textContent=n.text; if(atTop) r.scrollTop=0; } }});
/* ============================================================
   Расширение: обобщённый слой "текст ↔ биты" + передатчик AX.25/APRS.
   Добавить в КОНЕЦ protocols.js (использует def/buf/setMod/BLOCK/Eng
   из core-engine.js и ita2enc/ita2/VARICODE/VARIMAP/crcCalc/CRCS
   из protocols.js — файл должен грузиться после них).
   ============================================================ */

/* ---------- текст → биты (общий слой, отдельно от последовательной посылки) ---------- */
// В отличие от uartTx/uartRx (которые совмещают кодировку символа И тайминг
// старт/стоп-бит), эти модули только превращают строку в массив бит (blk) и
// обратно — тайминг, скремблирование, FEC, перемежение вешаются отдельными
// узлами (scram/convenc/interleave/crc), как в остальной части патч-бея.

const TXTCODINGS=['UTF-8','ASCII 8-bit','ASCII 7-bit','Baudot ITA2','PSK31 varicode'];

function pushBits(arr,v,w){ for(let k=w-1;k>=0;k--) arr.push((v>>k)&1); }
function bytesToBits(bytes,w){ const o=[]; for(const b of bytes) pushBits(o,b,w); return o; }
function bitsToBytesW(bits,w){
  const o=[];
  for(let i=0;i+w<=bits.length;i+=w){ let v=0; for(let k=0;k<w;k++) v=(v<<1)|bits[i+k]; o.push(v); }
  return o;
}

function txtToBits(text,coding){
  switch(coding){
    case 'UTF-8': return bytesToBits(new TextEncoder().encode(text),8);
    case 'ASCII 7-bit': return bytesToBits([...text].map(c=>c.charCodeAt(0)&0x7f),7);
    case 'Baudot ITA2': { let figs=null,bits=[];
      for(const c of text.toUpperCase()){
        const e=ita2enc(c); if(!e) continue;
        if(figs===null||e[0]!==figs){ figs=e[0]; pushBits(bits,figs?27:31,5); }
        pushBits(bits,e[1],5); }
      return bits; }
    case 'PSK31 varicode': { const bits=[];
      for(const c of text){ const v=VARICODE[c.charCodeAt(0)]; if(!v) continue;
        for(const ch of v) bits.push(+ch); bits.push(0,0); }        // "00" — разделитель символов
      return bits; }
    default: return bytesToBits([...text].map(c=>c.charCodeAt(0)&0xff),8);   // ASCII 8-bit
  }
}

function bitsToTxt(bits,coding){
  switch(coding){
    case 'UTF-8': { const by=bitsToBytesW(bits,8);
      try{ return new TextDecoder().decode(new Uint8Array(by)); }catch(e){ return ''; } }
    case 'ASCII 7-bit': return bitsToBytesW(bits,7).map(c=>String.fromCharCode(c)).join('');
    case 'Baudot ITA2': { let figs=false,o='',i=0;
      while(i+5<=bits.length){ let v=0; for(let k=0;k<5;k++) v=(v<<1)|bits[i+k]; i+=5;
        if(v===27){ figs=true; continue; } if(v===31){ figs=false; continue; }
        o+=ita2(v,figs); }
      return o; }
    case 'PSK31 varicode': { let o='',cur=[],zeroRun=0;
      for(const b of bits){
        if(b){ cur.push(1); zeroRun=0; continue; }
        zeroRun++;
        if(zeroRun===1){ cur.push(0); continue; }                  // одиночный 0 — часть кода
        cur.pop();                                                 // второй 0 подряд — это был разделитель
        if(cur.length){ const c=VARIMAP[cur.join('')]; if(c!=null) o+=String.fromCharCode(c); }
        cur=[]; zeroRun=0; }
      return o; }
    default: return bitsToBytesW(bits,8).map(c=>String.fromCharCode(c)).join('');
  }
}

def({ id:'txt2bits', title:'Text → Bits', cat:'Protocols',
  ins:[{n:'text',t:'txt'},{n:'go',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'text',t:'text',d:'CQ CQ DE TEST'},
          {n:'coding',t:'select',opts:TXTCODINGS,d:'UTF-8'},
          {n:'build',t:'button',label:'Build',fn:n=>{n.src=null;}}],
  init:n=>{n.bid=0;n.prevGo=0;},
  process(n,I){
    const src=(typeof I.text==='string'&&I.text)? I.text : n.p.text;
    const go=I.go||0, trig=go>.5&&!n.prevGo; n.prevGo=go>.5;
    if(src!==n.src || n.coding!==n.p.coding || trig){
      n.src=src; n.coding=n.p.coding;
      const bits=txtToBits(src,n.p.coding);
      const d=new Float32Array(bits.length);
      for(let i=0;i<bits.length;i++) d[i]=bits[i]?1:-1;
      n.blk={d,n:d.length,id:++n.bid};
      n.text=bits.length+' bits · '+n.p.coding; }
    return {blk:n.blk||null, text:n.text||''}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'…'; }});


def({ id:'bits2txt', title:'Bits → Text', cat:'Decoders',
  ins:[{n:'blk',t:'blk'}], outs:[{n:'text',t:'txt'}], readout:true, tall:true,
  params:[{n:'coding',t:'select',opts:TXTCODINGS,d:'UTF-8'},
          {n:'append',t:'check',d:true,label:'append'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{n.bid=-1;n.text='';},
  process(n,I){
    const b=I.blk; if(!b||b.id===n.bid) return {text:n.text||''};
    n.bid=b.id;
    const bits=[...b.d].map(v=>v>0?1:0);
    const s=bitsToTxt(bits,n.p.coding);
    n.text = n.p.append? (n.text+s) : s;
    if(n.text.length>4000) n.text=n.text.slice(-3000);
    return {text:n.text}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==(n.text||'…')){ r.textContent=n.text||'…'; r.scrollTop=r.scrollHeight; } }});


/* ---------- AX.25 / APRS: сборка и передача кадра ---------- */
// Пара к декодеру 'hdlc' — тот же формат кадра (флаги 0x7E, вставка нулей,
// NRZI, CRC-16/X.25), только в обратную сторону: строка → биты в эфир.

function ax25ParseCall(s){                          // 'RA1ABC-5' → {call,ssid}
  s=(s||'').trim().toUpperCase();
  const m=s.match(/^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/);
  return m? {call:m[1],ssid:Math.min(15,+m[2]||0)} : {call:'NOCALL',ssid:0};
}
function ax25Addr(call,ssid,last,cbit){              // один адрес → 7 байт поля адреса
  const s=call.padEnd(6,' '), b=[];
  for(let i=0;i<6;i++) b.push(s.charCodeAt(i)<<1);
  b.push(0x60|(ssid<<1)|(cbit?0x80:0)|(last?1:0));
  return b;
}
function ax25BuildFrame(n){
  const dst=ax25ParseCall(n.p.dst), src=ax25ParseCall(n.p.src);
  const path=n.p.path.split(',').map(s=>s.trim()).filter(Boolean).map(ax25ParseCall);
  const addrs=[{...dst,c:1},{...src,c:0},...path.map(p=>({...p,c:0}))];
  const bytes=[];
  addrs.forEach((a,i)=>bytes.push(...ax25Addr(a.call,a.ssid,i===addrs.length-1,a.c)));
  bytes.push(0x03,0xf0);                             // control (UI), PID (нет уровня 3)
  bytes.push(...new TextEncoder().encode(n.p.text));
  const fcs=crcCalc(bytes,CRCS['CRC-16/X.25 (HDLC)']);
  bytes.push(fcs&0xff,(fcs>>8)&0xff);                // FCS младшим байтом вперёд
  return bytes;
}
function ax25StuffBits(bytes){                       // байты → биты кадра со вставкой нуля, младшим битом вперёд
  const bits=[]; let ones=0;
  for(const byte of bytes) for(let k=0;k<8;k++){
    const b=(byte>>k)&1; bits.push(b);
    if(b){ ones++; if(ones===5){ bits.push(0); ones=0; } } else ones=0; }
  return bits;
}
function ax25Queue(n){
  const bytes=ax25BuildFrame(n);
  const flag=[0,1,1,1,1,1,1,0];
  const bits=[];
  for(let i=0;i<n.p.preamble;i++) bits.push(...flag);
  bits.push(...ax25StuffBits(bytes));
  for(let i=0;i<Math.max(1,n.p.postamble);i++) bits.push(...flag);
  let lvl=0;                                         // NRZI: 0 в данных = смена уровня, 1 = без смены
  n.q=bits.map(b=>{ if(!b) lvl^=1; return [lvl,1]; });
  n.text='frame: '+bytes.length+' bytes · '+bits.length+' bits on the wire';
}

def({ id:'ax25Tx', title:'Transmit AX.25/APRS', cat:'Protocols', readout:true, tall:true,
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'baud',t:'num'},{n:'loop',t:'num'}],
  outs:[{n:'bit',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'dst',t:'text',d:'APRS',label:'destination address'},
          {n:'src',t:'text',d:'NOCALL-1',label:'callsign-SSID'},
          {n:'path',t:'text',d:'WIDE1-1,WIDE2-1',label:'digipeater path'},
          {n:'text',t:'text',d:'!5540.00N/03730.00E>test APRS',label:'information field'},
          {n:'baud',t:'range',min:50,max:9600,step:1,d:1200,log:true},
          {n:'preamble',t:'range',min:1,max:60,step:1,d:20,label:'preamble flags'},
          {n:'postamble',t:'range',min:1,max:10,step:1,d:3,label:'flags after frame'},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>ax25Queue(n)}],
  init:n=>{n.q=[];n.cur=0;n.left=0;n.prevGo=0;n.text='waiting';},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    if(typeof I.text==='string'&&I.text) n.p.text=I.text;
    const o=buf(n,'bit'), spb=Eng.sr/Math.max(1,n.p.baud);
    const go=I.go||0; if(go>.5&&n.prevGo<=.5) ax25Queue(n); n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){
        if(!n.q.length && n.p.loop) ax25Queue(n);
        if(n.q.length){ const b=n.q.shift(); n.cur=b[0]; n.left=b[1]*spb; }
        else n.left=spb; }
      n.left--; o[i]=n.cur?1:-1; }
    return {bit:o, busy:n.q.length?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting'; }});


/* ============================================================
   Olivia / Contestia: MFSK + Уолш-Адамар FEC.
   Пара по духу как FT8: цельные приёмник/передатчик, а не россыпь
   микро-узлов — перемежение бит завязано на положение символа в блоке
   настолько плотно, что развязать его на отдельные провода нельзя
   без нового типа порта ("вектор на такт"), которого у нас нет.
   Спецификация: draft spec Павла Ялохи (SP9VRC) + Wikipedia/Olivia MFSK.
   Проверено автономным тестом на 2000+ случайных блоков, включая
   внесение одной ошибки символа на блок — Уолш-код её выправляет.
   ============================================================ */

function hadamard64(){                               // 64×64, конструкция Сильвестра, кэшируется
  let H=[[1]];
  while(H.length<64){
    const m=H.length, H2=[];
    for(let i=0;i<m;i++) H2.push(H[i].concat(H[i]));
    for(let i=0;i<m;i++) H2.push(H[i].concat(H[i].map(v=>-v)));
    H=H2; }
  return H;
}
const HAD64=hadamard64();
const OLIVIA_SCRAMBLE=0xE257E6D0291574ECn;
function oliviaScramble(rotBy){                       // константа скрэмблирования, повёрнутая вправо
  const rot=((OLIVIA_SCRAMBLE>>BigInt(rotBy))|(OLIVIA_SCRAMBLE<<BigInt(64-rotBy)))&0xFFFFFFFFFFFFFFFFn;
  const bits=[]; for(let i=63;i>=0;i--) bits.push(Number((rot>>BigInt(i))&1n));
  return bits;
}
function oliviaWalshEnc(code7){                       // 7 бит → 64 значения ±1 (строка Адамара + инверсия)
  const row=code7&0x3f, inv=(code7>>6)&1;
  return HAD64[row].map(v=>inv? -v:v);
}
function oliviaWalshDec(vec){                         // 64 мягких/жёстких значения → 7 бит (корреляция со всеми строками)
  let best=0,bestCorr=0,bestAbs=-1;
  for(let r=0;r<64;r++){
    let c=0; for(let i=0;i<64;i++) c+=HAD64[r][i]*vec[i];
    if(Math.abs(c)>bestAbs){ bestAbs=Math.abs(c); bestCorr=c; best=r; } }
  return best | ((bestCorr<0?1:0)<<6);
}
function oliviaEncodeBlock(chars7,bitsPerSym){        // bitsPerSym символов-кодов → 64 индекса тона
  const vecs=[];
  for(let ch=0; ch<bitsPerSym; ch++){
    const scr=oliviaScramble((13*ch)%64), raw=oliviaWalshEnc(chars7[ch]);
    vecs.push(raw.map((v,i)=> scr[i]? -v:v)); }
  const tones=new Array(64);
  for(let s=0;s<64;s++){
    let tone=0;
    for(let p=0;p<bitsPerSym;p++){
      const ch=((p-s)%bitsPerSym+bitsPerSym)%bitsPerSym;   // диагональное перемежение (спецификация Ялохи)
      tone=(tone<<1)|(vecs[ch][s]>0?1:0); }
    tones[s]=tone; }
  return tones;
}
function oliviaDecodeBlock(tones,bitsPerSym){         // 64 индекса тона → bitsPerSym кодов-символов
  const vecs=[]; for(let ch=0;ch<bitsPerSym;ch++) vecs.push(new Array(64));
  for(let s=0;s<64;s++) for(let p=0;p<bitsPerSym;p++){
    const bit=(tones[s]>>(bitsPerSym-1-p))&1;
    const ch=((p-s)%bitsPerSym+bitsPerSym)%bitsPerSym;
    vecs[ch][s]=bit?1:-1; }
  const chars=[];
  for(let ch=0;ch<bitsPerSym;ch++){
    const scr=oliviaScramble((13*ch)%64);
    chars.push(oliviaWalshDec(vecs[ch].map((v,i)=>scr[i]?-v:v))); }
  return chars;
}
function oliviaDecodeBlockConf(tones,bitsPerSym){     // как oliviaDecodeBlock, но с оценкой уверенности (для поиска границы блока)
  const vecs=[]; for(let ch=0;ch<bitsPerSym;ch++) vecs.push(new Array(64));
  for(let s=0;s<64;s++) for(let p=0;p<bitsPerSym;p++){
    const bit=(tones[s]>>(bitsPerSym-1-p))&1;
    const ch=((p-s)%bitsPerSym+bitsPerSym)%bitsPerSym;
    vecs[ch][s]=bit?1:-1; }
  const chars=[]; let minAbs=64;
  for(let ch=0;ch<bitsPerSym;ch++){
    const scr=oliviaScramble((13*ch)%64), dv=vecs[ch].map((v,i)=>scr[i]?-v:v);
    let best=0,bestCorr=0,bestAbs=-1;
    for(let r=0;r<64;r++){
      let c=0; for(let i=0;i<64;i++) c+=HAD64[r][i]*dv[i];
      if(Math.abs(c)>bestAbs){ bestAbs=Math.abs(c); bestCorr=c; best=r; } }
    chars.push(best|((bestCorr<0?1:0)<<6));
    if(bestAbs<minAbs) minAbs=bestAbs; }
  return {chars, conf:minAbs/64};                     // conf=1 — идеальное совпадение с кодовым словом Уолша
}
function oliviaTextToTones(text,M){
  const bitsPerSym=Math.log2(M);
  const codes=[...text].map(c=>c.charCodeAt(0)&0x7f);
  while(codes.length%bitsPerSym) codes.push(0x20);     // добиваем блок пробелами
  const tones=[];
  for(let b=0;b<codes.length;b+=bitsPerSym) tones.push(...oliviaEncodeBlock(codes.slice(b,b+bitsPerSym),bitsPerSym));
  return tones;
}

const MFSK_TONES=['2','4','8','16','32','64','128','256'];
const MFSK_BW=['125','250','500','1000','2000'];

function mfskTxProcess(n,I,BLOCK_){
  const o=buf(n,'out');
  const M=+n.p.tones, bw=+n.p.bw, bitsPerSym=Math.log2(M), spb=Eng.sr*M/bw;
  if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
  if(typeof I.text==='string'&&I.text) n.p.text=I.text;
  const go=I.go||0;
  if((go>.5&&n.prevGo<=.5)||n.trig){
    n.trig=false; n.q=oliviaTextToTones(n.p.text,M); n.qi=0; n.left=0;
    n.text='symbol block: '+n.q.length+' ('+Math.ceil(n.q.length/64)+' FEC block(s))'; }
  n.prevGo=go;
  const f0=n.p.f0-bw/2, spacing=bw/M;
  for(let i=0;i<BLOCK_;i++){
    if(n.left<=0){
      if(n.qi>=n.q.length){
        if(n.p.loop){ n.q=oliviaTextToTones(n.p.text,M); n.qi=0;
          n.text='symbol block: '+n.q.length+' ('+Math.ceil(n.q.length/64)+' FEC block(s))'; }
        if(!n.q.length){ o[i]=0; continue; } }
      n.cur=n.q[n.qi++]; n.left=spb; }
    const freq=f0+n.cur*spacing;
    n.ph=(n.ph+freq/Eng.sr)%1;
    o[i]=Math.sin(2*Math.PI*n.ph)*n.p.amp;
    n.left--; }
  return {out:o, busy:n.qi<n.q.length?1:0};
}
function mfskRxProcess(n,I,BLOCK_){
  const M=+n.p.tones, bw=+n.p.bw, bitsPerSym=Math.log2(M), baud=bw/M, spacing=baud, f0=n.p.f0-bw/2;
  if(n.M!==M || n.bw!==bw){                            // смена числа тонов/полосы — пересоздать состояние
    n.M=M; n.bw=bw;
    n.acc=new Float64Array(M*2); n.tonePh=new Float64Array(M);
    n.ph=0; n.symCount=0; n.win=[]; n.locked=false; n.lockPhase=0; n.conf=0; }
  for(let i=0;i<BLOCK_;i++){
    const x=I.in?I.in[i]:0;
    for(let k=0;k<M;k++){
      const f=f0+k*spacing, w=2*Math.PI*n.tonePh[k];
      n.acc[k*2]+=x*Math.cos(w); n.acc[k*2+1]-=x*Math.sin(w);
      n.tonePh[k]=(n.tonePh[k]+f/Eng.sr)%1; }
    n.ph+=baud/Eng.sr;
    if(n.ph>=1){
      n.ph-=1;
      let best=0,bestMag=-1;
      for(let k=0;k<M;k++){ const mag=n.acc[k*2]*n.acc[k*2]+n.acc[k*2+1]*n.acc[k*2+1];
        if(mag>bestMag){ bestMag=mag; best=k; } }
      n.acc.fill(0);
      n.win.push(best); if(n.win.length>64) n.win.shift();
      n.symCount++;
      // Приёмник не знает, где у передатчика начинается 64-символьный блок — это НЕ
      // режим с явным кадром/синхрословом, как AX.25, а непрерывный поток символов.
      // Поэтому: пока не поймали фазу — пробуем декодировать скользящее окно КАЖДЫЙ
      // такт и ждём, когда получится (почти) точное кодовое слово Уолша (conf≈1 —
      // такое совпадение случайно практически невозможно). Как только поймали —
      // запоминаем фазу и дальше декодируем ровно раз в 64 такта, без перебора.
      if(n.win.length===64){
        if(!n.locked){
          const r=oliviaDecodeBlockConf(n.win,bitsPerSym);
          n.conf=r.conf;
          if(r.conf>=0.85){
            n.locked=true; n.lockPhase=n.symCount%64;
            n.text=(n.text||'')+r.chars.map(c=>String.fromCharCode(c)).join('');
            if(n.text.length>4000) n.text=n.text.slice(-3000); }
        } else if(n.symCount%64===n.lockPhase){
          const r=oliviaDecodeBlockConf(n.win,bitsPerSym);
          n.conf=r.conf;
          if(r.conf<0.5) n.locked=false;               // синхронизация потеряна — искать заново
          else { n.text=(n.text||'')+r.chars.map(c=>String.fromCharCode(c)).join('');
            if(n.text.length>4000) n.text=n.text.slice(-3000); } } } } }
  return {text:n.text||'', sym:n.win[n.win.length-1]||0, lock:n.locked?1:0};
}

// Раздельные позывные узлы по спецификации Ялохи (Olivia).
def({ id:'oliviaTx', title:'Olivia: Transmit', cat:'Protocols', readout:true, tall:true,
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'loop',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'text',t:'text',d:'CQ CQ DE TEST OLIVIA'},
          {n:'tones',t:'select',opts:MFSK_TONES,d:'8'},
          {n:'bw',t:'select',opts:MFSK_BW,d:'250'},
          {n:'f0',t:'range',min:200,max:3000,step:10,d:1000,label:'band center, Hz'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>{n.trig=true;}}],
  init:n=>{n.q=[];n.qi=0;n.cur=0;n.left=0;n.ph=0;n.prevGo=0;n.trig=false;n.text='waiting';},
  process(n,I){ return mfskTxProcess(n,I,BLOCK); },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting'; }});

def({ id:'oliviaRx', title:'Olivia: Receive', cat:'Decoders', readout:true, tall:true,
  ins:[{n:'in',t:'sig'}], outs:[{n:'text',t:'txt'},{n:'sym',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'tones',t:'select',opts:MFSK_TONES,d:'8'},
          {n:'bw',t:'select',opts:MFSK_BW,d:'250'},
          {n:'f0',t:'range',min:200,max:3000,step:10,d:1000,label:'band center, Hz'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{n.M=0;n.bw=0;n.text='';},
  process(n,I){ return mfskRxProcess(n,I,BLOCK); },
  draw(n){ const r=n.el.querySelector('.readout');
    const t=(n.locked?'synced':'searching for block boundary…')+'\n'+(n.text||'…');
    if(r.textContent!==t){ r.textContent=t; r.scrollTop=r.scrollHeight; } }});


// Contestia (UT2UZ) — та же MFSK+Уолш-Адамар связка, что и Olivia (источники
// описывают её как «производную Olivia со схожим FEC высокой избыточности»),
// только со своим набором Тонов/Полосы под более высокую скорость. Точный
// битовый формат оригинального Contestia (если он отличается в деталях
// скрэмблирования) я подтвердить по открытым источникам не смог — считайте
// этот узел «в семье Olivia», а не гарантированно байт-в-байт совместимым
// с эфирным Contestia от MixW/fldigi.
def({ id:'contestiaTx', title:'Contestia: Transmit', cat:'Protocols', readout:true, tall:true,
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'loop',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'text',t:'text',d:'CQ CQ DE TEST CONTESTIA'},
          {n:'tones',t:'select',opts:MFSK_TONES,d:'8'},
          {n:'bw',t:'select',opts:MFSK_BW,d:'500'},
          {n:'f0',t:'range',min:200,max:3000,step:10,d:1000,label:'band center, Hz'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'loop',t:'check',d:false},
          {n:'send',t:'button',label:'Send',fn:n=>{n.trig=true;}}],
  init:n=>{n.q=[];n.qi=0;n.cur=0;n.left=0;n.ph=0;n.prevGo=0;n.trig=false;n.text='waiting';},
  process(n,I){ return mfskTxProcess(n,I,BLOCK); },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting'; }});

def({ id:'contestiaRx', title:'Contestia: Receive', cat:'Decoders', readout:true, tall:true,
  ins:[{n:'in',t:'sig'}], outs:[{n:'text',t:'txt'},{n:'sym',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'tones',t:'select',opts:MFSK_TONES,d:'8'},
          {n:'bw',t:'select',opts:MFSK_BW,d:'500'},
          {n:'f0',t:'range',min:200,max:3000,step:10,d:1000,label:'band center, Hz'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.text='';}}],
  init:n=>{n.M=0;n.bw=0;n.text='';},
  process(n,I){ return mfskRxProcess(n,I,BLOCK); },
  draw(n){ const r=n.el.querySelector('.readout');
    const t=(n.locked?'synced':'searching for block boundary…')+'\n'+(n.text||'…');
    if(r.textContent!==t){ r.textContent=t; r.scrollTop=r.scrollHeight; } }});


/* ============================================================
   OFDM: обобщённая многочастотная модуляция общего назначения.
   Не привязан к конкретному протоколу — берёт/отдаёт биты (blk),
   поверх можно собирать что угодно (Olivia уже такой не сделаешь
   без переделки — там перемежение завязано на модуляцию намертво,
   а вот OFDM как раз позволяет разделить слои).

   Схема: N ортогональных поднесущих (k+1)·Δf, дифференциальная
   BPSK/QPSK на каждой отдельно (это убирает саму задачу оценки
   канала/пилотов — фаза берётся относительно ПРЕДЫДУЩЕГО символа
   на той же поднесущей, а не какого-то опорного пилот-тона).
   Циклический префикс — для устойчивости к многолучёвости И как
   сигнатура для поиска границы символа на приёме (автокорреляция
   CP — стандартный приём, тот же, что в WiFi/LTE/DRM).

   Проверено автономным тестом: держит синхронизацию при ЛЮБОЙ
   задержке старта передачи (0..123456 сэмплов), и шум с амплитудой
   30% от сигнала не мешает (без какого-либо FEC поверх — сам код
   в чистом виде). Более сильный шум просто не даёт поймать захват
   (нужен FEC поверх, как и в реальных системах — этот узел даёт
   только модуляцию, кодирование — отдельными узлами выше по цепи).
   ============================================================ */

function ofdmBitsToInc(bits,bpc){                     // биты -> приращение фазы (Грей-код)
  if(bpc===1) return bits[0]? Math.PI : 0;
  const b0=bits[0], b1=bits[1];
  if(!b0&&!b1) return 0; if(!b0&&b1) return Math.PI/2; if(b0&&b1) return Math.PI; return 3*Math.PI/2;
}
function ofdmIncToBits(d,bpc){                        // приращение фазы -> биты (ближайшая точка созвездия)
  if(bpc===1) return [Math.cos(d)<0?1:0];
  const a=((d%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
  const idx=Math.round(a/(Math.PI/2))%4;
  return [[0,0],[0,1],[1,1],[1,0]][idx];
}
function ofdmEncodePhases(bits,N,bpc){                // биты -> массив OFDM-символов (Float64Array[N] абс.фаз, [0]=опорный)
  const bitsPerSym=N*bpc, b=bits.slice();
  while(b.length%bitsPerSym) b.push(0);
  const out=[new Float64Array(N)]; let prev=new Float64Array(N);
  for(let i=0;i<b.length;i+=bitsPerSym){
    const cur=new Float64Array(N);
    for(let k=0;k<N;k++) cur[k]=(prev[k]+ofdmBitsToInc(b.slice(i+k*bpc,i+k*bpc+bpc),bpc))%(2*Math.PI);
    out.push(cur); prev=cur; }
  return out;
}
function ofdmBuildQueue(n){
  const N=n.p.carriers|0, bpc=n.p.mod==='QPSK'?2:1;
  const bits=n.lastBlk? [...n.lastBlk.d].map(v=>v>0?1:0) : [];
  const symSamp=Math.round(Eng.sr/n.p.spacing), cpSamp=Math.round(symSamp*n.p.cp/100);
  n.queue=ofdmEncodePhases(bits,N,bpc); n.qi=0; n.curPhases=n.queue[0]; n.localIdx=-cpSamp;
  n.text='OFDM symbols: '+n.queue.length+' ('+bits.length+' bits, '+N+' subcarriers, '+n.p.mod+')';
}

def({ id:'ofdmTx', title:'OFDM: Modulator', cat:'Modulation', readout:true, tall:true,
  ins:[{n:'blk',t:'blk'},{n:'go',t:'num'},{n:'loop',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'carriers',t:'range',min:4,max:64,step:1,d:16,label:'subcarriers'},
          {n:'spacing',t:'range',min:5,max:200,step:.25,d:31.25,log:true,label:'subcarrier spacing, Hz'},
          {n:'f0',t:'range',min:0,max:4000,step:10,d:800,label:'band lower edge, Hz'},
          {n:'cp',t:'range',min:0,max:50,step:1,d:25,label:'cyclic prefix, % of symbol'},
          {n:'mod',t:'select',opts:['BPSK','QPSK'],d:'BPSK'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'loop',t:'check',d:true},
          {n:'send',t:'button',label:'Send',fn:n=>{n.trig=true;}}],
  init:n=>{n.bid=-1;n.queue=[];n.qi=0;n.localIdx=Infinity;n.curPhases=null;n.prevGo=0;n.trig=false;n.text='waiting for bit block';},
  process(n,I){
    const o=buf(n,'out');
    const N=n.p.carriers|0, df=n.p.spacing, f0=n.p.f0, amp=n.p.amp;
    const symSamp=Math.round(Eng.sr/df), cpSamp=Math.round(symSamp*n.p.cp/100);
    const b=I.blk; if(b && b.id!==n.bid){ n.bid=b.id; n.lastBlk=b; }
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const go=I.go||0; if((go>.5&&n.prevGo<=.5)||n.trig){ n.trig=false; if(n.lastBlk) ofdmBuildQueue(n); }
    n.prevGo=go;
    for(let i=0;i<BLOCK;i++){
      if(n.localIdx>=symSamp){
        n.qi++;
        if(n.qi>=n.queue.length){
          if(n.p.loop && n.lastBlk) ofdmBuildQueue(n);
          else { n.curPhases=null; o[i]=0; continue; }
        } else { n.curPhases=n.queue[n.qi]; n.localIdx=-cpSamp; }
      }
      if(!n.curPhases){ o[i]=0; continue; }
      const t=n.localIdx/Eng.sr; let s=0;
      for(let k=0;k<N;k++) s+=Math.cos(2*Math.PI*(f0+(k+1)*df)*t + n.curPhases[k]);
      o[i]=s*amp/N; n.localIdx++; }
    return {out:o, busy:n.qi<n.queue.length?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.text||'waiting for bit block'; }});


def({ id:'ofdmRx', title:'OFDM: Demodulator', cat:'Modulation', readout:true,
  ins:[{n:'in',t:'sig'}], outs:[{n:'blk',t:'blk'},{n:'lock',t:'num'}],
  params:[{n:'carriers',t:'range',min:4,max:64,step:1,d:16,label:'subcarriers'},
          {n:'spacing',t:'range',min:5,max:200,step:.25,d:31.25,log:true,label:'subcarrier spacing, Hz'},
          {n:'f0',t:'range',min:0,max:4000,step:10,d:800,label:'band lower edge, Hz'},
          {n:'cp',t:'range',min:0,max:50,step:1,d:25,label:'cyclic prefix, % of symbol'},
          {n:'mod',t:'select',opts:['BPSK','QPSK'],d:'BPSK'}],
  init:n=>{n.N=0;n.df=0;n.cpP=-1;},
  process(n,I){
    const N=n.p.carriers|0, df=n.p.spacing, f0=n.p.f0, bpc=n.p.mod==='QPSK'?2:1;
    if(n.N!==N || n.df!==df || n.cpP!==n.p.cp){             // смена параметров — пересоздать состояние приёма
      n.N=N; n.df=df; n.cpP=n.p.cp;
      const symSamp=Math.round(Eng.sr/df), cpSamp=Math.round(symSamp*n.p.cp/100), period=symSamp+cpSamp;
      n.symSamp=symSamp; n.cpSamp=cpSamp; n.period=period;
      n.ringLen=period+symSamp+8; n.ring=new Float64Array(n.ringLen);
      n.corrSum=0; n.energySum=0; n.validCount=0; n.hist=new Float64Array(period);
      n.n=0; n.locked=false; n.lockOffset=0;
      n.prevIQ=new Float64Array(N*2); n.haveRef=false;
      n.accI=new Float64Array(N); n.accQ=new Float64Array(N);
      n.bid=0; n.blkOut=null; }
    const symSamp=n.symSamp, cpSamp=n.cpSamp, period=n.period;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      n.ring[n.n%n.ringLen]=x;
      if(n.n>=symSamp){
        const xSym=n.ring[(n.n-symSamp+n.ringLen)%n.ringLen];
        n.corrSum+=x*xSym; n.energySum+=(x*x+xSym*xSym)/2; n.validCount++;
        if(n.validCount>cpSamp){
          const oldN=n.n-cpSamp, oldX=n.ring[oldN%n.ringLen], oldXSym=n.ring[(oldN-symSamp+n.ringLen)%n.ringLen];
          n.corrSum-=oldX*oldXSym; n.energySum-=(oldX*oldX+oldXSym*oldXSym)/2; n.validCount=cpSamp; }
        if(n.validCount===cpSamp && !n.locked){
          const norm=Math.abs(n.corrSum)/(n.energySum+1e-9);
          n.hist[n.n%period]=n.hist[n.n%period]*0.7+norm*0.3;
          // Пик корреляции CP приходится на КОНЕЦ символа (окно совпадает с копией CP,
          // сдвинутой на symSamp вперёд), поэтому +1 при переводе в начало данных;
          // margin — запас в БЕЗОПАСНУЮ сторону: недолёт всё ещё внутри своего CP,
          // перелёт уже цепляет чужой символ и рвёт всё в клочья.
          if(n.n>0 && n.n%(period*6)===0){
            let bi=0; for(let i2=1;i2<period;i2++) if(n.hist[i2]>n.hist[bi]) bi=i2;
            if(n.hist[bi]>0.4){
              n.locked=true;
              const margin=Math.max(2,Math.round(cpSamp*0.15));
              n.lockOffset=((bi+1-margin)%period+period)%period; } } }
      }
      if(n.locked){
        const rel=((n.n-n.lockOffset)%period+period)%period;
        if(rel>=cpSamp){
          const dPos=rel-cpSamp;
          for(let k=0;k<N;k++){
            const w=2*Math.PI*(f0+(k+1)*df)*(dPos/Eng.sr);
            n.accI[k]+=x*Math.cos(w); n.accQ[k]-=x*Math.sin(w); }
          if(dPos===symSamp-1){
            if(!n.haveRef){ for(let k=0;k<N;k++){ n.prevIQ[k*2]=n.accI[k]; n.prevIQ[k*2+1]=n.accQ[k]; } n.haveRef=true; }
            else {
              const bits=[];
              for(let k=0;k<N;k++){
                const cp=Math.atan2(n.accQ[k],n.accI[k]), pp=Math.atan2(n.prevIQ[k*2+1],n.prevIQ[k*2]);
                bits.push(...ofdmIncToBits(cp-pp,bpc));
                n.prevIQ[k*2]=n.accI[k]; n.prevIQ[k*2+1]=n.accQ[k]; }
              const d=new Float32Array(bits.length);
              for(let i2=0;i2<bits.length;i2++) d[i2]=bits[i2]?1:-1;
              n.blkOut={d,n:d.length,id:++n.bid}; }
            n.accI.fill(0); n.accQ.fill(0); } }
      }
      n.n++; }
    return {blk:n.blkOut, lock:n.locked?1:0}; },
  draw(n){ n.el.querySelector('.readout').textContent=(n.locked?'synced':'searching for symbol boundary…')+
    (n.blkOut? ' · last block #'+n.blkOut.id : ''); }});


/* ============================================================
   Определитель типа сигнала: эвристический, не точный декодер.
   Смотрит на усреднённый спектр (кластеры энергии, их количество
   и разнос) + огибающую (манипуляция вкл/выкл, оценка скорости
   через автокорреляцию) + тест «возвести в квадрат» для PSK
   (подавленная несущая после манипуляции ±π снова становится
   чистым тоном на удвоенной частоте — классический приём).
   Выдаёт ранжированный список догадок с параметрами для быстрой
   настройки нужного декодера, не гарантирует точность.
   ============================================================ */

function sigidHann(N){ const w=new Float64Array(N); for(let i=0;i<N;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1)); return w; }
function sigidAvgSpectrum(x,N,nFrames,win){
  const acc=new Float64Array(N/2), re=new Float32Array(N), im=new Float32Array(N);
  for(let f=0;f<nFrames;f++){
    for(let i=0;i<N;i++){ re[i]=(x[f*N+i]||0)*win[i]; im[i]=0; }
    fft(re,im);
    for(let k=0;k<N/2;k++) acc[k]+=Math.hypot(re[k],im[k])/nFrames;
  }
  return acc;
}
// Кластеризация по областям энергии выше порога — устойчивее к боковым
// лепесткам от манипуляции, чем поиск отдельных локальных максимумов.
function sigidBands(mag,sr,N,relFactor,gapHz){
  let maxMag=0; for(const v of mag) if(v>maxMag) maxMag=v;
  if(maxMag<1e-9) return [];
  const thr=maxMag*relFactor, gapBins=Math.max(1,Math.round(gapHz/(sr/N)));
  const active=new Uint8Array(mag.length);
  for(let i=0;i<mag.length;i++) active[i]=mag[i]>thr?1:0;
  let i=0;
  while(i<active.length){
    if(!active[i]){ let j=i; while(j<active.length&&!active[j]) j++;
      if(j-i<=gapBins&&i>0&&j<active.length) for(let k=i;k<j;k++) active[k]=1;
      i=j; } else i++; }
  const bands=[]; i=0;
  while(i<active.length){
    if(active[i]){ let j=i; while(j<active.length&&active[j]) j++;
      let wsum=0,wf=0,peakMag=0;
      for(let k=i;k<j;k++){ wsum+=mag[k]; wf+=mag[k]*k*sr/N; if(mag[k]>peakMag) peakMag=mag[k]; }
      bands.push({freqLo:i*sr/N,freqHi:(j-1)*sr/N,centroid:wf/wsum,mag:peakMag}); i=j; }
    else i++; }
  return bands.filter(b=>b.centroid>40);           // отбросить DC-подобный мусор у нуля
}
function sigidBandSpacing(bands){
  if(bands.length<2) return null;
  const sp=[]; for(let i=1;i<bands.length;i++) sp.push(bands[i].centroid-bands[i-1].centroid);
  const mean=sp.reduce((a,b)=>a+b,0)/sp.length;
  const varr=sp.reduce((a,b)=>a+(b-mean)**2,0)/sp.length;
  return {mean, cv:Math.sqrt(varr)/Math.max(1,mean)};
}
// Насколько энергия внутри полосы «размазана» (много близких тонов сразу),
// а не сосредоточена в одном-двух бинах (одна несущая/CW). Не даёт точное
// число тонов, но не требует их и разрешать по отдельности.
function sigidFlatness(mag,sr,N,lo,hi){
  const b0=Math.max(0,Math.round(lo/(sr/N))), b1=Math.min(mag.length-1,Math.round(hi/(sr/N)));
  if(b1<=b0) return 0;
  let sum=0,peak=0,cnt=0;
  for(let i=b0;i<=b1;i++){ sum+=mag[i]; if(mag[i]>peak) peak=mag[i]; cnt++; }
  const mean=sum/cnt;
  return peak>0? mean/peak : 0;                       // ближе к 1 — энергия размазана, ближе к 0 — один острый пик
}
// Оценка скорости манипуляции по автокорреляции огибающей (сильно прорежена —
// иначе на 48 кГц полный перебор лагов слишком дорог для реального времени).
function sigidEnvelopeRate(x,sr){
  const decim=Math.max(1,Math.round(sr/2000)), envSr=sr/decim;
  const env=new Float64Array(Math.floor(x.length/decim));
  const winSamp=Math.max(1,Math.round(sr*0.004));
  let acc=0;
  const absx=new Float64Array(x.length);
  for(let i=0;i<x.length;i++){ absx[i]=Math.abs(x[i]);
    acc+=absx[i]; if(i>=winSamp) acc-=absx[i-winSamp];
    if(i%decim===0) env[Math.floor(i/decim)]=acc/Math.min(i+1,winSamp); }
  const mean=env.reduce((a,b)=>a+b,0)/env.length;
  const c=env.map(v=>v-mean);
  const minLag=Math.max(6,Math.round(envSr/500)), maxLag=Math.min(c.length-1,Math.round(envSr/3));
  let bestLag=0,bestCorr=-Infinity;
  for(let lag=minLag;lag<=maxLag;lag++){
    let s=0; for(let i=0;i+lag<c.length;i++) s+=c[i]*c[i+lag];
    if(s>bestCorr){ bestCorr=s; bestLag=lag; } }
  const rate=bestLag>0? envSr/bestLag : 0;
  const envMax=Math.max(...env)||1;
  const lowFrac=env.filter(v=>v<envMax*0.3).length/env.length;
  return { rate, onOff: lowFrac>0.12 && lowFrac<0.88 };
}
// DTMF: жёсткая проверка по 8 стандартным частотам — если есть ровно один
// «строчный» и один «столбцовый» тон одновременно, это почти наверняка DTMF.
const SIGID_DTMF_R=[697,770,852,941], SIGID_DTMF_C=[1209,1336,1477,1633];
function sigidDtmfCheck(x,sr){
  const N=Math.min(x.length,Math.round(sr*0.1));
  function goertzel(f){
    const w=2*Math.PI*f/sr, c=2*Math.cos(w); let s0=0,s1=0,s2=0;
    for(let i=0;i<N;i++){ s0=x[i]+c*s1-s2; s2=s1; s1=s0; }
    return s1*s1+s2*s2-c*s1*s2;
  }
  const rowE=SIGID_DTMF_R.map(goertzel), colE=SIGID_DTMF_C.map(goertzel);
  const rMax=Math.max(...rowE), cMax=Math.max(...colE), tot=rMax+cMax;
  const rOther=rowE.slice().sort((a,b)=>b-a)[1]||0, cOther=colE.slice().sort((a,b)=>b-a)[1]||0;
  const active = tot>1 && rMax>rOther*4 && cMax>cOther*4 && Math.min(rMax,cMax)>Math.max(rMax,cMax)*0.15;
  return { active, row:SIGID_DTMF_R[rowE.indexOf(rMax)], col:SIGID_DTMF_C[colE.indexOf(cMax)] };
}

// Анализ ОДНОГО широкого кластера сам по себе — раньше это делалось только
// когда кластер был единственным; если их несколько (типичная картина в
// загруженном КВ-диапазоне — FT8 сразу в нескольких слотах полосы), каждый
// разбирался отдельно, что и привело к неверной догадке «просто много несущих».
function sigidAnalyzeOne(w,tight,sqBands,keying,mag,sr,N){
  const bw=w.freqHi-w.freqLo;
  const sq=bw>40 && sqBands.find(b=>Math.abs(b.centroid-2*w.centroid)<w.centroid*.08 && (b.freqHi-b.freqLo)<bw*.5);
  const sub=tight.filter(t=>t.centroid>=w.freqLo-5&&t.centroid<=w.freqHi+5).length;
  const flat=sigidFlatness(mag,sr,N,w.freqLo,w.freqHi);
  if(sq) return {name:'BPSK (±180° phase, carrier suppressed)', conf:.6,
    note:'carrier ~'+w.centroid.toFixed(0)+' Hz (narrow peak at 2× frequency after squaring — a reliable sign of phase keying)'};
  if(keying.onOff)
    return {name:'Morse (CW)', conf:.7, note:'tone '+w.centroid.toFixed(0)+' Hz, on/off keying (dots/dashes — speed not fixed)'};
  // FT8/FT4/JT65/WSPR — тоже MFSK, но полоса на порядок ýже, чем у Olivia/Contestia
  // (десятки Гц против сотен-тысяч) — это и есть их главная спектральная примета.
  // Проверяется ПОСЛЕ манипуляции вкл/выкл: в отличие от Морзе, здесь несущая светит
  // непрерывно весь слот, а по ширине узкий CW-тон и FT8-слот на глаз спектра похожи.
  if(bw>12 && bw<=80)
    return {name:'FT8/FT4/JT65/WSPR-like (narrowband weak-signal MFSK)', conf:.5,
      note:'bandwidth only ~'+bw.toFixed(0)+' Hz around '+w.centroid.toFixed(0)+' Hz — characteristic width for this family, try ft8Rx'};
  if(bw>80 && (sub>=3 || flat>.45))
    return {name:'MFSK family (Olivia/Contestia/similar)', conf: sub>=3? .55:.4,
      note:'bandwidth ~'+bw.toFixed(0)+' Hz around '+w.centroid.toFixed(0)+' Hz'+(sub>=3?', '+sub+' tones inside':', energy is spread out — looks like several tones at once')};
  return {name:'Unmodulated carrier / AM / narrowband SSB', conf:.3, note:'frequency ~'+w.centroid.toFixed(0)+' Hz'};
}

function sigidClassify(feat){
  const {tight,wide,keying,dtmf,sqBands,mag,sr,N} = feat, out=[];
  if(dtmf.active) out.push({name:'DTMF', conf:.9, note:'row '+dtmf.row+' Hz / column '+dtmf.col+' Hz'});
  if(!wide.length){ out.push({name:'no signal visible (silence/noise)', conf:0}); return out; }
  // гипотеза «ровно 2 кластера — это на самом деле пара тонов ОДНОЙ 2-FSK передачи»,
  // а не два независимых сигнала — только в разумном для сдвига FSK диапазоне
  if(wide.length===2){
    const shift=Math.abs(wide[1].centroid-wide[0].centroid);
    if(shift>=50 && shift<=1200){
      if(keying.rate>500)
        out.push({name:'Packet/AFSK (Bell202-like)', conf:.5,
          note:'tones '+wide[0].centroid.toFixed(0)+'/'+wide[1].centroid.toFixed(0)+' Hz, shift '+shift.toFixed(0)+' Hz, est. ~'+keying.rate.toFixed(0)+' baud'});
      else
        out.push({name:'RTTY / 2-FSK', conf:.55,
          note:'tones '+wide[0].centroid.toFixed(0)+'/'+wide[1].centroid.toFixed(0)+' Hz, shift '+shift.toFixed(0)+' Hz, est. ~'+keying.rate.toFixed(1)+' baud'});
    }
  }
  // и в любом случае — независимая догадка по каждому кластеру (если их несколько,
  // это отдельные сигналы рядом в полосе, а не обязательно одна передача)
  const many=wide.length>1;
  wide.slice(0,6).forEach((w,i)=>{
    const g=sigidAnalyzeOne(w,tight,sqBands,keying,mag,sr,N);
    out.push({ name:g.name, conf: many? g.conf*0.85 : g.conf,
      note:(many? 'cluster '+(i+1)+' ('+w.centroid.toFixed(0)+' Hz): ':'')+g.note });
  });
  out.sort((a,b)=>b.conf-a.conf);
  return out;
}

def({ id:'sigid', title:'Signal Type Identifier', cat:'Analysis', readout:true, tall:true,
  ins:[{n:'in',t:'sig'}],
  params:[{n:'fftSize',t:'select',opts:['2048','4096','8192','16384'],d:'8192'},
          {n:'period',t:'range',min:.5,max:5,step:.5,d:2,label:'analysis period, s'}],
  init:n=>{n.buf=null;n.bi=0;n.text='accumulating...';n.last=0;},
  process(n,I){
    const need=Math.round(Eng.sr*n.p.period);
    if(!n.buf || n.buf.length!==need){ n.buf=new Float32Array(need); n.bi=0; }
    for(let i=0;i<BLOCK;i++){ n.buf[n.bi]=I.in?I.in[i]:0; n.bi=(n.bi+1)%n.buf.length; n.last++; }
    if(n.last<n.buf.length) return {};                 // ждём первое полное накопление
    n.last=0;
    const N=+n.p.fftSize, nFrames=Math.max(1,Math.floor(n.buf.length/N));
    const win=sigidHann(N);
    const mag=sigidAvgSpectrum(n.buf,N,nFrames,win);
    const tight=sigidBands(mag,Eng.sr,N,.1,8);
    const wide=sigidBands(mag,Eng.sr,N,.15,80);
    const sq=new Float32Array(n.buf.length); for(let i=0;i<sq.length;i++) sq[i]=n.buf[i]*n.buf[i];
    const magSq=sigidAvgSpectrum(sq,N,nFrames,win);
    const sqBands=sigidBands(magSq,Eng.sr,N,.2,60);
    const keying=sigidEnvelopeRate(n.buf,Eng.sr);
    const dtmf=sigidDtmfCheck(n.buf,Eng.sr);
    const guesses=sigidClassify({tight,wide,keying,dtmf,sqBands,mag,sr:Eng.sr,N});
    n.text=guesses.map((g,i)=>(i+1)+'. '+g.name+' ('+Math.round(g.conf*100)+'%)'+(g.note?'\n   '+g.note:'')).join('\n');
    return {}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text; }});
