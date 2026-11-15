"use strict";
/* ============================ GPS L1 C/A: блоки ============================
   GPS: Test Sky (IQ) — IQ-источник «небо» на 1575.42 МГц по выдуманному созвездию: приёмник без антенны. Не излучать в эфир.
   GPS Receiver — IQ (RTL-SDR на 1575.42 МГц, файл или Test Sky) → поиск PRN → слежение → эфемериды → позиция: rec для карты,
   NMEA GGA на text, числа lat/lon/alt/nsat/pdop. Ядра — в gps-kernels.js / gps-iq-kernels.js (проверка: tools/test-gps*.mjs). */

defIQ({ id:'gpsSky', title:'GPS: Test Sky (IQ)', cat:'IQ', kw:'gps gnss navigation satellite l1 c/a 1575 test signal generator transmitter loopback synthetic sky',
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'}], outs:[{n:'iq',t:'iq'},{n:'fc',t:'num'},{n:'rec',t:'rec'}],
  pack:['sr cycle','lat lon alt','nsat cn0'],
  params:[{n:'sr',t:'select',opts:GPS_SR_OPTS,d:'2048000',label:'sample rate (RTL-SDR: 2.048 MS/s)',short:'rate'},
          {n:'lat',t:'num',d:55.03,label:'receiver latitude (the sky is drawn for it)',short:'lat'},
          {n:'lon',t:'num',d:82.92,label:'receiver longitude',short:'lon'},
          {n:'alt',t:'num',d:150,label:'receiver height, m',short:'alt'},
          {n:'nsat',t:'range',min:4,max:10,step:1,d:6,label:'satellites (the highest above the horizon)',short:'sats'},
          {n:'cn0',t:'range',min:30,max:55,step:1,d:46,label:'signal C/N0, dB·Hz (open sky ≈ 45–50; below ~38 the search fails)',short:'C/N0'},
          {n:'cycle',t:'select',opts:['fast (subframes 1–3)','full (1–5, ephemeris in up to 48 s)'],d:'fast (subframes 1–3)',label:'navigation message: only the ephemeris subframes (fix in ~25 s) or the full 5-subframe frame',short:'frame'}]},
  n=>{ const u=n.ui; if(!u) return 'no data'; return u.err ? u.err : u.t.toFixed(0)+' s · '+u.sats; });

defIQ({ id:'gpsRx', title:'GPS Receiver (L1 C/A)', cat:'Decoders', tall:true, resize:true, w:460, kw:'gps gnss navigation satellite l1 c/a 1575 position fix nmea pseudorange ephemeris rtl-sdr',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'nsat',t:'num'},{n:'pdop',t:'num'}],
  pack:['on maxSat','thr avg maxd'],
  params:[{n:'on',t:'check',d:true,label:'receive (off — channels are dropped)',short:'on'},
          {n:'maxSat',t:'range',min:4,max:12,step:1,d:8,label:'channels: satellites tracked at once (CPU load grows with them)',short:'chans'},
          {n:'thr',t:'range',min:4,max:12,step:.5,d:5,label:'search threshold: correlation peak over the noise floor (lower finds weaker ones, but ghosts appear)',short:'thr'},
          {n:'avg',t:'range',min:1,max:60,step:1,d:5,label:'average the position over the last N one-second fixes',short:'avg'},
          {n:'maxd',t:'range',min:1,max:10,step:1,d:5,label:'Doppler search ±, kHz (a still receiver: ±5; add your SDR\'s clock error × 1575 Hz/ppm)',short:'±kHz'}]},
  n=>{ const u=n.ui; if(!u) return 'no input'; if(u.err) return u.err;
    const f=u.fix, pad=(v,w)=>String(v).padStart(w);
    let s=f ? 'FIX '+f.lat.toFixed(5)+' '+f.lon.toFixed(5)+' · '+f.h.toFixed(0)+' m · '+f.n+' sats · PDOP '+f.pdop.toFixed(1)+' · resid. '+f.rms.toFixed(1)+' m'+(f.k>1 ? ' · avg of '+f.k : '')
            : 'no fix yet'+(u.reason ? ' — '+u.reason : '');
    s+='\nPRN  Doppler  lock  frames  eph  tracked\n';
    for(const r of u.rows) s+=pad(r.prn,3)+' '+pad((r.dopp>=0?'+':'')+r.dopp.toFixed(0)+' Hz',9)+' '+pad(r.lock.toFixed(2),5)+' '+pad(r.frames,6)+'  '+(r.eph ? ' ✓ ' : ' · ')+'  '+r.sec.toFixed(0)+' s\n';
    s+=(u.rows.length ? '' : 'no satellites yet\n')+'searching PRN '+(u.scan%32+1)+' · '+u.nacq+' tries · '+(u.fs/1e6).toFixed(3)+' MS/s';
    return s; });
