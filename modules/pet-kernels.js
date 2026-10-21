"use strict";
/* ============================ Aether Pet: ядро ============================
   Питомец-организм живёт на найденных сигналах. Вход — метки sigid ({f, type, conf, snr, rf}); опыт тем больше,
   чем сложнее класс и ниже SNR; задания подбираются по инвентарю устройств (что умеет железо пользователя).
   Ничего чужого не сохраняется: только класс, диапазон, лучший (самый слабый) SNR. Проверка: node tools/test-pet.mjs */

const PET_M=1e6;
// сложность распознавания класса: 1 (несущая) … 8 (OFDM). UNK — неопознанное, самое дорогое, но ловится строже
const PET_TYPES={CAR:1,TONE:1,AM:2,WFM:2,CW:3,OOK:3,NFM:3,VOICE:3,DTMF:3,USB:4,LSB:4,SSB:4,FSK:5,MFSK:6,PSK:6,DIG:6,UNK:7,OFDM:8};
// горизонты — именованные полосы; открытый горизонт = в нём уже что-то поймано
const PET_BANDS=[
  ['audio',0,0],['LF/MF',0,3*PET_M],['HF',3*PET_M,30*PET_M],['VHF low',30*PET_M,88*PET_M],['FM broadcast',88*PET_M,108*PET_M],
  ['Airband',108*PET_M,137*PET_M],['VHF high',137*PET_M,174*PET_M],['UHF low',174*PET_M,420*PET_M],['70 cm / ISM 433',420*PET_M,450*PET_M],
  ['UHF',450*PET_M,862*PET_M],['ISM 868 / 915',862*PET_M,960*PET_M],['GSM / L-band',960*PET_M,1600*PET_M],['1.6–2.3 GHz',1600*PET_M,2300*PET_M],
  ['2.4 GHz',2300*PET_M,2500*PET_M],['SHF',2500*PET_M,3e11]];
function petBand(f,rf){
  if(rf===false) return PET_BANDS[0];
  for(let i=1;i<PET_BANDS.length;i++) if(f>=PET_BANDS[i][1] && f<PET_BANDS[i][2]) return PET_BANDS[i];
  return PET_BANDS[1];
}
const petClamp=(x,a,b)=>x<a ? a : x>b ? b : x;
const petSnrBonus=snr=>petClamp((24-snr)/16,0,1.5);            // 24 дБ и выше — 0, 8 дБ — 1, 0 дБ и ниже — 1.5

// опыт за находку: сложность × (1 + бонус слабого сигнала) + надбавка за первый такой класс и за первую полосу
function petXp(type,snr,newType,newBand){
  const d=PET_TYPES[type]||PET_TYPES.UNK;
  return Math.round(10*d*(1+petSnrBonus(snr)))+(newType ? d*5 : 0)+(newBand ? 20 : 0);
}
const petNeed=lv=>Math.round(250*Math.pow(lv-1,1.5));            // опыт, с которого начинается уровень lv
function petLevel(xp){
  let lv=1; while(xp>=petNeed(lv+1)) lv++;
  const a=petNeed(lv), b=petNeed(lv+1);
  return {lv, cur:xp-a, span:b-a, frac:(xp-a)/(b-a)};
}
const PET_STAGES=['noise','tone','chord','spectrum'];       // форма питомца растёт: шум → тон → аккорд → спектр
const petStage=lv=>PET_STAGES[lv<3 ? 0 : lv<5 ? 1 : lv<8 ? 2 : 3];

