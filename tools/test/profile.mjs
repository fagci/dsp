// Профиль главного потока: пресет с USB SDR на синтезированном IQ-файле (2.4 MS/s, WFM),
// 6 с CPU-профиля, подвисания по логу движка, топ функций по собственному времени.
// Запуск: node profile.mjs ["имя пресета" | baseline]  (baseline — SDR со своим демодулятором)
import {chromium} from 'playwright';
import {serve} from './serve.mjs';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const {srv, url} = await serve(root);
const b = await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
const ctx = await b.newContext({viewport:{width:1600,height:1000}});
const p = await ctx.newPage();
let stalls=[]; p.on('console', m => { const t=m.text(); const r=/stall ~(\d+)ms/.exec(t); if(r && started) stalls.push(+r[1]); });
let started=false;
await p.goto(url);
await p.waitForFunction(() => window.crossOriginIsolated === true && document.readyState==='complete' && typeof Graph === 'object', null, {timeout:15000});
const preset = process.argv[2] || 'USB SDR: FM Receiver from Blocks';
await p.evaluate(async (preset) => {
  const sr = 2400000, L = sr*4, u8 = new Uint8Array(2*L);
  let ph = 0;
  for(let i=0; i<L; i++){
    ph += 2*Math.PI*(100000 + 50000*Math.sin(2*Math.PI*1000*i/sr))/sr;
    u8[2*i] = Math.round(127.5+40*Math.cos(ph)+ (Math.random()-.5)*6); u8[2*i+1] = Math.round(127.5+40*Math.sin(ph)+(Math.random()-.5)*6);
  }
  if(preset==='baseline'){ clearAll(); const rx=addNode('rtlsdr',40,40,{sr:'2400000',demod:'WFM'}); const sa=addNode('sa',400,40,{auto:true}); const dc=addNode('dac',400,400,{});
    addEdge(rx.id,'spec',sa.id,'spec'); addEdge(rx.id,'audioL',dc.id,'L'); addEdge(rx.id,'audioR',dc.id,'R'); }
  else PRESETS[preset]();
  retopo();
  const rx = Graph.nodes.find(n => n.type==='rtlsdr');
  rx.p.sr='2400000';
  const src = await iqParseFiles([new File([u8], 'test_100000000Hz_2.4Msps.cu8')], 'auto');
  const dev = iqFileDevice(src, 2400000, 100000000);
  dev.onFreq = f => { rx.actualFreq = f; rx.p.freq = f; rx.appliedFreq = f; };
  rx.p.freq = await dev.setCenterFrequency(); rx.dev = dev;
  await rtlStart(rx, dev.rate);
  window._lt=[]; new PerformanceObserver(l => { for(const e of l.getEntries()) _lt.push(e.duration); }).observe({type:'longtask', buffered:false});
}, preset);
await p.click('#run');
await p.waitForTimeout(3000);
const cdp = await ctx.newCDPSession(p);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {interval:200});
await cdp.send('Profiler.start'); started=true;
await p.waitForTimeout(6000);
const {profile} = await cdp.send('Profiler.stop');
const info = await p.evaluate(() => ({lt:_lt.length, ltMax:Math.max(0,..._lt).toFixed(0), ltSum:_lt.reduce((a,b)=>a+b,0).toFixed(0), load:Eng.load.toFixed(2), isl:Islands.list.length,
  audio:Graph.nodes.find(n=>n.type==='iqAudio')?.state}));
console.log(info, 'stalls in 6 s:', stalls.length, 'max', Math.max(0,...stalls), 'sum', stalls.reduce((a,b)=>a+b,0));
// self time по функциям
const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
const dt = profile.timeDeltas; const counts = new Map();
profile.samples.forEach((id, i) => counts.set(id, (counts.get(id)||0) + (dt[i]||0)));
for(const [id, us] of counts){ const n = byId.get(id), cf = n.callFrame;
  const key = (cf.functionName||'(anon)')+' '+cf.url.split('/').pop().split('?')[0]+':'+cf.lineNumber;
  self.set(key, (self.get(key)||0)+us); }
const total = [...self.values()].reduce((a,b)=>a+b,0);
console.log('total ms', (total/1000).toFixed(0));
for(const [k,v] of [...self].sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log((v/1000).toFixed(0).padStart(6), (100*v/total).toFixed(1).padStart(5)+'%', k);
await b.close(); srv.close();
