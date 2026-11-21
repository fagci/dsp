// Лаборатория на живом SDR: открывает настоящий донгл через WebUSB тем же кодом страницы
// (modules/sources.js, узел USB SDR), крутит граф и снимает статистику приёмника — без rtl_tcp,
// без моста и без синтетики. Первый раз нужно один раз выбрать устройство в окне Chrome:
//
//   node tools/e2e-usb-sdr.mjs --grant          # headed, chooser, разрешение остаётся в профиле
//   node tools/e2e-usb-sdr.mjs                  # headless, 6 с на 100 МГц, таблица + сводка
//   node tools/e2e-usb-sdr.mjs --freq 104.4M --ppm 54 --gain 20 --sec 10 --json /tmp/sdr.jsonl
//   node tools/e2e-usb-sdr.mjs --hop 104.4M,104.8M --hop-sec 2 --capture /tmp/cap.sigmf
//   node tools/e2e-usb-sdr.mjs --replay /tmp/cap.sigmf --demod WFM --sec 5   # реальная запись в граф
//
// Проверяются: Connect/Disconnect, захват PLL, реальная частота и частота дискретизации, ADC
// peak/rms/clip/overload, RSSI/SNR, звук, кадры спектра, перестройка, недоборы; --capture пишет IQ
// через штатный IQ Recorder страницы (SigMF/cu8 по умолчанию, --wav — WAV) и охватывает весь прогон,
// включая --hop; --capture-sec — минимальная длина прогона. --replay проигрывает такую запись через
// IQ File Player — тот же путь, что «Open IQ file…», и даёт повторяемые данные (до 64 МБ).
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
const sec = +arg('sec', 6), sampleMs = +arg('sample', 500), hopSec = +arg('hop-sec', 2);
const freqArg = hz(arg('freq', 100e6)), sr = +arg('sr', 1024000), demod = String(arg('demod', 'WFM'));
const gain = String(arg('gain', 'auto')), ppm = +arg('ppm', 0);
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
    under:[n.underrunsWorker|0,n.underrunsOverflow|0,n.underrunsStarve|0]};})()`;

const median = a => { const v = a.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };

async function connectUsb(page, usbId){
  return evaluate(page, `(async()=>{
    clearAll();
    const n = addNode('rtlsdr', 80, 80, {freq:${freq}, sr:'${sr}', demod:${JSON.stringify(demod)}, usbId:${JSON.stringify(usbId)},
      ppm:${ppm}, auto:${gain === 'auto'}, gainDb:${gain === 'auto' ? 32 : +gain}});
    await rtlConnect(n, false);
    // канал 1 по умолчанию стоит на центре, но без провода tuneFreq узел не строит полосу
    // канала и не считает SNR (в обычном патче частоту задаёт маркер спектроанализатора) —
    // ставим Constant на центр. sdrCenter, а не actualFreq: для AM/SAM/USB/LSB (и dcShift)
    // железо стоит на sr/4 выше логического центра, и actualFreq увёл бы канал на чужие частоты.
    const c = addNode('const', 80, 300, {v: Math.round(sdrCenter(n))});
    addEdge(c.id, 'out', n.id, 'tuneFreq'); markWiresDirty();
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
    const n = addNode('rtlsdr', 80, 80, {demod:${JSON.stringify(demod)}, iqFmt:'auto', loop:true});
    const f = new File(window.__labChunks, ${JSON.stringify(name)}, {type:${JSON.stringify(name.endsWith('.sigmf') ? 'application/x-tar' : name.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream')}});
    window.__labChunks = [];
    await iqOpenFile(n, [f]);
    const c = addNode('const', 80, 300, {v: Math.round(sdrCenter(n))});
    addEdge(c.id, 'out', n.id, 'tuneFreq'); markWiresDirty();
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
  const sum = rows.reduce((a, r) => { a.under[0] += r.under[0]; a.under[1] += r.under[1]; a.under[2] += r.under[2]; a.ovl += r.ovl; return a; }, {under: [0, 0, 0], ovl: 0});
  const res = {
    kind, ok: rows.length > 0, samples: rows.length, connected: rows.filter(r => r.on).length,
    freq: median(rows.map(r => r.freq)), chanTune: median(rows.map(r => r.tune)), sr: rows[rows.length - 1]?.sr, tuner,
    adcRms: median(rows.map(r => r.adcRms)), adcPkMax: rows.length ? Math.max(...rows.map(r => r.adcPk ?? -999)) : null,
    clipMax: rows.length ? Math.max(...rows.map(r => r.clip ?? 0)) : null, ovlSamples: sum.ovl,
    rssi: median(rows.map(r => r.rssi)), snr: median(rows.map(r => r.snr)), audioRms: median(rows.map(r => r.audio)),
    specFrames: rows.length > 1 ? rows[rows.length - 1].specRev - rows[0].specRev : 0,
    specMed: median(rows.map(r => r.spec && r.spec.med)), specP95: median(rows.map(r => r.spec && r.spec.p95)),
    tuneMsMax: rows.length ? Math.max(...rows.map(r => r.tuneMs ?? 0)) : null, underruns: sum.under,
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
      const capName = capturePath && !replayPath ? await startCapture(page) : null;
      if(capturePath && !replayPath && !capName) bad.push('capture did not start');
      const {res} = await collect(page, {total: runSec, tuner: setup.tuner, kind: replayPath ? 'replay' : 'usb'});
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
