"use strict";
/* ============================ LOGIC ANALYZER ============================ */
// До 8 каналов с порогом и гистерезисом → цифровые дорожки на общей оси времени, запуск по фронту,
// декодеры UART / SPI / I²C с байтами на выходе. Вход — сигнальные провода (частота = Eng.sr: годится
// для UART до ~10 кБод, I²C/SPI до ~10 кГц) или числовые (один отсчёт на блок, ~Eng.sr/BLOCK Гц —
// медленные дискретные сигналы: лампы, триггеры, флип-флопы).
// Дорожки хранятся списком фронтов, а не отсчётов — окно в 10 с на 44 кГц ничего не стоит.

const LA_KEEP=20;                                   // сколько секунд фронтов помним
const LA_COLORS=['--t-blk','--acc','--acc2','--t-img','--t-spec','--t-trk','--err','--t-iq'];
const laNum=n=>n.p.src==='number';
const laUsb=n=>n.p.src==='USB';                      // отсчёты из USB-логического анализатора (logicusb.js), частота — своя
const laCount=n=>+n.p.count||4;
const laType=n=>laNum(n) || laUsb(n) ? 'num' : 'sig';
const laRate=n=>laNum(n) ? Eng.sr/BLOCK : laUsb(n) ? lusbRate(n) : Eng.sr;
function laRewire(n,all){                           // убрать провода к исчезнувшим портам (all — сменился тип портов)
  const vi=new Set(portsOf(n,'ins').map(p=>p.n)), vo=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>e.to===n.id ? all || !vi.has(e.tp) : e.from===n.id && (all || !vo.has(e.fp))).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
const laHex=(v,bits)=>v.toString(16).toUpperCase().padStart(Math.ceil(bits/4),'0');
const laFmtT=s=>{ const a=Math.abs(s);
  return a>=1 ? +s.toFixed(3)+' s' : a>=1e-3 ? +(s*1e3).toFixed(3)+' ms' : +(s*1e6).toFixed(1)+' µs'; };

function laReset(n){
  const N=laCount(n);
  n.lv=Array(N).fill(0); n.eT=Array.from({length:N},()=>[]); n.eV=Array.from({length:N},()=>[]); n.eH=Array(N).fill(0);
  n.si=0; n.ann=[]; n.dec={}; n.trigAt=null; n.pend=null; n.armed=true; n.hold=null; n.tprev=0;
  n.line=''; n.lineT=0; n.textOut=''; n.nbytes=0; n.nerr=0; n.nlines=0; n.byte=0; n.last='';
}
function laEmit(n,k,t0,t1,byte,bits,o={}){         // k — канал дорожки, [t0,t1] — отсчёты, o: err, label, rec-поля
  const rate=laRate(n);
  n.recs.push({proto:n.p.proto, t:Date.now(), time:+(t0/rate).toFixed(6), ch:k+1, byte, hex:laHex(byte,bits), ...o.rec,
               ...(o.err ? {err:o.err} : {})});
  n.ann.push({k, a:t0, b:t1, s:o.label ?? laHex(byte,bits), c:o.chr||'', err:!!o.err});
  if(n.ann.length>3000) n.ann.splice(0,500);
  n.nbytes++; if(o.err) n.nerr++;
  n.byte=byte; n.newv=1; n.lastT=n.si;
}
function laFlush(n){
  if(!n.line) return;
  n.textOut=n.line; n.last=n.line; n.line=''; n.nlines++;
}
function laChar(n,c){
  if(c===10){ laFlush(n); return; }
  if(c===13) return;
  n.line+=c>=32 && c<127 ? String.fromCharCode(c) : '·';
  if(n.line.length>=80) laFlush(n);
}
const laWord=(w,cnt,bit,msb)=>msb ? (w<<1|bit) : (w|bit<<cnt);

