"use strict";
/* Termux: записи моста tools/termux/bridge.mjs → значения выходов узла. Без DOM — проверяется в tools/test-termux.mjs */

const TERMUX_SUBS=['gps','battery','accel','gyro','mag','light','pressure','gravity','linear','rotation','gamerot','georot','accelraw','gyroraw','magraw','proximity','ambtemp','humidity','steps','step','devorient','sigmotion','stationary','motion','heading','hinge','wifi','cell','ble','bt','gnss','gnssraw','nmea','mic','pkt','power','ext','activity','pickup','wakegest','glance','tilt','offbody'];

// какие источники просить у моста по чекбоксам узла
function termuxSub(p){ return TERMUX_SUBS.filter(k=>p[k]); }

// сообщение подписки: источники и частота датчиков (hz — только приложению DSP, Termux-мост её не знает)
function termuxSubMsg(p){
  const m={sub:termuxSub(p)}, hz=+p.hz;
  if(hz>0) m.hz=hz;
  if(+p.wifiEvery>0 && p.wifi) m.wifiEvery=+p.wifiEvery;
  if(+p.cellEvery>0 && p.cell) m.cellEvery=+p.cellEvery;
  if(p.ble && typeof plScanOpts==='function'){ const bo=plScanOpts(p); if(bo) m.ble=bo; }
  if(+p.micHz>0 && p.mic) m.micHz=+p.micHz;
  if(p.mic && p.micSrc && p.micSrc!=='auto') m.micSrc=String(p.micSrc);          // источник: unprocessed / mic / camcorder / … (voice_call, downlink, uplink, submix — с root)
  if(p.mic && p.micDev && p.micDev!=='auto') m.micDev=String(p.micDev);
  if(p.mic && p.micCh==='stereo') m.micCh='stereo';                                 // два микрофона одним AudioRecord: L и R из одного кадра, без сдвига
  if(p.mic && p.micLow) m.micLow=true;                                              // порции по 10 мс и немедленная отправка моста          // устройство: usb / wired / bluetooth / builtin
  if(p.pkt){ m.iface=String(p.iface||'any').trim(); m.filter=String(p.filter||'').trim(); m.snap=+p.snap||256; }
  return m;
}

// Запас сглаживания микрофона на странице, с: обычный 250 мс (неровный приход порций); в режиме низкой задержки — micLag мс (20…300, по умолчанию 60).
// Реальный запас не меньше трёх интервалов между порциями (ssProcess, sources.js), так что при порциях по 10 мс пол — 30 мс.
function termuxMicLag(p){ return p && p.micLow ? Math.min(300,Math.max(20,+p.micLag||60))/1000 : .25; }

// кватернион Android (x,y,z,w) → азимут, тангаж, крен в градусах (как SensorManager.getOrientation)
function termuxEuler(r){
  const {x,y,z,w}=r;
  if(![x,y,z,w].every(Number.isFinite)) return null;
  const r1=2*(x*y-z*w), r4=1-2*(x*x+z*z), r6=2*(x*z-y*w), r7=2*(y*z+x*w), r8=1-2*(x*x+y*y), d=180/Math.PI;
  return [Math.atan2(r1,r4)*d, Math.asin(Math.max(-1,Math.min(1,-r7)))*d, Math.atan2(-r6,r8)*d];
}

// Timing Advance обслуживающей соты → расстояние до станции (поля dist, distSigma, м — их понимает Source Locator как замер-расстояние).
// LTE: шаг 16·Ts ≈ 78,12 м (расстояние от ta·78 до (ta+1)·78 — берём середину), GSM: шаг 553,5 м. Погрешность — шаг плюс многолучёвость.
function termuxTaDist(r){
  if(r.ta==null || r.ta==='') return {};
  const ta=+r.ta; if(!isFinite(ta) || ta<0) return {};
  if(r.type==='LTE' && ta<=1282) return {dist:Math.round((ta+.5)*78.12*10)/10, distSigma:50};
  if(r.type==='GSM' && ta<=63) return {dist:Math.round((ta+.5)*553.5), distSigma:250};
  return {};
}

// Единый ключ устройства для Table / Source Locator: dev (тип + адрес / id соты), name, rssi (у соты — RSRP, иначе dBm)
function termuxDev(r){
  if(!r) return null;
  const num=v=>typeof v==='number' && isFinite(v);
  switch(r.src){
    case 'wifi': return r.bssid ? {dev:'wifi:'+r.bssid, name:r.ssid||r.bssid} : null;
    case 'ble': {
      if(!r.addr) return null;
      const mf=r.mfr && typeof r.mfr==='object' ? Object.keys(r.mfr) : [];
      return {dev:'ble:'+r.addr, name:r.name||r.addr, ...(mf.length ? {mfrId:mf} : {})};   // mfrId — id компаний массивом, для правил Rec → Entities
    }
    case 'bt': return r.addr ? {dev:'bt:'+r.addr, name:r.name||r.addr} : null;
    case 'cell': {
      const id=r.cid ?? r.bid, plmn=r.mcc!=null ? r.mcc+'-'+r.mnc : '';
      if(id==null && r.pci==null) return null;
      const rssi=num(r.rsrp) ? r.rsrp : num(r.dbm) ? r.dbm : null;
      return {dev:'cell:'+(r.type||'')+':'+plmn+':'+(id!=null ? id : 'p'+r.pci), name:(r.type||'cell')+' '+plmn+' '+(id!=null ? id : 'pci '+r.pci)+(r.reg ? ' *' : ''), ...(r.rssi==null && rssi!=null ? {rssi} : {}), ...termuxTaDist(r)};
    }
  }
  return null;
}

