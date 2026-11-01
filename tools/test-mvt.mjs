// Векторные тайлы (MVT): node tools/test-mvt.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({TextDecoder,DataView,Response,Blob,DecompressionStream,Uint8Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/mvt-kernels.js'),'utf8')+';this.K={mvtDecode,mvtGeom,mvtRender,mvtBytes,MVT_PAL};',ctx);
const K=ctx.K;

// --- минимальный кодировщик protobuf для сборки тайла ---
const vi=n=>{ const o=[]; while(n>=128){ o.push((n%128)|128); n=Math.floor(n/128); } o.push(n); return o; };
const tag=(f,w)=>vi(f*8+w), ld=(f,b)=>[...tag(f,2),...vi(b.length),...b], vf=(f,n)=>[...tag(f,0),...vi(n)];
const str=s=>[...Buffer.from(s)], zz=n=>n<0?-2*n-1:2*n;
const packed=(f,a)=>ld(f,a.flatMap(vi));
const cmd=(id,n)=>id+n*8;
const val=v=>typeof v==='string' ? ld(4,ld(1,str(v))) : ld(4,[...tag(4,0),...vi(v)]);
function layer(name,extent,feats){            // feats: [{type,geom,props}]
  const keys=[],vals=[]; const kidx=k=>{ let i=keys.indexOf(k); if(i<0){ i=keys.length; keys.push(k); } return i; };
  const vidx=v=>{ const j=vals.findIndex(x=>x===v); if(j>=0) return j; vals.push(v); return vals.length-1; };
  const fb=feats.map(f=>{ const tags=[]; for(const [k,v] of Object.entries(f.props||{})) tags.push(kidx(k),vidx(v));
    return ld(2,[...packed(2,tags),...vf(3,f.type),...packed(4,f.geom)]); });
  return ld(3,[...vf(15,2),...ld(1,str(name)),...fb.flat(),...keys.flatMap(k=>ld(3,str(k))),...vals.flatMap(v=>ld(4,typeof v==='string'?ld(1,str(v)):[...tag(4,0),...vi(v)])),...vf(5,extent)]);
}
// квадрат 0,0–100,100 (полигон), линия (10,10)→(60,10)→(60,50), точка (200,300)
const sq=[cmd(1,1),zz(0),zz(0),cmd(2,3),zz(100),zz(0),zz(0),zz(100),zz(-100),zz(0),cmd(7,1)];
const ln=[cmd(1,1),zz(10),zz(10),cmd(2,2),zz(50),zz(0),zz(0),zz(40)];
const pt=[cmd(1,1),zz(200),zz(300)];
const tile=Uint8Array.from([
  ...layer('water',4096,[{type:3,geom:sq,props:{class:'lake'}}]),
  ...layer('transportation',4096,[{type:2,geom:ln,props:{class:'primary'}},{type:2,geom:ln,props:{class:'path'}}]),
  ...layer('place',4096,[{type:1,geom:pt,props:{class:'city',name:'Омск',rank:2}}]),
]);

const t=K.mvtDecode(tile);
ok('layers decoded',Object.keys(t.layers).join()==='water,transportation,place' && t.layers.water.extent===4096);
const w=t.layers.water.features[0];
ok('polygon: ring closed, props',w.type===3 && w.rings.length===1 && w.rings[0].join()==='0,0,100,0,100,100,0,100,0,0' && w.props.class==='lake',JSON.stringify(w));
const l0=t.layers.transportation.features[0];
ok('line: relative commands → absolute points',l0.type===2 && l0.rings[0].join()==='10,10,60,10,60,50' && l0.props.class==='primary');
const p0=t.layers.place.features[0];
ok('point + utf-8 name + int value',p0.type===1 && p0.rings[0].join()==='200,300' && p0.props.name==='Омск' && p0.props.rank===2,JSON.stringify(p0));
ok('geometry: negative deltas and several rings',K.mvtGeom([cmd(1,1),zz(5),zz(5),cmd(2,1),zz(-3),zz(2),cmd(1,1),zz(10),zz(10),cmd(2,1),zz(1),zz(1)],2).map(r=>r.join(',')).join(';')==='5,5,2,7;12,17,13,18');
let thrown=false; try{ K.mvtDecode(Uint8Array.from([26,200,1,1])); }catch(e){ thrown=/truncated/.test(e.message); }
ok('truncated tile throws, does not hang',thrown);
ok('empty tile: no layers',Object.keys(K.mvtDecode(new Uint8Array(0)).layers).length===0);

// gzip
const gz=zlib.gzipSync(Buffer.from(tile));
const unz=await K.mvtBytes(gz.buffer.slice(gz.byteOffset,gz.byteOffset+gz.length));
ok('gzip body is unpacked',unz.length===tile.length && Object.keys(K.mvtDecode(unz).layers).length===3);
ok('plain body is left as is',(await K.mvtBytes(tile.buffer.slice(0))).length===tile.length);

// отрисовка в контекст-заглушку
function mock(){ const c={calls:[],fills:[],strokes:[],texts:[],font:'',lineWidth:0,fillStyle:'',strokeStyle:'',globalAlpha:1};
  for(const m of ['beginPath','moveTo','lineTo','setLineDash','save','restore']) c[m]=(...a)=>c.calls.push(m);
  c.fillRect=()=>c.calls.push('fillRect'); c.fill=r=>c.fills.push([c.fillStyle,r]); c.stroke=()=>c.strokes.push([c.strokeStyle,c.lineWidth,c.globalAlpha]);
  c.fillText=(s)=>c.texts.push(s); c.strokeText=()=>{}; c.measureText=s=>({width:String(s).length*6}); return c; }
const g=mock(); K.mvtRender(g,t,14,512,K.MVT_PAL.light);
ok('render: background, water filled evenodd',g.calls[0]==='fillRect' && g.fills.some(f=>f[0]===K.MVT_PAL.light.water && f[1]==='evenodd'));
ok('render: road casing first, then the fill; path dashed',g.strokes[0][0]===K.MVT_PAL.light.roads.primary[1] && g.strokes.some(s=>s[0]===K.MVT_PAL.light.roads.primary[0]) && g.strokes.length===3,JSON.stringify(g.strokes));
ok('render: city label drawn',g.texts.join()==='Омск');
const gd=mock(); K.mvtRender(gd,t,14,512,K.MVT_PAL.dark);
ok('render: dark palette',gd.fills.some(f=>f[0]===K.MVT_PAL.dark.water));
const g2=mock(); K.mvtRender(g2,{layers:{}},3,256,K.MVT_PAL.light);
ok('render: empty tile is just the background',g2.calls.join()==='fillRect' && g2.strokes.length===0);
const far=K.mvtDecode(Uint8Array.from([...layer('place',4096,[{type:1,geom:[cmd(1,1),zz(400000),zz(10)],props:{class:'city',name:'Far'}}])]));
const g3=mock(); K.mvtRender(g3,far,5,256,K.MVT_PAL.light);
ok('render: label far outside the tile is skipped',g3.texts.length===0);
if(process.env.MVT_OUT) fs.writeFileSync(process.env.MVT_OUT,tile);
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