function laUart(n,dig,L,rate){
  const p=n.p, a=dig[p.a-1]; if(!a) return;
  const D=n.dec, bits=+p.bits, par=p.parity!=='none' ? 1 : 0, spb=rate/Math.max(1,+p.baud);
  const idle=p.idle==='low' ? 0 : 1, msb=p.order==='MSB';
  if(D.st===undefined){ D.st=0; D.prev=1; }
  for(let i=0;i<L;i++){
    const v=a[i]^(idle ? 0 : 1), t=n.si+i;
    if(D.st===0){
      if(D.prev===1 && v===0){ D.st=1; D.t0=t; D.k=-1; D.next=t+spb*.5; D.w=0; D.pb=0; D.ones=0; }
    } else if(t>=D.next){
      if(D.k===-1){ if(v!==0) D.st=0; else { D.k=0; D.next=D.t0+spb*1.5; } }
      else if(D.k<bits){ D.w=laWord(D.w,D.k,v,msb); D.ones+=v; D.k++; D.next=D.t0+spb*(D.k+1.5); }
      else if(par && D.k===bits){ D.pb=v; D.k++; D.next=D.t0+spb*(D.k+1.5); }
      else {                                          // стоп-бит — собираем байт
        const w=bits<32 ? D.w & ((1<<bits)-1) : D.w;
        let err='';
        if(v!==1) err='framing';
        else if(par && ((D.ones+D.pb)&1)!==(p.parity==='even' ? 0 : 1)) err='parity';
        laEmit(n,p.a-1,D.t0,D.t0+spb*(bits+par+2),w,bits,{err, chr:w>=32 && w<127 ? String.fromCharCode(w) : ''});
        if(!err) laChar(n,w);
        D.st=0;
      }
    }
    D.prev=v;
  }
}
function laSpi(n,dig,L){
  const p=n.p, clk=dig[p.a-1], d1=p.b>0 ? dig[p.b-1] : null, d2=p.c>0 ? dig[p.c-1] : null, cs=p.cs>0 ? dig[p.cs-1] : null;
  if(!clk) return;
  const D=n.dec, bits=+p.bits, msb=p.order!=='LSB', fall=p.edge==='falling';
  if(D.cp===undefined){ D.cp=clk[0]; D.csp=1; D.cnt=0; D.w1=0; D.w2=0; D.l1=[]; D.l2=[]; }
  const flush=()=>{ if(D.l1.length||D.l2.length){
      n.line=(D.l1.length ? 'MOSI '+D.l1.join(' ') : '')+(D.l2.length ? (D.l1.length ? ' | ' : '')+'MISO '+D.l2.join(' ') : '');
      laFlush(n); D.l1=[]; D.l2=[]; } };
  for(let i=0;i<L;i++){
    const t=n.si+i, c=clk[i], csv=cs ? cs[i] : 0;
    if(cs && D.csp===0 && csv===1) flush();
    if(cs && D.csp===1 && csv===0){ D.cnt=0; D.w1=D.w2=0; }
    D.csp=csv;
    const edge=fall ? D.cp===1 && c===0 : D.cp===0 && c===1;
    if(edge && csv===0){
      if(D.cnt===0) D.t0=t;
      if(d1) D.w1=laWord(D.w1,D.cnt,d1[i],msb);
      if(d2) D.w2=laWord(D.w2,D.cnt,d2[i],msb);
      if(++D.cnt===bits){
        const m=bits<32 ? (1<<bits)-1 : -1;
        if(d1){ laEmit(n,p.b-1,D.t0,t,D.w1&m,bits,{rec:{line:'mosi'}}); D.l1.push(laHex(D.w1&m,bits)); }
        if(d2){ laEmit(n,p.c-1,D.t0,t,D.w2&m,bits,{rec:{line:'miso'}}); D.l2.push(laHex(D.w2&m,bits)); }
        D.cnt=0; D.w1=D.w2=0;
        if(D.l1.length>=16 || D.l2.length>=16) flush();
      }
    }
    D.cp=c;
  }
  D.flush=flush;
}
function laI2c(n,dig,L){
  const p=n.p, scl=dig[p.a-1], sda=p.b>0 ? dig[p.b-1] : null; if(!scl || !sda) return;
  const D=n.dec;
  if(D.sp===undefined){ D.sp=scl[0]; D.dp=sda[0]; D.on=false; D.cnt=0; D.w=0; D.first=true; D.l=[]; }
  const stop=()=>{ if(D.on && D.l.length){ n.line='S '+D.l.join(' ')+' P'; laFlush(n); } D.on=false; D.l=[]; };
  for(let i=0;i<L;i++){
    const t=n.si+i, c=scl[i], d=sda[i];
    if(D.sp===1 && c===1 && D.dp!==d){
      if(d===0){ stop(); D.on=true; D.cnt=0; D.w=0; D.first=true; D.l=[]; }      // START (в т.ч. повторный)
      else stop();                                                                 // STOP
    } else if(D.sp===0 && c===1 && D.on){
      if(D.cnt===0) D.t0=t;
      if(D.cnt<8){ D.w=D.w<<1|d; D.cnt++; }
      else {                                                                       // 9-й бит: ACK = 0
        const nak=d===1, w=D.w;
        if(D.first){
          D.addr=w>>1; const rw=w&1 ? 'R' : 'W';
          laEmit(n,p.b-1,D.t0,t,w,8,{label:laHex(D.addr,7)+' '+rw, err:nak ? 'nak' : '', rec:{kind:'addr',addr:D.addr,rw}});
          D.l.push(laHex(D.addr,7)+(rw==='R' ? '+R' : '+W')+(nak ? '!' : ''));
          D.first=false;
        } else {
          laEmit(n,p.b-1,D.t0,t,w,8,{err:nak ? 'nak' : '', rec:{kind:'data',addr:D.addr}});
          D.l.push(laHex(w,8)+(nak ? '!' : ''));
        }
        D.cnt=0; D.w=0;
      }
    }
    D.sp=c; D.dp=d;
  }
  D.flush=stop;
}

