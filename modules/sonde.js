"use strict";
/* ============================ Радиозонды ============================
   RS41 Radiosonde (IQ-блок, ядро в sonde-kernels.js): IQ (или уже ЧМ-звук с приёмника) → кадры →
   серийный номер, позиция, высота, скорость, подъём, температура, влажность → записи для карты. */

defIQ({ id:'rs41Rx', title:'RS41 Radiosonde', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.frames+' frames'+(u.bad ? ', '+u.bad+' bad' : '')+
      (u.fixed ? ' · RS fixed '+u.fixed+' bytes' : '');
    const rows=u.sondes.map(z=>z.id+' #'+z.frame+
      (z.lat!=null ? '\n  '+z.lat.toFixed(5)+', '+z.lon.toFixed(5)+' · '+Math.round(z.alt)+' m · '+(z.climb>=0?'↑':'↓')+Math.abs(z.climb).toFixed(1)+' m/s · '+
        z.vh.toFixed(1)+' m/s → '+Math.round(z.heading)+'° · '+z.sats+' sats' : '\n  no GPS fix')+
      '\n  '+(z.temp!=null ? z.temp.toFixed(1)+' °C · RH '+Math.round(z.rh??0)+'% · ' : 'T: collecting calibration · ')+z.batt+' V'+
      (z.time ? ' · '+new Date(z.time).toISOString().slice(11,19)+' UTC' : ''));
    return head+(rows.length ? '\n'+rows.join('\n') : '\nno sonde yet'); });
