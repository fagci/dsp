"use strict";
/* ============================ GSM: приём бёрстов из IQ ============================
 * Порт приёмного тракта gr-gsm (ptrkrysik/gr-gsm, GPLv3) и SCH/BCCH-декодера из
 * libosmocore (osmocom/libosmocore, GPLv2+): FCCH → SCH → синхронизация →
 * разбор бёрстов на TS0 нисходящего канала → BCCH/System Information. Даёт то, что
 * просили — «принимать пакеты с IQ»: несущая C0 ловится, кадры нумеруются, бёрсты
 * выдаются битами, из BCCH вытаскивается сота целиком (PLMN/LAC/CID, ARFCN свои и
 * соседние, RACH-параметры).
 *
 * Что готово:
 *   [ГОТОВО] MLSE-детектор (Витерби по каналу) — viterbiDetector, порт 1:1
 *   [ГОТОВО] оценка импульсной характеристики по обучающей последовательности
 *   [ГОТОВО] FCCH-поиск (частотная коррекция несущей) — findFcch, порт 1:1
 *   [ГОТОВО] SCH: свёрточный код G0/G1, CRC-16/10 (0x175), разбор BSIC/FN
 *            — свои энкодер/Витерби сверены с osmo_conv (порядок бит r=(state<<1)|bit),
 *            round-trip и сквозной прогон через бёрст в тестах
 *   [ГОТОВО] BCCH/xCCH: деперемежение + свёрточный код K=5 + FIRE CRC-40 → L2,
 *            разбор SI1/SI2/SI3/SI4 (Cell ID, LAI, список ARFCN — все форматы Frequency List:
 *            bitmap0, range1024/512/256/128, variable bitmap — RACH Control, Control
 *            Channel/Cell Options/Cell Selection — под debug) и офлайн-таблица PLMN→оператор
 *   [ГОТОВО] SI13 (GPRS-индикатор соты: PBCCH или RAC+параметры доступа)
 *   [ГОТОВО] CBCH/SMSCB (TS 04.12/03.41): детектор из CBCH Channel Description в SI4
 *            (TN/подканал/TSC/ARFCN, ARFCN→частота) + сам демультиплексор и декод, если
 *            CBCH на той же несущей, что идёт приём (частоты совпали, не hopping):
 *            позиции блока сверены с планировщиком osmo-bts, 4 блока → CBS-страница,
 *            GSM7/UCS2/8-bit
 *   [ГОТОВО] SI2quater: список соседей 3G (UTRAN FDD/TDD, UARFCN + scrambling code/cell
 *            parameter через тот же range-алгоритм, что и Frequency List) — порт f_k() и
 *            convert_n_to_p/q 1:1 из Wireshark packet-gsm_a_rr.c, сверен на ручном
 *            битовом векторе. Редкие legacy GPRS-подблоки (RTD/BSIC/Report Priority/Meas
 *            Param Description) — только детектируются, не разбираются
 *   [ГОТОВО] нумерация бёрстов (t1/t2/t3 → FN, TN) и типизация по 51-мультикадру TS0
 *   [ГОТОВО] внутренняя частотная петля: дерот. входа по накопленному смещению
 *
 *   [ГОТОВО] CCCH на TS0 (paging, immediate assignment / extended / reject): те же 4 бёрста → xCCH → L2; блоки 6–9, 12–15,
 *            16–19 (объединённый с SDCCH/4) или все девять (по CCCH-CONF из SI3). Идентификаторы абонентов в paging — хэш-маркер
 *            или ничего (параметр ids), подробности — у функции gsmParseCcch
 *
 * Не разобрано: CBCH на другой несущей или
 * hopping — только детектируется (TN/ARFCN/частота), сам канал не декодируется без
 * отдельного приёма на той частоте.
 * Uplink не принимается — только downlink (FCCH/SCH есть только там).
 *
 * Вход — поток 'iq', любой sr выше ~1.1 МГц; внутри ресемплится на OSR·270.833 кГц.
 * Из трафика конкретных абонентов (SDCCH/FACCH/TCH, адресованного MS по TMSI/IMSI)
 * декодируются только сырые биты бёрста — узел не лезет в содержимое звонков/SMS
 * конкретных людей. CBCH — исключение: открытый широковещательный канал без адресации
 * (оповещения всем в соте), а не связь конкретного абонента. */

// 51-мультикадр TS0 (нисходящий): FCCH на 0/10/20/30/40, SCH на 1/11/21/31/41, прочее — норм/dummy
const GSM_FCCH_FRAMES=new Set([0,10,20,30,40]);
const GSM_SCH_FRAMES=new Set([1,11,21,31,41]);

/* ---------- GMSK-раскладка бит в опорную комплексную последовательность ---------- */
// gr-gsm gmsk_mapper: дифференциальное кодирование + умножение на j (порт 1:1)
function gsmGmskMapper(bits, nitems, startRe, startIm){
  const re=new Float32Array(nitems), im=new Float32Array(nitems);
  re[0]=startRe; im[0]=startIm;
  let prev=2*bits[0]-1;
  for(let i=1;i<nitems;i++){
    const cur=2*bits[i]-1, enc=cur*prev;                 // NRZ + дифф. кодирование
    re[i]=-enc*im[i-1]; im[i]=enc*re[i-1];               // умножение на j·enc
    prev=cur;
  }
  return {re,im};
}

/* ---------- MLSE-детектор бёрста (gr-gsm viterbi_detector.cc, порт 1:1) ---------- */
// input — комплексный сигнал после согласованного фильтра, rhh — автокорреляция канала.
// output — дифференциально декодированные жёсткие решения (-1/1).
function gsmViterbiDetector(inRe, inIm, samplesNum, rhhRe, rhhIm, startState, stopStates, output){
  const inc=new Float32Array(8);
  let pm1=new Float32Array(16), pm2=new Float32Array(16);
  const trans=[]; for(let i=0;i<samplesNum;i++) trans.push(new Float32Array(16));
  inc[0]=-rhhIm[1]-rhhRe[2]-rhhIm[3]+rhhRe[4];
  inc[1]= rhhIm[1]-rhhRe[2]-rhhIm[3]+rhhRe[4];
  inc[2]=-rhhIm[1]+rhhRe[2]-rhhIm[3]+rhhRe[4];
  inc[3]= rhhIm[1]+rhhRe[2]-rhhIm[3]+rhhRe[4];
  inc[4]=-rhhIm[1]-rhhRe[2]+rhhIm[3]+rhhRe[4];
  inc[5]= rhhIm[1]-rhhRe[2]+rhhIm[3]+rhhRe[4];
  inc[6]=-rhhIm[1]+rhhRe[2]+rhhIm[3]+rhhRe[4];
  inc[7]= rhhIm[1]+rhhRe[2]+rhhIm[3]+rhhRe[4];
  for(let i=0;i<16;i++) pm1[i]=-10e30;
  pm1[startState]=0;
  let sampleNr=0, oldPm=pm1, newPm=pm2, realImag=1;
  const acs=(t,idx,c1,c2)=>{ const d=c2-c1; newPm[idx]=d<0?c1:c2; t[idx]=d; };
  while(sampleNr<samplesNum){
    // мнимые состояния
    realImag=1;
    const yi=inIm[sampleNr], t=trans[sampleNr];
    acs(t,0, oldPm[0]+yi-inc[2], oldPm[8]+yi+inc[5]);
    acs(t,1, oldPm[0]-yi+inc[2], oldPm[8]-yi-inc[5]);
    acs(t,2, oldPm[1]+yi-inc[3], oldPm[9]+yi+inc[4]);
    acs(t,3, oldPm[1]-yi+inc[3], oldPm[9]-yi-inc[4]);
    acs(t,4, oldPm[2]+yi-inc[0], oldPm[10]+yi+inc[7]);
    acs(t,5, oldPm[2]-yi+inc[0], oldPm[10]-yi-inc[7]);
    acs(t,6, oldPm[3]+yi-inc[1], oldPm[11]+yi+inc[6]);
    acs(t,7, oldPm[3]-yi+inc[1], oldPm[11]-yi-inc[6]);
    acs(t,8, oldPm[4]+yi-inc[6], oldPm[12]+yi+inc[1]);
    acs(t,9, oldPm[4]-yi+inc[6], oldPm[12]-yi-inc[1]);
    acs(t,10,oldPm[5]+yi-inc[7], oldPm[13]+yi+inc[0]);
    acs(t,11,oldPm[5]-yi+inc[7], oldPm[13]-yi-inc[0]);
    acs(t,12,oldPm[6]+yi-inc[4], oldPm[14]+yi+inc[3]);
    acs(t,13,oldPm[6]-yi+inc[4], oldPm[14]-yi-inc[3]);
    acs(t,14,oldPm[7]+yi-inc[5], oldPm[15]+yi+inc[2]);
    acs(t,15,oldPm[7]-yi+inc[5], oldPm[15]-yi-inc[2]);
    let tmp=oldPm; oldPm=newPm; newPm=tmp;
    sampleNr++;
    if(sampleNr===samplesNum) break;
    // вещественные состояния
    realImag=0;
    const yr=inRe[sampleNr], t2=trans[sampleNr];
    acs(t2,0, oldPm[0]-yr-inc[7], oldPm[8]-yr+inc[0]);
    acs(t2,1, oldPm[0]+yr+inc[7], oldPm[8]+yr-inc[0]);
    acs(t2,2, oldPm[1]-yr-inc[6], oldPm[9]-yr+inc[1]);
    acs(t2,3, oldPm[1]+yr+inc[6], oldPm[9]+yr-inc[1]);
    acs(t2,4, oldPm[2]-yr-inc[5], oldPm[10]-yr+inc[2]);
    acs(t2,5, oldPm[2]+yr+inc[5], oldPm[10]+yr-inc[2]);
    acs(t2,6, oldPm[3]-yr-inc[4], oldPm[11]-yr+inc[3]);
    acs(t2,7, oldPm[3]+yr+inc[4], oldPm[11]+yr-inc[3]);
    acs(t2,8, oldPm[4]-yr-inc[3], oldPm[12]-yr+inc[4]);
    acs(t2,9, oldPm[4]+yr+inc[3], oldPm[12]+yr-inc[4]);
    acs(t2,10,oldPm[5]-yr-inc[2], oldPm[13]-yr+inc[5]);
    acs(t2,11,oldPm[5]+yr+inc[2], oldPm[13]+yr-inc[5]);
    acs(t2,12,oldPm[6]-yr-inc[1], oldPm[14]-yr+inc[6]);
    acs(t2,13,oldPm[6]+yr+inc[1], oldPm[14]+yr-inc[6]);
    acs(t2,14,oldPm[7]-yr-inc[0], oldPm[15]-yr+inc[7]);
    acs(t2,15,oldPm[7]+yr+inc[0], oldPm[15]+yr-inc[7]);
    tmp=oldPm; oldPm=newPm; newPm=tmp;
    sampleNr++;
  }
  let bestStop=stopStates[0], maxM=oldPm[bestStop];
  for(let i=1;i<stopStates.length;i++){ const m=oldPm[stopStates[i]];
    if(m>maxM){ maxM=m; bestStop=stopStates[i]; } }
  const parity=[0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0];
  const prev=[[0,8],[0,8],[1,9],[1,9],[2,10],[2,10],[3,11],[3,11],
              [4,12],[4,12],[5,13],[5,13],[6,14],[6,14],[7,15],[7,15]];
  sampleNr=samplesNum;
  let state=bestStop, outBit=0;
  while(sampleNr>0){
    sampleNr--;
    const decision=trans[sampleNr][state]>0?1:0;
    output[sampleNr]=(decision!==outBit)?-trans[sampleNr][state]:trans[sampleNr][state];
    outBit=outBit^realImag^parity[state];
    state=prev[state][decision];
    realImag=realImag?0:1;
  }
}

/* ---------- SCH: свёрточный код (G0=0o31, G1=0o33), CRC-10, разбор ---------- */
// Витерби K=5 (G0/G1) по 2·STEPS мягким битам (sbit: 0→+, 1→−) → STEPS инф. бит.
// Хвост из 4 нулей → конечное состояние 0. Тот же код у SCH (39 шагов) и xCCH (228).
function gsmConvK5(sb, steps){
  const NS=16, NEG=-1e9;
  let pm=new Float32Array(NS).fill(NEG); pm[0]=0;
  let npm=new Float32Array(NS);
  const back=[]; for(let i=0;i<steps;i++) back.push(new Uint8Array(NS));
  for(let i=0;i<steps;i++){
    npm.fill(NEG);
    const s0=sb[2*i], s1=sb[2*i+1];
    for(let st=0;st<NS;st++){
      if(pm[st]<=NEG/2) continue;
      for(let bit=0;bit<2;bit++){
        const r=(st<<1)|bit, o0=gsmParity(r&GSM_G0), o1=gsmParity(r&GSM_G1);
        const m=pm[st]+(o0?-s0:s0)+(o1?-s1:s1), ns=r&0xf;   // корреляция: sbit>0 → бит 0
        if(m>npm[ns]){ npm[ns]=m; back[i][ns]=(st<<1)|bit; }
      }
    }
    const t=pm; pm=npm; npm=t;
  }
  const u=new Int8Array(steps); let st=0;
  for(let i=steps-1;i>=0;i--){ const b=back[i][st]; u[i]=b&1; st=b>>1; }
  return u;
}
function gsmSchConvDecode(sb){ return gsmConvK5(sb,39).subarray(0,35); }
// e-биты бёрста (148, 0/1) → {t1,t2,t3,ncc,bcc} или null (CRC не сошёлся)
function gsmDecodeSch(eb){
  const sb=new Int8Array(78);
  for(let i=0;i<GSM_SCH_DATA_LEN;i++){ sb[i]=eb[3+i]?-127:127;
    sb[GSM_SCH_DATA_LEN+i]=eb[3+GSM_SCH_DATA_LEN+GSM_N_SYNC+i]?-127:127; }
  const u=gsmSchConvDecode(sb);
  if(gsmSchCrc10(u,25)!==((u[25]<<9)|(u[26]<<8)|(u[27]<<7)|(u[28]<<6)|(u[29]<<5)|
      (u[30]<<4)|(u[31]<<3)|(u[32]<<2)|(u[33]<<1)|u[34])) return null;
  const d=u;   // 25 бит sb_info, порядок как в gr-gsm sch.c
  const ncc=(d[7]<<2)|(d[6]<<1)|d[5];
  const bcc=(d[4]<<2)|(d[3]<<1)|d[2];
  const t1=(d[1]<<10)|(d[0]<<9)|(d[15]<<8)|(d[14]<<7)|(d[13]<<6)|(d[12]<<5)|
           (d[11]<<4)|(d[10]<<3)|(d[9]<<2)|(d[8]<<1)|d[23];
  const t2=(d[22]<<4)|(d[21]<<3)|(d[20]<<2)|(d[19]<<1)|d[18];
  const t3p=(d[17]<<2)|(d[16]<<1)|d[24];
  const t3=10*t3p+1;
  return {t1,t2,t3,ncc,bcc};
}

