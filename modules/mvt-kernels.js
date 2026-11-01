"use strict";
/* Векторные тайлы (Mapbox Vector Tile, схема OpenMapTiles): разбор protobuf и отрисовка в 2D-контекст — без DOM, проверяется в tools/test-mvt.mjs.
   Тайл рисуется один раз в картинку (см. geoVecTile в geo.js) и дальше идёт тем же путём, что растровые тайлы. */

function pbFields(b,s,e,cb){                          // разбор protobuf: cb(поле, тип, число, начало, конец)
  let p=s;
  const vi=()=>{ let v=0,sh=0,c; do{ if(p>=e) throw new Error('mvt: truncated'); c=b[p++]; v+=(c&127)*2**sh; sh+=7; }while(c&128); return v; };
  while(p<e){
    const k=vi(), f=Math.floor(k/8), w=k&7;
    if(w===0) cb(f,0,vi(),0,0);
    else if(w===2){ const l=vi(); if(p+l>e) throw new Error('mvt: truncated'); cb(f,2,0,p,p+l); p+=l; }
    else if(w===1){ cb(f,1,0,p,p+8); p+=8; }
    else if(w===5){ cb(f,5,0,p,p+4); p+=4; }
    else throw new Error('mvt: bad wire type '+w);
  }
}
function pbPacked(b,s,e){ const o=[]; let p=s; while(p<e){ let v=0,sh=0,c; do{ c=b[p++]; v+=(c&127)*2**sh; sh+=7; }while(c&128 && p<=e); o.push(v); } return o; }
const MVT_TD=typeof TextDecoder!=='undefined' ? new TextDecoder() : null;
function mvtValue(b,s,e){
  let r=null;
  pbFields(b,s,e,(f,w,v,a,z)=>{
    if(f===1) r=MVT_TD.decode(b.subarray(a,z));
    else if(f===2) r=new DataView(b.buffer,b.byteOffset+a,4).getFloat32(0,true);
    else if(f===3) r=new DataView(b.buffer,b.byteOffset+a,8).getFloat64(0,true);
    else if(f===4||f===5) r=v;
    else if(f===6) r=v%2 ? -(v+1)/2 : v/2;           // sint64: zigzag
    else if(f===7) r=!!v;
  });
  return r;
}
// команды геометрии → кольца / линии / точки в координатах тайла: массивы плоских [x,y,x,y,…]; полигоны замыкаются
function mvtGeom(c,type){
  const out=[]; let x=0,y=0,cur=null,i=0;
  const zz=v=>(v%2) ? -(v+1)/2 : v/2;
  while(i<c.length){
    const ci=c[i++], cmd=ci&7, n=Math.floor(ci/8);
    for(let j=0;j<n;j++){
      if(cmd===1){ x+=zz(c[i++]); y+=zz(c[i++]); cur=[x,y]; out.push(cur); }
      else if(cmd===2){ x+=zz(c[i++]); y+=zz(c[i++]); if(cur) cur.push(x,y); }
      else if(cmd===7){ if(cur && type===3) cur.push(cur[0],cur[1]); }
      else throw new Error('mvt: bad command '+cmd);
    }
  }
  return out;
}
// Uint8Array → {layers:{имя:{extent,features:[{type:1|2|3,rings,props}]}}}
function mvtDecode(b){
  const tile={layers:{}};
  pbFields(b,0,b.length,(f,w,v,s,e)=>{
    if(f!==3 || w!==2) return;
    const keys=[], vals=[], raw=[]; let name='', extent=4096;
    pbFields(b,s,e,(f2,w2,v2,s2,e2)=>{
      if(f2===1) name=MVT_TD.decode(b.subarray(s2,e2));
      else if(f2===3) keys.push(MVT_TD.decode(b.subarray(s2,e2)));
      else if(f2===4) vals.push(mvtValue(b,s2,e2));
      else if(f2===5) extent=v2||4096;
      else if(f2===2){ const ft={type:0,tags:[],geom:[]}; pbFields(b,s2,e2,(f3,w3,v3,s3,e3)=>{
        if(f3===3) ft.type=v3; else if(f3===2) ft.tags=pbPacked(b,s3,e3); else if(f3===4) ft.geom=pbPacked(b,s3,e3); }); raw.push(ft); }
    });
    const lay=tile.layers[name]||(tile.layers[name]={extent,features:[]});
    for(const ft of raw){
      const props={}; for(let i=0;i+1<ft.tags.length;i+=2) props[keys[ft.tags[i]]]=vals[ft.tags[i+1]];
      lay.features.push({type:ft.type,rings:mvtGeom(ft.geom,ft.type),props});
    }
  });
  return tile;
}