def({ id:'logan', lazy:'proc', title:'Logic Analyzer', cat:'Analysis',
  ins:n=>laUsb(n) ? [] : Array.from({length:laCount(n)},(_,k)=>({n:'ch'+(k+1),t:laType(n)})),
  outs:n=>[...Array.from({length:laCount(n)},(_,k)=>({n:'d'+(k+1),t:laType(n)})),
           {n:'byte',t:'num'},{n:'new',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'hit',t:'num'}],
  view:{h:170}, resize:true, readout:true, w:440,
  params:[{n:'src',t:'select',opts:['signal','number','USB'],d:'signal',label:'input: wires (signal / number) or a USB logic analyzer (fx2lafw)',fn:n=>{ lusbStop(n); laReset(n); laRewire(n,true); }},
          {n:'count',t:'select',opts:['1','2','3','4','5','6','7','8'],d:'4',label:'channels',fn:n=>{ laReset(n); laRewire(n,false); }},
          {n:'names',t:'text',d:'',label:'channel names (comma separated)'},
          {n:'thr',t:'num',d:.5,label:'threshold'},
          {n:'hys',t:'num',d:.1,label:'hysteresis'},
          {n:'span',t:'range',min:.001,max:10,step:.001,d:.05,log:true,label:'window, s'},
          {n:'trig',t:'select',opts:['off','rising','falling'],d:'off',label:'trigger'},
          {n:'tch',t:'range',min:1,max:8,step:1,d:1,label:'trigger channel'},
          {n:'single',t:'check',d:false,label:'single shot (re-arm with Arm)'},
          {n:'arm',t:'button',label:'Arm',fn:n=>{ n.armed=true; n.trigAt=null; n.pend=null; redraw(n); }},
          {n:'hold',t:'button',label:'Hold / Run',fn:n=>{ n.hold=n.hold==null ? n.si : null; redraw(n); }},
          {n:'proto',t:'select',opts:['none','UART','SPI','I2C'],d:'none',label:'decoder'},
          {n:'a',t:'range',min:1,max:8,step:1,d:1,label:'channel: UART rx / SPI clk / I²C SCL',adv:true},
          {n:'b',t:'range',min:0,max:8,step:1,d:2,label:'channel: SPI MOSI / I²C SDA',adv:true},
          {n:'c',t:'range',min:0,max:8,step:1,d:0,label:'channel: SPI MISO (0 = none)',adv:true},
          {n:'cs',t:'range',min:0,max:8,step:1,d:0,label:'channel: SPI chip select (0 = none, active low)',adv:true},
          {n:'baud',t:'num',d:9600,label:'UART baud',adv:true},
          {n:'bits',t:'range',min:4,max:16,step:1,d:8,label:'word bits (UART / SPI)',adv:true},
          {n:'parity',t:'select',opts:['none','even','odd'],d:'none',label:'UART parity',adv:true},
          {n:'idle',t:'select',opts:['high','low'],d:'high',label:'UART idle level',adv:true},
          {n:'order',t:'select',opts:['auto','LSB','MSB'],d:'auto',label:'bit order (auto: UART LSB first, SPI MSB first)',adv:true},
          {n:'edge',t:'select',opts:['rising','falling'],d:'rising',label:'SPI sampling clock edge',adv:true},
          {n:'clr',t:'button',label:'Clear decoded',fn:n=>{ n.ann=[]; n.nbytes=n.nerr=n.nlines=0; n.last=''; n.dec={}; redraw(n); }},
          {n:'urate',t:'select',opts:LUSB_RATES.map(r=>r[0]),d:'1 MHz',label:'USB: sample rate (D0…D7 = channels 1…8)',adv:true,fn:n=>{ if(n.usbRun) lusbStart(n); }},
          {n:'uconn',t:'button',label:'USB: connect',fn:n=>lusbConnect(n),adv:true},
          {n:'ufw',t:'button',label:'USB: load firmware (.fw)',fn:n=>lusbFirmware(n),adv:true},
          {n:'ustart',t:'button',label:'USB: start',fn:n=>lusbStart(n),adv:true},
          {n:'ustop',t:'button',label:'USB: stop',fn:n=>lusbStop(n),adv:true}],
  init:n=>{ laReset(n); n.rk=''; n.dk=''; n.recs=[]; n.newv=0; n.lastT=0; n.dout=[]; n.dig=[]; lusbInit(n); },
  dispose:n=>{ lusbDispose(n); },
  process(n,I){
    const p=n.p, N=laCount(n), num=laNum(n), usb=laUsb(n), rate=laRate(n), S=usb ? lusbTake(n) : null, L=num ? 1 : usb ? S.n : BLOCK;
    const rk=rate+'|'+num+'|'+usb+'|'+N; if(rk!==n.rk){ n.rk=rk; laReset(n); }
    const dk=[p.proto,p.a,p.b,p.c,p.cs,p.baud,p.bits,p.parity,p.idle,p.order,p.edge].join('|');
    if(dk!==n.dk){ n.dk=dk; n.dec={}; }
    const thr=+p.thr, h=Math.abs(+p.hys)/2, cut=n.si-LA_KEEP*rate;
    n.recs=[]; n.newv=0;
    for(let k=0;k<N;k++){
      const a=I['ch'+(k+1)], wired=usb || (num ? typeof a==='number' && isFinite(a) : !!a);
      if(!n.dig[k] || (usb ? n.dig[k].length<L : n.dig[k].length!==L)){ n.dig[k]=new Uint8Array(L); n.dout[k]=num || usb ? 0 : new Float32Array(L); }
      const dg=n.dig[k], T=n.eT[k], V=n.eV[k]; let lv=n.lv[k];
      for(let i=0;i<L;i++){
        if(usb) lv=(S.d[i]>>k)&1;
        else if(wired){
          const v=num ? a : a[i];
          if(lv===0 ? v>thr+h : v<thr-h) lv^=1;
          else if(!T.length) lv=v>thr ? 1 : 0;
        }
        dg[i]=lv;
        if(!T.length || V[V.length-1]!==lv){ T.push(n.si+i); V.push(lv); }
        if(!num && !usb) n.dout[k][i]=lv;
      }
      n.lv[k]=lv; if(num || usb) n.dout[k]=lv;
      let hd=n.eH[k]; while(hd+1<T.length && T[hd+1]<cut) hd++;      // старые фронты — за голову, раз в 4096 вырезаем
      if(hd>4096){ T.splice(0,hd); V.splice(0,hd); hd=0; }
      n.eH[k]=hd;
    }
    let hit=0;
    if(p.trig!=='off'){
      const d=n.dig[clamp(Math.round(p.tch),1,N)-1], want=p.trig==='rising' ? 1 : 0, ws=Math.max(2,p.span*rate);
      for(let i=0;i<L;i++){
        const t=n.si+i;
        if(n.pend!=null && t>=n.pend+ws*.75){ n.trigAt=n.pend; n.pend=null; }      // кадр дописан до конца окна — показываем целиком
        if(d[i]===want && n.tprev!==want && n.pend==null && (!p.single || n.armed)){ n.pend=t; hit=1; if(p.single) n.armed=false; }
        n.tprev=d[i];
      }
    }
    if(p.proto==='UART') laUart(n,n.dig,L,rate);
    else if(p.proto==='SPI') laSpi(n,n.dig,L);
    else if(p.proto==='I2C') laI2c(n,n.dig,L);
    n.si+=L;
    if(n.line && n.si-n.lastT>rate) laFlush(n);                          // конец передачи без перевода строки
    if(p.proto==='SPI' && n.dec.flush && n.si-n.lastT>rate*.5) n.dec.flush();
    const o={byte:n.byte, new:n.newv, text:n.textOut||null, rec:n.recs.length ? n.recs : null, hit};
    for(let k=0;k<N;k++) o['d'+(k+1)]=n.dout[k];
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, N=laCount(n), p=n.p, rate=laRate(n), LAB=44, AX=13;
    const names=String(p.names||'').split(','), rh=(H-AX)/N, ws=Math.max(2,p.span*rate), pw=W-LAB-2;
    let start;
    if(n.hold!=null) start=n.hold-ws;
    else if(p.trig!=='off') start=n.trigAt!=null ? n.trigAt-ws*.25 : n.si-ws;
    else start=n.si-ws;
    const end=start+ws, X=t=>LAB+(t-start)/ws*pw, lim=Math.min(end,n.si);
    cx.clearRect(0,0,W,H);
    const bound=(T,hd)=>{ let lo=hd, hi=T.length; while(lo<hi){ const m=(lo+hi)>>1; if(T[m]<=start) lo=m+1; else hi=m; } return lo; };
    indFont(cx,Math.min(11,rh*.5)); cx.textBaseline='middle';
    for(let k=0;k<N;k++){
      const y0=k*rh, yh=y0+Math.min(5,rh*.15), yl=y0+rh-Math.min(5,rh*.15), Y=v=>v ? yh : yl;
      const col=themeColor(LA_COLORS[k%LA_COLORS.length]), T=n.eT[k], V=n.eV[k], hd=n.eH[k];
      cx.strokeStyle=themeColor('--grid'); cx.lineWidth=1; cx.beginPath(); cx.moveTo(0,y0+rh-.5); cx.lineTo(W,y0+rh-.5); cx.stroke();
      cx.fillStyle=themeColor('--axis'); cx.textAlign='left';
      cx.fillText((names[k]||'').trim()||'ch'+(k+1),12,y0+rh/2);
      cx.beginPath(); cx.arc(5,y0+rh/2,3,0,7); cx.fillStyle=col; cx.globalAlpha=n.lv[k] ? 1 : .2; cx.fill(); cx.globalAlpha=1;
      if(!T.length || start>=lim) continue;
      let j=bound(T,hd), lvl=j>hd ? V[j-1] : null, x=X(Math.max(start,T[hd]));
      if(lvl===null){ lvl=V[hd]; }
      cx.save(); cx.beginPath(); cx.rect(LAB,y0,pw+2,rh); cx.clip();
      cx.strokeStyle=col; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(x,Y(lvl));
      for(;j<T.length && T[j]<=lim;j++){ const ex=X(T[j]); cx.lineTo(ex,Y(lvl)); lvl=V[j]; cx.lineTo(ex,Y(lvl)); }
      cx.lineTo(X(lim),Y(lvl)); cx.stroke(); cx.restore();
    }
    // аннотации декодера: пузыри с байтами поверх дорожки
    cx.textAlign='center';
    for(const a of n.ann){
      if(a.b<start || a.a>lim) continue;
      const x0=X(a.a), x1=X(a.b), w=x1-x0; if(w<14) continue;
      const y=a.k*rh+rh/2, bh=Math.min(13,rh*.6);
      cx.fillStyle=themeColor('--screen'); cx.globalAlpha=.82; cx.fillRect(x0,y-bh/2,w,bh); cx.globalAlpha=1;
      cx.strokeStyle=themeColor(a.err ? '--err' : '--acc'); cx.lineWidth=1; cx.strokeRect(x0+.5,y-bh/2+.5,w-1,bh-1);
      cx.fillStyle=themeColor(a.err ? '--err' : '--scr-hi');
      const s=a.c && w>a.s.length*7+16 ? a.s+' '+a.c : a.s;
      cx.save(); cx.beginPath(); cx.rect(x0,y-bh/2,w,bh); cx.clip(); cx.fillText(s,(x0+x1)/2,y+1); cx.restore();
    }
    if(p.trig!=='off' && n.trigAt!=null && n.trigAt>=start && n.trigAt<=end){
      const x=X(n.trigAt); cx.strokeStyle=themeColor('--acc'); cx.setLineDash([3,3]); cx.beginPath(); cx.moveTo(x+.5,0); cx.lineTo(x+.5,H-AX); cx.stroke(); cx.setLineDash([]);
    }
    // ось времени: от запуска (или от начала окна)
    const ref=p.trig!=='off' && n.trigAt!=null ? n.trigAt : start;
    cx.fillStyle=themeColor('--axis'); cx.strokeStyle=themeColor('--axis'); cx.textBaseline='alphabetic'; indFont(cx,9);
    for(let i=0;i<=4;i++){ const x=LAB+i*pw/4, t=(start+ws*i/4-ref)/rate;
      cx.beginPath(); cx.moveTo(x+.5,H-AX); cx.lineTo(x+.5,H-AX+3); cx.stroke();
      cx.textAlign=i===0 ? 'left' : i===4 ? 'right' : 'center'; cx.fillText(laFmtT(t),x,H-2); }
    cx.textAlign='start';
    const r=n.el.querySelector('.readout');
    if(r){
      const spb=rate/Math.max(1,+p.baud);
      const us=laUsb(n) ? n.ustat+' · ' : '';
      r.textContent = us+(p.proto==='none' ? (n.hold!=null ? 'hold' : p.trig!=='off' ? (n.trigAt==null ? 'waiting for trigger' : 'triggered') : 'running')
        : p.proto+' · '+n.nbytes+' bytes'+(n.nerr ? ' · '+n.nerr+' errors' : '')+(p.proto==='UART' && spb<3 ? ' · baud too high for this sample rate' : '')+(n.last ? '\n'+n.last.slice(-60) : ''));
    } }
});