/* ---------- BCCH/CCCH: xCCH-декодер (libosmocore gsm0503) + разбор System Information ----------
 * 4 нормальных бёрста → деперемежение → свёрточный код K=5 (G0/G1) → FIRE CRC-40 →
 * 23 байта L2 → RR-сообщение. Из SI3 берём Cell ID и LAI (MCC/MNC/LAC) — идентификатор соты.
 * Из SI1/SI2 — список ARFCN (своей соты и соседних, все форматы Frequency List — bitmap0, range1024/
 * 512/256/128, variable bitmap, сверено с dissect_arfcn_list_core/f_k из Wireshark
 * epan/dissectors/packet-gsm_a_rr.c) и RACH Control Parameters (TS 04.08 10.5.2.29). */

// наибольшая степень двойки, не превосходящая idx (TS 04.08 10.5.2.13, функция для range-форматов)
function gsmPow2Le(idx){ let j=1; do{ j<<=1; } while(j<=idx); return j>>1; }
// f_k: k-я по порядку ARFCN внутри диапазона range, восстановленная из W-массива (TS 04.08 10.5.2.13
// Annex, алгоритм "range encoding"); сверено с f_k() из Wireshark packet-gsm_a_rr.c построчно
function gsmFk(k, w, range){
  let idx=k; range-=1; range=Math.floor(range/gsmPow2Le(idx));
  let n=w[idx]-1;
  while(idx>1){
    const j=gsmPow2Le(idx); range=2*range+1;
    if(2*idx<3*j){ idx-=j>>1; n=(n+w[idx]-1+Math.floor((range-1)/2)+1)%range; }
    else { idx-=j; n=(n+w[idx]-1+1)%range; }
  }
  return (n+1)%1024;
}
// range1024/512/256/128: первый ARFCN (f0 либо ORIG, явно в заголовке) + W-массив переменной
// битности (10 бит, затем 9,9,8,8,8,8,7×8,... — удваивается группа, ширина убывает на 1), вплоть
// до первого нулевого элемента или конца IE; f_k() переводит W-значения в сами номера ARFCN
function gsmRangeDecode(b, off, len, range){
  const r=new GsmBitReader(b, off*8+(range===1024?6:7));
  let arfcnOrig=0; const list=[];
  if(range===1024){ if((b[off]>>2)&1) list.push(0); }
  else { arfcnOrig=r.bits(10); list.push(arfcnOrig); }
  const wsize0={1024:10,512:9,256:8,128:7}[range], imax={1024:16,512:17,256:21,128:28}[range];
  const w=new Array(imax+1).fill(0);
  let wsize=wsize0, nwi=1, jwi=0, iused=imax;
  for(let i=1;i<=imax;i++){
    w[i]=r.bits(wsize);
    const curOff=r.pos>>3;
    // в оригинале (dissect_channel_list_n_range) тут нет break — цикл дочитывает все imax
    // элементов, просто не используя их дальше; iused после первого нуля уже не меняется
    // (условие iused===imax больше не сработает), так что на итоговый список ARFCN это не влияет —
    // останавливаемся раньше, нам не нужна точная позиция конца IE для разбора чего-то следом
    if(iused===imax && w[i]===0){ iused=i-1; break; }
    if((curOff-off)>len){ iused=i-1; break; }
    if(++jwi===nwi){ jwi=0; nwi<<=1; wsize--; }
  }
  for(let i=1;i<=iused;i++) list.push((gsmFk(i,w,range)+arfcnOrig)%1024);
  return [...new Set(list)].sort((a,b2)=>a-b2);
}
// variable bitmap: база ARFCN из 10 бит (1 из FORMAT-ID + следующий байт + старший бит третьего),
// дальше обычный битмап (бит=1 → ARFCN=база+позиция, по модулю 1024), а не «сверху вниз», как bitmap0
function gsmVarBitmapDecode(b, off, len){
  let arfcn=((b[off]&0x01)<<9)|(b[off+1]<<1)|((b[off+2]&0x80)>>7);
  const list=[]; let pos=off+2, bit=7;
  for(let byte=0; byte<=len-3; byte++){
    const oct=b[pos];
    while(bit-->0){ arfcn++; if((oct>>bit)&1) list.push(arfcn%1024); }
    bit=8; pos++;
  }
  return list.sort((a,b2)=>a-b2);
}
// Список частот (TS 04.08 10.5.2.13): off — байт с FORMAT-ID, len — длина IE (16 байт для SI1/SI2).
// bitmap 0: первый байт даёт только 4 младших бита данных (старшие 4 — FORMAT-ID), дальше 8 бит/байт.
function gsmDecodeFreqList(b, off, len){
  const format=b[off];
  if((format&0xc0)===0x00){
    const arfcns=[]; let bit=4, arfcn=125;
    for(let byte=0; byte<len; byte++){
      const oct=b[off+byte];
      while(bit-->0){ arfcn--; if((oct>>bit)&1) arfcns.push(arfcn); }
      bit=8;
    }
    return {format:'bitmap0', arfcns};
  }
  if((format&0xc8)===0x80) return {format:'range1024', arfcns:gsmRangeDecode(b,off,len,1024)};
  if((format&0xce)===0x88) return {format:'range512', arfcns:gsmRangeDecode(b,off,len,512)};
  if((format&0xce)===0x8a) return {format:'range256', arfcns:gsmRangeDecode(b,off,len,256)};
  if((format&0xce)===0x8c) return {format:'range128', arfcns:gsmRangeDecode(b,off,len,128)};
  if((format&0xce)===0x8e) return {format:'varbitmap', arfcns:gsmVarBitmapDecode(b,off,len)};
  return {format:'other', arfcns:[]};
}
const GSM_TX_INTEGER=[3,4,5,6,7,8,9,10,11,12,14,16,20,25,32,50];
const GSM_MAX_RETRANS=[1,2,4,7];
// RACH Control Parameters (TS 04.08 10.5.2.29), 3 байта с off
function gsmDecodeRach(b, off){
  const o1=b[off];
  return { maxRetrans:GSM_MAX_RETRANS[(o1>>6)&3], txInteger:GSM_TX_INTEGER[(o1>>2)&0xf],
    cellBarred:!!(o1&0x02), reAllowed:!(o1&0x01), acc:(b[off+1]<<8)|b[off+2] };
}
// Control Channel Description (TS 04.08 10.5.2.11), 3 байта с off — конфигурация CCCH/SDCCH соты
function gsmDecodeCtrlCh(b, off){
  const o1=b[off], o2=b[off+1];
  return { mscr:!!(o1&0x80), att:!!(o1&0x40), bsAgBlksRes:(o1>>3)&7, ccchConf:o1&7,
    cbq3:(o2>>5)&3, bsPaMfrms:(o2&7)+2, t3212min:b[off+2]*6 };
}
// CCCH-CONF (3 бита): объединён ли CCCH с SDCCH и сколько физ. каналов под CCCH
const GSM_CCCH_CONF=['1 канал CCCH, не объединён с SDCCH','1 канал CCCH, объединён с SDCCH',
  '2 канала CCCH, не объединён','резерв','3 канала CCCH, не объединён','резерв','4 канала CCCH, не объединён','резерв'];
// Cell Options BCCH (TS 04.08 10.5.2.3), 1 байт с off
function gsmDecodeCellOpt(b, off){
  const o=b[off];
  return { pwrc:!!(o&0x40), dtx:(o>>4)&3, radioLinkTimeout:(((o&0x0f))+1)*4 };
}
// Cell Selection Parameters (TS 04.08 10.5.2.4), 2 байта с off
function gsmDecodeCellSel(b, off){
  const o1=b[off], o2=b[off+1];
  return { cellReselectHyst:((o1>>5)&7)*2, msTxpwrMaxCch:o1&0x1f,
    acs:!!(o2&0x80), neci:!!(o2&0x40), rxlevAccessMin:o2&0x3f };
}
// CBCH Channel Description: опциональный TV-элемент (IEI 0x64) сразу после RACH в SI4 (TS 04.08
// 10.5.2.5 Channel Description); если байта 0x64 нет — CBCH на соте не настроен (обычный случай).
function gsmDecodeCbch(b, off){
  if(b[off]!==0x64) return {present:false};
  const o1=b[off+1], o2=b[off+2], o3=b[off+3];
  const tn=o1&7;
  let kind='?', sub=0;
  if((o1&0xf8)===0x08) kind='TCH/F+ACCHs';
  else if((o1&0xf0)===0x10){ kind='TCH/H+ACCH'; sub=(o1>>3)&1; }
  else if((o1&0xe0)===0x20){ kind='SDCCH/4+CBCH'; sub=(o1>>3)&3; }
  else if((o1&0xc0)===0x40){ kind='SDCCH/8+CBCH'; sub=(o1>>3)&7; }
  const tsc=(o2>>5)&7, hopping=!!(o2&0x10);
  const r={present:true, tn, kind, sub, tsc, hopping};
  if(hopping){ r.maio=((o2&0x0f)<<2)|((o3&0xc0)>>6); r.hsn=o3&0x3f; }
  else { r.arfcn=((o2&0x03)<<8)|o3; r.freq=gsmArfcnFreq(r.arfcn); }
  return r;
}

/* ---------- Rest Octets: побитовый CSN.1-разбор (SI13, позже SI2quater/range-форматы) ----------
 * Биты нумеруются как в GSM: bitOffset 0 = старший бит байта 0. За пределами массива отдаёт 0
 * (стандартный "спэйр" заполнитель) — удобно для опциональных полей без явной длины сообщения. */
class GsmBitReader{
  constructor(bytes, bitOffset=0){ this.b=bytes; this.pos=bitOffset; this.end=bytes.length*8; }
  bit(){ if(this.pos>=this.end) return 0; const byte=this.b[this.pos>>3], bit=7-(this.pos&7); this.pos++; return (byte>>bit)&1; }
  bits(n){ let v=0; for(let i=0;i<n;i++) v=(v<<1)|this.bit(); return v; }
  flag(){ return this.bit()===1; }   // H/L-флаг CSN.1: обычно 1 = «далее есть поле/повтор»
  left(){ return this.end-this.pos; }
}
// GPRS Mobile Allocation (TS 04.08 вложенный в SI13 Rest Octets) — структура переменной длины,
// нужно только правильно пройти (для выравнивания битов), содержимое (хоппинг GPRS) не используем
function gsmSkipGprsMobileAlloc(r){
  r.bits(6);                                            // HSN
  while(r.flag()) r.bits(4);                            // RFL number list
  if(r.flag()) while(r.flag()) r.bits(6);                // ARFCN index list
  else { const len=r.bits(6); r.bits(len+1); }           // либо явный MA-битмап длиной len+1 бит
}
// SI13 Rest Octets (TS 04.08 10.5.2.37b): GPRS-индикатор соты, PBCCH или обычный RAC+параметры.
// Останавливаемся сразу после нужных нам полей — Additions in Rel-99/4/6 за ними не разбираем,
// там для нас ничего интересного, а для выравнивания битов дальше они и не нужны.
function gsmDecodeSi13(b){
  const r=new GsmBitReader(b, 3*8);                     // Rest Octets начинаются с байта 3 (после PD+msg type)
  if(!r.flag()) return {present:false};                 // SI13 contents отсутствует — редкий случай (пустое SI13)
  const res={present:true, bcchChangeMark:r.bits(3), siChangeField:r.bits(4)};
  if(r.flag()){ r.bits(2); gsmSkipGprsMobileAlloc(r); }  // SI13 change mark + GPRS Mobile Allocation — пропускаем
  if(r.flag()){                                          // PBCCH присутствует в соте
    res.psi1RepeatPeriod=r.bits(4);
    res.pbcch={pb:r.bits(4), tsc:r.bits(3), tn:r.bits(3)};
    if(r.flag()) res.pbcch.maio=r.bits(6);
    else if(r.flag()) res.pbcch.arfcn=r.bits(10);
  } else {                                               // PBCCH не настроен — пакетные данные идут по BCCH/CCCH
    res.rac=r.bits(8);
    res.spgcCcchSup=r.flag();
    res.priorityAccessThr=r.bits(3);
    res.networkControlOrder=r.bits(2);
  }
  return res;
}

/* ---------- SI2quater: список 3G/LTE-соседей (TS 04.08 10.5.2.33b) ----------
 * Самый навороченный элемент во всём разборе: цепочка опциональных вложенных блоков, из которых
 * нас интересует только «3G Neighbour Cell Description» → UTRAN FDD/TDD списки (ARFCN + scrambling
 * code каждой ячейки). Списки кодируются той же range-упаковкой (W-массив → gsmFk), что и Frequency
 * List, только длина W-поля в битах даётся готовой таблицей (convert_n_to_p/q), а не выводится из
 * длины целого IE. Четыре опциональных GPRS-блока перед этим (RTD/BSIC/ReportPriority/MeasParam
 * Description) — объёмные вложенные структуры почти не встречающиеся на практике (наследие
 * GPRS-эпохи); если какой-то из них присутствует, останавливаемся честно, вместо риска тихо
 * съехать по биту и выдать неверный список соседей. Сверено построчно с packet-gsm_a_rr.c:
 * de_rr_si2quater_rest_oct, de_rr_si2quater_meas_info_utran_fdd_desc/tdd_desc, convert_n_to_p/q. */
