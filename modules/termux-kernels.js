"use strict";
/* Termux: записи моста tools/termux/bridge.mjs → значения выходов узла. Без DOM — проверяется в tools/test-termux.mjs */

const TERMUX_SUBS=['gps','battery','accel','gyro','mag','light','pressure','wifi','cell'];

// какие источники просить у моста по чекбоксам узла
function termuxSub(p){ return TERMUX_SUBS.filter(k=>p[k]); }

// сообщение подписки: источники и частота датчиков (hz — только приложению DSP, Termux-мост её не знает)
function termuxSubMsg(p){
  const m={sub:termuxSub(p)}, hz=+p.hz;
  if(hz>0) m.hz=hz;
  return m;
}

// адрес камеры приложения DSP на том же порту, что и WebSocket (→ вход url узла IP Camera); null — камера выключена
function termuxCamUrl(url,p){
  if(!p.cam || p.cam==='off') return null;
  let u; try{ u=new URL(String(url||'').trim()); }catch(e){ return null; }
  if(u.protocol!=='ws:' && u.protocol!=='wss:') return null;
  const q=new URLSearchParams({cam:p.cam,w:p.camw,fps:p.camfps,q:p.camq}), t=u.searchParams.get('token');
  if(t) q.set('token',t);
  return (u.protocol==='wss:' ? 'https:' : 'http:')+'//'+u.host+'/camera.mjpg?'+q;
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
    case 'sensor': {
      const k={accel:['ax','ay','az'], gyro:['gx','gy','gz'], mag:['mx','my','mz']}[r.sensor];
      if(k){ set(k[0],r.x); set(k[1],r.y); set(k[2],r.z); }
      else if(r.sensor==='light') set('light',r.x);
      else if(r.sensor==='pressure') set('press',r.x);
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
    case 'wifi': return 'wifi '+r.bssid+' '+r.rssi+' dBm '+(r.ssid||'');
    case 'cell': return 'cell '+(r.type||'')+(r.cid!=null ? ' cid '+r.cid : '');
    default: return r.src+' '+(r.msg||'');
  }
}
