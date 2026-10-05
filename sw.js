// Сервис-воркер только для офлайн-шелла: весь DSP — локальный, всё считается в браузере, сеть не
// нужна для работы. Но без сервис-воркера установленный PWA (иконка на главном экране Android) без
// связи показывает нативный экран Chrome «нет подключения к интернету» вместо самого приложения —
// навигация идёт напрямую в сеть, кэшировать нечем. Стратегия — network-first с откатом на кэш:
// онлайн всегда получаем свежее (та же схема ?v=N, что и в index.html), офлайн — последнее
// закэшированное вместо ошибки.
//
// CACHE бампать вместе с ?v=N в index.html — иначе после правки файлов старый список ссылок
// (со старым ?v=) продолжит переустанавливаться поверх уже закэшированного нового.
const CACHE='dsp-shell-v157';
const SHELL=[
  './',
  './index.html',
  './styles.css?v=157',
  './manifest.json',
  './favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/panzoom.min.js?v=4.6.2',
  './vendor/interact.min.js?v=1.10.28',
  './vendor/satellite.min.js?v=5.0.0',
  './vendor/lame.min.js?v=1.2.1',
  './vendor/vis-network.min.js?v=9.1.9',
  './vendor/mbelib.wasm',
  './vendor/codec2.wasm',
  './vendor/tetra-acelp.wasm',
  './vendor/SDDC_FX3.img',
  './core-dsp.js?v=157',
  './core-engine.js?v=157',
  './core-islands.js?v=157',
  './iq-worker.js?v=157',
  './modules/analysis.js?v=157',
  './modules/misc.js?v=157',
  './modules/modulation.js?v=157',
  './modules/output.js?v=157',
  './modules/processing.js?v=157',
  './modules/protocols.js?v=157',
  './modules/sigid.js?v=157',
  './modules/sources.js?v=157',
  './modules/audioeditor.js?v=157',
  './modules/tracker-formats.js?v=157',
  './modules/tracker-player.js?v=157',
  './modules/tracker.js?v=157',
  './modules/tracker-session.js?v=157',
  './modules/tracker-panels.js?v=157',
  './modules/sampler.js?v=157',
  './modules/tinysa.js?v=157',
  './modules/hfdl.js?v=157',
  './modules/gsm.js?v=157',
  './modules/propagation.js?v=157',
  './modules/geo.js?v=157',
  './modules/sequencer.js?v=157',
  './modules/logic.js?v=157',
  './modules/indicators.js?v=157',
  './modules/logicusb.js?v=157',
  './modules/logican.js?v=157',
  './modules/sked.js?v=157',
  './modules/sat.js?v=157',
  './modules/radio.js?v=157',
  './modules/iq-kernels.js?v=157',
  './modules/ccsds-kernels.js?v=157',
  './modules/lrpt-msumr.js?v=157',
  './modules/sonde-kernels.js?v=157',
  './modules/inmarsat-kernels.js?v=157',
  './modules/mpt1327-kernels.js?v=157',
  './modules/ism-kernels.js?v=157',
  './modules/acars-kernels.js?v=157',
  './modules/fsk4-kernels.js?v=157',
  './modules/dmr-kernels.js?v=157',
  './modules/p25-kernels.js?v=157',
  './modules/nxdn-kernels.js?v=157',
  './modules/m17-kernels.js?v=157',
  './modules/ysf-kernels.js?v=157',
  './modules/dstar-kernels.js?v=157',
  './modules/dpmr-kernels.js?v=157',
  './modules/sym-kernels.js?v=157',
  './modules/blind-kernels.js?v=157',
  './modules/tetra-kernels.js?v=157',
  './modules/video-kernels.js?v=157',
  './modules/iq.js?v=157',
  './modules/adsb.js?v=157',
  './modules/lrpt.js?v=157',
  './modules/sonde.js?v=157',
  './modules/inmarsat.js?v=157',
  './modules/mpt1327.js?v=157',
  './modules/ism.js?v=157',
  './modules/acars.js?v=157',
  './modules/dmr.js?v=157',
  './modules/fsk4.js?v=157',
  './modules/sym.js?v=157',
  './modules/blind.js?v=157',
  './modules/tetra.js?v=157',
  './modules/voicecrypt.js?v=157',
  './modules/mbe-tables.js?v=157',
  './modules/mbe.js?v=157',
  './modules/comms.js?v=157',
  './modules/video.js?v=157',
  './modules/ir-kernels.js?v=157',
  './modules/ir.js?v=157',
  './modules/mqtt-kernels.js?v=157',
  './modules/mqtt.js?v=157',
  './modules/ble-kernels.js?v=157',
  './modules/ble.js?v=157',
  './modules/iqnet.js?v=157',
  './modules/gamepad.js?v=157',
  './modules/webhid.js?v=157',
  './modules/webnfc.js?v=157',
  './modules/graphview.js?v=157',
  './modules/chat.js?v=157',
  './presets.js?v=157',
  './core-graph.js?v=157',
];
self.addEventListener('install',e=>{
  self.skipWaiting();                                 // не ждать закрытия всех вкладок — как и ручной ?v=N, обновление должно применяться сразу
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(ks=>Promise.all(ks.filter(k=>k!==CACHE && k!=='dsp-tiles').map(k=>caches.delete(k))))   // тайлы карты — отдельно, переживают обновления
      .then(()=>self.clients.claim())
  );
});
// COOP/COEP на саму страницу — делают её cross-origin isolated, без этого нет SharedArrayBuffer и
// движок работает через postMessage с большим выходным буфером. Хостинг (GitHub Pages) заголовки
// ставить не даёт, поэтому их добавляет сервис-воркер. credentialless, а не require-corp: сторонние
// no-cors ресурсы (CodeMirror с CDN) грузятся без кук и без CORP-заголовка.
function isolate(res){
  if(!res || res.status===0 || res.type==='opaqueredirect') return res;
  const h=new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy','same-origin');
  h.set('Cross-Origin-Embedder-Policy','credentialless');
  return new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  // сторонние запросы (CDN CodeMirror и т.п.) — мимо кэша, как и раньше без сервис-воркера
  if(req.method!=='GET' || new URL(req.url).origin!==location.origin) return;
  // скрипт воркера под изолированной страницей тоже должен нести COEP, иначе браузер его не запустит
  const nav=req.mode==='navigate' || req.destination==='worker';
  e.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy));
      return res;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
      .then(res=>nav?isolate(res):res)
  );
});
