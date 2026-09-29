// Радиозонд RS41: эталонные кадры и запись (rs1729/RS), генератор → приёмник → карта
// Кадры из rs41/rs41.txt: 1) стандартный 320 байт, 2) 518 байт с двумя ошибками в RS (и исправленный вариант)
const F1 = '8635f44093df1a602c87e0fa0521e8943d9cef4c7a67393f6d39fb546461f2111b6447ab79a746c80350cda5344157f8c0c12234f46902220f792816174b313933303239331a00000300000a00002f0007322ce53e31991abf12dada3eb68468c16755d51c7a2a15310216060245f302000d08a31607821e08bb210219060243f302000000000000000000000000000000220d7c1e0807d03cdc071fd81ddb19d70a8d0eb602b60cb518d40692ff00ff00ff001c277d59b8d83301ff0f881f0f38f4fe18b283038735ff000000003eb8ff4947201e6e3aff55415f13fc6e005440440cf100009e9f7406f85800832b631719d70010bebc172a8b00000000000000000000000000000000000000000000a48b7b15366181193ef05d07e1245b1be0f721f801f60804107b0b76110000000000000000000000000000000000ecc7';
const F2 = '8635f44093df1a608f9b1025bf8ec9e28ad68413c31788307e9881c5cb2f37f754fa09b711c5c39977ed8fbf22377b3e5e1cee59fc644b19f0792896134b343032303234341c00000100000c00007a0007320f00000000008920bac20000000000000092697a2ae9030226fd015de502363208522a075f330874040228fd015de502000000000000000000000000000000e7917c1e4d0750f1921703fb01f8068d1fd811f70bd604d50afa17f913d90c8b20f9a16a7d5921103501ff440000006c1f00cd977e059ab7009566fd191d1affd82fbf143fb8ff5277180991faff9ca1d10d441b01927bf211dd190190999f0553a1ff9120b10c3847ff06eeee0e571301a2c0891c000000cddd1a0882d10011167b153c154217941930005fc50b1eb9fde107d2050902115a537ea6ed343030313030303120313037393020202033312e37203036373520303334392030373030203132383636203630303520313339333120363031342031343038322035383830203738313420383032372031303039203930392039353631353632203935303839323220343238383339313633382032393335383636203539343238203335323439203636393920333738332034363837203637303120363930312037393939049a762d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f35a';
const F2_PARITY_FIXED = '8f9b1025bf8ec9e28ad68413c31788307e9881c5cb2f37f754fa49b711c5c39977ed8fbf22377b3e5e1cee59bc644b19';
const GEN = (sr, off, noise, extra=[]) => [[['iqGen', {sr, fc:403e6, mode:'RS41', off, lvl:-20, noise}], ['rs41Rx', {}], ...extra], ['0.iq>1.in']];

export function setup(){
  window.sondeHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  window.sondeRun = (ns, sec, k=1) => {
    const recs = [], n = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[k].out.rec) recs.push(...ns[k].out.rec);
    }
    return recs;
  };
  // записи совпадают с полётом генератора
  window.sondeCheck = recs => {
    for(const r of recs){
      const s = rs41SimState(r.frame);
      if(r.id !== RS41_SIM.id) return 'id '+r.id;
      if(Math.abs(r.lat-s.lat) > 2e-6 || Math.abs(r.lon-s.lon) > 2e-6 || Math.abs(r.alt-s.alt) > 1) return 'pos '+JSON.stringify(r)+' vs '+JSON.stringify(s);
      if(Math.abs(r.climb-5) > .05 || Math.abs(r.vh-8) > .05 || Math.abs(r.heading-45) > 1) return 'vel '+JSON.stringify(r);
      if(r.temp != null && Math.abs(r.temp-s.temp) > .2) return 'T '+r.temp+' vs '+s.temp;
      if(r.rh != null && Math.abs(r.rh-s.rh) > 2) return 'RH '+r.rh+' vs '+s.rh;
    }
    return true;
  };
}

