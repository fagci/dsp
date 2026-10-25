"use strict";
/* ============================ Каталог сигналов (tune + decode): ядро ============================
   Тип сигнала → на что настроить приёмник и чем декодировать. Одна запись — один канал: частота, режим демодулятора USB SDR,
   полоса канала, частота дискретизации, декодер (id блока) и ветка Decoder Switch (1…4; 0 — автоперебор).
   Строки уходят в таблицу как band plan «Protocols/Signal catalog (tune + decode)»: порты колонок tune/demod/bw/sr/branch
   идут проводами на USB SDR (freq, demod, bw, sr) и на Decoder Switch (sel).
   Частоты — типовые (≈): точные зависят от региона, у многих протоколов несколько каналов — это отдельные строки. */
const SIGCAT_BRANCH={adsb:1, ais:2, pocsag:3, ism:4};        // ветки демо-пресета «Signal catalog: pick a type, the SDR tunes and decodes»
const SIGCAT=(()=>{
  const A=(kind,name,f,bw,sr,decoder,branch,note,demod,hint)=>({kind,name,f,bw,sr,decoder,branch,note,demod:demod||'IQ',hint:hint||''});   // hint — подсказка для Universal Decoder, если id блока неоднозначен (две ступени аналогового ТВ)
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
    A('vdl2','VDL Mode 2 136.975',MHz(136.975),25e3,1.024e6,'vdl2Rx',0,'авиа-линк данных D8PSK 10.5 кБод 31.5 кбит/с: ACARS и ATN поверх AVLC; основная частота 136.975 (также 136.650 / 136.725 / 136.775 / 136.800 / 136.825 / 136.875 / 136.900 / 136.925)'),
    A('same','NOAA Weather 162.550',MHz(162.55),12.5e3,1.024e6,'sameRx',0,'предупреждения SAME/EAS (США); каналы 162.400–162.550 МГц','NFM'),
    A('ax25','APRS 144.800',MHz(144.8),25e3,1.024e6,'ax25Rx',0,'APRS / AX.25, Bell 202 1200 Bd, NFM; Европа (США — 144.390 МГц)','NFM'),
    A('wwv','WWV 10 MHz',MHz(10),10e3,1.024e6,'wwv',0,'службы времени WWV / WWVH / CHU: секундные метки и код времени, AM; также 2.5, 5, 15, 20 МГц, CHU 3.33 / 7.85 / 14.67 МГц','AM'),
    A('ft8','FT8 20 m 14.074',MHz(14.074),3e3,1.024e6,'ft8Rx',0,'FT8, слоты по 15 с (UTC), USB; диал 14.074 МГц (также 7.074, 10.136, 18.100, 21.074, 28.074)','USB'),
    A('js8','JS8Call 20 m 14.078',MHz(14.078),3e3,1.024e6,'js8Rx',0,'JS8Call, слоты по 15 с (UTC), USB; диал 14.078 МГц (также 7.078, 10.130, 18.104, 21.078)','USB'),
    A('lrpt','Meteor-M LRPT 137.900',MHz(137.9),150e3,1.024e6,'ccsdsDecode',0,'метеоспутник Meteor-M2-3 / M2-4, OQPSK 72 кБод → кадры CCSDS → картинка МСУ-МР (PSK Demodulator → CCSDS Decoder → LRPT Image)'),
    A('gsm','GSM 900 DL 947.2',MHz(947.2),200e3,2.4e6,'gsmRx',0,'несущая GSM (BCCH): FCCH, SCH, системная информация; поток ≥ 1.06 МС/с'),
    A('dvbt','DVB-T2 UHF 8 MHz (ch 21)',MHz(474),8e6,10e6,'dvbsoft',0,'эфирное цифровое ТВ: DVB Receiver (IQ), стандарт DVB-T2, полоса 8 МГц; поток ≥ 9.14 МС/с (Airspy / HackRF)'),
    A('atv','Analog TV PAL (UHF ch 21)',MHz(471.25),8e6,10e6,'tvDecode',0,'аналоговое ТВ: TV Demodulator (AM negative, на несущую изображения) → TV Decoder; поток ≥ 6 МС/с','IQ','atvam'),
    A('atv','FPV video 5.8 GHz (R1)',MHz(5658),20e6,20e6,'tvDecode',0,'аналоговое FPV-видео: TV Demodulator (FM) → TV Decoder; поток 20 МС/с','IQ','fpv'),
    A('lorawan','LoRaWAN EU868 868.1',MHz(868.1),125e3,1.024e6,'loraRx',0,'LoRaWAN, ширина 125 кГц, SF7–12; Европа (868.1 / 868.3 / 868.5 МГц)'),
    A('lorawan','LoRaWAN US915 902.3',MHz(902.3),125e3,1.024e6,'loraRx',0,'LoRaWAN, ширина 125 кГц; США (ап-линк 902.3 МГц + 200 кГц)'),
    A('lora','Meshtastic EU 869.525',MHz(869.525),250e3,1.024e6,'meshAir',0,'LoRa LongFast, ширина 250 кГц; Европа'),
    A('lora','Meshtastic US 906.875',MHz(906.875),250e3,1.024e6,'meshAir',0,'LoRa LongFast, ширина 250 кГц; США'),
  ];
})();

// имя записи Signal Database (sigdb-kernels.js) → вид записей каталога; по нему sigDb предлагает, чем декодировать
const SIGCAT_OF={'ADS-B / Mode S':'adsb','AIS':'ais','POCSAG':'pocsag','ISM 433 OOK/ASK':'ism','ISM FSK (датчики)':'ism','ACARS (VHF)':'acars','VDL Mode 2':'vdl2',
  'NOAA Weather Radio':'same','LoRa 250 / 500 кГц':'lora','LoRa 125 кГц':'lorawan','DVB-T / DVB-T2':'dvbt','Аналоговое ТВ PAL/SECAM':'atv','Аналоговое FPV-видео':'atv'};
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
