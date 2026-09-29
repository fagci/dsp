// ADS-B: разбор эталонных кадров, генератор → демодулятор → декодер, исправление бита, острова
const CHAIN = sr => [[['iqGen', {sr, fc:1090e6, mode:'ADS-B', off:0, lvl:-20, noise:-40}], ['adsbDemod', {}], ['adsbDecode', {rlat:55.01, rlon:82.65}]],
  ['0.iq>1.in', '1.rec>2.rec']];

export function setup(){
  // все борта симулятора найдены: позывной, высота, позиция рядом с истинной
  window.adsbCheck = (de, gen) => {
    const t = gen.adsb.t/gen.adsb.sr, bad = [];
    for(const a of ADSB_SIM){
      const k = a.icao.toString(16).toUpperCase().padStart(6, '0'), x = de.ac.get(k), s = adsbSimPos(a, t);
      if(!x){ bad.push(k+' missing'); continue; }
      if(x.flight !== a.call) bad.push(k+' flight '+x.flight);
      if(x.alt !== a.alt) bad.push(k+' alt '+x.alt);
      if(x.lat == null || Math.abs(x.lat-s.lat) > 0.02 || Math.abs(x.lon-s.lon) > 0.03) bad.push(k+` pos ${x.lat},${x.lon} vs ${s.lat.toFixed(3)},${s.lon.toFixed(3)}`);
      if(x.gs == null || Math.abs(x.gs-Math.hypot(s.ve, s.vn)) > 3) bad.push(k+' gs '+x.gs);
    }
    return bad.length ? bad.join('; ') : true;
  };
}

export default [
  {name:'adsb: reference frames (1090 MHz Riddle)', fn(){
    const n = T.build([['adsbDecode', {}]], [])[0];
    n.p.rlat = 52.25; n.p.rlon = 3.9;
    const feed = txt => { evalNode(n); n.lastText = null; const I = {text:txt}; return MOD.adsbDecode.process(n, I); };
    feed('*8D4840D6202CC371C32CE0576098;');
    feed('*8D40621D58C386435CC412692AD6;\n*8D40621D58C382D690C8AC2863A7;');
    feed('*8D485020994409940838175B284F;');
    feed('*8DA05F219B06B6AF189400CBC33F;');
    const a = n.ac.get('4840D6'), b = n.ac.get('40621D'), c = n.ac.get('485020'), d = n.ac.get('A05F21'), bad = [];
    if(a?.flight !== 'KLM1023') bad.push('flight '+a?.flight);
    if(!(b && Math.abs(b.lat-52.25720) < 1e-4 && Math.abs(b.lon-3.91937) < 1e-4 && b.alt === 38000)) bad.push('pos '+JSON.stringify(b));
    if(!(c && Math.abs(c.gs-159) <= 1 && Math.abs(c.track-182.9) < 0.1 && c.vr === -832)) bad.push('vel '+JSON.stringify(c));
    if(!(d && Math.abs(d.hdg-244) < 0.1 && d.tas === 375 && d.vr === -2304)) bad.push('airspeed '+JSON.stringify(d));
    if(n.ac.size !== 4) bad.push('aircraft '+n.ac.size);
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'adsb: altitude (25 ft) and squawk fields', fn(){
    const bad = [];
    if(adsbAc12(0xC38) !== 38000) bad.push('ac12 '+adsbAc12(0xC38));
    if(adsbAc13(0) !== null) bad.push('ac13 empty');
    if(adsbSquawk(0x1FBF) !== '7777') bad.push('squawk 7777 → '+adsbSquawk(0x1FBF));
    if(adsbSquawk(0) !== '0000') bad.push('squawk 0000');
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'adsb: generator → demodulator → decoder at 2.4 MS/s', arg:CHAIN('2400000'), fn([g, w]){
    const ns = T.build(g, w);
    T.run(3);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(ns[1].ui.frames < 30) return 'frames '+ns[1].ui.frames;
    return adsbCheck(ns[2], ns[0]);
  }},
  {name:'adsb: 2.0 MS/s works too, and the map gets planes', arg:[[...CHAIN('2000000')[0], ['geoMap', {}]], [...CHAIN('2000000')[1], '2.rec>3.rec']], fn([g, w]){
    const ns = T.build(g, w);
    T.run(3);
    const r = adsbCheck(ns[2], ns[0]); if(r !== true) return r;
    const planes = [...ns[3].ents.values()].filter(e => e.rec.icon === 'plane' && e.rec.heading != null && e.rec.alt != null);
    return planes.length === 3 || 'map planes '+planes.length;
  }},
  {name:'adsb: one flipped bit is fixed, two are rejected', fn(){
    const sr = 2400000, a = ADSB_SIM[0], out = [];
    for(const flips of [[], [50], [50, 70]]){
      const b = adsbSimMsg(a, 'id', 0), orig = modesHex(b, 14);
      for(const i of flips) b[i>>3] ^= 0x80>>(i&7);
      const env = adsbEnv(b, sr), L = env.length+2000, re = new Float32Array(L), im = new Float32Array(L);
      re.set(env.map(v => 0.1*v), 500);
      const n = {p:{thr:6, fix:'1 bit'}}; IQK.adsbDemod.init(n);
      const r = IQK.adsbDemod.process(n, {in:{sr, fc:0, chunks:[{re, im, t0:0, tag:null}]}}).rec
        || IQK.adsbDemod.process(n, {in:{sr, fc:0, chunks:[{re:new Float32Array(2000), im:new Float32Array(2000), t0:L, tag:null}]}}).rec;
      out.push(r ? (r[0].raw === orig ? 'ok' : 'wrong')+(r[0].fix ? '+fix' : '') : 'none');
    }
    return out.join(',') === 'ok,ok+fix,none' || out.join(',');
  }},
  {name:'adsb: frames from the worker island reach the decoder once each', arg:CHAIN('2000000'), async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl || ns[2]._isl) return 'wrong islands';
      await T.realtime(4);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      const fr = ns[1].ui?.frames, msgs = ns[2].msgs;
      if(!(fr > 20 && msgs <= fr && msgs >= fr-3)) return `demod ${fr} frames, decoder ${msgs} msgs`;
      return ns[2].ac.size === 3 || 'aircraft '+ns[2].ac.size;
    } finally { Islands.setEnabled(false); }
  }},
];
