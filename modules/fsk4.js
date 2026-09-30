"use strict";
/* ============================ 4FSK Digital Voice ============================
   Универсальный приёмник 4FSK-протоколов (ядро в fsk4-kernels.js, протоколы — плагины): IQ → дискриминатор → RRC → синхрослова.
   Один протокол или все сразу: канал (скорость, α) общий, протокол определяется по синхрословам. Записи — на `rec`, сырые кадры
   вокодера (AMBE / IMBE / …) — на `voice`. */

defIQ({ id:'fskRx', title:'4FSK Digital Voice', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}],
  params:[{n:'proto',t:'select',opts:['auto',...FSK4.order],d:'auto',label:'protocol (auto: every one, picked by sync words)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const a=u.active && u.protos[u.active], ids=Object.keys(u.protos);
    if(a) return a.text;
    const recent=ids.flatMap(id=>u.protos[id].recent||[]).slice(-6);
    return (u.fs/1000).toFixed(1)+' kS/s · searching sync ('+ids.join(', ')+')'+(recent.length ? '\n'+recent.join('\n') : ''); });