// Прореживание замеров одного устройства: не чаще every с и не ближе move м от прошлого. st — Map dev → {t,lat,lon}
function termuxThin(st,r,now,every,move){
  if(!(every>0) && !(move>0)) return true;
  const L=st.get(r.dev);
  if(L){
    if(every>0 && now-L.t<every*1000) return false;
    if(move>0 && typeof r.lat==='number' && typeof L.lat==='number'){
      const dy=(r.lat-L.lat)*111320, dx=(r.lon-L.lon)*111320*Math.cos(r.lat*Math.PI/180);
      if(Math.hypot(dx,dy)<move) return false;
    }
  }
  st.set(r.dev,{t:now,lat:r.lat,lon:r.lon});
  if(st.size>20000) st.delete(st.keys().next().value);
  return true;
}

// точка замера для карты
const TERMUX_COL={wifi:'#4aa3ff', ble:'#b07cff', bt:'#3fd0c0', cell:'#ffa040'};
function termuxPoint(r,id){
  return {id, lat:r.lat, lon:r.lon, icon:'dot', size:3, track:0, color:TERMUX_COL[r.src]||'#aaaaaa', label:r.rssi+' dBm',
          kind:r.src, dev:r.dev, name:r.name, rssi:r.rssi};
}

// запись mic: PCM 16 бит little-endian в base64 → Float32Array [-1,1)
// число каналов выхода микрофона узла: 1 (mono) или 2 (stereo → выходы mic и micB)
function termuxMicK(p){ return p && p.micCh==='stereo' ? 2 : 1; }

function termuxPcm(r){
  if(!r || typeof r.pcm!=='string') return null;
  let bin; try{ bin=atob(r.pcm); }catch(e){ return null; }
  const n=bin.length>>1, o=new Float32Array(n);
  for(let i=0;i<n;i++){ let v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8); if(v&0x8000) v-=0x10000; o[i]=v/32768; }
  return o;
}

// нагрузка самого моста: процессорное время процесса (мс, растёт) → доля ядра между двумя записями power
function termuxCpu(o,r){
  if(typeof r.cpu!=='number') return;
  const t=typeof r.t==='number' ? r.t : Date.now();
  if(o._cpu0!=null && t>o._cpu0t){ const v=(r.cpu-o._cpu0)/(t-o._cpu0t)*100; if(isFinite(v) && v>=0) o.cpupct=v; }
  o._cpu0=r.cpu; o._cpu0t=t;
}

// запись моста → o (последние значения по выходам)
function termuxApply(o,r){
  if(!r || typeof r!=='object') return;
  const set=(k,v)=>{ if(typeof v==='number' && isFinite(v)) o[k]=v; };
  switch(r.src){
    case 'gps': set('lat',r.lat); set('lon',r.lon); set('alt',r.alt); set('acc',r.acc); set('speed',r.speed); set('hdg',r.bearing); break;
    case 'battery':
      set('batt',r.pct); set('temp',r.temp);
      if(r.status) o.charging=/^(CHARGING|FULL)$/i.test(r.status) ? 1 : 0;
      break;
    case 'power': set('therm',r.thermal); set('saver',r.saver); set('thr',r.throttle); set('batt',r.pct); o.charging=r.charging ? 1 : 0; set('wake',r.wake); set('nclients',r.clients); if(typeof r.held==='string') o.held=r.held; termuxCpu(o,r); break;
    case 'ext': set('extv',r.value); break;
    case 'activity': {                       // состояние из датчиков + экран; историю (hist) в «последнее значение» не берём
      if(r.hist) break;
      const a={still:0,moving:1,walking:2}[r.state]; if(a!=null) o.act=a;
      set('cadence',r.cadence); set('locked',r.locked); set('screen',r.screen); set('steps',r.steps);
      break;
    }
    case 'cell': if(r.reg==1 || r.reg===true){ set('cdbm',r.dbm); set('crsrp',r.rsrp); set('crsrq',r.rsrq); set('csinr',r.sinr); } break;
    case 'mic': set('micdb',r.rms); break;
    case 'gnss': if(r.kind==='fix'){ set('nsat',r.n); set('nused',r.used); set('cn0',r.cn0); } break;
    case 'sensor': {
      const k={accel:['ax','ay','az'], gyro:['gx','gy','gz'], mag:['mx','my','mz']}[r.sensor];
      if(k){ set(k[0],r.x); set(k[1],r.y); set(k[2],r.z); }
      else if(r.sensor==='light') set('light',r.x);
      else if(r.sensor==='pressure') set('press',r.x);
      else if(r.sensor==='proximity') set('prox',r.x);
      else if(r.sensor==='ambtemp') set('atemp',r.x);
      else if(r.sensor==='humidity') set('humid',r.x);
      else if(r.sensor==='steps') set('steps',r.x);
      else if(r.sensor==='heading') set('heading',r.x);
      else if(r.sensor==='devorient') set('orient',r.x);
      else if(r.sensor==='pickup') o.pick=(o.pick||0)+1;
      else if(r.sensor==='wakegest') o.wakeg=(o.wakeg||0)+1;
      else if(r.sensor==='glance') o.glanc=(o.glanc||0)+1;
      else if(r.sensor==='tilt') o.tiltc=(o.tiltc||0)+1;
      else if(r.sensor==='offbody') set('offb',r.x);
      else if(r.sensor==='stationary') o.still=1;
      else if(r.sensor==='motion') o.still=0;
      else if(r.sensor==='sigmotion') o.sigm=(o.sigm||0)+1;
      else if(r.sensor==='hinge') set('hinge',r.x);
      else if(r.sensor==='rotation'){ const e=termuxEuler(r); if(e){ o.yaw=e[0]; o.pitch=e[1]; o.roll=e[2]; } }
      break;
    }
  }
}

