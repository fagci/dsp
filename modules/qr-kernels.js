"use strict";
/* ============================ QR: ядро ============================
   Без DOM: матрица модулей → пиксели. Кодирование и разбор самого QR — vendor/qrcode.min.js и vendor/jsqr.min.js.
   Проверяется tools/test-qr.mjs. */

// matrix[y][x] truthy — тёмный модуль; scale — пикселей на модуль, quiet — белая рамка в модулях. Возвращает RGBA
function qrRender(matrix,scale=6,quiet=4){
  const n=matrix.length, s=Math.max(1,scale|0), W=(n+2*quiet)*s, d=new Uint8ClampedArray(W*W*4).fill(255);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) if(matrix[y][x]){
    for(let j=0;j<s;j++){ let o=((((y+quiet)*s+j)*W)+(x+quiet)*s)*4; for(let i=0;i<s;i++,o+=4) d[o]=d[o+1]=d[o+2]=0; }
  }
  return {w:W,h:W,data:d};
}