// Палитры (схема OpenMapTiles). roads: класс → [заливка, обводка, ширина в пикселях тайла 256 на z14]
const MVT_PAL={
  light:{bg:'#f2efe9',water:'#9fc8ee',waterLine:'#9fc8ee',wood:'#c5d9ae',grass:'#d4e6bf',farm:'#ece9d6',sand:'#f0e8c0',ice:'#ffffff',park:'#cbe5b5',residential:'#e9e5dd',industrial:'#e4e0e6',building:'#d8cfc7',buildingEdge:'#c6bcb3',
    boundary:'#9b7bb0',label:'#2b2b2b',halo:'rgba(255,255,255,.85)',waterLabel:'#4a7fb5',rail:'#8a8a8a',
    roads:{motorway:['#e99654','#b46a2c',6],trunk:['#f6b873','#c58a45',5.5],primary:['#fbd48b','#c9a24f',5],secondary:['#fff2a6','#c8bd68',4.4],tertiary:['#ffffff','#bdb8ae',3.8],minor:['#ffffff','#c9c5bc',3],service:['#ffffff','#d0ccc4',1.8],track:['#c9a27a',null,1.2],path:['#a89580',null,1]}},
  dark:{bg:'#1c1f22',water:'#0f2a3f',waterLine:'#13344d',wood:'#212e20',grass:'#232d22',farm:'#24262a',sand:'#2b2a24',ice:'#2e3238',park:'#233222',residential:'#212427',industrial:'#25232a',building:'#2c3137',buildingEdge:'#363c43',
    boundary:'#7d6591',label:'#cdd5db',halo:'rgba(10,12,14,.85)',waterLabel:'#5f93c4',rail:'#5f656c',
    roads:{motorway:['#a9682f','#2a1a0c',6],trunk:['#8e6a3b','#251a0d',5.5],primary:['#7d6a45','#211a0e',5],secondary:['#6d6a52','#1d1b10',4.4],tertiary:['#4a4f56','#16181b',3.8],minor:['#3d4248','#16181b',3],service:['#33383d','#16181b',1.8],track:['#5b4c3c',null,1.2],path:['#6a5e52',null,1]}},
};
const MVT_ROAD_ORDER=['path','track','service','minor','tertiary','secondary','primary','trunk','motorway'];
const MVT_PLACE_RANK={country:1,state:2,province:2,city:3,town:4,village:5,suburb:6,quarter:6,neighbourhood:7,hamlet:7,isolated_dwelling:8};
const MVT_PLACE_PX={country:15,state:12,province:12,city:14,town:12.5,village:11,suburb:10.5,quarter:10,neighbourhood:10,hamlet:10,isolated_dwelling:9.5};

function mvtName(p){ return p['name']||p['name:latin']||p['name_en']||''; }

