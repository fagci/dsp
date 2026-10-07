"use strict";
/* ============================ Шаблоны колонок для Table ============================
   Готовые наборы колонок под типовые задачи: точки на карте, замеры, частоты, диапазоны, передатчики, связи… Список создаётся сразу
   с колонками (＋ → шаблон) или получает недостающие колонки шаблона (⊞), данные остаются. Имена колонок — те, что понимают остальные
   узлы (карта, Video Overlay, Mark Point, Radio Reach, Signal Paths, секвенсор). Проверяется tools/test-tabletemplates.mjs. */

const TBL_TEMPLATES=[
  {id:'points', title:'Map points', dir:'points', cols:['name','lat','lon','alt','h','icon','color','note'],
   desc:'Points on the Map and in the 3D overlay (Video Overlay → own points). h — height above the ground, m; alt — above sea level.'},
  {id:'measure', title:'Field measurements (point + height)', dir:'field', cols:['name','t','session','tx','lat','lon','alt','h','freq','rssi','azimuth','elevation','rx_ant','rx_gain','note','photo'],
   desc:'What Mark Point records: where, how high the antenna was, level, bearing, source (tx), session (field / quiet), antenna, photo. Feeds Source Locator and the Map.'},
  {id:'freqs', title:'Frequencies (channels, bookmarks)', dir:'freq', cols:['name','freq','demod','bw','color','note'],
   desc:'One frequency per row (Hz, 145.5M, 14 MHz): a receiver can be tuned from it, the Sequencer steps through it.'},
  {id:'bands', title:'Frequency ranges (band plan)', dir:'bands', cols:['name','lo','hi','step','demod','color','kind','note'],
   desc:'Ranges for the spectrum (bands), the Band Scanner and the multiband view: lo, hi, channel step, mode.'},
  {id:'tx', title:'Transmitters (signal sources)', dir:'sources', cols:['name','lat','lon','h','freq','erp_w','pol','azimuth','beamwidth','note'],
   desc:'Radio / TV masts and any known source: place, mast height (h, m), frequency, radiated power (erp_w), antenna gain, polarisation, direction and beamwidth.'},
  {id:'rx', title:'Receiving points (observation posts)', dir:'posts', cols:['name','lat','lon','alt','h','rx_ant','rx_gain','note','photo'],
   desc:'Where you listen from: a place, antenna height (h, m above ground), antenna and its gain, a photo of the site.'},
  {id:'links', title:'Links (two ends)', dir:'links', cols:['name','lat','lon','h','lat2','lon2','h2','freq','kind','color','label','note'],
   desc:'A link between two points (Signal Paths input / output; drawn on the Map and in 3D). kind: direct / reflect; a row may also carry path3 (JSON).'},
  {id:'antennas', title:'Antennas (catalogue)', dir:'antennas', cols:['name','type','gain_dbi','lo','hi','pol','beamwidth','vswr','note'],
   desc:'Antennas you have or compare: type, gain, band (lo, hi), polarisation, beamwidth, VSWR.'},
  {id:'antest', title:'Antenna tests (compare antennas, heights, places)', dir:'tests', cols:['name','t','site','lat','lon','ant','h','freq','rssi','snr','note','photo'],
   desc:'One row per run: the same source and frequency, a different antenna / height / site — then compare the levels.'},
  {id:'siglog', title:'Signal log (what was heard)', dir:'log', cols:['t','name','freq','demod','bw','rssi','lat','lon','note'],
   desc:'Signals you noted: time, frequency, mode, bandwidth, level, place.'},
  {id:'track', title:'Track (route)', dir:'tracks', cols:['id','lat','lon','alt','speed','icon','label'],
   desc:'A route for the Sequencer (a moving marker on the Map): rows with the same id are one vehicle; speed in km/h.'},
  {id:'photos', title:'Photo log', dir:'photos', cols:['name','t','lat','lon','alt','photo','note'],
   desc:'Photos with the place and time (the place and time are taken from the picture when it has EXIF).'},
];
// недостающие колонки шаблона в конец списка колонок cur
const tblTemplateCols=(cur,t)=>[...cur,...t.cols.filter(c=>!cur.includes(c))];