/* ---- инвентарь: что браузер знает о железе пользователя ---- */
// [vendor, product|'*', вид, имя, диапазоны приёма Гц]
const PET_USB=[
  [0x0bda,0x2832,'sdr','RTL-SDR',[[24*PET_M,1766*PET_M]]],[0x0bda,0x2838,'sdr','RTL-SDR',[[24*PET_M,1766*PET_M]]],
  [0x15f4,0x0131,'sdr','Astrometa DVB-T2 SDR',[[48*PET_M,862*PET_M]]],
  [0x1d50,0x6089,'sdr','HackRF One',[[PET_M,6000*PET_M]]],[0x1d50,0x604b,'sdr','HackRF Jawbreaker',[[PET_M,6000*PET_M]]],[0x1d50,0xcc15,'sdr','rad1o',[[PET_M,6000*PET_M]]],
  [0x1d50,0x60a1,'sdr','Airspy',[[24*PET_M,1800*PET_M]]],[0x03eb,0x800c,'sdr','Airspy HF+',[[9e3,31*PET_M],[60*PET_M,260*PET_M]]],
  [0x38af,0x0001,'sdr','HydraSDR RFOne',[[24*PET_M,1800*PET_M]]],
  [0x04b4,0x00f3,'sdr','RX-888',[[10e3,60*PET_M]]],[0x04b4,0x00f1,'sdr','RX-888',[[10e3,60*PET_M]]],
  [0x1df7,'*','sdr','SDRplay',[[10e3,2000*PET_M]]],[0x2040,0xd300,'sdr','MSi2500 SDR',[[10e3,2000*PET_M]]],
  [0x07ca,0x8591,'sdr','MSi2500 SDR',[[10e3,2000*PET_M]]],[0x04bb,0x0537,'sdr','MSi2500 SDR',[[10e3,2000*PET_M]]],[0x0511,0x0037,'sdr','MSi2500 SDR',[[10e3,2000*PET_M]]],
  [0x04d8,0xfb31,'sdr','FUNcube Dongle Pro+',[[150e3,1900*PET_M]]],
];
const PET_SERIAL=[
  [0x0483,0x5740,'sdr','tinySA',[[100e3,960*PET_M]]],
  [0x303a,'*','board','ESP32 board',[]],[0x10c4,0xea60,'board','CP210x serial board',[]],[0x1a86,'*','board','CH340 serial board',[]],
  [0x2e8a,'*','board','Raspberry Pi Pico',[]],[0x2341,'*','board','Arduino',[]],
];
function petMatch(tbl,v,p){ return tbl.find(r=>r[0]===v && (r[1]==='*' || r[1]===p)); }
// usb / serial — [{vendorId, productId}], flags — {audio, camera, ble, nfc, hid, gamepad, motion, serial, usb}
function petDevices(usb,serial,flags){
  const inv=[], seen=new Set();
  const add=(id,kind,name,ranges)=>{ if(seen.has(id)) return; seen.add(id); inv.push({id,kind,name,ranges:ranges||[]}); };
  const sn=new Map();
  for(const [list,tbl,tag] of [[usb||[],PET_USB,'usb'],[serial||[],PET_SERIAL,'ser']]){
    for(const d of list){
      const r=petMatch(tbl,d.vendorId,d.productId); if(!r) continue;
      const base=tag+':'+d.vendorId.toString(16)+':'+d.productId.toString(16), k=(sn.get(base)||0)+1; sn.set(base,k);
      add(base+(k>1 ? '#'+k : ''),r[2],r[3],r[4]);
    }
  }
  const f=flags||{};
  if(f.audio) add('audio','audio','Microphone / sound card',[]);
  if(f.camera) add('camera','camera','Camera',[]);
  if(f.ble) add('ble','ble','Bluetooth LE',[]);
  if(f.nfc) add('nfc','nfc','NFC',[]);
  if(f.hid) add('hid','hid','WebHID',[]);
  if(f.gamepad) add('gamepad','gamepad','Gamepad',[]);
  if(f.motion) add('motion','motion','Motion sensors',[]);
  return inv;
}
const petRanges=inv=>inv.flatMap(d=>d.ranges.map(r=>({lo:r[0],hi:r[1],dev:d.name})));
const petHas=(inv,kind)=>inv.some(d=>d.kind===kind);
// полоса доступна, если приёмник накрывает её середину (край диапазона — это ещё не горизонт)
const petReach=(r,lo,hi)=>r.lo<=(lo+hi)/2 && r.hi>=(lo+hi)/2;
const petCovers=(inv,lo,hi)=>petRanges(inv).some(r=>petReach(r,lo,hi));