// короткая строка записи для readout
function termuxLine(r){
  const f=(v,d)=>typeof v==='number' ? v.toFixed(d) : '—';
  switch(r.src){
    case 'gps': return 'gps '+f(r.lat,5)+', '+f(r.lon,5)+(r.acc!=null ? ' ±'+f(r.acc,0)+' m' : '');
    case 'battery': return 'battery '+r.pct+'% '+(r.status||'');
    case 'sensor': return r.sensor+' '+[r.x,r.y,r.z].filter(v=>v!=null).map(v=>f(v,2)).join(' ');
    case 'cell': return 'cell '+(r.type||'')+(r.reg ? ' *' : '')+' '+(r.mcc!=null ? r.mcc+'-'+r.mnc+' ' : '')+'cid '+(r.cid ?? '—')+(r.pci!=null ? ' pci '+r.pci : '')+(r.dbm!=null ? ' '+r.dbm+' dBm' : '');
    case 'pkt': return 'pkt '+r.iface+' '+(r.ip ? r.ip+(r.sport ? ':'+r.sport : '')+' → '+r.dip+(r.dport ? ':'+r.dport : '') : (r.smac||'')+' → '+(r.dmac||''))+' '+r.len+' B';
    case 'power': return 'power '+r.pct+'%'+(r.charging ? ' charging' : '')+(r.saver ? ' saver' : '')+' thermal '+r.thermal+' · polling ÷'+(r.throttle||1)+(r.clients!=null ? ' · '+r.clients+' client(s)' : '')+(r.wake ? ' · wake lock' : '')+(r.held ? ' · holding '+r.held : '');
    case 'activity': return 'activity '+r.state+(r.locked ? ' (locked)' : '')+(r.cadence ? ' '+r.cadence+' steps/min' : '')+(r.hist ? ' [log]' : '');
    case 'ext': return 'ext '+(r.name||'')+' '+(r.value!=null ? r.value : (r.text||''));
    case 'mic': return 'mic '+f(r.rms,0)+' dBFS';
    case 'wifi': return 'wifi '+r.bssid+' '+r.rssi+' dBm'+(r.ch ? ' ch '+r.ch : '')+' '+(r.ssid||'');
    case 'wificonn': return 'connected '+(r.ssid||r.bssid)+' '+r.rssi+' dBm '+(r.speed!=null ? r.speed+' Mbit/s' : '');
    case 'ble': return 'ble '+r.addr+' '+r.rssi+' dBm '+(r.name||'');
    case 'bt': return 'bt '+r.addr+' '+(r.rssi!=null ? r.rssi+' dBm ' : '')+(r.name||r.major||'');
    case 'gnss': return r.kind==='sat' ? 'gnss '+r.con+' '+r.svid+' '+f(r.cn0,0)+' dB-Hz el '+f(r.el,0)+(r.used ? ' used' : '') : 'gnss '+r.used+'/'+r.n+' sats, '+f(r.cn0,0)+' dB-Hz';
    case 'gnssraw': return r.kind==='meas' ? 'raw '+r.con+' '+r.svid+' '+f(r.cn0,0)+' dB-Hz' : 'raw clock';
    case 'nmea': return r.line||'';
    default: return r.src+' '+(r.msg||'');
  }
}