// индекс NR_OF_xDD_CELLS (5 бит) → длина поля с W-массивом, бит (TS 04.08 10.5.2.1e)
const GSM_CONVERT_N_TO_P=[0,10,19,28,36,44,52,60,67,74,81,88,95,102,109,116,122,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
const GSM_CONVERT_N_TO_Q=[0,9,17,25,32,39,46,53,59,65,71,77,83,89,95,101,106,111,116,121,126,0,0,0,0,0,0,0,0,0,0,0];
// W-массив диапазон-кодированных ячеек внутри поля заранее известной длины bitLen. Позиция ридера
// после вызова всегда ровно start+bitLen — надёжнее побитового повтора оригинала (там выравнивание
// при раннем нулевом элементе внутри выделенного под поле бюджета бит явно не задокументировано).
function gsmReadRangeCells(r, bitLen, wsize0, range){
  const start=r.pos; if(!bitLen) return [];
  let wsize=wsize0, nwi=1, jwi=0, i=1; const w=[]; let left=bitLen;
  while(left>0){
    w[i]=r.bits(wsize); left-=wsize;
    if(w[i]===0) break;
    if(++jwi===nwi){ jwi=0; nwi<<=1; wsize--; }
    i++;
  }
  // i-1 верно в обоих случаях выхода из цикла: при break на нулевом элементе i ещё не увеличен
  // (указывает на сам нулевой элемент), при естественном завершении (left<=0) i уже увеличен после
  // последнего прочитанного элемента — итог один и тот же, как и в оригинале (iused=i-1 безусловно)
  const iused=i-1;
  const list=[]; for(let k=1;k<=iused;k++) list.push(gsmFk(k,w,range));
  r.pos=start+bitLen;                                   // жёстко фиксируем конец поля
  return list;
}
function gsmUtranFddDecode(r){
  const res={cells:[]};
  if(r.flag()) res.bandwidth=r.bits(3);
  while(r.flag()){
    r.bit();                                             // зарезервированный бит (earlier version)
    const uarfcn=r.bits(14), hasParam0=r.flag();
    const n=r.bits(5), bitLen=GSM_CONVERT_N_TO_P[n]||0;
    const codes=gsmReadRangeCells(r,bitLen,10,1024).map(v=>({scramblingCode:v&0x1ff, diversity:(v>>9)&1}));
    res.cells.push({uarfcn, hasParam0, codes});
  }
  return res;
}
function gsmUtranTddDecode(r){
  const res={cells:[]};
  if(r.flag()) res.bandwidth=r.bits(3);
  while(r.flag()){
    r.bit();
    const uarfcn=r.bits(14), hasParam0=r.flag();
    const n=r.bits(5), bitLen=GSM_CONVERT_N_TO_Q[n]||0;
    const codes=gsmReadRangeCells(r,bitLen,9,512).map(v=>({cellParameter:v&0x7f, syncCaseTstd:(v>>7)&1, diversity:(v>>8)&1}));
    res.cells.push({uarfcn, hasParam0, codes});
  }
  return res;
}
function gsmDecodeSi2quater(b){
  const r=new GsmBitReader(b, 3*8);
  const res={baInd:r.bit(), ba3gInd:r.bit(), mpChangeMark:r.bit(), index:r.bits(4), count:r.bits(4)};
  if(r.flag()) r.bits(3);                                // Measurement Parameters Description — не используем
  for(const name of ['RTD','BSIC','Report Priority','GPRS Measurement Parameters']){
    if(r.flag()){ res.note=`доп. GPRS-описание (${name}) присутствует — дальше не разобрано`; return res; }
  }
  if(r.flag()){                                          // NC Measurement Parameters
    res.networkControlOrder=r.bits(2);
    if(r.flag()){ res.ncNonDrxPeriod=r.bits(3); res.ncReportingPeriodI=r.bits(3); res.ncReportingPeriodT=r.bits(3); }
  }
  if(r.flag()){ const extStart=r.pos, len=r.bits(8); r.pos=extStart+8+len; }  // Extension Info — по явной длине
  if(r.flag()){                                          // 3G Neighbour Cell Description — ради чего всё это
    const g={};
    if(r.flag()) g.indexStart3g=r.bits(7);
    if(r.flag()) g.absoluteIndexStartEmr=r.bits(7);
    if(r.flag()) g.utranFdd=gsmUtranFddDecode(r);
    if(r.flag()) g.utranTdd=gsmUtranTddDecode(r);
    res.neighbors3g=g;
  }
  return res;
}
// ARFCN → частота нисходящего канала, МГц (TS 05.05 табл. диапазонов); null — ARFCN вне известных
// диапазонов. Пригодится, когда интересующий канал (например, CBCH) лежит не на той несущей, на
// которой идёт приём — её можно прочитать здесь и перестроиться туда отдельной записью.
function gsmArfcnFreq(n){
  if(n>=0 && n<=124) return 935+0.2*n;                    // P-GSM 900
  if(n>=975 && n<=1023) return 935+0.2*(n-1024);           // E-GSM 900 (расширение вниз от 935)
  if(n>=955 && n<=974) return 935+0.2*(n-1024);            // R-GSM 900
  // DCS1800 (512-885) и PCS1900 (512-810) делят номера ARFCN — без знания региона/диапазона тюнера
  // не различить; берём DCS1800 как более распространённый вне Северной Америки.
  if(n>=512 && n<=885) return 1805.2+0.2*(n-512);
  return null;
}
// частота downlink → частота uplink той же пары, МГц (дуплексный разнос TS 05.05): 45 МГц GSM900, 95 МГц DCS1800 —
// подсказка, на что настроить второй приёмник ('ul') на тестовом стенде; null — частота вне известных диапазонов
function gsmUplinkFreq(dlMHz){
  if(dlMHz==null) return null;
  if(dlMHz>=935 && dlMHz<=960) return dlMHz-45;
  if(dlMHz>=1805.2 && dlMHz<=1879.8) return dlMHz-95;
  return null;
}

/* ---------- CBCH/SMSCB (TS 04.12 CBCH block, TS 03.41 CBS message) ----------
 * Физика блока — тот же самый xCCH (4 нормальных бёрста → gsmBcchDecode), что и у BCCH/SDCCH, только
 * на другом таймслоте/позиции в 51-мультикадре. Позиции сверены с планировщиком osmo-bts
 * (src/common/scheduler_mframe.c, frame_sdcch8_cbch[102]): CBCH-блок (4 бёрста) — на FN mod 102 в
 * {8..11} и {59..62} таймслота из CBCH Channel Description. Один L2-блок (23 байта) = 1 байт
 * заголовка (LPD/LB/SEQ-NUM) + 22 байта данных; 4 блока (seq 0..3) складываются в CBS-страницу
 * 88 байт (TS 03.41: Serial Number 2 + Message ID 2 + DCS 1 + Page Parameter 1 + текст 82). */
const GSM_CBCH_FN=[8,59];                             // начала двух CBCH-окон в 102-кадровом цикле
// GSM 03.38 default alphabet (септеты 0..127; 27 — ESC на таблицу расширений)
const GSM7_TABLE='@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT={0x0a:'\f',0x14:'^',0x28:'{',0x29:'}',0x2f:'\\',0x3c:'[',0x3d:'~',0x3e:']',0x40:'|',0x65:'€'};
// распаковка упакованных септетов (TS 03.38 §6.1.2.1): LSB первого байта — младшие биты первого септета
function gsm7Unpack(bytes, numSeptets){
  const out=[]; let buf=0, bits=0, bi=0;
  while(out.length<numSeptets && bi<bytes.length){
    buf|=bytes[bi++]<<bits; bits+=8;
    while(bits>=7 && out.length<numSeptets){ out.push(buf&0x7f); buf>>=7; bits-=7; }
  }
  return out;
}
function gsm7Decode(bytes, numSeptets){
  const septets=gsm7Unpack(bytes, numSeptets);
  let s=''; let esc=false;
  for(const c of septets){
    if(esc){ s+=GSM7_EXT[c]||'?'; esc=false; }
    else if(c===27) esc=true;
    else s+=GSM7_TABLE[c]||'?';
  }
  return s.replace(/\r+$/,'');                        // хвостовая заливка CR (0x0D) — не часть текста
}
// DCS (TS 03.38 §5) — упрощённо: General Data Coding group различает кодировку явно, остальные
// группы (языковые/WAP/message handling) считаем GSM7 по умолчанию — это обычный случай для CBS.
function gsmDcsInfo(dcs){
  if((dcs&0xc0)===0x40){ const cs=(dcs>>2)&3;
    return {charset:['gsm7','8bit','ucs2','reserved'][cs]}; }
  return {charset:'gsm7'};
}
// заголовок CBCH-блока (TS 04.12 §3.4.2.2): spare(1)+LPD(2)+LB(1)+SEQ-NUM(4)
function gsmCbchHeader(o){
  return { lpd:(o>>5)&3, lb:!!(o&0x10), seq:o&0x0f };
}
// CBS-сообщение 88 байт (TS 03.41 §9.3.2) → {serial,msgId,dcs,charset,totalPages,pageNum,text}
function gsmCbsParse(p){
  const sn=(p[0]<<8)|p[1];
  const serial={gs:(sn>>14)&3, msgCode:(sn>>4)&0x3ff, updateNum:sn&0xf};
  const msgId=(p[2]<<8)|p[3], dcs=p[4], pp=p[5];
  const dc=gsmDcsInfo(dcs);
  let text;
  if(dc.charset==='gsm7') text=gsm7Decode(p.subarray(6,88),93);
  else if(dc.charset==='ucs2'){ text=''; for(let i=6;i+1<88;i+=2){ const cc=(p[i]<<8)|p[i+1]; if(cc) text+=String.fromCharCode(cc); } }
  else { let hex=''; for(let i=6;i<88;i++) hex+=p[i].toString(16).padStart(2,'0'); text='(8-bit) '+hex; }
  return {serial, msgId, dcs, charset:dc.charset, totalPages:(pp>>4)&0xf, pageNum:pp&0xf, text};
}

// деперемежение xCCH (TS 05.03 4.1.4): cB[k]=iB[B·114+j]
function gsmXcchDeinterleave(iB){
  const cB=new Float32Array(456);
  for(let k=0;k<456;k++){ const B=k&3, j=2*((49*k)%57)+((k&7)>>2); cB[k]=iB[B*114+j]; }
  return cB;
}
// 4×114 бит данных (0/1) → 23 байта L2 или null (CRC не сошёлся)
function gsmBcchDecode(four){
  const iB=new Float32Array(456);
  for(let B=0;B<4;B++){ const d=four[B]; for(let j=0;j<114;j++) iB[B*114+j]=d[j]?-127:127; }   // 0→+,1→−
  const cB=gsmXcchDeinterleave(iB);
  const conv=gsmConvK5(cB,228);                        // 224 данные+parity + 4 хвост
  const c=gsmFireCrc40(conv,184);                      // CRC по 184 = 40 бит четности
  for(let i=0;i<40;i++) if(conv[184+i]!==Number((c>>BigInt(39-i))&1n)) return null;
  // TS 04.08: бит 1 октета передаётся первым и является младшим (LSB) — conv[i*8+0] это бит0, не бит7
  const l2=new Uint8Array(23);
  for(let i=0;i<23;i++){ let v=0; for(let b=0;b<8;b++) v|=conv[i*8+b]<<b; l2[i]=v; }
  return l2;
}
// MCC/MNC из 3 BCD-байт LAI (osmocom gsm48_decode_lai)
function gsmMccMnc(d0,d1,d2){
  const mcc=(d0&0x0f)*100+((d0>>4)&0x0f)*10+(d1&0x0f);
  const mnc=((d1>>4)&0x0f)===0x0f ? (d2&0x0f)*10+((d2>>4)&0x0f)
                                  : (d2&0x0f)*100+((d2>>4)&0x0f)*10+((d1>>4)&0x0f);
  return {mcc, mnc, mnc2:((d1>>4)&0x0f)===0x0f};
}
// L2-кадр System Information → поля (GSM48_MT_RR_SYSINFO_*)
function gsmParseSI(b){
  if((b[1]&0x0f)!==0x06) return null;                  // PD ≠ RR
  const mt=b[2], r={si:mt};
  if(mt===0x1b){                                       // SI3: Cell Identity + LAI
    r.type='SI3'; r.ci=(b[3]<<8)|b[4];
    const m=gsmMccMnc(b[5],b[6],b[7]); r.mcc=m.mcc; r.mnc=m.mnc; r.mnc2=m.mnc2;
    r.lac=(b[8]<<8)|b[9];
    r.ctrlCh=gsmDecodeCtrlCh(b,10); r.cellOpt=gsmDecodeCellOpt(b,13); r.cellSel=gsmDecodeCellSel(b,14);
    r.rach=gsmDecodeRach(b,16);
  } else if(mt===0x1c){                                // SI4: LAI (без Cell Identity)
    r.type='SI4';
    const m=gsmMccMnc(b[3],b[4],b[5]); r.mcc=m.mcc; r.mnc=m.mnc; r.mnc2=m.mnc2;
    r.lac=(b[6]<<8)|b[7];
    r.rach=gsmDecodeRach(b,10);
    r.cbch=gsmDecodeCbch(b,13);
  } else if(mt===0x1a){                                // SI2: соседние соты + RACH
    r.type='SI2'; const fl=gsmDecodeFreqList(b,3,16);
    r.neighborArfcns=fl.arfcns; r.neighborFmt=fl.format; r.nccPermitted=b[19];
    r.rach=gsmDecodeRach(b,20);
  } else if(mt===0x19){                                // SI1: ARFCN своей соты + RACH
    r.type='SI1'; const fl=gsmDecodeFreqList(b,3,16);
    r.cellArfcns=fl.arfcns; r.cellFmt=fl.format;
    r.rach=gsmDecodeRach(b,19);
  }
  else if(mt===0x00){ r.type='SI13'; r.si13=gsmDecodeSi13(b); }
  else if(mt===0x02){                                  // SI2bis: продолжение списка соседей (Extended BCCH Freq List) + RACH
    r.type='SI2bis'; const fl=gsmDecodeFreqList(b,3,16);
    r.neighborArfcns=fl.arfcns; r.neighborFmt=fl.format; r.extInd=!!(b[3]&0x20);
    r.rach=gsmDecodeRach(b,19);
  }
  else if(mt===0x03){                                  // SI2ter: соседи в других диапазонах (NCD2), без RACH
    r.type='SI2ter'; const fl=gsmDecodeFreqList(b,3,16);
    r.neighborArfcns=fl.arfcns; r.neighborFmt=fl.format; r.extInd=!!(b[3]&0x20);
  }
  else if(mt===0x07){ r.type='SI2quater'; r.si2q=gsmDecodeSi2quater(b); }
  else if(mt===0x1d){                                   // SI5: тот же список соседей, что SI2, но по SACCH во время разговора
    r.type='SI5'; const fl=gsmDecodeFreqList(b,3,16);
    r.neighborArfcns=fl.arfcns; r.neighborFmt=fl.format;
  }
  else if(mt===0x1e) r.type='SI6';                       // SI6: LAI+Cell Options(SACCH)+NCC Permitted по SACCH — только типизируется
  else r.type='0x'+mt.toString(16);
  return r;
}
/* ---------- CCCH (TS 44.018): paging и immediate assignment ----------
 * Тот же xCCH-блок, что и BCCH: 4 бёрста → 23 байта L2. Положение блоков в 51-мультикадре TS0: объединённый CCCH (с SDCCH/4) —
 * кадры 6–9, 12–15, 16–19; необъединённый — ещё 22–25, 26–29, 32–35, 36–39, 42–45, 46–49. Тип канала (PCH / AGCH) по заголовку
 * не определить, различает сообщение. Идентификаторы абонентов (TMSI / IMSI в paging) по умолчанию не выдаются: только хэш с
 * случайной солью сеанса (одинаковый абонент — одинаковый маркер внутри приёма) либо вовсе без них; параметр ids = show
 * показывает их как есть и кладёт в hex без маски. Трафик абонентов (SDCCH / TCH / SACCH) этим не декодируется. */
const GSM_CHAN_TYPE=t=>t===1 ? 'TCH/F' : t<=3 ? 'TCH/H sub '+(t&1) : t<=7 ? 'SDCCH/4 sub '+(t&3) : t<=15 ? 'SDCCH/8 sub '+(t&7) : 'type '+t;
// Mobile Identity (TS 24.008 10.5.1.4) → {kind, value}
function gsmMobileId(b){
  if(!b.length) return {kind:'none',value:''};
  const t=b[0]&7, odd=(b[0]>>3)&1;
  if(t===4) return {kind:'TMSI', value:Array.from(b.subarray(1),x=>x.toString(16).padStart(2,'0')).join('')};
  if(t===0) return {kind:'none',value:''};
  let d=String(b[0]>>4);
  for(let i=1;i<b.length;i++){ d+=(b[i]&15).toString(16); if(i<b.length-1 || odd) d+=(b[i]>>4).toString(16); }
  return {kind:({1:'IMSI',2:'IMEI',3:'IMEISV'})[t]||'type '+t, value:d.replace(/f/g,'')};
}
// Channel Description (3 байта) → поля
function gsmChanDesc(b,o){
  const ch=b[o], o2=b[o+1], r={chan:GSM_CHAN_TYPE(ch>>3), tn:ch&7, tsc:(o2>>5)&7, hopping:!!(o2&0x10)};
  if(r.hopping){ r.maio=((o2&0x0f)<<2)|(b[o+2]>>6); r.hsn=b[o+2]&0x3f; } else { r.arfcn=((o2&3)<<8)|b[o+2]; r.freq=gsmArfcnFreq(r.arfcn); }
  return r;
}
// Request Reference (3 байта): RA, T1', T3, T2 → номер кадра по модулю 42432
function gsmReqRef(b,o){
  const ra=b[o], t1=b[o+1]>>3, t3=((b[o+1]&7)<<3)|(b[o+2]>>5), t2=b[o+2]&31;
  return {ra, fn:(51*26*t1)+(51*(((t3+26)-t2)%26))+t3};
}
// 23 байта L2 → разобранное сообщение CCCH или null (не RR / не CCCH-сообщение)
function gsmParseCcch(b){
  if((b[0]>>2)===0) return {msg:'idle'};                    // L2 pseudo length 0 — заполнение
  if((b[1]&0x0f)!==0x06) return null;
  const mt=b[2];
  if(mt===0x21 || mt===0x22 || mt===0x24){
    const r={msg:'Paging Request '+(mt===0x21 ? 1 : mt===0x22 ? 2 : 3), mt, pageMode:b[3]&15, cneed1:(b[3]>>4)&3, cneed2:(b[3]>>6)&3, ids:[]};
    if(mt===0x21){
      const l=b[4]; r.ids.push(b.subarray(5,5+l));
      const i=5+l; if(b[i]===0x17 && i+1<b.length) r.ids.push(b.subarray(i+2,i+2+b[i+1]));
    } else if(mt===0x22){
      r.ids.push(b.subarray(4,8),b.subarray(8,12));
      if(b[12]===0x17 && 13<b.length) r.ids.push(b.subarray(14,14+b[13]));
    } else r.ids.push(b.subarray(4,8),b.subarray(8,12),b.subarray(12,16),b.subarray(16,20));
    if(mt!==0x21){                                              // TMSI без байта типа → с ним, для общего разбора
      const k=mt===0x22 ? 2 : 4;
      r.ids=r.ids.map((x,i)=>i<k ? (x.every(v=>v===0xff) ? new Uint8Array(0) : Uint8Array.from([0xf4,...x])) : x);
    }
    r.ids=r.ids.map(gsmMobileId).filter(x=>x.kind!=='none');
    return r;
  }
  if(mt===0x3f){
    const r={msg:'Immediate Assignment', mt, pageMode:b[3]&15, dedicated:b[3]>>4, ...gsmChanDesc(b,4), ...gsmReqRef(b,7), ta:b[10], maLen:b[11]};
    return r;
  }
  if(mt===0x39) return {msg:'Immediate Assignment Extended', mt, pageMode:b[3]&15, a:{...gsmChanDesc(b,4), ...gsmReqRef(b,7), ta:b[10]}, b:{...gsmChanDesc(b,11), ...gsmReqRef(b,14), ta:b[17]}};
  if(mt===0x3a){
    const refs=[]; for(let i=0;i<4;i++){ const o=4+4*i; refs.push({...gsmReqRef(b,o), wait:b[o+3]}); }
    return {msg:'Immediate Assignment Reject', mt, pageMode:b[3]&15, refs};
  }
  return {msg:'other', mt};
}
// копия L2 paging без идентификаторов абонентов (для hex при ids ≠ show)
function gsmMaskPaging(b){
  const o=Uint8Array.from(b), mt=b[2];
  const zero=(a,n)=>{ for(let i=a;i<a+n && i<o.length;i++) o[i]=0; };
  if(mt===0x21){ const l=b[4]; zero(5,l); const i=5+l; if(b[i]===0x17) zero(i+2,b[i+1]); }
  else if(mt===0x22){ zero(4,8); if(b[12]===0x17) zero(14,b[13]); }
  else if(mt===0x24) zero(4,16);
  return o;
}
/* ---------- SDCCH/SACCH (TS 44.018): слепой разбор выделенного канала ----------
 * После Immediate Assignment (на той же несущей, без hopping) следим за его TN и пробуем декодировать xCCH-блок
 * (4 бёрста → gsmBcchDecode) на КАЖДОМ новом бёрсте этого TN, без таблицы позиций 51/102-мультикадра — границу блока
 * находит сама CRC-40 (FIRE): неверное окно (чужая под-подканал/SACCH-фаза или смесь двух сообщений) её не проходит,
 * так что ложные срабатывания практически исключены (2^-40). SACCH несёт 2-байтный L1-заголовок (TA, уровень Tx)
 * перед L2 — определяем это по тому, какое из двух смещений даёт осмысленный PD/MT. Шифрование (A5) после Ciphering
 * Mode Command делает CRC-40 заведомо неверной — зашифрованные блоки этим декодером не читаются, только отбраковываются. */
// GSM 04.08/24.008 Mobility Management: коды сообщений, которыми абонент представляется сети до/без шифрования
// (не проверено по живому перехвату — только самосогласованным тестом генератор↔приёмник, см. tools/test-gsm.mjs)
const GSM_MM_TYPES={0x01:'IMSI Detach Indication', 0x02:'Location Updating Accept', 0x04:'Location Updating Reject', 0x08:'Location Updating Request',
  0x11:'Authentication Reject', 0x12:'Authentication Request', 0x14:'Authentication Response',
  0x18:'Identity Request', 0x19:'Identity Response', 0x1a:'TMSI Reallocation Command', 0x1b:'TMSI Reallocation Complete',
  0x20:'CM Service Request', 0x21:'CM Service Accept', 0x22:'CM Service Reject', 0x24:'CM Service Abort', 0x25:'CM Re-establishment Request'};
// общий разбор L2-сообщения на выделенном канале; off — где начинается L2 внутри 23-байтного блока
// (0 — SDCCH, 2 — SACCH, после L1-заголовка): RR переиспользует уже проверенные gsmParseSI/gsmParseCcch, MM — своя таблица
function gsmParseL3(b, off){
  if(off+2>=b.length) return null;
  if((b[off]>>2)===0) return {type:'idle', pd:null, mt:0};
  const pd=b[off+1]&0x0f, mt=b[off+2];
  if(pd===0x06){
    const nb=b.subarray(off);
    const si=gsmParseSI(nb); if(si && !si.type.startsWith('0x')) return {pd:'RR', type:si.type, mt, ...si};
    const cc=gsmParseCcch(nb); if(cc && cc.msg!=='other' && cc.msg!=='idle') return {pd:'RR', type:cc.msg, mt, ...cc};
    return null;
  }
  if(pd===0x05){
    const name=GSM_MM_TYPES[mt]; if(!name) return null;
    const r={pd:'MM', type:name, mt};
    if(mt===0x19){ const l=b[off+3]||0; r.midOff=off+3; r.midLen=1+l; r.mobileId=gsmMobileId(b.subarray(off+4,off+4+l)); }           // Identity Response: Mobile Identity (LV)
    else if(mt===0x08){                                   // Location Updating Request: LU-type/CKSN(1) + LAI(5) + Classmark1(1) + Mobile Identity (LV)
      const m=gsmMccMnc(b[off+4],b[off+5],b[off+6]); r.mcc=m.mcc; r.mnc=m.mnc; r.lac=(b[off+7]<<8)|b[off+8];
      const lo=off+10, l=b[lo]||0; r.midOff=lo; r.midLen=1+l; r.mobileId=gsmMobileId(b.subarray(lo+1,lo+1+l));
    }
    else if(mt===0x20){                                    // CM Service Request: тип/CKSN(1) + Classmark2 (LV) + Mobile Identity (LV)
      const cl=b[off+4]||0, lo=off+5+cl, l=b[lo]||0; r.midOff=lo; r.midLen=1+l; r.mobileId=gsmMobileId(b.subarray(lo+1,lo+1+l));
    }
    return r;
  }
  return null;
}
function gsmMaskRange(b,off,len){ const o=Uint8Array.from(b); for(let i=off;i<off+len && i<o.length;i++) o[i]=0; return o; }
function gsmIdToken(salt,id){                                  // FNV-1a 32 по соли сеанса и идентификатору
  let h=0x811c9dc5; const s=salt+'|'+id.kind+id.value;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; }
  return id.kind+' #'+h.toString(36).padStart(7,'0');
}
function gsmMccMncStr(r){
  const mnc=r.mnc2 ? String(r.mnc).padStart(2,'0') : String(r.mnc).padStart(3,'0');
  return String(r.mcc).padStart(3,'0')+'-'+mnc;
}

