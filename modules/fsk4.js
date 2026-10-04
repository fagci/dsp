"use strict";
/* ============================ 4FSK Digital Voice ============================
   Универсальный приёмник 4FSK-протоколов (ядро в fsk4-kernels.js, протоколы — плагины): IQ → дискриминатор → RRC → синхрослова.
   Один протокол или все сразу: канал (скорость, α) общий, протокол определяется по синхрословам. Записи — на `rec`, сырые кадры
   вокодера (AMBE / IMBE / …) — на `voice`. */

defIQ({ id:'fskRx', title:'Digital Voice Decoder', kw:'4fsk dmr p25 nxdn ysf m17 d-star dstar dpmr motorola mototrbo', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}],
  params:[{n:'proto',t:'select',opts:['auto',...FSK4.order],d:'auto',label:'protocol (auto: every one, picked by sync words)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const a=u.active && u.protos[u.active], ids=Object.keys(u.protos);
    if(a) return a.text;
    const recent=ids.flatMap(id=>u.protos[id].recent||[]).slice(-6);
    return (u.fs/1000).toFixed(1)+' kS/s · searching sync ('+ids.join(', ')+')'+(recent.length ? '\n'+recent.join('\n') : ''); });

// кадры M17 из Symbol Sync Search (blk) → записи и сырой Codec 2; разбор тот же, что у Digital Voice Decoder с proto = m17
defIQ({ id:'m17Parse', title:'M17 Frame Parser', cat:'Decoders', kw:'m17 lsf callsign codec2 frames', tall:true, resize:true, w:480,
  ins:[{n:'blk',t:'blk'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>n.ui ? n.ui.text : 'no input');
