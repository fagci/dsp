// Сервис-воркер только для офлайн-шелла: весь DSP — локальный, всё считается в браузере, сеть не
// нужна для работы. Но без сервис-воркера установленный PWA (иконка на главном экране Android) без
// связи показывает нативный экран Chrome «нет подключения к интернету» вместо самого приложения —
// навигация идёт напрямую в сеть, кэшировать нечем. Стратегия — network-first с откатом на кэш:
// онлайн всегда получаем свежее (та же схема ?v=N, что и в index.html), офлайн — последнее
// закэшированное вместо ошибки.
//
// ?v=N-запросы отдаются из кэша без обращения к сети (cache-first), поэтому любая правка файла требует бампа V.
// CACHE бампать вместе с ?v=N в index.html — иначе после правки файлов старый список ссылок
// (со старым ?v=) продолжит переустанавливаться поверх уже закэшированного нового.
const CACHE='dsp-shell-v286';
const V=CACHE.replace(/\D/g,'');                 // ?v=N берётся из имени кэша — бампать только CACHE и V в index.html
const SHELL=[
  './',
  './index.html',
  './styles.css?v='+V,
  './manifest.json',
  './favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/panzoom.min.js?v=4.6.2',
  './vendor/interact.min.js?v=1.10.28',
  './vendor/satellite.min.js?v=5.0.0',
  './vendor/lame.min.js?v=1.2.1',
  './vendor/vis-network.min.js?v=9.1.9',
  './vendor/mbelib.wasm',
  './vendor/codec2.wasm',
  './vendor/tetra-acelp.wasm',
  './vendor/SDDC_FX3.img',
  './core-dsp.js?v='+V,
  './core-engine.js?v='+V,
  './core-islands.js?v='+V,
  './iq-worker.js?v='+V,
  './modules/analysis.js?v='+V,
  './modules/bandplan-data.js?v='+V,
  './modules/sa-panes.js?v='+V,
  './modules/misc.js?v='+V,
  './modules/modulation.js?v='+V,
  './modules/output.js?v='+V,
  './modules/processing.js?v='+V,
  './modules/protocols.js?v='+V,
  './modules/sigid.js?v='+V,
  './modules/filestore.js?v='+V,
  './modules/sources.js?v='+V,
  './modules/audioeditor.js?v='+V,
  './modules/tracker-formats.js?v='+V,
  './modules/tracker-player.js?v='+V,
  './modules/tracker.js?v='+V,
  './modules/tracker-session.js?v='+V,
  './modules/tracker-panels.js?v='+V,
  './modules/sampler.js?v='+V,
  './modules/tinysa.js?v='+V,
  './modules/espsdr.js?v='+V,
  './modules/hfdl.js?v='+V,
  './modules/gsm.js?v='+V,
  './modules/propagation.js?v='+V,
  './modules/geo.js?v='+V,
  './modules/locate3d-kernels.js?v='+V,
  './modules/sequencer.js?v='+V,
  './modules/table.js?v='+V,
  './modules/table-templates.js?v='+V,
  './modules/logic.js?v='+V,
  './modules/indicators.js?v='+V,
  './modules/logicusb.js?v='+V,
  './modules/logican.js?v='+V,
  './modules/sked.js?v='+V,
  './modules/sat.js?v='+V,
  './modules/horizon.js?v='+V,
  './modules/geodata-kernels.js?v='+V,
  './modules/geodata.js?v='+V,
  './modules/geofeat-kernels.js?v='+V,
  './modules/geofeat.js?v='+V,
  './modules/geostore.js?v='+V,
  './modules/backup-kernels.js?v='+V,
  './modules/backup.js?v='+V,
  './modules/reach-kernels.js?v='+V,
  './modules/reach.js?v='+V,
  './modules/photo-kernels.js?v='+V,
  './modules/photos.js?v='+V,
  './modules/audio-kernels.js?v='+V,
  './modules/audioattach.js?v='+V,
  './modules/paths-kernels.js?v='+V,
  './modules/paths.js?v='+V,
  './modules/coverage-kernels.js?v='+V,
  './modules/coverage.js?v='+V,
  './modules/overlay-kernels.js?v='+V,
  './modules/overlay.js?v='+V,
  './modules/control-kernels.js?v='+V,
  './modules/joystick.js?v='+V,
  './modules/flightsim-kernels.js?v='+V,
  './modules/flightsim.js?v='+V,
  './modules/nrf24.js?v='+V,
  './modules/radio.js?v='+V,
  './modules/simd-kernels.js?v='+V,
  './modules/iq-kernels.js?v='+V,
  './modules/ccsds-kernels.js?v='+V,
  './modules/lrpt-msumr.js?v='+V,
  './modules/sonde-kernels.js?v='+V,
  './modules/inmarsat-kernels.js?v='+V,
  './modules/mpt1327-kernels.js?v='+V,
  './modules/ism-kernels.js?v='+V,
  './modules/lora-kernels.js?v='+V,
  './modules/ais-kernels.js?v='+V,
  './modules/pocsag-kernels.js?v='+V,
  './modules/timecode-kernels.js?v='+V,
  './modules/acars-kernels.js?v='+V,
  './modules/fsk4-kernels.js?v='+V,
  './modules/dmr-kernels.js?v='+V,
  './modules/p25-kernels.js?v='+V,
  './modules/nxdn-kernels.js?v='+V,
  './modules/m17-kernels.js?v='+V,
  './modules/ysf-kernels.js?v='+V,
  './modules/dstar-kernels.js?v='+V,
  './modules/dpmr-kernels.js?v='+V,
  './modules/sym-kernels.js?v='+V,
  './modules/blind-kernels.js?v='+V,
  './modules/sigdb-kernels.js?v='+V,
  './modules/tetra-kernels.js?v='+V,
  './modules/gsm-kernels.js?v='+V,
  './modules/video-kernels.js?v='+V,
  './modules/iq.js?v='+V,
  './modules/adsb.js?v='+V,
  './modules/lrpt.js?v='+V,
  './modules/sonde.js?v='+V,
  './modules/inmarsat.js?v='+V,
  './modules/mpt1327.js?v='+V,
  './modules/ism.js?v='+V,
  './modules/lora.js?v='+V,
  './modules/ais.js?v='+V,
  './modules/pocsag.js?v='+V,
  './modules/timecode.js?v='+V,
  './modules/same.js?v='+V,
  './modules/selcal.js?v='+V,
  './modules/fivetone.js?v='+V,
  './modules/tbsk-kernels.js?v='+V,
  './modules/tbsk.js?v='+V,
  './modules/js8-kernels.js?v='+V,
  './modules/js8.js?v='+V,
  './modules/acars.js?v='+V,
  './modules/dmr.js?v='+V,
  './modules/fsk4.js?v='+V,
  './modules/sym.js?v='+V,
  './modules/blind.js?v='+V,
  './modules/tetra.js?v='+V,
  './modules/voicecrypt.js?v='+V,
  './modules/mbe-tables.js?v='+V,
  './modules/mbe.js?v='+V,
  './modules/comms.js?v='+V,
  './modules/video.js?v='+V,
  './modules/ir-kernels.js?v='+V,
  './modules/ir.js?v='+V,
  './modules/mqtt-kernels.js?v='+V,
  './modules/mqtt.js?v='+V,
  './modules/nmea.js?v='+V,
  './modules/ble-kernels.js?v='+V,
  './modules/ble.js?v='+V,
  './modules/bytes-kernels.js?v='+V,
  './modules/bytes.js?v='+V,
  './modules/meshtastic-kernels.js?v='+V,
  './modules/meshtastic.js?v='+V,
  './modules/odid-kernels.js?v='+V,
  './modules/odid.js?v='+V,
  './modules/telemetry-kernels.js?v='+V,
  './modules/telemetry.js?v='+V,
  './modules/iqnet.js?v='+V,
  './modules/power.js?v='+V,
  './modules/gamepad.js?v='+V,
  './modules/webhid.js?v='+V,
  './modules/webnfc.js?v='+V,
  './modules/speech.js?v='+V,
  './modules/webrtc.js?v='+V,
  './modules/rtcmedia.js?v='+V,
  './modules/otherworld.js?v='+V,
  './modules/graphview.js?v='+V,
  './modules/chat.js?v='+V,
  './modules/games.js?v='+V,
  './modules/mobile.js?v='+V,
  './presets.js?v='+V,
  './core-graph.js?v='+V,
];
self.addEventListener('install',e=>{
  self.skipWaiting();                                 // не ждать закрытия всех вкладок — как и ручной ?v=N, обновление должно применяться сразу
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(ks=>Promise.all(ks.filter(k=>k!==CACHE && k!=='dsp-tiles' && k!=='dsp-share').map(k=>caches.delete(k))))   // тайлы карты — отдельно, переживают обновления
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
// «Поделиться → DSP»: файлы приходят POST-ом (manifest share_target) — кладём в кэш dsp-share, страница заберёт их сама
async function takeShare(e){
  try{
    const fd=await e.request.formData(), c=await caches.open('dsp-share');
    let i=0;
    for(const f of fd.getAll('files')) if(f && f.name) await c.put('./share/'+(i++),new Response(f,{headers:{'X-Name':encodeURIComponent(f.name),'Content-Type':f.type||'application/octet-stream'}}));
  }catch(err){}
  return new Response(null,{status:303,headers:{Location:'./index.html?share=done'}});
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method==='POST' && new URL(req.url).origin===location.origin && new URL(req.url).searchParams.has('share')){ e.respondWith(takeShare(e)); return; }
  // сторонние запросы (CDN CodeMirror и т.п.) — мимо кэша, как и раньше без сервис-воркера
  if(req.method!=='GET' || new URL(req.url).origin!==location.origin) return;
  // скрипт воркера под изолированной страницей тоже должен нести COEP, иначе браузер его не запустит
  const nav=req.mode==='navigate' || req.destination==='worker';
  // URL с ?v=N неизменяем (версия = имя кэша) — отдаём из кэша без сети; иначе каждый запуск перекачивает все файлы
  if(new URL(req.url).searchParams.has('v')){
    e.respondWith(
      caches.open(CACHE).then(c=>c.match(req).then(r=>r||fetch(req).then(res=>{
        if(res.ok) c.put(req,res.clone());
        return res;
      }))).then(res=>nav?isolate(res):res)
    );
    return;
  }
  e.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy));
      return res;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
      .then(res=>nav?isolate(res):res)
  );
});