/* ---------- офлайн-таблица PLMN (MCC-MNC) → оператор ----------
 * Не претендует на полноту и может устаревать (перепродажа кодов, слияния операторов) — сверено по
 * памяти из открытых MCC/MNC справочников (ITU/GSMA), только крупные операторы СНГ и несколько
 * заметных зарубежных сетей. Неизвестный код — просто PLMN-код без названия, ничего не придумываем. */
const GSM_OPERATORS={
  '250-01':'МТС', '250-02':'МегаФон', '250-20':'Tele2', '250-99':'Билайн',
  '255-01':'Vodafone UA', '255-03':'Kyivstar', '255-06':'lifecell',
  '257-01':'МТС (Беларусь)', '257-02':'life:)', '257-04':'A1 (Velcom)',
  '259-01':'Orange Moldova', '259-02':'Moldcell',
  '283-01':'VivaCell-MTS', '283-05':'Ucom',
  '282-01':'Geocell', '282-02':'Magticom', '282-04':'Beeline (Georgia)',
  '400-01':'Azercell', '400-02':'Bakcell', '400-04':'Nar Mobile',
  '401-01':'Beeline (KZ)', '401-02':'Activ (Kcell)', '401-77':'Tele2 (KZ)',
  '434-04':'Beeline (UZ)', '434-05':'Ucell',
  '437-01':'Beeline (KG)', '437-05':'MegaCom',
  '260-01':'Plus', '260-02':'T-Mobile PL', '260-03':'Orange PL', '260-06':'Play',
  '262-01':'Telekom.de', '262-02':'Vodafone.de', '262-07':'O2 Germany',
  '208-01':'Orange FR', '208-10':'SFR', '208-15':'Free Mobile', '208-20':'Bouygues',
  '234-10':'O2 UK', '234-15':'Vodafone UK', '234-20':'Three UK', '234-30':'EE',
  '222-01':'TIM', '222-10':'Vodafone IT', '222-88':'Wind Tre',
  '214-01':'Vodafone ES', '214-03':'Orange ES', '214-07':'Movistar',
  '310-260':'T-Mobile US', '310-410':'AT&T', '311-480':'Verizon',
  '460-00':'China Mobile', '460-01':'China Unicom', '460-03':'China Telecom',
  '286-01':'Turkcell', '286-02':'Vodafone TR', '286-03':'Türk Telekom',
};
function gsmOperator(plmn){ return GSM_OPERATORS[plmn]||null; }

/* ---------- приёмник: FCCH → SCH → синхронизация → бёрсты ---------- */
// Опорные последовательности (готовятся один раз)
let GSM_SCH_TS=null, GSM_NORM_TS=null;
function gsmPrepareRefs(){
  if(GSM_SCH_TS) return;
  GSM_SCH_TS=gsmGmskMapper(GSM_SYNC_BITS, GSM_N_SYNC, 0, -1);
  GSM_NORM_TS=GSM_TRAIN_SEQ.map(ts=>gsmGmskMapper(ts, GSM_N_TRAIN, ts[0]===0?1:-1, 0));
}

function gsmFrameNr(t1,t2,t3){ return (51*26*t1)+(51*(((t3+26)-t2)%26))+t3; }