// Рисует тайл z в квадрат size×size. g — CanvasRenderingContext2D (или совместимый); pal — MVT_PAL.light / dark.
function mvtRender(g,tile,z,size,pal){
  const u=size/256, L=tile.layers;
  g.fillStyle=pal.bg; g.fillRect(0,0,size,size);
  g.lineJoin='round'; g.lineCap='round';
  const K=lay=>size/lay.extent;
  const path=(f,k)=>{ g.beginPath(); for(const r of f.rings){ if(r.length<4) continue; g.moveTo(r[0]*k,r[1]*k); for(let i=2;i<r.length;i+=2) g.lineTo(r[i]*k,r[i+1]*k); } };
  const fills=(name,colorOf)=>{ const ly=L[name]; if(!ly) return; const k=K(ly);
    for(const f of ly.features){ if(f.type!==3) continue; const c=colorOf(f.props); if(!c) continue; path(f,k); g.fillStyle=c; g.fill('evenodd'); } };
  const lines=(name,pick)=>{ const ly=L[name]; if(!ly) return; const k=K(ly);
    for(const f of ly.features){ if(f.type===1) continue; const s=pick(f.props); if(!s) continue; path(f,k);
      g.strokeStyle=s.c; g.lineWidth=s.w*u; g.setLineDash(s.d ? s.d.map(v=>v*u) : []); g.globalAlpha=s.a||1; g.stroke(); }
    g.setLineDash([]); g.globalAlpha=1; };
  fills('landcover',p=>({wood:pal.wood,forest:pal.wood,grass:pal.grass,farmland:pal.farm,sand:pal.sand,ice:pal.ice,wetland:pal.grass,rock:pal.residential})[p.class]||null);
  fills('landuse',p=>({residential:pal.residential,suburb:pal.residential,commercial:pal.residential,industrial:pal.industrial,retail:pal.residential,cemetery:pal.grass,pitch:pal.park,playground:pal.park,stadium:pal.park,school:pal.residential,hospital:pal.residential})[p.class]||null);
  fills('park',()=>pal.park);
  fills('water',()=>pal.water);
  lines('waterway',p=>({c:pal.waterLine,w:p.class==='river'?2.2:1.2}));
  fills('building',()=>pal.building);
  const ts=L.transportation;
  if(ts){
    const k=K(ts), sc=Math.min(3,Math.max(.35,2**((z-14)*.6)));
    const cls=p=>{ const c=String(p.class||''); return c.replace(/_construction$/,''); };
    const rk=c=>MVT_ROAD_ORDER.indexOf(c);
    const roads=ts.features.filter(f=>f.type===2 && rk(cls(f.props))>=0).sort((a,b)=>rk(cls(a.props))-rk(cls(b.props)));
    for(const pass of [0,1]) for(const f of roads){
      const c=cls(f.props), st=pal.roads[c], tun=f.props.brunnel==='tunnel';
      if(pass===0 && !st[1]) continue;
      path(f,k); g.globalAlpha=tun?.5:1;
      if(c==='path'||c==='track'){ if(pass===1){ g.strokeStyle=st[0]; g.lineWidth=Math.max(.8,st[2]*sc)*u; g.setLineDash([3*u,2*u]); g.stroke(); g.setLineDash([]); } }
      else { g.strokeStyle=pass===0?st[1]:st[0]; g.lineWidth=(st[2]*sc+(pass===0?1.6:0))*u; g.stroke(); }
      g.globalAlpha=1;
    }
    for(const f of ts.features){ const c=String(f.props.class||''); if(f.type!==2 || (c!=='rail' && c!=='transit')) continue;
      path(f,k); g.strokeStyle=pal.rail; g.lineWidth=Math.max(.7,1.1*sc)*u; g.setLineDash([4*u,3*u]); g.stroke(); g.setLineDash([]); }
  }
  lines('boundary',p=>p.admin_level<=2 ? {c:pal.boundary,w:1.4,d:[5,3]} : (p.admin_level<=4 ? {c:pal.boundary,w:.9,d:[3,3],a:.8} : null));
  // подписи: населённые пункты и водоёмы; простая защита от наложений внутри тайла (соседние тайлы рисуют свои части одного и того же текста)
  const boxes=[];
  const label=(x,y,text,px,col,italic)=>{
    if(x<-size*.5||y<-size*.5||x>size*1.5||y>size*1.5) return;
    g.font=(italic?'italic ':'')+Math.round(px*u)+'px sans-serif'; const w=g.measureText(text).width, h=px*u;
    const b=[x-w/2-2*u,y-h/2-2*u,x+w/2+2*u,y+h/2+2*u];
    for(const o of boxes) if(b[0]<o[2]&&b[2]>o[0]&&b[1]<o[3]&&b[3]>o[1]) return;
    boxes.push(b);
    g.textAlign='center'; g.textBaseline='middle'; g.lineWidth=3*u; g.strokeStyle=pal.halo; g.strokeText(text,x,y); g.fillStyle=col; g.fillText(text,x,y);
  };
  const wn=L.water_name;
  if(wn){ const k=K(wn); for(const f of wn.features){ const n=mvtName(f.props); if(!n||f.type!==1||!f.rings[0]) continue; label(f.rings[0][0]*k,f.rings[0][1]*k,n,11,pal.waterLabel,true); } }
  const pl=L.place;
  if(pl){ const k=K(pl);
    const fs=pl.features.filter(f=>f.type===1 && f.rings[0] && mvtName(f.props)).sort((a,b)=>(MVT_PLACE_RANK[a.props.class]||9)-(MVT_PLACE_RANK[b.props.class]||9)||(a.props.rank||99)-(b.props.rank||99));
    for(const f of fs) label(f.rings[0][0]*k,f.rings[0][1]*k,mvtName(f.props),MVT_PLACE_PX[f.props.class]||10,pal.label,false); }
}

// ответ сервера → Uint8Array: тело бывает ещё сжатым gzip (если сервер не выставил Content-Encoding)
async function mvtBytes(buf){
  let b=new Uint8Array(buf);
  if(b.length>2 && b[0]===0x1f && b[1]===0x8b && typeof DecompressionStream!=='undefined'){
    b=new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  return b;
}
