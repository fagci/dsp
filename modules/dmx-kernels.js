"use strict";
/* ============================ DMX512: ядро ============================
   Enttec DMX USB Pro и совместимые (DMXKing, клоны): кадр 0x7E, метка, длина (LE, 2 байта), данные, 0xE7. Метка 6 — вывод DMX:
   данные = стартовый код 0 + до 512 каналов. Без DOM и сети — проверяется отдельно. */

const DMX_CH=512;
function dmxEnttecFrame(chans,label=6){
  const n=chans.length, len=label===6 ? n+1 : n, o=new Uint8Array(len+5);
  o[0]=0x7E; o[1]=label; o[2]=len&255; o[3]=len>>8;
  if(label===6){ o[4]=0; o.set(chans,5); } else o.set(chans,4);
  o[o.length-1]=0xE7; return o;
}
// «1=255 5-8=128, 12=0» → [{from,to,v}]; каналы 1…512, значения 0…255 (округляются и ограничиваются); мусорные части пропускаются
function dmxParse(text){
  const out=[];
  for(const tok of String(text||'').split(/[\s,;]+/)){
    const m=/^(\d{1,3})(?:-(\d{1,3}))?=(-?\d+(?:\.\d+)?)$/.exec(tok); if(!m) continue;
    let a=+m[1], b=m[2]!==undefined ? +m[2] : a;
    if(a<1 || b<1 || a>DMX_CH || b>DMX_CH) continue;
    if(b<a) [a,b]=[b,a];
    out.push({from:a,to:b,v:Math.max(0,Math.min(255,Math.round(+m[3])))});
  }
  return out;
}
const dmxClamp=(v,scale)=>Math.max(0,Math.min(255,Math.round(scale==='0–1' ? v*255 : v)));