class GsmReceiver{
  constructor(){
    gsmPrepareRefs();
    this.re=new Float32Array(0); this.im=new Float32Array(0);
    this.len=0; this.head=0; this.dCounter=0;
    this.state='fcch';                                  // fcch | sch | sync
    this.fcchStart=0; this.failedSch=0; this.schRef=null;
    this.t1=0; this.t2=0; this.t3=0; this.tn=0; this.offFrac=0;
    this.ncc=0; this.bcc=0;
    this.bursts=[];                                     // выданные за такт бёрсты
    this.rec=[];
    this.dbm=0; this.fc=0;
    this.bcch=[null,null,null,null];                    // 4 бёрста BCCH (кадры 2..5)
    this.bcchTry=0; this.bcchOk=0;                       // попытки/успехи разбора BCCH (диагностика)
    this.cellLabel=null;                                 // подпись своей соты для рёбер графа соседей
    this.lastCellBase=null; this.lastCellId=null;         // последний известный CID для PLMN-LAC (SI3→SI4)
    this.cbchTn=-1; this.cbchTsc=null;                   // таймслот/TSC CBCH, если настроен и ARFCN совпал с текущим
    this.cbchBuf=[null,null,null,null];                  // 4 бёрста текущего CBCH-блока (23 байта L2 каждый)
    this.cbchPage=[null,null,null,null];                 // 4 фрагмента (seq 0..3) собираемой CBS-страницы
    this.cbchTry=0; this.cbchOk=0; this.cbsOk=0;          // диагностика: попытки блока / успехи блока / собранные страницы
    this.ccchCombined=null;                              // CCCH объединён с SDCCH/4 (CCCH-CONF из SI3): null — ещё неизвестно
    this.ccchBuf=[null,null,null,null];
    this.ids='hash';                                     // идентификаторы абонентов в paging: hash | none | show
    this.salt=Math.random().toString(36).slice(2);       // соль хэша — на один приём
    this.ccch={blocks:0, ok:0, idle:0, paging:0, ids:0, ia:0, rej:0, other:0};
    this.dch=[];                                         // отслеживаемые выделенные каналы {tn, tsc, until} — из Immediate Assignment на этой же несущей
    this.dchBuf={}; this.ulDchBuf={};                     // this.dchBuf[tn] / ulDchBuf[tn] — накопленные бёрсты (до 4) слепого разбора SDCCH/SACCH
    // аплинк (для своего тестового стенда): отдельный буфер IQ той же несущей сетки, физически на 3 таймслота позже
    // downlink-бёрста того же (FN,TN) — см. anchorUl/workUplink
    this.ul={re:new Float32Array(0), im:new Float32Array(0), len:0, head:0};
    this.ulCounter=0; this.ulAnchor=0; this.ulReady=false;
    this.ulSlot={t1:0,t2:0,t3:0,tn:0,offFrac:0};
  }
  avail(){ return this.len-this.head; }
  // отставание от потока (UI/GC-пауза, нагрузка): копить дальше нельзя — каждый push копирует остаток, а разбор не успевает,
  // нагрузка растёт лавиной. Выбрасываем старое, оставляя хвост, и ищем FCCH заново
  dropBacklog(keep){
    const k=Math.max(0,this.avail()-keep); this.consume(k); this.state='fcch'; this.dropped=(this.dropped||0)+1;
  }
  pushBuf(buf,re,im){
    const keep=buf.len-buf.head, n=re.length;
    if(buf.re.length<keep+n){
      const cap=Math.max(keep+n, buf.re.length*2, 1<<16);
      const nr=new Float32Array(cap), ni=new Float32Array(cap);
      nr.set(buf.re.subarray(buf.head,buf.len)); ni.set(buf.im.subarray(buf.head,buf.len));
      buf.re=nr; buf.im=ni;
    } else if(buf.head>0){
      buf.re.copyWithin(0,buf.head,buf.len); buf.im.copyWithin(0,buf.head,buf.len);
    }
    buf.len=keep; buf.head=0;
    buf.re.set(re,buf.len); buf.im.set(im,buf.len); buf.len+=n;
  }
  push(re,im){ this.pushBuf(this,re,im); }
  consume(k){ this.head+=k; this.dCounter+=k; }
  // аплинк: буфер своей несущей (та же сетка OSR·270.833 кГц), копится, пока не найдена привязка по SCH
  ulPush(re,im){
    this.pushBuf(this.ul,re,im);
    if(!this.ulReady){ const cap=8*GSM_TARGET_SR; if(this.ul.len-this.ul.head>cap) this.ul.head=this.ul.len-cap; }
  }
  ulConsume(k){ this.ul.head+=k; this.ulCounter+=k; }
  // временно подставляет аплинк-буфер вместо своего под те же re/im/head/len — переиспользует getNormImp/
  // detectBurst/correlate без их дублирования для второго потока
  withUl(fn){
    const re=this.re, im=this.im, head=this.head, len=this.len;
    this.re=this.ul.re; this.im=this.ul.im; this.head=this.ul.head; this.len=this.ul.len;
    try{ fn(); } finally {
      this.ul.re=this.re; this.ul.im=this.im; this.ul.head=this.head; this.ul.len=this.len;
      this.re=re; this.im=im; this.head=head; this.len=len;
    }
  }
  // привязка: правая граница SCH-бёрста (dCounter+bs) → то же (FN,TN) на аплинке, через 3 таймслота (TS 05.10) —
  // переустанавливается на каждом удачном SCH, так что слежение за тактом (adj в processTimeslot) не нужно дублировать
  anchorUl(bs,tn){
    this.ulAnchor=this.dCounter+bs+3*GSM_TS_BITS*GSM_OSR;
    this.ulSlot={t1:this.t1,t2:this.t2,t3:this.t3,tn,offFrac:0};
    this.ulReady=true;
  }

  phaseDiff(i,j){                                      // arg( s[i] · conj(s[j]) )
    const h=this.head, ar=this.re[h+i], ai=this.im[h+i], br=this.re[h+j], bi=this.im[h+j];
    return Math.atan2(ai*br-ar*bi, ar*br+ai*bi);
  }
  // корреляция опорной seq (шаг OSR) с сигналом от смещения off
  correlate(seqRe,seqIm,length,off){
    const h=this.head; let rr=0,ri=0;
    for(let k=0;k<length;k++){ const a=seqRe[k], b=seqIm[k];
      const cr=this.re[h+off+k*GSM_OSR], ci=this.im[h+off+k*GSM_OSR];
      rr+=a*cr+b*ci; ri+=b*cr-a*ci; }                  // seq · conj(input)
    return [rr/length, ri/length];
  }

  // ---- поиск FCCH (gr-gsm find_fcch_burst, порт) ----
  findFcch(){
    const nitems=this.avail();
    const buf=new Float32Array(GSM_FCCH_HITS*GSM_OSR); let bi=0, bn=0;   // кольцо разностей фаз
    let lowest=1e9, phaseDiff=0, best=0, start=-1, hit=0, miss=0, sample=0, toConsume=0;
    let st='init', end=false, result=false;
    while(!end){
      if(st==='init'){ hit=0; miss=0; start=-1; lowest=1e9; bi=0; bn=0; st='search'; }
      else if(st==='search'){
        sample++;
        if(sample>nitems-GSM_FCCH_HITS*GSM_OSR){ toConsume=sample; st='fail'; continue; }
        phaseDiff=this.phaseDiff(sample,sample-1);
        if(phaseDiff>0){ toConsume=sample; st='found'; } else st='search';
      }
      else if(st==='found'){
        if(phaseDiff>0) hit++; else miss++;
        if(miss>=GSM_FCCH_MISS*GSM_OSR && hit<=GSM_FCCH_HITS*GSM_OSR){ st='init'; continue; }
        if((miss>=GSM_FCCH_MISS*GSM_OSR && hit>GSM_FCCH_HITS*GSM_OSR) || hit>2*GSM_FCCH_HITS*GSM_OSR){ st='fcch'; continue; }
        if(miss<GSM_FCCH_MISS*GSM_OSR && hit>GSM_FCCH_HITS*GSM_OSR){
          let mn=1e9,mx=-1e9; for(let k=0;k<bn;k++){ const v=buf[k]; if(v<mn)mn=v; if(v>mx)mx=v; }
          if(lowest>mx-mn){ lowest=mx-mn; start=sample-GSM_FCCH_HITS*GSM_OSR-GSM_FCCH_MISS*GSM_OSR;
            let s=0; for(let k=0;k<bn;k++) s+=buf[k]-(Math.PI/2)/GSM_OSR; this.bestSum=s; }
        }
        if(++sample>=nitems){ st='fail'; continue; }
        phaseDiff=this.phaseDiff(sample,sample-1);
        if(bn<buf.length) buf[bn++]=phaseDiff; else { buf[bi]=phaseDiff; bi=(bi+1)%buf.length; }
        st='found';
      }
      else if(st==='fcch'){
        toConsume=start+GSM_FCCH_HITS*GSM_OSR+1;
        this.fcchStart=this.dCounter+start;
        const phaseOff=this.bestSum/GSM_FCCH_HITS;
        this.freqOffset=phaseOff*GSM_SYMBOL_RATE/(2*Math.PI);   // сумма по FCCH_HITS×OSR, деление на FCCH_HITS → уже Гц
        end=true; result=true;
      }
      else if(st==='fail'){ end=true; result=false; }
    }
    this.consume(toConsume);
    return result;
  }

  reachSch(){
    const nitems=this.avail();
    const sampleNr=this.fcchStart+(GSM_FRAME_BITS-GSM_SAFETY_MARGIN)*GSM_OSR;
    if(this.dCounter<sampleNr){
      this.consume(this.dCounter+nitems>=sampleNr ? sampleNr-this.dCounter : nitems);
      return false;
    }
    return true;
  }

  // окна энергии: сумма winLen значений power начиная с i, пока окно целиком помещается
  _windowEnergy(pow){
    const winLen=GSM_CHAN_IMP*GSM_OSR, we=[];
    for(let i=0;i+winLen<=pow.length;i++){ let e=0; for(let k=0;k<winLen;k++) e+=pow[i+k]; we.push(e); }
    return we;
  }
  // импульсная характеристика по SCH (gr-gsm get_sch_chan_imp_resp) → burst_start
  getSchImp(chanRe,chanIm){
    const corrRe=[], corrIm=[], pow=[], winLen=GSM_CHAN_IMP*GSM_OSR;
    const len=(GSM_SYNC_POS+GSM_SYNC_SEARCH_RANGE)*GSM_OSR;
    for(let ii=GSM_SYNC_POS*GSM_OSR;ii<len;ii++){
      const [cr,ci]=this.correlate(GSM_SCH_TS.re.subarray(5),GSM_SCH_TS.im.subarray(5),GSM_N_SYNC-10,ii);
      corrRe.push(cr); corrIm.push(ci); pow.push(cr*cr+ci*ci);
    }
    const we=this._windowEnergy(pow);
    let strongest=0,mx=-1; for(let i=0;i<we.length;i++) if(we[i]>mx){ mx=we[i]; strongest=i; }
    let center=0,maxc=0;
    for(let ii=0;ii<winLen;ii++){ const cr=corrRe[strongest+ii], ci=corrIm[strongest+ii];
      const a=Math.hypot(cr,ci); if(a>maxc){ center=ii; maxc=a; } chanRe[ii]=cr; chanIm[ii]=ci; }
    return strongest+center-48*GSM_OSR-2*GSM_OSR+2+GSM_SYNC_POS*GSM_OSR;
  }
  getNormImp(bcc,chanRe,chanIm){
    const corrRe=[], corrIm=[], pow=[], winLen=GSM_CHAN_IMP*GSM_OSR;
    const center=(GSM_TRAIN_POS+GSM_GUARD)*GSM_OSR|0;
    const startPos=center+1-5*GSM_OSR, stopPos=center+GSM_CHAN_IMP*GSM_OSR+5*GSM_OSR;
    const seq=GSM_NORM_TS[bcc];
    for(let ii=startPos;ii<stopPos;ii++){
      const [cr,ci]=this.correlate(seq.re.subarray(GSM_TRAIN_BEGINNING),seq.im.subarray(GSM_TRAIN_BEGINNING),GSM_N_TRAIN-10,ii);
      corrRe.push(cr); corrIm.push(ci); pow.push(cr*cr+ci*ci);
    }
    const we=this._windowEnergy(pow);
    // max_element(begin, end - winLen) — сильнейшее без последних winLen окон
    let strongest=0,mx=-1; const upto=Math.max(1,we.length-winLen);
    for(let i=0;i<upto;i++) if(we[i]>mx){ mx=we[i]; strongest=i; }
    if(strongest<0) strongest=0;
    for(let ii=0;ii<winLen;ii++){ chanRe[ii]=corrRe[strongest+ii]; chanIm[ii]=corrIm[strongest+ii]; }
    return startPos+strongest-GSM_TRAIN_POS*GSM_OSR;
  }

  // MLSE-детекция бёрста от burst_start (gr-gsm detect_burst) → 148 жёстких бит (0/1)
  detectBurst(chanRe,chanIm,burstStart,out){
    const rhhRe=new Float32Array(GSM_CHAN_IMP), rhhIm=new Float32Array(GSM_CHAN_IMP);
    const L=GSM_CHAN_IMP*GSM_OSR, tRe=new Float32Array(L), tIm=new Float32Array(L);
    for(let k=L-1;k>=0;k--){ let ar=0,ai=0;                    // автокорреляция канала
      for(let i=k;i<L;i++){ const xr=chanRe[i], xi=chanIm[i], yr=chanRe[i-k], yi=chanIm[i-k];
        ar+=xr*yr+xi*yi; ai+=xi*yr-xr*yi; }
      tRe[k]=ar; tIm[k]=ai; }
    for(let ii=0;ii<GSM_CHAN_IMP;ii++){ rhhRe[ii]=tRe[ii*GSM_OSR]; rhhIm[ii]=-tIm[ii*GSM_OSR]; }
    const fRe=new Float32Array(GSM_BURST_SIZE), fIm=new Float32Array(GSM_BURST_SIZE);
    const h=this.head;
    for(let n=0;n<GSM_BURST_SIZE;n++){                          // согласованный фильтр (mafi)
      const a=n*GSM_OSR; let sr=0,si=0;
      for(let ii=0;ii<L;ii++){ if(a+ii>=GSM_BURST_SIZE*GSM_OSR) break;
        const xr=this.re[h+burstStart+a+ii], xi=this.im[h+burstStart+a+ii];
        sr+=xr*chanRe[ii]-xi*chanIm[ii]; si+=xr*chanIm[ii]+xi*chanRe[ii]; }
      fRe[n]=sr; fIm[n]=si;
    }
    const output=new Float32Array(GSM_BURST_SIZE);
    gsmViterbiDetector(fRe,fIm,GSM_BURST_SIZE,rhhRe,rhhIm,3,[4,12],output);
    for(let i=0;i<GSM_BURST_SIZE;i++) out[i]=output[i]>0?1:0;
  }

  signalDbm(){
    const h=this.head; let p=0;
    for(let ii=GSM_GUARD|0;ii<GSM_TS_BITS;ii++){ const a=Math.hypot(this.re[h+ii],this.im[h+ii]); p+=a*a; }
    return Math.round(10*Math.log10(p/GSM_TS_BITS/50));
  }

  // тип бёрста по 51-мультикадру TS0; для TN>0 — просто нормальный (данные)
  burstType(){
    if(this.tn!==0) return 'normal';
    const t3=this.t3;
    if(GSM_FCCH_FRAMES.has(t3)) return 'fcch';
    if(GSM_SCH_FRAMES.has(t3)) return 'sch';
    return 'normal';
  }
  // шаг на один таймслот вперёд по 51-мультикадру; st — {t1,t2,t3,tn,offFrac}, по умолчанию свой (downlink);
  // аплинк шагает по собственному st=this.ulSlot той же функцией — сетка одна и та же, просто с других отсчётов
  stepSlot(st){
    st.tn++;
    if(st.tn===GSM_TS_PER_FRAME){ st.tn=0;
      if(st.t2===25 && st.t3===50) st.t1=(st.t1+1)%(1<<11);
      st.t2=(st.t2+1)%26; st.t3=(st.t3+1)%51; }
    st.offFrac+=GSM_GUARD_FRAC*GSM_OSR;
    const oi=Math.floor(st.offFrac); st.offFrac-=oi; return oi;
  }
  advanceBurst(){ return this.stepSlot(this); }

  // один такт: сколько успеваем — разбираем; возвращает выданные бёрсты и записи
  work(){
    this.bursts=[]; this.rec=[];
    let guard=0;
    while(guard++<200){
      if(this.state==='fcch'){
        if(this.avail()<2*GSM_FCCH_HITS*GSM_OSR+64) break;
        if(this.findFcch()) this.state='sch';
      }
      else if(this.state==='sch'){
        const need=(GSM_SYNC_POS+GSM_SYNC_SEARCH_RANGE)*GSM_OSR+GSM_BURST_SIZE*GSM_OSR+GSM_CHAN_IMP*GSM_OSR+8;
        if(!this.reachSch()) { if(this.avail()<need) break; else continue; }
        if(this.avail()<need) break;
        const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
        const bs=this.getSchImp(chanRe,chanIm);
        if(bs<0 || this.head+bs+GSM_BURST_SIZE*GSM_OSR>=this.len){ this.state='fcch'; continue; }
        const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
        const r=gsmDecodeSch(eb);
        if(!r){ this.state='fcch'; continue; }
        this.t1=r.t1; this.t2=r.t2; this.t3=r.t3; this.ncc=r.ncc; this.bcc=r.bcc; this.tn=0; this.offFrac=0;
        this.anchorUl(bs,0);
        this.advanceBurst();                                     // set(...)++ как в оригинале
        this.consume(bs+GSM_BURST_SIZE*GSM_OSR+4*GSM_OSR);
        this.state='sync'; this.failedSch=0; this.schRef=null;
        this.emitSch(bs);
      }
      else if(this.state==='sync'){
        const need=(GSM_TS_BITS+2*GSM_GUARD)*GSM_OSR+16;
        if(this.avail()<need) break;
        this.processTimeslot();
      }
    }
    this.workUplink();
    return {bursts:this.bursts, rec:this.rec};
  }