// горизонты, доступные с этим инвентарём, и сколько из них уже открыто
function petHorizons(st,inv){
  const rg=petRanges(inv), out=[];
  for(let i=1;i<PET_BANDS.length;i++){
    const [name,lo,hi]=PET_BANDS[i], r=rg.find(x=>petReach(x,lo,hi));
    if(!r) continue;
    out.push({name, lo, hi, dev:r.dev, open:Object.keys(st.found).some(k=>k.endsWith('@'+name))});
  }
  return out;
}
// горизонты, которых инвентарь не достаёт: подсказка, какое железо что откроет
function petLocked(inv){
  const rg=petRanges(inv); if(!rg.length) return [];
  return PET_BANDS.slice(1).filter(b=>!rg.some(x=>petReach(x,b[1],b[2]))).map(b=>b[0]);
}

/* ---- задания ---- */
const petQ=(id,title,band,types,xp,hint,o)=>({id,title,band,types,xp,hint,...o});
const PET_QUESTS=[
  petQ('fm','Catch a broadcast FM station',[88*PET_M,108*PET_M],['WFM'],30,'USB SDR → Spectrum Analyzer + Signal Type Identifier, tune around 100 MHz'),
  petQ('air','Find an airband voice channel',[118*PET_M,137*PET_M],['AM'],40,'AM voice between 118 and 137 MHz; airports are the easiest'),
  petQ('pmr','Hear PMR446 chatter',[446*PET_M,446.2*PET_M],['NFM','VOICE'],40,'446.000–446.200 MHz, narrow FM; a walkie-talkie nearby helps'),
  petQ('marine','Listen to marine VHF',[156*PET_M,162.1*PET_M],['NFM','VOICE'],45,'156–162 MHz near a coast or river'),
  petQ('ism433','Sniff a 433 MHz sensor',[433.05*PET_M,434.79*PET_M],['OOK','FSK','DIG','CAR'],50,'weather stations and remotes; ISM Scanner (rtl_433) decodes them'),
  petQ('ism868','Spot the 868 MHz ISM band',[863*PET_M,870*PET_M],null,60,'LoRa, smart meters, alarms; wide short bursts'),
  petQ('noaa','Find a weather-satellite downlink',[137*PET_M,138.1*PET_M],null,80,'NOAA APT / Meteor pass at 137 MHz; Satellites shows when one flies over'),
  petQ('ais','Spot ship transponders (AIS)',[161.9*PET_M,162.1*PET_M],['FSK','DIG','UNK'],70,'161.975 and 162.025 MHz, 9600 Bd GMSK'),
  petQ('pager','Spot a pager network',[929*PET_M,932*PET_M],['FSK','MFSK','DIG'],70,'POCSAG / FLEX; the Protocols nodes decode them'),
  petQ('adsb','Detect ADS-B at 1090 MHz',[1089*PET_M,1091*PET_M],null,90,'short pulses; an antenna near a window and a clear sky'),
  petQ('hfssb','Find a voice on the HF bands',[3*PET_M,30*PET_M],['USB','LSB','SSB','VOICE'],70,'needs an HF-capable receiver; evenings on 40 m and 20 m'),
  petQ('hfcw','Find Morse (CW) on HF',[3*PET_M,30*PET_M],['CW'],80,'amateur bands: 7.0 and 14.0 MHz'),
  petQ('hfdig','Catch a digital mode on HF',[3*PET_M,30*PET_M],['FSK','MFSK','PSK','DIG'],110,'FT8 on 14.074 MHz, RTTY, PSK31'),
  petQ('lband','Reach L-band: a satellite carrier',[1525*PET_M,1559*PET_M],null,140,'Inmarsat; needs an LNA and a patch antenna'),
  petQ('wifi','Spot the 2.4 GHz neighbourhood',[2400*PET_M,2500*PET_M],null,100,'Wi-Fi and Bluetooth; wide bursts, a HackRF sees them best'),
  petQ('tone','Whistle at the microphone',null,['TONE','CAR','CW'],20,'connect Microphone → Signal Type Identifier (in) and whistle',{audio:true}),
  petQ('dtmf','Dial a DTMF digit near the microphone',null,['DTMF'],35,'play keypad tones from a phone next to the microphone',{audio:true}),
  petQ('weak','Catch a signal weaker than 10 dB SNR',null,null,120,'lower the detection threshold of Signal Type Identifier to 5 dB and wait',{maxSnr:10,rf:true}),
  petQ('nameless','Meet something nameless',null,['UNK','DIG'],150,'a signal the classifier cannot name; point Signal Analyzer or Baud Estimator at it',{rf:true}),
];
function petCanDo(q,inv){
  if(q.audio) return petHas(inv,'audio');
  if(q.band) return petCovers(inv,q.band[0],q.band[1]);
  return petHas(inv,'sdr');
}
function petQuestMatch(q,c){
  if(!!q.audio===(c.rf!==false)) return false;
  if(q.rf && c.rf===false) return false;
  if(q.types && !q.types.includes(c.type)) return false;
  if(q.band && !(c.f>=q.band[0] && c.f<=q.band[1])) return false;
  if(q.maxSnr!=null && c.snr>q.maxSnr) return false;
  return true;
}
// следующее задание: невыполненные и доступные; сначала в неоткрытых горизонтах, потом по сложности
function petPick(st,inv){
  const open=new Set(Object.keys(st.found).map(k=>k.slice(k.indexOf('@')+1)));
  const cand=PET_QUESTS.filter(q=>!st.quests[q.id] && !(st.skip||{})[q.id] && petCanDo(q,inv));
  const sc=q=>{
    const b=q.band ? petBand((q.band[0]+q.band[1])/2,true)[0] : null;
    const d=q.types ? Math.min(...q.types.map(t=>PET_TYPES[t])) : 5;
    return (b && open.has(b) ? 20 : 0)+d+q.xp/60;
  };
  cand.sort((a,b)=>sc(a)-sc(b));
  return cand[0]||null;
}

