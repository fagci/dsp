// Сервис-воркер: офлайн-шелл PWA, COOP/COEP и откат на последнюю рабочую версию.
// Весь DSP локальный, но без воркера установленный PWA без связи показывает нативный экран Chrome
// «нет подключения» вместо приложения.
//
// Версия — хэш содержимого файлов SHELL: после правки файлов запустить `node tools/stamp.mjs`
// (прописывает её в CACHE здесь, в const V и styles.css?v= в index.html; tools/test-version.mjs следит).
// Файлы ?v=V неизменяемы и отдаются из кэша без сети; index.html — network-first.
//
// Откат: установка новой версии атомарна (addAll), прежняя версия живёт в своём кэше, пока страница
// новой не подтвердит успешную загрузку ('ok'). Если скрипты не загрузились, страница шлёт 'rollback' —
// пока сеть отдаёт index.html этой версии, воркер подаёт index.html последней подтверждённой.
const PFX='dsp-shell-v';
const CACHE='dsp-shell-vb2f555c8';
const V=CACHE.slice(PFX.length);
const META='dsp-meta', STATE_KEY='./__state', PIN_MS=6*3600e3;    // сколько держать откат, пока не выйдет новая версия
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
  './vendor/rtl433.wasm',
  './vendor/codec2.wasm',
  './vendor/tetra-acelp.wasm',
  './vendor/mpeg2.wasm',
  './vendor/leandvb.wasm',
  './vendor/dvbofdm.wasm',
  './vendor/SDDC_FX3.img',
  './core-dsp.js?v='+V,
  './core-engine.js?v='+V,
  './core-islands.js?v='+V,
  './iq-worker.js?v='+V,
  './dvbsoft-worker.js?v='+V,
  './dvbsoft-pool.js?v='+V,
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
  './modules/iqrec-kernels.js?v='+V,
  './modules/sources.js?v='+V,
  './modules/rds-kernels.js?v='+V,
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
  './modules/stopwatch-kernels.js?v='+V,
  './modules/sequencer.js?v='+V,
  './modules/table.js?v='+V,
  './modules/table-templates.js?v='+V,
  './modules/logic.js?v='+V,
  './modules/indicators.js?v='+V,
  './modules/viz-kernels.js?v='+V,
  './modules/visualizers.js?v='+V,
  './modules/player-kernels.js?v='+V,
  './modules/medialib-kernels.js?v='+V,
  './modules/playlist.js?v='+V,
  './modules/medialib.js?v='+V,
  './modules/player.js?v='+V,
  './modules/logicusb.js?v='+V,
  './modules/logican.js?v='+V,
  './modules/sked.js?v='+V,
  './modules/sdrdir-kernels.js?v='+V,
  './modules/sdrdir.js?v='+V,
  './modules/openwebrx-kernels.js?v='+V,
  './modules/openwebrx.js?v='+V,
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
  './modules/rt433-kernels.js?v='+V,
  './modules/ism-scan-kernels.js?v='+V,
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
  './modules/ts-kernels.js?v='+V,
  './modules/ts.js?v='+V,
  './modules/iptv-kernels.js?v='+V,
  './modules/iptv.js?v='+V,
  './modules/cxd-sequences.js?v='+V,
  './modules/dvb-kernels.js?v='+V,
  './modules/dvb.js?v='+V,
  './modules/leandvb-kernels.js?v='+V,
  './modules/dvbsoft.js?v='+V,
  './modules/hex-kernels.js?v='+V,
  './modules/hex-formats.js?v='+V,
  './modules/hex-gsm.js?v='+V,
  './modules/hex.js?v='+V,
  './modules/hex-scan-kernels.js?v='+V,
  './modules/hex-scan.js?v='+V,
  './modules/wifisniff-kernels.js?v='+V,
  './modules/wifisniff.js?v='+V,
  './modules/pcap-kernels.js?v='+V,
  './modules/pcap.js?v='+V,
  './modules/link-kernels.js?v='+V,
  './modules/link.js?v='+V,
  './modules/meshtastic-kernels.js?v='+V,
  './modules/meshtastic.js?v='+V,
  './modules/meshtastic-air.js?v='+V,
  './modules/meshcore-kernels.js?v='+V,
  './modules/meshcore.js?v='+V,
  './modules/odid-kernels.js?v='+V,
  './modules/odid.js?v='+V,
  './modules/telemetry-kernels.js?v='+V,
  './modules/telemetry.js?v='+V,
  './modules/iqnet.js?v='+V,
  './modules/power.js?v='+V,
  './modules/errlog.js?v='+V,
  './modules/gamepad.js?v='+V,
  './modules/webhid.js?v='+V,
  './modules/webnfc.js?v='+V,
  './modules/speech.js?v='+V,
  './modules/webrtc.js?v='+V,
  './modules/rtcmedia.js?v='+V,
  './modules/otherworld.js?v='+V,
  './modules/graphview.js?v='+V,
  './modules/chat.js?v='+V,
  './modules/rds.js?v='+V,
  './modules/games.js?v='+V,
  './modules/mobile.js?v='+V,
  './presets.js?v='+V,
  './core-graph.js?v='+V,
];
// состояние: good — последняя подтверждённая страницей версия, bad/t — версия, из-за которой откатились, и когда
let stateP=null;
const getState=()=>stateP||(stateP=caches.open(META).then(c=>c.match(STATE_KEY)).then(r=>r?r.json():{}).catch(()=>({})));
const setState=s=>{ stateP=Promise.resolve(s); return caches.open(META).then(c=>c.put(STATE_KEY,new Response(JSON.stringify(s),{headers:{'Content-Type':'application/json'}}))); };
const prune=good=>caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('dsp-shell-') && k!==CACHE && k!==PFX+good).map(k=>caches.delete(k))));
// откат действует, пока сеть отдаёт именно плохую версию; со временем снимается — вдруг сбой был случайным
const pinned=(st,v)=>!!(st.good && v && v===st.bad && Date.now()-st.t<PIN_MS);
const liveCache=st=>st.bad===V && pinned(st,V) ? PFX+st.good : CACHE;
const store=(req,res)=>getState().then(st=>caches.open(liveCache(st))).then(c=>c.put(req,res));