  emitSch(){
    const fn=gsmFrameNr(this.t1,this.t2,this.t3);
    this.rec.push({t:Date.now(), kind:'GSM-SCH', bsic:(this.ncc<<3)|this.bcc,
      ncc:this.ncc, bcc:this.bcc, fn, tn:0, freq:this.fc, dbm:this.dbm});
  }
  // 2×57 бит данных из e-бит нормального бёрста (без tail/train/steal/guard)
  extractData(eb){
    const d=new Uint8Array(114);
    for(let i=0;i<57;i++){ d[i]=eb[3+i]; d[57+i]=eb[88+i]; }
    return d;
  }
  // накопление 4 бёрстов BCCH (кадры 2..5 одного 51-мультикадра) → декод SI
  accumBcch(eb){
    const idx=this.t3-2;
    if(idx===0) this.bcch=[null,null,null,null];
    if(idx<0||idx>3) return;
    this.bcch[idx]=this.extractData(eb);
    if(idx===3 && this.bcch.every(Boolean)){
      this.bcchTry++;
      const l2=gsmBcchDecode(this.bcch); this.bcch=[null,null,null,null];
      if(l2){ this.bcchOk++; const si=gsmParseSI(l2); if(si) this.emitBcch(si, l2); }
    }
  }
  emitBcch(si, l2){
    const fn=gsmFrameNr(this.t1,this.t2,this.t3);
    let hex=''; for(const x of l2) hex+=x.toString(16).padStart(2,'0');
    const rec={t:Date.now(), kind:'GSM-'+si.type, si:si.type, bsic:(this.ncc<<3)|this.bcc,
      ncc:this.ncc, bcc:this.bcc, fn, tn:0, freq:this.fc, dbm:this.dbm, hex, hexSchema:'gsm-l2'};
    if(si.ci!=null) rec.ci=si.ci;
    if(si.mcc!=null){ rec.mcc=si.mcc; rec.mnc=si.mnc; rec.plmn=gsmMccMncStr(si); rec.lac=si.lac;
      const op=gsmOperator(rec.plmn); if(op) rec.op=op;
      // ключ соты: PLMN-LAC-CI. SI4 не несёт CID — тогда переиспользуем CID, который уже узнали из SI3
      // этой же соты (это один и тот же приём, не другая сота), иначе SI3/SI4 одной соты расходятся
      // на два разных id и recUniq считает их за две разные записи вместо одной.
      const base=rec.plmn+'-'+si.lac.toString(16);
      if(si.ci!=null){ rec.id=base+'-'+si.ci.toString(16); this.lastCellBase=base; this.lastCellId=rec.id; }
      else rec.id=(this.lastCellBase===base && this.lastCellId) ? this.lastCellId : base;
      this.cellLabel=(op||rec.plmn)+' LAC'+si.lac; }           // для рёбер графа соседей (emitNeighbors)
    if(si.cellArfcns) { rec.cellArfcns=si.cellArfcns; rec.cellFmt=si.cellFmt; }
    if(si.neighborArfcns) { rec.neighborArfcns=si.neighborArfcns; rec.neighborFmt=si.neighborFmt; rec.nccPermitted=si.nccPermitted;
      this.emitNeighbors(si.neighborArfcns, si.neighborFmt); }
    if(si.rach) rec.rach=si.rach;
    if(si.ctrlCh){ rec.ctrlCh=si.ctrlCh; this.ccchCombined=si.ctrlCh.ccchConf===1 ? true : [0,2,4,6].includes(si.ctrlCh.ccchConf) ? false : this.ccchCombined; }
    if(si.cellOpt) rec.cellOpt=si.cellOpt;
    if(si.cellSel) rec.cellSel=si.cellSel;
    if(si.cbch){
      rec.cbch=si.cbch;
      // декодируем CBCH, только если он на ТОЙ ЖЕ несущей, что мы уже принимаем (его TN не бесплатно —
      // это тот же C0 или совпавший по частоте TRX); hopping CBCH без MA-списка не разобрать.
      const cbchOk=si.cbch.present && !si.cbch.hopping && si.cbch.freq!=null &&
        Math.abs(si.cbch.freq-this.fc/1e6)<0.15;
      this.cbchTn=cbchOk ? si.cbch.tn : -1; this.cbchTsc=cbchOk ? si.cbch.tsc : null;
    }
    if(si.si13) rec.si13=si.si13;
    if(si.si2q) rec.si2q=si.si2q;
    this.rec.push(rec);
  }
  // 4 бёрста CBCH-блока (TS 04.12) готовы → декод через общий xCCH (gsmBcchDecode), разбор заголовка,
  // накопление 4 блоков (seq 0..3) в CBS-страницу 88 байт и её разбор
  // позиция в блоке CCCH: {start, idx} либо null; до SI3 (конфигурация неизвестна) — только кадры, общие для обеих конфигураций
  ccchPos(t3){
    for(const st of this.ccchCombined===false ? GSM_CCCH_ALL : GSM_CCCH_COMBINED) if(t3>=st && t3<st+4) return {start:st, idx:t3-st};
    return null;
  }
  accumCcch(eb, idx){
    if(idx===0) this.ccchBuf=[null,null,null,null];
    this.ccchBuf[idx]=this.extractData(eb);
    if(idx!==3 || !this.ccchBuf.every(Boolean)) return;
    const l2=gsmBcchDecode(this.ccchBuf); this.ccchBuf=[null,null,null,null];
    const C=this.ccch; C.blocks++;
    if(!l2) return;
    C.ok++;
    const m=gsmParseCcch(l2);
    if(!m) return;
    if(m.msg==='idle'){ C.idle++; return; }
    this.emitCcch(m,l2);
  }
  emitCcch(m,l2){
    const C=this.ccch, fn=gsmFrameNr(this.t1,this.t2,this.t3), hx=a=>Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
    const base={t:Date.now(), fn, tn:0, freq:this.fc, dbm:this.dbm, bsic:(this.ncc<<3)|this.bcc, hexSchema:'gsm-l2'};
    if(m.msg.startsWith('Paging')){
      C.paging++;
      if(!m.ids.length){ C.idle++; return; }                  // paging без идентификатора — заполнение
      C.ids+=m.ids.length;
      const rec={...base, kind:'GSM-PCH', msg:m.msg, pageMode:m.pageMode, count:m.ids.length};
      if(this.ids==='show') rec.ids=m.ids.map(x=>x.kind+' '+x.value);
      else if(this.ids==='hash') rec.ids=m.ids.map(x=>gsmIdToken(this.salt,x));
      rec.hex=hx(this.ids==='show' ? l2 : gsmMaskPaging(l2));
      rec.text=m.msg+' · '+m.ids.length+' '+(m.ids.length===1 ? 'identity' : 'identities')+(rec.ids ? ': '+rec.ids.join(', ') : '');
      this.rec.push(rec); return;
    }
    if(m.msg==='Immediate Assignment'){
      C.ia++;
      if(!m.hopping && m.freq!=null && Math.abs(m.freq-this.fc/1e6)<0.15) this.trackDch(m.tn,m.tsc,m.chan);   // та же несущая → отслеживаем SDCCH/SACCH на её TN
      this.rec.push({...base, kind:'GSM-AGCH', msg:m.msg, chan:m.chan, ctn:m.tn, tsc:m.tsc, hopping:m.hopping, arfcn:m.arfcn, maio:m.maio, hsn:m.hsn, ra:m.ra, reqFn:m.fn, ta:m.ta, hex:hx(l2),
        text:'Immediate Assignment · '+m.chan+' TN'+m.tn+' TSC'+m.tsc+(m.hopping ? ' hopping MAIO '+m.maio+' HSN '+m.hsn : ' ARFCN '+m.arfcn)+' · RA 0x'+m.ra.toString(16)+' · TA '+m.ta}); return;
    }
    if(m.msg==='Immediate Assignment Extended'){
      C.ia++;
      for(const x of [m.a,m.b]) if(!x.hopping && x.freq!=null && Math.abs(x.freq-this.fc/1e6)<0.15) this.trackDch(x.tn,x.tsc,x.chan);
      this.rec.push({...base, kind:'GSM-AGCH', msg:m.msg, hex:hx(l2), text:'Immediate Assignment Extended · '+[m.a,m.b].map(x=>x.chan+' TN'+x.tn+(x.hopping ? ' hopping' : ' ARFCN '+x.arfcn)).join(' / ')}); return;
    }
    if(m.msg==='Immediate Assignment Reject'){
      C.rej++;
      this.rec.push({...base, kind:'GSM-AGCH', msg:m.msg, wait:m.refs[0].wait, hex:hx(l2), text:'Immediate Assignment Reject · wait '+m.refs[0].wait+' s'}); return;
    }
    C.other++;
  }
  accumCbch(eb, idx){
    if(idx===0) this.cbchBuf=[null,null,null,null];
    this.cbchBuf[idx]=this.extractData(eb);
    if(idx!==3 || !this.cbchBuf.every(Boolean)) return;
    this.cbchTry++;
    const l2=gsmBcchDecode(this.cbchBuf); this.cbchBuf=[null,null,null,null];
    if(!l2) return;
    this.cbchOk++;
    const h=gsmCbchHeader(l2[0]);
    if(h.lpd!==1 || h.seq>3){ if(h.seq===0) this.cbchPage=[null,null,null,null]; return; }  // не CB / schedule / null
    if(h.seq===0) this.cbchPage=[null,null,null,null];
    this.cbchPage[h.seq]=l2.subarray(1,23);
    if(!this.cbchPage.every(Boolean)) return;
    const page=new Uint8Array(88); for(let i=0;i<4;i++) page.set(this.cbchPage[i],i*22);
    this.cbchPage=[null,null,null,null];
    this.cbsOk++;
    const cbs=gsmCbsParse(page);
    // id — тот же набор полей (Message ID + Serial Number), которым TS 03.41 определяет дубликат
    // одного и того же сообщения: повтор схлопнется в recUniq в одну строку, новое — отдельная.
    const id=(this.cellLabel||'cell?')+'-CBS-'+cbs.msgId.toString(16)+'-'+cbs.serial.msgCode+'-'+cbs.serial.updateNum;
    this.rec.push({t:Date.now(), kind:'GSM-CBS', id, fn:gsmFrameNr(this.t1,this.t2,this.t3), tn:this.cbchTn,
      freq:this.fc, dbm:this.dbm, msgId:cbs.msgId, msgCode:cbs.serial.msgCode, updateNum:cbs.serial.updateNum,
      dcs:cbs.dcs, charset:cbs.charset, page:cbs.pageNum, pages:cbs.totalPages, text:cbs.text,
      hex:Array.from(page,x=>x.toString(16).padStart(2,'0')).join(''), hexSchema:'gsm-cbs'});
  }
  // рёбра «своя сота → сосед по ARFCN» для узла Graph (vis-network): кидаем как записи rec с
  // from/to — graphview сам их подхватит по именам колонок, без отдельного провода
  emitNeighbors(arfcns, fmt){
    if(fmt==='other' || !arfcns.length) return;
    const from=this.cellLabel||('BSIC '+((this.ncc<<3)|this.bcc));
    for(const a of arfcns) this.rec.push({t:Date.now(), kind:'GSM-NEIGHBOR', from, to:'ARFCN '+a});
  }

  processTimeslot(){
    const type=this.burstType();
    // TN1..7 без CBCH/отслеживаемых каналов не нужны для разбора — пропускаем целиком (7/8 всей нагрузки на бёрсты);
    // allTs включает прежнее поведение (бёрсты всех слотов на выходе burst)
    if(type==='normal' && this.tn!==0 && !this.allTs && this.tn!==this.cbchTn && !this.dch.some(c=>c.tn===this.tn && c.until>Date.now())){
      const off=this.advanceBurst(); this.consume(GSM_TS_BITS*GSM_OSR+off); return;
    }
    this.dbm=this.signalDbm();
    let toConsume=0, adj=0;
    if(type==='fcch'){
      // измеряем остаточное смещение частоты и корректируем петлю
      const h=this.head; let phaseSum=0;
      const m=6*GSM_OSR;                                  // запас по краям: при сдвиге слота окно не должно захватывать хвосты/шум
      const first=Math.ceil((GSM_GUARD+2*GSM_TAIL)*GSM_OSR)+1+m, last=first+GSM_USEFUL*GSM_OSR-GSM_TAIL*GSM_OSR-2*m;
      for(let ii=first;ii<last;ii++) phaseSum+=this.phaseDiff(ii,ii-1)-(Math.PI/2)/GSM_OSR;
      const fo=(phaseSum/(last-first))*GSM_TARGET_SR/(2*Math.PI);
      if(Math.abs(fo)<GSM_AFC_MAX_STEP){ this.freqOffset=fo*0.5; this.freqUpdate=true; }   // выброс = слот сдвинут, не уход частоты
    }
    else if(type==='sch'){
      const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
      const bs=this.getSchImp(chanRe,chanIm);
      if(bs>=0 && this.head+bs+GSM_BURST_SIZE*GSM_OSR<this.len){
        const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
        const r=gsmDecodeSch(eb);
        if(r){ this.t1=r.t1; this.t2=r.t2; this.t3=r.t3; this.ncc=r.ncc; this.bcc=r.bcc; this.failedSch=0;
          this.emitSch(bs); this.emitBurst('sch',eb);
          // слежение за тактом: позиция SCH относительно первой принятой — уход кварца SDR, подтягиваем сетку слотов.
          // Привязка аплинка (anchorUl) делается только один раз, при первом захвате: это физическая позиция,
          // пересчитывать её на каждый SCH не нужно и вредно (резкий скачок анкера выбрасывает уже накопленный
          // в ul-буфере кусок) — вместо этого применяем ТУ ЖЕ самую поправку adj к шагу аплинка (clock общий)
          if(this.schRef==null) this.schRef=bs;
          else { const err=bs-this.schRef; if(Math.abs(err)<GSM_TRACK_MAX*GSM_OSR){ adj=Math.trunc(err/2); this.pendingUlAdj=(this.pendingUlAdj||0)+adj; } } }
        else if(++this.failedSch>=GSM_MAX_SCH_ERR){ this.state='fcch'; }
      }
    }
    else if(type==='normal'){
      const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
      // TSC канала по умолчанию = BCC (общее правило для соты), но у CBCH и отслеживаемых выделенных каналов — свой
      const dchc=this.dch.find(c=>c.tn===this.tn && c.until>Date.now());
      const tsc=(this.tn===this.cbchTn && this.cbchTsc!=null) ? this.cbchTsc : (dchc ? dchc.tsc : this.bcc);
      const bs=this.getNormImp(tsc,chanRe,chanIm);
      if(bs>=0 && this.head+bs+GSM_BURST_SIZE*GSM_OSR<this.len){
        const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
        this.emitBurst('normal',eb);
        if(this.tn===0 && this.t3>=2 && this.t3<=5) this.accumBcch(eb);   // BCCH → System Information
        if(this.tn===0){ const cp=this.ccchPos(this.t3); if(cp) this.accumCcch(eb,cp.idx); }   // CCCH → paging, immediate assignment
        if(this.tn===this.cbchTn){                                       // CBCH → SMSCB, если настроен на этой несущей
          const fn=gsmFrameNr(this.t1,this.t2,this.t3), lfn=fn%102;
          for(const start of GSM_CBCH_FN) if(lfn>=start && lfn<start+4) this.accumCbch(eb, lfn-start);
        }
        if(dchc) this.accumDch(this.tn, eb, false, this.t3%4===dchc.ph);                      // выделенный канал → слепой разбор SDCCH/SACCH
      }
    }
    const off=this.advanceBurst();
    toConsume=GSM_TS_BITS*GSM_OSR+off+adj;
    this.consume(toConsume);
  }

