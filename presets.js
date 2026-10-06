/* ---- пресеты ---- */
// Загружается раньше core-graph.js, поэтому serialize/deserialize/autoLayout/stat
// используются только внутри обработчиков и вызываются уже после их определения.
const PKEY='dsp-presets', AKEY='dsp-autosave', VKEY='dsp-presets-ver', PRESET_VER=45;
const LS={ get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
set(k,v){ try{ localStorage.setItem(k,v); }catch(e){ stat.textContent='storage unavailable'; } } };
const patchListEl=document.getElementById('patchList');
const patchSearchEl=document.getElementById('patchSearch');
const readP=()=>{ try{ return JSON.parse(LS.get(PKEY))||{}; }catch(e){ return {}; } };
const writeP=o=>LS.set(PKEY,JSON.stringify(o));
let currentPatchName='', patchQuery='';
const openPatchCats=new Set(['own','temp']);          // свои патчи и temp раскрыты сразу, встроенные — свёрнуты
const TEMP_PREFIX='temp:', TEMP_MAX=5;
// Вместо "несохранённое пропадёт" — тихо откладываем текущий граф в раздел temp и едем дальше.
function stashIfDirty(){
if(!graphDirty || !Graph.nodes.length) return;
const p=readP();
const ts=new Date().toISOString().slice(0,19).replace('T',' ');
const key=TEMP_PREFIX+ts+' — '+(currentPatchName||'untitled');
p[key]=serialize();
const temps=Object.keys(p).filter(k=>k.startsWith(TEMP_PREFIX)).sort();
while(temps.length>TEMP_MAX) delete p[temps.shift()];
writeP(p);
}
function makePatchItem(name,count){
const b=document.createElement('button'); b.className='pitem'+(name===currentPatchName?' on':'');
b.innerHTML= `<span class="ptxt"><b>${name}</b><i>${count} nodes</i></span><span class="pdel" title="Delete patch">✕</span>` ;
const doDelete=e=>{ e.preventDefault(); e.stopPropagation();
if(confirm('Delete patch «'+name+'»?')){ const p=readP(); delete p[name]; writeP(p);
if(currentPatchName===name) currentPatchName='';
buildPatchList(); stat.textContent='patch deleted'; } };
b.addEventListener('click',e=>{ if(e.target.closest('.pdel')) return; openPatch(name); });
b.querySelector('.pdel').addEventListener('click',doDelete);      // тап/клик по крестику — работает и на мобиле
b.addEventListener('contextmenu',doDelete);                       // на десктопе правый клик — тоже как раньше
return b;
}
function makePatchDetails(key,label,open){
const det=document.createElement('details'); det.className='pcat'; det.open=open;
det.addEventListener('toggle',()=>{ det.open?openPatchCats.add(key):openPatchCats.delete(key); });
const sum=document.createElement('summary'); sum.textContent=label;
det.append(sum);
return det;
}
function buildPatchList(){
patchListEl.innerHTML='';
const p=readP();
const q=patchQuery.trim().toLocaleLowerCase('ru');
const match=name=>!q || name.toLocaleLowerCase('ru').includes(q);
const custom=Object.keys(p).filter(k=>!(k in PRESETS) &&match(k));
const temp=custom.filter(k=>k.startsWith(TEMP_PREFIX)).sort().reverse();     // новые сверху
const own=custom.filter(k=>!k.startsWith(TEMP_PREFIX)).sort();
const builtin=Object.keys(p).filter(k=>(k in PRESETS) &&match(k));
let matches=0;
const addGroup=(key,label,keys)=>{
if(!keys.length) return;
const det=makePatchDetails(key,label,q?true:openPatchCats.has(key));
det.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="cnt">${keys.length}</span>` );
for(const name of keys){ matches++; det.append(makePatchItem(name,p[name].nodes.length)); }
patchListEl.append(det);
};
addGroup('temp','TEMP (autosave)',temp);
addGroup('own','MY PATCHES',own);
const byCat={};                                       // встроенные — по категориям, не одним списком
for(const name of builtin){ const cat=PRESET_CATS[name]||'Misc'; (byCat[cat]||(byCat[cat]=[])).push(name); }
for(const cat of PRESET_CAT_ORDER) if(byCat[cat]) addGroup('builtin:'+cat, cat, byCat[cat].sort());
for(const cat of Object.keys(byCat).sort())            // категории вне PRESET_CAT_ORDER — в конец списком
if(!PRESET_CAT_ORDER.includes(cat)) addGroup('builtin:'+cat, cat, byCat[cat].sort());
patchListEl.classList.toggle('empty',matches===0);
}
function openPatch(name){
stashIfDirty();
const p=readP(); if(!p[name]) return;
deserialize(p[name]); currentPatchName=name; graphDirty=false;
stat.textContent='opened: '+name;
buildPatchList(); closeSide();
}
document.getElementById('psave').onclick=()=>{
const name=prompt('Patch name',currentPatchName||'patch '+new Date().toLocaleString());
if(!name) return;
const p=readP(); p[name]=serialize(); writeP(p);
currentPatchName=name; graphDirty=false;
stat.textContent='patch saved: '+name;
buildPatchList();
};
patchSearchEl.addEventListener('input',e=>{ patchQuery=e.target.value; buildPatchList(); });
// Строит недостающие/устаревшие встроенные пресеты и обновляет версию хранилища.
// Сами пресеты регистрируются ниже через preset(имя, функция-строитель), см. PRESETS.
function buildBuiltinPresets(){
const p=readP(), ver=+(LS.get(VKEY)||0);
for(const [name,fn] of Object.entries(PRESETS)){
if(ver <PRESET_VER || !p[name]){
try{ fn(); autoLayout(); p[name]=serialize(); }
catch(err){ console.error('preset  "'+name+' " failed to build:',err); }
}
}
writeP(p); LS.set(VKEY,String(PRESET_VER)); buildPatchList();
}
/* ---- реестр встроенных пресетов ---- */
// preset(имя, функция) — по аналогии с def(...) у модулей: функция просто строит граф
// узлов (addNode/addEdge), как будто пользователь собрал его вручную.
/* ---- категории встроенных пресетов ---- */
// имя пресета → категория; используется только для группировки списка,
// сам preset(имя, функция) ничего о категориях не знает.
const PRESET_CAT_ORDER=['Start Here',
                         'SDR Receivers',
                         'Digital Voice & Trunking',
                         'Aircraft, Satellites & Telemetry',
                         'Images & TV',
                         'HF Modes & Morse',
                         'Modems & Data Links',
                         'Infrared',
                         'Network & IoT',
                         'Unknown Signals',
                         'Maps & Locating',
                         'Music: Sequencers & Mixer',
                         'Music: Synth & Tracker',
                         'Analysis & Measurement'];
const PRESET_CATS={
  'Demo: Sweep and Waterfall':'Start Here',
  'Quick Audio Recording':'Start Here',
  'Find Sound Source (by Frequency)':'Start Here',
  'HF: Quick-Decode All Protocols':'Start Here',
  'Quick Sound Level Meter':'Start Here',
  'Quick Signal Chain Check':'Start Here',

  'USB SDR: Wideband Sweep':'SDR Receivers',
  'USB SDR: Auto Scan (CFAR + Band Scanner)':'SDR Receivers',
  'USB SDR: Multiband Scan (panes + CFAR)':'SDR Receivers',
  'USB SDR: Signal Identifier':'SDR Receivers',
  'IQ: Receiver from Blocks (Generator)':'SDR Receivers',
  'USB SDR: FM Receiver from Blocks':'SDR Receivers',
  'Remote SDR: FM Receiver (rtl_tcp over WebSocket)':'SDR Receivers',
  'USB SDR: HF AM / SSB from Blocks':'SDR Receivers',
  'Sound Card IQ: HF Receiver (SoftRock-style)':'SDR Receivers',
  'IQ: Channelizer — Three Signals at Once (Generator)':'SDR Receivers',
  'USB SDR: Listen to the Strongest Channels':'SDR Receivers',
  'tinySA: Spectrum':'SDR Receivers',

  'MPT 1327: Control Channel (Generator)':'Digital Voice & Trunking',
  'MPT 1327: Control Channel (USB SDR)':'Digital Voice & Trunking',
  'DMR: Calls, SMS and CSBK (Generator)':'Digital Voice & Trunking',
  'DMR: Repeater or Direct Mode (USB SDR)':'Digital Voice & Trunking',
  'DMR: Activity Log and Station Map (Generator)':'Digital Voice & Trunking',
  'DMR: Activity Log and Station Map (USB SDR)':'Digital Voice & Trunking',
  '4FSK Digital Voice: Auto Detect (Generator)':'Digital Voice & Trunking',
  '4FSK Digital Voice: Any System (USB SDR)':'Digital Voice & Trunking',
  'M17: Receiver Built from Blocks (Generator)':'Digital Voice & Trunking',
  'DMR: Receiver Built from Blocks (Generator)':'Digital Voice & Trunking',
  'P25: Receiver Built from Blocks (Generator)':'Digital Voice & Trunking',
  'M17: Transmitter Built from Blocks (Loopback)':'Digital Voice & Trunking',
  'Data over 4FSK: Image, File or Text (Loopback)':'Digital Voice & Trunking',
  'Data over DMR: Image, File or Text (Loopback)':'Digital Voice & Trunking',
  'M17: Voice Transmitter, Microphone to Speaker (Loopback)':'Digital Voice & Trunking',
  'TETRA: Test Cell (Generator)':'Digital Voice & Trunking',
  'TETRA: Control Channel (USB SDR)':'Digital Voice & Trunking',

  'Satellites: Track and Doppler':'Aircraft, Satellites & Telemetry',
  'Satellites: Pass and Sky Plot':'Aircraft, Satellites & Telemetry',
  'ADS-B: Radar and Attitude (Generator)':'Aircraft, Satellites & Telemetry',
  'ADS-B: Aircraft Map (Generator)':'Aircraft, Satellites & Telemetry',
  'ADS-B: Aircraft Map (USB SDR, 1090 MHz)':'Aircraft, Satellites & Telemetry',
  'Meteor-M LRPT: Image (Generator)':'Aircraft, Satellites & Telemetry',
  'Meteor-M LRPT: Image (USB SDR, 137 MHz)':'Aircraft, Satellites & Telemetry',
  'Radiosonde RS41: Map (Generator)':'Aircraft, Satellites & Telemetry',
  'Radiosonde RS41: Map (USB SDR, 400–406 MHz)':'Aircraft, Satellites & Telemetry',
  'NMEA: GPS Track (Table Playback)':'Maps & Locating',
  'NMEA: Network Stream (gpsd, AIS-catcher, Termux)':'Network & IoT',
  'POCSAG: Transmitter Loopback (no radio)':'Modems & Data Links',
  'POCSAG: Send a Page (HackRF TX)':'Modems & Data Links',
  'Time Signal: DCF77 Clock (Generator)':'HF Modes & Morse',
  'Time Signal: WWVB Clock (Generator)':'HF Modes & Morse',
  'Time Signal: DCF77 / WWVB from a Sound Card (192 kS/s)':'HF Modes & Morse',
  'SAME / EAS: Alert Decoder Test (Loopback)':'Aircraft, Satellites & Telemetry',
  'SAME / EAS: NOAA Weather Radio (USB SDR)':'Aircraft, Satellites & Telemetry',
  'SELCAL: Test Signal (Loopback)':'HF Modes & Morse',
  'SELCAL: HF Aeronautical Channel (KiwiSDR)':'HF Modes & Morse',
  'Selcall ZVEI / CCIR: Five-Tone Decoder Test (Loopback)':'Digital Voice & Trunking',
  'Selcall ZVEI / CCIR: Five-Tone Decoder (USB SDR, NFM)':'Digital Voice & Trunking',
  'POCSAG: Pager Messages (Generator)':'Modems & Data Links',
  'POCSAG: Pager Messages (USB SDR)':'Modems & Data Links',
  'AIS: Vessels on the Map (Generator)':'Aircraft, Satellites & Telemetry',
  'AIS: Vessels on the Map (USB SDR, 162 MHz)':'Aircraft, Satellites & Telemetry',
  'ISM 433: Sensors and Remotes (Generator)':'Aircraft, Satellites & Telemetry',
  'ISM 433: Sensors and Remotes (USB SDR)':'Aircraft, Satellites & Telemetry',
  'LoRa: Chirp Link (Loopback)':'Modems & Data Links',
  'LoRa: Receive (USB SDR, 868 MHz)':'Modems & Data Links',
  'LoRa: Send a Message (HackRF TX)':'Modems & Data Links',
  'ACARS: VHF Messages (Generator)':'Aircraft, Satellites & Telemetry',
  'ACARS: VHF Messages (USB SDR, 131 MHz)':'Aircraft, Satellites & Telemetry',
  'Inmarsat STD-C: EGC Messages (Generator)':'Aircraft, Satellites & Telemetry',
  'Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz)':'Aircraft, Satellites & Telemetry',
  'GSM: Receive Bursts (USB SDR)':'Aircraft, Satellites & Telemetry',
  'GSM: ARFCN Scanner (sweep the band, log every cell)':'Aircraft, Satellites & Telemetry',
  'HFDL: Receive Chain (to Symbols)':'Aircraft, Satellites & Telemetry',
  'NOAA APT (AM Envelope)':'Aircraft, Satellites & Telemetry',
  'HFDL: Detection and Frame':'Aircraft, Satellites & Telemetry',
  'HFDL: Receive and Aircraft Map':'Aircraft, Satellites & Telemetry',

  'SSTV / Fax: Raster':'Images & TV',
  'Decode Protocol as Raster':'Images & TV',
  'Weather Fax WEFAX 120':'Images & TV',
  'WEFAX Transmit (Demo)':'Images & TV',
  'Analog TV: Test Card (Generator)':'Images & TV',
  'Analog TV: FPV / TV Receiver (USB SDR)':'Images & TV',

  'HF: Who Is On Air (Schedule)':'HF Modes & Morse',
  'Morse from Microphone':'HF Modes & Morse',
  'Morse from Camera':'HF Modes & Morse',
  'RTTY: Transmit and Receive':'HF Modes & Morse',
  'RTTY: Receive Off-Air':'HF Modes & Morse',
  'Morse: Encoder + Decoder':'HF Modes & Morse',
  'FT8: Find Signals in Slot':'HF Modes & Morse',
  'PSK31 (7035–7040 kHz)':'HF Modes & Morse',
  'Feld Hell':'HF Modes & Morse',
  'SSB: Shift to Zero':'HF Modes & Morse',
  'Olivia: Transmit and Receive (Loop)':'HF Modes & Morse',
  'Contestia: Transmit and Receive (Loop)':'HF Modes & Morse',

  'DTMF':'Modems & Data Links',
  'Text → Signal → Text':'Modems & Data Links',
  'IR: Remote Codes Loopback (No Hardware)':'Infrared',
  'IR: Learn and Replay (Sound Card)':'Infrared',
  'IR: Arduino / ESP / Flipper (WebSerial)':'Infrared',
  'IR: Tasmota Blaster over MQTT':'Infrared',
  'MQTT: Subscribe and Publish':'Network & IoT',
  'Gamepad: Axes to Tone and Lamps':'Network & IoT',
  'HID: Reports to Number and Log':'Network & IoT',
  'NFC: Tag Log and Writer':'Network & IoT',
  'Graph: Links from CSV':'Network & IoT',
  'Chat: Text In and Out':'Network & IoT',
  'BLE: Heart Rate Monitor':'Network & IoT',
  'BLE: Find a Beacon by RSSI':'Network & IoT',
  'BLE: UART Terminal':'Network & IoT',
  'Unknown Signal: Blind Analysis (Generator)':'Unknown Signals',
  'Preamble Search':'Modems & Data Links',
  'Noise-Resistant Frame':'Modems & Data Links',
  'APRS / AX.25':'Modems & Data Links',
  'Chirp Modem: Noise and Reflection':'Modems & Data Links',
  'APRS: Transmit and Receive (Loop)':'Modems & Data Links',
  'DTMF: Encoder + Decoder':'Modems & Data Links',
  'Text → Bits → Text (Encodings)':'Modems & Data Links',
  'OFDM: Text via Multi-Carrier Modulation':'Modems & Data Links',

  'Map: My Position and Points from CSV':'Maps & Locating',
  'Sequencer: Vehicle Track on the Map':'Maps & Locating',
  'Sequencer: Frequency Stepper (CSV → Oscillator)':'Analysis & Measurement',
  'Sequencer: Random Beacon (Trigger Clock)':'Modems & Data Links',
  'Control: Clocks Switch a Tone On and Off':'Analysis & Measurement',
  'Control: Level Trigger (Compare, Counter, One-Shot)':'Analysis & Measurement',
  'Control: Logic Test Bench (all blocks)':'Analysis & Measurement',
  'Indicators: Lamps, Gauge, LED Bar, Compass, Display':'Analysis & Measurement',
  'Indicators: Sky Plot, S-Meter, Text Ticker':'Analysis & Measurement',
  'Indicators: Switches and Attitude':'Analysis & Measurement',
  'Logic Analyzer: UART Decode':'Analysis & Measurement',
  'Logic Analyzer: USB (fx2lafw)':'Analysis & Measurement',
  'FT8: Propagation Map':'Maps & Locating',
  'Fox Hunt: Locate Transmitter':'Maps & Locating',
  'Internet Radio on the Map':'Maps & Locating',
  'Wi-Fi: Locate Access Points (Termux)':'Maps & Locating',
  'Two Microphones':'Maps & Locating',
  'Beamforming Direction Finding (2 mics)':'Maps & Locating',
  'TDOA: Path Difference (2 mics)':'Maps & Locating',
  'Chirp Radar 2D (2 mics)':'Maps & Locating',
  'Sonar: Single Mic, 18–22 kHz Chirp':'Maps & Locating',

  'Piano Roll: Length and Velocity':'Music: Sequencers & Mixer',
  'Piano Roll: 4-Voice Chords':'Music: Sequencers & Mixer',
  'Drum Machine: Banks A/B':'Music: Sequencers & Mixer',
  'Sync: Master Clock':'Music: Sequencers & Mixer',
  'Piano Roll: Scale Quantization':'Music: Sequencers & Mixer',
  'Arrangement: Intro → Verse → Chorus':'Music: Sequencers & Mixer',
  '12-Channel Mixer: Full Band':'Music: Sequencers & Mixer',

  'Synth: Acid Bass (303)':'Music: Synth & Tracker',
  'Techno: Drum Machine':'Music: Synth & Tracker',
  'Techno: Generative Acid':'Music: Synth & Tracker',
  'Techno: Full Track':'Music: Synth & Tracker',
  'Tracker (MOD / S3M / XM)':'Music: Synth & Tracker',
  'Tracker: Channels through Effects':'Music: Synth & Tracker',
  'Tracker Studio (tiles)':'Music: Synth & Tracker',
  'Tracker: Synths as Instruments':'Music: Synth & Tracker',

  'Band Occupancy':'Analysis & Measurement',
  'Wavelet vs FFT':'Analysis & Measurement',
  'Vibration (Accelerometer)':'Analysis & Measurement',
  'Low-Frequency Sensor Spectrum':'Analysis & Measurement',
  'Event Capture':'Analysis & Measurement',
  'Band Overview':'Analysis & Measurement',
  'Frequency Response and Chain Delay':'Analysis & Measurement',
  'Harmonics and Cepstrum':'Analysis & Measurement',
  'Sound Level Meter with Log':'Analysis & Measurement',
  'Analyze Recording (Offline)':'Analysis & Measurement',
  'Interference Suppression':'Analysis & Measurement',
  'Mains Hum Removal':'Analysis & Measurement',
  'Room Acoustics':'Analysis & Measurement',
  'Phase Scope: Correlation and Lissajous Figures':'Analysis & Measurement',
  'Hilbert: Envelope and Instantaneous Frequency':'Analysis & Measurement',
  'Triggered Scope: Phase Difference Visible':'Analysis & Measurement',
};
const PRESETS={};
function preset(name,fn){
if(PRESETS[name]) console.warn('дублирующееся имя пресета: '+name);
PRESETS[name]=fn;
if(!(name in PRESET_CATS)) console.warn('у пресета "'+name+'" нет категории — попадёт в «Разное»');
}
/* ---- демо-патч ---- */
function buildDemo(){
clearAll();
const o1=addNode('osc',40,40,{freq:400,amp:.3,wave:'saw'});
const lf=addNode('lfo',40,260,{freq:.3,min:300,max:3000});
const f =addNode('biquad',300,40,{type:'lp',freq:1200,Q:6});
const sc=addNode('scope',560,40);
const ff=addNode('fft',300,300,{size:'2048'});
const wf=addNode('sa',560,300,{fmin:0,fmax:6000,split:.4});
const dc=addNode('dac',820,40,{vol:.25});
const mt=addNode('meter',820,220);
addEdge(o1.id,'out',f.id,'in');
addEdge(lf.id,'out',f.id,'freq');
addEdge(f.id,'out',sc.id,'in1');
addEdge(f.id,'out',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(f.id,'out',dc.id,'L');
addEdge(f.id,'out',mt.id,'in');
markWiresDirty();
}
preset('Demo: Sweep and Waterfall', buildDemo);
/* ---- быстрые сценарии ---- */
preset('Quick Audio Recording', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Catches sound by level — no need to hit «record» at the exact moment.\n'+
  'Pre/post-record compensate for reaction time.\nEcho cancellation/noise suppression/AGC are off so they don\'t taint the recording.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const m =addNode('mic',40,240,{gainA:1,echo:false,ns:false,agc:false});
const tr=addNode('triggerRecorder',420,40,{mode:'level',threshold:.02,preTime:.5,postTime:1.5,maxDuration:20});
tr.size.w=460; tr.size.h=280; applySize(tr);
const mt=addNode('meter',420,360);
const sc=addNode('scope',900,40,{span:4096,gain:2});
sc.size.w=480; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',tr.id,'in');
addEdge(m.id,'a',mt.id,'in');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
preset('Find Sound Source (by Frequency)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Tap a peak on the spectrum — marker 1 lands there,\n'+
  'and the level of that exact frequency over time appears on the right.\n'+
  'Move the mic/source and watch where the level is higher — that\'s how you find direction.'});
nt.size.w=420; nt.size.h=160; applySize(nt);
const m =addNode('mic',40,240,{gainA:2});
const ff=addNode('fft',40,440,{size:'4096'});
const sa=addNode('sa',420,40,{fmin:20,fmax:8000,split:.4});
sa.size.w=560; sa.size.h=320; applySize(sa);
const ns=addNode('numsig',420,400,{dc:false,gain:.02});   // SNR 0..50 дБ -> 0..1
const sc=addNode('scope',420,540,{span:16384,gain:1});
sc.size.w=560; sc.size.h=200; applySize(sc);
const nvF=addNode('numview',1020,40,{digits:0});
const nvL=addNode('numview',1020,200,{digits:1});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(sa.id,'f1',nvF.id,'in');
addEdge(sa.id,'snr1',nvL.id,'in');
addEdge(sa.id,'snr1',ns.id,'in');
addEdge(ns.id,'out',sc.id,'in1');
markWiresDirty();
});
preset('HF: Quick-Decode All Protocols', function(){
clearAll();
const nt=addNode('note',40,40,{text:'HF receiver output — into the mic input.\n'+
  'sigid below is a heuristic signal-type detector: it labels each signal on the spectrum\n'+
  'and hints which decoder on the right is worth watching (no guarantee, but saves time).\n'+
  'Tune the receiver to a band, watch the spectrum for activity.'});
nt.size.w=460; nt.size.h=200; applySize(nt);
const m =addNode('mic',40,280,{gainA:2});
const ff=addNode('fft',40,480,{size:'4096'});
const sa=addNode('sa',460,40,{fmin:100,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=280; applySize(sa);
const si=addNode('sigid',40,640,{fftSize:'8192',period:2});
si.size.w=440; si.size.h=220; applySize(si);
const mo=addNode('morseRx',1080,40,{auto:true,thr:.5,minRun:20});
mo.size.w=340; mo.size.h=160; applySize(mo);
const af=addNode('afskRx',1080,240,{fmin:300,fmax:3000,baudMin:20,baudMax:300});
af.size.w=340; af.size.h=160; applySize(af);
const hd=addNode('ax25Rx',1080,440,{baud:1200,nrzi:true,ax25:true});
hd.size.w=340; hd.size.h=200; applySize(hd);
const dt=addNode('dtmfRx',1080,680);
dt.size.w=340; dt.size.h=120; applySize(dt);
const f8=addNode('ft8Rx',1460,40);
f8.size.w=380; f8.size.h=260; applySize(f8);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',si.id,'in'); addEdge(ff.id,'spec',si.id,'spec');
addEdge(si.id,'bands',sa.id,'bands');               // метки типа сигнала — над спектром
addEdge(m.id,'a',mo.id,'sig');
addEdge(m.id,'a',af.id,'in');
addEdge(af.id,'soft',hd.id,'in');
addEdge(m.id,'a',dt.id,'in');
addEdge(m.id,'a',f8.id,'in');
markWiresDirty();
});
preset('Map: My Position and Points from CSV', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Map works offline: base map (Natural Earth) is downloaded once and kept in the browser.\n'+
  'CSV → Rec: load a file with lat,lon (or grid) and any other columns — they show up on click.\n'+
  'Known fields: id (track), icon, color, size, label, radius (m), azimuth (°), range (km), lat2/lon2, snr, rssi.\n'+
  'My Position: tick «track position» (GPS on a phone).'});
nt.size.w=420; nt.size.h=190; applySize(nt);
const me=addNode('geoMe',40,260,{});
const csv=addNode('recCsv',20,480,{});
const lg=addNode('recLog',290,480,{});
lg.size.w=210; applySize(lg);
const map=addNode('geoMap',520,40,{mz:3,mlat:50,mlon:30});
map.size.w=620; map.size.h=560; applySize(map);
addEdge(me.id,'rec',map.id,'rec');
addEdge(csv.id,'rec',lg.id,'rec');
addEdge(lg.id,'rec',map.id,'rec2');
markWiresDirty();
});
preset('Sequencer: Vehicle Track on the Map', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Table drives along the points of its rows at the set speed (advance = distance)\n'+
  'and, with «interpolate», puts the marker between them. Load your own track: KML, GPX, GeoJSON or CSV with lat,lon.\n'+
  'Speed can come from a column (speed col), a wire (speed) or the slider. Rec Log saves what was sent.'});
nt.size.w=460; nt.size.h=130; applySize(nt);
const sq=addNode('table',40,200,{list:'@patch',advance:'distance',speed:40,rate:4,interp:true,loop:true,
  data:'id,lat,lon,icon,label\nbus1,55.0302,82.9204,bus,Bus 1\nbus1,55.0350,82.9350,bus,Bus 1\nbus1,55.0410,82.9450,bus,Bus 1\nbus1,55.0450,82.9600,bus,Bus 1\nbus1,55.0420,82.9750,bus,Bus 1'});
sq.size.w=270; sq.size.h=300; applySize(sq);
const lg=addNode('recLog',340,200,{}); lg.size.w=210; applySize(lg);
const map=addNode('geoMap',580,40,{mz:11,mlat:55.04,mlon:82.95});
map.size.w=620; map.size.h=520; applySize(map);
addEdge(sq.id,'rec',lg.id,'rec');
addEdge(lg.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('Sequencer: Frequency Stepper (CSV → Oscillator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Each CSV row is held for its dwell seconds (advance = dwell), then the next one is taken.\n'+
  'The freq column goes to the oscillator. Any other column can be wired out the same way.'});
nt.size.w=460; nt.size.h=90; applySize(nt);
const sq=addNode('table',40,160,{list:'@patch',advance:'dwell',loop:true,data:'freq,dwell\n300,1\n600,1\n1200,0.5\n2400,0.5\n800,2'});
sq.size.w=260; sq.size.h=300; applySize(sq);
const o=addNode('osc',340,160,{amp:.3});
const sc=addNode('scope',560,160);
const dc=addNode('dac',560,360,{vol:.2});
addEdge(sq.id,'freq',o.id,'freq');
addEdge(o.id,'out',sc.id,'in1');
addEdge(o.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Sequencer: Random Beacon (Trigger Clock)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Trigger Clock fires at random every 3–8 s (mode random); Table takes a random row\n'+
  'of its table on every pulse. «text» goes to a transmitter, «rec» to a log. A row with fields = a packet or a call.\n'+
  'For a fixed beacon use mode interval; for calls at set times use advance = time with Time Base.'});
nt.size.w=480; nt.size.h=130; applySize(nt);
const ck=addNode('tclock',40,200,{mode:'random',rmin:3,rmax:8});
const sq=addNode('table',300,200,{list:'@patch',order:'shuffle',initial:false,textCol:'msg',
  data:'src,dst,msg\n101,200,CQ CQ de beacon\n102,200,Test 1 2 3\n103,201,Status OK\n104,201,Battery low'});
sq.size.w=260; sq.size.h=300; applySize(sq);
const lg=addNode('recLog',580,200,{}); lg.size.w=210; applySize(lg);
addEdge(ck.id,'trig',sq.id,'trig');
addEdge(sq.id,'rec',lg.id,'rec');
markWiresDirty();
});
preset('Control: Clocks Switch a Tone On and Off', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Clock A sets the flip-flop, clock B (delayed by 2 s) resets it: the tone is on for 2 s, off for 2 s.\n'+
  'Any clock, comparator or oscillator edge can drive set / reset / clk. Math scales 0/1 into the oscillator amplitude.'});
nt.size.w=520; nt.size.h=110; applySize(nt);
const a=addNode('tclock',40,240,{interval:4});
const b=addNode('tclock',40,460,{interval:4,delay:2});
const ff=addNode('nflip',300,320,{});
const m=addNode('nmath',520,320,{op:'sum',k:.25});
const o=addNode('osc',740,240,{freq:660,amp:0});
const dc=addNode('dac',960,240,{vol:.3});
const nv=addNode('numview',520,480,{});
addEdge(a.id,'trig',ff.id,'set');
addEdge(b.id,'trig',ff.id,'reset');
addEdge(ff.id,'out',m.id,'in1');
addEdge(m.id,'out',o.id,'amp');
addEdge(ff.id,'out',nv.id,'in');
addEdge(o.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Control: Level Trigger (Compare, Counter, One-Shot)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'LFO swells the tone level; Level measures it in dB. Compare shows the level on its screen with the threshold\n'+
  'and hysteresis, and fires rise / fall pulses. Counter counts the events, One-Shot holds a 2 s alarm gate after each one.'});
nt.size.w=560; nt.size.h=110; applySize(nt);
const l=addNode('lfo',40,240,{freq:.2,min:0,max:.5});
const o=addNode('osc',260,240,{freq:500,amp:0});
const mt=addNode('meter',480,240,{});
const c=addNode('ncmp',720,240,{thr:-24,hys:6,span:20});
c.size.w=300; c.size.h=140; applySize(c);
const k=addNode('ncount',1060,240,{mod:0});
const s=addNode('nshot',1060,420,{width:2});
const n1=addNode('numview',1280,240,{});
const n2=addNode('numview',1280,420,{});
addEdge(l.id,'out',o.id,'amp');
addEdge(o.id,'out',mt.id,'in');
addEdge(mt.id,'db',c.id,'in');
addEdge(c.id,'rise',k.id,'clk');
addEdge(c.id,'rise',s.id,'trig');
addEdge(k.id,'count',n1.id,'in');
addEdge(s.id,'gate',n2.id,'in');
markWiresDirty();
});
preset('Control: Logic Test Bench (all blocks)', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Test bench for every Control logic block.\n'+
  'Clock 1 s → Counter (mod 4) → Select picks a semitone from 4 constants → Math (÷12, 2^x, ×220) → arpeggio pitch.\n'+
  'Counter wrap (every 4 s) toggles the Flip-Flop; a slow LFO goes through Compare (window 0.2…0.8, screen) and Logic AND with the flip-flop → tone gate.\n'+
  'Sample & Hold freezes the LFO on every clock → Math → second tone; One-Shot (wrap) makes a short blip on it; Logic XOR and the scope hit counter are shown as numbers.'});
nt.size.w=760; nt.size.h=130; applySize(nt);
const X=[40,300,560,820,1080,1340], Y=[190,410,850];
// тактовый генератор и счётчик
const ck=addNode('tclock',X[0],Y[0],{interval:1});
const cn=addNode('ncount',X[1],Y[0],{mod:4});
const nvC=addNode('numview',X[2],Y[0],{});
// арпеджио: Select → Math → Math(pow) → Math
const semi=[0,4,7,12].map((v,i)=>addNode('const',X[1],Y[1]+i*95,{v}));
const sel=addNode('nsel',X[2],Y[1],{inputs:'4'});
const m1=addNode('nmath',X[3],Y[1],{op:'sum',k:1/12});
const two=addNode('const',X[3],Y[1]+170,{v:2});
const m2=addNode('nmath',X[4],Y[1],{op:'in1 ^ in2'});
const m3=addNode('nmath',X[5],Y[1],{op:'sum',k:220});
const o1=addNode('osc',X[5],Y[0],{freq:220,amp:0,wave:'tri'});
// гейт: Flip-Flop + LFO → Compare → Logic AND → Math → amp
const ff=addNode('nflip',X[2]+70,Y[2],{});
const lf=addNode('lfo',X[0],Y[2],{freq:.07,min:0,max:1});
const cm=addNode('ncmp',X[1],Y[2],{mode:'inside',thr:.2,thr2:.8,hys:.06,span:30});
cm.size.w=300; cm.size.h=130; applySize(cm);
const lg=addNode('nlogic',X[3]+40,Y[2],{op:'AND'});
const mg=addNode('nmath',X[4]+40,Y[2],{op:'sum',k:.25});
const xr=addNode('nlogic',X[3]+40,Y[2]+150,{op:'XOR'});
const nvX=addNode('numview',X[4]+40,Y[2]+150,{});
// второй тон: S&H от LFO по такту, One-Shot от wrap
const sh=addNode('nhold',X[0],Y[2]+440,{});
const m4=addNode('nmath',X[1],Y[2]+440,{op:'sum',k:600,ofs:300});
const os=addNode('nshot',X[2],Y[2]+440,{width:.4});
const m5=addNode('nmath',X[3],Y[2]+480,{op:'sum',k:.2});
const o2=addNode('osc',X[4],Y[2]+440,{freq:500,amp:0});
// выход: сумма, осциллограф с hit, счётчик срабатываний
const sm=addNode('sum',X[5]-10,Y[2]+100,{});
const dc=addNode('dac',X[5]+240,Y[2]+100,{vol:.3});
const sc=addNode('scope',X[5]+240,Y[0]-20,{});
const hc=addNode('ncount',X[5]+240,Y[2]+580,{mod:0});
const nvH=addNode('numview',X[5]+480,Y[2]+580,{});
// провода
addEdge(ck.id,'trig',cn.id,'clk');
addEdge(cn.id,'count',nvC.id,'in');
addEdge(cn.id,'count',sel.id,'sel');
semi.forEach((c,i)=>addEdge(c.id,'out',sel.id,'in'+(i+1)));
addEdge(sel.id,'out',m1.id,'in1');
addEdge(two.id,'out',m2.id,'in1');
addEdge(m1.id,'out',m2.id,'in2');
addEdge(m2.id,'out',m3.id,'in1');
addEdge(m3.id,'out',o1.id,'freq');
addEdge(cn.id,'wrap',ff.id,'clk');
addEdge(lf.id,'out',cm.id,'in');
addEdge(ff.id,'out',lg.id,'in1');
addEdge(cm.id,'out',lg.id,'in2');
addEdge(lg.id,'out',mg.id,'in1');
addEdge(mg.id,'out',o1.id,'amp');
addEdge(ff.id,'out',xr.id,'in1');
addEdge(cm.id,'out',xr.id,'in2');
addEdge(xr.id,'out',nvX.id,'in');
addEdge(lf.id,'out',sh.id,'in');
addEdge(ck.id,'trig',sh.id,'trig');
addEdge(sh.id,'out',m4.id,'in1');
addEdge(m4.id,'out',o2.id,'freq');
addEdge(cn.id,'wrap',os.id,'trig');
addEdge(os.id,'gate',m5.id,'in1');
addEdge(m5.id,'out',o2.id,'amp');
addEdge(o1.id,'out',sm.id,'a');
addEdge(o2.id,'out',sm.id,'b');
addEdge(sm.id,'out',dc.id,'L');
addEdge(sm.id,'out',sc.id,'in1');
addEdge(sc.id,'hit',hc.id,'clk');
addEdge(hc.id,'count',nvH.id,'in');
markWiresDirty();
});
preset('FT8: Propagation Map', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Receiver audio (USB, 7074/14074 kHz …) into the mic input.\n'+
  'Enter your position (lat/lon or locator) — lines go from each heard station to you,\n'+
  'records carry snr, distance and azimuth. Rec Log saves them to CSV.'});
nt.size.w=460; nt.size.h=130; applySize(nt);
const m =addNode('mic',40,200,{gainA:2});
const me=addNode('geoMe',40,380,{});
const f8=addNode('ft8Rx',300,200,{fmin:200,fmax:2800,top:15,thr:1.6});
f8.size.w=420; f8.size.h=300; applySize(f8);
const lg=addNode('recLog',300,540,{});
lg.size.w=420; applySize(lg);
const map=addNode('geoMap',760,40,{mz:2.5,mlat:45,mlon:20,grid:'maidenhead',ttl:60});
map.size.w=640; map.size.h=560; applySize(map);
addEdge(m.id,'a',f8.id,'in');
addEdge(f8.id,'rec',lg.id,'rec');
addEdge(lg.id,'rec',map.id,'rec');
addEdge(me.id,'rec',map.id,'rec2');
markWiresDirty();
});
preset('Fox Hunt: Locate Transmitter', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Walk around the transmitter and press ● Mark (or set auto every N s).\n'+
  'Each mark = your position + RSSI. With 3+ marks Source Locator estimates the source;\n'+
  'add azimuth (from a directional antenna) for bearings. Manual gain on the SDR, no AGC!\n'+
  'Path loss n: 2 open field, 2.7–3.5 town, 4+ indoors.'});
nt.size.w=500; nt.size.h=150; applySize(nt);
const me=addNode('geoMe',40,220,{src:'gps'});
const rx=addNode('rtlsdr',40,500,{auto:false,gainDb:20,demod:'NFM'});
const mk=addNode('geoMark',320,220,{icon:'dot'});
const loc=addNode('geoLocate',320,480,{field:'rssi'});
loc.size.w=340; loc.size.h=420; applySize(loc);
const map=addNode('geoMap',700,40,{mz:15,follow:true,store:'foxhunt'});
map.size.w=640; map.size.h=600; applySize(map);
addEdge(rx.id,'rssi',mk.id,'rssi');
addEdge(rx.id,'snr',mk.id,'snr');
addEdge(me.id,'lat',mk.id,'lat');
addEdge(me.id,'lon',mk.id,'lon');
addEdge(mk.id,'rec',loc.id,'rec');
addEdge(mk.id,'rec',map.id,'rec');
addEdge(loc.id,'rec',map.id,'rec2');
addEdge(me.id,'rec',map.id,'rec3');
markWiresDirty();
});
preset('HF: Who Is On Air (Schedule)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Load a schedule into Station Schedule: EiBi CSV (eibispace.de → sked-XNN.csv)\n'+
  'or your own CSV (khz, time, days, station, lang, target, itu, lat, lon).\n'+
  'It shows what is on air now on the tuned frequency; transmitters go to the map\n'+
  '(country centre when the file has no coordinates). Enter your position for distances.'});
nt.size.w=500; nt.size.h=150; applySize(nt);
const kw=addNode('kiwisdr',40,220,{freq:9420000,mod:'am'});
const dc=addNode('dac',40,520,{vol:.4});
const me=addNode('geoMe',300,520,{});
const sk=addNode('sked',300,220,{tol:5});
sk.size.w=380; sk.size.h=280; applySize(sk);
const map=addNode('geoMap',720,40,{mz:2,mlat:30,mlon:20});
map.size.w=620; map.size.h=520; applySize(map);
addEdge(kw.id,'audio',dc.id,'L'); addEdge(kw.id,'audio',dc.id,'R');
addEdge(kw.id,'freq',sk.id,'freq');
addEdge(sk.id,'rec',map.id,'rec');
addEdge(me.id,'rec',map.id,'rec2');
markWiresDirty();
});
preset('Satellites: Track and Doppler', function(){
clearAll();
const nt=addNode('note',40,40,{text:'1. My Position: enter your location. 2. Satellites: Download TLE (once), Download frequencies (once) —\n'+
  'both are kept in the browser. 3. Pick a satellite: type its name/NORAD or click it on the map.\n'+
  'freq = downlink with Doppler correction → tuneFreq of the SDR channel, so the receiver follows the pass.\n'+
  'Downlinks of satellites above the horizon are marked on the spectrum.'});
nt.size.w=620; nt.size.h=130; applySize(nt);
const me=addNode('geoMe',40,200,{});
const st=addNode('satTrack',300,200,{group:'amateur',sat:'ISS'});
st.size.w=380; st.size.h=620; applySize(st);
const rx=addNode('rtlsdr',720,200,{auto:false,gainDb:35,demod:'NFM',bw:15000,freq:145900000});
const sa=addNode('sa',720,560,{auto:true,split:.35});
sa.size.w=560; sa.size.h=320; applySize(sa);
const dc=addNode('dac',1000,200,{vol:.4});
const map=addNode('geoMap',1320,40,{mz:2,mlat:40,mlon:30,ttl:10});
map.size.w=620; map.size.h=520; applySize(map);
addEdge(st.id,'freq',rx.id,'tuneFreq');
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(st.id,'bands',sa.id,'bands');
addEdge(rx.id,'audio',dc.id,'L'); addEdge(rx.id,'audio',dc.id,'R');
addEdge(st.id,'rec',map.id,'rec');
addEdge(me.id,'rec',map.id,'rec2');
addEdge(map.id,'sel',st.id,'select');
markWiresDirty();
});
preset('Internet Radio on the Map', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Internet Radio: set a country code / tag / name and press Search (radio-browser.info).\n'+
  'Stations go to the map (violet — no coordinates, placed around the country centre).\n'+
  'Click a station on the map — it starts playing in Audio Stream and goes through the spectrum.\n'+
  'Only streams that send CORS headers can be captured into the graph.'});
nt.size.w=560; nt.size.h=130; applySize(nt);
const rd=addNode('radioDir',40,200,{cc:'',limit:2000});
rd.size.h=150; applySize(rd);
const st=addNode('stream',40,640,{url:''});
const dc=addNode('dac',320,640,{vol:.5});
const ff=addNode('fft',400,200,{size:'4096'});
const sa=addNode('sa',400,340,{fmin:0,fmax:16000,split:.35});
sa.size.w=460; sa.size.h=280; applySize(sa);
const map=addNode('geoMap',900,40,{mz:2,mlat:35,mlon:15,labels:true});
map.size.w=640; map.size.h=560; applySize(map);
addEdge(rd.id,'rec',map.id,'rec');
addEdge(map.id,'sel',rd.id,'select');
addEdge(rd.id,'url',st.id,'url');
addEdge(st.id,'audio',dc.id,'L'); addEdge(st.id,'audio',dc.id,'R');
addEdge(st.id,'audio',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
markWiresDirty();
});
preset('Wi-Fi: Locate Access Points (Termux)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'On the phone (Termux + Termux:API): pkg install termux-api jq websocat, then\n'+
  "  websocat -t ws-l:127.0.0.1:8765 sh-c:'bash wifi-scan.sh'   (tools/termux/wifi-scan.sh)\n"+
  'Open this page on the same phone, press Connect and walk around: every scan = your GPS position\n'+
  '+ RSSI of each access point. Source Locator estimates each AP (group by bssid) once the marks\n'+
  'spread over 15 m. Click an AP on the map to see its probability map. Press Fit on the map.'});
nt.size.w=640; nt.size.h=150; applySize(nt);
const net=addNode('nettext',40,220,{url:'ws://127.0.0.1:8765'});
const me=addNode('recFilter',40,500,{expr:"r.id === 'me'"});
const fresh=addNode('recFilter',40,630,{expr:"r.id !== 'me' && r.rssi != null && (r.age_s == null || r.age_s < 20)"});
const loc=addNode('geoLocate',300,220,{group:'bssid',labelField:'ssid',pathN:3,sigmaDb:6,minSpread:15,max:300});
loc.size.w=360; loc.size.h=420; applySize(loc);
const map=addNode('geoMap',700,40,{mz:16,labels:true,trail:2000});
map.size.w=660; map.size.h=600; applySize(map);
addEdge(net.id,'rec',me.id,'rec');
addEdge(net.id,'rec',fresh.id,'rec');
addEdge(fresh.id,'rec',loc.id,'rec');
addEdge(loc.id,'rec',map.id,'rec');
addEdge(me.id,'rec',map.id,'rec2');
addEdge(map.id,'sel',loc.id,'select');
markWiresDirty();
});
preset('Quick Sound Level Meter', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Quick loudness estimate: level bar + LUFS-like metrics.\n'+
  '«Reset integrated» on the loudness node — start the measurement over.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const m =addNode('mic',40,220,{gainA:1});
const mt=addNode('meter',420,40);
const ld=addNode('loud',420,120);
const sc=addNode('scope',420,220,{span:8192,gain:2});
sc.size.w=460; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',mt.id,'in');
addEdge(m.id,'a',ld.id,'in');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
preset('Quick Signal Chain Check', function(){
clearAll();
const nt=addNode('note',40,40,{text:'A sweep through the speaker, the mic listens back —\n'+
  'quickly reveals frequency-response dips, rattle, dropouts in the chain.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const sw=addNode('sweep',40,220,{f0:40,f1:16000,rate:.3,mode:'log',amp:.3});
const dc=addNode('dac',40,420,{vol:.4});
const m =addNode('mic',420,40,{gainA:2});
const ff=addNode('fft',420,240,{size:'4096'});
const sa=addNode('sa',780,40,{fmin:20,fmax:16000,split:.4});
sa.size.w=560; sa.size.h=280; applySize(sa);
const sc=addNode('scope',780,340,{span:4096,gain:2});
sc.size.w=560; sc.size.h=200; applySize(sc);
addEdge(sw.id,'out',dc.id,'L');
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
preset('USB SDR: Wideband Sweep', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the SDR — it steps across the range, the spectrum shows the whole band,\n'+
  'the waterfall gets one line per full pass.\n'+
  'Tap the spectrum — marker 1 pauses the sweep and tunes to that frequency; remove the marker to resume.\n'+
  'Use manual gain: with AGC every step has its own level and the waterfall gets striped.'});
nt.size.w=460; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'2400000',auto:false,gainDb:30,dcShift:true,demod:'WFM',
  sweep:true,swLo:88,swHi:108,swFft:'1024',swAvg:8});
const sa=addNode('sa',540,40,{auto:true,floor:-90,top:-20,split:.3});
sa.size.w=720; sa.size.h=460; applySize(sa);
const dc=addNode('dac',540,560,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(sa.id,'f1',rx.id,'tuneFreq');
addEdge(rx.id,'audioL',dc.id,'L'); addEdge(rx.id,'audioR',dc.id,'R');
markWiresDirty();
});
preset('USB SDR: Auto Scan (CFAR + Band Scanner)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the SDR. The Band Scanner walks the band plan in windows of the SDR span;\n'+
  'the CFAR detector looks for signals in each window — its threshold is dB over the local noise floor,\n'+
  'so it does not depend on gain. When something is there the scanner stops, the strongest target is\n'+
  'tuned and played, and when it goes quiet (or the listen timeout ends) the scan goes on.\n'+
  'Every new signal also lands in the «Scan log» table (time, frequency, width, level, SNR) — it is kept in the browser,\n'+
  'export it from the table. Pick another band plan in the first table; set the demodulator to match the band.\n'+
  'The «Scan skip» table is a skip list: add rows with lo / hi (or a single freq) for pagers, beacons and\n'+
  'other permanent carriers — the detector ignores targets inside them and the scanner does not stop there.'});
nt.size.w=560; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'2400000',auto:false,gainDb:30,dcShift:true,demod:'NFM',bw:12500,freq:150000000});
const bp=addNode('table',360,260,{list:'presets/Utility / services (RU)',initial:false});
bp.size.w=340; bp.size.h=200; applySize(bp);
const bs=addNode('bandscan',740,260,{timeout:4000,settle:250});
bs.size.w=300; bs.size.h=200; applySize(bs);
const cf=addNode('cfar',360,520,{auto:true,thr:10,confM:2,confN:3});
cf.size.w=300; cf.size.h=220; applySize(cf);
const sk=addNode('table',40,520,{list:'Scan skip',initial:false});
sk.size.w=300; sk.size.h=220; applySize(sk);
const lg=addNode('table',740,520,{list:'Scan log',initial:false});
lg.size.w=420; lg.size.h=260; applySize(lg);
const sa=addNode('sa',1080,40,{auto:true,floor:-90,top:-20,split:.4});
sa.size.w=700; sa.size.h=420; applySize(sa);
const dc=addNode('dac',740,820,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(rx.id,'spec',cf.id,'spec'); addEdge(cf.id,'rec',lg.id,'rec'); addEdge(sk.id,'bands',cf.id,'skip');
addEdge(bp.id,'bands',bs.id,'bands');
addEdge(rx.id,'freqLo',bs.id,'freqLo'); addEdge(rx.id,'freqHi',bs.id,'freqHi');
addEdge(cf.id,'count',bs.id,'active');
addEdge(bs.id,'freq',rx.id,'freq');
addEdge(cf.id,'f1',rx.id,'tuneFreq');
addEdge(rx.id,'audioL',dc.id,'L'); addEdge(rx.id,'audioR',dc.id,'R');
markWiresDirty();
});
preset('USB SDR: Multiband Scan (panes + CFAR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the SDR. The Band Scanner walks the ranges of the table in windows of the SDR span; the Spectrum Analyzer\n'+
  '(layout «panes») shows every range as its own pane — a spectrum on top, a waterfall below — and keeps what each window saw,\n'+
  'so the bands stay on the screen while the receiver visits them (the pane being received is outlined, old data is dimmed).\n'+
  'More ranges than panes: the page turns after the scanner (follow); or use ◀ ▶ / the wheel on a pane title.\n'+
  'View: wheel on a pane — zoom, drag — pan, double click — back. Humps at the window step come from the filter edges: both nodes\n'+
  'drop 10% of each window (the «edge» parameter — keep them equal), so the useful middle is stitched without a gap.\n'+
  'SEARCH: «detect signals» + threshold (dB over the noise; the dashed line on a pane is where it is). A ▼ marks a signal and the scanner stops on it:\n'+
  'the strongest is tuned and played. SKIP: Shift+tap a ▼ (it turns into ⊘, Shift+tap it to return); the «Scan skip» table below is a skip list\n'+
  'by ranges (lo / hi) for pagers and beacons; «Clear skipped signals» wipes the taps. On a phone: the «⊘ skip» button below the panes, then tap a ▼ (or hold a ▼).\n'+
  'Tap a pane — marker 1–4; tap a pane title — retune. The receiver squelch (SNR) keeps the speaker quiet while the scan is not on a signal.'});
nt.size.w=720; nt.size.h=250; applySize(nt);
const rx=addNode('rtlsdr',40,300,{sr:'2400000',auto:false,gainDb:30,dcShift:true,demod:'NFM',bw:12500,freq:100000000,sql:'SNR',sqlSnr:8});
const bp=addNode('table',360,300,{list:'@patch',initial:false,data:'name,lo,hi,step\n'+
  'FM broadcast,87.5M,108M,100k\nAirband,118M,137M,25k\n2m ham,144M,146M,12.5k\nMarine VHF,156M,162.025M,25k\n'+
  'LPD433,433.05M,434.79M,25k\nPMR446,446M,446.2M,12.5k\nSRD 868,868M,870M,25k\nADS-B,1089M,1091M,1M'});
bp.size.w=340; bp.size.h=280; applySize(bp);
const bs=addNode('bandscan',740,300,{timeout:3000,settle:250,edge:10});
bs.size.w=300; bs.size.h=200; applySize(bs);
const sk=addNode('table',1080,300,{list:'Scan skip',initial:false});
sk.size.w=300; sk.size.h=220; applySize(sk);
const sa=addNode('sa',40,620,{layout:'panes',panes:4,detect:true,detThr:10,edge:10,follow:true,peakHold:true,floor:-90,top:-20,split:.45});
sa.size.w=1100; sa.size.h=440; applySize(sa);
const lg=addNode('table',1420,300,{list:'Scan log',initial:false});
lg.size.w=420; lg.size.h=260; applySize(lg);
const dc=addNode('dac',1420,620,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(bp.id,'bands',sa.id,'bands'); addEdge(bp.id,'bands',bs.id,'bands');
addEdge(sk.id,'bands',sa.id,'skip');
addEdge(rx.id,'freqLo',bs.id,'freqLo'); addEdge(rx.id,'freqHi',bs.id,'freqHi');
addEdge(sa.id,'count',bs.id,'active');
addEdge(bs.id,'freq',rx.id,'freq');
addEdge(sa.id,'detF',rx.id,'tuneFreq');
addEdge(sa.id,'rec',lg.id,'rec');
addEdge(rx.id,'audioL',dc.id,'L'); addEdge(rx.id,'audioR',dc.id,'R');
markWiresDirty();
});
preset('USB SDR: Signal Identifier', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the SDR and tune to a busy band. sigid finds signals in the spectrum,\n'+
  'then takes the raw IQ of each one in turn (at the native sample rate) and names the modulation:\n'+
  'AM/NFM/WFM/SSB/CW, FSK with shift and baud, BPSK/QPSK, CTCSS, stereo pilot.\n'+
  'Labels ride above the signals via the band plan; tap a signal to listen, the demod mode is up to you.\n'+
  'Click a band in the band plan to search only inside it; tick «whole spectrum» on sigid to search everywhere again.'});
nt.size.w=520; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,300,{sr:'2400000',auto:false,gainDb:30,dcShift:true,demod:'NFM',bw:12500,freq:446100000});
const bp=addNode('table',300,300,{list:'presets/Russia (full)',initial:false});
bp.size.w=340; bp.size.h=200; applySize(bp);
const si=addNode('sigid',680,740,{period:2,thr:8,maxSig:8});
si.size.w=560; si.size.h=260; applySize(si);
const sa=addNode('sa',680,40,{auto:true,floor:-90,top:-20,split:.45});
sa.size.w=760; sa.size.h=480; applySize(sa);
const dc=addNode('dac',300,700,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'spec',si.id,'spec');
addEdge(bp.id,'bands',si.id,'plan');
addEdge(bp.id,'lo',si.id,'fmin'); addEdge(bp.id,'hi',si.id,'fmax');   // клик по полосе — искать только в ней
addEdge(si.id,'bands',bp.id,'sigs');
addEdge(bp.id,'bands',sa.id,'bands');
addEdge(sa.id,'f1',rx.id,'tuneFreq');
addEdge(sa.id,'centerFreq',rx.id,'steerFreq');
addEdge(rx.id,'audio',dc.id,'L'); addEdge(rx.id,'audio',dc.id,'R');
markWiresDirty();
});
preset('IQ: Receiver from Blocks (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'A receiver wired from IQ blocks. Lime wires carry an IQ stream at its own sample rate.\n'+
  'Generator (1.024 MS/s, NFM at +100 kHz) → shift to zero → decimate ×16 (64 kS/s) → FM demodulator → IQ → Audio.\n'+
  'Tap a signal on the spectrum: marker 1 tunes the shift. Change the generator mode (AM/USB/LSB) and the demodulator with it.'});
nt.size.w=520; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'1024000',fc:100000000,mode:'FM',off:100000,lvl:-20,dev:3000,noise:-70});
const sp=addNode('iqSpec',40,560,{size:'8192'});
const sa=addNode('sa',600,40,{auto:true,floor:-110,top:0,split:.4});
sa.size.w=640; sa.size.h=340; applySize(sa);
const sh=addNode('iqShift',300,240,{offset:100000});
const dm=addNode('iqDecim',300,420,{M:'16'});
const de=addNode('iqDemod',600,440,{mode:'FM',dev:3000});
const au=addNode('iqAudio',860,440,{});
const sc=addNode('scope',1100,440);
const dc=addNode('dac',860,640,{vol:.3});
addEdge(gn.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(gn.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',dm.id,'in'); addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'out',au.id,'in');
addEdge(au.id,'out',sc.id,'in1'); addEdge(au.id,'out',dc.id,'L'); addEdge(au.id,'out',dc.id,'R');
markWiresDirty();
});
preset('Measure: Modulation Meter — FM and AM (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Modulation Meter: AM depth, FM deviation, modulating frequency, FM index and the carrier offset of a signal near the center.\n'+
  'The generator sends FM ±5 kHz with a 1 kHz tone, 2 kHz off the center. AM: depth from the positive and negative peaks of the envelope (a difference shows overmodulation or a distorted carrier).\n'+
  'FM: half of the peak-to-peak deviation of the instantaneous frequency inside the band; β = deviation / modulating frequency.\n'+
  'Change the generator mode to AM (depth 0.6) or the deviation and the tone. On a real signal shift it to zero first (IQ Frequency Shift) and decimate to a few × the channel width.'});
nt.size.w=700; nt.size.h=170; applySize(nt);
const gn=addNode('iqGen',40,260,{sr:'256000',fc:100000000,mode:'FM',off:2000,lvl:-20,tone:1000,dev:5000,depth:.6,noise:-60});
const mm=addNode('modMeter',340,260,{bw:15000,win:'250'});
mm.size.w=560; applySize(mm);
const n1=addNode('numview',340,420,{label:'AM depth, %'});
const n2=addNode('numview',560,420,{label:'FM deviation, Hz'});
const n3=addNode('numview',780,420,{label:'FM index β'});
addEdge(gn.id,'iq',mm.id,'in');
addEdge(mm.id,'am',n1.id,'in'); addEdge(mm.id,'dev',n2.id,'in'); addEdge(mm.id,'idx',n3.id,'in');
markWiresDirty();
});
preset('Measure: SINAD of an FM Receiver (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'SINAD of an FM receiver, the usual bench test: a carrier modulated by 1 kHz at ±3 kHz → demodulator → SINAD.\n'+
  'The tone is cut out by a sine fit over the whole window, what is left in 300–3400 Hz is noise and distortion: SINAD = (S+N+D)/(N+D), THD+N = √((N+D)/S).\n'+
  '12 dB SINAD is the usual sensitivity criterion of a voice receiver. Lower the generator level or raise its noise and watch SINAD fall; ENOB is shown in the readout.'});
nt.size.w=700; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:145000000,mode:'FM',off:0,lvl:-20,tone:1000,dev:3000,noise:-45});
const dm=addNode('iqDecim',300,240,{M:'4'});
const de=addNode('iqDemod',300,400,{mode:'FM',dev:3000});
const au=addNode('iqAudio',560,400,{});
const sn=addNode('sinad',860,240,{band:'300–3400 Hz',win:'0.5'});
sn.size.w=520; applySize(sn);
const nv=addNode('numview',860,520,{label:'SINAD, dB'});
addEdge(gn.id,'iq',dm.id,'in'); addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'out',au.id,'in');
addEdge(au.id,'out',sn.id,'in'); addEdge(sn.id,'sinad',nv.id,'in');
markWiresDirty();
});
preset('Measure: IQ Quality — DC and Imbalance (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'IQ Quality: DC offset (LO leakage), I/Q gain and phase error, and the image rejection from them — all from the moments of the stream over a window.\n'+
  'The generator sends a tone at +20 kHz and mirrors it with an imbalance (generator → advanced: Q gain, phase, delay): gain 0.5 dB and 2° give an image about 29 dB down.\n'+
  'Works on a tone away from zero, on noise or on a busy band; a carrier exactly at the center (real envelope) reads too low. On a real receiver wire the SDR\'s `iq` here and correct with IQ Balance / IQ DC Block.'});
nt.size.w=700; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:100000000,mode:'carrier',off:20000,lvl:-20,noise:-80,imbG:.5,imbP:2});
const iq=addNode('iqQuality',340,240,{win:'500'});
iq.size.w=620; applySize(iq);
const sp=addNode('iqSpec',340,420,{size:'4096'});
const sa=addNode('sa',620,420,{auto:true,floor:-110,top:0,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const nv=addNode('numview',990,240,{label:'image rejection, dB'});
addEdge(gn.id,'iq',iq.id,'in'); addEdge(iq.id,'irr',nv.id,'in');
addEdge(gn.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
markWiresDirty();
});
preset('ADS-B: Aircraft Map (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'ADS-B without a radio: the generator sends Mode S extended squitters (DF17) from three aircraft\n'+
  'circling near Novosibirsk — position (CPR even/odd), velocity, callsign — at 2.4 MS/s with noise.\n'+
  'Demodulator: preamble search, PPM bits, CRC-24. Decoder: CPR → lat/lon, altitude, speed, heading → map.'});
nt.size.w=560; nt.size.h=140; applySize(nt);
const gn=addNode('iqGen',40,220,{sr:'2400000',fc:1090000000,mode:'ADS-B',off:0,lvl:-20,noise:-40});
const dm=addNode('adsbDemod',40,560,{});
const de=addNode('adsbDecode',320,220,{rlat:55.01,rlon:82.65});
de.size.w=540; de.size.h=240; applySize(de);
const map=addNode('geoMap',900,40,{mz:8,mlat:55.0,mlon:82.65,ttl:5,labels:true,trail:300});
map.size.w=560; map.size.h=420; applySize(map);
addEdge(gn.id,'iq',dm.id,'in'); addEdge(dm.id,'rec',de.id,'rec'); addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('ADS-B: Aircraft Map (USB SDR, 1090 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Aircraft on the map straight from the air: SDR at 1090 MHz, 2.4 MS/s, raw IQ → ADS-B demodulator → decoder → map.\n'+
  'Connect the SDR (a 1090 MHz antenna helps a lot). Gain high, but watch the ADC: clipping kills weak frames.\n'+
  'Set your position in the decoder (or add My Position) — it checks positions by range and decodes surface ones.\n'+
  'Decoder text input takes AVR lines («*8D…;») too, e.g. dump1090 port 30002 via Text over Network.'});
nt.size.w=620; nt.size.h=160; applySize(nt);
const rx=addNode('rtlsdr',40,240,{sr:'2400000',freq:1090000000,demod:'IQ',auto:false,gainDb:40});
const dm=addNode('adsbDemod',340,240,{});
const de=addNode('adsbDecode',340,420,{});
de.size.w=540; de.size.h=280; applySize(de);
const map=addNode('geoMap',920,40,{mz:7,ttl:5,labels:true,trail:500,tiles:'none'});
map.size.w=600; map.size.h=460; applySize(map);
addEdge(rx.id,'iq',dm.id,'in'); addEdge(dm.id,'rec',de.id,'rec'); addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('USB SDR: FM Receiver from Blocks', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Broadcast FM receiver built from IQ blocks instead of the SDR\'s own demodulator.\n'+
  'Raw IQ (1.024 MS/s) → DC block → shift the tapped station to zero → ×4 (256 kS/s) → WFM: stereo pilot PLL,\n'+
  'RDS (name and radiotext in the demodulator\'s readout), 50 µs de-emphasis, audio at 42.7 kS/s → stereo out.\n'+
  'Connect the SDR, tap a station on the upper spectrum. The lower one shows the channel after decimation.'});
nt.size.w=600; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'1024000',freq:100000000,demod:'WFM'});
const sa=addNode('sa',680,40,{auto:true,floor:-90,top:-20,split:.4});
sa.size.w=640; sa.size.h=340; applySize(sa);
const dcb=addNode('iqDc',340,260,{});
const sh=addNode('iqShift',340,420,{});
const d1=addNode('iqDecim',340,580,{M:'4',cut:.45});
const sp=addNode('iqSpec',340,760,{size:'2048'});
const s2=addNode('sa',680,420,{auto:true,floor:-100,top:-20,split:.4});
s2.size.w=640; s2.size.h=260; applySize(s2);
const de=addNode('iqDemod',40,780,{mode:'WFM',deemph:'50 µs',stereo:true});
de.size.w=360; applySize(de);
const au=addNode('iqAudio',680,760,{});
const dc=addNode('dac',940,760,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',dcb.id,'in'); addEdge(dcb.id,'out',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',d1.id,'in'); addEdge(d1.id,'out',sp.id,'in'); addEdge(sp.id,'spec',s2.id,'spec');
addEdge(d1.id,'out',de.id,'in'); addEdge(de.id,'stereo',au.id,'in');
addEdge(au.id,'out',dc.id,'L'); addEdge(au.id,'q',dc.id,'R');
markWiresDirty();
});
preset('Remote SDR: FM Receiver (rtl_tcp over WebSocket)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'The same broadcast FM receiver as «USB SDR: FM Receiver from Blocks», but the RTL-SDR is on another machine (a Raspberry Pi, a server, a second PC): run `rtl_tcp -a 0.0.0.0 -s 1024000` there\n'+
  'and a TCP → WebSocket bridge next to it, e.g. `websockify 8766 127.0.0.1:1234` (or any other proxy that passes bytes). IQ over Network speaks rtl_tcp: it sets the rate, tunes, sets the gain / ppm / bias-T.\n'+
  'Another SDR can be used through the protocol «raw stream»: `rtl_sdr -f 100e6 -s 1024000 - | websocat -b -s 8766`, `hackrf_transfer -r - …`, GNU Radio, SoapySDR — set the format, rate and center by hand.\n'+
  'From the https page only wss:// works; from a local copy over http — ws:// too. Press Connect, tap a station on the upper spectrum.'});
nt.size.w=760; nt.size.h=180; applySize(nt);
const rx=addNode('iqnet',40,260,{url:'ws://127.0.0.1:8766',proto:'rtl_tcp',sr:1024000,freq:100000000});
rx.size.w=300; rx.size.h=180; applySize(rx);
const dcb=addNode('iqDc',400,260,{});
const w0=addNode('iqSpec',400,400,{size:'4096'});
const sa=addNode('sa',720,260,{auto:true,floor:-90,top:-20,split:.4});
sa.size.w=640; sa.size.h=300; applySize(sa);
const sh=addNode('iqShift',400,560,{});
const d1=addNode('iqDecim',400,720,{M:'4',cut:.45});
const sp=addNode('iqSpec',400,900,{size:'2048'});
const s2=addNode('sa',720,600,{auto:true,floor:-100,top:-20,split:.4});
s2.size.w=640; s2.size.h=260; applySize(s2);
const de=addNode('iqDemod',40,900,{mode:'WFM',deemph:'50 µs',stereo:true});
de.size.w=360; applySize(de);
const au=addNode('iqAudio',720,900,{});
const dc=addNode('dac',980,900,{vol:.4});
addEdge(rx.id,'iq',dcb.id,'in'); addEdge(dcb.id,'out',w0.id,'in'); addEdge(w0.id,'spec',sa.id,'spec');
addEdge(dcb.id,'out',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',d1.id,'in'); addEdge(d1.id,'out',sp.id,'in'); addEdge(sp.id,'spec',s2.id,'spec');
addEdge(d1.id,'out',de.id,'in'); addEdge(de.id,'stereo',au.id,'in');
addEdge(au.id,'out',dc.id,'L'); addEdge(au.id,'q',dc.id,'R');
markWiresDirty();
});
preset('USB SDR: HF AM / SSB from Blocks', function(){
clearAll();
const nt=addNode('note',40,40,{text:'HF receiver from IQ blocks (RTL-SDR with an upconverter / direct sampling, Airspy + HF, SDRplay).\n'+
  'Raw IQ → DC block → noise blanker (on the wide band, where impulses are still short) → shift the tapped\n'+
  'signal to zero → ×32 (32 kS/s) → SAM (PLL on the carrier; sideband both / USB / LSB / ISB) or USB / LSB →\n'+
  'squelch → audio → auto notch (removes whistles and heterodynes). Switch the demodulator mode as needed.'});
nt.size.w=640; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'1024000',freq:7100000,demod:'AM'});
const sa=addNode('sa',720,40,{auto:true,floor:-100,top:-30,split:.4});
sa.size.w=640; sa.size.h=340; applySize(sa);
const dcb=addNode('iqDc',340,260,{});
const nb=addNode('iqNb',340,400,{level:'mid'});
const sh=addNode('iqShift',340,540,{});
const d1=addNode('iqDecim',340,700,{M:'32',cut:.3});
const de=addNode('iqDemod',40,760,{mode:'SAM',samSb:'both',bw:5000});
de.size.w=360; applySize(de);
const sq=addNode('iqSquelch',720,440,{mode:'SNR',thr:6,hang:500});
const au=addNode('iqAudio',720,640,{});
const an=addNode('anf',980,640,{});
const dc=addNode('dac',1240,640,{vol:.4});
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',dcb.id,'in'); addEdge(dcb.id,'out',nb.id,'in'); addEdge(nb.id,'out',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',d1.id,'in'); addEdge(d1.id,'out',de.id,'in'); addEdge(de.id,'out',sq.id,'in');
addEdge(sq.id,'out',au.id,'in'); addEdge(au.id,'out',an.id,'in');
addEdge(an.id,'out',dc.id,'L'); addEdge(an.id,'out',dc.id,'R');
markWiresDirty();
});
preset('Sound Card IQ: HF Receiver (SoftRock-style)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'IQ from the stereo line input — a receiver with an audio IQ output (SoftRock, a direct-conversion kit).\n'+
  'Set the sample rate at the top to 96 or 192 kHz (the band you see is that wide). Left → I, right → Q.\n'+
  'IQ Balance fixes the gain/phase mismatch of the two channels (the mirror image; auto needs a busy band) and\n'+
  'a channel skew (delay ±1 sample on some cards). Tap a signal on the spectrum; SSB/AM mode in the demodulator.\n'+
  'Set fc in I/Q → IQ to the receiver\'s LO for real frequencies. Mirror spectrum — «swap I and Q».'});
nt.size.w=660; nt.size.h=170; applySize(nt);
const mic=addNode('mic',40,260,{mode:'stereo device'});
const mg=addNode('iqMerge',340,260,{fc:0});
const bal=addNode('iqBalance',340,400,{auto:true});
const dcb=addNode('iqDc',340,560,{});
const sp=addNode('iqSpec',40,560,{size:'4096'});
const sa=addNode('sa',720,40,{auto:true,floor:-110,top:-30,split:.4});
sa.size.w=640; sa.size.h=340; applySize(sa);
const sh=addNode('iqShift',720,420,{});
const d1=addNode('iqDecim',720,560,{M:'4',cut:.3});
const de=addNode('iqDemod',1000,420,{mode:'USB',bw:2700});
const au=addNode('iqAudio',1000,620,{});
const dc=addNode('dac',1260,620,{vol:.4});
addEdge(mic.id,'a',mg.id,'I'); addEdge(mic.id,'b',mg.id,'Q');
addEdge(mg.id,'iq',bal.id,'in'); addEdge(bal.id,'out',dcb.id,'in');
addEdge(dcb.id,'out',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(dcb.id,'out',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',d1.id,'in'); addEdge(d1.id,'out',de.id,'in'); addEdge(de.id,'out',au.id,'in');
addEdge(au.id,'out',dc.id,'L'); addEdge(au.id,'out',dc.id,'R');
markWiresDirty();
});
preset('Meteor-M LRPT: Image (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Meteor-M LRPT without a radio: the generator sends CCSDS frames the way M2-3/M2-4 do —\n'+
  'RS(255,223)×4, randomizer, NRZ-M, convolutional code K=7 r=1/2, OQPSK 72 kBd with RRC α=0.6 — at 256 kS/s,\n'+
  '+2 kHz off and with noise. PSK Demodulator: frequency search, carrier and symbol loops, constellation.\n'+
  'CCSDS Decoder: Viterbi sync (I/Q swap, 90°, pair shift), ASM, derandomizer, Reed–Solomon → VCDU frames.\n'+
  'LRPT Image: packets of VC5 → MSU-MR segments (JPEG 8×8, Huffman, quality QF) → channels 1–3 of a test picture\n'+
  'as an RGB composite (switch it, or one channel; Save PNG). Raise the generator noise: at −20 dBFS (Es/N0 ≈ 6 dB)\n'+
  'frames still come through.'});
nt.size.w=680; nt.size.h=200; applySize(nt);
const gn=addNode('iqGen',40,320,{sr:'256000',fc:137900000,mode:'LRPT',lrpt:'OQPSK',off:2000,lvl:-20,noise:-30});
const sp=addNode('iqSpec',40,700,{size:'4096'});
const sa=addNode('sa',340,700,{auto:true,floor:-90,top:-10});
sa.size.w=460; sa.size.h=220; applySize(sa);
const dm=addNode('pskDemod',340,320,{mode:'OQPSK'});
const de=addNode('ccsdsDecode',720,320,{nrzm:true});
de.size.w=380; applySize(de);
const im=addNode('lrptImage',1140,40,{comp:'RGB 123'});
im.size.w=520; im.size.h=420; applySize(im);
addEdge(gn.id,'iq',dm.id,'in'); addEdge(gn.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'rec',im.id,'rec');
markWiresDirty();
});
preset('Meteor-M LRPT: Image (USB SDR, 137 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Meteor-M LRPT frames straight from the air. The SDR sits 50 kHz below 137.9 MHz (off its DC spike),\n'+
  'the shift brings 137.9 MHz to zero; tap the signal on the spectrum to move it. 1.024 MS/s, the demodulator\n'+
  'decimates ÷4 itself. M2-3/M2-4: OQPSK + NRZ-M (default). Old M2: QPSK, NRZ-M off. The other channel is 137.1 MHz.\n'+
  'Needs a pass above ~15–20° with a 137 MHz antenna (QFH / turnstile / V-dipole); «Satellites: Track and Doppler»\n'+
  'tells when. LRPT Image builds the MSU-MR picture line by line: RGB 221 by day (channels 2, 2, 1), one IR channel\n'+
  '(4–6) at night; Save PNG when the pass is over. Lost frames leave black gaps, the rest stays in place.'});
nt.size.w=680; nt.size.h=200; applySize(nt);
const rx=addNode('rtlsdr',40,320,{sr:'1024000',freq:137850000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-90,top:-20,split:1});
sa.size.w=640; sa.size.h=300; applySize(sa);
const sh=addNode('iqShift',340,320,{offset:50000});
const dm=addNode('pskDemod',340,480,{mode:'OQPSK'});
const de=addNode('ccsdsDecode',760,400,{nrzm:true});
de.size.w=380; applySize(de);
const im=addNode('lrptImage',1180,400,{comp:'RGB 221'});
im.size.w=520; im.size.h=460; applySize(im);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',dm.id,'in'); addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'rec',im.id,'rec');
markWiresDirty();
});
preset('Radiosonde RS41: Map (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Radiosonde without a radio: the generator flies a Vaisala RS41 up from Novosibirsk — 5 m/s up, wind 8 m/s\n'+
  'to the north-east — and sends a 320-byte frame every second: GFSK 4800 Bd ±2.4 kHz, scrambled, RS(255,231)×2,\n'+
  'blocks with CRC. RS41 Radiosonde: FM discriminator, header correlation, bits, ECC, blocks → serial number,\n'+
  'position (ECEF), height, climb, speed, temperature and humidity (from the calibration sent in pieces, ~10 s) → map.'});
nt.size.w=680; nt.size.h=170; applySize(nt);
const gn=addNode('iqGen',40,260,{sr:'256000',fc:403000000,mode:'RS41',off:3000,lvl:-20,noise:-40});
const rx=addNode('rs41Rx',340,260,{});
rx.size.w=460; rx.size.h=200; applySize(rx);
const map=addNode('geoMap',860,40,{mz:10,mlat:55.05,mlon:82.95,ttl:30,labels:true,trail:600});
map.size.w=560; map.size.h=460; applySize(map);
addEdge(gn.id,'iq',rx.id,'in'); addEdge(rx.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('Radiosonde RS41: Map (USB SDR, 400–406 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Weather balloons on the map: Vaisala RS41 sondes, launched twice a day (00 and 12 UTC) from upper-air stations.\n'+
  'Set the SDR to the sonde frequency band (400–406 MHz; sondehub.org shows what flies near you), tap the\n'+
  'signal on the spectrum. 1.024 MS/s, the receiver decimates itself. Serial, position, height, climb, speed,\n'+
  'temperature and humidity (after ~10 s of calibration) — table in the node, track on the map; «Record Log» saves CSV.'});
nt.size.w=680; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'1024000',freq:403500000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,260,{});
const de=addNode('rs41Rx',340,420,{});
de.size.w=460; de.size.h=220; applySize(de);
const map=addNode('geoMap',860,360,{mz:8,ttl:60,labels:true,trail:3000});
map.size.w=560; map.size.h=420; applySize(map);
const log=addNode('recLog',340,700,{});
log.size.w=460; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',map.id,'rec'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('MPT 1327: Control Channel (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'MPT 1327 trunking without a radio: the generator sends a control channel — FFSK 1200 Bd (1 = 1200 Hz, 0 = 1800 Hz)\n'+
  'on an FM carrier, ±2.5 kHz: preamble, sync word 0xC4D7, address codewords with a data codeword every other message.\n'+
  'MPT 1327 Decoder: FM discriminator, 8 bit-clock phases, sync search, CRC-15 and parity → PFIX/IDENT and raw codewords.'});
nt.size.w=680; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:160000000,mode:'MPT1327',off:7000,lvl:-20,noise:-50});
const de=addNode('mpt1327Rx',340,240,{});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,600,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('MPT 1327: Control Channel (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'MPT 1327 analogue trunking: tune the SDR to a control channel (VHF/UHF business bands; the strongest steady FM signal\n'+
  'with a constant data buzz) and tap it on the spectrum. The decoder shows codewords with PFIX/IDENT; the log saves CSV.'});
nt.size.w=680; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:160000000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('mpt1327Rx',340,360,{});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('NMEA: GPS Track (Table Playback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'NMEA 0183 without a receiver: the Table plays GGA / RMC / VTG sentences of a walk around a block (one epoch a second, three rows each).\n'+
  'NMEA Parser: checksum → fields; the three sentences of an epoch are joined into one record (position, altitude, speed, course, satellites, HDOP) → map.\n'+
  'The numeric outputs (lat, lon, sog, cog…) go to any node. A real receiver: Serial Port (WebSerial) or Text over Network (gpsd, Termux) → text of the parser.'});
nt.size.w=720; nt.size.h=130; applySize(nt);
const sq=addNode('table',40,200,{list:'@patch',textCol:'nmea',rate:3,loop:true,
  data:'nmea\n"$GPGGA,073000,5501.9500,N,08255.2000,E,1,09,0.9,150.0,M,-35.0,M,,*6C"\n"$GPRMC,073000,A,5501.9500,N,08255.2000,E,5.0,90.0,150625,,,A*48"\n"$GPVTG,90.0,T,,M,5.0,N,9.3,K,A*3B"\n"$GPGGA,073001,5501.9449,N,08255.2679,E,1,09,0.9,150.8,M,-35.0,M,,*61"\n"$GPRMC,073001,A,5501.9449,N,08255.2679,E,5.2,105.0,150625,,,A*72"\n"$GPVTG,105.0,T,,M,5.2,N,9.6,K,A*01"\n"$GPGGA,073002,5501.9299,N,08255.3313,E,1,09,0.9,151.5,M,-35.0,M,,*6D"\n"$GPRMC,073002,A,5501.9299,N,08255.3313,E,5.4,120.0,150625,,,A*73"\n"$GPVTG,120.0,T,,M,5.4,N,10.0,K,A*3E"\n"$GPGGA,073003,5501.9061,N,08255.3856,E,1,09,0.9,152.1,M,-35.0,M,,*64"\n"$GPRMC,073003,A,5501.9061,N,08255.3856,E,5.6,135.0,150625,,,A*7B"\n"$GPVTG,135.0,T,,M,5.6,N,10.4,K,A*3C"\n"$GPGGA,073004,5501.8750,N,08255.4273,E,1,09,0.9,152.6,M,-35.0,M,,*6A"\n"$GPRMC,073004,A,5501.8750,N,08255.4273,E,5.8,150.0,150625,,,A*7F"\n"$GPVTG,150.0,T,,M,5.8,N,10.7,K,A*32"\n"$GPGGA,073005,5501.8388,N,08255.4536,E,1,09,0.9,152.9,M,-35.0,M,,*63"\n"$GPRMC,073005,A,5501.8388,N,08255.4536,E,6.0,165.0,150625,,,A*74"\n"$GPVTG,165.0,T,,M,6.0,N,11.1,K,A*38"\n"$GPGGA,073006,5501.8000,N,08255.4625,E,1,09,0.9,153.0,M,-35.0,M,,*6A"\n"$GPRMC,073006,A,5501.8000,N,08255.4625,E,5.0,180.0,150625,,,A*7D"\n"$GPVTG,180.0,T,,M,5.0,N,9.3,K,A*0B"\n"$GPGGA,073007,5501.7612,N,08255.4536,E,1,09,0.9,152.9,M,-35.0,M,,*68"\n"$GPRMC,073007,A,5501.7612,N,08255.4536,E,5.2,195.0,150625,,,A*71"\n"$GPVTG,195.0,T,,M,5.2,N,9.6,K,A*08"\n"$GPGGA,073008,5501.7250,N,08255.4273,E,1,09,0.9,152.6,M,-35.0,M,,*6C"\n"$GPRMC,073008,A,5501.7250,N,08255.4273,E,5.4,210.0,150625,,,A*72"\n"$GPVTG,210.0,T,,M,5.4,N,10.0,K,A*3E"\n"$GPGGA,073009,5501.6939,N,08255.3856,E,1,09,0.9,152.1,M,-35.0,M,,*65"\n"$GPRMC,073009,A,5501.6939,N,08255.3856,E,5.6,225.0,150625,,,A*78"\n"$GPVTG,225.0,T,,M,5.6,N,10.4,K,A*3E"\n"$GPGGA,073010,5501.6701,N,08255.3313,E,1,09,0.9,151.5,M,-35.0,M,,*65"\n"$GPRMC,073010,A,5501.6701,N,08255.3313,E,5.8,240.0,150625,,,A*72"\n"$GPVTG,240.0,T,,M,5.8,N,10.7,K,A*30"\n"$GPGGA,073011,5501.6551,N,08255.2679,E,1,09,0.9,150.8,M,-35.0,M,,*67"\n"$GPRMC,073011,A,5501.6551,N,08255.2679,E,6.0,255.0,150625,,,A*73"\n"$GPVTG,255.0,T,,M,6.0,N,11.1,K,A*38"\n"$GPGGA,073012,5501.6500,N,08255.2000,E,1,09,0.9,150.0,M,-35.0,M,,*60"\n"$GPRMC,073012,A,5501.6500,N,08255.2000,E,5.0,270.0,150625,,,A*78"\n"$GPVTG,270.0,T,,M,5.0,N,9.3,K,A*07"\n"$GPGGA,073013,5501.6551,N,08255.1321,E,1,09,0.9,149.2,M,-35.0,M,,*6C"\n"$GPRMC,073013,A,5501.6551,N,08255.1321,E,5.2,285.0,150625,,,A*76"\n"$GPVTG,285.0,T,,M,5.2,N,9.6,K,A*0A"\n"$GPGGA,073014,5501.6701,N,08255.0687,E,1,09,0.9,148.5,M,-35.0,M,,*62"\n"$GPRMC,073014,A,5501.6701,N,08255.0687,E,5.4,300.0,150625,,,A*74"\n"$GPVTG,300.0,T,,M,5.4,N,10.0,K,A*3E"\n"$GPGGA,073015,5501.6939,N,08255.0144,E,1,09,0.9,147.9,M,-35.0,M,,*6D"\n"$GPRMC,073015,A,5501.6939,N,08255.0144,E,5.6,315.0,150625,,,A*7E"\n"$GPVTG,315.0,T,,M,5.6,N,10.4,K,A*3C"\n"$GPGGA,073016,5501.7250,N,08254.9727,E,1,09,0.9,147.4,M,-35.0,M,,*6D"\n"$GPRMC,073016,A,5501.7250,N,08254.9727,E,5.8,330.0,150625,,,A*7A"\n"$GPVTG,330.0,T,,M,5.8,N,10.7,K,A*36"\n"$GPGGA,073017,5501.7612,N,08254.9464,E,1,09,0.9,147.1,M,-35.0,M,,*6F"\n"$GPRMC,073017,A,5501.7612,N,08254.9464,E,6.0,345.0,150625,,,A*74"\n"$GPVTG,345.0,T,,M,6.0,N,11.1,K,A*38"\n"$GPGGA,073018,5501.8000,N,08254.9375,E,1,09,0.9,147.0,M,-35.0,M,,*6C"\n"$GPRMC,073018,A,5501.8000,N,08254.9375,E,5.0,0.0,150625,,,A*77"\n"$GPVTG,0.0,T,,M,5.0,N,9.3,K,A*02"\n"$GPGGA,073019,5501.8388,N,08254.9464,E,1,09,0.9,147.1,M,-35.0,M,,*68"\n"$GPRMC,073019,A,5501.8388,N,08254.9464,E,5.2,15.0,150625,,,A*44"\n"$GPVTG,15.0,T,,M,5.2,N,9.6,K,A*31"\n"$GPGGA,073020,5501.8750,N,08254.9727,E,1,09,0.9,147.4,M,-35.0,M,,*62"\n"$GPRMC,073020,A,5501.8750,N,08254.9727,E,5.4,30.0,150625,,,A*4A"\n"$GPVTG,30.0,T,,M,5.4,N,10.0,K,A*0E"\n"$GPGGA,073021,5501.9061,N,08255.0144,E,1,09,0.9,147.9,M,-35.0,M,,*61"\n"$GPRMC,073021,A,5501.9061,N,08255.0144,E,5.6,45.0,150625,,,A*44"\n"$GPVTG,45.0,T,,M,5.6,N,10.4,K,A*0A"\n"$GPGGA,073022,5501.9299,N,08255.0687,E,1,09,0.9,148.5,M,-35.0,M,,*6C"\n"$GPRMC,073022,A,5501.9299,N,08255.0687,E,5.8,60.0,150625,,,A*43"\n"$GPVTG,60.0,T,,M,5.8,N,10.7,K,A*00"\n"$GPGGA,073023,5501.9449,N,08255.1321,E,1,09,0.9,149.2,M,-35.0,M,,*68"\n"$GPRMC,073023,A,5501.9449,N,08255.1321,E,6.0,75.0,150625,,,A*4E"\n"$GPVTG,75.0,T,,M,6.0,N,11.1,K,A*08"'});
sq.size.w=300; sq.size.h=300; applySize(sq);
const pa=addNode('nmea',380,200,{});
pa.size.w=420; pa.size.h=300; applySize(pa);
const map=addNode('geoMap',840,40,{mz:16,mlat:55.03,mlon:82.92,ttl:300,labels:false,trail:600});
map.size.w=560; map.size.h=460; applySize(map);
const log=addNode('recLog',380,540,{});
log.size.w=420; applySize(log);
addEdge(sq.id,'text',pa.id,'text'); addEdge(pa.id,'rec',map.id,'rec'); addEdge(pa.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('NMEA: Network Stream (gpsd, AIS-catcher, Termux)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'NMEA over WebSocket: any program that writes NMEA lines to a pipe, through websocat — e.g. a GPS: gpsd → gpspipe -r | websocat -s 8765,\n'+
  'AIS-catcher / rtl-ais with -N / -u (NMEA to UDP) → a UDP-to-WebSocket bridge, a ship\'s multiplexer (port 10110) → websockify. From the https page only wss://.\n'+
  'Edit the URL in Text over Network and press Connect. !AIVDM sentences become vessels (name, type, size) on the map like in AIS Decoder;\n'+
  'GGA / RMC / VTG become the position of the receiver, depth, wind, water temperature and heading go to the numeric outputs.'});
nt.size.w=760; nt.size.h=150; applySize(nt);
const nx=addNode('nettext',40,230,{url:'ws://127.0.0.1:8765'});
nx.size.w=300; nx.size.h=240; applySize(nx);
const pa=addNode('nmea',380,230,{});
pa.size.w=420; pa.size.h=300; applySize(pa);
const map=addNode('geoMap',840,40,{mz:12,ttl:1800,labels:true,trail:600});
map.size.w=560; map.size.h=460; applySize(map);
const log=addNode('recLog',380,570,{});
log.size.w=420; applySize(log);
addEdge(nx.id,'line',pa.id,'text'); addEdge(nx.id,'go',pa.id,'go'); addEdge(pa.id,'rec',map.id,'rec'); addEdge(pa.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('AIS: Vessels on the Map (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'AIS without a radio: the generator sends position reports (types 1, 18), static data (5, 24), a base station (4) and an aid to navigation (21)\n'+
  'of four vessels near the Bosphorus — GMSK 9600 Bd on an FM carrier ±2.4 kHz, NRZI, HDLC with bit stuffing and CRC-16. Positions advance faster than real time.\n'+
  'AIS Decoder: FM discriminator, 8 bit-clock phases, flags, CRC → messages by MMSI; names and dimensions from type 5 / 24 join the positions → map.\n'+
  'The text output gives !AIVDM sentences for other programs (Network Out, Serial Out).'});
nt.size.w=720; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,260,{sr:'256000',fc:162000000,mode:'AIS',off:-25000,lvl:-20,noise:-50});
const de=addNode('aisRx',340,260,{});
de.size.w=520; de.size.h=300; applySize(de);
const map=addNode('geoMap',900,40,{mz:11,mlat:41.03,mlon:29.03,ttl:30,labels:true,trail:600});
map.size.w=560; map.size.h=460; applySize(map);
const log=addNode('recLog',340,620,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',map.id,'rec'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('AIS: Vessels on the Map (USB SDR, 162 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'AIS: channel A is 161.975 MHz, channel B 162.025 MHz — both fit into the 1 MS/s window around 162.000 MHz. Connect the SDR, put marker 1\n'+
  'of the Spectrum Analyzer on one of the channels (tune it to the other for B, set the letter in the decoder). A VHF antenna near the coast or a harbour works best.\n'+
  'Vessels appear on the map with a name once a static report (type 5 / 24, every ~6 min) has been heard; the log saves CSV.'});
nt.size.w=720; nt.size.h=130; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:162000000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('aisRx',340,360,{});
de.size.w=520; de.size.h=300; applySize(de);
const map=addNode('geoMap',760,360,{mz:9,ttl:30,labels:true,trail:600});
map.size.w=560; map.size.h=400; applySize(map);
const log=addNode('recLog',340,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',map.id,'rec'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('POCSAG: Pager Messages (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'POCSAG paging without a radio: the generator sends a text page, a numeric page and a tone-only call in turn — 2-FSK ±4.5 kHz, 1200 Bd\n'+
  '(pick 512 or 2400 in the generator): preamble 1010…, batches of a sync word and 16 codewords, BCH(31,21) and parity, RIC = address ×8 + frame.\n'+
  'POCSAG Decoder: FM discriminator, all three baud rates and 8 bit-clock phases at once, polarity by the sync word, errors corrected up to 2 bits per codeword → RIC, function, text / digits.\n'+
  'Messages lists them (to = RIC); Rec Log saves CSV.'});
nt.size.w=760; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,260,{sr:'256000',fc:466000000,mode:'POCSAG',off:5000,lvl:-20,noise:-50});
const de=addNode('pocsagRx',340,260,{});
de.size.w=520; de.size.h=300; applySize(de);
const ms=addNode('msgLog',900,260,{});
ms.size.w=480; ms.size.h=300; applySize(ms);
const log=addNode('recLog',340,620,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',ms.id,'rec'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('POCSAG: Pager Messages (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'POCSAG: tune the SDR to a local paging channel (frequencies differ by country: VHF 148–174 MHz, UHF 440–470 MHz, 929 MHz in North America)\n'+
  'and tap the narrow FSK signal on the spectrum. Check the baud rate (auto tries 512 / 1200 / 2400). Pages are addressed to people: keep to the law of your country\n'+
  'on receiving and storing them.'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:466000000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('pocsagRx',340,360,{});
de.size.w=520; de.size.h=300; applySize(de);
const ms=addNode('msgLog',900,360,{});
ms.size.w=480; ms.size.h=300; applySize(ms);
const log=addNode('recLog',340,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',ms.id,'rec'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('POCSAG: Transmitter Loopback (no radio)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'POCSAG paging transmitter checked against the decoder without a radio: POCSAG Transmit builds the signal (preamble, sync word, address and message codewords with BCH, 1 = lower frequency),\n'+
  'IQ Modulator makes NFM with ±4.5 kHz deviation, POCSAG Decoder reads it back. Edit the text, RIC, type (text / numeric / tone) and baud rate and press Send.\n'+
  'Numeric messages take 0–9 * U space - [ ] ( ( and ) become [ and ]).'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const tx=addNode('pocsagTx',40,200,{text:'Hello from the DSP workbench',ric:1234567,func:'3',type:'alpha',baud:'1200'});
tx.size.w=340; tx.size.h=200; applySize(tx);
const md=addNode('iqMod',420,200,{mode:'NFM',sr:'2000000',fc:466000000,off:0,dev:4500,lvl:-6});
const de=addNode('pocsagRx',720,200,{});
de.size.w=480; de.size.h=260; applySize(de);
const log=addNode('recLog',720,500,{});
log.size.w=480; applySize(log);
addEdge(tx.id,'out',md.id,'in'); addEdge(md.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('POCSAG: Send a Page (HackRF TX)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Page a pager with a HackRF: POCSAG Transmit → IQ Modulator (NFM, ±4.5 kHz) → HackRF TX. Set the carrier frequency of your pager (center frequency + offset in IQ Modulator),\n'+
  'its RIC (the capcode), the baud rate and the message type (a pager takes what its code plug allows: text on function 3, numeric on function 0 is common). If the pager stays silent, try the *invert* switch.\n'+
  'Press Connect in HackRF TX, then Send in POCSAG Transmit: the tx pin turns the transmitter on for the length of the message. TX VGA and amp are off by default — start at the lowest power, close to the pager.\n'+
  'You must comply with local radio regulations: transmit only on frequencies and with power the law allows you (a licence, a test cable or a shielded box).'});
nt.size.w=900; nt.size.h=150; applySize(nt);
const tx=addNode('pocsagTx',40,240,{text:'TEST',ric:1234567,func:'3',type:'alpha',baud:'1200'});
tx.size.w=340; tx.size.h=200; applySize(tx);
const md=addNode('iqMod',420,240,{mode:'NFM',sr:'2000000',fc:466000000,off:100000,dev:4500,lvl:-6});
const hk=addNode('hackrfTx',720,240,{});
hk.size.w=300; applySize(hk);
addEdge(tx.id,'out',md.id,'in'); addEdge(md.id,'iq',hk.id,'in'); addEdge(tx.id,'tx',hk.id,'tx');
markWiresDirty();
});
preset('Time Signal: DCF77 Clock (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'DCF77 without a radio: the generator sends the carrier of Mainflingen, 77.5 kHz, with the power dips of the current time — 100 ms is 0, 200 ms is 1, no dip in the 59th second\n'+
  'and the frame of the next minute (BCD minutes, hours, date, weekday, parity bits, CET / CEST).\n'+
  'Time Signal Decoder: mixer on the carrier → 400 Hz envelope → upper / lower level tracking → width of every dip → bit → minute frame with checks → UTC time.\n'+
  'A frame takes a minute, and two in a row confirm each other (~3 minutes from the start): set the run speed in the toolbar to ×8 … ×32 and the time appears in seconds —\n'+
  'the decoder counts samples of the stream, not the clock of the page.'});
nt.size.w=760; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,230,{sr:'48000',fc:77500,mode:'DCF77',off:0,lvl:-20,noise:-50});
const de=addNode('timeRx',340,230,{station:'DCF77'});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,590,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('Time Signal: WWVB Clock (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'WWVB without a radio: the generator sends the 60 kHz carrier of Fort Collins with the power dips of the current time — 200 ms is 0, 500 ms is 1, 800 ms is a marker (seconds 0, 9, 19 … 59)\n'+
  'and the frame of the minute: BCD minutes, hours, day of the year, DUT1, year, leap flags.\n'+
  'Time Signal Decoder: mixer on the carrier → 400 Hz envelope → upper / lower level tracking → width of every dip → bit → minute frame with checks → UTC time.\n'+
  'A frame takes a minute, and two in a row confirm each other (~3 minutes from the start): set the run speed in the toolbar to ×8 … ×32 and the time appears in seconds —\n'+
  'the decoder counts samples of the stream, not the clock of the page.'});
nt.size.w=760; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,230,{sr:'48000',fc:60000,mode:'WWVB',off:0,lvl:-20,noise:-50});
const de=addNode('timeRx',340,230,{station:'WWVB'});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,590,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('Time Signal: DCF77 / WWVB from a Sound Card (192 kS/s)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'A longwave time signal straight into a sound card: set the sample rate of the engine (toolbar) to 192000, connect a tuned ferrite loop antenna (77.5 kHz for DCF77, 60 kHz for WWVB) to the line input.\n'+
  'The input is a real signal at 192 kS/s, I/Q → IQ makes a stream of it with the centre at 0, Time Signal Decoder mixes the station frequency down (carrier = stream center).\n'+
  'With an SDR that tunes 60–80 kHz (RX-888, a KiwiSDR-like receiver, an upconverter) put its iq output on the decoder input instead; the stream centre frequency is taken into account.\n'+
  'Without a signal the node says so: look at the carrier level and the depth of the dips (>35% for a frame to be tried).'});
nt.size.w=900; nt.size.h=130; applySize(nt);
const mc=addNode('mic',40,230,{echo:false,ns:false,agc:false});
const iq=addNode('iqMerge',340,230,{});
const de=addNode('timeRx',640,230,{station:'DCF77'});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',640,590,{});
log.size.w=520; applySize(log);
addEdge(mc.id,'a',iq.id,'I'); addEdge(iq.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('SAME / EAS: Alert Decoder Test (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'SAME (NOAA Weather Radio, EAS) without a radio: SAME Test Signal sends a header three times — AFSK 520.83 Bd, 1 = 2083.3 Hz, 0 = 1562.5 Hz, the preamble of 16 bytes 0xAB —\n'+
  'and then NNNN three times. SAME / EAS Decoder: 8 bit-clock phases, search for ZCZC / NNNN, the three repeats are voted character by character → originator, event, areas, validity, station.\n'+
  'Press Send in the test node (default: a Required Weekly Test). The test signal is for checking the decoder on a cable or in the sound card only: never put it on the air or into an alerting system.'});
nt.size.w=840; nt.size.h=130; applySize(nt);
const tx=addNode('sameTx',40,230,{});
tx.size.w=340; tx.size.h=320; applySize(tx);
const rx=addNode('sameRx',420,230,{});
rx.size.w=520; rx.size.h=300; applySize(rx);
const log=addNode('recLog',420,590,{});
log.size.w=520; applySize(log);
addEdge(tx.id,'out',rx.id,'in'); addEdge(rx.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('SAME / EAS: NOAA Weather Radio (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'NOAA Weather Radio (US, 162.400 / .425 / .450 / .475 / .500 / .525 / .550 MHz, narrow FM): tune to the local channel; alerts begin with the SAME burst, so leave the patch running.\n'+
  'SAME / EAS Decoder shows the event (Tornado Warning, Required Weekly Test…), the areas as FIPS codes (PSSCCC), the validity time and the station; the log keeps them as CSV.'});
nt.size.w=840; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{auto:false,gainDb:35,demod:'NFM',bw:12500,freq:162550000});
const sa=addNode('sa',40,520,{auto:true,split:.35});
sa.size.w=480; sa.size.h=300; applySize(sa);
const de=addNode('sameRx',420,200,{});
de.size.w=520; de.size.h=300; applySize(de);
const dc=addNode('dac',720,520,{vol:.3});
const log=addNode('recLog',420,560,{});
log.size.w=260; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(rx.id,'audio',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
addEdge(rx.id,'audio',dc.id,'L'); addEdge(rx.id,'audio',dc.id,'R');
markWiresDirty();
});
preset('SELCAL: Test Signal (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Aviation SELCAL (ICAO Annex 10, HF / VHF) without a radio: SELCAL Test Signal sends a code — two pulses of two tones each (1.0 s, gap 0.2 s), the 16 tones A…S from 312.6 to 1479.1 Hz,\n'+
  'AB-CD = tones A and B, then C and D. SELCAL Decoder: Goertzel on 16 frequencies in a 90 ms window every 43 ms → two tones → pulse → two pulses → code. The tone table and the timings are from the ASRI SELCAL Users Guide.\n'+
  'Press Send; put a code of your aircraft into *watch for a code* to see a match mark. The test signal is for a cable or the sound-card loop only: do not transmit it — it would call someone else\'s aircraft.'});
nt.size.w=900; nt.size.h=130; applySize(nt);
const tx=addNode('selcalTx',40,230,{});
tx.size.w=340; tx.size.h=300; applySize(tx);
const rx=addNode('selcalRx',420,230,{});
rx.size.w=500; rx.size.h=300; applySize(rx);
const log=addNode('recLog',420,590,{});
log.size.w=500; applySize(log);
addEdge(tx.id,'out',rx.id,'in'); addEdge(rx.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('SELCAL: HF Aeronautical Channel (KiwiSDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'SELCAL listens on the same channel as the voice: an HF aeronautical (MWARA / VOLMET-type) frequency in USB. Connect a KiwiSDR, set the channel (8891 kHz is only an example), USB.\n'+
  'Tones appear in the audio at their own pitch, so the receiver has to be tuned within a few Hz: the decoder shows the measured offset (tuning error) with every code, and *receiver tuning error* shifts the table.\n'+
  'An error of about half the tone spacing (17 Hz at the low end) turns A-B-C into neighbours that look like a valid code — check the offset line if a result looks odd.'});
nt.size.w=900; nt.size.h=130; applySize(nt);
const kw=addNode('kiwisdr',40,230,{freq:8891000,mod:'usb',bw:3000});
const rx=addNode('selcalRx',420,230,{});
rx.size.w=500; rx.size.h=300; applySize(rx);
const dc=addNode('dac',420,590,{vol:.4});
const log=addNode('recLog',700,590,{});
log.size.w=400; applySize(log);
addEdge(kw.id,'audio',rx.id,'in'); addEdge(rx.id,'rec',log.id,'rec');
addEdge(kw.id,'audio',dc.id,'L'); addEdge(kw.id,'audio',dc.id,'R');
markWiresDirty();
});
preset('Selcall ZVEI / CCIR: Five-Tone Decoder Test (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Five-tone selective calling of land mobile radio (fire and rescue, taxis, security): a code is 5 tones in a row, 33–100 ms each, E = the repeat tone for a doubled digit.\n'+
  'Five-Tone Selcall: Test Signal plays a code in the chosen standard (ZVEI-1/2/3, DZVEI, PZVEI, CCIR, EEA, EIA); Five-Tone Selcall Decoder: Hann window of 0.7 tone, Goertzel on 16 frequencies every 1/8 tone → tone → sequence (tones spaced 0.6–1.8 tone lengths).\n'+
  'Press Send. Put the same standard into both nodes. The test signal is for a cable or the sound-card loop only: such tones start real alarm receivers — do not transmit it.'});
nt.size.w=900; nt.size.h=130; applySize(nt);
const tx=addNode('fivetoneTx',40,230,{});
tx.size.w=340; tx.size.h=300; applySize(tx);
const rx=addNode('fivetoneRx',420,230,{});
rx.size.w=500; rx.size.h=300; applySize(rx);
const log=addNode('recLog',420,590,{});
log.size.w=500; applySize(log);
addEdge(tx.id,'out',rx.id,'in'); addEdge(rx.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('Selcall ZVEI / CCIR: Five-Tone Decoder (USB SDR, NFM)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Five-tone calls over narrow FM: tune the SDR to a channel that is used for selective calling (the band and the standard are a local matter: ZVEI-1 is common in German-speaking countries, CCIR / EEA in many others),\n'+
  'pick the standard in the decoder, and the tone length if it differs from the usual (the decoder takes ±40%). The code appears when the tones stop. In the PZVEI table 0 and E share 2400 Hz — a 0 after a 0 is shown as E.\n'+
  'Alarm calls are addressed to people and organisations: keep to the law of your country about receiving and storing them.'});
nt.size.w=900; nt.size.h=130; applySize(nt);
const rx=addNode('rtlsdr',40,230,{auto:false,gainDb:35,demod:'NFM',bw:12500,freq:155000000});
const sa=addNode('sa',40,560,{auto:true,split:.35});
sa.size.w=480; sa.size.h=300; applySize(sa);
const de=addNode('fivetoneRx',420,230,{});
de.size.w=500; de.size.h=300; applySize(de);
const dc=addNode('dac',720,560,{vol:.3});
const log=addNode('recLog',560,590,{});
log.size.w=260; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(rx.id,'audio',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
addEdge(rx.id,'audio',dc.id,'L'); addEdge(rx.id,'audio',dc.id,'R');
markWiresDirty();
});
preset('ISM 433: Sensors and Remotes (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'433 MHz without a radio: the generator sends OOK telegrams in turn — a Nexus/TFA-type temperature and humidity sensor (PPM, 36 bits, 5 repeats),\n'+
  'an EV1527/PT2262 remote (PWM, 20-bit address + 4 data bits, 6 repeats) and a Manchester packet of an unknown protocol.\n'+
  'ISM 433 Decoder: envelope → slicer → pulse train → PWM / PPM / Manchester → protocol. Unknown packets are logged with timings and bits.\n'+
  'Rec: Unique by Key keeps one line per device (id), with a counter and first / last time.'});
nt.size.w=720; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,200,{sr:'1024000',fc:433920000,mode:'ISM433',off:20000,lvl:-20,noise:-50});
const de=addNode('ismRx',340,200,{});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,560,{});
log.size.w=520; applySize(log);
const uniq=addNode('recUniq',900,200,{key:'id'});
uniq.size.w=420; uniq.size.h=260; applySize(uniq);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec'); addEdge(de.id,'rec',uniq.id,'rec');
markWiresDirty();
});
preset('ISM 433: Sensors and Remotes (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'433.92 MHz ISM band: weather sensors, door and gate remotes, doorbells, car keys (OOK; FSK ones need modulation OOK+FSK or FSK).\n'+
  'Tap the burst on the spectrum: the decoder shows the protocol (EV1527/PT2262, Nexus) or, for an unknown one, the encoding (PWM/PPM/Manchester),\n'+
  'pulse timings and the bits. With HackRF turn RX AMP and LNA on; keep the signal off the DC spike (tune 100–200 kHz aside).'});
nt.size.w=720; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:433920000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('ismRx',340,360,{});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('LoRa: Chirp Link (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'LoRa without a radio: LoRa Modulator builds a real frame (preamble of up-chirps, sync word, 2.25 down-chirps, header, payload with CRC, whitening, Hamming, interleaving, Gray)\n'+
  'and sends it as IQ every 3 s with a frequency offset, a clock error and noise; LoRa Decoder finds the preamble, aligns on the up / down pair, measures the offset and reads the text.\n'+
  'Change the spreading factor (it must match in both blocks), the bandwidth, the coding rate or raise the noise: in the simulator the decoder holds down to about −5 dB SNR at SF7 and −12 dB at SF12 (chip datasheets quote lower figures).\n'+
  'The waterfall shows the chirps: a diagonal line that wraps around the band.'});
nt.size.w=760; nt.size.h=130; applySize(nt);
const tx=addNode('loraTx',40,200,{sr:'250000',sf:'8',bw:'125000',every:3,off:4000,ppm:10,noise:-40,lvl:-20});
tx.size.w=420; tx.size.h=300; applySize(tx);
const sp=addNode('iqSpec',500,200,{size:'1024'});
const sa=addNode('sa',760,200,{auto:true,floor:-110,top:-10,split:.4});
sa.size.w=620; sa.size.h=320; applySize(sa);
const de=addNode('loraRx',500,380,{sf:'8',bw:'125000'});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',1060,560,{});
log.size.w=420; applySize(log);
addEdge(tx.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(tx.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('LoRa: Receive (USB SDR, 868 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'LoRa on the air: tune the SDR to a LoRa channel (EU868: 868.1 / 868.3 / 868.5 MHz, US915: 902–928 MHz, Asia 433.05–434.79 MHz, Meshtastic EU 869.525 MHz)\n'+
  'and tap the chirps on the spectrum. Set the spreading factor and bandwidth of the network (LoRaWAN EU: SF7–12 at 125 kHz; Meshtastic LongFast: SF11 / 250 kHz). Use sync word 34 for LoRaWAN, 2B for Meshtastic, any to take all.\n'+
  'The decoder shows the frame, its SNR and carrier offset. LoRaWAN payloads are encrypted: the record carries them as hex (the MAC header with the device address is in the first bytes). Take only what the law of your country lets you receive and keep.'});
nt.size.w=820; nt.size.h=130; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:868100000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('loraRx',340,360,{sf:'7',bw:'125000'});
de.size.w=520; de.size.h=300; applySize(de);
const log=addNode('recLog',340,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('LoRa: Send a Message (HackRF TX)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'LoRa Modulator → HackRF TX: a LoRa frame from the browser. Set the center frequency (868100000 for EU868 channel 1), the spreading factor, bandwidth, coding rate and sync word of the receiver.\n'+
  'Press Connect in HackRF TX, then Send in LoRa Modulator: the tx pin turns the transmitter on for the length of the frame. TX VGA and amp are off by default — start at the lowest power, close to the receiver.\n'+
  'The frame is built from open descriptions of the PHY and was not checked against real chips: if a receiver ignores it, try the other sync word or the *inverted IQ* switch.\n'+
  'You must comply with local radio regulations: transmit only on frequencies, with power and duty cycle the law allows you (a licence, a test cable or a shielded box).'});
nt.size.w=900; nt.size.h=150; applySize(nt);
const tx=addNode('loraTx',40,240,{sr:'2000000',fc:868100000,sf:'7',bw:'125000',msg:'TEST',lvl:-6});
tx.size.w=420; tx.size.h=300; applySize(tx);
const hk=addNode('hackrfTx',520,240,{});
hk.size.w=300; applySize(hk);
addEdge(tx.id,'iq',hk.id,'in'); addEdge(tx.id,'tx',hk.id,'tx');
markWiresDirty();
});
preset('ACARS: VHF Messages (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'ACARS without a radio: the generator sends AM bursts with MSK 2400 Bd (1200 / 2400 Hz) — pre-key, "+*", SYN SYN, SOH, aircraft registration,\n'+
  'label, block id, text, ETX, BCS (CRC-16) — position, OOOI, gate and link-test messages from a few aircraft, with a pause between bursts.\n'+
  'ACARS Decoder: AM envelope, MSK discriminator at 8 bit-clock phases, sync search (tone polarity and differential coding are found by the sync word),\n'+
  'parity, CRC → registration, label, flight, text.'});
nt.size.w=720; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,220,{sr:'256000',fc:131725000,mode:'ACARS',off:7000,lvl:-20,noise:-50});
const de=addNode('acarsRx',340,220,{});
de.size.w=560; de.size.h=300; applySize(de);
const log=addNode('recLog',340,580,{});
log.size.w=560; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('ACARS: VHF Messages (USB SDR, 131 MHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'ACARS from the air (AM, 25 kHz channels): Europe 131.525 / 131.725 / 131.825 MHz, North America 129.125 / 130.025 / 131.550 MHz.\n'+
  'Tune to a channel, tap a burst on the spectrum (a short carrier every few seconds, buzzing in AM). The decoder needs the signal in the passband (about ±10 kHz),\n'+
  'but IQ Frequency Shift before it helps to keep away from the DC spike. A vertical whip is enough, ACARS is vertically polarized.'});
nt.size.w=720; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:131725000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('acarsRx',340,360,{});
de.size.w=560; de.size.h=300; applySize(de);
const log=addNode('recLog',340,720,{});
log.size.w=560; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('DMR: Calls, SMS and CSBK (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'DMR without a radio: the generator sends a repeater downlink — 4FSK 4800 Bd, two TDMA slots with CACH, colour code 1.\n'+
  'Slot 1: a group voice call (LC header, four superframes with embedded LC and the talker alias, terminator). Slot 2: CSBK preambles and two data messages\n'+
  '(IP/UDP/Motorola TMS text at rate ½, short data at rate ¾, an LRRP position — it lands on the map — all with CRC-32). CSBK: preamble,\n'+
  'Tier III C_ALOHA and a channel grant. The CACH carries a Short LC (slot activity).\n'+
  'Digital Voice Decoder (DMR): FM discriminator, RRC, 8 clock phases, sync and polarity search, then Golay / QR / BPTC / Reed-Solomon / CRC for every field. The voice output has the raw AMBE+2 frames.'});
nt.size.w=760; nt.size.h=150; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:438000000,mode:'DMR',off:2000,lvl:-20,noise:-45});
const de=addNode('fskRx',340,240,{proto:'dmr'});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,640,{});
log.size.w=560; applySize(log);
const map=addNode('geoMap',940,240,{mz:9,mlat:55.03,mlon:82.92,ttl:60,labels:true});
map.size.w=520; map.size.h=400; applySize(map);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec'); addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('DMR: Repeater or Direct Mode (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'DMR (MotoTRBO, Hytera, Anytone…): tune the SDR to a repeater output or a simplex/direct frequency in the VHF/UHF bands\n'+
  'and tap the signal on the spectrum. The decoder shows the colour code, time slots, calls (from → to, group or private, emergency, encrypted), talker alias,\n'+
  'CSBK, text messages and LRRP / NMEA positions (on the map); the log saves CSV. Voice is not decoded to audio: AMBE+2 frames come out raw on the voice output.'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:438000000,demod:'IQ'});
const sa=addNode('sa',860,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('fskRx',340,360,{proto:'dmr'});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,760,{});
log.size.w=560; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
const map=addNode('geoMap',940,360,{mz:8,ttl:300,labels:true,trail:3000});
map.size.w=520; map.size.h=400; applySize(map);
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec'); addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('DMR: Activity Log and Station Map (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Who talks to whom, when and for how long: Digital Voice Decoder (DMR) → DMR Call Log. The log keeps calls and messages, counters per radio ID\n'+
  'and per talkgroup (calls, seconds, messages, last heard, talker alias) and buttons for CSV (calls, stations, groups). The stations output feeds the map —\n'+
  'a station shows up as soon as it sends a position (LRRP / NMEA). The generator has one radio (2600123) with a voice call, messages and a position.'});
nt.size.w=760; nt.size.h=120; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:438000000,mode:'DMR',off:2000,lvl:-20,noise:-45});
const de=addNode('fskRx',340,240,{proto:'dmr'});
de.size.w=480; de.size.h=300; applySize(de);
const lg=addNode('dmrLog',340,600,{});
lg.size.w=480; lg.size.h=300; applySize(lg);
const map=addNode('geoMap',860,240,{mz:9,mlat:55.03,mlon:82.92,ttl:600,labels:true});
map.size.w=520; map.size.h=400; applySize(map);
const log=addNode('recLog',860,680,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',lg.id,'rec');
addEdge(lg.id,'stations',map.id,'rec'); addEdge(lg.id,'calls',log.id,'rec');
markWiresDirty();
});
preset('DMR: Activity Log and Station Map (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Activity of a DMR repeater or a direct-mode channel: tune the SDR and tap the signal on the spectrum. DMR Call Log counts calls, seconds and\n'+
  'messages per radio ID and per talkgroup, keeps the last calls and saves CSV; stations that send a position (LRRP / NMEA) are placed on the map.'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:438000000,demod:'IQ'});
const sa=addNode('sa',860,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('fskRx',340,360,{proto:'dmr'});
de.size.w=480; de.size.h=300; applySize(de);
const lg=addNode('dmrLog',340,720,{});
lg.size.w=480; lg.size.h=300; applySize(lg);
const map=addNode('geoMap',860,360,{mz:8,ttl:1800,labels:true,trail:3000});
map.size.w=520; map.size.h=400; applySize(map);
const log=addNode('recLog',860,800,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',lg.id,'rec');
addEdge(lg.id,'stations',map.id,'rec'); addEdge(lg.id,'calls',log.id,'rec');
markWiresDirty();
});
preset('Inmarsat STD-C: EGC Messages (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Inmarsat-C without a dish: the generator sends a LES TDM carrier the way the satellites do — BPSK 1200 Bd,\n'+
  'RRC α=0.6, 8.64 s frames of 64×162 symbols (unique word, row permutation, interleaving, K=7 code, scrambler)\n'+
  'with a Bulletin Board and SafetyNET EGC warnings split over several frames. PSK Demodulator (BPSK): frequency\n'+
  'search, Costas and symbol loops. STD-C Decoder: frames → packets → assembled EGC messages (text and records).'});
nt.size.w=680; nt.size.h=170; applySize(nt);
const gn=addNode('iqGen',40,260,{sr:'48000',fc:1541450000,mode:'STD-C',off:900,lvl:-20,noise:-30});
const dm=addNode('pskDemod',340,260,{mode:'BPSK',rate:1200,bw:.02,pull:3000});
const de=addNode('stdcDecode',720,260,{});
de.size.w=520; de.size.h=320; applySize(de);
const log=addNode('recLog',720,620,{});
log.size.w=520; applySize(log);
addEdge(gn.id,'iq',dm.id,'in'); addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Maritime safety broadcasts from geostationary Inmarsat satellites: SafetyNET navigational and weather warnings.\n'+
  'L-band 1537–1545 MHz (e.g. 1541.45 MHz on IOR/EMEA — look for a ~2 kHz wide carrier), a patch or helix antenna\n'+
  'pointed at the satellite and an LNA help a lot. Tap the carrier on the spectrum; ×32 to 32 kS/s, BPSK 1200 Bd.\n'+
  'A frame takes 8.64 s; messages come in parts over several frames. Records go to the log (save CSV).'});
nt.size.w=680; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'1024000',freq:1541450000,demod:'IQ'});
const sa=addNode('sa',760,40,{auto:true,floor:-100,top:-40,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,260,{});
const d1=addNode('iqDecim',340,420,{M:'32',cut:.3});
const dm=addNode('pskDemod',340,580,{mode:'BPSK',rate:1200,bw:.02,pull:3000});
const de=addNode('stdcDecode',760,360,{});
de.size.w=520; de.size.h=320; applySize(de);
const log=addNode('recLog',760,720,{});
log.size.w=520; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',d1.id,'in'); addEdge(d1.id,'out',dm.id,'in'); addEdge(dm.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
markWiresDirty();
});
preset('GSM: Receive Bursts (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'GSM downlink receiver: sync to a C0 carrier, decode bursts and list the cells around you.\n'+
  'Raw IQ → tap a GSM channel on the spectrum → GSM: Receive Bursts. The node finds FCCH, decodes SCH\n'+
  '(BSIC + frame number) and the BCCH System Information — Cell ID, LAC, MCC/MNC (with an offline\n'+
  'operator-name lookup for common CIS/EU/US networks), own+neighbour ARFCN lists and RACH params.\n'+
  '«Rec: Unique by Key» (key = id = PLMN-LAC-CID) keeps one row per cell; save it to CSV. The Graph node\n'+
  'draws serving-cell → neighbour-ARFCN edges straight from the same rec stream (no extra wiring needed).\n'+
  '2.4 MS/s on RTL-SDR drops more samples than 2.048 MS/s or lower — if BCCH never decodes, try that first,\n'+
  'and prefer a fixed gain over AGC (AGC can overshoot into clipping right after retuning). Tune to a GSM900\n'+
  'BCCH (935–960 MHz) or DCS1800 (1805–1880 MHz).'});
nt.size.w=680; nt.size.h=220; applySize(nt);
const rx=addNode('rtlsdr',40,320,{sr:'2048000',freq:942000000,demod:'IQ',auto:false,gainDb:32});
const bp=addNode('table',40,480,{list:'presets/GSM downlink (ARFCN bands)',initial:false});
bp.size.w=300; bp.size.h=160; applySize(bp);
const sa=addNode('sa',720,40,{auto:true,floor:-90,top:-10,split:1});
sa.size.w=640; sa.size.h=300; applySize(sa);
const sh=addNode('iqShift',340,320,{});
const gsm=addNode('gsmRx',340,460,{afc:true});
gsm.size.w=760; gsm.size.h=300; applySize(gsm);
const uniq=addNode('recUniq',1160,80,{key:'id'});
uniq.size.w=360; uniq.size.h=240; applySize(uniq);
const log=addNode('recLog',1160,360,{});
log.size.w=360; applySize(log);
const nv=addNode('numview',1560,80,{label:'cells'});
const gv=addNode('graphview',1160,620,{directed:true});
gv.size.w=420; gv.size.h=320; applySize(gv);
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(bp.id,'bands',sa.id,'bands');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',gsm.id,'in');
addEdge(gsm.id,'rec',uniq.id,'rec'); addEdge(uniq.id,'new',log.id,'rec'); addEdge(uniq.id,'count',nv.id,'in');
addEdge(gsm.id,'nb',gv.id,'rec');
markWiresDirty();
});
preset('GSM: ARFCN Scanner (sweep the band, log every cell)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Not every GSM channel you tap on the spectrum carries a receivable BCCH — many peaks are\n'+
  'neighbours, weak distant cells or just noise. Instead of tuning by hand and hoping, this preset\n'+
  'sweeps the whole GSM900/DCS1800 downlink automatically: Band Scanner retunes the RTL-SDR across\n'+
  'the «GSM downlink (ARFCN bands)» list, dwelling on each ~2 MS/s window just long enough for\n'+
  'GSM: Receive Bursts to try an FCCH/SCH lock (its sync output tells the scanner whether to keep\n'+
  'listening there or move on). Every cell it manages to decode (SI3/SI4 → PLMN/LAC/CID) lands in\n'+
  '«Rec: Unique by Key» — one row per cell, deduplicated, with a hit count; save the full list to CSV\n'+
  'once the sweep loops back around. Raise «listen timeout» if cells near the edge of a window need\n'+
  'more time to lock; this is the same approach grgsm_scanner / kal use — try an actual FCCH/SCH\n'+
  'decode on each candidate rather than guessing from spectrum peaks alone.'});
nt.size.w=700; nt.size.h=240; applySize(nt);
const rx=addNode('rtlsdr',40,340,{sr:'2048000',freq:942000000,demod:'IQ',auto:false,gainDb:32});
const bp=addNode('table',40,500,{list:'presets/GSM downlink (ARFCN bands)',initial:false});
bp.size.w=300; bp.size.h=160; applySize(bp);
const bs=addNode('bandscan',380,500,{timeout:3000,settle:250});
bs.size.w=300; bs.size.h=200; applySize(bs);
const sa=addNode('sa',760,40,{auto:true,floor:-90,top:-10,split:1});
sa.size.w=640; sa.size.h=300; applySize(sa);
const sh=addNode('iqShift',40,780,{});
const gsm=addNode('gsmRx',380,780,{afc:true});
gsm.size.w=760; gsm.size.h=300; applySize(gsm);
const uniq=addNode('recUniq',1180,80,{key:'id'});
uniq.size.w=360; uniq.size.h=240; applySize(uniq);
const log=addNode('recLog',1180,360,{});
log.size.w=360; applySize(log);
const nv=addNode('numview',1580,80,{label:'cells'});
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(bp.id,'bands',sa.id,'bands'); addEdge(bp.id,'bands',bs.id,'bands');
addEdge(rx.id,'freqLo',bs.id,'freqLo'); addEdge(rx.id,'freqHi',bs.id,'freqHi');
addEdge(bs.id,'freq',rx.id,'freq');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sh.id,'out',gsm.id,'in');
addEdge(gsm.id,'sync',bs.id,'active');
addEdge(gsm.id,'rec',uniq.id,'rec'); addEdge(uniq.id,'new',log.id,'rec'); addEdge(uniq.id,'count',nv.id,'in');
markWiresDirty();
});
preset('IQ: Channelizer — Three Signals at Once (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Three generators (FM, AM, USB) summed into one 1.024 MS/s stream.\n'+
  'The channelizer cuts it into 32 channels of 32 kHz with one FFT and hands three of them\n'+
  '(by frequency) to three demodulators at once; the mixer spreads them left / centre / right.\n'+
  'The lower spectrum is the power of every channel. Try «outputs take: strongest».'});
nt.size.w=560; nt.size.h=170; applySize(nt);
const g1=addNode('iqGen',40,260,{sr:'1024000',fc:100000000,mode:'FM',off:96000,lvl:-20,dev:3000,tone:1000,noise:-70});
const g2=addNode('iqGen',40,560,{sr:'1024000',fc:100000000,mode:'AM',off:-160000,lvl:-26,tone:500,depth:.6,noise:-120});
const g3=addNode('iqGen',40,860,{sr:'1024000',fc:100000000,mode:'USB',off:320000,lvl:-30,tone:1500,noise:-120});
const a1=addNode('iqAdd',300,260,{}), a2=addNode('iqAdd',300,420,{});
const sp=addNode('iqSpec',300,600,{size:'8192'});
const sa=addNode('sa',640,40,{auto:true,floor:-110,top:0,split:.4});
sa.size.w=620; sa.size.h=300; applySize(sa);
const ch=addNode('iqChan',300,760,{N:'32',ov:'2',K:'3',sel:'manual',freqs:'100.096, 99.84, 100.32'});
const s2=addNode('sa',640,380,{auto:true,floor:-110,top:0,split:1});
s2.size.w=620; s2.size.h=200; applySize(s2);
const d1=addNode('iqDemod',640,640,{mode:'FM',dev:3000}), d2=addNode('iqDemod',640,840,{mode:'AM'}), d3=addNode('iqDemod',640,1040,{mode:'USB'});
const u1=addNode('iqAudio',900,640,{}), u2=addNode('iqAudio',900,840,{}), u3=addNode('iqAudio',900,1040,{});
const mx=addNode('mixer4',1160,640,{pa:-.8,pb:0,pc:.8,kc:1.5});
const dc=addNode('dac',1420,640,{vol:.3});
addEdge(g1.id,'iq',a1.id,'a'); addEdge(g2.id,'iq',a1.id,'b');
addEdge(a1.id,'out',a2.id,'a'); addEdge(g3.id,'iq',a2.id,'b');
addEdge(a2.id,'out',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(a2.id,'out',ch.id,'in'); addEdge(ch.id,'spec',s2.id,'spec');
addEdge(ch.id,'ch1',d1.id,'in'); addEdge(ch.id,'ch2',d2.id,'in'); addEdge(ch.id,'ch3',d3.id,'in');
addEdge(d1.id,'out',u1.id,'in'); addEdge(d2.id,'out',u2.id,'in'); addEdge(d3.id,'out',u3.id,'in');
addEdge(u1.id,'out',mx.id,'a'); addEdge(u2.id,'out',mx.id,'b'); addEdge(u3.id,'out',mx.id,'c');
addEdge(mx.id,'L',dc.id,'L'); addEdge(mx.id,'R',dc.id,'R');
markWiresDirty();
});
preset('USB SDR: Listen to the Strongest Channels', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the SDR and tune to a busy NFM band (PMR446, 2 m, LPD, marine VHF).\n'+
  'The channelizer splits 1.024 MS/s into 64 channels of 16 kHz and keeps the four strongest\n'+
  'active ones on its outputs (held for 2 s after they go quiet); each gets its own NFM demodulator,\n'+
  'the mixer spreads them across the stereo field. Readout of the channelizer shows who is where.'});
nt.size.w=600; nt.size.h=170; applySize(nt);
const rx=addNode('rtlsdr',40,260,{sr:'1024000',freq:446100000,demod:'NFM'});
const sa=addNode('sa',680,40,{auto:true,floor:-90,top:-20,split:.4});
sa.size.w=620; sa.size.h=320; applySize(sa);
const ch=addNode('iqChan',360,260,{N:'64',ov:'2',K:'4',sel:'strongest',thr:10,hold:2,skipDc:true});
const s2=addNode('sa',680,400,{auto:true,floor:-100,top:-20,split:1});
s2.size.w=620; s2.size.h=200; applySize(s2);
const mx=addNode('mixer4',1340,640,{pa:-.8,pb:-.3,pc:.3,pd:.8});
const dc=addNode('dac',1600,640,{vol:.4});
['a','b','c','d'].forEach((k,i)=>{
  const d=addNode('iqDemod',680,640+i*180,{mode:'FM',dev:2500});
  const u=addNode('iqAudio',1000,640+i*180,{});
  addEdge(ch.id,'ch'+(i+1),d.id,'in'); addEdge(d.id,'out',u.id,'in'); addEdge(u.id,'out',mx.id,k);
});
addEdge(rx.id,'spec',sa.id,'spec'); addEdge(sa.id,'centerFreq',rx.id,'steerFreq');
addEdge(rx.id,'iq',ch.id,'in'); addEdge(ch.id,'spec',s2.id,'spec');
addEdge(mx.id,'L',dc.id,'L'); addEdge(mx.id,'R',dc.id,'R');
markWiresDirty();
});
preset('tinySA: Spectrum', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Connect the tinySA / tinySA Ultra over USB (WebSerial, Chrome/Edge).\n'+
  'Spectrum and waterfall show the sweep in dBm; drag the spectrum to move the range.\n'+
  'Screenshot grabs the device screen; generator mode turns the tinySA into a signal source.'});
nt.size.w=460; nt.size.h=150; applySize(nt);
const ts=addNode('tinysa',40,300,{start:88,stop:108,points:'450'});
const sa=addNode('sa',540,40,{auto:true,floor:-110,top:-20,split:.35});
sa.size.w=720; sa.size.h=460; applySize(sa);
addEdge(ts.id,'spec',sa.id,'spec');
addEdge(sa.id,'centerFreq',ts.id,'steerFreq');
markWiresDirty();
});
preset('ESP-SDR: ESP32 Spectrum', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Flash ESP-SDR firmware to an ESP32 (see ESPARGOS/esp-sdr), connect it over USB/UART (WebSerial, Chrome/Edge).\n'+
  'The chip computes the FFT itself (on-chip FFT) and streams the spectrum; the level is dB re full scale.\n'+
  'Drag the spectrum to retune. The I/Q burst mode is a fallback for firmware without SPEC.'});
nt.size.w=460; nt.size.h=150; applySize(nt);
const es=addNode('espsdr',40,300,{freq:2437,rate:'40',fft:'1024'});
const sa=addNode('sa',540,40,{auto:true,split:.35});
sa.size.w=720; sa.size.h=460; applySize(sa);
addEdge(es.id,'spec',sa.id,'spec');
addEdge(sa.id,'centerFreq',es.id,'steerFreq');
markWiresDirty();
});
/* ---- готовые патчи ---- */
preset('Morse from Microphone', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,300,{size:'2048',win:'blackman'});   // окно 43 мс: короче точки
const wf=addNode('sa',40,460,{fmin:200,fmax:2000,floor:-100,top:-30,tol:60,split:.35});
wf.size.w=620; wf.size.h=320; applySize(wf);
const mo=addNode('morseRx',700,40,{auto:true,thr:.6,minRun:25});
mo.size.w=380; mo.size.h=240; applySize(mo);
const mo2=addNode('morseRx',700,320,{auto:true,thr:.6,minRun:25});
mo2.size.w=380; mo2.size.h=200; applySize(mo2);
const bp=addNode('biquad',360,40,{type:'bp',freq:700,Q:20});
const dc=addNode('dac',360,260,{vol:.3,mode:'mono'});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(wf.id,'snr1',mo.id,'level');                // маркер 1 — первый корреспондент
addEdge(wf.id,'snr2',mo2.id,'level');               // маркер 2 — второй, параллельно
addEdge(m.id,'a',bp.id,'in');
addEdge(wf.id,'f1',bp.id,'freq');                 // в наушники — тон под маркером 1
addEdge(bp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Morse from Camera', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Receive: point the camera at a blinking source\\n'+
  '(e.g. another device\'s screen running this same preset) —\\n'+
  'the frame on the camera preview is the zone brightness is measured from.\\n\\n'+
  'Transmit: type text into «Morse: Transmit», press «Send»,\\n'+
  'then «Fullscreen» on the transmitting screen — it will blink Morse.'});
nt.size.w=420; nt.size.h=220; applySize(nt);
const c =addNode('cam',40,300,{roi:true,roiX:.4,roiY:.4,roiW:.2,roiH:.2,roiAuto:true,
  ae:false,exp:.7,af:false,awb:false});
const g =addNode('thresh',420,300,{thr:.55,hys:.08,hold:0});
const mo=addNode('morseRx',680,300,{auto:true,thr:.5,minRun:30});
mo.size.w=320; mo.size.h=180; applySize(mo);
const tx=addNode('morseTx',420,40,{text:'CQ CQ DE TEST',wpm:12});
const fl=addNode('flash',680,40);
addEdge(c.id,'bright',g.id,'num');
addEdge(g.id,'num',mo.id,'level');
addEdge(tx.id,'key',fl.id,'in');
markWiresDirty();
});
preset('RTTY: Transmit and Receive', function(){
clearAll();
const tx=addNode('serialTx',40,40,{text:'RYRY DE TEST',baud:45.45,loop:true});
const md=addNode('mod',300,40,{mode:'FSK',f0:1275,shift:170,amp:.3});
const nz=addNode('osc',300,300,{wave:'noise',amp:.02});
const mx=addNode('sum',560,40,{ka:1,kb:1});
const ff=addNode('fft',560,200,{size:'4096'});
const wf=addNode('sa',560,340,{fmin:900,fmax:1800,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const dm=addNode('fsk',1060,40,{f0:1275,shift:170,bw:60,center:true});
const rx=addNode('serialRx',1060,300,{baud:45.45,code:'Baudot (RTTY)'});
rx.size.w=320; rx.size.h=200; applySize(rx);
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',dm.id,'in');
addEdge(wf.id,'f1',dm.id,'f0');                 // маркер 1 = частота настройки
addEdge(dm.id,'fLo',wf.id,'m3'); addEdge(dm.id,'fHi',wf.id,'m4');
addEdge(dm.id,'soft',rx.id,'soft');
markWiresDirty();
});
preset('RTTY: Receive Off-Air', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'8192'});
const wf=addNode('sa',560,40,{fmin:800,fmax:2600,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const dm=addNode('fsk',1140,40,{f0:1275,shift:170,bw:60,center:true});
const rx=addNode('serialRx',1140,320,{baud:45.45,code:'Baudot (RTTY)'});
rx.size.w=360; rx.size.h=260; applySize(rx);
const sc=addNode('scope',1140,540,{span:8192,gain:1});
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',dm.id,'in');
addEdge(wf.id,'f1',dm.id,'f0');
addEdge(dm.id,'fLo',wf.id,'m3'); addEdge(dm.id,'fHi',wf.id,'m4');
addEdge(dm.id,'bLo',wf.id,'bLo'); addEdge(dm.id,'bHi',wf.id,'bHi');
addEdge(dm.id,'soft',rx.id,'soft'); addEdge(dm.id,'soft',sc.id,'in1');
markWiresDirty();
});
preset('SSTV / Fax: Raster', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'4096'});
const wf=addNode('sa',40,400,{fmin:1000,fmax:2500,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
// demod вместо fft+peak (см. пресет WEFAX): peak.freq — число раз в блок, а sigmap/sigwin
// ждут sig (посэмплово) — раньше эти рёбра просто не создавались из-за несовпадения типов.
const dmL=addNode('demod',340,40,{mode:'FM',freq:1900,bw:800,gain:1});      // 1500..2300 Гц → -1..1, яркость
const mp=addNode('sigmap',600,40,{inMin:-1,inMax:1,outMin:0,outMax:1});
const dmS=addNode('demod',340,260,{mode:'FM',freq:1200,bw:200,gain:1});     // 1100..1300 Гц → -1..1, синхро-тон
const sy=addNode('sigwin',600,260,{lo:-1,hi:1,minMs:3});
const pa=addNode('paint',880,40,{std:'Martin M1',lineMs:446.446,width:'960',height:'256',
rgb:true,sync:'edge'});
pa.size.w=420; pa.size.h=320; applySize(pa);
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');                 // водопад — только для визуальной настройки
addEdge(m.id,'a',dmL.id,'in'); addEdge(dmL.id,'out',mp.id,'in');
addEdge(m.id,'a',dmS.id,'in'); addEdge(dmS.id,'out',sy.id,'in');
addEdge(mp.id,'out',pa.id,'level');
addEdge(sy.id,'out',pa.id,'sync');
markWiresDirty();
});
preset('Decode Protocol as Raster', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'4096'});
const wf=addNode('sa',560,40,{fmin:0,fmax:4000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
// demod вместо peak: тянет частоту посэмпльно, а не раз в блок; маркер f1 задаёт центр напрямую
// через вход 'freq' (peak.fc так и не был совместим по типу с sigmap.in — sig, а не num).
const dm=addNode('demod',300,340,{mode:'FM',freq:1900,bw:300,gain:1});      // bw=300 ~ прежний tol=150 в обе стороны
const mp=addNode('sigmap',560,340,{inMin:-1,inMax:1,outMin:0,outMax:1});
const pa=addNode('paint',840,340,{lineMs:500,width:'512',height:'256',sync:'free'});
pa.size.w=440; pa.size.h=300; applySize(pa);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(wf.id,'f1',dm.id,'freq');
addEdge(m.id,'a',dm.id,'in');
addEdge(dm.id,'out',mp.id,'in'); addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('Morse: Encoder + Decoder', function(){
clearAll();
const tx=addNode('morseTx',40,40,{text:'CQ DE R1ABC',wpm:15,loop:true});
const md=addNode('mod',300,40,{mode:'OOK',f0:800,amp:.3,rise:4});
const nz=addNode('osc',300,300,{wave:'noise',amp:.03});
const mx=addNode('sum',560,140);
const ff=addNode('fft',820,140,{size:'2048'});
const pk=addNode('peak',1080,140,{fmin:500,fmax:1200,thr:-55,hold:40,track:true});
const mo=addNode('morseRx',1340,140,{auto:true,thr:.45});
mo.size.w=320; mo.size.h=180; applySize(mo);
const fl=addNode('flash',40,320);
const dac=addNode('dac',560,340,{vol:.2});
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',pk.id,'spec');
addEdge(pk.id,'level',mo.id,'level');
addEdge(tx.id,'key',fl.id,'in');
addEdge(mx.id,'out',dac.id,'L');
markWiresDirty();
});
preset('HFDL: Receive Chain (to Symbols)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'8192'});
const wf=addNode('sa',40,400,{fmin:300,fmax:3300,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',320,40,{type:'bp',freq:1800,Q:1.2});
const co=addNode('costas',580,40,{f0:1800,order:'8PSK',loopHz:5,lp:2500});
const fi=addNode('rrc',840,40,{baud:1800,beta:.35,span:8});
const fq=addNode('rrc',840,260,{baud:1800,beta:.35,span:8});
const ga=addNode('gardner',1100,40,{baud:1800,gain:.02});
const sl=addNode('pskdec',1360,40,{order:'8',diff:true,fmt:'hex'});
sl.size.w=320; sl.size.h=220; applySize(sl);
const cn=addNode('const2',1360,320,{dec:1,scale:3});
cn.size.w=320; cn.size.h=240; applySize(cn);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in'); addEdge(wf.id,'f1',bp.id,'freq');
addEdge(bp.id,'out',co.id,'in'); addEdge(wf.id,'f1',co.id,'f0');
addEdge(co.id,'I',fi.id,'in'); addEdge(co.id,'Q',fq.id,'in');
addEdge(fi.id,'out',ga.id,'I'); addEdge(fq.id,'out',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(ga.id,'sI',cn.id,'I'); addEdge(ga.id,'sQ',cn.id,'Q');
markWiresDirty();
});
preset('FT8: Find Signals in Slot', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'16384'});
const wf=addNode('sa',40,400,{fmin:200,fmax:2800,floor:-110,top:-30,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const f8=addNode('ft8Rx',600,40,{fmin:200,fmax:2800,top:10,thr:1.6});
f8.size.w=460; f8.size.h=320; applySize(f8);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',f8.id,'in');
addEdge(f8.id,'f',wf.id,'m3');
markWiresDirty();
});
preset('Weather Fax WEFAX 120', function(){
  clearAll();
  const m =addNode('mic',40,40,{gainA:2});
  const ff=addNode('fft',40,240,{size:'8192'});
  const wf=addNode('sa',40,400,{fmin:1000,fmax:2600,split:.4});
  wf.size.w=560; wf.size.h=300; applySize(wf);
  // demod вместо fft+peak: посэмпловый ЧМ-дискриминатор вместо поблочного FFT-пика.
  // peak пересчитывал частоту раз в аудио-блок (~10.6мс при block=512) — это в разы
  // медленнее пикселя WEFAX (~0.28мс при 1810 столбцах / 500мс), картинка размазывалась
  // в блоки по ~38 столбцов независимо от подбора fmin/fmax/tol.
  const dm=addNode('demod',340,40,{mode:'FM',freq:1900,bw:800,gain:1});
  const mp=addNode('sigmap',600,40,{inMin:-1,inMax:1,outMin:0,outMax:1});
  const pa=addNode('paint',880,40,{std:'WEFAX 120 lpm IOC576',lineMs:500,width:'1810',
  height:'600',sync:'free',palette:'gray'});
  pa.size.w=620; pa.size.h=420; applySize(pa);
  addEdge(m.id,'a',ff.id,'in');
  addEdge(ff.id,'spec',wf.id,'spec');   // водопад — только для визуальной настройки, на демод не влияет
  addEdge(m.id,'a',dm.id,'in');
  addEdge(dm.id,'out',mp.id,'in');
  addEdge(mp.id,'out',pa.id,'level');
  markWiresDirty();
});
preset('WEFAX Transmit (Demo)', function(){
  clearAll();
  const v =addNode('vidsrc',40,40,{});                 // картинку задать через URL/файл в самом узле
  const tx=addNode('paintTx',340,40,{std:'WEFAX 120 lpm IOC576'});
  const o =addNode('osc',600,40,{wave:'sine',freq:1900,fmHz:400,amp:.3});
  addEdge(v.id,'img',tx.id,'img');
  addEdge(tx.id,'level',o.id,'fm');
  // addEdge(o.id,'out', <твой узел вывода на динамики>.id, 'in');  ← подставь свой id узла категории «Вывод»,
  // этого файла у меня нет, я не знаю его имя в твоём проекте.
  markWiresDirty();
});
preset('NOAA APT (AM Envelope)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const bp=addNode('biquad',300,40,{type:'bp',freq:2400,Q:1.5});
const en=addNode('env',560,40,{atk:.2,rel:.4});
const mp=addNode('sigmap',820,40,{inMin:0,inMax:.5,outMin:0,outMax:1});
const pa=addNode('paint',1080,40,{std:'NOAA APT',lineMs:500,width:'2080',
height:'600',sync:'free'});
pa.size.w=640; pa.size.h=420; applySize(pa);
addEdge(m.id,'a',bp.id,'in'); addEdge(bp.id,'out',en.id,'in');
addEdge(en.id,'out',mp.id,'in'); addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('DTMF', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const dt=addNode('dtmfRx',300,40,{thr:6,minMs:40});
dt.size.w=320; dt.size.h=160; applySize(dt);
const ff=addNode('fft',300,300,{size:'2048'});
const sp=addNode('sa',560,300,{fmin:600,fmax:1800,floor:-90,split:.4});
sp.size.w=520; sp.size.h=300; applySize(sp);
addEdge(m.id,'a',dt.id,'in'); addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',sp.id,'spec');
markWiresDirty();
});
preset('PSK31 (7035–7040 kHz)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'16384'});
const wf=addNode('sa',40,400,{fmin:200,fmax:2600,floor:-110,top:-40,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',340,40,{type:'bp',freq:1000,Q:8});
const co=addNode('costas',600,40,{f0:1000,order:'BPSK',loopHz:4,lp:80});
const ga=addNode('gardner',880,40,{baud:31.25,gain:0,free:true});
const sl=addNode('pskdec',1140,40,{order:'2',diff:true,fmt:'PSK31 varicode'});
const cn=addNode('const2',880,300,{dec:1,scale:2});
cn.size.w=320; cn.size.h=220; applySize(cn);
sl.size.w=360; sl.size.h=280; applySize(sl);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in');
addEdge(wf.id,'f1',bp.id,'freq'); addEdge(wf.id,'f1',co.id,'f0');
addEdge(bp.id,'out',co.id,'in');
addEdge(co.id,'I',ga.id,'I'); addEdge(co.id,'Q',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(ga.id,'sI',cn.id,'I'); addEdge(ga.id,'sQ',cn.id,'Q');
markWiresDirty();
});
preset('Feld Hell', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,300,{size:'8192'});
const wf=addNode('sa',40,460,{fmin:300,fmax:2000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',340,40,{type:'bp',freq:1000,Q:12});
const en=addNode('env',600,40,{atk:1,rel:2});
const mp=addNode('sigmap',860,40,{inMin:0,inMax:.3,outMin:0,outMax:1});
const pa=addNode('paint',1120,40,{std:'Feld Hell',lineMs:114.2857,width:'640',height:'14',
dir:'columns',sync:'free'});
pa.size.w=620; pa.size.h=200; applySize(pa);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in'); addEdge(wf.id,'f1',bp.id,'freq');
addEdge(bp.id,'out',en.id,'in'); addEdge(en.id,'out',mp.id,'in');
addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('SSB: Shift to Zero', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const wf=addNode('sa',40,420,{fmin:0,fmax:12000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const sb=addNode('demod',340,40,{mode:'SSB',freq:10000,bw:2400,side:'USB',gain:3});
const fm=addNode('freqmeter',620,40,{fmin:100,fmax:4000,win:'0.5',digits:2});
const sc=addNode('scope',620,240,{span:4096,gain:2});
const dc=addNode('dac',900,40,{vol:.3,mode:'mono',pan:0});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',sb.id,'in');
addEdge(wf.id,'f1',sb.id,'freq');                // маркер 1 = частота настройки на несущую
addEdge(sb.id,'out',fm.id,'in'); addEdge(sb.id,'out',sc.id,'in1');
addEdge(sb.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Band Occupancy', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'16384'});
const wf=addNode('sa',560,40,{fmin:0,fmax:4000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const st=addNode('specstat',560,340,{mode:'occupancy',thr:-85,tau:120});
st.size.w=560; st.size.h=200; applySize(st);
const pk=addNode('specstat',560,580,{mode:'max',floor:-120});
pk.size.w=560; pk.size.h=160; applySize(pk);
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(ff.id,'spec',st.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
markWiresDirty();
});
preset('Text → Signal → Text', function(){
clearAll();
const ts=addNode('textsrc',40,40,{text:'CQ CQ DE R1ABC K',repeat:0});
ts.size.w=320; ts.size.h=120; applySize(ts);
const tc=addNode('textcode',40,340,{mode:'encode',coding:'Morse'});
tc.size.w=320; tc.size.h=140; applySize(tc);
const tx=addNode('morseTx',420,40,{wpm:18});
const md=addNode('mod',680,40,{mode:'OOK',f0:800,amp:.3,rise:4});
const nz=addNode('osc',680,260,{wave:'noise',amp:.02});
const mx=addNode('sum',920,40);
const dc=addNode('dac',920,260,{vol:.25,mode:'mono',pan:0});
const ff=addNode('fft',1160,40,{size:'2048'});
const pk=addNode('peak',1160,240,{fmin:500,fmax:1200,thr:-55,hold:40,track:true});
const mo=addNode('morseRx',1420,40,{auto:true,thr:.45});
mo.size.w=320; mo.size.h=200; applySize(mo);
const fl=addNode('flash',420,340);
addEdge(ts.id,'text',tx.id,'text'); addEdge(ts.id,'go',tx.id,'go');
addEdge(ts.id,'text',tc.id,'text');
addEdge(tx.id,'bit',md.id,'bit'); addEdge(tx.id,'key',fl.id,'in');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',dc.id,'L'); addEdge(mx.id,'out',ff.id,'in');
addEdge(ff.id,'spec',pk.id,'spec'); addEdge(pk.id,'level',mo.id,'level');
markWiresDirty();
});
preset('Wavelet vs FFT', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const wv=addNode('wavelet',40,300,{fmin:80,fmax:8000,bands:'288',Q:16,order:'1'});
const ff=addNode('fft',40,560,{size:'4096'});
const sa1=addNode('sa',420,40,{fmin:80,fmax:8000,log:true,split:.35});
sa1.size.w=620; sa1.size.h=340; applySize(sa1);
const sa2=addNode('sa',420,420,{fmin:80,fmax:8000,log:true,split:.35});
sa2.size.w=620; sa2.size.h=340; applySize(sa2);
addEdge(m.id,'a',wv.id,'in'); addEdge(m.id,'a',ff.id,'in');
addEdge(wv.id,'spec',sa1.id,'spec');              // сверху — постоянная добротность
addEdge(ff.id,'spec',sa2.id,'spec');              // снизу — тот же сигнал через БПФ
markWiresDirty();
});
preset('Vibration (Accelerometer)', function(){
clearAll();
const ac=addNode('accel',40,40);
const nx=addNode('numsig',320,40,{gain:1,dc:true,dcHz:.3});
const ny=addNode('numsig',320,240,{gain:1,dc:true,dcHz:.3});
const nz=addNode('numsig',320,440,{gain:1,dc:true,dcHz:.3});
const s1=addNode('sum',600,40,{ka:1,kb:1});
const s2=addNode('sum',600,240,{ka:1,kb:1});
const wv=addNode('wavelet',880,40,{fmin:.5,fmax:40,bands:'144',Q:8,floor:-80,top:0});
const sa=addNode('sa',880,260,{fmin:.5,fmax:40,log:true,floor:-60,top:10,split:.4,tol:1});
sa.size.w=640; sa.size.h=360; applySize(sa);
const sc=addNode('scope',600,460,{span:16384,gain:1,stack:true});
sc.size.w=520; sc.size.h=220; applySize(sc);
const ac2=addNode('autocorr',1560,40,{win:'4',fmin:.5,fmax:40});
ac2.size.w=380; ac2.size.h=200; applySize(ac2);
addEdge(ac.id,'x',nx.id,'in'); addEdge(ac.id,'y',ny.id,'in'); addEdge(ac.id,'z',nz.id,'in');
addEdge(nx.id,'out',s1.id,'a'); addEdge(ny.id,'out',s1.id,'b');
addEdge(s1.id,'out',s2.id,'a'); addEdge(nz.id,'out',s2.id,'b');
addEdge(s2.id,'out',wv.id,'in');                  // сумма осей — общая вибрация
addEdge(wv.id,'spec',sa.id,'spec');
addEdge(nx.id,'out',sc.id,'in1'); addEdge(ny.id,'out',sc.id,'in2');
addEdge(nz.id,'out',sc.id,'in3'); addEdge(s2.id,'out',sc.id,'in4');
addEdge(s2.id,'out',ac2.id,'in');
markWiresDirty();
});
preset('Low-Frequency Sensor Spectrum', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Sensor samples are placed by their timestamps and resampled evenly\\n'+
  '(sx/sy/sz/smag outputs), then decimated and averaged (Welch) in «Low-Frequency FFT».\\n'+
  'Check the real sensor rate in the sensor readout: Nyquist is half of it.\\n'+
  'Browsers give ~60 Hz (Chrome) to ~100 Hz; for hundreds of Hz on Android run the SensorServer app\\n'+
  'and use «Sensor (WebSocket)» instead of «Accelerometer».\\n'+
  'Peaks here are mechanical vibration or aliases of 50/100 Hz hum (e.g. 50 Hz at 60 Hz rate → 10 Hz).'});
nt.size.w=560; nt.size.h=160; applySize(nt);
const ac=addNode('accel',40,220);                 // devicemotion: в Firefox — сотни Гц, в Chrome — 60
const lf=addNode('lfft',320,220,{fs:'128',size:'2048',upd:'0.1',avg:'10'});
const sa=addNode('sa',600,220,{fmin:1,fmax:50,floor:-110,top:-30,split:.45,tol:1});
sa.size.w=640; sa.size.h=360; applySize(sa);
addEdge(ac.id,'smag',lf.id,'in');
addEdge(lf.id,'spec',sa.id,'spec');
markWiresDirty();
});
preset('Event Capture', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const cp=addNode('capture',360,40,{sec:5,mode:'level',thr:.03,loop:true});
cp.size.w=520; cp.size.h=140; applySize(cp);
const ff=addNode('fft',360,320,{size:'8192'});
const sa=addNode('sa',700,320,{fmin:0,fmax:6000,split:.4});
sa.size.w=620; sa.size.h=340; applySize(sa);
const sc=addNode('scope',700,40,{span:8192,gain:1});
sc.size.w=460; sc.size.h=200; applySize(sc);
const dc=addNode('dac',360,180,{vol:.3});
addEdge(m.id,'a',cp.id,'in');
addEdge(cp.id,'out',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(cp.id,'out',sc.id,'in1'); addEdge(cp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Two Microphones', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Two different physical inputs (different microphones\n'+
'or two sound-card channels) — in each «Microphone» node,\npick a different source for its input field.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const m1=addNode('mic',40,220,{gainA:2});
const m2=addNode('mic',40,420,{gainA:2});
const sc=addNode('scope',440,40,{span:4096,gain:2,stack:true});
sc.size.w=520; sc.size.h=240; applySize(sc);
const f1=addNode('fft',440,320,{size:'4096'});
const f2=addNode('fft',440,480,{size:'4096'});
const s1=addNode('sa',800,320,{fmin:0,fmax:8000,split:.4});
s1.size.w=560; s1.size.h=300; applySize(s1);
const s2=addNode('sa',800,660,{fmin:0,fmax:8000,split:.4});
s2.size.w=560; s2.size.h=300; applySize(s2);
const df=addNode('sum',440,620,{ka:1,kb:-1});       // разность каналов — проверка фазировки пары
const sd=addNode('meter',440,760);
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
addEdge(m1.id,'a',f1.id,'in'); addEdge(m2.id,'a',f2.id,'in');
addEdge(f1.id,'spec',s1.id,'spec'); addEdge(f2.id,'spec',s2.id,'spec');
addEdge(m1.id,'a',df.id,'a'); addEdge(m2.id,'a',df.id,'b');
addEdge(df.id,'out',sd.id,'in'); addEdge(df.id,'out',sc.id,'in3');
markWiresDirty();
});
preset('Beamforming Direction Finding (2 mics)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Beamformer with angle scanning.\n\n'+
'Two microphones at a known baseline (see «baseline, cm» on beam).\n'+
'LFO sweeps the angle ±90°, meter/scope show the beam loudness —\n'+
'the peak matches the direction to the sound source.'});
nt.size.w=420; nt.size.h=180; applySize(nt);
const m1=addNode('mic',40,280,{gainA:2});
const m2=addNode('mic',40,480,{gainA:2});
const lf=addNode('lfo',40,680,{freq:.15,min:-90,max:90,wave:'tri'});
const bm=addNode('beam',420,280,{dist:15,useManual:false});
const mt=addNode('meter',420,480);
const nv=addNode('numview',420,560,{digits:0});
const sc=addNode('scope',780,40,{span:4096,gain:3,stack:true});
sc.size.w=520; sc.size.h=200; applySize(sc);
const dc=addNode('dac',780,320,{vol:.25});
addEdge(m1.id,'a',bm.id,'A'); addEdge(m2.id,'a',bm.id,'B');
addEdge(lf.id,'out',bm.id,'ang'); addEdge(lf.id,'out',nv.id,'in');
addEdge(bm.id,'sum',mt.id,'in'); addEdge(bm.id,'sum',sc.id,'in1');
addEdge(bm.id,'sum',dc.id,'L');
markWiresDirty();
});
preset('TDOA: Path Difference (2 mics)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Path-length difference of sound between two microphones\n'+
'via cross-correlation. Clap off to one side —\n'+
'lagMs shows which microphone the sound reached first.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const m1=addNode('mic',40,220,{gainA:2});
const m2=addNode('mic',40,420,{gainA:2});
const xc=addNode('xcorr',420,40,{maxMs:5,win:'0.05',smooth:.5});
xc.size.w=460; xc.size.h=200; applySize(xc);
const nv=addNode('numview',420,300,{digits:3});
const sc=addNode('scope',900,40,{span:4096,gain:3,stack:true,trig:true});
sc.size.w=480; sc.size.h=220; applySize(sc);
addEdge(m1.id,'a',xc.id,'A'); addEdge(m2.id,'a',xc.id,'B');
addEdge(xc.id,'lagMs',nv.id,'in');
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
markWiresDirty();
});
preset('Chirp Radar 2D (2 mics)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'2D chirp radar by echo time-of-arrival.\n\n'+
'Speaker at the center of the baseline, mic A on the left, B on the right\n'+
'(geometry — see the node\'s description). x,y on the node are the target coordinates.'});
nt.size.w=420; nt.size.h=180; applySize(nt);
const m1=addNode('mic',40,280,{gainA:3});
const m2=addNode('mic',40,480,{gainA:3});
const cr=addNode('chirpRadar',420,40,{fLo:17000,fHi:20500,dur:3,period:80,baseline:12,maxRange:1.5});
cr.size.w=460; cr.size.h=280; applySize(cr);
const dc=addNode('dac',420,360,{vol:.5});
const sc=addNode('scope',900,40,{span:8192,gain:3,stack:true});
sc.size.w=520; sc.size.h=200; applySize(sc);
addEdge(m1.id,'a',cr.id,'A'); addEdge(m2.id,'a',cr.id,'B');
addEdge(cr.id,'out',dc.id,'L'); addEdge(cr.id,'out',dc.id,'R');
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
markWiresDirty();
});
preset('Band Overview', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const sa=addNode('sa',360,40,{fmin:0,fmax:6000,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const pe=addNode('persist',360,420,{fmin:0,fmax:6000,decay:.995,gain:4});
pe.size.w=600; pe.size.h=300; applySize(pe);
const cf=addNode('cfar',1000,40,{fmin:100,fmax:6000,thr:10,minW:2,top:12,hold:1000});
cf.size.w=420; cf.size.h=280; applySize(cf);
const pk=addNode('peak',1000,380,{fmin:100,fmax:6000,thr:-70});
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pe.id,'spec');
addEdge(ff.id,'spec',cf.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
addEdge(cf.id,'f1',sa.id,'m3'); addEdge(cf.id,'f2',sa.id,'m4');
markWiresDirty();
});
preset('Preamble Search', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'4096'});
const sa=addNode('sa',360,40,{fmin:200,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const dm=addNode('fsk',360,380,{f0:1275,shift:170,bw:120,center:true});
const co=addNode('corr',740,380,{pat:'PN sequence 63',baud:1200,thr:.8,abs:true,dead:50});
co.size.w=460; co.size.h=180; applySize(co);
const cp=addNode('capture',1240,40,{sec:2,mode:'on trigger',loop:true});
cp.size.w=480; cp.size.h=160; applySize(cp);
const sc=addNode('scope',1240,300,{span:8192,gain:1});
sc.size.w=460; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',dm.id,'in'); addEdge(sa.id,'f1',dm.id,'f0');
addEdge(dm.id,'fLo',sa.id,'m3'); addEdge(dm.id,'fHi',sa.id,'m4');
addEdge(dm.id,'soft',co.id,'in');
addEdge(dm.id,'soft',cp.id,'in');
addEdge(co.id,'peak',cp.id,'trig');                // найден образец — сохраняем кадр
addEdge(dm.id,'soft',sc.id,'in1'); addEdge(co.id,'corr',sc.id,'in2');
markWiresDirty();
});
preset('Frequency Response and Chain Delay', function(){
clearAll();
const sw=addNode('sweep',40,40,{f0:20,f1:20000,rate:.5,mode:'log',amp:.3});
const nz=addNode('osc',40,300,{wave:'noise',amp:.3});
const dc=addNode('dac',360,40,{vol:.3,mode:'mono'});
const m =addNode('mic',360,240,{gainA:2});
const tf=addNode('tf',700,40,{size:'4096',avg:.97});
const sa=addNode('sa',1000,40,{fmin:20,fmax:20000,log:true,floor:-60,top:20,split:.5});
sa.size.w=620; sa.size.h=340; applySize(sa);
const sc=addNode('sa',1000,420,{fmin:20,fmax:20000,log:true,floor:-40,top:0,split:.5});
sc.size.w=620; sc.size.h=300; applySize(sc);
const xc=addNode('xcorr',700,300,{maxMs:50,win:'0.25'});
xc.size.w=460; xc.size.h=200; applySize(xc);
addEdge(sw.id,'out',dc.id,'L');
addEdge(sw.id,'out',tf.id,'ref'); addEdge(m.id,'a',tf.id,'meas');
addEdge(tf.id,'H',sa.id,'spec');                   // АЧХ тракта
addEdge(tf.id,'coh',sc.id,'spec');                 // когерентность
addEdge(sw.id,'out',xc.id,'A'); addEdge(m.id,'a',xc.id,'B');
markWiresDirty();
});
preset('Harmonics and Cepstrum', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const cp=addNode('cepstrum',40,440,{size:'16384',fmin:40,fmax:2000});
const sa=addNode('sa',360,40,{fmin:0,fmax:6000,floor:-110,top:-10,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const hm=addNode('harm',1000,40,{auto:false,nh:10,tol:20});
hm.size.w=420; hm.size.h=280; applySize(hm);
const st=addNode('stats',1000,380,{tau:1});
st.size.w=420; st.size.h=200; applySize(st);
addEdge(m.id,'a',ff.id,'in'); addEdge(m.id,'a',cp.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',hm.id,'spec');
addEdge(cp.id,'f0',hm.id,'f0');                    // основная берётся из кепстра
addEdge(cp.id,'f0',sa.id,'m3'); addEdge(hm.id,'h2',sa.id,'m4');
addEdge(m.id,'a',st.id,'in');
markWiresDirty();
});
preset('Noise-Resistant Frame', function(){
clearAll();
const ts=addNode('textsrc',40,40,{text:'TEST FRAME 12345'});
ts.size.w=340; ts.size.h=100; applySize(ts);
const tx=addNode('serialTx',40,240,{baud:1200,code:'ASCII 8N1'});
const fr=addNode('frame',400,40,{len:120,src:'every sample',fmt:'bits'});
fr.size.w=380; fr.size.h=160; applySize(fr);
const en=addNode('convEnc',400,300,{K:7,g1:'171',g2:'133',tail:true});
const il=addNode('interleaveTx',700,300,{rows:9,cols:20});
const nz=addNode('osc',700,480,{wave:'noise',amp:.4});
const dl=addNode('interleaveRx',1000,300,{rows:9,cols:20});
const vi=addNode('viterbiDec',1300,40,{K:7,g1:'171',g2:'133',tail:true,fmt:'text'});
vi.size.w=420; vi.size.h=220; applySize(vi);
const bv=addNode('blkview',1300,320,{fmt:'hex',wrap:48});
bv.size.w=420; bv.size.h=200; applySize(bv);
addEdge(ts.id,'text',tx.id,'text'); addEdge(ts.id,'go',tx.id,'go');
addEdge(tx.id,'bit',fr.id,'in'); addEdge(ts.id,'go',fr.id,'trig');
addEdge(fr.id,'blk',en.id,'blk');
addEdge(en.id,'blk',il.id,'blk');
addEdge(il.id,'blk',dl.id,'blk');
addEdge(dl.id,'blk',vi.id,'blk');
addEdge(vi.id,'blk',bv.id,'blk');
markWiresDirty();
});
preset('Sound Level Meter with Log', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:1});
const ff=addNode('fft',40,260,{size:'8192'});
const sa=addNode('sa',360,40,{fmin:20,fmax:20000,log:true,split:.45});
sa.size.w=620; sa.size.h=340; applySize(sa);
const st=addNode('stats',360,420,{tau:1});
st.size.w=420; st.size.h=200; applySize(st);
const cl=addNode('cal',820,420,{mode:'dB offset',ref:94,unit:'dB SPL'});
const lg=addNode('table',1120,40,{list:'logs/sound level',log:true,period:1,names:'dB_SPL,crest,f_peak,level'});
lg.size.w=420; lg.size.h=260; applySize(lg);
const pk=addNode('peak',1120,360,{fmin:20,fmax:20000,thr:-90});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
addEdge(m.id,'a',st.id,'in');
addEdge(st.id,'dbfs',cl.id,'in');
addEdge(cl.id,'out',lg.id,'a'); addEdge(st.id,'crest',lg.id,'b');
addEdge(pk.id,'freq',lg.id,'c'); addEdge(pk.id,'level',lg.id,'d');
markWiresDirty();
});
preset('Analyze Recording (Offline)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Analyze a recording\n\n1. Pick a file in the node below\n'+
'2. Set speed to ×8…×32 in the toolbar\n3. Scrub through the recording with the «position» slider\n'+
'Audio above ×1 speed sounds distorted — that\'s expected.'});
nt.size.w=380; nt.size.h=180; applySize(nt);
const fl=addNode('file',40,280,{rate:1,gain:1,loop:false});
fl.size.w=460; fl.size.h=120; applySize(fl);
const ff=addNode('fft',40,520,{size:'8192'});
const sa=addNode('sa',540,40,{fmin:0,fmax:6000,split:.4});
sa.size.w=620; sa.size.h=340; applySize(sa);
const pe=addNode('persist',540,420,{fmin:0,fmax:6000,decay:.997,gain:4});
pe.size.w=620; pe.size.h=280; applySize(pe);
const cf=addNode('cfar',1200,40,{fmin:100,fmax:6000,thr:10,top:12,hold:2000});
cf.size.w=420; cf.size.h=300; applySize(cf);
const cp=addNode('capture',1200,380,{sec:5,mode:'manual',loop:true});
cp.size.w=420; cp.size.h=160; applySize(cp);
const dc=addNode('dac',1200,600,{vol:.3});
addEdge(fl.id,'out',ff.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pe.id,'spec');
addEdge(ff.id,'spec',cf.id,'spec');
addEdge(cf.id,'f1',sa.id,'m3'); addEdge(cf.id,'f2',sa.id,'m4');
addEdge(fl.id,'out',cp.id,'in'); addEdge(cp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('APRS / AX.25', function(){
clearAll();
const nt=addNode('note',40,40,{text:'APRS / AX.25, Bell 202 1200 baud\n'+
'Tones at 1200 (mark) and 2200 (space) Hz.\nMarker 1 on the analyzer lets you fine-tune reception.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const m =addNode('mic',40,240,{gainA:2});
const ff=addNode('fft',40,440,{size:'2048'});
const sa=addNode('sa',420,40,{fmin:600,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const dm=addNode('fsk',420,380,{f0:1200,shift:1000,bw:600,center:false});
const hd=addNode('ax25Rx',1020,40,{baud:1200,nrzi:true,ax25:true});
hd.size.w=480; hd.size.h=320; applySize(hd);
const bv=addNode('blkview',1020,400,{fmt:'hex',wrap:48});
bv.size.w=480; bv.size.h=180; applySize(bv);
const sc=addNode('scope',420,600,{span:4096,gain:2});
sc.size.w=460; sc.size.h=180; applySize(sc);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',dm.id,'in');
addEdge(dm.id,'fLo',sa.id,'m3'); addEdge(dm.id,'fHi',sa.id,'m4');
addEdge(dm.id,'bLo',sa.id,'bLo'); addEdge(dm.id,'bHi',sa.id,'bHi');
addEdge(dm.id,'soft',hd.id,'in');
addEdge(hd.id,'blk',bv.id,'blk');
addEdge(dm.id,'soft',sc.id,'in1');
markWiresDirty();
});
preset('Interference Suppression', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Interference suppression using a reference channel\n\n'+
'Microphone A — wanted signal plus interference,\nmicrophone B — interference only (a second, separate microphone).\n'+
'The filter subtracts whatever correlates with B.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const mA=addNode('mic',40,260,{gainA:2});
const mB=addNode('mic',40,460,{gainA:2});
const ad=addNode('nlms',420,40,{taps:'256',mu:.3});
const bm=addNode('beam',420,240,{dist:15,ang:0,useManual:false});
const nt2=addNode('notch',420,440,{f0:50,n:5,Q:40});
const ag=addNode('agc',420,600,{target:.3});
const ff=addNode('fft',760,600,{size:'4096'});
const sa=addNode('sa',760,40,{fmin:0,fmax:8000,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const sc=addNode('scope',760,400,{span:4096,gain:2,stack:true});
sc.size.w=520; sc.size.h=180; applySize(sc);
const dc=addNode('dac',1400,40,{vol:.3});
addEdge(mA.id,'a',ad.id,'d'); addEdge(mB.id,'a',ad.id,'x');
addEdge(mA.id,'a',bm.id,'A'); addEdge(mB.id,'a',bm.id,'B');
addEdge(ad.id,'out',nt2.id,'in'); addEdge(nt2.id,'out',ag.id,'in');
addEdge(ag.id,'out',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(mA.id,'a',sc.id,'in1'); addEdge(ad.id,'out',sc.id,'in2');
addEdge(bm.id,'sum',sc.id,'in3');
addEdge(ag.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Mains Hum Removal', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Mains hum removal (50/60 Hz and harmonics)\n\n'+
'Hum Canceller subtracts the hum itself and follows the real mains frequency\n(see its readout);'+
' the rest of the signal is untouched.\nComb Notch — cheaper, cuts every multiple of f0 (and DC),\n'+
'here tuned by the canceller\'s freq output. Compare on the spectrum.'});
nt.size.w=460; nt.size.h=170; applySize(nt);
const m =addNode('mic',40,260,{gainA:2});
const hc=addNode('humcancel',540,40,{preset:'50',f0:50,n:20,bw:1});
const cb=addNode('combnotch',540,420,{preset:'50',f0:50,bw:2});
const ff=addNode('fft',540,600,{size:'8192'});
const sa=addNode('sa',900,40,{fmin:0,fmax:1000,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const dc=addNode('dac',900,640,{vol:.3});
addEdge(m.id,'a',hc.id,'in'); addEdge(m.id,'a',cb.id,'in');
addEdge(hc.id,'freq',cb.id,'f0');
addEdge(hc.id,'out',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(hc.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Room Acoustics', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Room acoustics\n\n'+
'Sweep out the speaker, mic picks it back up.\nThe «Measure» button on the impulse-response node —\n'+
'press it after the sweep has played all the way through.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const sw=addNode('sweep',40,260,{f0:30,f1:18000,rate:.25,mode:'log',amp:.3});
const dc=addNode('dac',40,460,{vol:.4});
const m =addNode('mic',40,620,{gainA:2});
const ff=addNode('fft',420,620,{size:'16384'});
const oc=addNode('octave',760,620,{width:'1/3 octave',weight:'A',fmin:20,fmax:20000});
const sa=addNode('sa',420,40,{fmin:20,fmax:20000,log:true,floor:-100,top:-20,split:.5});
sa.size.w=600; sa.size.h=320; applySize(sa);
const irn=addNode('ir',420,400,{size:'32768',range:'T20'});
irn.size.w=560; irn.size.h=200; applySize(irn);
const st=addNode('stats',1060,620,{tau:1});
addEdge(sw.id,'out',dc.id,'L');
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',oc.id,'spec');
addEdge(oc.id,'spec',sa.id,'spec');
addEdge(sw.id,'out',irn.id,'ref'); addEdge(m.id,'a',irn.id,'meas');
addEdge(m.id,'a',st.id,'in');
markWiresDirty();
});
preset('HFDL: Detection and Frame', function(){
clearAll();
const nt=addNode('note',40,40,{text:'HFDL, receive chain\n\n'+
'SSB carrier shifted by 1440 Hz, 1800 baud.\n'+
'Preamble: A (127 bits) → A → M1 (127 bits).\n'+
'The M1 variant sets the rate: turn «M1 variant (HFDL)»\n'+
'and watch which one gives the correlation peak.\n\n'+
'What\'s here: detection, rate, deinterleaver,\nViterbi, descrambler, CRC.\n'+
'What\'s not: equalizer training on T-symbols\nand MPDU/LPDU parsing.'});
nt.size.w=420; nt.size.h=260; applySize(nt);
const m =addNode('mic',40,340,{gainA:2});
const ff=addNode('fft',40,540,{size:'8192'});
const sa=addNode('sa',480,40,{fmin:0,fmax:3500,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const sb=addNode('demod',480,380,{mode:'SSB',freq:1440,bw:2600,side:'USB',gain:3});
const co=addNode('costas',480,560,{f0:1800,order:'8PSK',loopHz:5,lp:2500});
const ga=addNode('gardner',800,560,{baud:1800,gain:.005});
const sl=addNode('pskdec',1080,560,{order:'8',diff:true,fmt:'bits'});
sl.size.w=340; sl.size.h=180; applySize(sl);
const cr=addNode('corr',1080,40,{pat:'HFDL: preamble A',baud:1800,thr:.6,abs:true,dead:100});
cr.size.w=420; cr.size.h=180; applySize(cr);
const cm=addNode('corr',1080,260,{pat:'HFDL: M1 (rate)',baud:1800,thr:.5,abs:true,shift:0});
cm.size.w=420; cm.size.h=200; applySize(cm);
const fr=addNode('frame',1560,40,{len:2160,src:'on clk',fmt:'bits'});
fr.size.w=380; fr.size.h=160; applySize(fr);
const di=addNode('hfdlDeint',1560,260,{shiftCols:17});
const vi=addNode('viterbiDec',1560,420,{K:7,g1:'155',g2:'117',tail:false,fmt:'hex'});
vi.size.w=380; vi.size.h=200; applySize(vi);
const ds=addNode('hfdlDescr',1560,680,{baud:1800});
const bv=addNode('blkview',1960,420,{fmt:'hex',wrap:48});
bv.size.w=400; bv.size.h=220; applySize(bv);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',sb.id,'in'); addEdge(sa.id,'f1',sb.id,'freq');
addEdge(sb.id,'out',co.id,'in');
addEdge(co.id,'I',ga.id,'I'); addEdge(co.id,'Q',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(co.id,'I',cr.id,'in'); addEdge(co.id,'I',cm.id,'in');
addEdge(co.id,'I',fr.id,'in'); addEdge(ga.id,'clk',fr.id,'clk');
addEdge(cm.id,'peak',fr.id,'trig');
addEdge(fr.id,'blk',di.id,'blk');
addEdge(di.id,'blk',vi.id,'blk');
addEdge(vi.id,'blk',bv.id,'blk');
markWiresDirty();
});


/* ============================================================
   Добавить в presets.js (рядом с остальными preset(...) вызовами,
   до вызова buildBuiltinPresets()). Требует узлов acid/drumseq
   из dsp-techno-nodes.js.
   ============================================================ */

function stepPattern(hits,len=32){                        // список индексов шагов → битовая строка
  const a=new Array(len).fill('0');
  for(const h of hits) a[h]='1';
  return a.join('');
}

preset('Synth: Acid Bass (303)', function(){
  clearAll();
  const sq=addNode('seq',40,40,{pattern:'45,45,x,48,45,43,45,x,45,45,x,50,45,43,41,x',bpm:130,div:'1/16',gatelen:.5});
  sq.size.w=420; applySize(sq);
  const ac=addNode('acid',520,40,{cutoff:500,envAmt:2600,reso:.8,decay:.18,slide:.05});
  const ds=addNode('dist',520,260,{type:'tanh',drive:3,mix:.6});
  const dl=addNode('delay',780,260,{ms:180,fb:.25,mix:.25});
  const dc=addNode('dac',1040,40,{vol:.4,mode:'mono'});
  addEdge(sq.id,'freq',ac.id,'freq'); addEdge(sq.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',dl.id,'in'); addEdge(dl.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Techno: Drum Machine', function(){
  clearAll();
  const grid=[stepPattern([0,4,8,12]), stepPattern([]), stepPattern([4,12]),
              stepPattern([2,6,10]), stepPattern([14]), stepPattern([])].join(';');
  const dr=addNode('drumseq',40,40,{grid,bpm:130,steps:16});
  dr.size.w=520; applySize(dr);
  const dc=addNode('dac',620,40,{vol:.5,mode:'mono'});
  addEdge(dr.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Techno: Generative Acid', function(){
  clearAll();
  const gs=addNode('genseq',40,40,{root:33,scale:'minor pentatonic',octaves:2,bpm:130,div:'1/16',
                                    gatelen:.5,restProb:.25,leapProb:.15});
  const ac=addNode('acid',520,40,{cutoff:480,envAmt:2500,reso:.8,decay:.17,slide:.05});
  const ds=addNode('dist',520,260,{drive:2.5,mix:.5});
  const dl=addNode('delay',780,260,{ms:180,fb:.25,mix:.25});
  const dc=addNode('dac',1040,40,{vol:.4,mode:'mono'});
  addEdge(gs.id,'freq',ac.id,'freq'); addEdge(gs.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',dl.id,'in'); addEdge(dl.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Techno: Full Track', function(){
  clearAll();
  const grid=[stepPattern([0,4,8,12]), stepPattern([]), stepPattern([4,12]),
              stepPattern([2,6,10]), stepPattern([14]), stepPattern([])].join(';');
  const dr=addNode('drumseq',40,40,{grid,bpm:130,steps:16});
  dr.size.w=520; applySize(dr);
  const sq=addNode('seq',40,320,{pattern:'33,33,x,36,33,31,33,x,33,33,x,38,33,31,29,x',bpm:130,div:'1/16',gatelen:.5});
  sq.size.w=420; applySize(sq);
  const ac=addNode('acid',620,320,{cutoff:450,envAmt:2400,reso:.82,decay:.16,slide:.04});
  const ds=addNode('dist',620,480,{drive:2.5,mix:.5});
  const mx=addNode('mixer4',900,180,{ka:1,pa:0,kb:.9,pb:0});
  const cp=addNode('comp',1160,180,{threshold:-10,ratio:4});
  const dc=addNode('dac',1400,180,{vol:.45,mode:'mono'});
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(sq.id,'freq',ac.id,'freq'); addEdge(sq.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',mx.id,'b');
  addEdge(mx.id,'out',cp.id,'in'); addEdge(cp.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Tracker (MOD / S3M / XM)', function(){
  clearAll();
  const tr=addNode('tracker',40,40,{});
  tr.p.song='';                                        // ключ песни у каждой загрузки пресета свой
  const vw=addNode('trkview',40,330,{});
  vw.size.w=520; vw.size.h=300; applySize(vw);
  const dc=addNode('dac',640,40,{vol:.6,mode:'stereo'});
  addEdge(tr.id,'L',dc.id,'L'); addEdge(tr.id,'R',dc.id,'R'); addEdge(tr.id,'song',vw.id,'song');
  markWiresDirty();
});

// канал 1 — отдельно через задержку, канал 2 играет не семплом, а 303-синтом по нотам трекера
preset('Tracker: Channels through Effects', function(){
  clearAll();
  const tr=addNode('tracker',40,40,{});
  tr.p.song='';
  const vw=addNode('trkview',40,330,{});
  vw.size.w=520; vw.size.h=260; applySize(vw);
  const c1=addNode('trkch',620,40,{ch:1,take:true});
  const dl=addNode('delay',880,40,{ms:250,fb:.35,mix:.35});
  const c2=addNode('trkch',620,330,{ch:2,take:true});
  const ac=addNode('acid',880,330,{cutoff:500,envAmt:2400,reso:.75,decay:.2,slide:.03});
  const dm=addNode('dac',1140,40,{vol:.6,mode:'stereo'});
  const d1=addNode('dac',1140,260,{vol:.5,mode:'mono'});
  addEdge(tr.id,'L',dm.id,'L'); addEdge(tr.id,'R',dm.id,'R');
  addEdge(tr.id,'song',vw.id,'song'); addEdge(tr.id,'song',c1.id,'song'); addEdge(tr.id,'song',c2.id,'song');
  addEdge(c1.id,'out',dl.id,'in'); addEdge(dl.id,'out',d1.id,'L');
  addEdge(c2.id,'freq',ac.id,'freq'); addEdge(c2.id,'gate',ac.id,'gate'); addEdge(ac.id,'out',d1.id,'R');
  markWiresDirty();
});

// редактор из тайлов в духе Renoise: включите ▦ — транспорт сверху, последовательность паттернов слева,
// паттерн в центре, инструменты справа, семпл/инструмент, микшер и граф модулей снизу
preset('Tracker Studio (tiles)', function(){
  clearAll();
  const tr=addNode('tracker',40,40,{});
  tr.p.song='';
  const dc=addNode('dac',40,330,{vol:.6,mode:'stereo'});
  addEdge(tr.id,'L',dc.id,'L'); addEdge(tr.id,'R',dc.id,'R');
  const tile={};
  [['trkbar',340,40],['trkseq',340,160],['trkpat',680,160],['trkinsl',1280,160],['trksmp',340,580],['trkmix',800,580],['trkkeys',1280,580]]
    .forEach(([t,x,y])=>{ tile[t]=addNode(t,x,y,{}); addEdge(tr.id,'song',tile[t].id,'song'); });
  const leaf=n=>({t:'leaf',id:dashId(),node:n?n.id:null});
  const split=(dir,children,sizes)=>({t:'split',id:dashId(),dir,children,sizes});
  Graph.dashTree=split('col',[
    leaf(tile.trkbar),
    split('row',[leaf(tile.trkseq),leaf(tile.trkpat),leaf(tile.trkinsl)],[18,57,25]),
    split('row',[leaf(tile.trksmp),leaf(tile.trkmix),{t:'leaf',id:dashId(),node:null,view:'graph'}],[45,30,25])],[17,52,31]);
  markWiresDirty();
});

// трекер играет генераторами графа: инструмент 1 — бас на 303, инструмент 2 — аккорды на 4-голосом синте,
// драм-машина идёт по clk трекера (импульс на строку)
preset('Tracker: Synths as Instruments', function(){
  clearAll();
  const tr=addNode('tracker',40,40,{demo:'synth'});
  tr.p.song='';
  const vw=addNode('trkview',40,330,{});
  vw.size.w=460; vw.size.h=240; applySize(vw);
  const i1=addNode('trkins',560,40,{inst:1,voices:'1'});
  const ac=addNode('acid',820,40,{cutoff:420,envAmt:2600,reso:.8,decay:.18,slide:.04});
  const i2=addNode('trkins',560,330,{inst:2,voices:'4'});
  const ps=addNode('poly4',820,330,{wave:'saw',attack:.02,decay:.3,sustain:.5,release:.4,spread:.7});
  const grid=[stepPattern([0,4,8,12]), stepPattern([]), stepPattern([4,12]),
              stepPattern([2,6,10,14]), stepPattern([]), stepPattern([])].join(';');
  const dr=addNode('drumseq',560,620,{grid,steps:16});
  dr.size.w=460; applySize(dr);
  const mx=addNode('mixer4',1100,200,{ka:.8,kb:.35,kc:.8,kd:0});
  const dc=addNode('dac',1360,200,{vol:.5,mode:'mono'});
  addEdge(tr.id,'song',vw.id,'song'); addEdge(tr.id,'song',i1.id,'song'); addEdge(tr.id,'song',i2.id,'song');
  addEdge(i1.id,'freq',ac.id,'freq'); addEdge(i1.id,'gate',ac.id,'gate');
  for(const k of ['','2','3','4']){ addEdge(i2.id,'freq'+k,ps.id,'freq'+k); addEdge(i2.id,'gate'+k,ps.id,'gate'+k); }
  addEdge(tr.id,'clk',dr.id,'clk');
  addEdge(ac.id,'out',mx.id,'a'); addEdge(ps.id,'out',mx.id,'b'); addEdge(dr.id,'out',mx.id,'c');
  addEdge(mx.id,'out',dc.id,'L');
  markWiresDirty();
});

/* ---- демо новых фич пиано-ролла / драм-машины / мастер-клока ---- */

preset('Piano Roll: Length and Velocity', function(){
  clearAll();
  // трезвучие длиной 2 шага, затем одиночные ноты разной длины (1–4 шага) и громкости (60–120)
  const grid='60:0:2:90;64:0:2:90;67:0:2:90;65:3:1:70;67:4:1:70;69:5:3:120;'+
             '65:9:1:60;64:10:1:60;62:11:1:60;60:12:4:100';
  const pr=addNode('pianoroll',40,40,{grid,steps:16,bpm:110,div:'1/8',gatelen:.85});
  pr.size.w=560; applySize(pr);
  const vc=addNode('voice',660,40,{wave1:'saw',level1:.7,wave2:'square',level2:0,
                                    attack:.01,decay:.15,sustain:.6,release:.25});
  const dc=addNode('dac',940,40,{vol:.4,mode:'mono'});
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(pr.id,'vel',vc.id,'vel');
  addEdge(vc.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Piano Roll: 4-Voice Chords', function(){
  clearAll();
  // 4 квартаккорда по 4 ноты — каждая нота идёт на свой freq/gate выход (freq..freq4)
  const grid=[
    '48:0:4:90','52:0:4:80','55:0:4:80','60:0:4:70',
    '50:4:4:90','53:4:4:80','57:4:4:80','60:4:4:70',
    '45:8:4:90','48:8:4:80','52:8:4:80','57:8:4:70',
    '48:12:4:100','52:12:4:90','55:12:4:90','60:12:4:80'
  ].join(';');
  const pr=addNode('pianoroll',40,40,{grid,steps:16,bpm:90,div:'1/4',gatelen:.9});
  pr.size.w=560; applySize(pr);
  const py=addNode('poly4',660,40,{wave:'tri',attack:.02,decay:.3,sustain:.7,release:.4,spread:.7});
  const dc=addNode('dac',940,40,{vol:.35});
  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(py.id,'L',dc.id,'L'); addEdge(py.id,'R',dc.id,'R');      // панорама голосов — по-настоящему стерео
  markWiresDirty();
});

preset('Drum Machine: Banks A/B', function(){
  clearAll();
  const A=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
           stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([6],16)].join(';');
  const B=[stepPattern([0,8],16), stepPattern([],16), stepPattern([12,13,14,15],16),
           stepPattern([2,6,10,14],16), stepPattern([],16), stepPattern([],16)].join(';');
  const grid=[A,B,'',''].join('|');                                // банк A — качалка, банк B — брейк с хлоп-роллом
  const dr=addNode('drumseq',40,40,{grid,steps:16,bpm:130,div:'1/16',bank:'A'});
  dr.size.w=560; applySize(dr);
  const dc=addNode('dac',680,40,{vol:.5,mode:'mono'});
  addEdge(dr.id,'out',dc.id,'L');
  markWiresDirty();
});
// Переключай банк вкладками A/B/C/D в шапке узла, рисуй перетаскиванием,
// «Копировать»/«Вставить» — гоняет паттерн между банками (и между разными узлами).

preset('Sync: Master Clock', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});
  const A=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
           stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([],16)].join(';');
  const dr=addNode('drumseq',40,220,{grid:[A,'','',''].join('|'),steps:16});
  dr.size.w=520; applySize(dr);
  const grid='60:0:2:100;63:2:2:90;65:4:2:100;60:6:2:80;58:8:2:100;60:10:2:90;63:12:2:100;65:14:2:110';
  const pr=addNode('pianoroll',40,460,{grid,steps:16,gatelen:.7});
  pr.size.w=520; applySize(pr);
  const vc =addNode('voice',620,460,{wave1:'saw',level1:.7,wave2:'square',level2:0,
                                      attack:.005,decay:.2,sustain:.4,release:.15});
  const mx =addNode('mixer4',1140,300,{ka:1,pa:-.3,kb:1,pb:.3});
  const dc =addNode('dac',1400,300,{vol:.4,mode:'mono'});
  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk');   // оба секвенсора — от одного клока
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(vc.id,'out',mx.id,'b');
  addEdge(mx.id,'out',dc.id,'L');
  markWiresDirty();
});
// Свой bpm у drumseq/pianoroll теперь не используется — весь тайминг задаёт clock.
// Смени bpm или div на clock — оба секвенсора перестроятся синхронно, без расхождения по фазе.

preset('Piano Roll: Scale Quantization', function(){
  clearAll();
  // риф в D натуральный минор (D,E,F,G,A,B♭,C) — все ноты уже попадают в лад
  const grid='62:0:2:100;65:2:2:90;69:4:2:100;67:6:1:80;65:7:1:80;64:8:2:90;62:10:2:100;60:12:4:110';
  const pr=addNode('pianoroll',40,40,{grid,steps:16,gatelen:.8,
                                       key:'D',scale:'natural minor',quantize:true});
  pr.size.w=560; applySize(pr);
  const vc=addNode('voice',660,40,{wave1:'tri',level1:.7,wave2:'square',level2:0,
                                    attack:.01,decay:.2,sustain:.5,release:.3});
  const dc=addNode('dac',940,40,{vol:.4,mode:'mono'});
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(pr.id,'vel',vc.id,'vel');
  addEdge(vc.id,'out',dc.id,'L');
  markWiresDirty();
});
// Фон сетки затемняет ступени вне лада — при «квантовать по ладу» клик в затемнённую
// клетку всё равно ставит ближайшую ноту лада, мимо не промахнёшься. Уже расставленные
// ноты не переезжают сами — квантуются только новые, при создании.

preset('Arrangement: Intro → Verse → Chorus', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});
  const sg=addNode('song',40,220,{seq:'A:2,B:4,B:4,C:4,C:4,B:2,A:2',stepsPerBar:16,loop:true});
  sg.size.w=340; applySize(sg);

  // банк A — интро (только хэты), B — куплет (качалка), C — припев (плотнее)
  const drGrid=
    '0000000000000000;0000000000000000;0000000000000000;0010001000100010;0000000000000000;0000000000000000|'+
    '1000100010001000;0000000000000000;0000100000001000;0101010101010101;0000000000000010;0000001000000000|'+
    '1010101010101010;0000000000000000;0000100000001000;0101010101010101;0010000000100000;0000001100000011|';
  const dr=addNode('drumseq',40,460,{grid:drGrid,steps:16});
  dr.size.w=560; applySize(dr);

  // банк A — выдержанный пад-аккорд, B — риф, C — аккордовые удары на каждую долю
  const prGrid=[
    '45:0:16:70;48:0:16:70;52:0:16:70',
    '62:0:2:100;65:2:2:90;69:4:2:100;67:6:1:80;65:7:1:80;64:8:2:90;62:10:2:100;60:12:4:110',
    '57:0:2:120;60:0:2:120;64:0:2:120;55:4:2:115;59:4:2:115;62:4:2:115;'+
    '57:8:2:120;60:8:2:120;64:8:2:120;60:12:2:127;64:12:2:127;67:12:2:127',
    ''
  ].join('|');
  const pr=addNode('pianoroll',700,460,{grid:prGrid,steps:16,gatelen:.85});
  pr.size.w=560; applySize(pr);

  // все 4 голоса пиано-ролла — один poly4 вместо ручной сборки osc+adsr+mul на каждый
  const py=addNode('poly4',1320,460,{wave:'tri',attack:.015,decay:.25,sustain:.6,release:.3,spread:.5});

  const mx=addNode('mixer4',1620,300,{ka:1,pa:-.3,kb:.9,pb:.2});
  const dc=addNode('dac',1900,300,{vol:.4,mode:'mono'});

  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk'); addEdge(ck.id,'pulse',sg.id,'clk');
  addEdge(sg.id,'bank',dr.id,'bankSel'); addEdge(sg.id,'bank',pr.id,'bankSel');   // один и тот же банк на оба узла
  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(py.id,'out',mx.id,'b');
  addEdge(mx.id,'out',dc.id,'L');
  markWiresDirty();
});
// У song-узла над клеткой каждого секвенсора появляется жёлтая полоска — значит банк
// сейчас переключает не UI, а song. Сам song теперь — плейлист: клик по бейджу A/B/C/D
// меняет банк секции, «−»/«+» — число тактов, ▲/▼ — переставить, «×» — удалить,
// «+ секция» сверху — добавить. Клик по телу строки ставит секцию в очередь — переход
// произойдёт на следующем такте, не обрывая текущий.

preset('12-Channel Mixer: Full Band', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});

  // барабаны — обычная качалка (без банков, тут показываем именно микшер)
  const drGrid=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
                stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([6],16)].join(';');
  const dr=addNode('drumseq',40,220,{grid:drGrid,steps:16});
  dr.size.w=520; applySize(dr);

  // пэд-аккорды на 4 голоса
  const prGrid=[
    '48:0:4:90','52:0:4:80','55:0:4:80','60:0:4:70',
    '50:4:4:90','53:4:4:80','57:4:4:80','60:4:4:70',
    '45:8:4:90','48:8:4:80','52:8:4:80','57:8:4:70',
    '48:12:4:100','52:12:4:90','55:12:4:90','60:12:4:80'
  ].join(';');
  const pr=addNode('pianoroll',40,460,{grid:prGrid,steps:16,bpm:90,div:'1/4',gatelen:.9});
  pr.size.w=520; applySize(pr);
  const py=addNode('poly4',40,700,{wave:'tri',attack:.02,decay:.3,sustain:.7,release:.4,spread:.4});

  // бас — генеративная мелодия через acid-фильтр
  const gs=addNode('genseq',620,220,{root:33,scale:'minor pentatonic',octaves:1,
                                      div:'1/16',gatelen:.5,restProb:.2,leapProb:.15});
  const ac=addNode('acid',620,380,{cutoff:450,envAmt:2200,reso:.75,decay:.16,slide:.05});

  // лид — короткий секвенированный рифф через voice
  const sq=addNode('seq',620,540,{pattern:'72,x,75,72,x,79,77,x',div:'1/8',gatelen:.5});
  const vc=addNode('voice',620,700,{wave1:'square',level1:.5,wave2:'sine',level2:.3,
                                     attack:.005,decay:.15,sustain:.4,release:.15});

  const mx=addNode('mixer12',1120,300,{
    ka:1,pa:0,                 // барабаны — по центру
    kb:.8,pb:-.4,              // аккорды — влево
    kc:.9,pc:0,                // бас — по центру
    kd:.7,pd:.45});            // лид — вправо
  const dc=addNode('dac',1420,300,{vol:.35});

  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk');
  addEdge(ck.id,'pulse',gs.id,'clk'); addEdge(ck.id,'pulse',sq.id,'clk');

  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(gs.id,'freq',ac.id,'freq'); addEdge(gs.id,'gate',ac.id,'gate');
  addEdge(sq.id,'freq',vc.id,'freq'); addEdge(sq.id,'gate',vc.id,'gate');

  addEdge(dr.id,'out',mx.id,'a');
  addEdge(py.id,'out',mx.id,'b');
  addEdge(ac.id,'out',mx.id,'c');
  addEdge(vc.id,'out',mx.id,'d');
  addEdge(mx.id,'L',dc.id,'L'); addEdge(mx.id,'R',dc.id,'R');
  markWiresDirty();
});
// Использованы только 4 из 12 каналов (a—d) — остальные 8 (e…l) свободны, подключай
// что угодно ещё: перкуссию, вторую мелодию, шумовую текстуру. У каждого канала свои
// уровень/панорама/мьют в параметрах узла, имя канала — первая буква в названии параметра.

preset('Phase Scope: Correlation and Lissajous Figures', function(){
  clearAll();
  const o1=addNode('osc',40,40,{wave:'sine',freq:220,amp:.3});
  const lf=addNode('lfo',40,260,{freq:.15,min:80,max:4000});          // медленно крутит частоту фазовращателя
  const ap=addNode('biquad',360,40,{type:'ap',freq:220,Q:.9});        // АЧХ не трогает, только сдвигает фазу
  const xy=addNode('xyscope',680,40,{gain:1,persist:.85});
  xy.size.w=420; xy.size.h=300; applySize(xy);
  const sm=addNode('sum',360,260,{ka:.6,kb:.6});                      // сухой + сдвинутый по фазе сигнал вместе
  const dc=addNode('dac',680,400,{vol:.3,mode:'mono'});
  addEdge(lf.id,'out',ap.id,'freq'); addEdge(o1.id,'out',ap.id,'in');
  addEdge(o1.id,'out',xy.id,'x'); addEdge(ap.id,'out',xy.id,'y');
  addEdge(o1.id,'out',sm.id,'a'); addEdge(ap.id,'out',sm.id,'b'); addEdge(sm.id,'out',dc.id,'L');
  markWiresDirty();
});
// Пока LFO гоняет частоту allpass-фильтра, фигура на фазоскопе плывёт от прямой линии
// (сигналы синфазны, корреляция около +1) через эллипс/окружность (сдвиг ~90°, корреляция
// около 0) до обратной линии (противофаза, корреляция около −1). Полоса снизу — то же самое
// числом. На слух сумма сухого и сдвинутого сигналов даёт лёгкий фейзерный эффект.

preset('Hilbert: Envelope and Instantaneous Frequency', function(){
  clearAll();
  const lf=addNode('lfo',40,40,{freq:.5,min:0,max:.35});               // амплитудная огибающая тона
  const o1=addNode('osc',40,260,{wave:'sine',freq:600,amp:.3});
  const hb=addNode('hilbert',360,260,{taps:127});
  const pl=addNode('polar',680,260);
  const sc=addNode('scope',1000,40,{span:4096,gain:1,stack:true});
  sc.size.w=480; sc.size.h=280; applySize(sc);
  const dc=addNode('dac',1000,400,{vol:.25,mode:'mono'});
  addEdge(lf.id,'out',o1.id,'amp');
  addEdge(o1.id,'out',hb.id,'in');
  addEdge(hb.id,'I',pl.id,'I'); addEdge(hb.id,'Q',pl.id,'Q');
  addEdge(pl.id,'mag',sc.id,'in1'); addEdge(pl.id,'dphase',sc.id,'in2');
  addEdge(o1.id,'out',dc.id,'L');
  markWiresDirty();
});
// hilbert строит аналитический сигнал прямо из чистого тона (без настройки на несущую,
// в отличие от iq); polar.mag — огибающая, повторяющая форму LFO, которым модулируется
// амплитуда; polar.dphase — мгновенная частота, у чистого тона должна держаться ровной
// линией около 600/24000≈0.025. Подключи вместо чистого тона что угодно ещё (голос,
// AM-сигнал с радио) — mag/dphase сразу покажут его огибающую и девиацию частоты.

preset('Sonar: Single Mic, 18–22 kHz Chirp', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'Monostatic sonar: speaker and microphone on the same device.\n\n'+
    'Required: echo/ns/agc on mic are off (already the default in this preset,\n'+
    'but check if you\'ve enabled them manually before). Otherwise the browser\'s\n'+
    'adaptive processing will cut out exactly the signal being measured here.\n\n'+
    'The range profile is drawn right on the sonar node. The peak is the found echo,\n'+
    'range1/range2/range3 are distances in meters (round-trip path already halved).\n'+
    'motion1 is the accumulated micro-displacement of the strongest echo by phase; an approximate\n'+
    'value, useful for relative changes (breathing, tremor), not absolute range.\n\n'+
    'At the start, point the phone at a wall/palm 0.5–1.5 m away and hold still — the first echo\n'+
    'should be stable.'});
  nt.size.w=460; nt.size.h=260; applySize(nt);
  const m=addNode('mic',40,340,{gainA:3,echo:false,ns:false,agc:false});
  const sn=addNode('sonar',420,40,{fLo:18000,fHi:22000,dur:12,period:100,maxDelay:25,amp:.5,thr:.15});
  sn.size.w=520; sn.size.h=260; applySize(sn);
  const dc=addNode('dac',420,340,{vol:1,mode:'mono'});
  addEdge(m.id,'a',sn.id,'in'); addEdge(sn.id,'out',dc.id,'L');
  markWiresDirty();
});
// dac.vol стоит на 1 неспроста: если тише — на многих телефонных динамиках 18–22 кГц
// и так на грани слышимости/чувствительности микрофона, эхо будет слабым и потонет
// в шуме. thr (порог пика) и maxDelay (окно поиска) — первое, что крутить, если эхо
// не находится: слишком высокий порог режет слабые отражения, слишком узкое окно
// не достаёт до цели.

preset('Triggered Scope: Phase Difference Visible', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'trig on scope is on (default). The trigger looks for an edge on the first ACTIVE\n'+
    'channel — that\'s in1. All channels are drawn from that same found start point,\n'+
    'which is why in1 looks stationary because of it.\n\n'+
    'IMPORTANT about osc\'s "phase" param: by itself it does nothing. It\'s only read\n'+
    'the moment a sync pulse arrives on the sync input (n.ph=n.p.phase inside\n'+
    'if(I.sync)). Without sync, phase just free-runs on its own counter. That\'s why here\n'+
    'o1.sync is wired to o2.sync: at equal frequency (200=200 Hz) o2 is forced to jump\n'+
    'to its own "phase" param every cycle — turn it on o2, and the shift is immediately\n'+
    'visible on screen as a stable (non-drifting) offset between the waves.\n\n'+
    'Making the frequencies different brings the drift back: sync resets the phase\n'+
    'each time, but between pulses it still runs at its own rate.'});
  nt.size.w=460; nt.size.h=320; applySize(nt);
  const o1=addNode('osc',40,400,{wave:'sine',freq:200,amp:.4,phase:0});
  const o2=addNode('osc',40,580,{wave:'sine',freq:200,amp:.4,phase:.25});
  const sc=addNode('scope',420,400,{span:2400,gain:1,trig:true,stack:true});
  sc.size.w=560; sc.size.h=280; applySize(sc);
  addEdge(o1.id,'sync',o2.id,'sync');
  addEdge(o1.id,'out',sc.id,'in1'); addEdge(o2.id,'out',sc.id,'in2');
  markWiresDirty();
});
preset('Chirp Modem: Noise and Reflection', function(){
clearAll();
// символ качается 0..63 медленной пилой — просто чтобы на глаз увидеть, что приёмник
// действительно отслеживает меняющееся значение, а не просто выдаёт одно и то же число
const src=addNode('lfo',40,40,{freq:.15,min:0,max:63,wave:'saw'});
const tx=addNode('chirpTx',300,40,{sf:'6',bw:2000,f0:1000,amp:.5});
const dl=addNode('delay',300,260,{ms:6,fb:0,mix:.35});         // короткое эхо — имитация переотражения
const nz=addNode('osc',300,420,{wave:'noise',amp:.05});
const mx=addNode('sum',560,140,{ka:1,kb:1});
const ff=addNode('fft',820,40,{size:'2048',win:'hann'});
const wf=addNode('sa',820,220,{fmin:0,fmax:3200,split:.4});
wf.size.w=480; wf.size.h=300; applySize(wf);
const rx=addNode('chirpRx',1340,40,{sf:'6',bw:2000,f0:1000});
const nvSym=addNode('numview',1340,260,{digits:0});
const nvLvl=addNode('numview',1340,360,{digits:2});
const nt=addNode('note',40,540,{text:
  'A symbol = a cyclic time shift of the same chirp pulse, not frequency/phase.\n\n'+
  'The receiver de-chirps (multiplies by the inverse reference chirp) and looks for the FFT peak — a shifted chirp\n'+
  'turns into a plain tone k·bw/M after de-chirping, so finding it is the same as finding the\n'+
  'symbol. Verified numerically (not just by eye): clean/with noise/with reflection — decodes\n'+
  'without a single error; disable dl/nz one at a time if you want to see each effect\n'+
  'separately. Watch sa — you can see the alternating upward chirp sweeps.'});
nt.size.w=460; nt.size.h=220; applySize(nt);
addEdge(src.id,'out',tx.id,'sym');
addEdge(tx.id,'out',dl.id,'in');
addEdge(dl.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
addEdge(rx.id,'sym',nvSym.id,'in'); addEdge(rx.id,'level',nvLvl.id,'in');
markWiresDirty();
});

preset('APRS: Transmit and Receive (Loop)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Builds an AX.25 frame (UI, Bell202 1200 baud) and immediately\n'+
'receives it back through ax25Rx — checks framing/CRC without going over the air.\n'+
'For real transmission, the mod output goes to "spk" instead of sum+noise.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const tx=addNode('ax25Tx',40,220,{src:'RA1ABC-1',dst:'APRS',path:'WIDE1-1,WIDE2-1',
  text:'!5540.00N/03730.00E>test from DSP workbench',baud:1200,loop:true});
tx.size.w=400; tx.size.h=300; applySize(tx);
const md=addNode('mod',480,220,{mode:'FSK',f0:1200,shift:1000,amp:.3,rise:.5});
const nz=addNode('osc',480,480,{wave:'noise',amp:.01});
const mx=addNode('sum',760,220,{ka:1,kb:1});
const dm=addNode('fsk',1000,220,{f0:1200,shift:1000,bw:600,center:false});
const hd=addNode('ax25Rx',1000,480,{baud:1200,nrzi:true,ax25:true});
hd.size.w=440; hd.size.h=280; applySize(hd);
const bv=addNode('blkview',1480,220,{fmt:'hex',wrap:48});
bv.size.w=380; bv.size.h=280; applySize(bv);
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',dm.id,'in');
addEdge(dm.id,'soft',hd.id,'in');
addEdge(hd.id,'blk',bv.id,'blk');
markWiresDirty();
});

preset('DTMF: Encoder + Decoder', function(){
clearAll();
const nt=addNode('note',40,40,{text:'dtmfTx generates tones, dtmfRx recognizes them right back —\n'+
'a loop for checking, without going over the air.'});
nt.size.w=380; nt.size.h=100; applySize(nt);
const tx=addNode('dtmfTx',40,180,{text:'123A456B',toneMs:100,gapMs:60,loop:true});
const rx=addNode('dtmfRx',480,180,{thr:6,minMs:40});
rx.size.w=360; rx.size.h=160; applySize(rx);
const sc=addNode('scope',480,400,{span:4096,gain:1});
addEdge(tx.id,'out',rx.id,'in');
addEdge(tx.id,'out',sc.id,'in1');
markWiresDirty();
});

preset('Text → Bits → Text (Encodings)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'A generic text↔bits (blk) layer, separate from timing.\n'+
'Change "coding" the same way on both nodes — RTTY/PSK31/UTF-8.'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const t2=addNode('txt2bits',40,180,{text:'CQ CQ DE TEST',coding:'Baudot ITA2'});
const b2=addNode('bits2txt',480,180,{coding:'Baudot ITA2'});
b2.size.w=380; b2.size.h=160; applySize(b2);
addEdge(t2.id,'blk',b2.id,'blk');
markWiresDirty();
});

preset('Olivia: Transmit and Receive (Loop)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Olivia 8/250: MFSK + Walsh–Hadamard FEC (64-symbol block).\n'+
'Try increasing nz noise — Olivia holds up even with noise stronger than the signal.'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const tx=addNode('oliviaTx',40,180,{text:'CQ CQ DE TEST OLIVIA',tones:'8',bw:'250',f0:1000,amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',480,180,{wave:'noise',amp:.15});
const mx=addNode('sum',480,400,{ka:1,kb:1});
const ff=addNode('fft',760,40,{size:'4096'});
const wf=addNode('sa',760,220,{fmin:800,fmax:1200,split:.4});
wf.size.w=480; wf.size.h=280; applySize(wf);
const rx=addNode('oliviaRx',1300,40,{tones:'8',bw:'250',f0:1000});
rx.size.w=380; rx.size.h=220; applySize(rx);
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
markWiresDirty();
});

preset('Contestia: Transmit and Receive (Loop)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Contestia 8/500 — the same MFSK+FEC engine as Olivia,\n'+
'just a different Tones/Bandwidth combo (faster, but a bit less noise-resistant).'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const tx=addNode('contestiaTx',40,180,{text:'CQ CQ DE TEST CONTESTIA',tones:'8',bw:'500',f0:1000,amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',480,180,{wave:'noise',amp:.15});
const mx=addNode('sum',480,400,{ka:1,kb:1});
const ff=addNode('fft',760,40,{size:'4096'});
const wf=addNode('sa',760,220,{fmin:700,fmax:1300,split:.4});
wf.size.w=480; wf.size.h=280; applySize(wf);
const rx=addNode('contestiaRx',1300,40,{tones:'8',bw:'500',f0:1000});
rx.size.w=380; rx.size.h=220; applySize(rx);
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
markWiresDirty();
});

preset('OFDM: Text via Multi-Carrier Modulation', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Generic OFDM modulation: 16 subcarriers, differential BPSK — on its own\n'+
'on each subcarrier, no pilots. txt2bits → ofdmTx → channel → ofdmRx → bits2txt.\n'+
'At the loop boundary the text will have ~1-2 "garbage" bytes — that\'s a phase jump on\n'+
'loop restart, not a protocol bug.'});
nt.size.w=460; nt.size.h=140; applySize(nt);
const t2=addNode('txt2bits',40,220,{text:'CQ CQ DE TEST OFDM WORKBENCH',coding:'UTF-8'});
const tx=addNode('ofdmTx',420,220,{carriers:16,spacing:31.25,f0:800,cp:25,mod:'BPSK',amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',420,520,{wave:'noise',amp:.1});
const mx=addNode('sum',820,220,{ka:1,kb:1});
const ff=addNode('fft',1080,40,{size:'4096'});
const wf=addNode('sa',1080,220,{fmin:700,fmax:1400,split:.4});
wf.size.w=460; wf.size.h=260; applySize(wf);
const rx=addNode('ofdmRx',1080,520,{carriers:16,spacing:31.25,f0:800,cp:25,mod:'BPSK'});
const b2=addNode('bits2txt',1600,520,{coding:'UTF-8'});
b2.size.w=380; b2.size.h=200; applySize(b2);
addEdge(t2.id,'blk',tx.id,'blk');
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
addEdge(rx.id,'blk',b2.id,'blk');
markWiresDirty();
});


/* ==========================================================================================
 * ПРЕСЕТ (отдельно от hfdl-all.js — подключай оба файла).
 *
 * НОВОЕ: costas теперь переключает order (BPSK/QPSK/8PSK) НА ЛЕТУ синхронно с фреймером —
 * преамбула/тренировка в HFDL всегда BPSK, целевая схема (тут 8PSK) — только во время данных
 * (см. current_mod_arity в hfdl.c). Раньше costas молотил один фиксированный order весь кадр,
 * из-за чего фаза грубо отслеживалась во время данных даже при верно определённом M1 —
 * подтверждено на реальном сигнале: c BPSK-преамбулой ловится чистый пик M1, но дальше
 * по кадру фаза плывёт без переключения.
 *
 * Планировщик (hfdlOrderSched) — copy той же state-machine, что в hfdlSymToBits, сидит на
 * тех же go/m1/clk. Получается цикл в графе (costas→...→hfdlOrderSched→costas.order) —
 * в этом движке циклы штатно поддерживаются (читают предыдущий блок, ~10мс задержка,
 * не критично на масштабах кадра).
 *
 * hfdlChipAvg — усредняет chip-пары для BPSK-скоростей (M1=0,1,4,5, codeRate=4).
 *
 * Проверено на реальной записи: структура (M1-детектор, деперемежитель, полином Витерби
 * "raw"=155/117) подтверждена отдельно, метрика Витерби падает до единиц-сотен от максимума
 * на настоящих кадрах, когда costas реально захватывает преамбулу.
 * hfdlDeint получает 'shiftCols' с hfdlShiftFromM1 (тот же приём, что и в hfdlChipAvg) —
 * сдвиг деперемежителя переключается на лету по M1, одно- и двухслотовые кадры (M1=0-3
 * vs 4-7) идут через один и тот же граф без ручной подстройки.
 * ========================================================================================== */
preset('HFDL: Receive and Aircraft Map', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'costas.order now switches on the fly (hfdlOrderSched) — preamble/training is BPSK,\n'+
    'data is the target scheme. This is a cycle in the graph (normal for this engine, ~1 block of delay).\n'+
    'hfdlChipAvg is required for BPSK rates (M1=0,1,4,5), otherwise Viterbi gets twice\n'+
    'as many bits as it should.\n'+
    'f0/freq=1455 — confirmed with the x² method on THREE different files (~1450-1456 Hz), NOT 1800.\n'+
    'The carrier is taken from the actual recording, not a bit from the spec — re-measure it for another file.\n'+
    'eqBw defaults to 0.1 — matched against real hfdl.c (eqlms_cccf_set_bw(c->eq, 0.1f)), used to be 0.05.\n'+
    'KNOWN UNRESOLVED ISSUE: even with these fixes, train-BER on our chain stays\n'+
    'around 40-50% on real recordings (checked on a very clean file, SNR is not the culprit). The real\n'+
    'dumphfdl decodes the same files without trouble — the discrepancy is in our demod architecture\n'+
    '(Costas/Gardner/equalizer), not the parameters or the protocol stack above it. See SESSION_NOTES.md.\n'+
    'If something\'s off — check each node\'s readout along the chain left to right, it shows\n'+
    'which step it got stuck at (waiting for frame / M2 / TRAIN / DATA / bad_fcs).'});
  nt.size.w=560; nt.size.h=270; applySize(nt);

  const m =addNode('mic',40,300,{gainA:2});
  const bp=addNode('biquad',320,300,{type:'bp',freq:1455,Q:1.2});
  const co=addNode('costas',580,300,{f0:1455,order:'BPSK',loopHz:20,lp:2500});
  const fi=addNode('rrc',840,220,{baud:1800,beta:.35,span:8});
  const fq=addNode('rrc',840,400,{baud:1800,beta:.35,span:8});
  const ga=addNode('gardner',1100,300,{baud:1800,gain:.02});

  const m1=addNode('hfdlM1Match',1360,80,{baud:1800,thr:.5,dead:1500});
  const sched=addNode('hfdlOrderSched',1360,500,{m1:3});

  const s2b=addNode('hfdlSymToBits',1360,300,{descramble:true});
  const deint=addNode('hfdlDeint',1660,300,{shiftCols:17});
  const shiftM1=addNode('hfdlShiftFromM1',1660,500,{m1:3});
  const avg=addNode('hfdlChipAvg',1960,300,{});
  const vit=addNode('viterbiDec',2260,300,{K:7,g1:'155',g2:'117',tail:true,fmt:'hex'});
  vit.size.w=360; vit.size.h=240; applySize(vit);
  const stack=addNode('hfdlStack',2660,300,{freq:11384});
  const map=addNode('geoMap',2960,300,{ttl:120,mz:2,mlat:30,mlon:0});
  map.size.w=560; map.size.h=340; applySize(map);

  addEdge(m.id,'a',bp.id,'in');
  addEdge(bp.id,'out',co.id,'in');
  addEdge(sched.id,'order',co.id,'order');             // ЦИКЛ: order по фреймеру, а не фикс. параметр
  addEdge(co.id,'I',fi.id,'in'); addEdge(co.id,'Q',fq.id,'in');
  addEdge(fi.id,'out',ga.id,'I'); addEdge(fq.id,'out',ga.id,'Q');

  addEdge(fi.id,'out',m1.id,'in');

  addEdge(ga.id,'sI',s2b.id,'I'); addEdge(ga.id,'sQ',s2b.id,'Q'); addEdge(ga.id,'clk',s2b.id,'clk');
  addEdge(m1.id,'go',s2b.id,'go'); addEdge(m1.id,'m1',s2b.id,'m1'); addEdge(m1.id,'flip',s2b.id,'flip');

  addEdge(ga.id,'clk',sched.id,'clk');
  addEdge(m1.id,'go',sched.id,'go'); addEdge(m1.id,'m1',sched.id,'m1');

  addEdge(s2b.id,'blk',deint.id,'blk');
  addEdge(s2b.id,'m1',shiftM1.id,'m1');
  addEdge(shiftM1.id,'shiftCols',deint.id,'shiftCols');
  addEdge(deint.id,'blk',avg.id,'blk');
  addEdge(s2b.id,'m1',avg.id,'m1');                    // из hfdlSymToBits (синхронизирован с blk), НЕ напрямую из hfdlM1Match!
  addEdge(avg.id,'blk',vit.id,'blk');
  addEdge(vit.id,'blk',stack.id,'blk');

  addEdge(stack.id,'rec',map.id,'rec');               // самолёты (треки по id) и наземные станции
  markWiresDirty();
});

preset('4FSK Digital Voice: Auto Detect (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'One decoder for the 4FSK / 2FSK digital voice systems: 4FSK Digital Voice takes an IQ stream and finds the protocol by its sync words —\n'+
  'DMR, P25 Phase 1, NXDN, YSF, M17, D-STAR, dPMR (or pick one in the node). The generator is a test transmitter: switch its 4FSK parameter between\n'+
  'P25 voice / control channel, NXDN, YSF, M17, D-STAR, dPMR and watch the records: calls, callsigns / IDs, text, trunking messages. Raw vocoder frames go on the voice output into Vocoder (mbelib): P25 / NXDN / dPMR / D-STAR / DMR frames become sound (the generator sends random frames, so it is noise).'});
nt.size.w=760; nt.size.h=120; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:433000000,mode:'4FSK',fsk4:'M17 voice stream',off:2000,lvl:-20,noise:-45});
const de=addNode('fskRx',340,240,{proto:'auto'});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,640,{});
log.size.w=560; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
const vc=addNode('mbeVoice',920,240,{}); vc.size.w=340; applySize(vc);
const dc=addNode('dac',920,420,{vol:.5});
addEdge(de.id,'voice',vc.id,'voice'); addEdge(vc.id,'out',dc.id,'L'); addEdge(vc.id,'out',dc.id,'R');
const ml=addNode('msgLog',1300,240,{}); ml.size.w=460; ml.size.h=300; applySize(ml);
const sl=addNode('subLog',1300,580,{}); sl.size.w=460; sl.size.h=300; applySize(sl);
addEdge(de.id,'rec',ml.id,'rec'); addEdge(de.id,'rec',sl.id,'rec');
markWiresDirty();
});
preset('4FSK Digital Voice: Any System (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Tune the SDR to a digital voice channel (VHF / UHF: DMR, P25, NXDN, YSF, M17, D-STAR, dPMR) and tap the signal on the spectrum.\n'+
  '4FSK Digital Voice locks onto whatever it hears and decodes it; records go to the log, raw vocoder frames come out on the voice output; Vocoder (mbelib) turns P25 IMBE and DMR / NXDN / dPMR / D-STAR AMBE frames into sound.'});
nt.size.w=760; nt.size.h=100; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:438000000,demod:'IQ'});
const sa=addNode('sa',860,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('fskRx',340,360,{proto:'auto'});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,760,{});
log.size.w=560; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
const vc=addNode('mbeVoice',920,360,{}); vc.size.w=340; applySize(vc);
const dc=addNode('dac',920,540,{vol:.5});
addEdge(de.id,'voice',vc.id,'voice'); addEdge(vc.id,'out',dc.id,'L'); addEdge(vc.id,'out',dc.id,'R');
const ml=addNode('msgLog',1300,360,{}); ml.size.w=460; ml.size.h=300; applySize(ml);
const sl=addNode('subLog',1300,700,{}); sl.size.w=460; sl.size.h=300; applySize(sl);
addEdge(de.id,'rec',ml.id,'rec'); addEdge(de.id,'rec',sl.id,'rec');
markWiresDirty();
});
preset('M17: Transmitter Built from Blocks (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'M17 transmitter taken apart and looped back into the receiver — no radio involved.\n'+
  'M17 Frame Builder (text → preamble, LSF, SMS packets, EOT; press Send) → Symbol Player (frames → symbols at 4800 Bd) → RRC Pulse Shaper → FM Modulator (IQ).\n'+
  'The IQ goes into the receiver chain (IQ Frequency Shift by the carrier offset, decimator, FM discriminator, RRC, slicer, sync search, parser) and the message comes out in the log.\n'+
  'For a real transmission put HackRF TX after FM Modulator: set the output sample rate of the shaper to 2 MS/s or more. You must comply with local radio regulations: transmit only where and how the law allows.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const tx=addNode('m17Tx',40,240,{});
tx.size.w=300; tx.size.h=300; applySize(tx);
const pl=addNode('symPlay',400,240,{});
const sh=addNode('symShape',400,440,{sr:'256000',alpha:.5});
const fm=addNode('fmMod',700,240,{off:100000});
const ss=addNode('iqShift',700,500,{offset:100000});
const dc=addNode('iqDecim',700,680,{M:'5'});
const fd=addNode('fmDisc',1000,240,{});
const rr=addNode('symRrc',1000,440,{baud:4800,alpha:.5});
const sl=addNode('symSlicer',1000,620,{baud:4800});
const sy=addNode('symSync',1300,240,{});
sy.size.w=340; sy.size.h=220; applySize(sy);
const ps=addNode('m17Parse',1300,500,{});
ps.size.w=420; ps.size.h=240; applySize(ps);
const lg=addNode('recLog',1300,800,{});
lg.size.w=420; applySize(lg);
addEdge(tx.id,'blk',pl.id,'blk'); addEdge(pl.id,'out',sh.id,'in'); addEdge(sh.id,'out',fm.id,'in');
addEdge(fm.id,'iq',ss.id,'in'); addEdge(ss.id,'out',dc.id,'in'); addEdge(dc.id,'out',fd.id,'in');
addEdge(fd.id,'out',rr.id,'in'); addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in');
addEdge(sy.id,'blk',ps.id,'blk'); addEdge(ps.id,'rec',lg.id,'rec');
markWiresDirty();
});
preset('Data over 4FSK: Image, File or Text (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Any data over a 4FSK symbol channel (not any standard), looped back without a radio.\n'+
  'Camera frame (or a file, text, bits) → Data → Symbols (JPEG / bytes → frames: sync word, number, length, CRC-16, whitened) → Symbol Player → RRC Pulse Shaper → FM Modulator → IQ → receiver chain → Symbol Sync Search (same word, 156 symbols after it for 32 bytes per frame) → Symbols → Data (CRC, reassembly) → picture / text.\n'+
  'Change the sync word to a DMR one and the payload to fit a slot if needed. For a real transmission put HackRF TX after FM Modulator (shaper output rate 2 MS/s or more). You must comply with local radio regulations: transmit only where and how the law allows.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const cm=addNode('cam',40,240,{});
const tx=addNode('dataTx',340,240,{});
tx.size.w=320; tx.size.h=340; applySize(tx);
const pl=addNode('symPlay',700,240,{});
const sh=addNode('symShape',700,440,{sr:'256000',alpha:.5});
const fm=addNode('fmMod',1000,240,{off:100000});
const ss=addNode('iqShift',1000,500,{offset:100000});
const dc=addNode('iqDecim',1000,680,{M:'5'});
const fd=addNode('fmDisc',1300,240,{});
const rr=addNode('symRrc',1300,440,{baud:4800,alpha:.5});
const sl=addNode('symSlicer',1300,620,{baud:4800});
const sy=addNode('symSync',1600,240,{word:'755FD7DF75F7',len:156,pre:0,period:0});
sy.size.w=340; sy.size.h=220; applySize(sy);
const rx=addNode('dataRx',1600,500,{});
rx.size.w=360; rx.size.h=300; applySize(rx);
addEdge(cm.id,'img',tx.id,'img');
addEdge(tx.id,'blk',pl.id,'blk'); addEdge(pl.id,'out',sh.id,'in'); addEdge(sh.id,'out',fm.id,'in');
addEdge(fm.id,'iq',ss.id,'in'); addEdge(ss.id,'out',dc.id,'in'); addEdge(dc.id,'out',fd.id,'in');
addEdge(fd.id,'out',rr.id,'in'); addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in');
addEdge(sy.id,'blk',rx.id,'blk');
markWiresDirty();
});
preset('Data over DMR: Image, File or Text (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Data in real DMR frames, looped back without a radio: the content is yours (a camera picture as JPEG, a file, text), the carrier is DMR.\n'+
  'DMR Data Builder: bytes → datagrams (frame number, length, CRC-16) → UDP/IPv4 → a data call (CSBK preamble, data header, blocks with CRC-32, BPTC) → time slots with CACH and sync words, colour code 1.\n'+
  'Symbol Player → RRC Pulse Shaper (α 0.2) → FM Modulator (648 Hz) → Digital Voice Decoder (DMR) → the UDP port and payload come out in rec → Symbols → Data puts the file / picture / text back.\n'+
  'A standard DMR receiver sees an IP/UDP packet to the given port; it does not know how to show a picture. A real repeater will pass the packets only if it carries the slot and the radio IDs are allowed.\n'+
  'For a real transmission put HackRF TX after FM Modulator (shaper output rate 2 MS/s or more). You must comply with local radio regulations: transmit only where and how the law allows.'});
nt.size.w=1100; nt.size.h=150; applySize(nt);
const cm=addNode('cam',40,260,{});
const tx=addNode('dmrTx',340,260,{});
tx.size.w=320; tx.size.h=400; applySize(tx);
const pl=addNode('symPlay',720,260,{});
const sh=addNode('symShape',720,460,{sr:'256000',alpha:.2});
const fm=addNode('fmMod',1020,260,{off:2000,dev:648});
const de=addNode('fskRx',1020,500,{proto:'dmr'});
de.size.w=520; de.size.h=300; applySize(de);
const rx=addNode('dataRx',1600,260,{});
rx.size.w=360; rx.size.h=300; applySize(rx);
addEdge(cm.id,'img',tx.id,'img');
addEdge(tx.id,'blk',pl.id,'blk'); addEdge(pl.id,'out',sh.id,'in'); addEdge(sh.id,'out',fm.id,'in');
addEdge(fm.id,'iq',de.id,'in'); addEdge(de.id,'rec',rx.id,'rec');
markWiresDirty();
});
preset('M17: Voice Transmitter, Microphone to Speaker (Loopback)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'M17 voice, microphone to speaker through the whole radio chain without a radio. Use headphones: with speakers the sound feeds back into the microphone.\n'+
  'Microphone → Vocoder Encoder (Codec 2: 8 kHz, 3200 bit/s, 16 bytes per 40 ms) → M17 Frame Builder in voice mode (press PTT on / off: preamble, LSF, a stream frame per 16 bytes, last-frame flag, EOT)\n'+
  '→ Symbol Player → RRC Pulse Shaper → FM Modulator → IQ → the receiver chain (shift, decimator, FM discriminator, RRC, slicer, sync search) → M17 Frame Parser → Vocoder (mbelib / Codec 2) → sound card.\n'+
  'For a real transmission put HackRF TX after FM Modulator (shaper output rate 2 MS/s or more) and wire the pin ptt to a switch. You must comply with local radio regulations: transmit only where and how the law allows.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const mc=addNode('mic',40,240,{});
const en=addNode('c2Enc',340,240,{});
const tx=addNode('m17Tx',340,400,{mode:'voice (stream)'});
tx.size.w=300; tx.size.h=300; applySize(tx);
const pl=addNode('symPlay',700,240,{});
const sh=addNode('symShape',700,440,{sr:'256000',alpha:.5});
const fm=addNode('fmMod',1000,240,{off:100000});
const ss=addNode('iqShift',1000,500,{offset:100000});
const dc=addNode('iqDecim',1000,680,{M:'5'});
const fd=addNode('fmDisc',1300,240,{});
const rr=addNode('symRrc',1300,440,{baud:4800,alpha:.5});
const sl=addNode('symSlicer',1300,620,{baud:4800});
const sy=addNode('symSync',1600,240,{});
sy.size.w=340; sy.size.h=220; applySize(sy);
const ps=addNode('m17Parse',1600,500,{});
ps.size.w=420; ps.size.h=240; applySize(ps);
const vc=addNode('mbeVoice',2060,240,{}); vc.size.w=340; applySize(vc);
const dac=addNode('dac',2060,460,{vol:.7});
addEdge(mc.id,'a',en.id,'in'); addEdge(en.id,'voice',tx.id,'voice');
addEdge(tx.id,'blk',pl.id,'blk'); addEdge(pl.id,'out',sh.id,'in'); addEdge(sh.id,'out',fm.id,'in');
addEdge(fm.id,'iq',ss.id,'in'); addEdge(ss.id,'out',dc.id,'in'); addEdge(dc.id,'out',fd.id,'in');
addEdge(fd.id,'out',rr.id,'in'); addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in');
addEdge(sy.id,'blk',ps.id,'blk'); addEdge(ps.id,'voice',vc.id,'voice');
addEdge(vc.id,'out',dac.id,'L'); addEdge(vc.id,'out',dac.id,'R');
markWiresDirty();
});
preset('P25: Receiver Built from Blocks (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'The P25 receiver taken apart: IQ Decimator → FM Discriminator → RRC Matched Filter (α 0.2) → Protocol Decoder (4FSK).\n'+
  'Protocol Decoder runs the same protocol code as Digital Voice Decoder (sync words, frame grid, NID, LDU, TSBK…) on the matched-filter output: 8 clock phases per symbol and the best phase and the levels\n'+
  'from the sync word, as in the single node. protocol = auto tries every protocol with the symbol rate below (4800 Bd: P25, NXDN 9600, YSF, DMR, M17…). Change the generator mode (4FSK parameter) to feed it another system.\n'+
  'For NXDN 4800 and dPMR set the baud of the filter and of the decoder to 2400. The Expand into blocks button on Digital Voice Decoder produces this chain for any protocol; M17 and DMR also have the full chain down to frames.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:433000000,mode:'4FSK',fsk4:'P25 voice',off:2000,lvl:-20,noise:-45});
const dc=addNode('iqDecim',340,240,{M:'5'});
const fm=addNode('fmDisc',340,440,{bw:5500});
const rr=addNode('symRrc',700,240,{baud:4800,alpha:.2});
const pd=addNode('fskSym',700,440,{proto:'auto',baud:4800});
pd.size.w=480; pd.size.h=320; applySize(pd);
const lg=addNode('recLog',1260,240,{});
lg.size.w=460; applySize(lg);
addEdge(gn.id,'iq',dc.id,'in'); addEdge(dc.id,'out',fm.id,'in'); addEdge(fm.id,'out',rr.id,'in');
addEdge(rr.id,'out',pd.id,'in'); addEdge(pd.id,'rec',lg.id,'rec');
markWiresDirty();
});
preset('DMR: Receiver Built from Blocks (Generator)', function(){
clearAll();
const ch=FSK4.protos.dmr.chain;
const nt=addNode('note',40,40,{text:'The DMR receiver taken apart: IQ Decimator → FM Discriminator → RRC Matched Filter (α 0.2) → Symbol Slicer → Symbol Sync Search → DMR Frame Parser.\n'+
  'Symbol Sync Search looks for the 48-bit sync words (repeater, mobile, direct mode, voice and data), takes 66 symbols before the word and 54 after it — one 30 ms frame of 144 symbols with the CACH —\n'+
  'and then keeps the frame grid (period 144) also where the word is missing (voice bursts B–F carry the embedded signalling instead). The parser works out the polarity from the FEC, the colour code, the slots,\n'+
  'voice calls, CSBK, data and SMS — the same channel layer as Digital Voice Decoder with protocol = dmr. The Expand into blocks button on that node produces exactly this chain.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:438000000,mode:'DMR',off:2000,lvl:-20,noise:-45});
const dc=addNode('iqDecim',340,240,{M:'5'});
const fm=addNode('fmDisc',340,440,{bw:ch.lp});
const rr=addNode('symRrc',700,240,{baud:ch.baud,alpha:ch.alpha});
const sl=addNode('symSlicer',700,440,{baud:ch.baud});
const sy=addNode('symSync',1060,240,{word:ch.words,len:ch.len,tol:ch.tol,pre:ch.pre,period:ch.period,lockTol:ch.lockTol});
sy.size.w=360; sy.size.h=240; applySize(sy);
const ps=addNode('dmrParse',1060,540,{});
ps.size.w=460; ps.size.h=300; applySize(ps);
const lg=addNode('recLog',1560,240,{});
lg.size.w=460; applySize(lg);
addEdge(gn.id,'iq',dc.id,'in'); addEdge(dc.id,'out',fm.id,'in'); addEdge(fm.id,'out',rr.id,'in');
addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in'); addEdge(sy.id,'blk',ps.id,'blk'); addEdge(ps.id,'rec',lg.id,'rec');
markWiresDirty();
});
preset('M17: Receiver Built from Blocks (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'The 4FSK receiver taken apart: IQ Decimator → FM Discriminator → RRC Matched Filter → Symbol Slicer → Symbol Sync Search → frames.\n'+
  'Symbols travel on an IQ wire as a real stream at the symbol rate (levels about ±1, ±3). Symbol Sync Search finds the M17 sync words (LSF 55F7, stream FF5D,\n'+
  'packet 75FF, BERT DF55) by correlation, fits gain and offset on the word (the sign of the gain is the polarity) and cuts a frame of 184 symbols after it.\n'+
  'Block Viewer shows the frames, M17 Frame Parser turns them into calls, callsigns, text and raw Codec 2 (the FEC, LSF / LICH / packet reassembly are the same as in\n'+
  'Digital Voice Decoder). The chain works for any 4FSK protocol: change the baud, alpha, words and frame length.'});
nt.size.w=1000; nt.size.h=120; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:433000000,mode:'4FSK',fsk4:'M17 voice stream',off:2000,lvl:-20,noise:-45});
const dc=addNode('iqDecim',340,240,{M:'5'});
const fm=addNode('fmDisc',340,440,{});
const rr=addNode('symRrc',700,240,{baud:4800,alpha:.5});
const sl=addNode('symSlicer',700,440,{baud:4800});
const sy=addNode('symSync',1060,240,{});
sy.size.w=360; sy.size.h=220; applySize(sy);
const bv=addNode('blkview',1060,520,{fmt:'hex'});
bv.size.w=360; bv.size.h=260; applySize(bv);
addEdge(gn.id,'iq',dc.id,'in'); addEdge(dc.id,'out',fm.id,'in'); addEdge(fm.id,'out',rr.id,'in');
addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in'); addEdge(sy.id,'blk',bv.id,'blk');
const ps=addNode('m17Parse',1420,240,{});
ps.size.w=460; ps.size.h=260; applySize(ps);
const lg=addNode('recLog',1420,560,{});
lg.size.w=460; applySize(lg);
addEdge(sy.id,'blk',ps.id,'blk'); addEdge(ps.id,'rec',lg.id,'rec');
markWiresDirty();
});
preset('TETRA: Test Cell (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'TETRA without a radio: the generator sends the main carrier of a test cell (MCC 262, MNC 1011, colour code 5, 391.0 MHz) — π/4-DQPSK, 18 kBd, 4 slots per frame:\n'+
  'a synchronization burst in frame 18, a control channel in slot 1 (MAC-RESOURCE with addresses and MLE / MM / CMCE message names, a channel allocation now and then),\n'+
  'a call in slot 2 every few seconds (traffic bursts with random bits instead of speech: the Vocoder plays noise), and SDS: text in three encodings (one long, sent in MAC fragments), statuses and LIP position reports of three moving radios — they land in Messages, Subscribers and on the map. TETRA Decoder: sync burst → cell identity and time, AACH, SYSINFO, MAC-RESOURCE, calls by usage marker.'});
nt.size.w=760; nt.size.h=120; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'256000',fc:391000000,mode:'TETRA',off:0,lvl:-20,noise:-45});
const de=addNode('tetraRx',340,240,{});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,640,{});
log.size.w=560; applySize(log);
addEdge(gn.id,'iq',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
const vc=addNode('mbeVoice',920,240,{}); vc.size.w=340; applySize(vc);
const dc=addNode('dac',920,420,{vol:.5});
addEdge(de.id,'voice',vc.id,'voice'); addEdge(vc.id,'out',dc.id,'L'); addEdge(vc.id,'out',dc.id,'R');
const ml=addNode('msgLog',1300,240,{proto:'TETRA'}); ml.size.w=460; ml.size.h=300; applySize(ml);
const sl=addNode('subLog',1300,580,{proto:'TETRA'}); sl.size.w=460; sl.size.h=300; applySize(sl);
addEdge(de.id,'rec',ml.id,'rec'); addEdge(de.id,'rec',sl.id,'rec');
const map=addNode('geoMap',1820,240,{mz:11,ttl:120,labels:true,trail:3000}); map.size.w=560; map.size.h=420; applySize(map);
addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('TETRA: Control Channel (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'TETRA: tune the SDR to a base-station main carrier (380–400 MHz in Europe, 410–430 / 450–470 MHz elsewhere; 25 kHz channels) and tap the signal on the spectrum.\n'+
  'The decoder finds the synchronization burst, then shows the cell (MCC / MNC, colour code, frequency, location area), calls and signalling addresses.\n'+
  'Speech frames go to the voice output → Vocoder (needs the locally built ACELP codec, see README); encrypted calls come out as noise.'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'1024000',freq:392000000,demod:'IQ'});
const sa=addNode('sa',860,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const de=addNode('tetraRx',340,360,{});
de.size.w=560; de.size.h=340; applySize(de);
const log=addNode('recLog',340,760,{});
log.size.w=560; applySize(log);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',de.id,'in'); addEdge(de.id,'rec',log.id,'rec');
const vc=addNode('mbeVoice',920,360,{}); vc.size.w=340; applySize(vc);
const dc=addNode('dac',920,540,{vol:.5});
addEdge(de.id,'voice',vc.id,'voice'); addEdge(vc.id,'out',dc.id,'L'); addEdge(vc.id,'out',dc.id,'R');
const ml=addNode('msgLog',1300,360,{proto:'TETRA'}); ml.size.w=460; ml.size.h=300; applySize(ml);
const sl=addNode('subLog',1300,700,{proto:'TETRA'}); sl.size.w=460; sl.size.h=300; applySize(sl);
addEdge(de.id,'rec',ml.id,'rec'); addEdge(de.id,'rec',sl.id,'rec');
const map=addNode('geoMap',860,360,{mz:11,ttl:600,labels:true,trail:3000}); map.size.w=560; map.size.h=420; applySize(map);
addEdge(de.id,'rec',map.id,'rec');
markWiresDirty();
});
preset('Analog TV: Test Card (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Analog video without a radio: the generator sends a PAL test card (colour bars, grey scale, frame) frequency-modulated like an FPV transmitter.\n'+
  'TV Demodulator: FM discriminator + video low-pass → composite video (sync tips down). TV Decoder: line and field sync, PAL / NTSC by the number of lines, colour burst (PAL V-switch and\n'+
  'line averaging), interlace → picture on the Frame node. Try: generator standard NTSC, AM (with the demodulator on AM negative), noise; decoder polarity, width, colour, picture shift.\n'+
  'Colour needs a sample rate of at least 2.4 × the subcarrier (10.6 MS/s PAL, 8.6 MS/s NTSC). 12 MS/s is heavy: lower the run speed if the browser cannot keep up.'});
nt.size.w=760; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,240,{sr:'12000000',fc:5800000000,mode:'Analog TV',tv:'PAL',tvm:'FM',tvdev:4000000,off:0,lvl:-20,noise:-50});
const dm=addNode('tvDemod',340,240,{mode:'FM',dev:4000000,bw:5000000});
const dc=addNode('tvDecode',340,380,{});
dc.size.w=420; dc.size.h=110; applySize(dc);
const fr=addNode('imgview',800,200,{});
fr.size.w=520; fr.size.h=440; applySize(fr);
const sp=addNode('iqSpec',340,560,{size:'4096',avg:'4'});
const sa=addNode('sa',40,640,{auto:true,floor:-100,top:-30});
sa.size.w=700; sa.size.h=240; applySize(sa);
addEdge(gn.id,'iq',dm.id,'in'); addEdge(dm.id,'out',dc.id,'in'); addEdge(dc.id,'img',fr.id,'img');
addEdge(gn.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
markWiresDirty();
});
preset('Analog TV: FPV / TV Receiver (USB SDR)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Analog video from an SDR with a wide sample rate: FPV (5.6–5.95 GHz, FM, needs a HackRF at 16–20 MS/s) or broadcast TV (UHF, AM negative: set the demodulator to AM (negative), 10 MS/s).\n'+
  'Tap the video carrier on the spectrum; TV Demodulator turns the channel into composite video, TV Decoder finds the sync, standard and colour. If the picture is a negative or the decoder cannot lock,\n'+
  'flip its polarity; move the picture with the shift sliders. With HackRF turn RX AMP and LNA on; FPV needs a 5.8 GHz antenna. The demodulator bandwidth (5 MHz) is the video bandwidth.'});
nt.size.w=760; nt.size.h=110; applySize(nt);
const rx=addNode('rtlsdr',40,200,{sr:'20000000',freq:5800000000,demod:'IQ'});
const sa=addNode('sa',860,40,{auto:true,floor:-100,top:-30,split:1});
sa.size.w=600; sa.size.h=280; applySize(sa);
const sh=addNode('iqShift',340,200,{});
const dm=addNode('tvDemod',340,340,{mode:'FM',dev:8000000,bw:5000000});
const dc=addNode('tvDecode',340,480,{});
dc.size.w=420; dc.size.h=110; applySize(dc);
const fr=addNode('imgview',860,360,{});
fr.size.w=520; fr.size.h=440; applySize(fr);
addEdge(rx.id,'spec',sa.id,'spec');
addEdge(rx.id,'iq',sh.id,'in'); addEdge(sa.id,'f1',sh.id,'freq');
addEdge(sh.id,'out',dm.id,'in'); addEdge(dm.id,'out',dc.id,'in'); addEdge(dc.id,'img',fr.id,'img');
markWiresDirty();
});
preset('Indicators: Lamps, Gauge, LED Bar, Compass, Display', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Visual indicators on number wires. An LFO swells a tone; Level measures it in dB: LED Bar (peak marker), Gauge (needle, colour zones, peak).\n'+
  'Compare turns the level into lamps (above -24 dB, with hold so short pulses stay visible; the last lamp blinks on a rising edge); a slow second LFO sweeps the Compass azimuth.\n'+
  'The 7-Segment Display shows a frequency in Hz / kHz / MHz. Every indicator works in the dashboard too.'});
nt.size.w=760; nt.size.h=100; applySize(nt);
const l=addNode('lfo',40,170,{freq:.25,min:0,max:.5});
const o=addNode('osc',260,160,{freq:500,amp:0});
const mt=addNode('meter',480,160,{});
const lb=addNode('ledbar',780,170,{min:-60,max:0,warn:-18,crit:-6});
lb.size.w=300; lb.size.h=34; applySize(lb);
const gg=addNode('gauge',780,470,{min:-60,max:0,warn:-18,crit:-6,unit:'dB'});
gg.size.w=300; gg.size.h=170; applySize(gg);
const c=addNode('ncmp',480,340,{thr:-24,hys:6,span:20});
c.size.w=200; c.size.h=110; applySize(c);
const lp=addNode('lamps',1120,170,{count:'3',labels:'level, rise, fall',colors:'green, amber, red',hold:.4});
lp.size.w=300; lp.size.h=80; applySize(lp);
const l2=addNode('lfo',40,380,{freq:.05,min:0,max:360,wave:'saw'});
const cp=addNode('compass',1120,470,{});
cp.size.w=220; cp.size.h=190; applySize(cp);
const l3=addNode('lfo',40,590,{freq:.1,min:7000000,max:14350000,wave:'tri'});
const sd=addNode('segdisp',1120,790,{digits:8,decimals:3,fmt:'frequency'});
sd.size.w=300; sd.size.h=70; applySize(sd);
addEdge(l.id,'out',o.id,'amp');
addEdge(o.id,'out',mt.id,'in');
addEdge(mt.id,'db',lb.id,'in'); addEdge(mt.id,'db',gg.id,'in'); addEdge(mt.id,'db',c.id,'in');
addEdge(c.id,'out',lp.id,'in1'); addEdge(c.id,'rise',lp.id,'in2'); addEdge(c.id,'fall',lp.id,'in3');
addEdge(l2.id,'out',cp.id,'az');
addEdge(l3.id,'out',sd.id,'in');
markWiresDirty();
});
preset('Indicators: Sky Plot, S-Meter, Text Ticker', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Two LFOs drive a Sky Plot (azimuth sweeps round, elevation rises and sets; the object is hollow below the horizon, the trail shows the pass).\n'+
  'A third LFO plays the signal level in dBm for the S-Meter (S9 = -73 dBm, 6 dB per S unit, fast attack, slow fall, peak marker). Compare fires when the level passes S9;\n'+
  'Fields → Rec packs the level into a record on each trigger and the Text Ticker lists it (switch display to marquee for a running line).'});
nt.size.w=760; nt.size.h=100; applySize(nt);
const a=addNode('lfo',40,160,{freq:.04,min:0,max:360,wave:'saw'});
const e=addNode('lfo',40,340,{freq:.04,min:-15,max:80,wave:'sine'});
const sp=addNode('skyplot',300,160,{trail:40});
sp.size.w=300; sp.size.h=260; applySize(sp);
const l=addNode('lfo',40,640,{freq:.3,min:-100,max:-40,wave:'sine'});
const sm=addNode('smeter',300,640,{s9:-73});
sm.size.w=420; sm.size.h=64; applySize(sm);
const c=addNode('ncmp',760,640,{thr:-73,hys:3,span:20});
c.size.w=220; c.size.h=110; applySize(c);
const rp=addNode('recPack',1020,640,{names:'dBm',consts:'event=above S9',mode:'trigger'});
const tk=addNode('ticker',1020,860,{time:true});
tk.size.w=420; tk.size.h=130; applySize(tk);
addEdge(a.id,'out',sp.id,'az'); addEdge(e.id,'out',sp.id,'el');
addEdge(l.id,'out',sm.id,'in'); addEdge(l.id,'out',c.id,'in'); addEdge(l.id,'out',rp.id,'dBm');
addEdge(c.id,'rise',rp.id,'go'); addEdge(rp.id,'rec',tk.id,'rec');
markWiresDirty();
});
preset('Indicators: Switches and Attitude', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Switch: click a tumbler, lever, rocker or button (latching) / push key (held while pressed); each gives 0 / 1 on outN, the state is saved in the patch.\n'+
  'Here the toggles and the rockers light Lamps panels; the lever, button and push switches show the other styles.\n'+
  'Attitude: an artificial horizon with a pitch ladder, roll scale and a slip ball. Three LFOs roll, pitch and slip it; with an Accelerometer wired to x / y / z it follows the device (flat, screen up).'});
nt.size.w=1000; nt.size.h=110; applySize(nt);
const sw=addNode('switch',40,170,{count:'4',style:'toggle',labels:'A, B, C, D',colors:'green, amber, red, blue'});
sw.size.w=320; sw.size.h=100; applySize(sw);
const lp=addNode('lamps',400,170,{count:'4',labels:'A, B, C, D',colors:'green, amber, red, blue'});
lp.size.w=300; lp.size.h=90; applySize(lp);
const sl=addNode('switch',40,520,{count:'3',style:'lever',labels:'lever 1, lever 2, lever 3',colors:'amber'});
sl.size.w=320; sl.size.h=110; applySize(sl);
const sr=addNode('switch',400,520,{count:'3',style:'rocker',labels:'power, pump, fan',colors:'green'});
sr.size.w=280; sr.size.h=110; applySize(sr);
const lr=addNode('lamps',740,520,{count:'3',labels:'power, pump, fan',colors:'green'});
lr.size.w=280; lr.size.h=90; applySize(lr);
const sb=addNode('switch',40,870,{count:'3',style:'button',labels:'arm, tx, rec',colors:'red, amber, blue'});
sb.size.w=320; sb.size.h=100; applySize(sb);
const sp=addNode('switch',400,870,{count:'2',style:'push',labels:'push, hold',colors:'teal, pink'});
sp.size.w=240; sp.size.h=100; applySize(sp);
const r=addNode('lfo',1100,170,{freq:.12,min:-45,max:45});
const pc=addNode('lfo',1100,450,{freq:.2,min:-18,max:18});
const sk=addNode('lfo',1100,730,{freq:.3,min:-1,max:1});
const at=addNode('attitude',1440,170,{});
at.size.w=320; at.size.h=330; applySize(at);
addEdge(sw.id,'out1',lp.id,'in1'); addEdge(sw.id,'out2',lp.id,'in2'); addEdge(sw.id,'out3',lp.id,'in3'); addEdge(sw.id,'out4',lp.id,'in4');
addEdge(sr.id,'out1',lr.id,'in1'); addEdge(sr.id,'out2',lr.id,'in2'); addEdge(sr.id,'out3',lr.id,'in3');
addEdge(r.id,'out',at.id,'roll'); addEdge(pc.id,'out',at.id,'pitch'); addEdge(sk.id,'out',at.id,'slip');
markWiresDirty();
});
preset('ADS-B: Radar and Attitude (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'ADS-B Radar: a PPI of the decoder\'s aircraft around your position (north up, range rings, headings, trails, a sweep).\n'+
  'Click an aircraft to select it: its callsign, altitude and speed show under the dial, and the outputs follow it —\n'+
  'az / range → Compass and Gauge, fpa (flight path angle from the vertical rate) and bank (from the turn rate) → Attitude, alt → 7-Segment.'});
nt.size.w=620; nt.size.h=130; applySize(nt);
const gn=addNode('iqGen',40,220,{sr:'2400000',fc:1090000000,mode:'ADS-B',off:0,lvl:-20,noise:-40});
const dm=addNode('adsbDemod',40,560,{});
const de=addNode('adsbDecode',320,220,{rlat:55.01,rlon:82.65});
de.size.w=480; de.size.h=240; applySize(de);
const rd=addNode('adsbradar',860,40,{lat:55.01,lon:82.65,range:'auto'});
rd.size.w=380; rd.size.h=380; applySize(rd);
const cp=addNode('compass',1280,40,{});
cp.size.w=200; cp.size.h=190; applySize(cp);
const gg=addNode('gauge',1280,260,{min:0,max:100,warn:70,crit:90,unit:'km'});
gg.size.w=220; gg.size.h=160; applySize(gg);
const at=addNode('attitude',860,460,{ball:false});
at.size.w=260; at.size.h=250; applySize(at);
const sd=addNode('segdisp',1140,500,{digits:6,decimals:0,color:'amber'});
sd.size.w=240; sd.size.h=64; applySize(sd);
addEdge(gn.id,'iq',dm.id,'in'); addEdge(dm.id,'rec',de.id,'rec'); addEdge(de.id,'rec',rd.id,'rec');
addEdge(rd.id,'az',cp.id,'az'); addEdge(rd.id,'track',cp.id,'az2'); addEdge(rd.id,'range',gg.id,'in');
addEdge(rd.id,'bank',at.id,'roll'); addEdge(rd.id,'fpa',at.id,'pitch'); addEdge(rd.id,'alt',sd.id,'in');
markWiresDirty();
});
preset('Satellites: Pass and Sky Plot', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Enter your position in My Position, press Download TLE in Satellites (once). Pass shows the next pass of the selected satellite:\n'+
  'the elevation arc between AOS and LOS (aos / los / maxel outputs), a marker at the current elevation and a countdown; Sky Plot shows where it is in the sky now.'});
nt.size.w=620; nt.size.h=110; applySize(nt);
const me=addNode('geoMe',40,200,{});
const st=addNode('satTrack',300,200,{group:'amateur',sat:'ISS'});
st.size.w=380; st.size.h=520; applySize(st);
const pp=addNode('passplot',720,200,{});
pp.size.w=420; pp.size.h=160; applySize(pp);
const sp=addNode('skyplot',720,400,{trail:120});
sp.size.w=300; sp.size.h=280; applySize(sp);
const cp=addNode('compass',1060,400,{});
cp.size.w=220; cp.size.h=200; applySize(cp);
addEdge(st.id,'el',pp.id,'el'); addEdge(st.id,'az',pp.id,'az'); addEdge(st.id,'aos',pp.id,'aos');
addEdge(st.id,'los',pp.id,'los'); addEdge(st.id,'maxel',pp.id,'max');
addEdge(st.id,'az',sp.id,'az'); addEdge(st.id,'el',sp.id,'el'); addEdge(st.id,'az',cp.id,'az');
markWiresDirty();
});
preset('Logic Analyzer: USB (fx2lafw)', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Logic Analyzer fed by a cheap 8-channel USB logic analyzer (Saleae clones on the Cypress FX2, boards with sigrok fx2lafw firmware): channels 1…8 are D0…D7, up to 24 MS/s (the page keeps up with a few MS/s; the readout warns when samples are dropped).\n'+
  'Press «USB: connect» in the advanced parameters and choose the device. If it has no firmware, press «USB: load firmware (.fw)» and pick a file from the sigrok-firmware-fx2lafw package or from PulseView (fx2lafw-saleae-logic.fw for Saleae clones); the board restarts, connect again. Then «USB: start».\n'+
  'The window, the trigger (edge, single shot with Arm, Hold) and the decoders (UART, SPI, I²C — the channels in the advanced parameters) work as with wires; here the decoder is UART 115200 on channel 1. Samples are 8 bit, so only channels 1…8.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const la=addNode('logan',40,200,{src:'USB',count:'4',names:'D0,D1,D2,D3',proto:'UART',a:1,baud:115200,urate:'4 MHz',span:.002});
la.size.w=720; la.size.h=210; applySize(la);
const lp=addNode('lamps',820,200,{count:'1',labels:'byte',colors:'amber',hold:.15});
lp.size.w=160; lp.size.h=80; applySize(lp);
const tk=addNode('ticker',820,330,{time:true});
tk.size.w=360; tk.size.h=110; applySize(tk);
addEdge(la.id,'new',lp.id,'in1'); addEdge(la.id,'text',tk.id,'text');
markWiresDirty();
});
preset('IR: Remote Codes Loopback (No Hardware)', function(){
clearAll();
const nt=addNode('note',40,20,{text:'The IR codec chain without any hardware. A square LFO presses the button every 2 s: IR Encode builds the frame (NEC, address 4, command 8) → IR Sound TX turns it into a waveform\n'+
  '→ IR Sound RX cuts the waveform back into pulses → IR Decode names the protocol, address and command. Change the protocol, address and command in IR Encode (or give it a text like «Sony12 1 21», «RC5 5 12», «Samsung 7 2»).\n'+
  'Here TX gives only the envelope and RX takes a baseband signal, so it works at any sample rate. For a real LED and a photodiode set the sample rate to 96 kHz or more, TX «modulated» and RX «carrier».\n'+
  'The wire between the nodes carries the frame as text «F:38000 9000 4500 …» (µs); formats of Flipper, Tasmota, Pronto and LIRC are understood too (output format in IR Encode).'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const l=addNode('lfo',40,200,{freq:.5,min:0,max:1,wave:'sq'});
const en=addNode('irEnc',260,200,{proto:'NEC',addr:4,cmd:8});
en.size.h=150; applySize(en);
const tx=addNode('irSoundTx',560,200,{mode:'envelope'});
const rx=addNode('irSoundRx',840,200,{mode:'baseband'});
const dc=addNode('irDec',1120,200,{});
dc.size.w=420; dc.size.h=260; applySize(dc);
const sc=addNode('scope',560,420,{span:4096,gain:1});
sc.size.w=460; sc.size.h=200; applySize(sc);
const tk=addNode('ticker',1120,520,{time:true});
tk.size.w=420; tk.size.h=110; applySize(tk);
addEdge(l.id,'out',en.id,'go'); addEdge(en.id,'raw',tx.id,'raw'); addEdge(tx.id,'out',rx.id,'in'); addEdge(tx.id,'out',sc.id,'in1');
addEdge(rx.id,'raw',dc.id,'raw'); addEdge(dc.id,'text',tk.id,'text');
markWiresDirty();
});
preset('IR: Learn and Replay (Sound Card)', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Copy a remote with a sound card. Input: an IR receiver module (TSOP / VS1838: its output into the microphone or line input, power from 3.3–5 V of any source), or a photodiode with an amplifier — then switch IR Sound RX to «carrier» (needs 96 kHz or more).\n'+
  'Point the remote at the receiver and press a key: IR Learn stores the first frame (the text field holds it; it is saved with the patch). IR Decode names a known protocol and IR Learn shows the structure of an unknown one (an air conditioner: header, the two pause lengths, the bytes).\n'+
  'Replay (or a pulse on `go`) sends the code: IR Sound TX → Sound Card output → a transistor and an IR LED. For a LED on the audio output use «modulated» at 96 kHz or more; at lower rates use «envelope» and an external 38 kHz modulator.\n'+
  '«Capture next» replaces the stored code. Any text format can be pasted into the field: Flipper .ir raw data, Tasmota IRsend, Pronto hex, LIRC numbers.'});
nt.size.w=1180; nt.size.h=150; applySize(nt);
const m =addNode('mic',40,240,{gainA:1,echo:false,ns:false,agc:false});
const rx=addNode('irSoundRx',300,240,{mode:'baseband',gap:20});
const ln=addNode('irLearn',580,240,{times:1,gap:45});
ln.size.w=420; ln.size.h=300; applySize(ln);
const tx=addNode('irSoundTx',1060,240,{mode:'modulated',level:.9});
const dc=addNode('irDec',580,600,{});
dc.size.w=420; dc.size.h=240; applySize(dc);
const dac=addNode('dac',1340,240,{vol:.5});
addEdge(m.id,'a',rx.id,'in'); addEdge(rx.id,'raw',ln.id,'raw'); addEdge(rx.id,'raw',dc.id,'raw');
addEdge(ln.id,'raw',tx.id,'raw'); addEdge(tx.id,'out',dac.id,'L'); addEdge(tx.id,'out',dac.id,'R');
markWiresDirty();
});
preset('IR: Arduino / ESP / Flipper (WebSerial)', function(){
clearAll();
const nt=addNode('note',40,20,{text:'An IR transceiver on a serial port. «device protocol»: sketch — an Arduino / ESP / Pico with tools/ir/ir-serial.ino (IRremote library; a receiver module and an IR LED on its pins),\n'+
  'flipper — the Flipper Zero console (IR frames are sent with `ir tx RAW …`, received with `ir rx raw`), wire — plain lines «F:38000 9000 4500 …» both ways (your own firmware).\n'+
  'Connect, press a key on a remote: IR Decode prints the protocol, address and command; IR Learn keeps the frame and replays it. IR Encode sends a command built from the protocol, address and command (or a text like «NEC 0x04 0x08»).\n'+
  'IR Merge puts Encode and Learn on the single serial input. The same nodes work with the sound card (IR Sound TX / RX): only the adapter changes.'});
nt.size.w=1100; nt.size.h=150; applySize(nt);
const sr=addNode('irSerial',40,220,{dev:'sketch (tools/ir)',baud:'115200'});
sr.size.h=160; applySize(sr);
const dc=addNode('irDec',360,220,{});
dc.size.w=420; dc.size.h=260; applySize(dc);
const ln=addNode('irLearn',820,220,{times:1,gap:45});
ln.size.w=420; ln.size.h=300; applySize(ln);
const en=addNode('irEnc',360,540,{proto:'NEC',addr:4,cmd:8});
en.size.h=150; applySize(en);
const tk=addNode('ticker',820,600,{time:true});
tk.size.w=420; tk.size.h=110; applySize(tk);
const mx=addNode('irMix',600,540,{});
addEdge(sr.id,'raw',dc.id,'raw'); addEdge(sr.id,'raw',ln.id,'raw'); addEdge(ln.id,'raw',mx.id,'b'); addEdge(en.id,'raw',mx.id,'a'); addEdge(mx.id,'raw',sr.id,'raw');
addEdge(dc.id,'text',tk.id,'text');
markWiresDirty();
});
preset('IR: Tasmota Blaster over MQTT', function(){
clearAll();
const nt=addNode('note',40,20,{text:'An ESP8266 / ESP32 with Tasmota and an IR LED / receiver (the IRsend / IRrecv modules) as a network IR transceiver. Set the broker WebSocket address in both MQTT nodes (Mosquitto: `listener 9001` + `protocol websockets`) and the device topic instead of tasmota_ir.\n'+
  'Send: IR Encode (output format «tasmota mqtt») → MQTT Out publishes to cmnd/<device>/IRsend. Receive: with `SetOption58 1` and IRrecv on, Tasmota publishes tele/<device>/RESULT with RawData — MQTT In → IR Decode names the protocol, address and command.\n'+
  'A code learned with IR Learn can be sent the same way: wire IR Learn `raw` through IR Merge to the same MQTT Out.'});
nt.size.w=1100; nt.size.h=130; applySize(nt);
const en=addNode('irEnc',40,200,{proto:'NEC',addr:4,cmd:8,fmt:'tasmota mqtt'});
en.size.h=150; applySize(en);
const mo=addNode('mqttOut',340,200,{url:'ws://127.0.0.1:9001',topic:'cmnd/tasmota_ir/IRsend'});
mo.size.h=140; applySize(mo);
const mi=addNode('mqttIn',40,420,{url:'ws://127.0.0.1:9001',topic:'tele/tasmota_ir/RESULT'});
mi.size.w=340; mi.size.h=190; applySize(mi);
const dc=addNode('irDec',640,420,{});
dc.size.w=420; dc.size.h=260; applySize(dc);
const tk=addNode('ticker',1100,420,{time:true});
tk.size.w=380; tk.size.h=110; applySize(tk);
addEdge(en.id,'raw',mo.id,'text'); addEdge(mi.id,'text',dc.id,'raw'); addEdge(dc.id,'text',tk.id,'text');
markWiresDirty();
});
preset('MQTT: Subscribe and Publish', function(){
clearAll();
const nt=addNode('note',40,20,{text:'MQTT over WebSocket (the browser cannot open mqtt:// itself: give the broker a WebSocket listener — Mosquitto `listener 9001` + `protocol websockets`, EMQX, HiveMQ, the Home Assistant add-on).\n'+
  'From the https page only wss:// works, from a local copy over http — ws:// too. Press Connect in both nodes.\n'+
  'MQTT Out publishes the LFO value to dsp/lfo; MQTT In subscribes to dsp/# and gives the payload as text (Ticker), as a number (the value output; for a JSON payload name the field, e.g. temp.value) and as records (rec — straight to the Map or Rec Log if the JSON has lat / lon).'});
nt.size.w=1000; nt.size.h=130; applySize(nt);
const l=addNode('lfo',40,200,{freq:.2,min:0,max:100,wave:'sine'});
const mo=addNode('mqttOut',300,200,{url:'ws://127.0.0.1:9001',topic:'dsp/lfo',template:'{v}'});
mo.size.h=140; applySize(mo);
const mi=addNode('mqttIn',40,400,{url:'ws://127.0.0.1:9001',topic:'dsp/#'});
mi.size.w=340; mi.size.h=190; applySize(mi);
const tk=addNode('ticker',440,400,{time:true});
tk.size.w=380; tk.size.h=110; applySize(tk);
const nv=addNode('numview',440,560,{});
addEdge(l.id,'out',mo.id,'value'); addEdge(mi.id,'text',tk.id,'text'); addEdge(mi.id,'value',nv.id,'in');
markWiresDirty();
});
preset('BLE: Heart Rate Monitor', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Web Bluetooth (Chrome / Edge / Opera on https or localhost; not Firefox / iOS). BLE GATT subscribes to the standard Heart Rate service (180D) of a chest strap or a watch in broadcast mode: press Connect, choose the device.\n'+
  'The value format «heart rate (bpm)» understands both the 8-bit and the 16-bit variant. For any other characteristic type its service and characteristic (a name, 16-bit 2A37 or a 128-bit UUID) and the format: battery %, temperature, uint / int / float, or hex only.'});
nt.size.w=1000; nt.size.h=110; applySize(nt);
const g=addNode('bleGatt',40,170,{svc:'heart_rate',chr:'heart_rate_measurement',fmt:'heart rate (bpm)',mode:'notify'});
g.size.w=340; g.size.h=190; applySize(g);
const nv=addNode('numview',440,170,{});
const tr=addNode('trend',440,300,{span:60,auto:true});
tr.size.w=460; tr.size.h=170; applySize(tr);
addEdge(g.id,'value',nv.id,'in'); addEdge(g.id,'value',tr.id,'in');
markWiresDirty();
});
preset('BLE: Find a Beacon by RSSI', function(){
clearAll();
const nt=addNode('note',40,20,{text:'The signal strength of one BLE device that advertises (a beacon, a tracker tag, a fitness band, a phone in discoverable mode): press Choose device. No connection is made, the device only has to broadcast.\n'+
  'Walk with the laptop or phone and watch the level grow when you get closer. Needs `watchAdvertisements` (Chrome 85+ on desktop and Android; on some versions enable chrome://flags/#enable-experimental-web-platform-features).\n'+
  'RSSI smoothing averages the jumpy readings; `present` drops to 0 after the silence set in «absent after»; `mfr` gives the manufacturer data (hex), `rec` a record per packet.'});
nt.size.w=1000; nt.size.h=130; applySize(nt);
const a=addNode('bleAdv',40,190,{avg:.5,lost:15});
a.size.w=340; a.size.h=160; applySize(a);
const nv=addNode('numview',440,190,{});
const tr=addNode('trend',440,320,{span:60,auto:true});
tr.size.w=460; tr.size.h=170; applySize(tr);
addEdge(a.id,'rssi',nv.id,'in'); addEdge(a.id,'rssi',tr.id,'in');
markWiresDirty();
});
preset('BLE: UART Terminal', function(){
clearAll();
const nt=addNode('note',40,20,{text:'A serial terminal over Bluetooth LE: Nordic UART Service (nRF, ESP32 with a NUS sketch, many BLE modules) or HM-10 (FFE0 / FFE1). The profile «custom» takes your own service and characteristics.\n'+
  'Lines from the device appear on `line` (Ticker); text from the Text Source goes out with the chosen line end, 20 bytes per write (raise it on devices with a big MTU).\n'+
  'Press Connect and choose the device.'});
nt.size.w=1000; nt.size.h=110; applySize(nt);
const b=addNode('bleUart',40,170,{profile:'Nordic UART',eol:'\\n'});
b.size.w=360; b.size.h=210; applySize(b);
const tk=addNode('ticker',460,170,{time:true});
tk.size.w=420; tk.size.h=140; applySize(tk);
const ts=addNode('textsrc',40,420,{});
addEdge(b.id,'line',tk.id,'text'); addEdge(ts.id,'text',b.id,'text');
markWiresDirty();
});
preset('Gamepad: Axes to Tone and Lamps', function(){
clearAll();
const nt=addNode('note',40,20,{text:'A gamepad, joystick, steering wheel or pedals as a controller (Gamepad API: Chrome, Edge, Firefox, Safari). The browser shows the device only after a button is pressed on it.\n'+
  'The left stick X sets the pitch of the oscillator (Math: −1…1 → 200…1000 Hz), the first two buttons light the lamps, the trend chart shows the axis. The `rumble` and `weak` inputs make the gamepad vibrate (a wire with 0…1, e.g. from a level meter or a lamp).\n'+
  'Axes and buttons are plain numbers: wire them to any parameter — the frequency of a receiver, a relay on Serial Out / MQTT Out, a tracker. The counts of axes and buttons are in the parameters.'});
nt.size.w=1000; nt.size.h=120; applySize(nt);
const g=addNode('gamepad',40,180,{axes:'4',btns:'4'});
g.size.w=300; g.size.h=200; applySize(g);
const m=addNode('nmath',400,180,{op:'sum',inputs:'1',k:400,ofs:600});
const os=addNode('osc',620,180,{amp:.3,wave:'sine'});
const dc=addNode('dac',860,180,{vol:.3});
const lp=addNode('lamps',400,340,{count:'2',labels:'b1,b2',colors:'amber,amber',hold:.1});
lp.size.w=200; lp.size.h=80; applySize(lp);
const tr=addNode('trend',620,340,{span:20,auto:false,lo:-1,hi:1});
tr.size.w=420; tr.size.h=140; applySize(tr);
addEdge(g.id,'a1',m.id,'in1'); addEdge(m.id,'out',os.id,'freq'); addEdge(os.id,'out',dc.id,'L'); addEdge(os.id,'out',dc.id,'R');
addEdge(g.id,'b1',lp.id,'in1'); addEdge(g.id,'b2',lp.id,'in2'); addEdge(g.id,'a1',tr.id,'in');
markWiresDirty();
});
preset('HID: Reports to Number and Log', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Any USB / Bluetooth HID device without a driver: foot pedals, remote controls, USB scales and sensors, barcode scanners, your own boards (Arduino Leonardo / Pro Micro, RP2040). WebHID: Chrome, Edge, Opera on https or localhost; keyboards and mice are blocked by the browser.\n'+
  'Press Connect and choose the device (vendor / product id narrow the list). Every input report appears as hex on `report` (the Ticker); the value output takes one field of the report: offset in the data, format (uint / int 8 / 16 / 32 bit, little or big endian, a single bit) and scale; the report id filters the value.\n'+
  'Find the field by watching which bytes change while you press or move something. The `send` input (hex) writes an output or a feature report: LEDs, modes, commands.'});
nt.size.w=1000; nt.size.h=130; applySize(nt);
const h=addNode('hid',40,190,{fmt:'uint8',off:0});
h.size.w=360; h.size.h=230; applySize(h);
const tk=addNode('ticker',460,190,{time:true});
tk.size.w=420; tk.size.h=140; applySize(tk);
const tr=addNode('trend',460,350,{span:30,auto:true});
tr.size.w=420; tr.size.h=140; applySize(tr);
addEdge(h.id,'report',tk.id,'text'); addEdge(h.id,'value',tr.id,'in');
markWiresDirty();
});
preset('NFC: Tag Log and Writer', function(){
clearAll();
const nt=addNode('note',40,20,{text:'NFC tags (NDEF): Web NFC works in Chrome on Android over https; desktop browsers do not support it. Press Scan, hold a tag to the back of the phone: the serial number goes to `serial`, the first text / URL / JSON record to `text`, every record to `rec` (Rec Log).\n'+
  'Write: type a text in the node (or wire a text to `write`), press Write and hold a blank or rewritable tag to the phone; a pulse on `go` does the same. The record type is text, URL or JSON.\n'+
  'A tag serial or its text can drive anything: publish it with MQTT Out, count visits with a Counter, log arrivals with timestamps.'});
nt.size.w=1000; nt.size.h=120; applySize(nt);
const nf=addNode('nfc',40,180,{wtext:'hello from the workbench',wtype:'text'});
nf.size.w=340; nf.size.h=230; applySize(nf);
const tk=addNode('ticker',440,180,{time:true});
tk.size.w=420; tk.size.h=120; applySize(tk);
const rl=addNode('recLog',440,320,{});
rl.size.w=420; rl.size.h=170; applySize(rl);
addEdge(nf.id,'serial',tk.id,'text'); addEdge(nf.id,'rec',rl.id,'rec');
markWiresDirty();
});
preset('Graph: Links from CSV', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Link graph from two tables. Links table `rows` → Graph `set`: one row = one edge (from, to[, weight[, label[, color]]]). Nodes table `rows` → Graph `nodes`: id, label, shape (dot, square, diamond, star, hexagon, box…), color, size — nodes without a row get the defaults. The wires carry the whole list, so a row deleted or edited in a table disappears or changes in the graph (only the difference is redrawn); a filter on a table limits the graph. Records on `rec` and CSV on `text` still add edges as they come. Click a node: its name goes to `sel`.'});
nt.size.w=1000; nt.size.h=100; applySize(nt);
const ts=addNode('textsrc',40,160,{text:'Demod,Squelch\nSquelch,Recorder\nDecoder,Map\nDecoder,Log'});
ts.size.w=300; ts.size.h=100; applySize(ts);
const tb=addNode('table',40,290,{list:'@patch',initial:false,
  data:'from,to,weight,label\nSDR,Filter,1,\nFilter,Demod,1,\nDemod,Decoder,2,audio\nDemod,Scope,1,\nDecoder,Log,1,'});
tb.size.w=300; tb.size.h=250; applySize(tb);
const tn=addNode('table',40,560,{list:'@patch',initial:false,
  data:'id,label,shape,color\nSDR,SDR,hexagon,#e0a040\nDecoder,Decoder,diamond,\nScope,Scope,square,\nLog,Log,box,'});
tn.size.w=300; tn.size.h=250; applySize(tn);
const g=addNode('graphview',380,160,{});
g.size.w=520; g.size.h=400; applySize(g);
addEdge(ts.id,'text',g.id,'text'); addEdge(tb.id,'rows',g.id,'set'); addEdge(tn.id,'rows',g.id,'nodes');
markWiresDirty();
});
preset('Chat: Text In and Out', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Chat: incoming text on `text` appears in the log, what you type (Enter / Send) leaves through `text` and a pulse on `go`. Here the Text Source plays the other side; what you type is shown in the Ticker.'});
nt.size.w=1000; nt.size.h=70; applySize(nt);
const ts=addNode('textsrc',40,130,{text:'CQ CQ DE R1ABC K',repeat:5});
ts.size.w=300; ts.size.h=100; applySize(ts);
const c=addNode('chat',380,130,{});
c.size.w=340; c.size.h=300; applySize(c);
const tk=addNode('ticker',760,130,{time:true});
tk.size.w=360; tk.size.h=140; applySize(tk);
addEdge(ts.id,'text',c.id,'text'); addEdge(c.id,'text',tk.id,'text');
markWiresDirty();
});
preset('Unknown Signal: Blind Analysis (Generator)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Reverse engineering a transmission without knowing its parameters. The generator (Unknown Signal) sends 2FSK with a hidden symbol rate,\n'+
  'a sync word, a convolutional code and a CRC, plus an echo, as from multipath. Every node of the chain prints what it found.\n'+
  'Baud Estimator finds the symbol rate (its wire sets the RRC filter and the slicer) → CMA Equalizer undoes the echo → FM discriminator → RRC → Symbol Slicer\n'+
  '→ Sync Word Hunter finds the sync word and the frame period and cuts frames → Conv Code Finder finds the polynomials (Viterbi decodes)\n'+
  '→ CRC Finder names the checksum → Block Viewer shows the message.\n'+
  'Change the generator: modulation, symbol rate, sync word, message length, CRC, code (also rate 1/3), echo. Without a code Conv Code Finder says so;\n'+
  'CRC Finder then takes the frames of Sync Word Hunter and tries extra bytes after the checksum. On a real signal use USB SDR iq instead of the generator.'});
nt.size.w=1100; nt.size.h=170; applySize(nt);
const gn=addNode('blindGen',40,240,{sr:'256000',off:20000,mod:'2FSK',baud:9600,dev:4800,word:'B38D2E5A',len:16,crc:'CRC-16/X-25',fec:'K=7 (171, 133)',gap:64,lvl:-20,noise:-50,echo:.35,echoDelay:.7,echoPhase:90});
gn.size.w=300; gn.size.h=420; applySize(gn);
const sp=addNode('iqSpec',40,700,{size:'8192'});
const sa=addNode('sa',380,240,{auto:true,floor:-110,top:0,split:.4});
sa.size.w=520; sa.size.h=300; applySize(sa);
const sh=addNode('iqShift',380,580,{offset:20000});
const dm=addNode('iqDecim',380,740,{M:'5'});
const be=addNode('blindBaud',640,580,{min:100,max:30000,avg:12,thr:10});
be.size.w=300; be.size.h=130; applySize(be);
const eq=addNode('blindEq',640,740,{taps:15,mu:.003});
const fd=addNode('fmDisc',940,580,{bw:0,dc:.2});
const rr=addNode('symRrc',940,740,{baud:9600,alpha:.5});
const sl=addNode('symSlicer',940,900,{baud:9600});
const sy=addNode('syncHunt',1240,240,{levels:'2',len:32,depth:16384,minHits:4,tol:1,flen:0,word:''});
sy.size.w=360; sy.size.h=190; applySize(sy);
const cv=addNode('convFind',1240,500,{rate:'auto',maxK:9,thr:.85,min:8,tail:true});
cv.size.w=360; cv.size.h=220; applySize(cv);
const cr=addNode('crcFind',1240,780,{min:6,tail:32,maxSkip:2,unknown:true});
cr.size.w=360; cr.size.h=240; applySize(cr);
const bv=addNode('blkview',1640,780,{fmt:'text',wrap:32});
bv.size.w=300; bv.size.h=200; applySize(bv);
addEdge(gn.id,'iq',sp.id,'in'); addEdge(sp.id,'spec',sa.id,'spec');
addEdge(gn.id,'iq',sh.id,'in'); addEdge(sh.id,'out',dm.id,'in');
addEdge(dm.id,'out',be.id,'in'); addEdge(dm.id,'out',eq.id,'in');
addEdge(eq.id,'out',fd.id,'in'); addEdge(fd.id,'out',rr.id,'in');
addEdge(be.id,'baud',rr.id,'baud'); addEdge(be.id,'baud',sl.id,'baud');
addEdge(rr.id,'out',sl.id,'in'); addEdge(sl.id,'out',sy.id,'in');
addEdge(sy.id,'blk',cv.id,'blk'); addEdge(cv.id,'blk',cr.id,'blk'); addEdge(cr.id,'blk',bv.id,'blk');
markWiresDirty();
});
preset('Logic Analyzer: UART Decode', function(){
clearAll();
const nt=addNode('note',40,20,{text:'Transmit Chars (ASCII 8N1, 2400 baud) sends a word every 5 s (a square LFO is the trigger). The Logic Analyzer digitises the wire (threshold + hysteresis),\n'+
  'shows it on a time axis with bubbles for the decoded bytes, and gives the bytes out: `byte` and `new` (a pulse per byte, here on a lamp), `text` (a line after a pause, here in the Ticker) and `rec` (a record per byte).\n'+
  'Trigger: falling edge, single shot: press Arm to catch the next transmission. Other decoders: SPI (clock, MOSI, MISO, CS) and I2C (SCL, SDA) — see the decoder channel settings.'});
nt.size.w=800; nt.size.h=100; applySize(nt);
const l=addNode('lfo',40,200,{freq:.2,min:0,max:1,wave:'sq'});
const tx=addNode('serialTx',260,200,{text:'HELLO',baud:2400,code:'ASCII 8N1',stop:'1',loop:false});
const la=addNode('logan',560,200,{count:'1',names:'TX',proto:'UART',a:1,baud:2400,trig:'falling',single:true,span:.03});
la.size.w=620; la.size.h=170; applySize(la);
const lp=addNode('lamps',1220,200,{count:'1',labels:'byte',colors:'amber',hold:.15});
lp.size.w=160; lp.size.h=80; applySize(lp);
const tk=addNode('ticker',1220,520,{time:true});
tk.size.w=360; tk.size.h=100; applySize(tk);
const nv=addNode('numview',1220,900,{});
addEdge(l.id,'out',tx.id,'go'); addEdge(tx.id,'bit',la.id,'ch1');
addEdge(la.id,'new',lp.id,'in1'); addEdge(la.id,'text',tk.id,'text'); addEdge(la.id,'byte',nv.id,'in');
markWiresDirty();
});