/* ---- достижения ---- */
const PET_ACH=[
  ['first','First contact','caught the first signal',s=>Object.keys(s.found).length>=1],
  ['ten','Ten species','ten different finds',s=>Object.keys(s.found).length>=10],
  ['types5','Taxonomist','five signal classes',s=>Object.keys(s.types).length>=5],
  ['bands4','Explorer','four horizons opened',s=>Object.keys(s.bands).length>=4],
  ['hard','Hard one','caught a class of difficulty 6 or more',s=>Object.keys(s.types).some(t=>PET_TYPES[t]>=6)],
  ['faint','Faint heart','caught something at 10 dB SNR or below',s=>Object.values(s.found).some(f=>f.low<=10)],
  ['level5','Bloom','reached level 5',s=>petLevel(s.xp).lv>=5],
  ['quests5','Dutiful','five quests done',s=>Object.keys(s.quests).length>=5],
];

/* ---- состояние ---- */
function petNew(name){
  return {v:1, name:name||'Ori', xp:0, found:{}, types:{}, bands:{}, quests:{}, skip:{}, ach:{}, devs:{}, active:null, caught:0,
    cand:{}, lastGain:0, born:0};
}
const PET_KEEP=['v','name','xp','found','types','bands','quests','skip','ach','devs','active','caught'];
function petSave(st){ const o={}; for(const k of PET_KEEP) o[k]=st[k]; return o; }
function petLoad(st,d){
  if(!d || d.v!==1 || typeof d.xp!=='number' || !d.found || typeof d.found!=='object') return false;
  for(const k of PET_KEEP) if(d[k]!==undefined) st[k]=d[k];
  st.cand={}; return true;
}