self.addEventListener('install',e=>{
  self.skipWaiting();                                 // не ждать закрытия всех вкладок
  // cache:'reload' — мимо HTTP-кэша, иначе в новую версию попадут устаревшие файлы; сбой любого файла — версия не ставится
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'}))))
    .catch(err=>caches.delete(CACHE).then(()=>{ throw err; })));
});
self.addEventListener('activate',e=>{
  // прежние версии не удаляем: последняя подтверждённая нужна для отката, остальные чистит prune
  e.waitUntil(getState().then(st=>prune(st.good)).then(()=>self.clients.claim()));
});
self.addEventListener('message',e=>{
  const d=e.data||{}, reply=m=>e.ports[0]&&e.ports[0].postMessage(m);
  e.waitUntil((async()=>{
    const st=await getState();
    if(d.type==='ok'){                                // страница версии d.v загрузилась целиком
      if(!await caches.has(PFX+d.v)) return reply({ok:false});
      await setState(st.bad===d.v ? {good:d.v} : {...st,good:d.v});
      await prune(d.v);
      reply({ok:true});
    }else if(d.type==='rollback'){                    // страница версии d.v не загрузилась
      if(!st.good || st.good===d.v || !await caches.has(PFX+st.good)) return reply({ok:false});
      await setState({good:st.good,bad:d.v,t:Date.now()});
      await caches.delete(PFX+d.v);
      reply({ok:true});
    }
  })());
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
// index.html: онлайн — свежий, кроме откатной версии; офлайн или после отката — из кэша подтверждённой версии
async function navigate(req){
  const st=await getState();
  let res=null;
  try{ res=await fetch(req); }catch(err){}
  if(res && res.type==='opaqueredirect') return res;
  if(res && res.ok){
    const v=/const V='(\w+)'/.exec(await res.clone().text())?.[1];
    if(!pinned(st,v)) return res;
  }
  return (await caches.match('./index.html',{cacheName:liveCache(st)})) || (await caches.match('./index.html')) || res || Response.error();
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method==='POST' && new URL(req.url).origin===location.origin && new URL(req.url).searchParams.has('share')){ e.respondWith(takeShare(e)); return; }
  // сторонние запросы (CDN CodeMirror и т.п.) — мимо кэша, как и раньше без сервис-воркера
  if(req.method!=='GET' || new URL(req.url).origin!==location.origin) return;
  // скрипт воркера под изолированной страницей тоже должен нести COEP, иначе браузер его не запустит
  const nav=req.mode==='navigate' || req.destination==='worker';
  const wrap=res=>nav?isolate(res):res;
  if(req.mode==='navigate'){ e.respondWith(navigate(req).then(wrap)); return; }
  // URL с ?v=N неизменяем — ищем во всех версиях (страница могла загрузиться из прежней), иначе сеть
  if(new URL(req.url).searchParams.has('v')){
    e.respondWith(
      caches.match(req).then(r=>r||fetch(req).then(res=>{
        if(res.ok) store(req,res.clone());
        return res;
      })).then(wrap)
    );
    return;
  }
  e.respondWith(
    fetch(req).then(res=>{
      store(req,res.clone());
      return res;
    }).catch(()=>caches.match(req).then(r=>r||Response.error()))
      .then(wrap)
  );
});
