// Сервис-воркер: офлайн-шелл PWA, COOP/COEP и откат на последнюю рабочую версию.
// Весь DSP локальный, но без воркера установленный PWA без связи показывает нативный экран Chrome
// «нет подключения» вместо приложения.
//
// Версия — хэш содержимого файлов SHELL: после правки файлов запустить `node tools/stamp.mjs`
// (прописывает её в CACHE здесь, в const V и styles.css?v= в index.html; tools/test-version.mjs следит).
// Файлы ?v=V неизменяемы и отдаются из кэша без сети; index.html — network-first.
// Новая версия не качает неизменённые файлы: H — хэши файлов (их пишет stamp), совпавшие копируются из кэша прежней версии.
//
// Откат: установка новой версии атомарна (addAll), прежняя версия живёт в своём кэше, пока страница
// новой не подтвердит успешную загрузку ('ok'). Если скрипты не загрузились, страница шлёт 'rollback' —
// пока сеть отдаёт index.html этой версии, воркер подаёт index.html последней подтверждённой.
const PFX='dsp-shell-v';
const CACHE='dsp-shell-v1fc0f4ea';
const V=CACHE.slice(PFX.length);
const H={"core-dsp.js":"aaacdc0b93eb","core-engine.js":"a8946828ac22","core-graph.js":"d598ec4333db","core-islands.js":"e238d09f766c","core-perf.js":"d9ff8c588abe","dvbsoft-pool.js":"d85a6069599b","dvbsoft-worker.js":"2eda83914482","favicon.svg":"783dfe06c06f","icons/apple-touch-icon.png":"d9c3af7d10cb","icons/favicon-32.png":"e1f0baec7af1","icons/icon-192.png":"b7e3f8575478","icons/icon-512.png":"f629317bf2b3","icons/icon-maskable-512.png":"6e827afe8b62","iq-worker.js":"599f87fda44a","manifest.json":"ac7d0ad1b577","modules/acars-kernels.js":"08ab7fa50337","modules/acars.js":"84b244215480","modules/activity-kernels.js":"44beb75edb94","modules/activity.js":"bbd346873eb7","modules/adsb-kernels.js":"990507688e67","modules/adsb.js":"5ea2d832c39c","modules/aec-kernels.js":"ee5e34dbeb81","modules/aec.js":"81db5c900a22","modules/aero-kernels.js":"4caf8b5d1878","modules/aero.js":"27455309c098","modules/ais-kernels.js":"c7e0596e00d4","modules/ais.js":"e05c1e545c2d","modules/analysis.js":"99025dd0b01f","modules/antpeak-kernels.js":"61619c5b72f8","modules/antpeak.js":"8588ca036ce5","modules/audio-kernels.js":"f1258cbbd506","modules/audioattach.js":"c80022de9a22","modules/audioeditor.js":"acadc729213c","modules/backup-kernels.js":"bca97a5f0082","modules/backup.js":"eb16a7021f38","modules/bandmode-kernels.js":"1a33ddba9e06","modules/bandplan-data.js":"0ed9b264018e","modules/baseline-kernels.js":"ceed3e6cd31b","modules/baseline.js":"0edb4c4d33b7","modules/bitchat-kernels.js":"20533ae85ffd","modules/bitchat.js":"13d8d2de44d5","modules/ble-kernels.js":"9a2fb8e0e67f","modules/ble.js":"d3d1d6c983b9","modules/blind-kernels.js":"baf569f0476c","modules/blind.js":"4f8cdaf38646","modules/bytes-kernels.js":"7c00423b1f06","modules/bytes.js":"76a837cd0713","modules/camera-kernels.js":"61944aaab9fa","modules/camera.js":"2de76936a19a","modules/camtools-kernels.js":"a2b79cff1576","modules/camtools.js":"f2b77791b260","modules/ccsds-kernels.js":"84ed52df2f7a","modules/chat.js":"e58b037c3cf6","modules/comms.js":"e38cc29a8b82","modules/control-kernels.js":"36a352ba5c60","modules/coverage-kernels.js":"7ef19b6e1f7b","modules/coverage.js":"351af27d875a","modules/ctlport.js":"3fe8ccaa46b6","modules/cxd-sequences.js":"d4a42a29dc5e","modules/dmr-kernels.js":"cf383fd65ce7","modules/dmr.js":"72c192e2d9c9","modules/dnsq-kernels.js":"3121281f04d4","modules/dpmr-kernels.js":"95b5b322976e","modules/dstar-kernels.js":"d63a3cb3cfaa","modules/dvb-kernels.js":"86382f450a21","modules/dvb.js":"ed666eff7e13","modules/dvbsoft.js":"7561978d998b","modules/errlog.js":"b64fcb762f4b","modules/espsdr.js":"8793e6633fbd","modules/filestore.js":"d8407ea93c1d","modules/fivetone.js":"18e6811fd820","modules/flasher.js":"2da8c6fe504c","modules/flightsim-kernels.js":"e19ebbc98dbe","modules/flightsim.js":"305efa0f30dc","modules/flow-kernels.js":"c72aa67fd4bb","modules/flow.js":"a5c7eb9997e0","modules/fsaccess.js":"aed66712df6d","modules/fsk4-kernels.js":"a5c0b5907fe6","modules/fsk4.js":"74df7374ea34","modules/gainopt-kernels.js":"6ebf87b8c402","modules/gainopt.js":"bd05f61d7d90","modules/gamepad.js":"0d386ea190a5","modules/games.js":"b947dc9bad86","modules/gattlink.js":"79cc7bccaed8","modules/geo.js":"225bebc2259d","modules/geodata-kernels.js":"36426db0e9bf","modules/geodata.js":"205bb464beb2","modules/geofeat-kernels.js":"4259a52da524","modules/geofeat.js":"e13841df1db5","modules/geofence-kernels.js":"fe71a0dd38f3","modules/geofence.js":"5a487d423e5f","modules/geostore.js":"338511a8f310","modules/graphview.js":"cda564fe84e3","modules/gsm-kernels.js":"c708717cc91c","modules/gsm.js":"e8aae1e378b1","modules/hamlib-kernels.js":"185587bf9c56","modules/hex-formats.js":"8ccb15a4c246","modules/hex-gsm.js":"d5b5a2ec421c","modules/hex-kernels.js":"d9ae431f8837","modules/hex-scan-kernels.js":"71d12e22c791","modules/hex-scan.js":"b29099a8688f","modules/hex.js":"faaad0f52bf6","modules/hfdl.js":"9406f23c2387","modules/horizon.js":"5634b5ce3de8","modules/hostcaps-kernels.js":"2702caa58a55","modules/indicators.js":"e322b8d6a27a","modules/inmarsat-kernels.js":"c92127cb7b6b","modules/inmarsat.js":"14d3ee8a0c20","modules/iptv-kernels.js":"f7079027b7e3","modules/iptv.js":"687fca2cc975","modules/iq-kernels.js":"3d24f1d57194","modules/iq.js":"75d9632f4515","modules/iqfiles-kernels.js":"1acd75a1a956","modules/iqfiles.js":"e0af5d1b06c3","modules/iqnet.js":"0f9d1d07c41e","modules/iqrec-kernels.js":"2a21c7599dc2","modules/ir-kernels.js":"8dc9f23cf059","modules/ir.js":"67118c7ff693","modules/ism-kernels.js":"277732fc131d","modules/ism-scan-kernels.js":"6f0b90fd0f8d","modules/ism.js":"f973c36c7a68","modules/joystick.js":"eb0079fa3285","modules/js8-kernels.js":"0d1c7aa823c6","modules/js8.js":"6e70b78726fa","modules/leandvb-kernels.js":"583f3ffd5ee8","modules/link-kernels.js":"04de5bc0fb8b","modules/link.js":"9d7ddab5076a","modules/locate3d-kernels.js":"9983d9fa2b57","modules/logic.js":"bf234274f3e6","modules/logican.js":"d67cb025e528","modules/logicusb.js":"11ea588fc5a1","modules/lookup-kernels.js":"c05456d5069d","modules/lora-kernels.js":"67c0f4e90bae","modules/lora.js":"58210dc431a6","modules/lrpt-msumr.js":"7d5e4eeea602","modules/lrpt.js":"e36a5218f91a","modules/m17-kernels.js":"608a222375fc","modules/mbe-tables.js":"4568a9bdbe45","modules/mbe.js":"8ad65252e28a","modules/media-kernels.js":"05b2f8cc1f00","modules/media.js":"019787fbfde5","modules/medialib-kernels.js":"41182bcce793","modules/medialib.js":"fb707b3088c8","modules/meshcore-kernels.js":"6ad4de058b32","modules/meshcore.js":"81d4536faa1e","modules/meshtastic-air.js":"166b1da7d8e9","modules/meshtastic-kernels.js":"b996de82b91d","modules/meshtastic.js":"7b1715d3b776","modules/misc.js":"82b5e91dcacc","modules/mjpeg-kernels.js":"0746fd51f611","modules/mobile.js":"a47afe911979","modules/modulation.js":"7880892c8997","modules/mpt1327-kernels.js":"d88f6b4d21c1","modules/mpt1327.js":"79cfdbcb8c93","modules/mqtt-kernels.js":"9b63b14ce8c1","modules/mqtt.js":"b749a9bfbf77","modules/netlink.js":"dba7e73ac9cd","modules/nipkow-kernels.js":"613544de9231","modules/nipkow.js":"002868491bfb","modules/nmea.js":"a238286c944f","modules/nnaudio-kernels.js":"6801556fee51","modules/nnaudio.js":"fe37d283ccde","modules/nrf24.js":"0e9e22ca1e48","modules/nxdn-kernels.js":"514539ed2ce6","modules/objdet-kernels.js":"be12fd43a6a8","modules/objdet.js":"b9789485d1f2","modules/odid-kernels.js":"edd07a2ed2cf","modules/odid.js":"298b0e16412f","modules/online-kernels.js":"1024cbc3de3e","modules/online.js":"ec0ec9e54458","modules/openwebrx-kernels.js":"febc8eabc96f","modules/openwebrx.js":"d8863519a28b","modules/otherworld.js":"da0e49b099d3","modules/output.js":"147cc8fcd379","modules/overlay-kernels.js":"7de3d6cde2cf","modules/overlay.js":"6dcd2d87fb07","modules/p25-kernels.js":"e48ca0244825","modules/paths-kernels.js":"552f0935eae7","modules/paths.js":"2c83d40b7575","modules/pcap-kernels.js":"2d7fc8617a39","modules/pcap.js":"ccb3f0aebe3a","modules/phoneact-kernels.js":"8c866bcfa223","modules/phoneact.js":"81037139a27e","modules/phonectl.js":"522c4634b930","modules/phonelink-kernels.js":"06545ae7cde9","modules/photo-kernels.js":"7614e4f7f607","modules/photos.js":"01302e9b4ed8","modules/pip-kernels.js":"ca83b958d7b9","modules/pip.js":"5772482b4ccd","modules/pitchnn-kernels.js":"1aa693242cae","modules/pitchnn.js":"27d668cd1fe5","modules/player-kernels.js":"3864d7cea23e","modules/player.js":"fd2365aa530a","modules/playlist.js":"b2022964f495","modules/pocsag-kernels.js":"501a6c9c2e31","modules/pocsag.js":"def3456bc483","modules/power.js":"7bc12de0fc6c","modules/presetplan-kernels.js":"591f57cc9eca","modules/processing.js":"385ea3420858","modules/propagation.js":"e3b0a973bfe3","modules/protocols.js":"8852b4457ee7","modules/qr-kernels.js":"ff8611de749e","modules/qr.js":"4c6eb44f31ee","modules/radio.js":"2f2b7ed6c826","modules/radiobridge-kernels.js":"0bb93d1cc93c","modules/radiobridge.js":"afbc3cbf78bb","modules/rds-kernels.js":"3b7cf9d17908","modules/rds.js":"a7bb79bfe239","modules/reach-kernels.js":"f96d93ddf1bf","modules/reach.js":"cbe957b58599","modules/reflists.js":"7695b37a457f","modules/rigctl.js":"bf18b8ae4075","modules/rotator-kernels.js":"a8421260cda2","modules/rotator.js":"91ab1cf376d4","modules/rowplayer.js":"401c5af0fa7d","modules/rt433-kernels.js":"bc3fe95b881c","modules/rt4d.js":"d63bf14642cc","modules/rt880-kernels.js":"c76459ba4805","modules/rt880.js":"64e4a28301a2","modules/rt890-kernels.js":"2f930fb935a6","modules/rt890.js":"29b5f4e420f6","modules/rtcmedia.js":"fa490e8f51e9","modules/sa-panes-kernels.js":"120fe871406b","modules/sa-panes.js":"3a66da0afda6","modules/sa-trace-kernels.js":"1eeb313b7260","modules/same.js":"9d37b9f1017f","modules/sampler.js":"9341495a9ca5","modules/sat.js":"82b22efb2004","modules/satplan-kernels.js":"62d8d6922b56","modules/satplan.js":"cbb3a0cfc5a9","modules/sdrdir-kernels.js":"48ce9a896ff4","modules/sdrdir.js":"c6597f3828be","modules/selcal.js":"feecfb4f6953","modules/sequencer.js":"99ac99ed596c","modules/sigcat-kernels.js":"392b750d44cc","modules/sigdb-kernels.js":"ea9ef271891e","modules/sigid-kernels.js":"54f5803facc1","modules/sigid.js":"042e374dcf3c","modules/siglab-kernels.js":"2d9afe821473","modules/siglab.js":"c603f4da7ced","modules/simd-kernels.js":"c274116a03cd","modules/sked.js":"fe3b3aa9008b","modules/smspdu-kernels.js":"6bcd20547636","modules/smspdu.js":"63e634110a3b","modules/sonde-kernels.js":"00d8584083e9","modules/sonde.js":"ab769e9a8be8","modules/sources.js":"5e3d81c37af5","modules/speech.js":"c67dc8b80f08","modules/stopwatch-kernels.js":"29a7e4bcd3ca","modules/streamcheck-kernels.js":"67829dd608ca","modules/streamcheck.js":"577de2662e8a","modules/studio-dsp.js":"c53b4fc202ce","modules/studio-kernels.js":"9466506144b7","modules/studio-nodes.js":"230e1be2616b","modules/studio-panels.js":"7442d9623d23","modules/studio-playlist.js":"c42a234d2da6","modules/studio-roll.js":"c1636dc4bfc8","modules/studio-ui.js":"33dab4d1df2d","modules/sym-kernels.js":"44eb2b66b26f","modules/sym.js":"5779d8ad7b01","modules/sync-kernels.js":"f76d8556e4f8","modules/sync.js":"56ae23664866","modules/syncvideo.js":"156a673ad9c8","modules/table-cards.js":"67a52411d313","modules/table-lookup.js":"3d7d4b895d8e","modules/table-rules.js":"059d1d1c1191","modules/table-templates.js":"29eaf3078938","modules/table.js":"5c5f1d513d55","modules/tblchart-kernels.js":"1218300a4da4","modules/tblchart.js":"f4ba23e18e1f","modules/tbsk-kernels.js":"e4f07687007a","modules/tbsk.js":"eed267b41cd4","modules/telemetry-kernels.js":"870a728424a9","modules/telemetry.js":"f1e2abb63482","modules/termux-kernels.js":"b97bcd885d18","modules/termux.js":"f6cff97e31cc","modules/tetra-kernels.js":"318ced98f18a","modules/tetra.js":"5eb3ac686c6e","modules/timecode-kernels.js":"2b6f6b79ed67","modules/timecode.js":"5d4f97464cbc","modules/timeline-kernels.js":"49407faccc80","modules/timeline.js":"3777bdbb2f5e","modules/tinysa.js":"af7934be04eb","modules/tools-kernels.js":"d854503aa827","modules/tools.js":"a46f9f70d0df","modules/tools2-kernels.js":"42bea3c767cb","modules/tools2.js":"db315829997e","modules/tracker-formats.js":"4786122e2763","modules/tracker-panels.js":"ba3ec277d214","modules/tracker-player.js":"31c46d04e6e7","modules/tracker-session.js":"551fd5c82ace","modules/tracker.js":"2e7e16a43ad6","modules/ts-kernels.js":"6187b8d77643","modules/ts.js":"94b66149274c","modules/tunnel-kernels.js":"7901f9e34369","modules/tunnel.js":"b2c2784bd7ae","modules/udec-audio.js":"acbef5daaa1c","modules/udec-kernels.js":"c22341ed62bf","modules/udec.js":"e32cdf087a5f","modules/usb-bridge.js":"09b0e31b8270","modules/uvk5-kernels.js":"da1927ced153","modules/uvk5.js":"932fc66a6c03","modules/vallog.js":"d811c444b004","modules/vdl2-kernels.js":"580b49c6132a","modules/vdl2.js":"5db9665d8e3e","modules/video-kernels.js":"b54fb5246e6e","modules/video.js":"a6bca00b8c11","modules/visualizers.js":"5f605a8bb920","modules/viz-kernels.js":"b99ce6b24f20","modules/voicecrypt.js":"92f81b4df889","modules/voicerestore-kernels.js":"8470cafb9425","modules/voicerestore.js":"0d4720ffc2aa","modules/wallpaper.js":"fd1efab3429f","modules/webapis.js":"a82baf365f8b","modules/webhid.js":"a3594e14a042","modules/webnfc.js":"b67c6ab01730","modules/webrtc.js":"a6041b33632d","modules/webusb-serial.js":"920ba3fb4585","modules/whisper-kernels.js":"9dbfd94ca43a","modules/whisper.js":"cfe53e9f87fe","modules/wifisniff-kernels.js":"77197d4b2396","modules/wifisniff.js":"9f9d9d613794","modules/wsfilter-kernels.js":"0b95a6a76749","modules/xfer-kernels.js":"aacf36db21d6","modules/yamnet-kernels.js":"d8eec4155d3a","modules/yamnet.js":"cafb1c6dfd0c","modules/ysf-kernels.js":"d0118a88d719","modules/zerospan-kernels.js":"e7ba82a2a3ae","modules/zerospan.js":"24aceaa216c0","presets.js":"88ee853c0c06","siglab-worker.js":"b811ae474a76","styles.css":"5623fc202105","vendor/SDDC_FX3.img":"d5cefa943bc4","vendor/codec2.wasm":"b3ed2172eaac","vendor/dvbofdm.wasm":"587b405e5f23","vendor/interact.min.js":"d62316ae5ad9","vendor/jsqr.min.js":"41fdad3e08b3","vendor/lame.min.js":"d64e652e22b0","vendor/leandvb.wasm":"5092f81072dc","vendor/mbelib.wasm":"27556d7531d6","vendor/mpeg2.wasm":"8615aa387fd2","vendor/panzoom.min.js":"3ce354ef7b49","vendor/qrcode.min.js":"d8ce08e27911","vendor/rnnoise.js":"89b7664ef810","vendor/rnnoise.wasm":"677147b9248a","vendor/rtl433.wasm":"9834c46c031f","vendor/satellite.min.js":"272c249d2448","vendor/tetra-acelp.wasm":"7ce395a4091a","vendor/vis-network.min.js":"f53f833ddb9b","whisper-worker.js":"7e4e89c2120d"};
const HKEY='./__hashes';
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
  './vendor/qrcode.min.js?v=1.4.4',
  './vendor/jsqr.min.js?v=1.4.0',
  './vendor/rnnoise.js?v=0.2.1',
  './vendor/rnnoise.wasm',
  './vendor/mbelib.wasm',
  './vendor/rtl433.wasm',
  './vendor/codec2.wasm',
  './vendor/tetra-acelp.wasm',
  './vendor/mpeg2.wasm',
  './vendor/leandvb.wasm',
  './vendor/dvbofdm.wasm',
  './vendor/SDDC_FX3.img',
  './core-perf.js?v='+V,
  './core-dsp.js?v='+V,
  './core-engine.js?v='+V,
  './core-islands.js?v='+V,
  './iq-worker.js?v='+V,
  './dvbsoft-worker.js?v='+V,
  './dvbsoft-pool.js?v='+V,
  './siglab-worker.js?v='+V,
  './whisper-worker.js?v='+V,
  './modules/usb-bridge.js?v='+V,
  './modules/hostcaps-kernels.js?v='+V,
  './modules/pip-kernels.js?v='+V,
  './modules/pip.js?v='+V,
  './modules/wallpaper.js?v='+V,
  './modules/webusb-serial.js?v='+V,
  './modules/analysis.js?v='+V,
  './modules/bandmode-kernels.js?v='+V,
  './modules/sigcat-kernels.js?v='+V,
  './modules/bandplan-data.js?v='+V,
  './modules/sa-panes-kernels.js?v='+V,
  './modules/sa-trace-kernels.js?v='+V,
  './modules/gainopt-kernels.js?v='+V,
  './modules/gainopt.js?v='+V,
  './modules/antpeak-kernels.js?v='+V,
  './modules/antpeak.js?v='+V,
  './modules/hamlib-kernels.js?v='+V,
  './modules/rotator-kernels.js?v='+V,
  './modules/ctlport.js?v='+V,
  './modules/rigctl.js?v='+V,
  './modules/rotator.js?v='+V,
  './modules/zerospan-kernels.js?v='+V,
  './modules/zerospan.js?v='+V,
  './modules/sa-panes.js?v='+V,
  './modules/misc.js?v='+V,
  './modules/modulation.js?v='+V,
  './modules/output.js?v='+V,
  './modules/processing.js?v='+V,
  './modules/qr-kernels.js?v='+V,
  './modules/qr.js?v='+V,
  './modules/protocols.js?v='+V,
  './modules/sigid-kernels.js?v='+V,
  './modules/sigid.js?v='+V,
  './modules/baseline-kernels.js?v='+V,
  './modules/baseline.js?v='+V,
  './modules/filestore.js?v='+V,
  './modules/iqrec-kernels.js?v='+V,
  './modules/iqfiles-kernels.js?v='+V,
  './modules/fsaccess.js?v='+V,
  './modules/iqfiles.js?v='+V,
  './modules/sources.js?v='+V,
  './modules/rds-kernels.js?v='+V,
  './modules/audioeditor.js?v='+V,
  './modules/tracker-formats.js?v='+V,
  './modules/tracker-player.js?v='+V,
  './modules/tracker.js?v='+V,
  './modules/tracker-session.js?v='+V,
  './modules/tracker-panels.js?v='+V,
  './modules/sampler.js?v='+V,
  './modules/studio-kernels.js?v='+V,
  './modules/studio-dsp.js?v='+V,
  './modules/studio-ui.js?v='+V,
  './modules/studio-panels.js?v='+V,
  './modules/studio-roll.js?v='+V,
  './modules/studio-playlist.js?v='+V,
  './modules/studio-nodes.js?v='+V,
  './modules/tinysa.js?v='+V,
  './modules/flasher.js?v='+V,
  './modules/uvk5-kernels.js?v='+V,
  './modules/uvk5.js?v='+V,
  './modules/rt880-kernels.js?v='+V,
  './modules/rt880.js?v='+V,
  './modules/rt890-kernels.js?v='+V,
  './modules/rt890.js?v='+V,
  './modules/rt4d.js?v='+V,
  './modules/espsdr.js?v='+V,
  './modules/hfdl.js?v='+V,
  './modules/gsm.js?v='+V,
  './modules/propagation.js?v='+V,
  './modules/geo.js?v='+V,
  './modules/locate3d-kernels.js?v='+V,
  './modules/stopwatch-kernels.js?v='+V,
  './modules/sequencer.js?v='+V,
  './modules/wsfilter-kernels.js?v='+V,
  './modules/lookup-kernels.js?v='+V,
  './modules/table.js?v='+V,
  './modules/table-templates.js?v='+V,
  './modules/table-cards.js?v='+V,
  './modules/table-rules.js?v='+V,
  './modules/table-lookup.js?v='+V,
  './modules/reflists.js?v='+V,
  './modules/rowplayer.js?v='+V,
  './modules/vallog.js?v='+V,
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
  './modules/satplan-kernels.js?v='+V,
  './modules/satplan.js?v='+V,
  './modules/horizon.js?v='+V,
  './modules/geodata-kernels.js?v='+V,
  './modules/geodata.js?v='+V,
  './modules/geofeat-kernels.js?v='+V,
  './modules/geofeat.js?v='+V,
  './modules/geostore.js?v='+V,
  './modules/backup-kernels.js?v='+V,
  './modules/backup.js?v='+V,
  './modules/sync-kernels.js?v='+V,
  './modules/xfer-kernels.js?v='+V,
  './modules/mjpeg-kernels.js?v='+V,
  './modules/sync.js?v='+V,
  './modules/syncvideo.js?v='+V,
  './modules/media-kernels.js?v='+V,
  './modules/media.js?v='+V,
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
  './modules/online-kernels.js?v='+V,
  './modules/online.js?v='+V,
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
  './modules/vdl2-kernels.js?v='+V,
  './modules/aero-kernels.js?v='+V,
  './modules/udec-kernels.js?v='+V,
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
  './modules/nipkow-kernels.js?v='+V,
  './modules/iq.js?v='+V,
  './modules/adsb-kernels.js?v='+V,
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
  './modules/vdl2.js?v='+V,
  './modules/aero.js?v='+V,
  './modules/udec-audio.js?v='+V,
  './modules/udec.js?v='+V,
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
  './modules/nipkow.js?v='+V,
  './modules/ir-kernels.js?v='+V,
  './modules/ir.js?v='+V,
  './modules/mqtt-kernels.js?v='+V,
  './modules/mqtt.js?v='+V,
  './modules/nmea.js?v='+V,
  './modules/termux-kernels.js?v='+V,
  './modules/termux.js?v='+V,
  './modules/phoneact-kernels.js?v='+V,
  './modules/phoneact.js?v='+V,
  './modules/ble-kernels.js?v='+V,
  './modules/ble.js?v='+V,
  './modules/dnsq-kernels.js?v='+V,
  './modules/geofence-kernels.js?v='+V,
  './modules/geofence.js?v='+V,
  './modules/flow-kernels.js?v='+V,
  './modules/flow.js?v='+V,
  './modules/tunnel-kernels.js?v='+V,
  './modules/tunnel.js?v='+V,
  './modules/smspdu-kernels.js?v='+V,
  './modules/smspdu.js?v='+V,
  './modules/phonelink-kernels.js?v='+V,
  './modules/gattlink.js?v='+V,
  './modules/bitchat-kernels.js?v='+V,
  './modules/bitchat.js?v='+V,
  './modules/netlink.js?v='+V,
  './modules/phonectl.js?v='+V,
  './modules/bytes-kernels.js?v='+V,
  './modules/bytes.js?v='+V,
  './modules/ts-kernels.js?v='+V,
  './modules/ts.js?v='+V,
  './modules/iptv-kernels.js?v='+V,
  './modules/iptv.js?v='+V,
  './modules/streamcheck-kernels.js?v='+V,
  './modules/streamcheck.js?v='+V,
  './modules/camera-kernels.js?v='+V,
  './modules/camera.js?v='+V,
  './modules/camtools-kernels.js?v='+V,
  './modules/camtools.js?v='+V,
  './modules/objdet-kernels.js?v='+V,
  './modules/objdet.js?v='+V,
  './modules/nnaudio-kernels.js?v='+V,
  './modules/nnaudio.js?v='+V,
  './modules/yamnet-kernels.js?v='+V,
  './modules/yamnet.js?v='+V,
  './modules/whisper-kernels.js?v='+V,
  './modules/whisper.js?v='+V,
  './modules/pitchnn-kernels.js?v='+V,
  './modules/pitchnn.js?v='+V,
  './modules/aec-kernels.js?v='+V,
  './modules/aec.js?v='+V,
  './modules/voicerestore-kernels.js?v='+V,
  './modules/voicerestore.js?v='+V,
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
  './modules/siglab-kernels.js?v='+V,
  './modules/siglab.js?v='+V,
  './modules/wifisniff-kernels.js?v='+V,
  './modules/wifisniff.js?v='+V,
  './modules/radiobridge-kernels.js?v='+V,
  './modules/radiobridge.js?v='+V,
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
  './modules/webapis.js?v='+V,
  './modules/speech.js?v='+V,
  './modules/webrtc.js?v='+V,
  './modules/rtcmedia.js?v='+V,
  './modules/otherworld.js?v='+V,
  './modules/graphview.js?v='+V,
  './modules/tblchart-kernels.js?v='+V,
  './modules/tblchart.js?v='+V,
  './modules/timeline-kernels.js?v='+V,
  './modules/timeline.js?v='+V,
  './modules/activity-kernels.js?v='+V,
  './modules/activity.js?v='+V,
  './modules/chat.js?v='+V,
  './modules/rds.js?v='+V,
  './modules/games.js?v='+V,
  './modules/tools-kernels.js?v='+V,
  './modules/tools.js?v='+V,
  './modules/tools2-kernels.js?v='+V,
  './modules/tools2.js?v='+V,
  './modules/mobile.js?v='+V,
  './modules/presetplan-kernels.js?v='+V,
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

