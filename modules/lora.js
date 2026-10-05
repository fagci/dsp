"use strict";
/* ============================ LoRa ============================
   LoRa Decoder (ядро в lora-kernels.js): IQ → ФНЧ → де-чирп + БПФ → преамбула, синхрослово, SFD → заголовок, Хэмминг, перемежение,
   Грей, белая последовательность, CRC → записи и текст нагрузки. LoRa Modulator делает обратное: текст или hex → IQ. */

const LORA_BWS=['7800','10400','15600','20800','31250','41700','62500','125000','250000','500000'];
const LORA_CRS=['4/5','4/6','4/7','4/8'];

defIQ({ id:'loraRx', title:'LoRa Decoder', kw:'lora chirp spread spectrum css lorawan meshtastic sx127x sx126x', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'}],
  params:[{n:'sf',t:'select',opts:['7','8','9','10','11','12'],d:'7',label:'spreading factor'},
          {n:'bw',t:'select',opts:LORA_BWS,d:'125000',label:'bandwidth, Hz'},
          {n:'sync',t:'text',d:'any',label:'sync word, hex (any = every one; LoRaWAN 34, private 12, Meshtastic 2B)'},
          {n:'hdr',t:'select',opts:['explicit','implicit'],d:'explicit',label:'header'},
          {n:'ldro',t:'select',opts:['auto','on','off'],d:'auto',label:'low data rate optimization (auto: symbol longer than 16 ms)'},
          {n:'len',t:'range',min:1,max:255,step:1,d:16,label:'implicit header: payload length, bytes'},
          {n:'cr',t:'select',opts:LORA_CRS,d:'4/5',label:'implicit header: coding rate'},
          {n:'crc',t:'check',d:true,label:'implicit header: payload CRC present'},
          {n:'thr',t:'range',min:3,max:20,step:1,d:9,label:'preamble detection threshold, dB'},
          {n:'bad',t:'check',d:true,label:'log frames with CRC errors too'},
          {n:'invert',t:'check',d:false,label:'inverted IQ (LoRaWAN downlinks)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input'; if(u.err) return u.err;
    const head='SF'+u.sf+' · '+u.bw/1000+' kHz · '+(u.sr/1000).toFixed(0)+' kS/s · '+u.state+' · '+u.frames+' frames ('+u.ok+' ok, '+u.bad+' CRC errors, '+u.hdrBad+' bad headers)'+
      (u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno frames yet'); });

// LoRa на передачу: текст (вход text, поле msg с {n} — номер кадра) или hex → IQ. Кадр уходит по фронту go, кнопке Send, по смене входа text
// (auto) или каждые every секунд. Между кадрами — тишина (и шум, если задан). Выход tx = 1, пока идёт кадр (на вход tx HackRF TX).
def({ id:'loraTx', title:'LoRa Modulator', cat:'Protocols', kw:'lora chirp spread spectrum css transmit tx modulator frame', readout:true, tall:true,
  ins:[{n:'text',t:'txt'},{n:'go',t:'num'}], outs:[{n:'iq',t:'iq'},{n:'tx',t:'num'}],
  params:[{n:'sr',t:'select',opts:IQ_SR_OPTS,d:'250000',label:'sample rate'},
          {n:'fc',t:'num',d:868100000,label:'center frequency, Hz'},
          {n:'sf',t:'select',opts:['7','8','9','10','11','12'],d:'7',label:'spreading factor'},
          {n:'bw',t:'select',opts:LORA_BWS,d:'125000',label:'bandwidth, Hz'},
          {n:'cr',t:'select',opts:LORA_CRS,d:'4/5',label:'coding rate'},
          {n:'crc',t:'check',d:true,label:'payload CRC'},
          {n:'hdr',t:'select',opts:['explicit','implicit'],d:'explicit',label:'header'},
          {n:'ldro',t:'select',opts:['auto','on','off'],d:'auto',label:'low data rate optimization'},
          {n:'sync',t:'text',d:'34',label:'sync word, hex (LoRaWAN 34, private 12, Meshtastic 2B)'},
          {n:'pre',t:'range',min:6,max:32,step:1,d:8,label:'preamble, symbols'},
          {n:'msg',t:'text',d:'Hello LoRa #{n}',label:'message (if the text input is empty); {n} — frame number'},
          {n:'fmt',t:'select',opts:['text','hex'],d:'text',label:'message format'},
          {n:'auto',t:'check',d:false,label:'send when the text input changes'},
          {n:'every',t:'range',min:0,max:60,step:.5,d:0,label:'repeat every, s (0 = off)'},
          {n:'off',t:'range',min:-100000,max:100000,step:100,d:0,label:'frequency offset from center, Hz'},
          {n:'ppm',t:'range',min:-100,max:100,step:1,d:0,label:'clock error, ppm'},
          {n:'lvl',t:'range',min:-100,max:0,step:1,d:-20,label:'signal level, dBFS'},
          {n:'noise',t:'range',min:-120,max:0,step:1,d:-120,label:'noise, dBFS'},
          {n:'invert',t:'check',d:false,label:'inverted IQ'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.send=true; }}],
  init:n=>{ n.g=null; n.q=[]; n.acc=0; n.cnt=0; n.prevGo=0; n.send=false; n.lastIn=null; n.t=0; n.tNext=0; n.rng=0x9e3779b9; n.gap=0; n.info='ready'; },
  process(n,I){
    const P=n.p, sr=+P.sr, st=iqStream(n,'iq',sr,+P.fc||0);
    n.acc+=sr*BLOCK/Eng.sr;
    const N=Math.floor(n.acc); n.acc-=N;
    const go=I.go||0, trig=go>.5 && !n.prevGo; n.prevGo=go>.5;
    const inText=typeof I.text==='string' && I.text ? I.text : null;
    let want=trig || n.send; n.send=false;
    if(inText!==null && inText!==n.lastIn){ n.lastIn=inText; if(P.auto) want=true; }
    if(+P.every>0 && n.t>=n.tNext){ want=true; n.tNext=n.t+ +P.every; }
    if(want && n.q.length<8) loraTxQueue(n,inText!==null ? inText : P.msg);
    n.t+=N/sr;
    if(N<=0) return {iq:st, tx:n.g ? 1 : 0};
    const re=new Float32Array(N), im=new Float32Array(N);
    let pos=0;
    while(pos<N){
      if(!n.g){
        if(n.gap>0){ const c=Math.min(n.gap,N-pos); n.gap-=c; pos+=c; continue; }
        if(!n.q.length) break;
        n.g=n.q.shift();
      }
      const c=loraGenRun(n.g,re,im,pos,N,sr);
      pos+=c;
      if(pos<N){ n.g=null; n.gap=Math.round(.02*sr); }
    }
    const nz=Math.pow(10,P.noise/20)/Math.SQRT2;
    if(P.noise>-119){
      let x=n.rng; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
      for(let i=0;i<N;i++){ const u=Math.max(rnd(),1e-12), r=nz*Math.sqrt(-2*Math.log(u)), a=2*Math.PI*rnd(); re[i]+=r*Math.cos(a); im[i]+=r*Math.sin(a); }
      n.rng=x;
    }
    iqPush(st,re,im);
    return {iq:st, tx:n.g ? 1 : 0}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.info; }});

function loraTxQueue(n,text){
  const P=n.p, sf=+P.sf, bw=+P.bw, cr=+P.cr.slice(2)-4;
  text=String(text).replace(/\{n\}/g,n.cnt+1);
  let b;
  if(P.fmt==='hex'){ const h=text.replace(/[^0-9a-f]/gi,''); b=Uint8Array.from((h.match(/../g)||[]).map(x=>parseInt(x,16))); }
  else b=loraBytes(text);
  if(!b.length){ n.info='empty message'; return; }
  b=b.slice(0,255);
  const ld=loraLdro(P.ldro,sf,bw), ih=P.hdr==='implicit';
  const syms=loraEncode(b,{sf,cr,crc:!!P.crc,ih,ldro:ld});
  const sw=parseInt(P.sync,16);
  const segs=loraSegs(syms,{sf,pre:P.pre|0,sync:isNaN(sw) ? 0x12 : sw&255});
  n.q.push(loraGenNew(segs,{sf,bw,amp:Math.pow(10,P.lvl/20),cfo:+P.off||0,ppm:+P.ppm||0,invert:!!P.invert}));
  n.cnt++;
  const air=((P.pre|0)+4.25+syms.length)*(1<<sf)/bw;
  n.info='frame #'+n.cnt+' · SF'+sf+' '+bw/1000+' kHz '+P.cr+' · '+b.length+' B · '+syms.length+' symbols · airtime '+(air*1000).toFixed(0)+' ms'+(ih ? '\nimplicit header: set length, CR and CRC in the decoder by hand' : '')+'\n"'+text.slice(0,120)+'"';
}
