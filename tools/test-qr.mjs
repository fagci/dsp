// QR: node tools/test-qr.mjs — генератор (vendor/qrcode.min.js) → пиксели (qr-kernels.js) → чтение (vendor/jsqr.min.js)
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({Math,JSON,Map,Set,Promise,Uint8Array,Uint8ClampedArray,String,Array,Object,crypto,console,Infinity,TextDecoder,TextEncoder});
vm.runInContext(rd('vendor/qrcode.min.js')+';'+rd('vendor/jsqr.min.js')+';'+rd('modules/sync-kernels.js')+';'+rd('modules/qr-kernels.js')+';this.K={qrcode,jsQR,qrRender,syKeyFromText,syKeyGen};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

function roundTrip(text,ecc='M',scale=6,invert=false){
  const q=K.qrcode; q.stringToBytes=q.stringToBytesFuncs['UTF-8'];
  const c=q(0,ecc); c.addData(text,'Byte'); c.make();
  const n=c.getModuleCount(), m=[]; for(let y=0;y<n;y++){ const r=[]; for(let x=0;x<n;x++) r.push(c.isDark(y,x)); m.push(r); }
  const r=K.qrRender(m,scale,4);
  if(invert) for(let i=0;i<r.data.length;i+=4){ r.data[i]=r.data[i+1]=r.data[i+2]=255-r.data[i]; }
  const res=K.jsQR(r.data,r.w,r.h,{inversionAttempts:'attemptBoth'});
  return {res,w:r.w,n};
}
const key=K.syKeyGen(), link='https://fagci.github.io/dsp/#sync='+key;
for(const [name,t] of [['key',key],['link',link],['short','hi'],['unicode','Привет, мир — 你好 ✓'],['long',('abcdefghij'.repeat(100))]]){
  const r=roundTrip(t); ok('round trip: '+name+' ('+t.length+' chars, '+r.n+' modules)',r.res && r.res.data===t);
}
for(const e of ['L','M','Q','H']) ok('ecc '+e,roundTrip(link,e).res?.data===link);
ok('scale 2',roundTrip(link,'M',2).res?.data===link);
ok('scale 12',roundTrip(link,'M',12).res?.data===link);
ok('inverted colours are read',roundTrip(link,'M',6,true).res?.data===link);
const r1=roundTrip(key); ok('image size = (modules + 2·4) · scale',r1.w===(r1.n+8)*6);

ok('key from a link',K.syKeyFromText(link)===key);
ok('key from the key itself',K.syKeyFromText(key)===key);
ok('key from a lower-case spaced copy',K.syKeyFromText(key.toLowerCase().replace(/-/g,' '))===key);
ok('key from a link with other parameters',K.syKeyFromText('https://x/y?a=1#p=n&sync='+encodeURIComponent(key))===key);
ok('foreign text is not a key',K.syKeyFromText('https://example.com')===null && K.syKeyFromText('')===null);
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
