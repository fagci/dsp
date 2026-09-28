// Острова: IQ-блоки в воркере, результат тот же, что в главном потоке.
// Из воркера приходят только выходы, подключённые к узлам вне острова
const RX = ['0.iq>1.in', '1.out>2.in', '2.out>3.in', '3.out>4.in'];
const FM = [
  ['iqGen', {sr:'1024000', fc:100e6, off:100000, lvl:-20, noise:-60, tone:1000, mode:'FM', dev:5000}],
  ['iqShift', {offset:100000}],
  ['iqDecim', {M:'16'}],
  ['iqDemod', {mode:'FM', dev:5000}],
  ['iqAudio', {}],
];

export default [
  {name:'islands: generator chain runs in one worker, bridge in main', arg:[FM, RX], async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      const isl = ns[0]._isl;
      if(!isl || ns.slice(0, 4).some(n => n._isl !== isl) || ns[4]._isl) return 'wrong islands: '+ns.map(n => !!n._isl);
      const a = [];
      await T.realtime(2.5, t => { if(t > 1.5) a.push(...ns[4].out.out); });
      const e = T.errors(); if(e.length) return e.join('; ');
      const f = T.toneHz(Float32Array.from(a), Eng.sr), pk = T.peak(a);
      if(!(Math.abs(f-1000) < 2 && pk > 0.9 && pk < 1.1)) return `f=${f.toFixed(2)} peak=${pk.toFixed(3)} ${ns[4].state}`;
      if(!ns[2].ui || ns[2].ui.srOut !== 64000) return 'no ui from worker: '+JSON.stringify(ns[2].ui);
      return ns[4].starves === 0 || `starves=${ns[4].starves}`;
    } finally { Islands.setEnabled(false); }
  }},
  {name:'islands: numbers and spectrum come back, params follow', arg:[[...FM,
      ['iqSpec', {size:'4096'}], ['const', {v:100.1e6}], ['numview', {}], ['sa', {}]], [...RX, '0.iq>5.in', '6.out>1.freq', '1.offset>7.in', '5.spec>8.spec']], async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      ns[1].p.offset = 0;
      await T.realtime(1);
      if(ns[1].out.offset !== 100000) return 'offset '+ns[1].out.offset;
      const sp = ns[5].out.spec; if(!sp || !sp.freqs) return 'no spectrum';
      let k = 0; for(let i=1; i<sp.mag.length; i++) if(sp.mag[i] > sp.mag[k]) k = i;
      if(Math.abs(sp.freqs[k]-100.1e6) > 5000) return 'peak at '+sp.freqs[k];
      // параметр меняется на ходу — уходит в воркер со следующим тактом
      ns[3].p.mode = 'AM';
      await T.realtime(0.5);
      return ns[3].ui?.sr === 64000 && ns[3].p.mode === 'AM' || 'ui '+JSON.stringify(ns[3].ui);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'islands: rewiring keeps the worker and node state', arg:[FM, RX], async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      const isl = ns[0]._isl, worker = isl.w;
      await T.realtime(0.5);
      delEdge(Graph.edges.find(e => e.from === ns[3].id));     // демодулятор → мост
      retopo();
      if(ns[0]._isl.w !== worker) return 'worker replaced';
      addEdge(ns[3].id, 'out', ns[4].id, 'in'); retopo();
      const a = [];
      await T.realtime(1.5, t => { if(t > 0.8) a.push(...ns[4].out.out); });
      const f = T.toneHz(Float32Array.from(a), Eng.sr);
      return Math.abs(f-1000) < 2 || `f=${f.toFixed(2)}`;
    } finally { Islands.setEnabled(false); }
  }},
  {name:'islands: no workers allowed → main thread', arg:[FM, RX], fn([g, w]){
    const W = window.Worker;
    window.Worker = function(){ throw new Error('blocked'); };
    try{
      Islands.setEnabled(true);
      const ns = T.build(g, w);
      if(Islands.enabled || ns.some(n => n._isl)) return 'islands still on';
      const a = T.capture(ns[4], 'out', 1, 0.5), f = T.toneHz(a, Eng.sr);
      return Math.abs(f-1000) < 2 || `f=${f.toFixed(2)}`;
    } finally { window.Worker = W; Islands.setEnabled(false); }
  }},
  {name:'islands: worker script fails to load → main thread', arg:[FM, RX], async fn([g, w]){
    const W = window.Worker;
    window.Worker = function(){ return new W('no-such-worker.js'); };
    try{
      Islands.setEnabled(true);
      const ns = T.build(g, w);
      await T.realtime(0.5);
      if(Islands.enabled || ns.some(n => n._isl)) return 'islands still on';
      const a = T.capture(ns[4], 'out', 1, 0.5), f = T.toneHz(a, Eng.sr);
      return Math.abs(f-1000) < 2 || `f=${f.toFixed(2)}`;
    } finally { window.Worker = W; Islands.setEnabled(false); }
  }},
];
