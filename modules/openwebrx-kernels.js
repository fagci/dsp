"use strict";
/* ============================ Ядро клиента OpenWebRX ============================
   Протокол сверен с клиентом jketterl/openwebrx (htdocs/openwebrx.js, lib/AudioEngine.js, lib/Demodulator.js).
   WebSocket ws://host:port/ws/: текст — «CLIENT DE SERVER …» и JSON {type,value}; бинарные кадры — [тип:u8][данные]:
   1 FFT, 2 аудио (int16 LE), 3 вторичный FFT, 4 HD-аудио. Аудио бывает IMA-ADPCM с маркерами «SYNC». Без DOM — tools/test-openwebrx.mjs. */

const OWRX_STEP=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const OWRX_IDX=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

// Декодер IMA-ADPCM с синхронизацией: «SYNC» + int16 stepIndex + int16 predictor, затем 1001 байт данных, по два отсчёта на байт
function owrxAdpcm(){
  const s={step:0,idx:0,pred:0,phase:0,sync:0,buf:[0,0,0,0],bi:0,cnt:0};
  const nib=v=>{
    s.idx=Math.min(88,Math.max(0,s.idx+OWRX_IDX[v]));
    let d=s.step>>3;
    if(v&1) d+=s.step>>2;
    if(v&2) d+=s.step>>1;
    if(v&4) d+=s.step;
    if(v&8) d=-d;
    s.pred=Math.min(32767,Math.max(-32768,s.pred+d));
    s.step=OWRX_STEP[s.idx];
    return s.pred;
  };
  return {
    decode(u8){
      const out=new Int16Array(u8.length*2); let o=0;
      for(let i=0;i<u8.length;i++){
        const b=u8[i];
        if(s.phase===0){
          if(b!==('SYNC').charCodeAt(s.sync++)) s.sync=0;
          if(s.sync===4){ s.bi=0; s.phase=1; }
        }else if(s.phase===1){
          s.buf[s.bi++]=b;
          if(s.bi===4){
            const v=new Int16Array(new Uint8Array(s.buf).buffer);
            s.idx=v[0]; s.pred=v[1]; s.cnt=1000; s.phase=2;
          }
        }else{
          out[o++]=nib(b&15); out[o++]=nib(b>>4);
          if(s.cnt--===0){ s.sync=0; s.phase=0; }
        }
      }
      return out.subarray(0,o);
    },
    reset(){ s.step=s.idx=s.pred=s.phase=s.sync=s.bi=s.cnt=0; }
  };
}

// «host[:port][/path]» или полный URL → {host,port,tls}
function owrxParseAddr(s){
  s=String(s||'').trim();
  const tls=/^(wss|https):\/\//i.test(s);
  s=s.replace(/^[a-z]+:\/\//i,'').replace(/[\/?#].*$/,'');
  const m=s.match(/^(.+):(\d+)$/);
  return m ? {host:m[1],port:+m[2],tls} : {host:s,port:tls?443:8073,tls};
}

// Границы полосы относительно несущей, Гц (low_cut, high_cut)
function owrxPassband(mod,bw){
  bw=Math.max(50,+bw||2700);
  switch(mod){
    case 'usb': return [150,150+bw];
    case 'lsb': return [-150-bw,-150];
    case 'cw':  return [800-bw/2,800+bw/2];
    default:    return [-bw/2,bw/2];
  }
}

// Разбор текстового кадра → событие; null — не интересует
function owrxText(str){
  if(str.startsWith('CLIENT DE SERVER')){
    const p={}; for(const kv of str.slice(17).split(' ')){ const i=kv.indexOf('='); if(i>0) p[kv.slice(0,i)]=kv.slice(i+1); }
    return {type:'hello',server:p.server||'',version:p.version||''};
  }
  let j; try{ j=JSON.parse(str); }catch(e){ return null; }
  if(!j || typeof j.type!=='string') return null;
  return {type:j.type,value:j.value};
}

// Уровень S-метра: сервер шлёт линейную мощность → дБ
const owrxDb=v=>v>0 ? 10*Math.log10(v) : -150;
