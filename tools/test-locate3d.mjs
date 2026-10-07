// Ядро Source Locator 3D: node tools/test-locate3d.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Infinity,isFinite,Number,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/locate3d-kernels.js'),'utf8')+';this.K={l3MeasAlt,l3FromElev,l3Source,l3Rays};',ctx);
const K=ctx.K; let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b);
ok('meas alt: GPS alt wins',K.l3MeasAlt({alt:300,h:2},100)===300);
near('meas alt: ground + antenna',K.l3MeasAlt({h:2},100),102,1e-9);
near('meas alt: no ground → antenna only',K.l3MeasAlt({h:2},NaN),2,1e-9);
// источник на (1 км, 0) на высоте 130 м; замеры на высоте 100 м
const S={x:1,y:0}, mk=(x,y,z)=>{ const d=Math.hypot(1-x,-y)*1000; return {x,y,z,el:Math.atan2(130-z,d)*180/Math.PI}; };
const M=[mk(0,0,100),mk(0.5,-0.5,100),mk(2,1,100)];
const e=K.l3FromElev(M,S,2);
near('elevation: altitude from three marks',e.alt,130,.01); ok('elevation: count',e.n===3);
ok('elevation: none → null',K.l3FromElev([{x:0,y:0,z:1}],S,2)===null);
// близкий замер точнее далёкого: ошибка угла даёт меньший разброс высоты
const e2=K.l3FromElev([{...mk(0.9,0,100),el:mk(0.9,0,100).el},{...mk(5,0,100),el:mk(5,0,100).el+3}],S,2);
ok('elevation: the near mark outweighs the far one',Math.abs(e2.alt-130)<10,e2.alt);
const s1=K.l3Source(M,S,100,{h0:10,sigEl:2});
ok('source: from elevation',s1.how==='elevation' && Math.abs(s1.h-30)<.1 && Math.abs(s1.alt-130)<.1,JSON.stringify(s1));
const s2=K.l3Source([{x:0,y:0,z:100}],S,100,{h0:10,sigEl:2});
ok('source: assumed mast height',s2.how==='assumed' && s2.alt===110 && s2.h===10);
const s3=K.l3Source(M,S,160,{h0:10,sigEl:2});
ok('source: never below the ground',s3.h===0 && s3.alt===160,JSON.stringify(s3));
ok('source: no ground, no elevation → null',K.l3Source([],S,NaN,{h0:10})===null);
const R=K.l3Rays([{lat:55,lon:82,alt3:100},{lat:55.1,lon:82,alt3:101},{lat:null,alt3:1}],{lat:55.05,lon:82.1,alt:130},'ray:a',{max:5});
ok('rays: links with altitudes',R.rays.length===2 && R.rays[0].alt===100 && R.rays[0].alt2===130 && R.rays[0].lat2===55.05 && R.rays[0].kind==='ray' && R.rays[0].id==='ray:a:0');
ok('rays: only the last ones',K.l3Rays(Array.from({length:10},()=>({lat:1,lon:1,alt3:0})),{lat:1,lon:1,alt:0},'r',{max:4}).rays.length===4);
console.log(bad?'FAILED '+bad:'all ok'); process.exit(bad?1:0);
