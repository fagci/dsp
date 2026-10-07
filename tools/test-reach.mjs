// Ядро Radio Reach: node tools/test-reach.mjs
// Сферическая Земля (дальность радиогоризонта) и синтетические препятствия.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Infinity,isFinite,Number,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/reach-kernels.js'),'utf8')+
  ';this.K={rrParseAlts,rrParseNums,rrDists,rrDest,rrTerrain,rrReachAz,rrReachAll,rrStats,rrPolygon,rrDistKm,rrBearing,rrObsPush,RR_R};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// списки
const al=K.rrParseAlts('FL100, 3000m 10000 fl350','ft');
ok('alts: FL, metres, plain feet',al.length===4 && Math.abs(al[0].m-3048)<1e-6 && al[1].m===3000 && Math.abs(al[2].m-3048)<1e-6 && Math.abs(al[3].m-10668)<1e-6,JSON.stringify(al));
ok('alts: plain numbers follow the unit',K.rrParseAlts('1000','m')[0].m===1000 && Math.abs(K.rrParseAlts('1000','ft')[0].m-304.8)<1e-9);
ok('alts: junk and out-of-range ignored',K.rrParseAlts('abc, FLx, 99999m, -5','ft').length===0);
ok('nums',K.rrParseNums('2, 10 30;x,-1').join()==='2,10,30');

// выборки
const d=K.rrDists(50000,100,300000);
ok('dists: fine step inside the window, 1 km beyond',d[0]===100 && d[499]===50000 && d[500]===51000 && d[d.length-1]===300000 && d.length===500+250);
ok('dists: no window → only the coarse part',K.rrDists(0,100,5000).join()==='1000,2000,3000,4000,5000',K.rrDists(0,100,5000).join());
const p=K.rrDest(55,82,90,100000);
near('dest east: latitude almost unchanged',p[0],55,.05); near('dest east: 100 km ≈ 1.567° of longitude at 55°',p[1]-82,100/(111.19*Math.cos(55*Math.PI/180)),.01);
near('distance',K.rrDistKm(55,82,56,82),111.19,.01); near('bearing',K.rrBearing(55,82,55,83),90,.05);

// плоская Земля без рельефа: радиогоризонт — d = sqrt(2kR·h1) + sqrt(2kR·h2)
const k=4/3, R=K.RR_R, Re=k*R, flat=new Float32Array(d.length).fill(0), dd=K.rrDists(0,100,600000);
const flat2=new Float32Array(dd.length).fill(0);
const h0=10, H=3048, exp=Math.sqrt(2*Re*h0)+Math.sqrt(2*Re*H);
near('flat Earth: radio horizon of 10 m mast and FL100',K.rrReachAz(dd,flat2,h0,H,k,0),exp,1500);
near('flat Earth: FL350',K.rrReachAz(dd,flat2,h0,10668,k,0),Math.sqrt(2*Re*h0)+Math.sqrt(2*Re*10668),2500);
ok('higher mast sees farther',K.rrReachAz(dd,flat2,30,H,k,0)>K.rrReachAz(dd,flat2,10,H,k,0));
ok('higher aircraft is seen farther',K.rrReachAz(dd,flat2,10,10668,k,0)>K.rrReachAz(dd,flat2,10,3048,k,0));
ok('lower refraction (k=1) → shorter range',K.rrReachAz(dd,flat2,10,H,1,0)<K.rrReachAz(dd,flat2,10,H,k,0));

// хребет 500 м на расстоянии 20 км: самолёт на 3000 м виден только до тех пор, пока угол выше хребта
const ridge=new Float32Array(dd.length); for(let i=0;i<dd.length;i++) ridge[i]=dd[i]>=20000 && dd[i]<22000 ? 500 : 0;
const rd=K.rrReachAz(dd,ridge,h0,3000,k,0);
// цель на расстоянии D видна, пока (3000−h0−D²/2Re)/D ≥ (500−h0−20000²/2Re)/20000: решаем делением пополам
const ang=(H,D)=>(H-h0-D*D/(2*k*R))/D, ar=ang(500,20000); let lo=21000, hi=600000;
for(let i=0;i<60;i++){ const mid=(lo+hi)/2; if(ang(3000,mid)>=ar) lo=mid; else hi=mid; }
const lim=lo;
near('ridge: the aircraft disappears where it drops below the ridge line',rd,lim,lim*.03);
ok('ridge: far less than the open-ground range',rd<K.rrReachAz(dd,flat2,h0,3000,k,0)*.6);
ok('ridge: an aircraft in front of the ridge is not blocked by it',K.rrReachAz(dd,ridge,h0,3000,k,0)>20000);
const ridge2=new Float32Array(dd.length); for(let i=0;i<dd.length;i++) ridge2[i]=dd[i]>=20000 && dd[i]<22000 ? 3500 : 0;
ok('ridge above the aircraft: reach ends at the ridge',K.rrReachAz(dd,ridge2,h0,3000,k,0)<=21100 && K.rrReachAz(dd,ridge2,h0,3000,k,0)>=19000,K.rrReachAz(dd,ridge2,h0,3000,k,0));
// нет данных (NaN) — как опорная земля
const nan=new Float32Array(dd.length).fill(NaN);
near('no data: reference ground used',K.rrReachAz(dd,nan,h0,H,k,0),exp,1500);
ok('reference ground above the antenna shortens the range',K.rrReachAz(dd,nan,h0,H,k,200)<K.rrReachAz(dd,nan,h0,H,k,0));
// антенна на горе выше: дальше
ok('antenna on a hill',K.rrReachAz(dd,flat2,510,H,k,0)>K.rrReachAz(dd,flat2,10,H,k,0));

// по азимутам и статистика
const ht=[]; for(let a=0;a<360;a++) ht.push(a>=80 && a<100 ? ridge2 : flat2);
const ra=K.rrReachAll(dd,ht,h0,3000,k,0), st=K.rrStats(ra);
ok('all azimuths: blocked sector is short, the rest long',ra[90]<25000 && ra[200]>200000 && ra[79]>200000 && ra[100]>200000);
ok('stats: min in the blocked sector, max elsewhere',st.minAz>=80 && st.minAz<100 && st.min<25 && st.max>200 && st.avg>st.min && st.avg<st.max);
const circ=K.rrStats(new Float32Array(360).fill(100000));
near('area of a 100 km circle',circ.area,Math.PI*100*100,30);
const poly=K.rrPolygon(55,82,ra,5);
ok('polygon is closed and has a point per step',poly.length===73 && poly[0][0]===poly[72][0] && poly[0][1]===poly[72][1]);

// наблюдаемая дальность
const bins=new Float32Array(72); K.rrObsPush(bins,92,120); K.rrObsPush(bins,93,80); K.rrObsPush(bins,-5,50); K.rrObsPush(bins,359.9,70);
ok('observed bins keep the maximum per sector',bins[18]===120 && bins[71]===70);
// рельеф по лучу
const tr=K.rrTerrain((la,lo)=>(lo>82.1 ? 700 : 0),55,82,90,[1000,10000,20000]);
ok('terrain along an azimuth',tr[0]===0 && tr[2]===700,Array.from(tr).join());
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
