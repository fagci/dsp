"use strict";
/* ============================ VLC Out: ядро (без DOM) ============================
   Граф → libVLC приложения (VlcHub.kt, команды vlc.out.*): страница шлёт PCM s16le на loopback (udp.send моста), libVLC кодирует (MP3 / AAC / Opus / FLAC)
   и отдаёт наружу: HTTP-сервер на телефоне, RTP / multicast, Icecast, файл, Chromecast / UPnP. Здесь — упаковка отсчётов и проверка полей. */

const VLO_MODES=['http server','rtp / multicast','icecast','file','chromecast / upnp'];
const VLO_MODE_ID={'http server':'http','rtp / multicast':'rtp','icecast':'icecast','file':'file','chromecast / upnp':'renderer'};
// кодек → какие режимы его принимают (приложение проверяет то же самое)
const VLO_CODEC_MODES={mp3:['http','rtp','icecast','file','renderer'],aac:['http','rtp','file','renderer'],opus:['http','icecast','file','renderer'],flac:['http','file','renderer']};
const vloCodecOk=(codec,mode)=>!!(VLO_CODEC_MODES[codec] && VLO_CODEC_MODES[codec].includes(mode));

// накопитель: 20 мс кадров → одна датаграмма (hex s16le); ch — число каналов (1 или 2)
const vloNew=(ch,rate)=>({ch:ch===1 ? 1 : 2, chunk:Math.max(64,Math.round((rate>0 ? rate : 48000)/50)), buf:new Int16Array(0), n:0, sent:0});
function vloClip(x){ x=x*32767; return x>32767 ? 32767 : x<-32768 ? -32768 : Math.round(x); }
// блок отсчётов (L, R — Float32Array или null; один канал → дублируется) → массив готовых hex-датаграмм (по chunk кадров)
const VLO_HEX=(()=>{ const t=[]; for(let i=0;i<256;i++) t.push((i<16 ? '0' : '')+i.toString(16)); return t; })();
function vloPack(st,L,R){
  const src=L||R; if(!src) return [];
  const len=src.length, out=[], need=st.chunk*st.ch;
  if(st.buf.length!==need){ st.buf=new Int16Array(need); st.n=0; }
  const a=L||R, b=R||L;
  for(let i=0;i<len;i++){
    if(st.ch===1) st.buf[st.n++]=vloClip((a[i]+b[i])*.5);
    else { st.buf[st.n++]=vloClip(a[i]); st.buf[st.n++]=vloClip(b[i]); }
    if(st.n===need){
      let h=''; const u=new Uint8Array(st.buf.buffer);
      for(let k=0;k<u.length;k++) h+=VLO_HEX[u[k]];
      out.push(h); st.n=0; st.sent+=st.chunk;
    }
  }
  return out;
}
// параметры узла → аргументы vlc.out.open (ошибка — строка)
function vloArgs(p,pass,rate){
  const mode=VLO_MODE_ID[p.mode]; if(!mode) return 'choose a mode';
  const codec=String(p.codec||'mp3'); if(!vloCodecOk(codec,mode)) return codec+' does not fit «'+p.mode+'» (rtp: mp3, aac; icecast: mp3, opus; http / file / chromecast: any)';
  const a={mode,codec,bitrate:+p.bitrate||128,rate:Math.round(rate)||48000,outrate:+p.outrate||48000,channels:p.channels==='mono' ? 1 : 2,caching:+p.caching||300,ttl:+p.ttl||4};
  const port=Math.round(+p.port||0), host=String(p.host||'').trim();
  if(mode==='http'){ if(!(port>=1024 && port<=65535)) return 'port: 1024…65535'; a.port=port; a.mount=String(p.path||'dsp').trim()||'dsp'; }
  else if(mode==='rtp'){ if(!host) return 'enter the address (a multicast group 239.x.x.x or a host)'; if(!(port>=1 && port<=65535)) return 'port: 1…65535'; a.host=host; a.port=port; }
  else if(mode==='icecast'){
    if(!host) return 'enter the Icecast server'; if(!(port>=1 && port<=65535)) return 'port: 1…65535';
    if(!pass) return 'the password comes to the «pass» pin (it is not stored in the patch)';
    a.host=host; a.port=port; a.mount=String(p.path||'dsp').trim()||'dsp'; a.user=String(p.user||'source').trim()||'source'; a.pass=String(pass);
  }
  else if(mode==='file'){ a.name=String(p.path||'dsp').trim()||'dsp'; }
  else { a.renderer=String(p.device||'').trim(); if(!a.renderer) return 'enter the device name (the «Find devices» button shows them)'; }
  return a;
}
// «Find devices»: ответ приложения → строка для статуса
const vloDevices=names=>Array.isArray(names) && names.length ? names.join(' · ') : 'none found (the same Wi-Fi network? Chromecast / UPnP / DLNA)';
