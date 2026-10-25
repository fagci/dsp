"use strict";
/* Universal Decoder: один узел на ряд протоколов, выбор по подсказке или автоматически (ядро — udec-kernels.js) */
defIQ({ id:'udec', title:'Universal Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  kw:'decoder switch auto protocol hint sigid catalog ais pocsag ism acars router universal',
  ins:[{n:'in',t:'iq'},{n:'hint',t:'val'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'proto',t:'txt'},{n:'locked',t:'num'}],
  params:[{n:'mode',t:'select',opts:['auto','manual'],d:'auto',label:'auto: the hint input (decoder id, protocol or catalog kind from Signal ID / Signal Database / the catalog table) or, with no hint, all protocols listen and the first to decode stays; manual: the protocol below'},
          {n:'proto',t:'select',opts:UDEC_REG.map(r=>r.proto),d:UDEC_REG[0].proto,label:'protocol (manual)'},
          {n:'giveUp',t:'range',min:2000,max:60000,step:500,d:8000,log:true,label:'auto: a hinted decoder that stays silent this long, ms, is considered a wrong hint — all protocols listen again until the hint changes'},
          {n:'hold',t:'range',min:1000,max:60000,step:500,d:6000,log:true,label:'auto: back to the search after silence of, ms'}]},
  n=>{ const u=n.ui;
    if(!u || u.none || !u.counts) return 'no input';
    const c=Object.keys(u.counts).map(k=>k+' '+u.counts[k]).join(' · ');
    const head=({search:'searching: '+(u.act||[]).join(', ')+(u.hintBad? ' (the hint did not decode)' : ''), lock:'locked: '+u.proto, hint:'hint: '+u.proto, manual:'manual: '+u.proto})[u.st]+
      (c ? ' · '+c : '')+(u.ago!=null ? ' · last '+(u.ago/1000).toFixed(0)+' s ago' : '');
    return head+((u.recent||[]).length ? '\n'+u.recent.join('\n') : '\nno message yet'); });
