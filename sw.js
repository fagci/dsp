// Сервис-воркер только для офлайн-шелла: весь DSP — локальный, всё считается в браузере, сеть не
// нужна для работы. Но без сервис-воркера установленный PWA (иконка на главном экране Android) без
// связи показывает нативный экран Chrome «нет подключения к интернету» вместо самого приложения —
// навигация идёт напрямую в сеть, кэшировать нечем. Стратегия — network-first с откатом на кэш:
// онлайн всегда получаем свежее (та же схема ?v=N, что и в index.html), офлайн — последнее
// закэшированное вместо ошибки.
//
// CACHE бампать вместе с ?v=N в index.html — иначе после правки файлов старый список ссылок
// (со старым ?v=) продолжит переустанавливаться поверх уже закэшированного нового.
const CACHE='dsp-shell-v159';
const SHELL=[
  './',
  './index.html',
  './styles.css?v=159',
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
  './core-dsp.js?v=159',
  './core-engine.js?v=159',
  './core-islands.js?v=159',
  './iq-worker.js?v=159',
  './modules/analysis.js?v=159',
  './modules/misc.js?v=159',
  './modules/modulation.js?v=159',
  './modules/output.js?v=159',
  './modules/processing.js?v=159',
  './modules/protocols.js?v=159',
  './modules/sigid.js?v=159',
  './modules/sources.js?v=159',
  './modules/audioeditor.js?v=159',
  './modules/tracker-formats.js?v=159',
  './modules/tracker-player.js?v=159',
  './modules/tracker.js?v=159',
  './modules/tracker-session.js?v=159',
  './modules/tracker-panels.js?v=159',
  './modules/sampler.js?v=159',
  './modules/tinysa.js?v=159',
  './modules/hfdl.js?v=159',
  './modules/gsm.js?v=159',
  './modules/propagation.js?v=159',
  './modules/geo.js?v=159',
  './modules/sequencer.js?v=159',
  './modules/table.js?v=159',
  './modules/logic.js?v=159',
  './modules/indicators.js?v=159',
  './modules/logicusb.js?v=159',
  './modules/logican.js?v=159',
  './modules/sked.js?v=159',
  './modules/sat.js?v=159',
  './modules/radio.js?v=159',
  './modules/iq-kernels.js?v=159',
  './modules/ccsds-kernels.js?v=159',
  './modules/lrpt-msumr.js?v=159',
  './modules/sonde-kernels.js?v=159',
  './modules/inmarsat-kernels.js?v=159',
  './modules/mpt1327-kernels.js?v=159',
  './modules/ism-kernels.js?v=159',
  './modules/acars-kernels.js?v=159',
  './modules/fsk4-kernels.js?v=159',
  './modules/dmr-kernels.js?v=159',
  './modules/p25-kernels.js?v=159',
  './modules/nxdn-kernels.js?v=159',
  './modules/m17-kernels.js?v=159',
  './modules/ysf-kernels.js?v=159',
  './modules/dstar-kernels.js?v=159',
  './modules/dpmr-kernels.js?v=159',
  './modules/sym-kernels.js?v=159',
  './modules/blind-kernels.js?v=159',
  './modules/tetra-kernels.js?v=159',
  './modules/video-kernels.js?v=159',
  './modules/iq.js?v=159',
  './modules/adsb.js?v=159',
  './modules/lrpt.js?v=159',
  './modules/sonde.js?v=159',
  './modules/inmarsat.js?v=159',
  './modules/mpt1327.js?v=159',
  './modules/ism.js?v=159',
  './modules/acars.js?v=159',
  './modules/dmr.js?v=159',
  './modules/fsk4.js?v=159',
  './modules/sym.js?v=159',
  './modules/blind.js?v=159',
  './modules/tetra.js?v=159',
  './modules/voicecrypt.js?v=159',
  './modules/mbe-tables.js?v=159',
  './modules/mbe.js?v=159',
  './modules/comms.js?v=159',
  './modules/video.js?v=159',
  './modules/ir-kernels.js?v=159',
  './modules/ir.js?v=159',
  './modules/mqtt-kernels.js?v=159',
  './modules/mqtt.js?v=159',
  './modules/ble-kernels.js?v=159',
  './modules/ble.js?v=159',
  './modules/iqnet.js?v=159',
  './modules/gamepad.js?v=159',
  './modules/webhid.js?v=159',
  './modules/webnfc.js?v=159',
  './modules/graphview.js?v=159',
  './modules/chat.js?v=159',
  './presets.js?v=159',
  './core-graph.js?v=159',
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
