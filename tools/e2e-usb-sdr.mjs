// Лаборатория на живом SDR: открывает настоящий донгл через WebUSB тем же кодом страницы
// (modules/sources.js, узел USB SDR), крутит граф и снимает статистику приёмника — без rtl_tcp,
// без моста и без синтетики. Первый раз нужно один раз выбрать устройство в окне Chrome:
//
//   node tools/e2e-usb-sdr.mjs --grant          # headed, chooser, разрешение остаётся в профиле
//   node tools/e2e-usb-sdr.mjs                  # headless, 6 с на 100 МГц, таблица + сводка
//   node tools/e2e-usb-sdr.mjs --freq 104.4M --ppm 54 --gain 20 --sec 10 --json /tmp/sdr.jsonl
//   node tools/e2e-usb-sdr.mjs --hop 104.4M,104.8M --hop-sec 2 --capture /tmp/cap.sigmf
//   node tools/e2e-usb-sdr.mjs --replay /tmp/cap.sigmf --demod WFM --sec 5   # реальная запись в граф
//   node tools/e2e-usb-sdr.mjs --stress --sr 3200000 --freq 104.4M   # живой донгл, max sample rate
//
// Проверяются: Connect/Disconnect, захват PLL, реальная частота и частота дискретизации, ADC
// peak/rms/clip/overload, RSSI/SNR, звук, кадры спектра, перестройка, недоборы; --capture пишет IQ
// через штатный IQ Recorder страницы (SigMF/cu8 по умолчанию, --wav — WAV) и охватывает весь прогон,
// включая --hop; --capture-sec — минимальная длина прогона. --replay проигрывает такую запись через
// IQ File Player — тот же путь, что «Open IQ file…», и даёт повторяемые данные (до 64 МБ).
// --stress — режим нагрузки: max sample rate, тяжёлый непрерывный спектр, плюс кадры rAF, long tasks
// и счётчики браузера (TaskDuration/ScriptDuration). По умолчанию 1 канал; --channels 4 — предел.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultProfile, launchChrome, attachPage, evaluate, openApp, serve, grantDevice, sleep} from './lab-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def = null) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const has = name => argv.includes('--' + name);
const hz = s => { const m = /^([\d.]+)\s*([kKmMgG]?)$/.exec(String(s).trim()); if(!m) throw new Error('bad frequency: ' + s);
  return Math.round(+m[1] * (m[2] ? {k: 1e3, m: 1e6, g: 1e9}[m[2].toLowerCase()] : 1)); };

const profile = path.resolve(String(arg('profile', defaultProfile())));
const deviceFile = path.join(profile, 'device.json');
const headed = has('headed') || has('grant');
const stress = has('stress');
const sec = +arg('sec', stress ? 10 : 6), sampleMs = +arg('sample', stress ? 250 : 500), hopSec = +arg('hop-sec', 2);
const freqArg = hz(arg('freq', 100e6)), sr = +arg('sr', stress ? 3200000 : 1024000), demod = String(arg('demod', 'WFM'));
const gain = String(arg('gain', 'auto')), ppm = +arg('ppm', 0);
// --stress поднимает самый дорогой спектр; каналы и поля можно переопределить руками.
const channels = Math.max(1, Math.min(4, +arg('channels', 1)));
const specOpts = {};
if(stress || arg('spec', null) != null) specOpts.specSize = String(arg('spec', '262144'));
if(stress || arg('spec-cont', null) != null) specOpts.specCont = String(arg('spec-cont', '1')) !== '0';
if(stress || arg('spec-fps', null) != null) specOpts.specFps = String(arg('spec-fps', '60'));
if(arg('spec-avg', null) != null) specOpts.specAvg = String(arg('spec-avg'));
if(stress) specOpts.specCover = '100';
if(has('stereo')) specOpts.stereo = true;
const nodeExtra = JSON.stringify(specOpts);
const hops = arg('hop') ? String(arg('hop')).split(',').map(hz) : null;
const freq = hops ? hops[0] : freqArg;             // с --hop стартуем сразу на первой частоте
const port = +arg('port', 8124);                    // grant привязан к origin: не меняй без --grant
const jsonPath = arg('json', null);
const capturePath = arg('capture', null), captureSec = +arg('capture-sec', 4);
const wav = has('wav') || /\.wav$/i.test(String(capturePath || ''));
const replayPath = arg('replay', null);
const MAX_REPLAY = 64 << 20;                        // больше — не тянем целиком через CDP (см. --capture/--replay)
const bad = [];
const say = (...a) => console.log(...a);
const readDevice = () => { try{ return JSON.parse(fs.readFileSync(deviceFile, 'utf8')); }catch(e){ return null; } };
const saveDevice = d => { try{ fs.mkdirSync(profile, {recursive: true}); fs.writeFileSync(deviceFile, JSON.stringify(d, null, 1) + '\n'); }catch(e){} };

