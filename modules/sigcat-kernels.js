"use strict";
/* ============================ Каталог сигналов (tune + decode): ядро ============================
   Тип сигнала → на что настроить приёмник и чем декодировать. Одна запись — один канал: частота, режим демодулятора USB SDR,
   полоса канала, частота дискретизации, декодер (id блока) и ветка Decoder Switch (1…4; 0 — автоперебор).
   Строки уходят в таблицу как band plan «Protocols/Signal catalog (tune + decode)»: порты колонок tune/demod/bw/sr/branch
   идут проводами на USB SDR (freq, demod, bw, sr) и на Decoder Switch (sel).
   Частоты — типовые (≈): точные зависят от региона, у многих протоколов несколько каналов — это отдельные строки. */
const SIGCAT_BRANCH={adsb:1, ais:2, pocsag:3, ism:4};        // ветки демо-пресета «Signal catalog: pick a type, the SDR tunes and decodes»
const SIGCAT=(()=>{
  const A=(kind,name,f,bw,sr,decoder,branch,note,demod)=>({kind,name,f,bw,sr,decoder,branch,note,demod:demod||'IQ'});
  const MHz=x=>Math.round(x*1e6);
  return [
    A('adsb','ADS-B 1090',MHz(1090),2e6,2.4e6,'adsbDemod → adsbDecode',SIGCAT_BRANCH.adsb,'Mode S extended squitter, самолёты на карту; нужна частота дискретизации 2.4 МС/с, антенна 1090 МГц'),
    A('ais','AIS A',MHz(161.975),25e3,1.024e6,'aisRx',SIGCAT_BRANCH.ais,'суда, GMSK 9600 Bd, канал 87B; AIS B — 162.025 МГц'),
    A('ais','AIS B',MHz(162.025),25e3,1.024e6,'aisRx',SIGCAT_BRANCH.ais,'суда, GMSK 9600 Bd, канал 88B'),
    A('pocsag','POCSAG 466.075',MHz(466.075),25e3,1.024e6,'pocsagRx',SIGCAT_BRANCH.pocsag,'пейджеры, FSK 512/1200/2400 Bd; Европа, частоты по оператору'),
    A('pocsag','POCSAG 466.230',MHz(466.23),25e3,1.024e6,'pocsagRx',SIGCAT_BRANCH.pocsag,'пейджеры, FSK 512/1200/2400 Bd; Европа, частоты по оператору'),
    A('pocsag','POCSAG 929.6125',MHz(929.6125),25e3,1.024e6,'pocsagRx',SIGCAT_BRANCH.pocsag,'пейджеры, FSK 512/1200/2400 Bd; США, частоты по оператору'),
    A('ism','ISM 433.92',MHz(433.92),250e3,1.024e6,'ismRx',SIGCAT_BRANCH.ism,'датчики погоды, брелоки, звонки: OOK/FSK; в Европе, России, Азии'),
    A('ism','ISM 315',MHz(315),250e3,1.024e6,'ismRx',SIGCAT_BRANCH.ism,'брелоки и датчики США/Азии'),
    A('ism','ISM 868.3',MHz(868.3),250e3,1.024e6,'ismRx',SIGCAT_BRANCH.ism,'датчики и счётчики Европы (Oregon v3, Fine Offset, M-Bus)'),
    A('ism','ISM 915',MHz(915),250e3,1.024e6,'ismRx',SIGCAT_BRANCH.ism,'датчики и счётчики США / Австралии'),
    A('acars','ACARS 131.550',MHz(131.55),25e3,1.024e6,'acarsRx',0,'авиа-сообщения, AM-MSK 2400 Bd; основная частота США / мира'),
    A('acars','ACARS 131.725',MHz(131.725),25e3,1.024e6,'acarsRx',0,'авиа-сообщения, AM-MSK 2400 Bd; Европа'),
    A('acars','ACARS 130.025',MHz(130.025),25e3,1.024e6,'acarsRx',0,'авиа-сообщения, AM-MSK 2400 Bd; США'),
    A('same','NOAA Weather 162.550',MHz(162.55),12.5e3,1.024e6,'sameRx',0,'предупреждения SAME/EAS (США); каналы 162.400–162.550 МГц','NFM'),
    A('lora','Meshtastic EU 869.525',MHz(869.525),250e3,1.024e6,'meshAir',0,'LoRa LongFast, ширина 250 кГц; Европа'),
    A('lora','Meshtastic US 906.875',MHz(906.875),250e3,1.024e6,'meshAir',0,'LoRa LongFast, ширина 250 кГц; США'),
  ];
})();

// имя записи Signal Database (sigdb-kernels.js) → вид записей каталога; по нему sigDb предлагает, чем декодировать
const SIGCAT_OF={'ADS-B / Mode S':'adsb','AIS':'ais','POCSAG':'pocsag','ISM 433 OOK/ASK':'ism','ISM FSK (датчики)':'ism','ACARS (VHF)':'acars',
  'NOAA Weather Radio':'same','LoRa 250 / 500 кГц':'lora'};
// запись каталога вида kind: ближайшая к измеренной частоте freq (Гц; 0 — первая); null, если вида нет
function sigcatPick(kind,freq){
  let best=null, bd=Infinity;
  for(const e of SIGCAT){ if(e.kind!==kind) continue; const d=freq>0 ? Math.abs(e.f-freq) : 0; if(d<bd){ bd=d; best=e; } }
  return best;
}

// строки band plan: [lo, hi, label, step, color, note, kind, ext] — ext добавляет колонки таблицы (demod, bw, sr, branch, decoder)
function sigcatRows(list){
  return (list||SIGCAT).map(e=>[e.f,e.f,e.name,25e3,'',e.note,e.kind,{demod:e.demod,bw:e.bw,sr:e.sr,branch:e.branch,decoder:e.decoder}]);
}