/* ---- кадр: метки sigid → события ---- */
const PET_DIGITAL=new Set(['UNK','DIG','FSK','MFSK','PSK','OOK','OFDM']);
function petFrame(st,labels,now,inv,o){
  o={confirm:3, minConf:.45, minSnr:3, hold:8000, ...o};
  const ev=[], here=new Set();
  for(const l of labels||[]){
    if(!l || !(l.f>0)) continue;
    const type=PET_TYPES[l.type]!=null ? l.type : 'UNK', rf=l.rf!==false, snr=isFinite(l.snr) ? l.snr : 10;
    const key=type+'|'+Math.round(Math.log(l.f)/0.02)+'|'+(rf ? 1 : 0);
    here.add(key);
    const c=st.cand[key]||(st.cand[key]={type,f:l.f,rf,hits:0,snr:0,conf:0,last:now,done:false});
    c.f=l.f; c.hits++; c.snr+=(snr-c.snr)/c.hits; c.conf+=((l.conf==null ? 1 : l.conf)-c.conf)/c.hits; c.last=now;
    if(c.done || c.hits<o.confirm || c.conf<o.minConf || c.snr<o.minSnr) continue;
    c.done=true;
    petCatch(st,c,ev,inv,now);
  }
  for(const k in st.cand) if(!here.has(k) && now-st.cand[k].last>o.hold) delete st.cand[k];
  return ev;
}
function petCatch(st,c,ev,inv,now){
  const band=petBand(c.f,c.rf), key=c.type+'@'+band[0], snr=c.snr, f=st.found[key];
  let xp=0;
  if(!f){
    const newType=!st.types[c.type], newBand=!st.bands[band[0]];
    xp=petXp(c.type,snr,newType,newBand);
    st.found[key]={f:Math.round(c.f), low:snr, best:snr, n:1, t:Date.now()};
    st.types[c.type]=(st.types[c.type]||0)+1; st.bands[band[0]]=(st.bands[band[0]]||0)+1; st.caught++;
    ev.push({kind:'discovery', type:c.type, band:band[0], f:Math.round(c.f), snr:+snr.toFixed(1), conf:+c.conf.toFixed(2), xp, newType, newBand});
  }else if(snr<=f.low-4){
    xp=Math.round(10*(PET_TYPES[c.type]||7)*petSnrBonus(snr)*.5);
    f.low=snr; f.n++;
    ev.push({kind:'weak', type:c.type, band:band[0], f:Math.round(c.f), snr:+snr.toFixed(1), xp});
  }else{ f.n++; f.best=Math.max(f.best,snr); }
  for(const q of PET_QUESTS){
    if(st.quests[q.id] || !petCanDo(q,inv) || !petQuestMatch(q,c)) continue;
    st.quests[q.id]={t:Date.now(), xp:q.xp}; xp+=q.xp;
    ev.push({kind:'quest', id:q.id, title:q.title, xp:q.xp});
  }
  const before=petLevel(st.xp).lv;
  if(!xp) return;
  st.xp+=xp; st.lastGain=now;
  const lv=petLevel(st.xp).lv;
  if(lv>before) ev.push({kind:'level', level:lv, stage:petStage(lv), grew:petStage(lv)!==petStage(before)});
  for(const [id,title,text,test] of PET_ACH){
    if(!st.ach[id] && test(st)){ st.ach[id]=Date.now(); ev.push({kind:'achievement', id, title, text}); }
  }
  if(st.active && st.quests[st.active]) st.active=null;
}

