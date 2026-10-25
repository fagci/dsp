"use strict";
/* Universal Decoder: один узел на ряд протоколов, выбор по подсказке или автоматически (ядро — udec-kernels.js) */
defIQ({ id:'udec', title:'Universal Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  kw:'decoder switch auto protocol hint sigid catalog ais pocsag ism acars router universal',
  ins:[{n:'in',t:'iq'},{n:'hint',t:'val'},{n:'sigs',t:'bands'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'proto',t:'txt'},{n:'locked',t:'num'},{n:'count',t:'num'}],
  params:[{n:'mode',t:'select',opts:['auto','manual'],d:'auto',label:'auto: the hint input (decoder id, protocol or catalog kind from Signal ID / Signal Database / the catalog table) or, with no hint, all protocols listen and the first to decode stays; manual: the protocol below'},
          {n:'proto',t:'select',opts:UDEC_REG.map(r=>r.proto),d:UDEC_REG[0].proto,label:'protocol (manual)'},
          {n:'giveUp',t:'range',min:2000,max:60000,step:500,d:8000,log:true,label:'auto: a hinted decoder that stays silent this long, ms, is considered a wrong hint — all protocols listen again until the hint changes'},
          {n:'maxCh',t:'range',min:1,max:8,step:1,d:4,label:'several channels: how many signals are followed at once (the sigs input — marks of Signal Type Identifier: each signal gets its own shift, decimation and decoder choice)'},
          {n:'chHold',t:'range',min:1000,max:60000,step:500,d:8000,log:true,label:'several channels: drop a channel after its signal is gone for, ms'},
          {n:'rlat',t:'num',d:0,label:'ADS-B: receiver latitude (surface positions and the distance filter)'},
          {n:'rlon',t:'num',d:0,label:'ADS-B: receiver longitude'},
          {n:'hold',t:'range',min:1000,max:60000,step:500,d:6000,log:true,label:'auto: back to the search after silence of, ms'}]},
  n=>{ const u=n.ui;
    if(u && u.multi && !u.none){
      const f=h=>(h/1e6).toFixed(4);
      return u.rows.length ? u.rows.map(r=>'ch'+r.ch+' '+f(r.f)+' MHz · '+(r.proto || (r.st==='search' ? 'searching' : r.st))+' · '+Object.keys(r.counts).map(k=>k+' '+r.counts[k]).join(' ')+(r.ago!=null ? ' · '+(r.ago/1000).toFixed(0)+' s ago' : '')).join('\n')+
        ((u.recent||[]).length ? '\n'+u.recent.join('\n') : '') : 'no signals marked yet';
    }
    if(!u || u.none || !u.counts) return 'no input';
    const c=Object.keys(u.counts).map(k=>k+' '+u.counts[k]).join(' · ');
    const head=({search:'searching: '+(u.act||[]).join(', ')+(u.hintBad? ' (the hint did not decode)' : ''), lock:'locked: '+u.proto, hint:'hint: '+u.proto, manual:'manual: '+u.proto})[u.st]+
      (c ? ' · '+c : '')+(u.ago!=null ? ' · last '+(u.ago/1000).toFixed(0)+' s ago' : '');
    return head+(u.info ? '\n'+u.info : '')+((u.recent||[]).length ? '\n'+u.recent.join('\n') : '\nno message yet'); });