// Снимок узла USB SDR: поля модуля (n, n.out) + дешёвая сводка по спектру (дБ) и RMS звука.
const SNAP = `(()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr');if(!n)return null;
  const o=n.out||{}, sp=n.spec; let sx=null;
  if(sp&&sp.mag&&sp.mag.length){ const N=sp.mag.length, step=Math.max(1,N>>10), db=[];
    for(let i=0;i<N;i+=step) db.push(20*Math.log10((sp.mag[i]||1e-12)));
    db.sort((a,b)=>a-b); sx={n:N, med:+db[db.length>>1].toFixed(1), p95:+db[Math.floor(db.length*.95)].toFixed(1), max:+db[db.length-1].toFixed(1)}; }
  let ar=null; if(o.audio&&o.audio.length){ let s=0; for(let i=0;i<o.audio.length;i++) s+=o.audio[i]*o.audio[i]; ar=+Math.sqrt(s/o.audio.length).toFixed(4); }
  return {t:Date.now(), on:!!n.connected, status:n.status, freq:Math.round(n.actualFreq||0), tune:n.ch[0].tuneFreq==null?null:Math.round(n.ch[0].tuneFreq), sr:n.sourceRate,
    adcPk:n.adcPk==null?null:+n.adcPk.toFixed(1), adcRms:n.adcRms==null?null:+n.adcRms.toFixed(1),
    clip:n.adcClip==null?null:+(100*n.adcClip).toFixed(3), ovl:sdrAdcOvl(n)?1:0,
    rssi:o.rssi==null?null:+o.rssi.toFixed(1), snr:o.snr==null?null:+o.snr.toFixed(1), sq:o.sqOpen??null,
    audio:ar, spec:sx, specRev:(n.spec&&n.spec.rev)||0, tuneMs:n._lastTuneMs==null?null:+n._lastTuneMs.toFixed(1),
    samples:n.specRing?n.specRing.written:null, ch:n.ch.filter(c=>c.active).length,
    msps:n.msps==null?null:+n.msps.toFixed(3), mspsIo:n.mspsIo==null?null:+n.mspsIo.toFixed(3),
    workerMs:n.workerMs==null?null:+n.workerMs.toFixed(2), roundtripMs:n.roundtripMs==null?null:+n.roundtripMs.toFixed(2),
    demMs:n._demMs==null?null:+n._demMs.toFixed(2), specCost:n._specCost==null?null:+n._specCost.toFixed(2),
    fftMs:n._fftMs==null?null:+n._fftMs.toFixed(3), cover:n._specCover==null?null:+n._specCover.toFixed(2),
    load:n._specLoad==null?null:+n._specLoad.toFixed(2), inflight:n._inFlight|0,
    under:[n.underrunsWorker|0,n.underrunsOverflow|0,n.underrunsStarve|0]};})()`;