  emitBurst(type,eb){
    const fn=gsmFrameNr(this.t1,this.t2,this.t3);
    const bits=new Float32Array(GSM_BURST_SIZE);
    for(let i=0;i<GSM_BURST_SIZE;i++) bits[i]=eb[i]?1:-1;
    this.bursts.push({type, fn, tn:this.tn, bits, dbm:this.dbm});
  }

  // регистрирует/продлевает слежение за выделенным каналом на tn (своя несущая, не hopping) — пока не истечёт
  // (без Channel Release мы не знаем точный момент освобождения, так что держим недолго и перезаписываем новым)
  // TCH не отслеживаем (это не сигнализация, слепой разбор даёт только мусор и съедает весь CPU); ph — позиция
  // последнего кадра блока в 51-мультикадре по модулю 4: SDCCH/8 — 3 (кадры 0..3, 4..7, …), SDCCH/4 — 1 (22..25, 26..29, …)
  trackDch(tn,tsc,chan){
    if(/^TCH/.test(chan||'')) return;
    const ph=/^SDCCH\/4/.test(chan||'') ? 1 : 3;
    const until=Date.now()+60000, ex=this.dch.find(c=>c.tn===tn);
    if(ex){ ex.tsc=tsc; ex.until=until; ex.ph=ph; } else { this.dch.push({tn,tsc,until,ph}); if(this.dch.length>8) this.dch.shift(); }
  }
  // накопление последних 4 бёрстов TN в скользящем окне — см. комментарий у gsmParseL3 про безопасность без таблицы
  accumDch(tn,eb,ul,tryDecode=true){
    const buf=(ul?this.ulDchBuf:this.dchBuf)[tn]||((ul?this.ulDchBuf:this.dchBuf)[tn]=[]);
    buf.push(this.extractData(eb)); if(buf.length>4) buf.shift();
    if(buf.length<4 || !tryDecode) return;   // декодируем только на границе блока: в 4 раза дешевле
    const l2=gsmBcchDecode(buf); if(!l2) return;
    buf.length=0;
    this.emitDch(tn,l2,ul);
  }
  emitDch(tn,l2,ul){
    const s=ul?this.ulSlot:this, fn=gsmFrameNr(s.t1,s.t2,s.t3);
    const hx=a=>Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
    let off=0, m=gsmParseL3(l2,0);
    if(!m){ const m2=gsmParseL3(l2,2); if(m2){ off=2; m=m2; } }
    if(!m || m.type==='idle') return;
    const base={t:Date.now(), fn, tn, dir:ul?'UL':'DL', freq:this.fc, dbm:this.dbm, bsic:(this.ncc<<3)|this.bcc, hexSchema:'gsm-l2'};
    let hex=l2;
    if(m.mobileId && this.ids!=='show') hex=gsmMaskRange(l2,m.midOff,m.midLen);
    const rec={...base, kind:off===2 ? 'GSM-SACCH' : 'GSM-SDCCH', pd:m.pd, msg:m.type, mt:m.mt, hex:hx(hex)};
    if(off===2){ rec.ta=l2[0]; rec.txPower=l2[1]; }
    if(m.mcc!=null){ rec.mcc=m.mcc; rec.mnc=m.mnc; rec.lac=m.lac; }
    if(m.mobileId && m.mobileId.kind!=='none'){
      rec.idKind=m.mobileId.kind;
      if(this.ids==='show') rec.id=m.mobileId.kind+' '+m.mobileId.value;
      else if(this.ids==='hash') rec.id=gsmIdToken(this.salt,m.mobileId);
    }
    rec.text=(ul?'↑ ':'↓ ')+m.pd+' '+m.type+(rec.id ? ' · '+rec.id : rec.idKind ? ' · '+rec.idKind : '');
    this.rec.push(rec);
  }

  // аплинк (для своего тестового стенда): шагает по той же TDMA-сетке, что downlink, от точки привязки anchorUl;
  // декодирует бёрст только на TN отслеживаемых каналов — остальные просто пропускаются, чтобы не терять привязку
  workUplink(){
    if(!this.ulReady) return;
    let guard=0;
    while(guard++<400){
      if(this.ulCounter<this.ulAnchor){
        const gap=this.ulAnchor-this.ulCounter, avail=this.ul.len-this.ul.head;
        if(avail<gap){ if(avail) this.ulConsume(avail); break; }
        this.ulConsume(gap); continue;
      }
      const need=(GSM_TS_BITS+2*GSM_GUARD)*GSM_OSR+16;
      if(this.ul.len-this.ul.head<need) break;
      const tn=this.ulSlot.tn, dchc=this.dch.find(c=>c.tn===tn && c.until>Date.now());
      if(dchc){
        const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
        this.withUl(()=>{
          const bs=this.getNormImp(dchc.tsc,chanRe,chanIm);
          if(bs>=0 && this.head+bs+GSM_BURST_SIZE*GSM_OSR<this.len){
            const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
            this.accumDch(tn,eb,true);
          }
        });
      }
      const off=this.stepSlot(this.ulSlot), nudge=this.pendingUlAdj||0;
      this.pendingUlAdj=0;
      this.ulConsume(GSM_TS_BITS*GSM_OSR+off+nudge);
    }
  }
}

/* ---------- DSP-узел ---------- */
// полный сброс: новый GsmReceiver + сброс AFC (foff/nco) и реземплеров 'in'/'ul'. Переподключение узла на другую
// частоту (сдвиг маркера спектра) само по себе НЕ сбрасывает накопленную частотную поправку и остаток
// реземплера от старой несущей — застрявший на старой частоте foff может не дать найти FCCH на новой. Кнопка
// делает то же самое, что переустановка узла, без необходимости удалять и добавлять его заново.
function gsmRxReset(n){
  n.rx=new GsmReceiver(); n.foff=0; n.nco=0;
  n.dl={lr:new Float32Array(0), li:new Float32Array(0), frac:1};
  n.ulSt={lr:new Float32Array(0), li:new Float32Array(0), frac:1};
  n.bid=0; n.log=[]; n.text='ищу FCCH…'; n.lastSchBsic=-1; n.fcchSince=null;
}
def({ id:'gsmRx', title:'GSM: Receive Bursts (IQ)', cat:'Decoders',
  ins:[{n:'in',t:'iq'},{n:'ul',t:'iq'}],
  outs:[{n:'rec',t:'rec'},{n:'burst',t:'blk'},{n:'freq',t:'num'},{n:'sync',t:'num'},{n:'nb',t:'rec'}],
  readout:true, tall:true,
  params:[{n:'afc',t:'check',d:true,label:'auto frequency correction (FCCH)'},
          {n:'debug',t:'check',d:false,label:'debug: доп. поля SI3/SI4 (Control Ch, Cell Opt, CBCH) + hex'},
          {n:'allts',t:'check',d:false,label:'decode all timeslots (TN1–7 bursts on the burst output; heavy on CPU)'},
          {n:'ids',t:'select',opts:['hash','none','show'],d:'hash',label:'paging identifiers (TMSI / IMSI): hash — only a marker, none — count only, show — as is'},
          {n:'clr',t:'button',label:'Clear log / resync',fn:gsmRxReset}],
  init:gsmRxReset,
  process(n,I){
    const s=iqIn(I,'in'), su=iqIn(I,'ul');
    if(!s || !s.sr){ n.text='нет входного IQ-потока'; return {rec:null, burst:null, freq:n.foff, sync:0}; }
    if(s.sr<GSM_TARGET_SR*0.98){ n.text='sr слишком низкий: нужно ≥ '+(GSM_TARGET_SR/1e6).toFixed(3)+' MS/s (GSM 270.833k×'+GSM_OSR+')'; return {rec:null, burst:null, freq:n.foff, sync:0}; }
    // ресемплинг на OSR·270.833 кГц — тот же для 'in' и для 'ul' (аплинк, второй приёмник на пару несущей —
    // своему тестовому стенду), раздельное состояние (остаток блока) на каждый вход
    const dl=gsmResampleStream(n.dl,s);
    if(dl && n.p.afc && n.foff!==0) gsmDerotate(dl.re,dl.im,n);
    const ul=(su && su.sr>=GSM_TARGET_SR*0.98) ? gsmResampleStream(n.ulSt,su) : null;   // своя частотная коррекция для аплинка не делается (см. README)
    if(dl){ n.rx.fc=s.fc||0; n.rx.ids=n.p.ids||'hash'; n.rx.allTs=!!n.p.allts; n.rx.push(dl.re,dl.im);
      if(ul) n.rx.ulPush(ul.re,ul.im);
      const {bursts,rec}=n.rx.work();
      if(n.rx.avail()>GSM_MAX_BACKLOG*GSM_TARGET_SR) n.rx.dropBacklog(0.05*GSM_TARGET_SR);   // после разбора всё ещё не успеваем
      // частотная петля
      // поправка применяется сразу по FCCH, даже если SCH в том же такте не сошёлся из-за ещё не
      // скорректированной частоты (раньше она терялась и поиск шёл десятки секунд). Уже накопленный
      // в приёмнике хвост добавочно довращаем, чтобы следующий FCCH не посчитал ту же ошибку второй раз
      if(n.p.afc && n.rx.freqOffset!=null){
        const old=n.foff;
        n.foff=clamp(n.foff+n.rx.freqOffset,-GSM_TARGET_SR/2,GSM_TARGET_SR/2);
        const d=n.foff-old, rx=n.rx;
        n.rx.freqOffset=null; n.rx.freqUpdate=false;
        if(d!==0){
          const w=-2*Math.PI*d/GSM_TARGET_SR, h=rx.head, L=rx.len-h;
          for(let k=0;k<L;k++){
            const c=Math.cos(w*k), s2=Math.sin(w*k), a=rx.re[h+k], b=rx.im[h+k];
            rx.re[h+k]=a*c-b*s2; rx.im[h+k]=a*s2+b*c;
          }
          n.nco+=w*L;
        }
      }
      // защита от застревания AFC: findFcch() (порт find_fcch_burst из gr-gsm) засекает только
      // УСТОЙЧИВО ПОЛОЖИТЕЛЬНЫЙ наклон фазы — так и должно быть, FCCH всегда на +67.7 кГц выше
      // несущей. Если накопленная коррекция foff хоть немного перелетит реальный уход частоты
      // (увод кварца донгла, единицы-десятки кГц — не обязательно большой по модулю foff: важна
      // именно разница с реальным смещением, которую мы не знаем), остаток после коррекции уйдёт
      // в минус — и цикл будет не находить FCCH уже никогда, сколько ни жди, даже если foff сам
      // по себе невелик (поэтому порог по |foff|, что стоял тут раньше, эту ситуацию не ловил).
      // Поэтому раз мы реально зависли в поиске надолго — пробуем сбросить накопленную коррекцию,
      // не дожидаясь, пока foff станет "подозрительно большим": хуже не будет, с нуля приёмник
      // синхронизируется исправно.
      if(n.rx.state==='fcch'){
        if(n.fcchSince==null) n.fcchSince=Date.now();
        else if(Date.now()-n.fcchSince>2000){ n.foff=0; n.nco=0; n.fcchSince=Date.now(); }
      } else n.fcchSince=null;
      // отдельный выход nb — рёбра «сота → сосед по ARFCN» для Graph (vis-network), чтобы не путать
      // его с rec: там generic from/to-угадывание по первым двум полям сломалось бы на прочих записях
      const mainRec=[], nbRec=[];
      for(const r of rec) (r.kind==='GSM-NEIGHBOR' ? nbRec : mainRec).push(r);
      let outRec=mainRec.length?mainRec:null, outNb=nbRec.length?nbRec:null, blk=null;
      n.bid+=bursts.length;
      const last=bursts[bursts.length-1];
      if(last) blk={d:last.bits, n:last.bits.length, id:n.bid, fn:last.fn, tn:last.tn, kind:last.type};
      // SCH валит ~10 строк/сек и выталкивает редкие SI1-4 (LAC/CID, ARFCN, RACH) из хвоста лога —
      // в скролл пишем SCH только при смене BSIC (захват/смена соты), текущий BSIC — в статусной строке.
      for(const r of rec){
        if(r.kind==='GSM-SCH'){ if(r.bsic===n.lastSchBsic) continue; n.lastSchBsic=r.bsic; }
        else if(r.kind==='GSM-NEIGHBOR') continue;      // рёбра для Graph — не для чтения построчно
        n.log.push(gsmRecLine(r,n.p.debug));
      }
      if(n.log.length>200) n.log.splice(0,n.log.length-200);
      const st=n.rx.state==='sync'?'синхр.':n.rx.state==='sch'?'жду SCH':'ищу FCCH';
      const mhz=s.fc?(s.fc/1e6).toFixed(3)+' МГц · ':'';
      // BCCH: попытки/успехи разбора SI — если попыток много, а успехов 0, дело не в "ждать дольше",
      // а в срыве синхронизации на одном из 4 бёрстов подряд (сбросы USB/AGC и т.п.), не в декодере.
      const bc=n.rx.bcchTry? ` · BCCH ${n.rx.bcchOk}/${n.rx.bcchTry}` : '';
      const cb=n.rx.cbchTn>=0? ` · CBCH TN${n.rx.cbchTn} бл.${n.rx.cbchOk}/${n.rx.cbchTry} стр.${n.rx.cbsOk}` : '';
      const cc=n.rx.ccch.blocks ? ` · CCCH ${n.rx.ccch.ok}/${n.rx.ccch.blocks} pag ${n.rx.ccch.paging} IA ${n.rx.ccch.ia}` : '';
      const bsicTxt=n.rx.state==='sync'? ` · BSIC ${(n.rx.ncc<<3)|n.rx.bcc}` : '';
      // подсказка по частоте для второго приёмника на 'ul' (дуплексный разнос) + сколько выделенных каналов отслеживаем;
      // UL в счётчике SDCCH/SACCH — её собственные записи с dir:'UL' уже попали в rec/лог выше, здесь просто итог
      const ulHz=gsmUplinkFreq(s.fc?s.fc/1e6:null);
      const ulTxt=n.rx.dch.length ? ` · ul: ${n.rx.dch.length} кан.`+(ul?'':' (вход не подключён)')+(ulHz!=null?` · ул. несущая ≈${ulHz.toFixed(3)} МГц`:'') : '';
      n.text=st+bsicTxt+` · ${mhz}foff ${n.foff.toFixed(0)} Hz · бёрстов ${n.bid}${bc}${cb}${cc}${ulTxt}\n`+n.log.slice(-14).join('\n');
      return {rec:outRec, burst:blk, freq:n.foff, sync:n.rx.state==='sync'?1:0, nb:outNb};
    }
    return {rec:null, burst:null, freq:n.foff, sync:n.rx.state==='sync'?1:0, nb:null};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) gsmReadout(n,r); }});