/* ---- голос питомца ---- */
const petFmtHz=f=>f>=1e9 ? (f/1e9).toFixed(3)+' GHz' : f>=1e6 ? (f/1e6).toFixed(3)+' MHz' : f>=1e3 ? (f/1e3).toFixed(1)+' kHz' : Math.round(f)+' Hz';
const PET_NEXT={
  OOK:'ISM Scanner (rtl_433) or the OOK decoder',FSK:'Baud Estimator and Modulation Meter, then Symbol Slicer',
  MFSK:'Signal Analyzer: look at the tone spacing',PSK:'Constellation and Baud Estimator',DIG:'Baud Estimator, then Conv Code Finder',
  UNK:'Signal Analyzer, then Baud Estimator',OFDM:'Signal Analyzer: carrier spacing and guard interval',
};
// самый заметный ещё не пойманный артефакт: что за сигнал и каким узлом его разбирать дальше
function petNag(st,labels){
  let best=null;
  for(const l of labels||[]){
    if(!l || !(l.f>0) || !PET_DIGITAL.has(l.type)) continue;
    const band=petBand(l.f,l.rf);
    if(st.found[l.type+'@'+band[0]]) continue;
    if(!best || (l.snr||0)>(best.snr||0)) best=l;
  }
  return best ? 'Something at '+petFmtHz(best.f)+' smells like '+best.type+' and I do not know it yet. Try '+PET_NEXT[best.type]+'.' : '';
}
function petMood(st,now,live){
  const idle=(now-st.lastGain)/60000;                            // минут без добычи
  return {curiosity:petClamp(idle/10,0,1), idle, live:live|0};
}
// строка питомца: событие > совет по артефакту > задание > настроение
function petSay(st,inv,ev,nag,now,live){
  const e=ev.find(x=>x.kind==='level')||ev.find(x=>x.kind==='gear')||ev.find(x=>x.kind==='achievement')||ev.find(x=>x.kind==='quest')||ev.find(x=>x.kind==='discovery'||x.kind==='weak');
  if(e){
    if(e.kind==='level') return e.grew ? 'New form: '+e.stage+'. Level '+e.level+'.' : 'Level '+e.level+'.';
    if(e.kind==='gear') return 'New organ: '+e.name+(e.horizons ? ' — '+e.horizons+' horizon'+(e.horizons>1 ? 's' : '')+' within reach.' : '.');
    if(e.kind==='achievement') return 'Achievement: '+e.title+' — '+e.text+'.';
    if(e.kind==='quest') return 'Quest done: '+e.title+' (+'+e.xp+' xp).';
    if(e.kind==='weak') return 'A fainter catch of '+e.type+' at '+petFmtHz(e.f)+': '+e.snr+' dB. +'+e.xp+' xp.';
    return 'New: '+e.type+' at '+petFmtHz(e.f)+' ('+e.band+', '+e.snr+' dB SNR). +'+e.xp+' xp.';
  }
  if(!inv.length) return 'I have no senses yet. Plug in an SDR, a microphone or a camera and I will tell you what to look for.';
  if(nag) return nag;
  const q=petPick(st,inv);
  const m=petMood(st,now,live);
  if(q) return (m.curiosity>.6 ? 'I am hungry. ' : '')+'Quest: '+q.title+'. '+q.hint+'.';
  const lock=petLocked(inv);
  if(lock.length) return 'All quests for your gear are done. Beyond reach: '+lock.slice(0,3).join(', ')+'. A new receiver would open them.';
  return 'Everything on the menu is eaten. Go and find something nameless.';
}
// новое устройство в инвентаре — событие «новый орган» и сколько горизонтов оно открывает
function petNewGear(st,inv){
  const ev=[];
  for(const d of inv){
    if(st.devs[d.id]) continue;
    st.devs[d.id]=Date.now();
    const h=d.ranges.length ? PET_BANDS.slice(1).filter(b=>d.ranges.some(r=>petReach({lo:r[0],hi:r[1]},b[1],b[2]))).length : 0;
    ev.push({kind:'gear', id:d.id, name:d.name, horizons:h});
  }
  return ev;
}