const keyOf=u=>u.split('?')[0].slice(2);
// хэши и адреса файлов в кэшах прежних версий: ключ → {h,u}, берём первое совпадение с текущим хэшем
async function oldFiles(){
  const old=new Map();
  for(const k of await caches.keys()){
    if(!k.startsWith(PFX) || k===CACHE) continue;
    const oc=await caches.open(k), r=await oc.match(HKEY);
    const m=r?await r.json().catch(()=>null):null;
    for(const key in m||{}) if(H[key] && m[key].h===H[key] && !old.has(key)) old.set(key,{oc,u:m[key].u});
  }
  return old;
}
async function install(){
  const c=await caches.open(CACHE), old=await oldFiles(), map={};
  await Promise.all(SHELL.map(async u=>{
    const key=keyOf(u), h=H[key], o=old.get(key);
    if(h) map[key]={h,u};
    const prev=o && await o.oc.match(o.u);
    if(prev) return c.put(u,prev);
    const res=await fetch(new Request(u,{cache:'reload'}));   // cache:'reload' — мимо HTTP-кэша, иначе в версию попадут устаревшие файлы
    if(!res.ok) throw new Error(u+' '+res.status);
    return c.put(u,res);
  }));
  await c.put(HKEY,new Response(JSON.stringify(map)));
}
self.addEventListener('install',e=>{
  self.skipWaiting();                                 // не ждать закрытия всех вкладок
  // сбой любого файла — версия не ставится
  e.waitUntil(install()
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
  try{ res=await fetch(req,{cache:'no-cache'}); }catch(err){}   // no-cache: проверка у сервера, а не HTTP-кэш (иначе до 10 мин старая версия)
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
  // крупные докачиваемые данные хранит Files → Offline data (OfflineData в filestore.js) — второй копии в кэше шелла не нужно
  if(/\/(data|vendor\/(objdet|mediapipe|basicpitch|whisper))\//.test(new URL(req.url).pathname)) return;
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