// статус — одной строкой сверху, лог — в своей прокручиваемой области, прижатой к новым строкам: в маленькой ячейке тайла
// текст не прыгает, когда статус переносится на другое число строк или приходят пакеты
function gsmReadout(n,r){
  if(!r._gsm){
    r._gsm=1; r.classList.add('gsm-ro');
    Object.defineProperty(r,'textContent',{configurable:true,get:()=>n.text||'',set:()=>{}});   // копирование по клику берёт весь текст
    r.innerHTML='<div class="gsm-st"></div><div class="gsm-lg"></div>';
  }
  const text=n.text||'';
  if(r._last===text) return;
  r._last=text;
  const i=text.indexOf('\n'), st=i<0 ? text : text.slice(0,i), lg=i<0 ? '' : text.slice(i+1);
  const stEl=r.firstChild, lgEl=r.lastChild;
  if(stEl.textContent!==st){ stEl.textContent=st; stEl.title=st; }
  const stick=lgEl.scrollHeight-lgEl.scrollTop-lgEl.clientHeight<24;     // пользователь не листал вверх
  lgEl.textContent=lg;
  if(stick) lgEl.scrollTop=lgEl.scrollHeight;
}

function gsmHerm(y0,y1,y2,y3,t){
  const c1=0.5*(y2-y0), c2=y0-2.5*y1+2*y2-0.5*y3, c3=0.5*(y3-y0)+1.5*(y1-y2);
  return ((c3*t+c2)*t+c1)*t+y1;
}
// ресемплинг любого sr на OSR·270.833 кГц (кубический Эрмит); st — {lr,li,frac}, своё на каждый вход ('in'/'ul')
// ФНЧ+децимация за один проход: полифазный КИХ (окно Блэкмана, срез GSM_LP_CUT) в дробной позиции выхода.
// Без ФНЧ соседние каналы (±400 кГц) и алиасинг ломают поиск FCCH (синхр. — минуты или срыв)
const GSM_MAX_BACKLOG=1;                                  // неразобранный остаток буфера приёмника сверх этого (с) — сброс
const GSM_LP_T=8, GSM_LP_PH=128, GSM_LP_CUT=180e3;
let GSM_LP_CACHE=null;
function gsmLpTable(sr){
  if(GSM_LP_CACHE && GSM_LP_CACHE.sr===sr) return GSM_LP_CACHE.h;
  const T=GSM_LP_T, K=2*T, h=new Float64Array((GSM_LP_PH+1)*K), a=2*GSM_LP_CUT/sr;
  for(let p=0;p<=GSM_LP_PH;p++){ let sum=0; const f=p/GSM_LP_PH;   // +1 фаза: дробь, округлённая до 1.0, без min()
    for(let j=0;j<K;j++){ const d=j-T+1-f, x=Math.PI*a*d;
      const v=(d===0?a:Math.sin(x)/(Math.PI*d))*(0.42+0.5*Math.cos(Math.PI*d/T)+0.08*Math.cos(2*Math.PI*d/T));
      h[p*K+j]=v; sum+=v; }
    for(let j=0;j<K;j++) h[p*K+j]/=sum; }
  GSM_LP_CACHE={sr,h}; return h;
}
function gsmResamplePoly(st,s,ratio){
  const T=GSM_LP_T, K=2*T, h=gsmLpTable(s.sr);
  let total=st.lr.length; for(const c of s.chunks) total+=c.re.length;
  const xr=new Float64Array(total), xi=new Float64Array(total);
  xr.set(st.lr); xi.set(st.li); let w=st.lr.length;
  for(const c of s.chunks){ xr.set(c.re,w); if(c.im) xi.set(c.im,w); w+=c.re.length; }
  const outR=new Float32Array(Math.ceil(total/ratio)+4), outI=new Float32Array(outR.length);
  let outN=0, pos=st.frac;
  if(pos<T-1) pos=T-1;                                  // начало потока: слева нет истории
  for(;;){
    const k=pos|0; if(k+T>total-1) break;
    const base=k-T+1, o=(((pos-k)*GSM_LP_PH+0.5)|0)*K;
    let a0=0,a1=0,b0=0,b1=0;                            // две независимые суммы на канал — короче цепочка зависимостей
    for(let j=0;j<K;j+=2){ const c0=h[o+j], c1=h[o+j+1], q=base+j;
      a0+=c0*xr[q]; a1+=c1*xr[q+1]; b0+=c0*xi[q]; b1+=c1*xi[q+1]; }
    outR[outN]=a0+a1; outI[outN]=b0+b1; outN++; pos+=ratio;
  }
  const keepFrom=Math.max(0,Math.floor(pos)-T);
  st.lr=xr.slice(keepFrom); st.li=xi.slice(keepFrom); st.frac=pos-keepFrom;
  return outN ? {re:outR.subarray(0,outN), im:outI.subarray(0,outN)} : null;
}
function gsmResampleStream(st,s){
  const ratio=s.sr/GSM_TARGET_SR;
  if(ratio>1.2) return gsmResamplePoly(st,s,ratio);
  const chunks=s.chunks;
  let total=st.lr.length; for(const c of chunks) total+=c.re.length;
  const xr=new Float32Array(total), xi=new Float32Array(total);
  xr.set(st.lr); xi.set(st.li); let w=st.lr.length;
  for(const c of chunks){ xr.set(c.re,w); if(c.im) xi.set(c.im,w); w+=c.re.length; }
  const outR=new Float32Array(Math.ceil(total/ratio)+4), outI=new Float32Array(outR.length);
  let outN=0, pos=st.frac;
  while(Math.floor(pos)+2<=total-1){
    const k=Math.floor(pos), t=pos-k;
    outR[outN]=gsmHerm(xr[k-1<0?0:k-1],xr[k],xr[k+1],xr[k+2],t);
    outI[outN]=gsmHerm(xi[k-1<0?0:k-1],xi[k],xi[k+1],xi[k+2],t);
    outN++; pos+=ratio;
  }
  const keepFrom=Math.max(0,Math.floor(pos)-1);
  st.lr=xr.slice(keepFrom); st.li=xi.slice(keepFrom); st.frac=pos-keepFrom;
  return outN ? {re:outR.subarray(0,outN), im:outI.subarray(0,outN)} : null;
}
// дерот. входа по накопленному смещению foff (AFC) — отдельным проходом по уже ресемплированным отсчётам,
// поэтому тот же цикл легко применить только к downlink (аплинк своей коррекции не делает, см. README)
function gsmDerotate(re,im,n){
  const w=-2*Math.PI*n.foff/GSM_TARGET_SR, rr=Math.cos(w), ri=Math.sin(w);
  let pr=Math.cos(n.nco), pi=Math.sin(n.nco);
  for(let i=0;i<re.length;i++){
    const a=re[i]*pr-im[i]*pi, b=re[i]*pi+im[i]*pr; re[i]=a; im[i]=b;
    const t=pr*rr-pi*ri; pi=pr*ri+pi*rr; pr=t;
  }
  n.nco=(n.nco+w*re.length)%(2*Math.PI);
}
// строка лога по записи; debug=true — доп. поля конфигурации соты + сырой hex L2-сообщения
function gsmRecLine(r,debug){
  const t=new Date(r.t).toLocaleTimeString();
  if(r.kind==='GSM-PCH' || r.kind==='GSM-AGCH') return `${t} ${r.kind==='GSM-PCH' ? 'PCH' : 'AGCH'} ${r.text} · FN ${r.fn} ${r.dbm} dBm`;
  if(r.kind==='GSM-SCH') return `${t} SCH BSIC ${r.bsic} (NCC ${r.ncc}/BCC ${r.bcc}) FN ${r.fn} ${r.dbm} dBm`;
  if(r.si==='SI3') return `${t} SI3 ${r.op?r.op+' ':''}PLMN ${r.plmn} LAC ${r.lac} CID ${r.ci} · ${r.dbm} dBm`
    +gsmRachSuffix(r.rach)+(debug?gsmDebugSuffix(r):'');
  if(r.si==='SI4') return `${t} SI4 ${r.op?r.op+' ':''}PLMN ${r.plmn} LAC ${r.lac}`
    +gsmRachSuffix(r.rach)+(debug?gsmDebugSuffix(r):'');
  if(r.si==='SI1') return `${t} SI1 своя сота ARFCN: ${gsmArfcnList(r.cellArfcns,r.cellFmt)}`+gsmRachSuffix(r.rach);
  if(r.si==='SI2') return `${t} SI2 соседи ARFCN: ${gsmArfcnList(r.neighborArfcns,r.neighborFmt)}`+gsmRachSuffix(r.rach);
  if(r.si==='SI2bis' || r.si==='SI2ter') return `${t} ${r.si} соседи ARFCN: ${gsmArfcnList(r.neighborArfcns,r.neighborFmt)}`+(r.extInd?' (+)':'')+gsmRachSuffix(r.rach);
  if(r.si==='SI13') return `${t} SI13 ${gsmSi13Line(r.si13)}`+(debug&&r.si13?gsmSi13DebugSuffix(r.si13):'');
  if(r.si==='SI2quater') return `${t} SI2quater ${gsmSi2qLine(r.si2q)}`;
  if(r.kind==='GSM-CBS') return `${t} CBS [${r.page}/${r.pages}] msgId 0x${r.msgId.toString(16)} (${r.charset}): ${r.text}`;
  if(r.kind==='GSM-SDCCH' || r.kind==='GSM-SACCH') return `${t} ${r.kind==='GSM-SACCH'?'SACCH':'SDCCH'} TN${r.tn} ${r.text} · ${r.dbm} dBm`;
  return `${t} ${r.si||r.kind} FN ${r.fn}`;
}
// краткая строка SI13: поддерживает ли сота GPRS и как к ней подключаться (PBCCH или по BCCH/CCCH)
function gsmSi13Line(si13){
  if(!si13 || !si13.present) return 'нет GPRS-данных';
  if(si13.pbcch) return `GPRS есть, PBCCH на TN${si13.pbcch.tn} TSC${si13.pbcch.tsc}`+
    (si13.pbcch.arfcn!=null?` ARFCN${si13.pbcch.arfcn}`:si13.pbcch.maio!=null?` hop MAIO${si13.pbcch.maio}`:'');
  if(si13.rac!=null) return `GPRS есть, PBCCH не настроен (пакетные данные по BCCH/CCCH), RAC ${si13.rac}`;
  return 'GPRS не поддерживается';
}
// краткая строка SI2quater: список 3G/LTE UTRAN-соседей (ARFCN + число scrambling-кодов на каждом)
function gsmSi2qLine(q){
  if(!q) return '';
  if(q.note) return q.note;
  const g=q.neighbors3g;
  if(!g || (!g.utranFdd?.cells?.length && !g.utranTdd?.cells?.length)) return '3G-соседей нет';
  const parts=[];
  for(const c of g.utranFdd?.cells||[]) parts.push(`FDD UARFCN${c.uarfcn}×${c.codes.length}`);
  for(const c of g.utranTdd?.cells||[]) parts.push(`TDD UARFCN${c.uarfcn}×${c.codes.length}`);
  return '3G-соседи: '+parts.join(', ');
}
function gsmSi13DebugSuffix(si13){
  return `\n    BCCH-CHANGE-MARK ${si13.bcchChangeMark} · SI-CHANGE-FIELD ${si13.siChangeField}`+
    (si13.spgcCcchSup!=null?` · SPGC-CCCH-SUP ${si13.spgcCcchSup?1:0} · PRIORITY-ACCESS-THR ${si13.priorityAccessThr} · NETWORK-CONTROL-ORDER ${si13.networkControlOrder}`:'');
}
// доп. строка для debug: Control Channel Description/Cell Options/Cell Selection (SI3),
// наличие и позиция CBCH (SI4), сырой hex декодированного L2-сообщения — для сверки руками
function gsmDebugSuffix(r){
  let s='';
  if(r.ctrlCh){ const c=r.ctrlCh;
    s+=`\n    CCCH-CONF ${c.ccchConf} (${GSM_CCCH_CONF[c.ccchConf]}) · ATT ${c.att?1:0} · BS-PA-MFRMS ${c.bsPaMfrms} · T3212 ${c.t3212min} мин`; }
  if(r.cellOpt){ const o=r.cellOpt;
    s+=`\n    PWRC ${o.pwrc?1:0} · DTX ${o.dtx} · RADIO-LINK-TIMEOUT ${o.radioLinkTimeout} с`; }
  if(r.cellSel){ const c=r.cellSel;
    s+=`\n    CELL-RESELECT-HYST ${c.cellReselectHyst} дБ · MS-TXPWR-MAX-CCH ${c.msTxpwrMaxCch} · RXLEV-ACCESS-MIN ${c.rxlevAccessMin}`; }
  if(r.cbch){ const c=r.cbch;
    s+=c.present ? `\n    CBCH: TN${c.tn} ${c.kind} суб.${c.sub} TSC${c.tsc}`+
        (c.hopping?` hop MAIO${c.maio}/HSN${c.hsn}`:` ARFCN${c.arfcn}`+(c.freq!=null?` (${c.freq.toFixed(1)} МГц)`:''))
      : `\n    CBCH: не настроен (нет Channel Description в SI4)`; }
  if(r.hex) s+=`\n    hex: ${r.hex}`;
  return s;
}
function gsmArfcnList(arfcns,fmt){
  if(fmt==='other') return '(формат не разобран)';
  if(!arfcns||!arfcns.length) return '-';
  return arfcns.length>8 ? arfcns.slice(0,8).join(',')+`,… (${arfcns.length})` : arfcns.join(',');
}
function gsmRachSuffix(rach){
  return rach ? ` · RACH tx${rach.txInteger}/retr${rach.maxRetrans}`+(rach.cellBarred?' CELL_BARRED':'') : '';
}