const median = a => { const v = a.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
const pct = (a, p) => { const v = a.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null; };

// Кадры rAF и long tasks — то, что видит пользователь. Счётчики Performance — сколько времени
// рендерер реально жёг CPU (TaskDuration), отдельно скрипт/вёрстка/стили.
async function startStress(page){
  await page.send('Performance.enable').catch(() => {});
  return evaluate(page, `(()=>{
    const S=window.__stress={frames:[],long:[],loaf:[],t0:performance.now()};
    let last=performance.now();
    const tick=t=>{ const d=t-last; last=t; if(d>0 && d<2000) S.frames.push(d); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try{ S.po=new PerformanceObserver(l=>{ for(const e of l.getEntries()) S.long.push({d:e.duration,t:e.startTime-S.t0}); }); S.po.observe({type:'longtask',buffered:true}); }catch(e){}
    try{ S.polo=new PerformanceObserver(l=>{ for(const e of l.getEntries()) S.loaf.push({d:e.duration,t:e.startTime-S.t0,
      scripts:(e.scripts||[]).map(s=>({url:s.sourceURL||'',fn:s.sourceFunctionName||s.functionName||'',inv:s.invoker||'',d:s.duration||0}))}); });
      S.polo.observe({type:'long-animation-frame',buffered:true}); }catch(e){}
    return 1; })()`);
}
async function perfMetrics(page){
  try{ const r=await page.send('Performance.getMetrics'); const m={}; for(const x of r.metrics) m[x.name]=x.value; return m; }catch(e){ return null; }
}
async function stressStats(page, pm0, pm1, wallSec){
  const {frames, long, loaf} = await evaluate(page, `({frames:window.__stress?window.__stress.frames.slice():[],
    long:window.__stress?window.__stress.long.slice():[],loaf:window.__stress?window.__stress.loaf.slice():[]})`);
  const d = (k) => pm0 && pm1 && pm0[k] != null && pm1[k] != null ? pm1[k] - pm0[k] : null;
  // buffered:true отдаёт и события до старта монитора — у них t<0 (загрузка страницы/Connect), их не считаем
  const longRun=long.filter(x=>x.t>=0), loafRun=loaf.filter(x=>x.t>=0);
  const ld=longRun.map(x=>x.d), scripts=new Map();
  for(const f of loafRun) for(const s of f.scripts||[]){
    const k=(s.fn||'?')+' @ '+(s.url||'?').replace(/^.*\//,'');
    const v=scripts.get(k)||{k,max:0,sum:0,n:0}; v.max=Math.max(v.max,s.d); v.sum+=s.d; v.n++; scripts.set(k,v);
  }
  return {
    frames: {n:frames.length, p50:pct(frames,.5), p95:pct(frames,.95), p99:pct(frames,.99), max:frames.length?Math.max(...frames):null,
      over33:frames.filter(x=>x>33).length, over50:frames.filter(x=>x>50).length},
    longtasks: {n:longRun.length, max:ld.length?Math.max(...ld):null, total:ld.reduce((a,b)=>a+b,0),
      list:longRun.slice(0,8), top:[...scripts.values()].sort((a,b)=>b.sum-a.sum).slice(0,6)},
    cpu: {task:d('TaskDuration'), script:d('ScriptDuration'), layout:d('LayoutDuration'), recalc:d('RecalcStyleDuration'),
      ratio:wallSec>0&&d('TaskDuration')!=null?d('TaskDuration')/wallSec:null}
  };
}
function printStress(res, rows, wallSec){
  const s=res.stress; if(!s) return;
  const f=s.frames, l=s.longtasks, c=s.cpu, ms=x=>x==null?'-':(+x).toFixed(1);
  say(`\nstress ${wallSec.toFixed(1)} с · каналов ${median(rows.map(r=>r.ch))||'?'} · ${res.sr} Гц · спектр ${median(rows.map(r=>r.spec&&r.spec.n))||'?'} бинов · ${(res.specFrames/wallSec).toFixed(1)} кадр/с`);
  say(`  rAF: n=${f.n} p50=${ms(f.p50)} p95=${ms(f.p95)} p99=${ms(f.p99)} max=${ms(f.max)} мс · >33мс ${f.over33} · >50мс ${f.over50}`);
  say(`  long tasks: n=${l.n} max=${ms(l.max)} мс · сумма ${ms(l.total)} мс · ${l.list.map(x=>`${ms(x.d)}@${ms(x.t)}`).join(' ')}`);
  if(l.top.length) say(`  LoAF: ${l.top.map(x=>`${x.k} ${x.sum.toFixed(0)}мс/${x.n}`).join(' · ')}`);
  say(`  CPU renderer: task ${ms(c.task)} с (${c.ratio==null?'-':(100*c.ratio).toFixed(1)}%) · script ${ms(c.script)} · layout ${ms(c.layout)} · style ${ms(c.recalc)}`);
  const io=median(rows.map(r=>r.mspsIo)), dem=median(rows.map(r=>r.msps)), wr=median(rows.map(r=>r.workerMs));
  const dr=res.deliveredRate==null?'-':(res.deliveredRate/1e6).toFixed(3);
  say(`  поток: mspsIo=${io==null?'-':io.toFixed(3)} msps=${dem==null?'-':dem.toFixed(3)} delivered=${dr} MSps worker=${ms(wr)} мс · underruns ${res.underruns.join('/')} (+${res.underrunsRun.join('/')} за прогон, ${res.underrunsSteady.join('/')} после 2 с)`);
  return {io, dem};
}

async function connectUsb(page, usbId){
  return evaluate(page, `(async()=>{
    clearAll();
    const n = addNode('rtlsdr', 80, 80, {freq:${freq}, sr:'${sr}', demod:${JSON.stringify(demod)}, usbId:${JSON.stringify(usbId)},
      ppm:${ppm}, auto:${gain === 'auto'}, gainDb:${gain === 'auto' ? 32 : +gain}, ...${nodeExtra}});
    await rtlConnect(n, false);
    // канал 1 по умолчанию стоит на центре, но без провода tuneFreq узел не строит полосу
    // канала и не считает SNR (в обычном патче частоту задаёт маркер спектроанализатора) —
    // ставим Constant на центр. sdrCenter, а не actualFreq: для AM/SAM/USB/LSB (и dcShift)
    // железо стоит на sr/4 выше логического центра, и actualFreq увёл бы канал на чужие частоты.
    const c = addNode('const', 80, 300, {v: Math.round(sdrCenter(n))});
    addEdge(c.id, 'out', n.id, 'tuneFreq'); markWiresDirty();
    // --stress: остальные каналы — NCO-офсеты в захваченной полосе, все демодулируются параллельно
    for(let i=1;i<${channels};i++){
      const ci=addNode('const', 80, 300+i*80, {v:Math.round(sdrCenter(n)+i*n.sourceRate*0.15)});
      addEdge(ci.id, 'out', n.id, 'tuneFreq'+(i+1)); markWiresDirty();
    }
    await Eng.start();
    return {status:n.status, connected:!!n.connected, tuner:n.dev&&n.dev.tunerName, rate:n.sourceRate, freq:n.actualFreq};
  })()`, {userGesture: true});
}

// Проигрывание реальной записи через IQ File Player: файл передаётся в страницу кусками base64.
async function connectReplay(page, file){
  const name = path.basename(file), b = fs.readFileSync(file), CH = 1 << 20;
  await evaluate(page, 'window.__labChunks=[]; 0');
  for(let off = 0; off < b.length; off += CH){
    const b64 = b.subarray(off, off + CH).toString('base64');
    await evaluate(page, `window.__labChunks.push(Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0))); window.__labChunks.length`);
  }
  return evaluate(page, `(async()=>{
    clearAll();
    const n = addNode('rtlsdr', 80, 80, {demod:${JSON.stringify(demod)}, iqFmt:'auto', loop:true, ...${nodeExtra}});
    const f = new File(window.__labChunks, ${JSON.stringify(name)}, {type:${JSON.stringify(name.endsWith('.sigmf') ? 'application/x-tar' : name.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream')}});
    window.__labChunks = [];
    await iqOpenFile(n, [f]);
    const c = addNode('const', 80, 300, {v: Math.round(sdrCenter(n))});
    addEdge(c.id, 'out', n.id, 'tuneFreq'); markWiresDirty();
    for(let i=1;i<${channels};i++){
      const ci=addNode('const', 80, 300+i*80, {v:Math.round(sdrCenter(n)+i*n.sourceRate*0.15)});
      addEdge(ci.id, 'out', n.id, 'tuneFreq'+(i+1)); markWiresDirty();
    }
    // SigMF с перестройками: iqFileDevice зовёт onFreq на каждом captures-сегменте —
    // ведём Constant за файлом, иначе канал останется на частоте первого сегмента
    const prev = n.dev && n.dev.onFreq;
    if(n.dev) n.dev.onFreq = f => { prev?.(f); c.p.v = f; };
    await Eng.start();   // с жестом: без него AudioContext в headless остаётся suspended и граф не тикает
    return {status:n.status, connected:!!n.connected, tuner:n.dev&&n.dev.tunerName, rate:n.sourceRate, freq:n.actualFreq, file:!!n.dev&&n.dev.kind==='file'};
  })()`, {userGesture: true});
}

// Запись IQ штатным рекордером узла (кнопка ● Record IQ): старт до прогона, стоп после —
// так --hop перестраивается внутри записи и в файле появляются все сегменты.
async function startCapture(page){
  const cap = await evaluate(page, `(async()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr');
    n.p.recDest='file / download'; n.p.recFmt='${wav ? 'WAV' : 'SigMF'}'; n.p.recBand='full'; n.p.tag='lab';
    await iqRecStart(n); return n.rec ? {name:n.rec.name} : null;})()`);
  if(!cap) return null;
  say('запись IQ:', cap.name);
  return cap.name;
}

// Остановить запись и выгрузить Blob в файл.
async function stopCapture(page, out){
  const st = await evaluate(page, `(async()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr');
    window.showSaveFilePicker=()=>Promise.reject(Object.assign(new Error('lab'),{name:'AbortError'}));
    await iqRecStop(n);
    const r=n.recDone; if(!r||!r.blob) return null;
    window.__labBlob=r.blob; return {name:r.name,size:r.blob.size,bps:r.bps,rate:r.rate,freq:r.freq};})()`);
  if(!st) return null;
  const dst = path.resolve(String(out));
  fs.mkdirSync(path.dirname(dst), {recursive: true});
  fs.writeFileSync(dst, Buffer.alloc(0));
  const CH = 2 << 20;
  for(let off = 0; off < st.size; off += CH){
    const b64 = await evaluate(page, `(async()=>{const u=new Uint8Array(await window.__labBlob.slice(${off},${Math.min(off + CH, st.size)}).arrayBuffer());
      let s=''; for(let i=0;i<u.length;i+=32768) s+=String.fromCharCode.apply(null,u.subarray(i,i+32768)); return btoa(s);})()`);
    fs.appendFileSync(dst, Buffer.from(b64, 'base64'));
  }
  await evaluate(page, `(()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr'); if(n) n.recDone=null; window.__labBlob=null; return 1;})()`).catch(() => {});
  return {...st, out: dst, seconds: st.size / st.bps / st.rate};
}

async function collect(page, {total, tuner, kind}){
  const rows = [], t0 = Date.now(); let hi = 0;
  say('t, мс | freq, МГц | ADC pk/rms | clip % | RSSI | SNR | audio | spec med/p95 | tune мс');
  while(Date.now() - t0 < total * 1000){
    if(hops && kind === 'usb'){
      const want = hops[Math.min(hops.length - 1, Math.floor((Date.now() - t0) / (hopSec * 1000)))];
      if(want !== hi){
        hi = want;
        await evaluate(page, `(()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr'); n.p.freq=${want};
          const c=Graph.nodes.find(x=>x.type==='const'); if(c) c.p.v=${want}; return 1;})()`);
      }
    }
    const r = await evaluate(page, SNAP); if(!r) break;
    rows.push(r);
    say(`${String(rows.length).padStart(2)} | ${(r.freq / 1e6).toFixed(4)} | ${r.adcPk ?? '-'}/${r.adcRms ?? '-'} | ${r.clip ?? '-'} | ${r.rssi ?? '-'} | ${r.snr ?? '-'} | ${r.audio ?? '-'} | ${r.spec ? r.spec.med + '/' + r.spec.p95 : '-'} | ${r.tuneMs ?? '-'}`);
    if(jsonPath) fs.appendFileSync(path.resolve(String(jsonPath)), JSON.stringify(r) + '\n');
    await sleep(sampleMs);
  }
  const sum = rows.reduce((a, r) => { a.ovl += r.ovl; return a; }, {ovl: 0});
  const last = rows[rows.length - 1] || {}, first = rows[0] || {};
  // счётчики в узле накопительные: суммировать их по сэмплам нельзя (каждая строка повторяет итог).
  // Для стресса важнее прирост за прогон, а не всё с момента Connect.
  const under = last.under || [0, 0, 0], under0 = first.under || under;
  const underRun = under.map((v, i) => Math.max(0, v - (under0[i] | 0)));
  // стартовые догоны кольца и первая перестройка — не показатель: для порога берём участок после 2 с
  const mid = rows[Math.min(rows.length - 1, Math.max(0, Math.round(2000 / sampleMs)))] || first;
  const underSteady = under.map((v, i) => Math.max(0, v - ((mid.under || under)[i] | 0)));
  // реально доехавшие до кольца отсчёты / время между сэмплами (не mspsIo, который меряет интервалы
  // между чанками и потому видит задержки доставки). Если меньше sourceRate — донгл/хост теряет поток.
  const secs = rows.length > 1 ? (last.t - first.t) / 1000 : 0;
  const srcRate = secs > 0 && last.samples != null && first.samples != null ? (last.samples - first.samples) / secs : null;
  const res = {
    kind, ok: rows.length > 0, samples: rows.length, connected: rows.filter(r => r.on).length,
    freq: median(rows.map(r => r.freq)), chanTune: median(rows.map(r => r.tune)), sr: rows[rows.length - 1]?.sr, tuner,
    adcRms: median(rows.map(r => r.adcRms)), adcPkMax: rows.length ? Math.max(...rows.map(r => r.adcPk ?? -999)) : null,
    clipMax: rows.length ? Math.max(...rows.map(r => r.clip ?? 0)) : null, ovlSamples: sum.ovl,
    rssi: median(rows.map(r => r.rssi)), snr: median(rows.map(r => r.snr)), audioRms: median(rows.map(r => r.audio)),
    specFrames: rows.length > 1 ? rows[rows.length - 1].specRev - rows[0].specRev : 0,
    specMed: median(rows.map(r => r.spec && r.spec.med)), specP95: median(rows.map(r => r.spec && r.spec.p95)),
    tuneMsMax: rows.length ? Math.max(...rows.map(r => r.tuneMs ?? 0)) : null, underruns: under, underrunsRun: underRun,
    underrunsSteady: underSteady, deliveredRate: srcRate,
  };
  return {rows, res};
}

// Файл для --replay проверяем до запуска Chrome: не тратим профиль и не грузим гигабайты в память.
const replayFile = replayPath ? path.resolve(String(replayPath)) : null;
if(replayFile){
  if(!fs.existsSync(replayFile)){ say('FAIL: no such IQ file: ' + replayFile); process.exit(1); }
  const sz = fs.statSync(replayFile).size;
  if(sz > MAX_REPLAY){
    say(`FAIL: replay ${(sz >> 20)} МиБ > ${MAX_REPLAY >> 20} МиБ — сократи запись (--capture-sec) или открой её в IQ File Player в браузере`);
    process.exit(1);
  }
}

const staticSrv = await serve(root, port);
const {proc, cdp} = launchChrome({headless: !headed, profile});
const pageErrors = [], notes = [];
try{
  const page = await attachPage(cdp);
  cdp.on(m => {
    if(m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
    if(m.method === 'Runtime.consoleAPICalled'){
      const s = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if(/перестройка|retune|ring trend|USB SDR|rtlsdr|audio ring|backpressure/i.test(s)) notes.push(s.slice(0, 300));
    }
  });
  await openApp(page, staticSrv.url + '/index.html');

  // Список поддерживаемых SDR — из самого приложения: grant/выбор не должны брать первое
  // попавшееся разрешённое устройство (serial, телефон) вместо донгла.
  const sdrFilters = await evaluate(page, 'SDR_USB_FILTERS').catch(() => null);
  const matches = (filters, d) => filters.some(f => f.vendorId === d.vid && (f.productId == null || f.productId === d.pid));
  const isSdr = d => !Array.isArray(sdrFilters) || !sdrFilters.length || matches(sdrFilters, d);
  const granted = () => evaluate(page, `navigator.usb.getDevices().then(ds=>ds.map(d=>({usbId:d.vendorId.toString(16)+':'+d.productId.toString(16)+':'+(d.serialNumber||''), vid:d.vendorId, pid:d.productId, name:d.productName||''})))`);

  if(has('grant')){
    const vid = arg('vid', null), pid = arg('pid', null);
    const filters = vid ? [{vendorId: parseInt(vid, 16), ...(pid ? {productId: parseInt(pid, 16)} : {})}]
      : (Array.isArray(sdrFilters) && sdrFilters.length ? sdrFilters : []);
    const have = (await granted()).find(d => !filters.length || matches(filters, d));
    if(have) say('уже разрешено:', have.name || have.usbId, '→', have.usbId);
    else{
      say('В окне Chrome выбери SDR-донгл' + (vid ? ` (${vid}${pid ? ':' + pid : ''})` : '') + '…');
      const d = await grantDevice(page, {filters, file: deviceFile, timeout: +arg('grant-timeout', 180)});
      say('разрешено:', d.productName || d.usbId, '→', d.usbId);
    }
    say('профиль:', profile);
  }else{
    let setup;
    if(replayPath){
      const file = replayFile, st = fs.statSync(file);
      say(`replay: ${file} · ${(st.size / 1e6).toFixed(1)} МБ · ${demod}`);
      setup = await connectReplay(page, file);
      say('open IQ:', setup.status, setup.connected ? `· ${setup.tuner || ''} · ${setup.rate} Гц · ${setup.freq} Гц` : '');
      if(capturePath) say('--capture в режиме replay игнорируется');
    }else{
      const list = await granted();
      const saved = readDevice();
      const pick = (saved && list.find(d => d.usbId === saved.usbId && isSdr(d))) || list.find(isSdr) || list[0] || null;
      if(!pick){ say('нет разрешения на USB: один раз запусти `node tools/e2e-usb-sdr.mjs --grant` и выбери донгл'); bad.push('no WebUSB grant'); }
      else if(!isSdr(pick)){ say(`разрешено не SDR-устройство (${pick.name || pick.usbId}); запусти --grant и выбери донгл`); bad.push('granted device is not an SDR'); }
      else{
        if(!saved || saved.usbId !== pick.usbId) saveDevice(pick);
        const usbId = pick.usbId;
        say(`USB SDR: ${usbId}${pick.name ? ' (' + pick.name + ')' : ''} · ${hops ? hops.map(f => (f / 1e6) + ' МГц').join(' → ') : freq + ' Гц'} · ${sr} Гц · ${demod} · gain ${gain}${ppm ? ' · ppm ' + ppm : ''}`);
        setup = await connectUsb(page, usbId);
        say('connect:', setup.status, setup.connected ? '· ' + (setup.tuner || '') : '');
      }
    }
    if(setup && !setup.connected){ bad.push('not connected: ' + setup.status); }
    else if(setup){
      const total = hops && !replayPath ? hops.length * hopSec : sec;
      // запись стартует до прогона и заканчивается после: --hop перестраивается внутри записи,
      // --capture-sec — минимальная длина прогона, а не отдельный кусок перед ним
      const runSec = Math.max(total, capturePath && !replayPath ? captureSec : 0);
      let pm0=null;
      if(stress){ await startStress(page); pm0=await perfMetrics(page); }
      const stressT0=Date.now();
      const capName = capturePath && !replayPath ? await startCapture(page) : null;
      if(capturePath && !replayPath && !capName) bad.push('capture did not start');
      const {rows, res} = await collect(page, {total: runSec, tuner: setup.tuner, kind: replayPath ? 'replay' : 'usb'});
      const wallSec=(Date.now()-stressT0)/1000;
      if(capName){
        const cap = await stopCapture(page, capturePath).catch(e => { bad.push('capture: ' + e.message); return null; });
        if(!cap){ if(!bad.length) bad.push('capture produced no blob'); }
        else{
          say('IQ сохранено:', cap.out, `· ${(cap.size / 1e6).toFixed(1)} МБ · ${cap.seconds.toFixed(2)} с · ${cap.rate} Гц · ${cap.freq} Гц`);
          if(cap.seconds < runSec * 0.5) bad.push('short capture: ' + cap.seconds.toFixed(2) + ' s');
        }
      }
      say('\nсводка:', JSON.stringify(res));
      if(notes.length) say('заметки:', notes.slice(-4).join(' | '));
      if(!res.samples) bad.push('no samples');
      if(res.specFrames === 0 && !res.audioRms) bad.push('no spectrum and no audio');
      if(pageErrors.length) bad.push('page errors: ' + pageErrors[0]);
      if(res.underruns.some(x => x > 0)) notes.push('underruns: ' + res.underruns.join('/'));
      if(stress){
        res.stress = await stressStats(page, pm0, await perfMetrics(page), wallSec);
        const perf = printStress(res, rows, wallSec);
        if(res.underrunsSteady.some(x => x > 0)) bad.push('steady-state underruns (worker/overflow/starve): ' + res.underrunsSteady.join('/'));
        if(perf.io != null && perf.io * 1e6 < sr * 0.95) bad.push(`throughput ${perf.io.toFixed(3)} MSps < ${(sr*0.95/1e6).toFixed(3)}`);
        if(res.stress.frames.n && res.stress.frames.p95 > 50) bad.push(`rAF p95 ${res.stress.frames.p95.toFixed(1)} ms > 50`);
        if(res.stress.frames.max > 250) bad.push(`rAF max ${res.stress.frames.max.toFixed(1)} ms > 250`);
        if(res.stress.longtasks.max > 150) bad.push(`long task ${res.stress.longtasks.max.toFixed(1)} ms > 150`);
      }
      await evaluate(page, `(async()=>{const n=Graph.nodes.find(x=>x.type==='rtlsdr'); if(n) await rtlDisconnect(n); return 1;})()`).catch(() => {});
    }
  }
}catch(e){
  bad.push(e.message);
  if(pageErrors.length) say('page errors:', pageErrors.slice(0, 3));
}finally{
  cdp.close();
  staticSrv.close();
  try{ proc.kill('SIGKILL'); }catch(e){}
}
if(bad.length){ say('\nFAIL:', bad.join('; ')); process.exit(1); }
say('\nok');
