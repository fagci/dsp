"use strict";
/* ============================ VLC Source: ядро (без DOM) ============================
   libVLC приложения (VlcHub.kt) декодирует любой адрес и шлёт звук сырым PCM s16le по UDP на 127.0.0.1:порт; страница получает датаграммы
   (hex) через мост и собирает из них кадры. Датаграммы режутся libVLC как придётся, поэтому хвост, не составивший целый кадр, переходит в следующую. */

// порт страницы для приёма (40000…59999)
const vlsPort=(rand=Math.random)=>40000+Math.min(19999,Math.floor(rand()*20000));
function vlsBytes(hex){
  if(typeof hex!=='string' || hex.length%2 || /[^0-9a-f]/i.test(hex)) return null;
  const b=new Uint8Array(hex.length>>1);
  for(let i=0;i<b.length;i++) b[i]=parseInt(hex.substr(i*2,2),16);
  return b;
}
const vlsNew=ch=>({ch:ch===1 ? 1 : 2, rem:new Uint8Array(0), frames:0});
// датаграмма (hex) → Float32Array кадров (каналы подряд: L,R,L,R… или M,M…), null — не hex; хвост хранится в st.rem
function vlsFeed(st,hex){
  let b=vlsBytes(hex); if(!b) return null;
  if(st.rem.length){ const c=new Uint8Array(st.rem.length+b.length); c.set(st.rem); c.set(b,st.rem.length); b=c; }
  const fb=2*st.ch, n=b.length-b.length%fb;
  st.rem=b.slice(n);
  const out=new Float32Array(n>>1);
  for(let i=0;i<out.length;i++){ let v=b[2*i]|(b[2*i+1]<<8); if(v&0x8000) v-=0x10000; out[i]=v/32768; }
  st.frames+=out.length/st.ch;
  return out;
}
// запрос частоты: «graph» — частота графа
const vlsRate=(sel,graphRate)=>{ const r=+sel; return r>0 ? r : (graphRate>0 ? Math.round(graphRate) : 48000); };
// метаданные: секунды из миллисекунд приложения
const vlsSec=ms=>ms>0 ? ms/1000 : 0;
