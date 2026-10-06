"use strict";
/* ======================= BAND PLAN DATA ======================= */
// Расширенные band plan'ы для 'table' (presets/<папка>/<имя>), справочник для изучения эфира.
// Запись: [lo, hi, label, step, color, note, kind]; единицы задаёт обёртка:
//   bdM — МГц, bdK — кГц, bdH — Гц, bdC — центр+ширина в МГц ([fc, bw, …]).
// kind — тип записи для фильтра (kind:video, kind:control, kind:channel…), note — пояснение.
// Цифры — ориентир (≈): точные частоты и мощности зависят от страны, прошивки и региона.
(()=>{
Object.assign(BP_COL,{
  VID:'#ff4081', CTL:'#69f0ae', TLM:'#40c4ff', MIL:'#e53935', MIC:'#f48fb1', WIFI:'#29b6f6',
  BT:'#5c6bc0', BLE:'#7e57c2', ZB:'#26c6da', NRF:'#d4e157', LORA:'#ff7043', STAB:'#ffd54f',
  BAND:'#607d8b', GEO:'#8bc34a', SATTV:'#ab47bc', LTE:'#5c6bc0', KEY:'#ffb300', TMP:'#aed581'});
const bdU=m=>rows=>rows.map(([lo,hi,label,step,col,note,kind])=>
  [Math.round(lo*m*1e4)/1e4,Math.round(hi*m*1e4)/1e4,label,Math.round((step||0)*m*1e4)/1e4,BP_COL[col]||col||'',note||'',kind||'']);
const bdM=bdU(1e6), bdK=bdU(1e3), bdH=bdU(1);
const bdC=rows=>bdM(rows.map(([fc,bw,...r])=>[fc-bw/2,fc+bw/2,...r]));
const rng=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const f3=x=>String(Math.round(x*1e4)/1e4);
const P={};

/* ---------- Bands: названия диапазонов ---------- */
P['Bands/ITU band names (ELF…THF)']=bdH([
  [3,30,'ELF',1,'BAND','λ 100000–10000 km: подводная связь, Schumann, ZEVS 82 Hz'],
  [30,300,'SLF',1,'BAND','λ 10000–1000 km: подводные лодки, сеть 50/60 Hz'],
  [300,3000,'ULF',10,'BAND','λ 1000–100 km: шахты, геофизика, аудио-начало'],
  [3e3,30e3,'VLF',100,'BAND','λ 100–10 km: флот, время, свисты/сферики, проникает в воду на ~10–40 м'],
  [30e3,300e3,'LF',1e3,'BAND','λ 10–1 km: LW вещание 9 кГц, NDB, время, Loran/Chayka, RFID 125 кГц'],
  [300e3,3e6,'MF',9e3,'BAND','λ 1 km–100 m: MW вещание, NDB, морская связь, любит ночное прохождение'],
  [3e6,30e6,'HF',1e3,'BAND','λ 100–10 m: КВ, ионосферное прохождение на тысячи км'],
  [30e6,300e6,'VHF',12500,'BAND','λ 10–1 m: FM, авиа, море, TV, радиолюбители'],
  [300e6,3e9,'UHF',12500,'BAND','λ 1 m–10 cm: TV, сотовая, GNSS, Wi-Fi 2.4, PMR, спутники'],
  [3e9,30e9,'SHF',1e6,'BAND','λ 10–1 cm: радары, спутники (C/X/Ku), Wi-Fi 5/6, 5G n78'],
  [30e9,300e9,'EHF',1e7,'BAND','λ 10–1 mm: V/W-band, 5G mmWave, 60 GHz, автомобильные радары 77 GHz'],
  [300e9,3e12,'THF',1e9,'BAND','λ 1–0.1 mm: субмиллиметр, астрономия']]);
P['Bands/IEEE radar letters (HF…mm)']=bdM([
  [3,30,'HF',0.001,'BAND','IEEE 521: загоризонтные радары (OTHR)'],
  [30,300,'VHF',0.0125,'BAND','IEEE: дальние РЛС раннего обнаружения, FM, авиа'],
  [300,1000,'UHF',0.025,'BAND','IEEE: РЛС дальнего обзора, TV, сотовая'],
  [1000,2000,'L',1,'BAND','УВД, GNSS, ADS-B, MSS (Inmarsat/Iridium), LTE'],
  [2000,4000,'S',1,'BAND','погодные и УВД РЛС, Wi-Fi 2.4, 3G/LTE, S-DARS'],
  [4000,8000,'C',1,'BAND','спутники C-band, погодные РЛС, Wi-Fi 5, радиовысотомеры 4.2–4.4'],
  [8000,12000,'X',1,'BAND','военные и погодные РЛС, SAR, дальний космос, X-band спутники'],
  [12000,18000,'Ku',1,'BAND','спутниковое TV/интернет (Starlink, OneWeb), VSAT'],
  [18000,27000,'K',1,'BAND','полицейские радары, линия поглощения водяного пара 22.2 GHz'],
  [27000,40000,'Ka',1,'BAND','Ka спутники, 5G n257/n261, малые радары'],
  [40000,75000,'V',1,'BAND','60 GHz (Wi-Fi 802.11ad, WiGig), поглощение O₂ ~60 GHz'],
  [75000,110000,'W',1,'BAND','авто-радары 76–81 GHz, E-band линки 71–86 GHz'],
  [110000,300000,'mm',10,'BAND','D/G-диапазоны, субтерагерцовые исследования']]);
P['Bands/NATO - ECM letters (A…M)']=bdM([
  [0,250,'A (NATO)',1,'BAND','NATO/ECM: до 250 MHz'],[250,500,'B (NATO)',1,'BAND','250–500: UHF mil-air/SATCOM'],
  [500,1000,'C (NATO)',1,'BAND','500–1000'],[1000,2000,'D (NATO)',1,'BAND','1–2 GHz (L)'],
  [2000,3000,'E (NATO)',1,'BAND','2–3 GHz (S)'],[3000,4000,'F (NATO)',1,'BAND','3–4 GHz'],
  [4000,6000,'G (NATO)',1,'BAND','4–6 GHz (C)'],[6000,8000,'H (NATO)',1,'BAND','6–8 GHz'],
  [8000,10000,'I (NATO)',1,'BAND','8–10 GHz (X)'],[10000,20000,'J (NATO)',1,'BAND','10–20 GHz (Ku)'],
  [20000,40000,'K (NATO)',1,'BAND','20–40 GHz (K/Ka)'],[40000,60000,'L (NATO)',1,'BAND','40–60 GHz'],
  [60000,100000,'M (NATO)',1,'BAND','60–100 GHz']]);
P['Bands/Satellite bands (L S C X Ku Ka)']=bdM([
  [1164,1300,'L: GNSS',1,'NAV','RNSS: L5/E5 1164–1215, L2 1215–1240, E6/L6 1260–1300','navigation'],
  [1525,1559,'L: MSS downlink',0.1,'SAT','Inmarsat, Thuraya, Omnistar (космос → Земля)','downlink'],
  [1559,1610,'L: RNSS L1',1,'NAV','GPS/GLONASS/Galileo/BeiDou L1','navigation'],
  [1610,1626.5,'L: MSS Iridium/Globalstar up',0.1,'SAT','Iridium 1616–1626.5, Globalstar ↑ 1610–1618','uplink'],
  [1626.5,1660.5,'L: MSS uplink',0.1,'SAT','Inmarsat/Thuraya Земля → космос','uplink'],
  [2025,2110,'S: space ops uplink',0.1,'SAT','TT&C, TDRS, SGLS-ish (Земля → космос)','uplink'],
  [2200,2290,'S: space ops downlink',0.1,'SAT','телеметрия КА, кубсаты, ISS (космос → Земля)','downlink'],
  [2320,2345,'S: DARS (SiriusXM)',1,'SAT','спутниковое радио США','downlink'],
  [2483.5,2500,'S: Globalstar downlink',1,'SAT','RDSS, Globalstar ↓','downlink'],
  [2500,2690,'S: BSS / IMT-2600',1,'CELL','спутниковое вещание и LTE B7/B41',''],
  [3400,4200,'C: downlink',1,'SAT','3.7–4.2 стандарт, 3.4–3.7 расширение (5G n77/n78 в части стран)','downlink'],
  [5850,6725,'C: uplink',1,'SAT','5.925–6.425 стандарт','uplink'],
  [7250,7750,'X: gov downlink',1,'MIL','военные/государственные (WGS, Skynet)','downlink'],
  [7900,8400,'X: gov uplink',1,'MIL','военные/государственные','uplink'],
  [8025,8400,'X: EESS downlink',1,'SAT','Earth observation, кубсаты, NOAA/JPSS HRD ~7.8 / Aqua 8.16','downlink'],
  [10700,12750,'Ku: downlink',1,'SATTV','DVB-S/S2, Starlink, OneWeb (LO 9.75/10.6 → IF 950–2150)','downlink'],
  [12750,13250,'Ku: uplink low',1,'SAT','OneWeb/VSAT','uplink'],
  [13750,14500,'Ku: uplink',1,'SAT','VSAT, Starlink ↑ 14.0–14.5','uplink'],
  [17700,20200,'Ka: downlink',1,'SAT','Ka-SAT, Viasat, Starlink gateways','downlink'],
  [27500,30000,'Ka: uplink',1,'SAT','Ka uplink / gateways','uplink'],
  [37500,42500,'Q: downlink',1,'SAT','перспективный','downlink'],
  [47200,51400,'V: uplink',1,'SAT','перспективный','uplink']]);
P['Bands/Infrasound & geophysical (mHz-kHz)']=bdH([
  [0.0017,0.0067,'Pc5 geomagnetic',0.0001,'GEO','геомагнитные пульсации 1.7–6.7 mHz (Alfvén)','natural'],
  [0.0067,0.022,'Pc4 geomagnetic',0.0001,'GEO','6.7–22 mHz','natural'],
  [0.022,0.1,'Pc3 geomagnetic',0.001,'GEO','22–100 mHz','natural'],
  [0.1,0.2,'Pc2 geomagnetic',0.001,'GEO','0.1–0.2 Hz','natural'],
  [0.2,5,'Pc1 geomagnetic (pearls)',0.01,'GEO','0.2–5 Hz, «жемчуг» ионосферные','natural'],
  [0.01,10,'Volcanic infrasound',0.01,'GEO','вулканы, обвалы, вариации давления','natural'],
  [0.05,0.1,'Primary microseism',0.001,'GEO','океанские волны → сейсмика','natural'],
  [0.1,0.35,'Secondary microseism',0.001,'GEO','шторма, самый сильный сейсмошум','natural'],
  [0.1,0.5,'Microbaroms',0.01,'GEO','инфразвук штормов, ≈0.2 Hz','natural'],
  [0.02,4,'CTBT infrasound (explosions)',0.01,'GEO','мониторинг взрывов и болидов','event'],
  [10,40,'Blue whale',0.5,'GEO','киты: синий 10–40 Hz (SOFAR канал)','bio'],
  [16.5,17,'Rail 16.7 Hz traction',0.1,'STAB','DE/AT/CH/NO/SE тяговая сеть 16.67 Hz','power'],
  [20,20000,'Audio',1,'BAND','20 Hz–20 kHz слышимый звук',''],
  [18000,120000,'Ultrasound / bats',100,'GEO','летучие мыши 20–120 kHz, дельфины, дефектоскопия','bio'],
  [49.9,50.1,'Mains 50 Hz',0.01,'STAB','EU/RU/AS, гармоники 100/150/…','power'],
  [59.9,60.1,'Mains 60 Hz',0.01,'STAB','Америка, JP-восток, гармоники 120/180/…','power'],
  [399,401,'Aircraft 400 Hz',0.1,'STAB','бортсеть самолётов, кораблей','power'],
  [7.83,7.83,'Schumann 1',0.01,'GEO','7.83 Hz (резонанс Земля–ионосфера)','natural'],
  [14.3,14.3,'Schumann 2',0.01,'GEO','≈14.3 Hz','natural'],[20.8,20.8,'Schumann 3',0.01,'GEO','≈20.8 Hz','natural'],
  [27.3,27.3,'Schumann 4',0.01,'GEO','≈27.3 Hz','natural'],[33.8,33.8,'Schumann 5',0.01,'GEO','≈33.8 Hz','natural'],
  [82,82,'ZEVS ELF',0.1,'STAB','РФ, Кольский п-ов, ≈82 Hz (связь с ПЛ)','military'],
  [76,76,'Seafarer ELF (off)',0.1,'MIL','США 76 Hz, закрыт в 2004 (для справки)','military'],
  [1700,2000,'Earth-ion. cutoff',10,'GEO','нижняя отсечка волновода Земля–ионосфера ≈1.7–2 kHz','natural'],
  [500,5000,'Dawn chorus / hiss',10,'GEO','VLF «хор», свисты и шипение магнитосферы','natural'],
  [2000,5000,'Tweeks',10,'GEO','сферики после отражения от ионосферы','natural'],
  [1000,10000,'Whistlers',10,'GEO','свистящие атмосферики от молний','natural'],
  [5000,10000,'Sferics (peak)',10,'GEO','максимум спектра молний 5–10 kHz','natural']]);

/* ---------- Stable: постоянно вещающее ---------- */
P['Stable/Time & frequency standards']=[...bdK([
  [40,40,'JJY 40',1,'TIME','Япония, Fukushima, 40 kHz','time'],[60,60,'JJY 60',1,'TIME','Япония, Saga, 60 kHz','time'],
  [50,50,'RTZ 50',1,'TIME','Иркутск, 50 kHz','time'],[60,60,'MSF 60',1,'TIME','Великобритания, Anthorn','time'],
  [60,60,'WWVB 60',1,'TIME','США, Fort Collins','time'],[66.6667,66.6667,'RBU 66.67',1,'TIME','Москва, импульсный код','time'],
  [68.5,68.5,'BPC 68.5',1,'TIME','Китай, Shangqiu','time'],[77.5,77.5,'DCF77',1,'TIME','Германия, Mainflingen','time'],
  [162,162,'ALS162 (TDF)',1,'TIME','Франция LW, Allouis, AM 162 kHz','time']]),
  ...bdK([
  [2500,2500,'WWV/WWVH/BPM 2.5',1,'TIME','США/Китай, 2.5 MHz','time'],[3330,3330,'CHU 3.33',1,'TIME','Канада','time'],
  [4996,4996,'RWM 4996',1,'TIME','Москва','time'],[5000,5000,'WWV/WWVH/BPM 5',1,'TIME','5 MHz, много станций (HLA, YVTO…)','time'],
  [7850,7850,'CHU 7.85',1,'TIME','Канада','time'],[9996,9996,'RWM 9996',1,'TIME','Москва','time'],
  [10000,10000,'WWV/WWVH/BPM 10',1,'TIME','10 MHz','time'],[14670,14670,'CHU 14.67',1,'TIME','Канада','time'],
  [14996,14996,'RWM 14996',1,'TIME','Москва','time'],[15000,15000,'WWV/WWVH/BPM 15',1,'TIME','15 MHz','time'],
  [20000,20000,'WWV 20',1,'TIME','США','time'],[25000,25000,'Std freq 25 MHz',1,'TIME','эталонная частота','time']])];
P['Stable/VLF-LF navy & beacons (3-300 kHz)']=bdK([
  [11.905,11.905,'RSDN-20 Alpha 11.9',0.1,'MIL','РФ «Альфа» (11.905 / 12.649 / 14.881), импульсы по циклу','nav'],
  [12.649,12.649,'RSDN-20 Alpha 12.6',0.1,'MIL','РФ «Альфа»','nav'],[14.881,14.881,'RSDN-20 Alpha 14.9',0.1,'MIL','РФ «Альфа»','nav'],
  [14.8,25.9,'RU Navy VLF cluster',0.05,'MIL','≈14.9–25.8 (14.88, 18.1, 20.5, 23.0, 25.0, 25.1, 25.5, 25.8), MSK','military'],
  [17.2,17.2,'SAQ Grimeton',0.01,'STAB','Швеция, Alexanderson, редко (праздники)','military'],
  [19.8,19.8,'NWC 19.8',0.01,'MIL','Австралия, Harold E. Holt','military'],
  [20.27,20.27,'ICV 20.27',0.01,'MIL','Италия','military'],[20.9,20.9,'HWU 20.9',0.01,'MIL','Франция, Rosnay','military'],
  [21.4,21.4,'NPM 21.4',0.01,'MIL','США, Гавайи','military'],[22.1,22.1,'GQD 22.1',0.01,'MIL','Великобритания, Anthorn','military'],
  [22.2,22.2,'JJI 22.2',0.01,'MIL','Япония, Ebino','military'],[23.4,23.4,'DHO38 23.4',0.01,'MIL','Германия, Rhauderfehn','military'],
  [24,24,'NAA 24.0',0.01,'MIL','США, Cutler (Maine)','military'],[24.8,24.8,'NLK 24.8',0.01,'MIL','США, Jim Creek','military'],
  [25.2,25.2,'NML 25.2',0.01,'MIL','США, La Moure','military'],[26.7,26.7,'TBB 26.7',0.01,'MIL','Турция, Bafa','military'],
  [37.5,37.5,'NRK 37.5',0.01,'MIL','Исландия','military'],[40.75,40.75,'NAU 40.75',0.01,'MIL','США, Пуэрто-Рико','military'],
  [100,100,'Chayka / Loran-C 100',1,'NAV','импульсная навигация 100 kHz (Chayka — РФ)','nav'],
  [70,129,'Decca (history)',1,'NAV','бывшая навигация 70–129 kHz','nav'],
  [190,415,'NDB band (low)',1,'NAV','неавтоматические радиомаяки, CW ident','beacon'],
  [283.5,325,'DGPS beacons',0.5,'NAV','морские DGPS (MSK 100–200 bps)','beacon'],
  [510,535,'NDB band (high)',1,'NAV','NDB + международный NAVTEX 518','beacon'],
  [424,424,'NAVTEX 424',1,'SEA','Япония, местный язык','beacon'],[490,490,'NAVTEX 490',1,'SEA','национальный язык','beacon'],
  [518,518,'NAVTEX 518',1,'SEA','международный, англ., FSK 100 Bd','beacon'],
  [153,279,'LW broadcast (AM)',9,'BC','198 BBC R4, 252 Tipasa (DZ), и др.; шаг 9 kHz','broadcast'],
  [198,198,'BBC R4 LW 198',9,'BC','Droitwich, 24/7','broadcast'],[252,252,'Tipasa LW 252',9,'BC','Алжир','broadcast']]);
P['Stable/HF beacons & always-on (utility)']=bdK([
  [4625,4625,'UVB-76 «Buzzer»',1,'UTIL','РФ, MDZhB, ≈4625 kHz, зуммер 24/7','utility'],
  [14100,14100,'IBP beacon 20m',1,'TIME','NCDXF/IARU: 14.100, цикл 3 мин','beacon'],
  [18110,18110,'IBP beacon 17m',1,'TIME','18.110','beacon'],[21150,21150,'IBP beacon 15m',1,'TIME','21.150','beacon'],
  [24930,24930,'IBP beacon 12m',1,'TIME','24.930','beacon'],[28200,28200,'IBP beacon 10m',1,'TIME','28.200','beacon'],
  [10144,10144,'DK0WCY beacon',1,'TIME','10.144 MHz, Германия, геомагнитный бюллетень','beacon'],
  [2182,2182,'Distress 2182',1,'SEA','международная частота бедствия, радиотелефон','safety'],
  [2187.5,2187.5,'DSC 2187.5',1,'SEA','цифровой избирательный вызов','safety'],
  [4207.5,4207.5,'DSC 4207.5',1,'SEA','DSC','safety'],[6312,6312,'DSC 6312',1,'SEA','DSC','safety'],
  [8414.5,8414.5,'DSC 8414.5',1,'SEA','DSC','safety'],[12577,12577,'DSC 12577',1,'SEA','DSC','safety'],
  [16804.5,16804.5,'DSC 16804.5',1,'SEA','DSC','safety'],[4209.5,4209.5,'NAVTEX 4209.5',1,'SEA','тропический NAVTEX','beacon'],
  [3413,3413,'VOLMET Shannon 3413',1,'AIR','метеосводки, USB','utility'],[5505,5505,'VOLMET Shannon 5505',1,'AIR','USB','utility'],
  [8957,8957,'VOLMET Shannon 8957',1,'AIR','USB','utility'],[13264,13264,'VOLMET Shannon 13264',1,'AIR','USB','utility'],
  [5720,5720,'HFDL 5720',1,'AIR','ACARS-подобные данные по HF, 1800 bps PSK','data'],
  [8942,8942,'HFDL 8942',1,'AIR','HF data link','data'],[10081,10081,'HFDL 10081',1,'AIR','HF data link','data'],
  [11184,11184,'HFDL 11184',1,'AIR','HF data link','data'],[13270,13270,'HFDL 13270',1,'AIR','HF data link','data'],
  [2618.5,2618.5,'WeFax Northwood',1,'UTIL','погодные факсимиле ≈2618.5','data'],
  [7880,7880,'WeFax Hamburg DDH3',1,'UTIL','≈7880 (RTTY/Fax)','data'],
  [13882.5,13882.5,'WeFax Pinneberg',1,'UTIL','≈13882.5','data'],
  [7038.6,7038.6,'WSPR 40m',1,'DIGI','WSPR dial USB (центр сигнала ≈ +1.5 kHz)','digital'],
  [10138.7,10138.7,'WSPR 30m',1,'DIGI','dial','digital'],[14095.6,14095.6,'WSPR 20m',1,'DIGI','dial','digital'],
  [18104.6,18104.6,'WSPR 17m',1,'DIGI','dial','digital'],[21094.6,21094.6,'WSPR 15m',1,'DIGI','dial','digital'],
  [28124.6,28124.6,'WSPR 10m',1,'DIGI','dial','digital'],
  [3573,3573,'FT8 80m',1,'DIGI','ввод 24/7: самый занятый цифровой режим','digital'],
  [7074,7074,'FT8 40m',1,'DIGI','24/7','digital'],[10136,10136,'FT8 30m',1,'DIGI','24/7','digital'],
  [14074,14074,'FT8 20m',1,'DIGI','24/7','digital'],[21074,21074,'FT8 15m',1,'DIGI','24/7','digital'],
  [28074,28074,'FT8 10m',1,'DIGI','24/7','digital']]);
P['Stable/VHF-UHF always-on 24x7']=bdM([
  [88,108,'FM broadcast',0.1,'BC','24/7; пилот 19 kHz, RDS 57 kHz','broadcast'],
  [136.975,136.975,'VDL Mode 2',0.025,'AIR','самая загруженная частота ACARS/VDL ≈136.975','data'],
  [131.55,131.55,'ACARS 131.550',0.025,'AIR','основная в мире (AM, MSK 2400)','data'],
  [131.725,131.725,'ACARS 131.725',0.025,'AIR','Европа','data'],[131.525,131.525,'ACARS 131.525',0.025,'AIR','Европа','data'],
  [130.025,130.025,'ACARS 130.025',0.025,'AIR','США','data'],[129.125,129.125,'ACARS 129.125',0.025,'AIR','США','data'],
  [161.975,161.975,'AIS 1 (ch87B)',0.025,'SEA','GMSK 9600, 24/7','data'],[162.025,162.025,'AIS 2 (ch88B)',0.025,'SEA','GMSK 9600, 24/7','data'],
  [156.775,156.775,'AIS Sat ch75',0.025,'SEA','дальний AIS','data'],[156.825,156.825,'AIS Sat ch76',0.025,'SEA','дальний AIS','data'],
  [156.525,156.525,'Marine DSC ch70',0.025,'SEA','цифровой вызов','safety'],[156.8,156.8,'Marine ch16 distress',0.025,'SEA','вызов/бедствие','safety'],
  [121.5,121.5,'Air guard 121.5',0.025,'AIR','гражданская частота бедствия','safety'],[243,243,'Mil guard 243.0',0.025,'AIR','военная (2-я гармоника 121.5)','safety'],
  [162.4,162.4,'NOAA WX 1',0.025,'UTIL','США/CA, 24/7, NFM','weather'],[162.425,162.425,'NOAA WX 2',0.025,'UTIL','NFM','weather'],
  [162.45,162.45,'NOAA WX 3',0.025,'UTIL','NFM','weather'],[162.475,162.475,'NOAA WX 4',0.025,'UTIL','NFM','weather'],
  [162.5,162.5,'NOAA WX 5',0.025,'UTIL','NFM','weather'],[162.525,162.525,'NOAA WX 6',0.025,'UTIL','NFM','weather'],
  [162.55,162.55,'NOAA WX 7',0.025,'UTIL','NFM','weather'],
  [137.1,137.1,'NOAA 19 APT',0.005,'SAT','≈137.100 (периодически)','satellite'],[137.62,137.62,'NOAA 15 APT',0.005,'SAT','≈137.620','satellite'],
  [137.9125,137.9125,'NOAA 18 APT',0.005,'SAT','≈137.9125','satellite'],
  [406.025,406.025,'COSPAS 406.025',0.003,'SAT','аварийные маяки (EPIRB/ELT)','safety'],[406.04,406.04,'COSPAS 406.040',0.003,'SAT','PLB/EPIRB','safety'],
  [868.2,868.4,'FLARM EU',0.2,'AIR','планеры/лёгкая авиация ≈868.2/868.4','data'],
  [978,978,'UAT 978',1,'AIR','ADS-B UAT США (до FL180)','data'],[1090,1090,'ADS-B 1090ES',1,'AIR','24/7: Mode S/ADS-B','data']]);


/* ---------- Drones ---------- */
const FPV={
  A:[5865,5845,5825,5805,5785,5765,5745,5725], B:[5733,5752,5771,5790,5809,5828,5847,5866],
  E:[5705,5685,5665,5645,5885,5905,5925,5945], F:[5740,5760,5780,5800,5820,5840,5860,5880],
  R:[5658,5695,5732,5769,5806,5843,5880,5917], L:[5362,5399,5436,5473,5510,5547,5584,5621]};
const FPVN={A:'Boscam A',B:'Boscam B',E:'Band E (DJI/Foxeer)',F:'Fatshark / NexWave',R:'Raceband (стандарт гонок)',L:'LowRace'};
P['Drones/FPV analog video 5.8G (A B E F R L)']=bdC(Object.entries(FPV).flatMap(([b,fs])=>
  fs.map((f,i)=>[f,18,'FPV '+b+(i+1)+' '+f+' [VID]',1,'VID',FPVN[b]+', аналог FM ≈18 MHz','video'])));
P['Drones/FPV video other bands (0.9-3.3G)']=bdC([
  ...[1080,1120,1160,1200,1240,1280,1320,1360].map((f,i)=>[f,18,'FPV 1.2G ch'+(i+1)+' '+f+' [VID]',1,'VID','1.2/1.3 GHz аналог, далёкие полёты, проходит сквозь листву','video']),
  ...[2414,2432,2450,2468].map((f,i)=>[f,20,'FPV 2.4G ch'+(i+1)+' '+f+' [VID]',1,'VID','аналоговый 2.4 GHz (перекрывается Wi-Fi/RC)','video']),
  [915,26,'FPV 0.9G video [VID]',1,'VID','900 MHz аналог (902–928 США); конфликт с ELRS/Crossfire','video'],
  [3300,400,'FPV 3.3G video [VID]',5,'VID','3.1–3.5 GHz аналог, хуже ходит, меньше помех','video'],
  [5000,200,'FPV 5.0G video (5.0–5.2) [VID]',1,'VID','редкий, нестандартный','video']]);
P['Drones/FPV digital video (DJI, HDZero, Walksnail)']=bdM([
  [5725,5850,'DJI FPV / O3 / O4 Air Unit [VID+CTL]',5,'VID','OFDM 10/20/40 MHz, видео и RC на одной линии; DroneID на том же канале','video'],
  [5650,5850,'DJI FPV (расш. 5.65–5.85) [VID]',5,'VID','FCC-режим, зависит от региона','video'],
  [5658,5917,'HDZero [VID]',37,'VID','27 MHz, каналы R1–R8 как Raceband (5658…5917)','video'],
  [5725,5850,'Walksnail Avatar [VID]',20,'VID','8 каналов в 5.725–5.850, 20/40 MHz','video'],
  [5150,5250,'DJI/Wi-Fi 5.1 (регионально) [VID]',20,'VID','5.15–5.25 в части стран и режимов','video'],
  [2400,2483.5,'DJI O3/O4 control 2.4 [CTL]',1,'CTL','2.4 GHz FHSS/OFDM управление и видео','control'],
  [5725,5850,'DJI O3/O4 control 5.8 [CTL]',5,'CTL','5.8 GHz вариант','control']]);
P['Drones/RC control links']=bdM([
  [2400.4,2479.4,'ExpressLRS 2.4G [CTL+TLM]',1,'CTL','LoRa/FLRC FHSS, 50–1000 Hz, домен ISM2G4','control'],
  [2400,2483.5,'FrSky ACCST/ACCESS 2.4 [CTL]',1,'CTL','FHSS ≈ 47–69 каналов 1 MHz; Archer, Tandem','control'],
  [2400,2483.5,'FlySky AFHDS 2A/3 [CTL]',1,'CTL','FHSS 2.4','control'],
  [2403,2480,'Spektrum DSM2/DSMX [CTL]',1,'CTL','2403–2480, DSMX FHSS','control'],
  [2400,2483.5,'Futaba FASST/FHSS [CTL]',1,'CTL','S-FHSS/T-FHSS/FASST','control'],
  [2400,2483.5,'TBS Tracer / ImmersionRC Ghost [CTL]',1,'CTL','2.4 GHz LoRa/FHSS','control'],
  [2400,2483.5,'Radiolink / Jumper / RadioMaster ELRS [CTL]',1,'CTL','мультипротокольные модули (A7105/CC2500/XN297)','control'],
  [863.275,869.575,'ExpressLRS EU868 [CTL+TLM]',0.2,'CTL','домен EU868, LoRa 200/250 Hz; доступны EU/IN/FCC/AU','control'],
  [903.5,926.9,'ExpressLRS FCC915 [CTL+TLM]',0.3,'CTL','FCC915 ≈903.5–926.9','control'],
  [915.5,926.9,'ExpressLRS AU915 [CTL+TLM]',0.3,'CTL','AU915','control'],
  [865.375,866.95,'ExpressLRS IN866 [CTL+TLM]',0.3,'CTL','Индия','control'],
  [433.1,434.45,'ExpressLRS EU433 [CTL+TLM]',0.2,'CTL','EU433','control'],
  [433.42,434.42,'ExpressLRS AU433 [CTL+TLM]',0.2,'CTL','AU433','control'],
  [863,870,'TBS Crossfire EU868 [CTL+TLM]',0.2,'CTL','FSK/LoRa, 150 Hz, ≈868 MHz 100 mW','control'],
  [902,928,'TBS Crossfire US915 [CTL+TLM]',0.5,'CTL','FHSS 915 (100 каналов)','control'],
  [863,928,'FrSky R9 / Cross [CTL+TLM]',0.5,'CTL','868/915 LoRa/FSK, дальний RC','control'],
  [433.05,434.79,'433 LRS (OpenLRS, EZUHF) [CTL]',0.025,'CTL','ISM 433 FHSS, лёгкая дальнобойная аппаратура','control'],
  [72.01,72.99,'72 MHz aircraft (US ch11–60)',0.02,'CTL','50 каналов × 20 kHz, 72.010…72.990, PPM FM','control'],
  [75.41,75.99,'75 MHz surface (US)',0.02,'CTL','модели авто/лодок','control'],
  [35,35.2,'35 MHz aircraft (EU/UK)',0.01,'CTL','35.010–35.200, 35.820–35.910','control'],
  [40.665,40.995,'40 MHz surface (EU)',0.01,'CTL','автомодели','control'],
  [26.995,27.255,'27 MHz RC (6 ch)',0.05,'CTL','26.995/27.045/27.095/27.145/27.195/27.255','control'],
  [2400,2483.5,'Toy drones 2.4 (XN297/A7105/BK2423) [CTL]',1,'CTL','Syma, Hubsan, Eachine: nRF24-подобные FHSS, см. nRF24','control']]);
P['Drones/Telemetry, MAVLink, ID']=bdM([
  [433.05,434.79,'SiK radio 433 (3DR/Holybro) [TLM]',0.05,'TLM','MAVLink, FHSS 433 (EU)','telemetry'],
  [902,928,'SiK / RFD900 915 [TLM]',0.1,'TLM','MAVLink, FHSS 902–928 (US/AU)','telemetry'],
  [868,868.6,'SiK 868 (EU) [TLM]',0.1,'TLM','MAVLink 868','telemetry'],
  [2400,2483.5,'MAVLink Wi-Fi / ESP / Herelink [TLM+VID]',1,'TLM','Wi-Fi телеметрия и видео по IP (UDP 14550)','telemetry'],
  [5725,5850,'DroneBridge / Wi-Fi 5.8 [TLM+VID]',5,'TLM','цифровой FPV + MAVLink в одном канале','telemetry'],
  [868,868.6,'LoRa telemetry 868 [TLM]',0.125,'TLM','SX127x, лёгкий канал телеметрии','telemetry'],
  [1090,1090,'ADS-B Out (uAvionix) [ID]',1,'AIR','1090ES; дроны с ADS-B','id'],
  [978,978,'UAT 978 [ID]',1,'AIR','США, UAT дроны/планеры','id'],
  [868.2,868.4,'FLARM [ID]',0.2,'AIR','EU, видимость дронов для пилотов','id'],
  [2402,2402,'Remote ID BLE adv 37 [ID]',2,'BLE','ASTM F3411, Legacy/Long Range (Coded PHY)','id'],
  [2426,2426,'Remote ID BLE adv 38 [ID]',2,'BLE','ASTM F3411','id'],
  [2480,2480,'Remote ID BLE adv 39 [ID]',2,'BLE','ASTM F3411','id'],
  [2437,2437,'Remote ID Wi-Fi NAN/Beacon ch6 [ID]',5,'WIFI','Wi-Fi NAN, ASTM F3411 / ASD-STAN','id'],
  [2400,2483.5,'DJI DroneID (OcuSync) [ID]',1,'MIL','DJI DroneID: OFDM-пакет в линии OcuSync: серийник, координаты, дом; декодируется SDR','id'],
  [5725,5850,'DJI DroneID 5.8 [ID]',5,'MIL','то же на 5.8 GHz','id']]);
P['Drones/Commercial models (DJI, Autel, Parrot…)']=bdM([
  [2400,2483.5,'DJI Mavic 3/Air 3/Mini 4/Avata (O3/O4) 2.4',1,'CTL','OcuSync 3+/4, 20/40 MHz, DroneID','model'],
  [5725,5850,'DJI Mavic 3/Air 3/Mini 4/Avata 5.8',5,'CTL','OcuSync 3+/4','model'],
  [2400,2483.5,'DJI Mavic 2/Air 2/Mini 2/Phantom 4 (OcuSync 2) 2.4',1,'CTL','OcuSync 2.0','model'],
  [5725,5850,'DJI Mavic 2/Air 2/Mini 2/Phantom 4 5.8',5,'CTL','OcuSync 2.0, в ряде стран 5.15–5.25','model'],
  [2400,2483.5,'DJI Mavic Pro/Phantom 4 Pro/Inspire (Lightbridge/OcuSync 1)',1,'CTL','Lightbridge 2.4/5.8','model'],
  [2400,2483.5,'DJI Phantom 3 Std/Mavic Mini 1/Spark (Wi-Fi) 2.4',1,'CTL','Wi-Fi 802.11n, видно в сканере Wi-Fi','model'],
  [5725,5850,'DJI Matrice 300/350 (OcuSync Ent.) 5.8',5,'CTL','OcuSync Enterprise 2.4/5.8','model'],
  [2400,2483.5,'DJI Agras/Matrice 2.4',1,'CTL','сельхоз и промышленные','model'],
  [2400,2483.5,'Autel EVO II/Lite/Nano (SkyLink) 2.4',1,'CTL','SkyLink 2.0/3.0','model'],
  [5725,5850,'Autel EVO II/Lite/Nano 5.8',5,'CTL','SkyLink','model'],
  [2400,2483.5,'Parrot ANAFI / Bebop (Wi-Fi) 2.4',1,'WIFI','Wi-Fi AP; ANAFI USA/Ai ещё 4G','model'],
  [5180,5825,'Parrot ANAFI 5 GHz Wi-Fi',20,'WIFI','5 GHz Wi-Fi AP (UNII-1/3)','model'],
  [5180,5825,'Skydio 2/X2 Wi-Fi 5 GHz',20,'WIFI','Wi-Fi, X10 с радио Doodle Labs/Silvus (опц.)','model'],
  [5725,5850,'Yuneec Typhoon H/H520 video 5.8',5,'CTL','Wi-Fi 5.8 видео + ST16 2.4','model'],
  [2400,2483.5,'Yuneec ST16 control 2.4',1,'CTL','управление','model'],
  [5725,5850,'Hubsan Zino/H501S video 5.8',5,'VID','видео 5.8 + управление 2.4','model'],
  [2400,2483.5,'Syma/Holy Stone/Eachine toys 2.4',1,'CTL','2.4 FHSS (XN297/A7105)','model'],
  [2400,2483.5,'Walkera DEVO / Radiolink 2.4',1,'CTL','FHSS','model']]);
P['Drones/Military & tactical UAS']=bdM([
  [5030,5091,'UAS CNPC (ITU AM(R)S) [CTL+TLM]',1,'MIL','WRC-12: управление и non-payload связь БПЛА','control'],
  [960,1164,'L-band AM(R)S UAS CNPC [CTL]',1,'MIL','960–1164 MHz, делится с DME/TACAN/UAT','control'],
  [960,1215,'JTIDS / Link 16 / MIDS',3,'MIL','51 частота 969–1206 MHz, TDMA FH, шаг 3 MHz','military'],
  [4400,4990,'Mil C-band LOS datalink [CTL+TLM+VID]',1,'MIL','«C-band» LOS линия для MALE-БПЛА (MQ-1/MQ-9, TB2 и др., ≈)','military'],
  [1350,1850,'Mil L-band datalink [CTL+TLM]',1,'MIL','тактические БПЛА: AeroVironment Raven/Puma DDL, ScanEagle (≈)','military'],
  [2200,2400,'S-band flight telemetry [TLM+VID]',1,'MIL','2.2–2.4 GHz: телеметрия, лёгкие БПЛА, обучение (≈)','military'],
  [1435,1525,'L-band telemetry (aero) [TLM]',1,'MIL','1.435–1.525, лётные испытания','telemetry'],
  [14400,15350,'CDL / TCDL Ku [VID+TLM]',10,'MIL','Common Data Link: Ku 14.40–14.83 / 15.15–15.35 (≈)','military'],
  [14000,14500,'Ku SATCOM uplink (MQ-9/Global Hawk) [CTL]',1,'MIL','БПЛА дальнего действия через ИСЗ','military'],
  [10700,12750,'Ku SATCOM downlink [CTL]',1,'MIL','БПЛА через Ku SATCOM','military'],
  [225,400,'UHF mil-air + UAV voice/data',0.025,'MIL','AM/FM, Have Quick; БПЛА-ретрансляторы','military'],
  [243,270,'UHF SATCOM downlink',0.025,'MIL','FLTSAT/UFO/MUOS 243–270','military'],
  [292,318,'UHF SATCOM uplink',0.025,'MIL','292–318','military'],
  [300,320,'MUOS uplink',5,'MIL','WCDMA 5 MHz','military'],[360,380,'MUOS downlink',5,'MIL','WCDMA 5 MHz','military'],
  [900,930,'Doodle Labs / Microhard 900 [CTL+VID]',1,'MIL','mesh-радиомодемы БПЛА (≈902–928)','military'],
  [1625,1720,'Doodle Labs 1.6–1.7 / Silvus [CTL+VID]',1,'MIL','MANET-радио (Silvus StreamCaster, Doodle Mesh Rider)','military'],
  [2300,2500,'Mesh MANET 2.3–2.5 [CTL+VID]',1,'MIL','Silvus/Doodle/Microhard','military'],
  [5150,5850,'Mesh MANET 5 GHz [CTL+VID]',5,'MIL','Silvus/Doodle/Wi-Fi-like','military'],
  [1559,1610,'GNSS L1 (Shahed/Geran и др. БПЛА)',1,'NAV','Shahed-136/Geran-2 — GNSS, часть вариантов с CRPA «Kometa» (≈)','military'],
  [1565,1585,'Counter-UAS: GNSS L1 jamming',1,'MIL','РЭБ/C-UAS: глушение L1/L2 и FPV-диапазонов','jamming'],
  [433,435,'C-UAS jam: 433',1,'MIL','РЭБ ELRS/LRS','jamming'],
  [860,930,'C-UAS jam: 868/915',1,'MIL','РЭБ ELRS/Crossfire','jamming'],
  [1100,1400,'C-UAS jam: 1.2G video',1,'MIL','РЭБ FPV 1.2/1.3','jamming'],
  [2400,2483.5,'C-UAS jam: 2.4',1,'MIL','РЭБ Wi-Fi/RC/DJI','jamming'],
  [5150,5950,'C-UAS jam: 5.8',1,'MIL','РЭБ FPV 5.8/5.2','jamming']]);

/* ---------- Wireless: Wi-Fi / BT / BLE / 802.15.4 / nRF24 ---------- */
P['Wireless/Wi-Fi 2.4G ch1-14']=bdC([
  ...rng(1,13).map(c=>[2407+5*c,22,'WiFi ch'+c+' '+(2407+5*c),5,'WIFI',c%5===1&&c<12?'непересекающийся: 1/6/11 (EU ещё 1/5/9/13)':c>11?'ch12–13 не в США (ограничено), 14 — только Япония, 11b':'20 MHz = 22 MHz DSSS','channel']),
  [2484,22,'WiFi ch14 2484',5,'WIFI','только Япония, 802.11b','channel']]);
const W5=[...[36,40,44,48].map(c=>[c,'UNII-1, indoor']),...[52,56,60,64].map(c=>[c,'UNII-2A, DFS']),
  ...rng(0,11).map(i=>100+4*i).map(c=>[c,'UNII-2C, DFS'+(c>=120&&c<=128?', TDWR 5.6 GHz (погодные радары)':'')]),
  ...[149,153,157,161,165].map(c=>[c,'UNII-3 (ISM 5.8)']),...[169,173,177].map(c=>[c,'UNII-4, ITS 5.9'])];
P['Wireless/Wi-Fi 5G channels (20 MHz)']=bdC(W5.map(([c,n])=>[5000+5*c,20,'WiFi ch'+c+' '+(5000+5*c),20,'WIFI',n+'; 40/80/160 MHz — объединение соседних','channel']));
P['Wireless/Wi-Fi 6E 6G channels (20 MHz)']=bdC(rng(0,58).map(i=>{ const c=1+4*i;
  return [5950+5*c,20,'WiFi6E ch'+c+' '+(5950+5*c)+((c-5)%16===0?' PSC':''),20,'WIFI',(c<=93?'U-NII-5':c<=113?'U-NII-6':c<=185?'U-NII-7':'U-NII-8')+((c-5)%16===0?', preferred scanning channel':''),'channel']; }));
P['Wireless/Wi-Fi 60G + HaLow']=[...bdC(rng(1,6).map(c=>[58320+2160*(c-1),2160,'WiGig ch'+c+' '+(58320+2160*(c-1))/1000+' GHz',2160,'WIFI','802.11ad/ay, каналы 2.16 GHz','channel'])),
  ...bdM([[902,928,'HaLow 802.11ah US',1,'WIFI','1/2/4/8/16 MHz, Wi-Fi дальнобойный IoT','band'],
  [863,868,'HaLow EU',1,'WIFI','863–868','band'],[916.5,927.5,'HaLow JP',1,'WIFI','916.5–927.5','band'],
  [917,923.5,'HaLow KR',1,'WIFI','917–923.5','band']])];
P['Wireless/V2X ITS 5.9G (DSRC, C-V2X)']=bdC(rng(0,6).map(i=>172+2*i).map(c=>[5000+5*c,10,'ITS ch'+c+' '+(5000+5*c),10,'NAV','DSRC/ITS-G5, 802.11p 10 MHz; C-V2X PC5 на 5.905–5.925','channel']));
P['Wireless/Bluetooth Classic ch0-78']=bdC(rng(0,78).map(k=>[2402+k,1,'BT ch'+k+' '+(2402+k),1,'BT','FHSS 1600 hops/s, AFH обходит Wi-Fi','channel']));
P['Wireless/BLE ch0-39 (adv 37, 38, 39)']=bdC(rng(0,39).map(k=>{
  const f=2402+2*k, adv=k===0?37:k===12?38:k===39?39:null, d=adv?null:k<12?k-1:k-2;
  return [f,2,'BLE '+(adv?'ADV '+adv:'data '+d)+' '+f,2,adv?'BLE':'BT',adv?'advertising: Wi-Fi 1/6/11 между ними (2402/2426/2480)':'data channel, RF idx '+k,'channel']; }));
P['Wireless/Zigbee Thread 802.15.4 (ch0-26)']=[...bdC([[868.3,0.6,'802.15.4 ch0 868.3 (EU)',0.6,'ZB','BPSK 20 kbit/s','channel'],
  ...rng(1,10).map(k=>[906+2*(k-1),0.6,'802.15.4 ch'+k+' '+(906+2*(k-1))+' (US)',2,'ZB','BPSK 40 kbit/s 915 MHz','channel']),
  ...rng(11,26).map(k=>[2405+5*(k-11),2,'Zigbee/Thread ch'+k+' '+(2405+5*(k-11)),5,'ZB',[15,20,25,26].includes(k)?'не пересекается с Wi-Fi 1/6/11':k===11?'часто по умолчанию, перекрыт Wi-Fi 1':'OQPSK 250 kbit/s','channel'])])];
P['Wireless/nRF24L01 XN297 ch0-125']=bdC(rng(0,125).map(k=>[2400+k,1,'nRF24 ch'+k+' '+(2400+k),1,'NRF',k>=84?'за пределами ISM 2.4 (>2483.5) — запрещено в большинстве стран':'Enhanced ShockBurst, 250k/1M ширина 1 MHz, 2M — 2 MHz','channel']));
P['Wireless/2.4G misc (ANT+, HID, ISM)']=bdM([
  [2457,2457,'ANT+ 2457',1,'NRF','ANT/ANT+ спорт-датчики (Garmin, Wahoo), один канал 57','channel'],
  [2402,2480,'Logitech Unifying/Lightspeed (nRF24)',1,'NRF','HID-мыши/клавиатуры, GFSK 2 Mbps; mousejack','hid'],
  [2403,2480,'Microsoft 2.4 / wireless keyboards',1,'NRF','проприетарный FHSS','hid'],
  [2400,2483.5,'Xbox 360 / gamepads 2.4',1,'NRF','проприетарные FHSS','hid'],
  [2450,2450,'Microwave oven leakage',20,'ISM','2.45 ± 20 MHz, импульсный шум 50/60 Hz','noise'],
  [2412,2472,'Wi-Fi Direct / NAN social',5,'WIFI','каналы 1/6/11 (2412/2437/2462)','channel'],
  [2400,2483.5,'Analog AV senders / wireless cams 2.4',1,'VID','2.414/2.432/2.450/2.468, FM видео','video'],
  [2400,2483.5,'WirelessHART / ISA100',1,'ZB','промышленные 802.15.4','industrial']]);

/* ---------- LoRa / sub-GHz IoT ---------- */
const lw=(f,bw,nm,note)=>[f,bw,nm,bw,'LORA',note||'LoRaWAN','channel'];
P['LoRa/LoRaWAN EU868 + EU433']=bdC([
  lw(868.1,0.125,'EU868 ch0 868.1','обязательный по умолчанию (join)'),lw(868.3,0.125,'EU868 ch1 868.3','обязательный; SF7 BW250 тоже'),lw(868.5,0.125,'EU868 ch2 868.5','обязательный'),
  ...[867.1,867.3,867.5,867.7,867.9].map((f,i)=>lw(f,0.125,'EU868 ch'+(i+3)+' '+f,'TTN/добавочные каналы')),
  [868.8,0.2,'EU868 FSK 868.8',100,'LORA','FSK 50 kbit/s','channel'],
  lw(869.525,0.125,'EU868 RX2 869.525','SF9 окно RX2 (g3, 10% duty, 500 mW)'),
  ...[433.175,433.375,433.575].map((f,i)=>lw(f,0.125,'EU433 ch'+i+' '+f,'EU433')),
  lw(434.665,0.125,'EU433 RX2 434.665','SF9')]);
P['LoRa/LoRaWAN US915 + AU915']=bdC([
  ...rng(0,63).map(i=>lw(902.3+0.2*i,0.125,'US915 ch'+i+' '+f3(902.3+0.2*i),'sub-band '+(Math.floor(i/8)+1)+(i>=8&&i<16?' (TTN/Helium)':''))),
  ...rng(0,7).map(i=>lw(903+1.6*i,0.5,'US915 ch'+(64+i)+' '+f3(903+1.6*i),'500 kHz, sub-band '+(i+1)+', SF8 BW500')),
  ...rng(0,7).map(i=>[923.3+0.6*i,0.5,'US915 DL'+i+' '+f3(923.3+0.6*i),500,'LORA','downlink 500 kHz','channel']),
  ...rng(0,63).map(i=>lw(915.2+0.2*i,0.125,'AU915 ch'+i+' '+f3(915.2+0.2*i),'sub-band '+(Math.floor(i/8)+1))),
  ...rng(0,7).map(i=>lw(915.9+1.6*i,0.5,'AU915 ch'+(64+i)+' '+f3(915.9+1.6*i),'500 kHz'))]);
P['LoRa/LoRaWAN Asia, RU, CN']=bdC([
  lw(923.2,0.125,'AS923-1 ch0 923.2','AS923 (JP/SG/TH…): 920–925'),lw(923.4,0.125,'AS923-1 ch1 923.4',''),
  lw(921.4,0.125,'AS923-2 ch0 921.4','AS923-2 (ID/VN…)'),lw(921.6,0.125,'AS923-2 ch1 921.6',''),
  lw(920.9,0.125,'KR920 ch0 920.9','Корея 920–923.5'),lw(921.1,0.125,'KR920 ch1 921.1',''),lw(921.3,0.125,'KR920 ch2 921.3',''),
  lw(865.0625,0.125,'IN865 ch0 865.0625','Индия 865–867'),lw(865.4025,0.125,'IN865 ch1 865.4025',''),lw(865.985,0.125,'IN865 ch2 865.985',''),
  lw(868.9,0.125,'RU864 ch0 868.9','РФ 864–870 (в основном 868.7–869.2)'),lw(869.1,0.125,'RU864 ch1 869.1',''),
  [479.8,19,'CN470 uplink 470.3–489.3',200,'LORA','96 каналов × 200 kHz, FDD','band'],[505,9.4,'CN470 downlink 500.3–509.7',200,'LORA','48 каналов','band'],
  lw(779.5,0.125,'CN779 ch0 779.5','779–787'),lw(779.7,0.125,'CN779 ch1 779.7',''),lw(779.9,0.125,'CN779 ch2 779.9','')]);
P['LoRa/Meshtastic & LoRa APRS']=bdM([
  [902,928,'Meshtastic US (≈906.875 LongFast)',0.25,'LORA','slot 20, 250 kHz; LongFast/ShortFast и др.','region'],
  [906.8,906.95,'Meshtastic US LongFast ≈906.875',0.25,'LORA','дефолтный канал США','channel'],
  [869.4,869.65,'Meshtastic EU_868 (≈869.525)',0.25,'LORA','10% duty, 500 mW; дефолт 869.525','region'],
  [433,434,'Meshtastic EU_433',0.25,'LORA','EU433, ≈433.875 дефолт','region'],
  [915,928,'Meshtastic ANZ/AU',0.25,'LORA','Австралия/НЗ','region'],[920.5,923.5,'Meshtastic JP',0.25,'LORA','Япония','region'],
  [920,923,'Meshtastic KR',0.25,'LORA','Корея','region'],[920,925,'Meshtastic TW/TH',0.25,'LORA','Тайвань/Таиланд','region'],
  [868.7,869.2,'Meshtastic RU',0.25,'LORA','Россия','region'],[865,867,'Meshtastic IN',0.25,'LORA','Индия','region'],
  [433.05,434.79,'Meshtastic UA_433 / MY_433',0.25,'LORA','Украина/Малайзия 433','region'],
  [868,868.6,'Meshtastic UA_868',0.25,'LORA','Украина 868','region'],[470,510,'Meshtastic CN',0.25,'LORA','Китай 470–510','region'],
  [2400,2483.5,'Meshtastic LORA_24',0.8,'LORA','2.4 GHz LoRa (SX128x)','region'],
  [433.775,433.775,'LoRa APRS 433.775',0.125,'DIGI','EU LoRa APRS (SF12, BW125)','channel'],
  [868.0,868.6,'LoRa APRS EU868',0.125,'DIGI','экспериментальные трекеры, шлюзы','channel']]);
P['LoRa/Sigfox, Z-Wave, wM-Bus, KNX, EnOcean']=bdM([
  [868.034,868.226,'Sigfox RCZ1 uplink (868.13)',0.1,'LORA','UNB DBPSK 100 bps, 192 kHz окно','channel'],[869.525,869.525,'Sigfox RCZ1 downlink',0.1,'LORA','GFSK 600 bps','channel'],
  [902.2,902.2,'Sigfox RCZ2/4 uplink 902.2',0.1,'LORA','США/Мексика/Бразилия','channel'],[905.2,905.2,'Sigfox RCZ2 downlink',0.1,'LORA','США','channel'],
  [920.8,920.8,'Sigfox RCZ4 uplink 920.8',0.1,'LORA','AU/NZ/…','channel'],[922.3,922.3,'Sigfox RCZ4 downlink',0.1,'LORA','AU/NZ','channel'],
  [868.42,868.42,'Z-Wave EU 868.42',0.1,'ZB','R1; ещё 869.85 (R2)','channel'],[869.85,869.85,'Z-Wave EU R2 869.85',0.1,'ZB','','channel'],
  [869,869,'Z-Wave RU 869.0',0.1,'ZB','РФ','channel'],[908.42,908.42,'Z-Wave US 908.42',0.1,'ZB','США/Канада','channel'],
  [916,916,'Z-Wave IL 916.0',0.1,'ZB','Израиль','channel'],[921.42,921.42,'Z-Wave ANZ/BR 921.42',0.1,'ZB','AU/NZ/BR','channel'],
  [865.2,865.2,'Z-Wave IN 865.2',0.1,'ZB','Индия','channel'],[919.8,919.8,'Z-Wave HK/MY 919.8',0.1,'ZB','','channel'],
  [922.5,926.3,'Z-Wave JP 922.5–926.3',0.1,'ZB','Япония (3 канала)','channel'],
  [868.3,868.3,'wM-Bus S2/T2 868.3',0.1,'SRD','счётчики EU, режим S/T2 (meter→collector T1: 868.95)','channel'],
  [868.95,868.95,'wM-Bus T1/C1 868.95',0.1,'SRD','счётчики EU','channel'],[868.03,868.63,'wM-Bus R2 868.03–868.63',0.06,'SRD','6 каналов','channel'],
  [169.4,169.475,'wM-Bus N 169.4–169.475',0.0125,'SRD','Narrowband, 12.5 kHz','channel'],
  [868.3,868.3,'KNX RF 868.3',0.1,'SRD','умный дом','channel'],[868.3,868.3,'EnOcean EU 868.3',0.1,'SRD','беспроводные выключатели без батареи','channel'],
  [315,315,'EnOcean US 315',0.1,'SRD','США','channel'],[902.875,902.875,'EnOcean US 902.875',0.1,'SRD','США','channel'],
  [433.42,433.42,'Somfy RTS 433.42',0.025,'KEY','жалюзи/шторы, rolling code','key'],
  [868.25,869.85,'io-homecontrol (Somfy/Velux)',0.1,'KEY','868.25/868.95/869.85','key']]);

/* ---------- SubGHz: 315 / 433 / 868 / 915 ---------- */
P['SubGHz/315 MHz (US, JP)']=bdM([
  [314,316,'US ISM 315 band',0.025,'SRD','FCC 15.231: ASK/OOK пульты, брелоки','band'],
  [315,315,'315.0 keyfobs / TPMS',0.025,'KEY','США: брелоки (Ford/GM…), TPMS, EV1527/PT2262','key'],
  [310,310,'310.0 garage / Linear',0.025,'KEY','гаражные пульты (Stanley, Linear)','key'],
  [303.875,303.875,'303.875 Chamberlain',0.025,'KEY','старые Chamberlain/Craftsman','key'],
  [318,318,'318.0 Linear / Multi-Code',0.025,'KEY','Linear MultiCode 318','key'],
  [390,390,'390.0 garage (Security+)',0.025,'KEY','Chamberlain Security+/Genie','key'],
  [345,345,'345.0 Honeywell/GE alarm',0.025,'KEY','охранные датчики','alarm'],
  [319.5,319.5,'319.5 Interlogix/GE',0.025,'KEY','GE/Interlogix','alarm'],
  [312,315,'312–315 JP keyless',0.025,'KEY','Япония, брелоки','key'],
  [300,320,'300–320 SRD',0.025,'SRD','диапазон гаражей и сигнализаций','band']]);
P['SubGHz/433 MHz ISM & devices']=bdM([
  [433.05,434.79,'ISM 433 (EU)',0.025,'ISM','ISM R1; 10 mW, радиолюбители первичные','band'],
  [433.92,433.92,'433.92 (key/sensor center)',0.025,'KEY','ASK/OOK/FSK: брелоки, TPMS, метеостанции, звонки','key'],
  [433.42,433.42,'433.42 Somfy RTS',0.025,'KEY','жалюзи','key'],[434.42,434.42,'434.42 keyfobs',0.025,'KEY','часть авто (Mercedes/…)','key'],
  [433.3,433.3,'433.3 Oregon Sci.',0.025,'TMP','метеодатчики','sensor'],[433.89,433.89,'433.89 weather/remote',0.025,'TMP','Fine Offset, LaCrosse','sensor'],
  [433.075,434.775,'LPD433 (69 ch)',0.025,'SRD','25 kHz каналы 433.075…434.775','voice'],
  [433.8,433.8,'433.8 Hörmann/Nice',0.025,'KEY','ворота','key'],
  [433.92,433.92,'KeeLoq/HCS301 433.92',0.025,'KEY','rolling code, ASK/FSK 433.92','key'],
  [433.5,433.5,'433.5 baby/intercom',0.025,'SRD','детские радионяни, домофоны','audio'],
  [434.775,434.775,'434.775 LPD ch69',0.025,'SRD','верхний канал','voice'],[433.075,433.075,'433.075 LPD ch1',0.025,'SRD','нижний канал','voice']]);
P['SubGHz/868-870 MHz SRD sub-bands (EU, RU)']=bdM([
  [863,865,'863–865 audio / RFID',0.1,'SRD','беспроводной звук (10 mW), радиомикрофоны','audio'],
  [865,868,'865–868 RFID (EU)',0.2,'SRD','RFID 865.6–867.6, 4 канала (865.7/866.3/866.9/867.5), 2 W','rfid'],
  [868,868.6,'868.0–868.6 (1%)',0.025,'SRD','основная: LoRa, Sigfox, KNX, датчики, сигнализации, 25 mW','band'],
  [868.7,869.2,'868.7–869.2 (0.1%)',0.025,'SRD','25 mW, РФ SRD','band'],
  [869.2,869.25,'869.200–869.250 social alarm',0.025,'SRD','социальные тревожные кнопки (10%)','alarm'],
  [869.25,869.3,'869.250–869.300 alarm',0.025,'SRD','тревожные системы','alarm'],
  [869.4,869.65,'869.4–869.65 (10%, 500 mW)',0.025,'SRD','мощный подканал: Meshtastic, LoRa RX2 869.525','band'],
  [869.65,869.7,'869.650–869.700 alarm',0.025,'SRD','тревожные системы','alarm'],
  [869.7,870,'869.7–870.0 (1%)',0.025,'SRD','25 mW','band'],
  [868.35,868.35,'868.35 sensors',0.025,'TMP','Oregon/La Crosse/Bresser 868','sensor'],
  [868.95,868.95,'868.95 sensors',0.025,'TMP','Visonic/метеодатчики','sensor'],
  [868.3,868.3,'868.3 central',0.025,'SRD','Hörmann BiSecur, Homematic','key']]);
P['SubGHz/915 MHz ISM (Americas, AU)']=bdM([
  [902,928,'ISM 915 (FCC 15.247)',0.1,'ISM','FHSS/DTS: LoRa, Z-Wave, Zigbee, FPV 0.9, ELRS/Crossfire US, RFID','band'],
  [902.75,927.25,'UHF RFID EPC Gen2 (US)',0.5,'ISM','50 каналов × 500 kHz, FHSS','rfid'],
  [912.6,912.6,'Itron ERT / rtlamr 912.6',0.1,'TMP','счётчики воды/газа/эл-ва США (SCM)','sensor'],
  [915,915,'915 center ISM',0.1,'ISM','','sensor'],
  [906,924,'Zigbee 915 ch1–10',2,'ZB','802.15.4 sub-GHz, 2 MHz шаг','band'],
  [902,928,'Wi-SUN FAN / HaLow',0.2,'ISM','FSK/OFDM для умных сетей и счётчиков','band'],
  [920,928,'AU915 / ISM 920',0.2,'ISM','Австралия 915–928','band'],
  [902,928,'Cordless phones 900 / baby monitors',0.1,'SRD','аналоговые/FHSS 900 MHz','audio'],
  [1920,1930,'DECT 6.0 (US)',1.728,'SRD','см. Audio/Cordless','audio']]);

/* ---------- Audio: радиомикрофоны и беспроводной звук ---------- */
P['Audio/Wireless mics UHF+VHF (EU)']=bdM([
  [470,694,'PMSE UHF TV-band (EU)',0.025,'MIC','основной диапазон радиомикрофонов, FM/аналог 200 kHz, цифровые 125–600 kHz','mic'],
  [470,608,'UHF TV 470–608',0.025,'MIC','главный пул профессиональных систем','mic'],
  [606,694,'UHF TV 606–694',0.025,'MIC','614–694 (600 MHz) в ряде стран','mic'],
  [694,790,'694–790 (mobile, раньше TV)',0.025,'CELL','LTE B28 DL ≈758–803; микрофоны выселены','info'],
  [823,832,'823–832 (PMSE duplex gap)',0.025,'MIC','бывшая полоса 800 MHz, радиомикрофоны/IEM','mic'],
  [863,865,'863–865 license-free mics',0.025,'MIC','безлицензионные микрофоны и наушники ≤10 mW, канал 70','mic'],
  [1785,1805,'1785–1805 PMSE ch70',0.025,'MIC','1.8 GHz микрофоны (ограничено лицензиями)','mic'],
  [174,216,'VHF Band III mics (EU)',0.025,'MIC','старые VHF-системы 174–216','mic'],
  [169.4,169.8,'169.4–169.8 hearing/mic',0.0125,'MIC','слуховые/ALD системы, телеметрия','mic'],
  [1350,1400,'1350–1400 PMSE (UK/EU)',0.025,'MIC','L-band микрофоны/IEM (≈, зависит от страны)','mic']]);
P['Audio/Wireless mics (US, CA)']=bdM([
  [174,216,'VHF TV 7–13 (mics)',0.025,'MIC','VHF микрофоны','mic'],[470,608,'UHF TV 14–36 (mics)',0.025,'MIC','основной пул США','mic'],
  [608,614,'CH37 (radio astronomy / WMTS)',0.025,'MIC','мед. телеметрия/радиоастрономия','mic'],
  [614,652,'600 MHz DL (T-Mobile) / mics',0.025,'CELL','LTE B71 DL 617–652 (после аукциона)','info'],
  [653,657,'653–657 licensed mics',0.025,'MIC','лицензированные микрофоны (duplex gap)','mic'],
  [657,663,'657–663 unlicensed (Part 15)',0.025,'MIC','безлицензионные устройства','mic'],
  [941.5,960,'941.5–960 aux / STL',0.025,'MIC','вещательные AUX и 944–952 STL','mic'],
  [902,928,'902–928 Part 15 mics',0.025,'MIC','безлицензионные микрофоны (Shure, ранние системы)','mic'],
  [925,937.5,'925–937.5 mics',0.025,'MIC','Shure X51/Sennheiser K','mic'],
  [1920,1930,'1920–1930 DECT-band mics',1.728,'MIC','Shure/Clear-Com UDECT','mic'],
  [2400,2483.5,'2.4 GHz digital mics',1,'MIC','Shure GLX-D, Rode Wireless, DJI Mic: FHSS/OFDM','mic'],
  [5150,5850,'5.8 GHz digital mics',5,'MIC','Hollyland/Saramonic/GLX-D','mic']]);
P['Audio/Vendor ranges (Sennheiser, Shure…)']=bdM([
  [516,558,'Sennheiser ew G4 A',0.025,'MIC','A: 516–558','vendor'],[566,608,'Sennheiser ew G4 G',0.025,'MIC','G: 566–608','vendor'],
  [606,648,'Sennheiser ew G4 GB',0.025,'MIC','GB: 606–648','vendor'],[626,668,'Sennheiser ew G4 B',0.025,'MIC','B: 626–668','vendor'],
  [734,776,'Sennheiser ew G4 C',0.025,'MIC','C: 734–776','vendor'],[780,822,'Sennheiser ew G4 D',0.025,'MIC','D: 780–822','vendor'],
  [823,865,'Sennheiser ew G4 E',0.025,'MIC','E: 823–865 (823–832 + 863–865)','vendor'],
  [925,937.5,'Sennheiser ew G4 K',0.025,'MIC','K: 925–937.5','vendor'],
  [470,534,'Shure ULX-D / QLX-D G51',0.025,'MIC','G51: 470–534','vendor'],[534,598,'Shure H51',0.025,'MIC','H51: 534–598','vendor'],
  [572,636,'Shure J51',0.025,'MIC','J51: 572–636','vendor'],[606,670,'Shure K51',0.025,'MIC','K51: 606–670','vendor'],
  [632,696,'Shure L51',0.025,'MIC','L51: 632–696','vendor'],[710,782,'Shure P51',0.025,'MIC','P51: 710–782','vendor'],
  [925,937.5,'Shure X51',0.025,'MIC','X51: 925–937.5','vendor'],
  [2400,2483.5,'Sennheiser XSW-D / Rode / DJI Mic',1,'MIC','2.4 GHz digital','vendor']]);
const dect=(f0,n)=>rng(0,n-1).map(i=>[f0+(f0>1900?1:-1)*1.728*i,1.728,'DECT '+(f0>1900?'6.0':'EU')+' c'+i+' '+f3(f0+(f0>1900?1:-1)*1.728*i),1.728,'SRD','GFSK 1.152 Mbit/s','channel']);
P['Audio/Cordless, baby monitors, intercom, AV senders']=[...bdC(dect(1897.344,10)),...bdC(dect(1921.536,5)),...bdM([
  [1880,1900,'DECT EU 1880–1900',1.728,'SRD','10 несущих, 24 слота, телефоны/Clear-Com','band'],
  [1920,1930,'DECT 6.0 US',1.728,'SRD','5 несущих','band'],
  [43.7,50,'US cordless 43.7–50 MHz',0.025,'SRD','аналоговые телефоны и радионяни (старые)','audio'],
  [49.83,49.89,'US 49 MHz baby monitor',0.015,'SRD','49.830/49.845/49.860/49.875/49.890','audio'],
  [902,928,'900 MHz cordless / baby',0.1,'SRD','FHSS, аналог','audio'],
  [914,915,'CT1 EU (old)',0.025,'SRD','устаревшие аналоговые телефоны CT1/CT1+','audio'],
  [2400,2483.5,'2.4 baby monitors / wireless audio',1,'SRD','FHSS/цифровые камеры','audio'],
  [5725,5850,'5.8 AV senders / wireless cams',5,'VID','аналог FM 5.8, 8 каналов','video'],
  [72.1,75.9,'US ALD 72–76 MHz',0.025,'MIC','assistive listening (церкви, залы)','audio'],
  [863,865,'EU tour guide / headphones',0.1,'MIC','беспроводные наушники и экскурсионные системы','audio'],
  [2300,2400,'Wireless video/ENG 2.3–2.4 + 2.0–2.1',1,'VID','ENG-линки COFDM (BAS 2025–2110)','video'],
  [7100,8500,'ENG 7–8 GHz',5,'VID','ENG/STL линки','video'],[12750,13250,'ENG 13 GHz',5,'VID','ENG/спутниковые грузовики','video']])];

/* ---------- Navigation ---------- */
P['Navigation/GNSS (GPS GLONASS Galileo BeiDou)']=bdC([
  [1575.42,2.046,'GPS L1 C/A',1,'NAV','1575.42, BPSK(1), гражданский; P(Y)/M-code шире ±10–15 MHz','civil'],
  [1575.42,30.69,'GPS L1 M/P(Y) wide',1,'NAV','военный M-code/ P(Y)','military'],
  [1227.6,2.046,'GPS L2C / L2 P(Y)',1,'NAV','1227.60; L2C гражданский','civil'],[1176.45,20.46,'GPS L5 / Galileo E5a / BDS B2a',1,'NAV','1176.45, 20.46 MHz','civil'],
  [1575.42,24.55,'Galileo E1 / BDS B1C / QZSS L1',1,'NAV','CBOC/BOC(1,1), 1575.42','civil'],
  [1207.14,20.46,'Galileo E5b / BDS B2b',1,'NAV','1207.14','civil'],[1191.795,51.15,'Galileo E5 AltBOC',1,'NAV','1191.795, 51 MHz','civil'],
  [1278.75,40.92,'Galileo E6 / QZSS L6',1,'NAV','1278.75; HAS/CAS','civil'],
  [1561.098,4.092,'BeiDou B1I',1,'NAV','1561.098','civil'],[1268.52,20.46,'BeiDou B3I',1,'NAV','1268.52','civil'],
  [1176.45,20.46,'NavIC L5',1,'NAV','1176.45 (Индия)','civil'],[2492.028,16.5,'NavIC S-band',1,'NAV','2492.028','civil'],
  [1202.025,20,'GLONASS L3OC (CDMA)',1,'NAV','1202.025','civil'],[1600.995,8.2,'GLONASS L1OC (CDMA)',1,'NAV','1600.995','civil'],
  [1248.06,8.2,'GLONASS L2OC (CDMA)',1,'NAV','1248.06','civil'],
  [1575.42,2.046,'SBAS L1 (WAAS/EGNOS/SDCM/MSAS/GAGAN)',1,'NAV','тот же L1, PRN 120–158','augmentation'],
  [1530,60,'L-band corrections (Omnistar, Galileo HAS)',1,'NAV','коррекции PPP через Inmarsat 1525–1559','augmentation'],
  [1559,51,'RNSS L1 band (1559–1610)',1,'BAND','весь диапазон GNSS L1 (GPS/GLO/GAL/BDS)','band']]);
P['Navigation/GLONASS FDMA (G1 G2, k=-7…6)']=bdC([
  ...rng(-7,6).map(k=>[1602+0.5625*k,1.022,'GLO G1 k'+k+' '+f3(1602+0.5625*k),0.5625,'NAV','FDMA 511 kHz BPSK, 1598.0625–1605.375','civil']),
  ...rng(-7,6).map(k=>[1246+0.4375*k,1.022,'GLO G2 k'+k+' '+f3(1246+0.4375*k),0.4375,'NAV','FDMA, 1242.9375–1248.625','civil'])]);
P['Navigation/Aero nav & surveillance']=bdM([
  [0.19,0.535,'NDB',0.001,'NAV','190–535 kHz, CW идентификатор + AM','beacon'],
  [108,117.975,'VOR / ILS LOC / GBAS',0.05,'NAV','VOR 108–117.95; ILS LOC 108.10–111.95 (нечётные десятые)','nav'],
  [108.1,111.95,'ILS localizer',0.05,'NAV','40 каналов, 90/150 Hz AM','nav'],
  [328.6,335.4,'ILS glideslope',0.15,'NAV','парный с LOC, UHF','nav'],[75,75,'Marker beacon 75',0.01,'NAV','внешний/средний/внутренний, 400/1300/3000 Hz','beacon'],
  [962,1213,'DME / TACAN',1,'NAV','канал X: запрос 1025–1150, ответ 962–1213','nav'],
  [1030,1030,'SSR/TCAS interrogation 1030',1,'AIR','запросы Mode S','data'],[1090,1090,'SSR/TCAS reply + ADS-B 1090ES',1,'AIR','ответы Mode A/C/S, ADS-B','data'],
  [978,978,'UAT 978',1,'AIR','США, ADS-B UAT','data'],[4200,4400,'Radar altimeter',4,'NAV','4.2–4.4 GHz, FMCW; 5G n77 помехи','nav'],
  [5350,5470,'Weather radar (airborne C/X)',1,'NAV','бортовой метео-РЛС','radar'],[9300,9500,'Weather radar X',1,'NAV','бортовой метео-РЛС, SART 9.2–9.5','radar'],
  [118,137,'Airband AM voice',0.025,'AIR','25/8.33 kHz каналы','voice'],[121.5,121.5,'Guard 121.5',0.025,'AIR','аварийная','safety'],
  [225,400,'Mil-air UHF AM',0.025,'MIL','225–399.975, 243.000 guard','military']]);

/* ---------- Satellite ---------- */
P['Satellite/Inmarsat, Thuraya & L-band MSS']=bdM([
  [1525,1559,'MSS L-band downlink',0.0025,'SAT','Inmarsat BGAN/Aero/C/M, Thuraya, Omnistar','downlink'],
  [1626.5,1660.5,'MSS L-band uplink',0.0025,'SAT','Inmarsat/Thuraya Земля→космос','uplink'],
  [1530,1545,'Inmarsat-C TDM / NCS',0.0025,'SAT','STD-C: ≈1537.10 / 1541.45 (пример), BPSK 1200 bit/s, EGC/ SafetyNET','data'],
  [1545,1555,'Inmarsat Aero (JAERO) downlink',0.0025,'SAT','1545–1555: P-канал 10.5 kbps, ACARS через спутник','data'],
  [1646.5,1656.5,'Inmarsat Aero uplink',0.0025,'SAT','Aero ↑','uplink'],[1626.5,1646.5,'Inmarsat-C / M uplink',0.0025,'SAT','STD-C ↑','uplink'],
  [1525,1559,'Thuraya L-band DL',0.0025,'SAT','Thuraya 2/3/4 (спот-лучи, GMR-1/3G)','downlink'],
  [1616,1626.5,'Iridium TDMA/TDD',0.0415,'SAT','1616–1626.5 MHz, QPSK 25 kbit/s, 66 КА, 24/7','data'],
  [1626,1626.5,'Iridium ring alert',0.0415,'SAT','≈1626.27, сигнал вызова','data'],
  [1610,1618.725,'Globalstar uplink',1.23,'SAT','CDMA 1.23 MHz','uplink'],[2483.5,2500,'Globalstar downlink',1.23,'SAT','S-band ↓','downlink'],
  [137,138,'ORBCOMM downlink',0.0125,'SAT','137.2–137.8, SDPSK 4800 bps','data'],[148,150.05,'ORBCOMM uplink',0.0125,'SAT','148–150.05','uplink'],
  [312,315,'Gonets uplink',0.025,'SAT','РФ «Гонец» (≈)','uplink'],[387,390,'Gonets downlink',0.025,'SAT','РФ «Гонец» (≈)','downlink'],
  [401.65,401.65,'Argos uplink 401.65',0.025,'SAT','метеобуи, животные','uplink'],
  [2320,2345,'SiriusXM S-DARS',0.5,'SAT','США','downlink'],[1452,1492,'DAB L-band / WorldSpace',0.5,'SAT','европейский DAB L','broadcast']]);
P['Satellite/Weather & EO downlinks']=bdM([
  [137.1,137.1,'NOAA 19 APT 137.1',0.005,'SAT','2400 Hz AM-FM, 38 kHz','apt'],[137.62,137.62,'NOAA 15 APT 137.62',0.005,'SAT','APT','apt'],
  [137.9125,137.9125,'NOAA 18 APT 137.9125',0.005,'SAT','APT','apt'],[137.9,137.9,'Meteor-M LRPT 137.9',0.005,'SAT','Meteor-M2-3/2-4, QPSK 72k, 137.1/137.9 (≈)','lrpt'],
  [137.1,137.1,'Meteor-M LRPT 137.1',0.005,'SAT','LRPT ≈137.1','lrpt'],
  [1698,1698,'NOAA HRPT 1698',0.1,'SAT','HRPT 665 kbps (NOAA-15…19: 1698/1702.5/1707)','hrpt'],[1702.5,1702.5,'NOAA HRPT 1702.5',0.1,'SAT','HRPT','hrpt'],[1707,1707,'NOAA HRPT 1707',0.1,'SAT','HRPT','hrpt'],
  [1701.3,1701.3,'MetOp AHRPT 1701.3',0.1,'SAT','AHRPT 3.5 Mbps, QPSK','hrpt'],[1701.4,1701.4,'FY-3 AHRPT ≈1701.4',0.1,'SAT','FengYun-3 AHRPT, ≈','hrpt'],
  [1686.6,1686.6,'GOES GRB 1686.6',0.1,'SAT','GOES-R GRB, 31 Mbps','grb'],[1694.1,1694.1,'GOES HRIT/EMWIN 1694.1',0.1,'SAT','HRIT 400 kbps, EMWIN','hrit'],
  [1691,1691,'GOES LRIT / Elektro-L 1691',0.1,'SAT','LRIT 128 kbps (≈)','lrit'],[1695.15,1695.15,'Meteosat HRIT 1695.15',0.1,'SAT','MSG/MTG HRIT/LRIT (≈)','hrit'],
  [1679.7,1679.7,'GOES DCS 1679.7',0.1,'SAT','DCP relay (≈)','dcs'],[401.9,402.1,'DCP uplink 401.9–402.1',0.025,'SAT','метеостанции → GOES/Meteosat','dcs'],
  [7812,7812,'NPP/JPSS X-band 7812',1,'SAT','HRD ≈7.8 GHz','xband'],[8160,8160,'Aqua/Terra X-band 8160',1,'SAT','direct broadcast','xband'],
  [400.15,406,'Radiosondes 400.15–406',0.0025,'TMP','Vaisala RS41, Meteomodem, DFM; GFSK 4800','radiosonde'],
  [1675,1683,'Radiosondes 1.68 GHz (old)',0.5,'TMP','старые РС (Vaisala RS92 1680)','radiosonde']]);
P['Satellite/Amateur & CubeSat']=bdM([
  [145.8,146,'2m satellite segment',0.005,'SAT','145.800–146.000 (↓ и ↑ сателлиты)','band'],[435,438,'70cm satellite segment',0.005,'SAT','435–438 (↓ и ↑)','band'],
  [29.3,29.51,'10m satellite',0.005,'SAT','AO-7 mode A ↓ 29.400–29.500','band'],[1260,1270,'23cm uplink',0.005,'SAT','узлы 1.26–1.27 GHz','band'],
  [2400,2450,'2.4 GHz satellite',0.5,'SAT','S-band ↓ (QO-100 ↑ 2400.05)','band'],
  [145.8,145.8,'ISS voice/SSTV 145.800',0.005,'SAT','↓ FM, ARISS SSTV, Region 1','iss'],[145.825,145.825,'ISS APRS 145.825',0.005,'SAT','APRS цифи','iss'],
  [145.99,145.99,'ISS repeater ↑ 145.990',0.005,'SAT','↑; ↓ 437.800','iss'],[437.8,437.8,'ISS repeater ↓ 437.800',0.005,'SAT','↓','iss'],
  [145.85,145.85,'SO-50 ↑ 145.850',0.005,'SAT','FM, тон 67.0 Hz','sat'],[436.795,436.795,'SO-50 ↓ 436.795',0.005,'SAT','FM','sat'],
  [435.25,435.25,'AO-91 ↑ 435.250',0.005,'SAT','FM, 67 Hz','sat'],[145.96,145.96,'AO-91 ↓ 145.960',0.005,'SAT','FM','sat'],
  [435.15,435.15,'AO-95 ↑ 435.150',0.005,'SAT','FM','sat'],[145.92,145.92,'AO-95 ↓ 145.920',0.005,'SAT','FM','sat'],
  [145.935,145.995,'RS-44 ↑ 145.935–145.995',0.005,'SAT','linear transponder','sat'],[435.61,435.67,'RS-44 ↓ 435.610–435.670',0.005,'SAT','SSB/CW','sat'],
  [145.9,146,'FO-29 ↑ 145.900–146.000',0.005,'SAT','linear','sat'],[435.8,435.9,'FO-29 ↓ 435.800–435.900',0.005,'SAT','linear','sat'],
  [145.85,145.95,'AO-7 mode A ↑',0.005,'SAT','linear','sat'],[29.4,29.5,'AO-7 mode A ↓',0.005,'SAT','linear','sat'],
  [432.125,432.175,'AO-7 mode B ↑',0.005,'SAT','linear','sat'],[145.925,145.975,'AO-7 mode B ↓',0.005,'SAT','linear','sat'],
  [145.935,145.935,'FUNcube beacon 145.935',0.005,'SAT','BPSK 1k2, образовательный','sat'],
  [2400.05,2400.3,'QO-100 NB ↑',0.001,'SAT','Es\'hail-2 25.5°E, узкополосный','geo'],[10489.55,10489.8,'QO-100 NB ↓',0.001,'SAT','10489.55–10489.80, маяки ≈10489.5/10489.75','geo'],
  [2401.5,2409.5,'QO-100 WB ↑',0.5,'SAT','DATV 8 MHz','geo'],[10491,10499,'QO-100 WB ↓',0.5,'SAT','DATV','geo'],
  [436,437.5,'CubeSat UHF telemetry',0.0025,'SAT','GFSK 9k6/1k2, CW, LoRa-спутники','telemetry'],[400,403,'Space ops UHF 400–403',0.0025,'SAT','метео/кубсаты UHF','telemetry'],
  [2200,2290,'CubeSat S-band',0.1,'SAT','высокоскоростной ↓','telemetry'],[8025,8400,'CubeSat/EO X-band',1,'SAT','X ↓ до сотен Mbps','telemetry']]);
P['Satellite/UHF 225-400 (military) & 270-400']=bdM([
  [225,328.6,'Mil-air UHF AM (NATO I)',0.025,'MIL','225.000–328.600 AM/HQ, 25 kHz','military'],[328.6,335.4,'ILS glideslope',0.15,'NAV','внутри полосы','nav'],
  [335.4,399.975,'Mil-air UHF AM (NATO II)',0.025,'MIL','335.4–399.975','military'],
  [243,243,'UHF guard 243.0',0.025,'MIL','военная частота бедствия','safety'],
  [243,270,'UHF SATCOM downlink 243–270',0.025,'MIL','FLTSATCOM/UFO/Skynet, 25 kHz каналы','satcom'],
  [292,318,'UHF SATCOM uplink 292–318',0.025,'MIL','FLTSATCOM/UFO','satcom'],
  [300,320,'MUOS uplink 300–320',5,'MIL','WCDMA, 5 MHz','satcom'],[360,380,'MUOS downlink 360–380',5,'MIL','WCDMA','satcom'],
  [149.9,150.05,'Tsikada/Parus ≈150',0.005,'NAV','Доплер-навигация КА ≈150/400 (РФ, ≈)','nav'],[399.76,400.05,'Tsikada/Parus ≈400',0.005,'NAV','пара к 150 MHz (≈)','nav'],
  [380,400,'TETRA / Tetrapol emergency',0.025,'UTIL','380–385/390–395 TETRA, 380–400 общ.','trunk'],
  [406,406.1,'COSPAS-SARSAT 406',0.003,'SAT','EPIRB/ELT: 406.025/.028/.037/.040','safety'],
  [400.15,406,'Radiosondes',0.0025,'TMP','метеозонды','radiosonde'],[401,402,'DCP / EESS 401–402',0.025,'SAT','метео телеметрия','dcs'],
  [312,315,'Gonets uplink (≈)',0.025,'SAT','РФ','satcom'],[387,390,'Gonets downlink (≈)',0.025,'SAT','РФ','satcom']]);
P['Satellite/TV Ku-C & LNB IF (950-2150)']=bdM([
  [950,2150,'LNB IF (L-band 1st IF)',1,'SATTV','вход SDR/ресивера после LNB; IF = RF − LO','if'],
  [10700,11700,'Ku low band (LO 9.75 → IF 950–1950)',1,'SATTV','Universal LNB, 22 kHz off','ku'],
  [11700,12750,'Ku high band (LO 10.6 → IF 1100–2150)',1,'SATTV','Universal LNB, 22 kHz on','ku'],
  [10700,11700,'FSS Ku (R1)',1,'SATTV','Astra/Hot Bird/Eutelsat, транспондеры 27–36 MHz','ku'],
  [11700,12500,'BSS Ku (R1)',1,'SATTV','DTH вещание: Astra 19.2°E, Hot Bird 13°E, Eutelsat 36°E (НТВ+/Триколор)','ku'],
  [11700,12750,'Tricolor / NTV+ (36°E)',1,'SATTV','Eutelsat 36B/36C ≈11.7–12.75, DVB-S2 (≈)','ru'],
  [3400,4200,'C-band DL',1,'SATTV','3.625–4.2 (стандарт 3.7–4.2), LO 5.15 → IF 950–1750','c'],
  [5850,6725,'C-band UL',1,'SATTV','5.925–6.425','c'],[17300,17800,'Ka BSS ↓ (R1)',1,'SATTV','17.3–17.8','ka'],
  [10950,11700,'Ku FSS (R2, 10.95–11.7)',1,'SATTV','Америка','ku'],[12200,12700,'Ku BSS (R2, 12.2–12.7)',1,'SATTV','DIRECTV/Dish','ku']]);
P['Satellite/Broadband (Starlink, OneWeb, Ka)']=bdM([
  [10700,12700,'Starlink Ku downlink',250,'SAT','8 каналов × 250 MHz, пользователи ↓','downlink'],[14000,14500,'Starlink Ku uplink',250,'SAT','↑ пользователи','uplink'],
  [17800,19300,'Starlink Ka gateways ↓',250,'SAT','шлюзы Ka ↓','gateway'],[27500,30000,'Starlink Ka gateways ↑',250,'SAT','шлюзы Ka ↑','gateway'],
  [71000,76000,'E-band gateways ↓',250,'SAT','Starlink V2+/Kuiper, 71–76','gateway'],[81000,86000,'E-band gateways ↑',250,'SAT','81–86','gateway'],
  [10700,12700,'OneWeb Ku ↓',250,'SAT','OneWeb пользователи ↓','downlink'],[12750,13250,'OneWeb Ku ↑',250,'SAT','OneWeb ↑ (+14.0–14.5)','uplink'],
  [17700,20200,'KA-SAT / Viasat Ka ↓',250,'SAT','Ka','downlink'],[27500,30000,'KA-SAT / Viasat Ka ↑',250,'SAT','Ka','uplink'],
  [1910,1915,'Starlink D2C PCS-G ↑',5,'CELL','прямая связь со смартфонами (≈), 1990–1995 ↓','d2c']]);
P['Satellite/Space ops & deep space']=bdM([
  [2025,2110,'S-band TT&C ↑',1,'SAT','TDRS, кубсаты ↑','uplink'],[2200,2290,'S-band TT&C ↓',1,'SAT','КА ↓','downlink'],
  [2110,2120,'DSN S ↑',1,'SAT','дальний космос ↑','deep'],[2290,2300,'DSN S ↓',1,'SAT','дальний космос ↓','deep'],
  [7145,7235,'DSN X ↑',1,'SAT','дальний космос ↑','deep'],[8400,8500,'DSN X ↓ (Voyager 8.4)',1,'SAT','8.4 GHz ↓','deep'],
  [31800,32300,'DSN Ka ↓',1,'SAT','Ka ↓','deep'],[34200,34700,'DSN Ka ↑',1,'SAT','Ka ↑','deep'],
  [1761,1842,'SGLS ↑ (US gov)',1,'MIL','USSF Satellite Ground Link','military'],
  [390,450,'Mars proximity UHF',1,'SAT','орбитальный ретранслятор Электра: 401.5/437.1 (≈)','deep'],
  [1420,1420,'Hydrogen line 1420.405',5,'GEO','21 cm водород, радиоастрономия','astro'],[1610.6,1613.8,'OH lines',1,'GEO','1612/1665/1667 OH','astro']]);

/* ---------- Cellular & trunked ---------- */
P['Cellular/LTE & 5G bands']=bdM([
  [880,915,'GSM900 / B8 UL',0.2,'CELL','E-GSM/UMTS900/LTE B8','uplink'],[925,960,'GSM900 / B8 DL',0.2,'CELL','','downlink'],
  [1710,1785,'GSM1800 / B3 UL',0.2,'CELL','DCS/LTE B3','uplink'],[1805,1880,'GSM1800 / B3 DL',0.2,'CELL','','downlink'],
  [1920,1980,'UMTS2100 / B1 UL',5,'CELL','','uplink'],[2110,2170,'UMTS2100 / B1 DL',5,'CELL','','downlink'],
  [832,862,'LTE B20 UL',5,'CELL','800 MHz EU/RU','uplink'],[791,821,'LTE B20 DL',5,'CELL','','downlink'],
  [703,748,'LTE B28 UL',5,'CELL','700 MHz APT','uplink'],[758,803,'LTE B28 DL',5,'CELL','','downlink'],
  [2500,2570,'LTE B7 UL',5,'CELL','2600 MHz','uplink'],[2620,2690,'LTE B7 DL',5,'CELL','','downlink'],
  [2570,2620,'LTE B38 TDD',5,'CELL','2600 TDD','tdd'],[2300,2400,'LTE B40 TDD',5,'CELL','2300 TDD','tdd'],[2496,2690,'LTE B41 TDD',5,'CELL','2.5 GHz TDD','tdd'],
  [452.5,457.5,'LTE B31 / CDMA450 UL',1.25,'CELL','450 MHz (Skylink РФ)','uplink'],[462.5,467.5,'LTE B31 / CDMA450 DL',1.25,'CELL','','downlink'],
  [3300,3800,'5G n78',5,'CELL','3.3–3.8 GHz (РФ 3.4–3.8)','5g'],[3300,4200,'5G n77',5,'CELL','3.3–4.2 GHz','5g'],[4400,5000,'5G n79',5,'CELL','4.4–5.0','5g'],
  [24250,27500,'5G n258',50,'CELL','24 GHz mmWave','5g'],[26500,29500,'5G n257',50,'CELL','28 GHz mmWave','5g'],
  [1850,1910,'LTE B2 UL (US PCS)',5,'CELL','','uplink'],[1930,1990,'LTE B2 DL (US PCS)',5,'CELL','','downlink'],
  [824,849,'LTE B5 UL (US 850)',5,'CELL','','uplink'],[869,894,'LTE B5 DL (US 850)',5,'CELL','','downlink'],
  [699,716,'LTE B12/17 UL (US 700)',5,'CELL','','uplink'],[729,746,'LTE B12/17 DL (US 700)',5,'CELL','','downlink'],
  [777,787,'LTE B13 UL (Verizon)',5,'CELL','','uplink'],[746,756,'LTE B13 DL',5,'CELL','','downlink'],
  [788,798,'LTE B14 UL (FirstNet)',5,'CELL','','uplink'],[758,768,'LTE B14 DL',5,'CELL','','downlink'],
  [617,652,'LTE B71 DL (US 600)',5,'CELL','','downlink'],[663,698,'LTE B71 UL',5,'CELL','','uplink']]);
P['Cellular/GSM-R, TETRA, P25, trunking']=bdM([
  [876,880,'GSM-R UL',0.2,'UTIL','железнодорожная связь ЕС, 4 MHz','rail'],[921,925,'GSM-R DL',0.2,'UTIL','','rail'],
  [380,385,'TETRA UL (emergency)',0.025,'UTIL','полиция/скорая ЕС','trunk'],[390,395,'TETRA DL (emergency)',0.025,'UTIL','','trunk'],
  [410,430,'TETRA civil / PMR',0.025,'UTIL','','trunk'],[450,470,'UHF PMR / trunk',0.0125,'UTIL','DMR/dPMR/NXDN','trunk'],
  [764,776,'P25 700 DL',0.0125,'UTIL','США','trunk'],[794,806,'P25 700 UL',0.0125,'UTIL','','trunk'],
  [806,824,'800 MHz trunking UL',0.0125,'UTIL','США MPT/P25/LTR','trunk'],[851,869,'800 MHz trunking DL',0.0125,'UTIL','','trunk'],
  [136,174,'VHF PMR / business',0.0125,'UTIL','аналог/DMR','trunk'],[151.725,156,'Railway VHF (RU)',0.025,'UTIL','РЖД','rail']]);

/* ---------- Voice: CB / PMR / FRS / MURS / Freenet ---------- */
const CB=[26.965,26.975,26.985,27.005,27.015,27.025,27.035,27.055,27.065,27.075,27.085,27.105,27.115,27.125,27.135,27.155,27.165,27.175,27.185,27.205,27.215,27.225,27.255,27.235,27.245,27.265,27.275,27.285,27.295,27.305,27.315,27.325,27.335,27.345,27.355,27.365,27.375,27.385,27.395,27.405];
P['Voice/CB 27 MHz (40 ch)']=bdC(CB.map((f,i)=>[f,0.01,'CB ch'+(i+1)+' '+f.toFixed(3),0.01,'SRD',i===8?'ch9 — аварийный канал':i===18?'ch19 — дальнобойщики':'AM/FM 4 W (EU), AM 4 W / SSB 12 W (США); ch9 — аварийный, ch19 — дальнобойщики','channel']));
P['Voice/PMR446 + LPD433 + FRS + GMRS + MURS + Freenet']=bdC([
  ...rng(1,8).map(c=>[446.00625+0.0125*(c-1),0.0125,'PMR446 ch'+c+' '+f3(446.00625+0.0125*(c-1)),0.0125,'SRD','аналог 12.5 kHz, 0.5 W','channel']),
  ...rng(9,16).map(c=>[446.10625+0.0125*(c-9),0.0125,'PMR446 ch'+c+' '+f3(446.10625+0.0125*(c-9)),0.0125,'SRD','12.5 kHz (EU 2018+) / dPMR/DMR Tier I 6.25 kHz','channel']),
  ...rng(1,69).map(c=>[433.075+0.025*(c-1),0.025,'LPD433 ch'+c+' '+f3(433.075+0.025*(c-1)),0.025,'SRD','25 kHz, 10 mW','channel']),
  ...[462.5625,462.5875,462.6125,462.6375,462.6625,462.6875,462.7125].map((f,i)=>[f,0.0125,'FRS ch'+(i+1)+' '+f,0.0125,'SRD','FRS/GMRS США','channel']),
  ...[467.5625,467.5875,467.6125,467.6375,467.6625,467.6875,467.7125].map((f,i)=>[f,0.0125,'FRS ch'+(i+8)+' '+f,0.0125,'SRD','FRS 0.5 W','channel']),
  ...[462.55,462.575,462.6,462.625,462.65,462.675,462.7,462.725].map((f,i)=>[f,0.025,'GMRS ch'+(i+15)+' '+f,0.025,'SRD','GMRS 5–50 W (лицензия)','channel']),
  ...[151.82,151.88,151.94,154.57,154.6].map((f,i)=>[f,0.0125,'MURS ch'+(i+1)+' '+f,0.0125,'SRD','США, без лицензии, 2 W','channel']),
  ...[149.025,149.0375,149.05,149.0625,149.075,149.0875].map((f,i)=>[f,0.0125,'Freenet '+(i+1)+' '+f,0.0125,'SRD','РФ/DE 149 MHz, 12.5 kHz','channel'])]);

/* ---------- Регистрация и перенос старых имён ---------- */
const MOVE={'Russia (full)':'Combined/Russia (full)','ISM / license-free':'ISM & SRD/ISM license-free','FM broadcast':'Broadcast/FM',
  'Broadcast (LW/MW/SW/FM/TV)':'Broadcast/LW MW SW FM TV','Utility / services (RU)':'Services/Utility (RU)','Airband':'Services/Airband',
  'Marine VHF':'Services/Marine VHF','Amateur radio (simplified)':'Amateur/Simplified','Amateur radio (by mode, IARU R1/RU)':'Amateur/By mode (IARU R1, RU)',
  'LPD433 / PMR446 (license-free voice)':'Voice/LPD433 + PMR446 (2 bands)','HF Broadcast (5kHz channels)':'Broadcast/HF 5 kHz channels',
  'GSM downlink (ARFCN bands)':'Cellular/GSM downlink (ARFCN)'};
for(const o in MOVE) if(BANDPLAN_PRESETS[o]) BANDPLAN_PRESETS[MOVE[o]]=BANDPLAN_PRESETS[o];
Object.assign(BANDPLAN_PRESETS,P);
window.BP_ALIAS=MOVE;                                     // старое имя → новое
window.BP_LEGACY=new Set(Object.keys(MOVE));              // в дереве скрыты, но патчи со старыми именами работают
})();