export default [
  {name:'rs41: reference frames — RS(255,231)×2, blocks, ECEF → lat/lon', arg:[F1, F2, F2_PARITY_FIXED], fn([F1, F2, F2_PARITY_FIXED]){
    const bad = [], out = [];
    for(const h of [F1, F2]){
      const f = new Uint8Array(RS41_FRAME); f.set(sondeHex(h));
      const len = rs41Len(f), e = rs41Ecc(f, len), r = rs41Parse(f, len, rs41State());
      out.push({len, e:e.join(), id:r?.id, frame:r?.frame, crc:r?.crcBad, lat:r?.lat?.toFixed(5), lon:r?.lon?.toFixed(5), alt:r?.alt?.toFixed(1), f});
    }
    const [a, b] = out;
    if(a.len !== 320 || a.e !== '0,0' || a.id !== 'K1930293' || a.frame !== 5910 || a.crc || a.lat !== '46.05026' || a.lon !== '16.11077' || a.alt !== '28410.0') bad.push('1: '+JSON.stringify({...a, f:0}));
    if(b.len !== 518 || b.e !== '0,2' || b.id !== 'K4020244' || b.frame !== 5014 || b.crc || b.lat !== '52.44202' || b.lon !== '0.46285') bad.push('2: '+JSON.stringify({...b, f:0}));
    const par = [...b.f.subarray(8, 56)].map(x => x.toString(16).padStart(2, '0')).join('');
    if(par !== F2_PARITY_FIXED) bad.push('corrected parity '+par);
    if(rs41Crc(new Uint8Array(17), 0, 17) !== 0xC7EC) bad.push('crc');
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'rs41: real recording (FM audio, 48 kHz) matches rs41mod', async fn(){
    const buf = new Uint8Array(await (await fetch('tools/test/data/rs41-20150802-6s.wav')).arrayBuffer());
    const v = new DataView(buf.buffer); let p = 12, data = null, sr = 0;
    while(p < buf.length){ const id = String.fromCharCode(...buf.subarray(p, p+4)), sz = v.getUint32(p+4, true);
      if(id === 'fmt ') sr = v.getUint32(p+12, true); if(id === 'data'){ data = buf.subarray(p+8, p+8+sz); break; } p += 8+sz; }
    const x = Float32Array.from(data, b => (b-128)/128), n = {p:{}}, recs = [];
    IQK.rs41Rx.init(n);
    for(let i=0; i<x.length; i+=4800){ const r = IQK.rs41Rx.process(n, {in:{sr, fc:0, chunks:[{re:x.subarray(i, i+4800), im:null, t0:i, tag:null}]}}, {}); if(r.rec) recs.push(...r.rec); }
    // rs41mod -i -v: [3172] 46.01891 16.34725 14035.75 vH 12.3 D 63.3 vV 7.1; [3173] 46.01897 16.34740 14041.53 13.0 60.1 4.0
    const ref = [[3172, 46.01891, 16.34725, 14035.75, 12.3, 63.3, 7.1], [3173, 46.01897, 16.34740, 14041.53, 13.0, 60.1, 4.0]];
    if(recs.length < 5 || n.bad) return 'frames '+recs.length+' bad '+n.bad;
    for(const [fr, lat, lon, alt, vh, d, vv] of ref){
      const r = recs.find(q => q.frame === fr); if(!r) return 'no frame '+fr;
      if(r.id !== 'L1830070' || Math.abs(r.lat-lat) > 6e-6 || Math.abs(r.lon-lon) > 6e-6 || Math.abs(r.alt-alt) > .6
        || Math.abs(r.vh-vh) > .06 || Math.abs(r.heading-d) > .6 || Math.abs(r.climb-vv) > .06) return 'frame '+fr+': '+JSON.stringify(r);
      // rs41mod печатает время GPS (11:59:26 у кадра 3172), в записи — UTC: минус 18 с
      if(new Date(r.t+18000).toISOString().slice(0, 19) !== '2015-08-02T11:59:'+(26+fr-3172)) return 'time '+new Date(r.t).toISOString();
    }
    return true;
  }},
  {name:'rs41: generator → receiver at 256 kS/s, +3 kHz: position, velocity, T, RH', arg:GEN('256000', 3000, -20), fn([g, w]){
    const ns = T.build(g, w), recs = sondeRun(ns, 10);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(recs.length < 8 || ns[1].bad) return 'frames '+recs.length+' bad '+ns[1].bad;
    if(!recs.some(r => r.temp != null && r.rh != null)) return 'no T/RH after 10 s';
    return sondeCheck(recs);
  }},
  {name:'rs41: 1.024 MS/s, −8 kHz — decimated inside', arg:GEN('1024000', -8000, -30), fn([g, w]){
    const ns = T.build(g, w), recs = sondeRun(ns, 4);
    if(ns[1].ui.M !== 25) return 'M '+ns[1].ui.M;
    return recs.length >= 3 && sondeCheck(recs) === true || 'frames '+recs.length+' '+sondeCheck(recs);
  }},
  {name:'rs41: noise alone — no frames', arg:GEN('256000', 0, -20), fn([g, w]){
    g[0][1].mode = 'off';
    const ns = T.build(g, w), recs = sondeRun(ns, 3);
    return recs.length === 0 && ns[1].frames === 0 || 'frames '+ns[1].frames;
  }},
  {name:'rs41: receiver in a worker island, records reach the map', arg:GEN('256000', 3000, -30, [['geoMap', {}]]), async fn([g, w]){
    w.push('1.rec>2.rec');
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl) return 'not in a worker';
      await T.realtime(5);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      const s = [...ns[2].ents.values()].filter(x => x.rec.icon === 'balloon');
      return s.length === 1 && s[0].pts.length >= 3 || 'map '+s.length+' '+(s[0]?.pts.length);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'preset: Radiosonde RS41: Map (Generator)', fn(){
    T.preset('Radiosonde RS41: Map (Generator)'); T.run(4);
    const e = T.errors(); if(e.length) return e.join('; ');
    const m = T.byType('geoMap')[0], s = [...m.ents.values()].filter(x => x.rec.icon === 'balloon');
    return s.length === 1 || 'balloons '+s.length;
  }},
  {name:'preset: Radiosonde RS41: Map (USB SDR, 400–406 MHz) (not connected)', fn(){
    T.preset('Radiosonde RS41: Map (USB SDR, 400–406 MHz)'); T.run(.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
];
