"use strict";
/* ============================ GSM: приём бёрстов из IQ ============================
 * Порт приёмного тракта gr-gsm (ptrkrysik/gr-gsm, GPLv3) и SCH-декодера из
 * libosmocore (osmocom/libosmocore, GPLv2+): FCCH → SCH → синхронизация →
 * разбор бёрстов на TS0 нисходящего канала. Даёт то, что просили — «принимать
 * пакеты с IQ»: несущая C0 ловится, кадры нумеруются, бёрсты выдаются битами.
 *
 * Что готово (и как проверено, см. tools/test/cases/gsm.mjs):
 *   [ГОТОВО] MLSE-детектор (Витерби по каналу) — viterbiDetector, порт 1:1
 *   [ГОТОВО] оценка импульсной характеристики по обучающей последовательности
 *   [ГОТОВО] FCCH-поиск (частотная коррекция несущей) — findFcch, порт 1:1
 *   [ГОТОВО] SCH: свёрточный код G0/G1, CRC-16/10 (0x175), разбор BSIC/FN
 *            — свои энкодер/Витерби сверены с osmo_conv (порядок бит r=(state<<1)|bit),
 *            round-trip и сквозной прогон через бёрст в тестах
 *   [ГОТОВО] нумерация бёрстов (t1/t2/t3 → FN, TN) и типизация по 51-мультикадру TS0
 *   [ГОТОВО] внутренняя частотная петля: дерот. входа по накопленному смещению
 *
 * Вход — поток 'iq', любой sr выше ~1.1 МГц; внутри ресемплится на OSR·270.833 кГц.
 * Дальше демодуляции нет: узел выдаёт биты бёрстов (для demapper/декодера канала),
 * BSIC и номер кадра. Это приёмник физического уровня, не декодер трафика. */

/* ---------- константы (gr-gsm gsm_constants.h) ---------- */
const GSM_OSR=4;
const GSM_SYMBOL_RATE=1625000/6;                     // символов/с
const GSM_TARGET_SR=GSM_SYMBOL_RATE*GSM_OSR;         // 1083333.33 отсч./с
const GSM_TAIL=3, GSM_GUARD_BITS=8, GSM_GUARD_FRAC=0.25, GSM_GUARD=GSM_GUARD_BITS+GSM_GUARD_FRAC;
const GSM_DATA_BITS=57, GSM_N_TRAIN=26, GSM_N_SYNC=64;
const GSM_USEFUL=142, GSM_BURST_SIZE=GSM_USEFUL+2*GSM_TAIL;   // 148
const GSM_SCH_DATA_LEN=39;
const GSM_TS_BITS=GSM_TAIL+GSM_USEFUL+GSM_TAIL+GSM_GUARD_BITS;   // 156
const GSM_TS_PER_FRAME=8, GSM_FRAME_BITS=GSM_TS_PER_FRAME*GSM_TS_BITS+2;   // 1250
const GSM_SYNC_POS=39, GSM_SYNC_SEARCH_RANGE=30;
const GSM_TRAIN_POS=GSM_TAIL+(GSM_DATA_BITS+1)+5, GSM_TRAIN_BEGINNING=5;   // 66
const GSM_SAFETY_MARGIN=6, GSM_CHAN_IMP=5, GSM_MAX_SCH_ERR=10;
const GSM_FCCH_HITS=GSM_USEFUL-4, GSM_FCCH_MISS=1, GSM_FCCH_MAX_OFF=100;

const GSM_SYNC_BITS=[
  1,0,1,1,1,0,0,1,0,1,1,0,0,0,1,0, 0,0,0,0,0,1,0,0,0,0,0,0,1,1,1,1,
  0,0,1,0,1,1,0,1,0,1,0,0,0,1,0,1, 0,1,1,1,0,1,1,0,0,0,0,1,1,0,1,1];
const GSM_TRAIN_SEQ=[
  [0,0,1,0,0,1,0,1,1,1,0,0,0,0,1,0,0,0,1,0,0,1,0,1,1,1],
  [0,0,1,0,1,1,0,1,1,1,0,1,1,1,1,0,0,0,1,0,0,1,0,1,1,1],
  [0,1,0,0,0,0,1,1,1,0,1,1,1,0,1,0,0,1,0,0,0,0,1,1,1,0],
  [0,1,0,0,0,1,1,1,1,0,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1,0],
  [0,0,0,1,1,0,1,0,1,1,1,0,0,1,0,0,0,0,0,1,1,0,1,0,1,1],
  [0,1,0,0,1,1,1,0,1,0,1,1,0,0,0,0,0,1,0,0,1,1,1,0,1,0],
  [1,0,1,0,0,1,1,1,1,1,0,1,1,0,0,0,1,0,1,0,0,1,1,1,1,1],
  [1,1,1,0,1,1,1,1,0,0,0,1,0,0,1,0,1,1,1,0,1,1,1,1,0,0],
  [0,1,1,1,0,0,0,1,0,1,1,1,0,0,0,1,0,1,1,1,0,0,0,1,0,1]];
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
// Порядок бит как в osmo_conv: r=(state<<1)|bit, out=parity(r&poly), state=r&0xF.
const GSM_G0=0b11001, GSM_G1=0b11011;
function gsmParity(x){ x^=x>>>4; x^=x>>>2; x^=x>>>1; return x&1; }   // чётность бит
// вход — 39 инф. бит (25 данные + 10 CRC + ... ), возвращает 78 кодовых бит (0/1)
function gsmSchConvEncode(u){
  const out=new Int8Array(78); let state=0, o=0;
  for(let i=0;i<39;i++){
    const bit=i<u.length?u[i]:0, r=(state<<1)|bit;
    out[o++]=gsmParity(r&GSM_G0); out[o++]=gsmParity(r&GSM_G1);
    state=r&0xf;
  }
  return out;
}
// Витерби по 78 мягким битам (sbit: 0→+, 1→−) → 35 инф. бит (25 данные + 10 CRC)
function gsmSchConvDecode(sb){
  const NS=16, STEPS=39, NEG=-1e9;
  let pm=new Float32Array(NS).fill(NEG); pm[0]=0;
  let npm=new Float32Array(NS);
  const back=[]; for(let i=0;i<STEPS;i++) back.push(new Uint8Array(NS));
  // предвычислить выходы ветвей: из state по bit → (o0,o1,nextState)
  for(let i=0;i<STEPS;i++){
    npm.fill(NEG);
    const s0=sb[2*i], s1=sb[2*i+1];
    for(let st=0;st<NS;st++){
      if(pm[st]<=NEG/2) continue;
      for(let bit=0;bit<2;bit++){
        const r=(st<<1)|bit, o0=gsmParity(r&GSM_G0), o1=gsmParity(r&GSM_G1);
        // метрика-корреляция: sbit>0 → бит 0
        const m=pm[st]+(o0?-s0:s0)+(o1?-s1:s1), ns=r&0xf;
        if(m>npm[ns]){ npm[ns]=m; back[i][ns]=(st<<1)|bit; }
      }
    }
    const t=pm; pm=npm; npm=t;
  }
  // трассировка из конечного состояния 0 (хвост из 4 нулей)
  const u=new Int8Array(35); let st=0;
  for(let i=STEPS-1;i>=0;i--){ const b=back[i][st]; const bit=b&1;
    if(i<35) u[i]=bit; st=b>>1; }
  return u;
}
// CRC-16/10 SCH: poly 0x175, init 0, xor 0x3ff (libosmocore gsm0503_sch_crc10)
function gsmSchCrc10(bits, len){
  let crc=0; const n=9;
  for(let i=0;i<len;i++){ crc^=(bits[i]&1)<<n;
    crc=(crc&(1<<n))?((crc<<1)^0x175):(crc<<1); crc&=0x3ff; }
  return crc^0x3ff;
}
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
    this.fcchStart=0; this.failedSch=0;
    this.t1=0; this.t2=0; this.t3=0; this.tn=0; this.offFrac=0;
    this.ncc=0; this.bcc=0;
    this.bursts=[];                                     // выданные за такт бёрсты
    this.rec=[];
    this.dbm=0;
  }
  avail(){ return this.len-this.head; }
  push(re,im){
    const keep=this.len-this.head, n=re.length;
    if(this.re.length<keep+n){
      const cap=Math.max(keep+n, this.re.length*2, 1<<16);
      const nr=new Float32Array(cap), ni=new Float32Array(cap);
      nr.set(this.re.subarray(this.head,this.len)); ni.set(this.im.subarray(this.head,this.len));
      this.re=nr; this.im=ni;
    } else if(this.head>0){
      this.re.copyWithin(0,this.head,this.len); this.im.copyWithin(0,this.head,this.len);
    }
    this.len=keep; this.head=0;
    this.re.set(re,this.len); this.im.set(im,this.len); this.len+=n;
  }
  consume(k){ this.head+=k; this.dCounter+=k; }

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
  advanceBurst(){
    this.tn++;
    if(this.tn===GSM_TS_PER_FRAME){ this.tn=0;
      if(this.t2===25 && this.t3===50) this.t1=(this.t1+1)%(1<<11);
      this.t2=(this.t2+1)%26; this.t3=(this.t3+1)%51; }
    this.offFrac+=GSM_GUARD_FRAC*GSM_OSR;
    const oi=Math.floor(this.offFrac); this.offFrac-=oi; return oi;
  }

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
        this.advanceBurst();                                     // set(...)++ как в оригинале
        this.consume(bs+GSM_BURST_SIZE*GSM_OSR+4*GSM_OSR);
        this.state='sync'; this.failedSch=0;
        this.emitSch(bs);
      }
      else if(this.state==='sync'){
        const need=(GSM_TS_BITS+2*GSM_GUARD)*GSM_OSR+16;
        if(this.avail()<need) break;
        this.processTimeslot();
      }
    }
    return {bursts:this.bursts, rec:this.rec};
  }

  emitSch(){
    const fn=gsmFrameNr(this.t1,this.t2,this.t3);
    this.rec.push({t:Date.now(), kind:'GSM-SCH', bsic:(this.ncc<<3)|this.bcc,
      ncc:this.ncc, bcc:this.bcc, fn, dbm:this.dbm});
  }

  processTimeslot(){
    const type=this.burstType();
    this.dbm=this.signalDbm();
    let toConsume=0;
    if(type==='fcch'){
      // измеряем остаточное смещение частоты и корректируем петлю
      const h=this.head; let phaseSum=0;
      const first=Math.ceil((GSM_GUARD+2*GSM_TAIL)*GSM_OSR)+1, last=first+GSM_USEFUL*GSM_OSR-GSM_TAIL*GSM_OSR;
      for(let ii=first;ii<last;ii++) phaseSum+=this.phaseDiff(ii,ii-1)-(Math.PI/2)/GSM_OSR;
      this.freqOffset=(phaseSum/(last-first))*GSM_TARGET_SR/(2*Math.PI);
      this.freqUpdate=true;
    }
    else if(type==='sch'){
      const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
      const bs=this.getSchImp(chanRe,chanIm);
      if(bs>=0 && this.head+bs+GSM_BURST_SIZE*GSM_OSR<this.len){
        const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
        const r=gsmDecodeSch(eb);
        if(r){ this.t1=r.t1; this.t2=r.t2; this.t3=r.t3; this.ncc=r.ncc; this.bcc=r.bcc; this.failedSch=0;
          this.emitSch(bs); this.emitBurst('sch',eb); }
        else if(++this.failedSch>=GSM_MAX_SCH_ERR){ this.state='fcch'; }
      }
    }
    else if(type==='normal'){
      const chanRe=new Float32Array(GSM_CHAN_IMP*GSM_OSR), chanIm=new Float32Array(GSM_CHAN_IMP*GSM_OSR);
      const bs=this.getNormImp(this.bcc,chanRe,chanIm);
      if(bs>=0 && this.head+bs+GSM_BURST_SIZE*GSM_OSR<this.len){
        const eb=new Uint8Array(GSM_BURST_SIZE); this.detectBurst(chanRe,chanIm,bs,eb);
        this.emitBurst('normal',eb);
      }
    }
    const off=this.advanceBurst();
    toConsume=GSM_TS_BITS*GSM_OSR+off;
    this.consume(toConsume);
  }

  emitBurst(type,eb){
    const fn=gsmFrameNr(this.t1,this.t2,this.t3);
    const bits=new Float32Array(GSM_BURST_SIZE);
    for(let i=0;i<GSM_BURST_SIZE;i++) bits[i]=eb[i]?1:-1;
    this.bursts.push({type, fn, tn:this.tn, bits, dbm:this.dbm});
  }
}

/* ---------- DSP-узел ---------- */
def({ id:'gsmRx', title:'GSM: Receive Bursts (IQ)', cat:'Decoders',
  ins:[{n:'in',t:'iq'}],
  outs:[{n:'rec',t:'rec'},{n:'burst',t:'blk'},{n:'freq',t:'num'},{n:'sync',t:'num'}],
  readout:true, tall:true,
  params:[{n:'afc',t:'check',d:true,label:'auto frequency correction (FCCH)'},
          {n:'clr',t:'button',label:'Clear log',fn:n=>{ n.log=[]; n.text='ищу FCCH…'; }}],
  init:n=>{ n.rx=new GsmReceiver(); n.foff=0; n.nco=0; n.frac=1; n.lr=new Float32Array(0); n.li=new Float32Array(0);
            n.bid=0; n.log=[]; n.text='ищу FCCH…'; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.text='нет входного IQ-потока'; return {rec:null, burst:null, freq:n.foff, sync:0}; }
    if(s.sr<GSM_TARGET_SR*0.98){ n.text='sr слишком низкий: нужно ≥ '+(GSM_TARGET_SR/1e6).toFixed(3)+' MS/s (GSM 270.833k×'+GSM_OSR+')'; return {rec:null, burst:null, freq:n.foff, sync:0}; }
    // ресемплинг любого sr на OSR·270.833 кГц (кубический Эрмит) + дерот. по накопл. смещению
    const ratio=s.sr/GSM_TARGET_SR, wderot=-2*Math.PI/GSM_TARGET_SR;
    // склейка: остаток прошлого блока + все чанки
    let total=n.lr.length; for(const c of s.chunks) total+=c.re.length;
    const xr=new Float32Array(total), xi=new Float32Array(total);
    xr.set(n.lr); xi.set(n.li); let w=n.lr.length;
    for(const c of s.chunks){ xr.set(c.re,w); if(c.im) xi.set(c.im,w); w+=c.re.length; }
    const outR=new Float32Array(Math.ceil(total/ratio)+4), outI=new Float32Array(outR.length);
    let outN=0, pos=n.frac;
    while(Math.floor(pos)+2 <= total-1){
      const k=Math.floor(pos), t=pos-k;
      let rr=gsmHerm(xr[k-1<0?0:k-1],xr[k],xr[k+1],xr[k+2],t);
      let ri=gsmHerm(xi[k-1<0?0:k-1],xi[k],xi[k+1],xi[k+2],t);
      if(n.p.afc && n.foff!==0){ const cr=Math.cos(n.nco), ci=Math.sin(n.nco);
        const a=rr*cr-ri*ci, b=rr*ci+ri*cr; rr=a; ri=b;
        n.nco+=wderot*n.foff; if(n.nco>1e4||n.nco<-1e4) n.nco%=2*Math.PI; }
      outR[outN]=rr; outI[outN]=ri; outN++;
      pos+=ratio;
    }
    // остаток: держим по одному отсчёту слева от следующей позиции (для k-1)
    let keepFrom=Math.max(0,Math.floor(pos)-1);
    n.lr=xr.slice(keepFrom); n.li=xi.slice(keepFrom); n.frac=pos-keepFrom;
    if(outN){ n.rx.push(outR.subarray(0,outN), outI.subarray(0,outN));
      const {bursts,rec}=n.rx.work();
      // частотная петля
      if(n.p.afc && n.rx.freqOffset!=null && (n.rx.state!=='fcch' || n.rx.freqUpdate)){
        n.foff+=n.rx.freqOffset; n.rx.freqOffset=null; n.rx.freqUpdate=false;
        n.foff=clamp(n.foff,-GSM_TARGET_SR/2,GSM_TARGET_SR/2);
      }
      let outRec=rec.length?rec:null, blk=null;
      for(const b of bursts){
        blk={d:b.bits, n:b.bits.length, id:++n.bid, fn:b.fn, tn:b.tn, kind:b.type};
        if(n.log.length<200) n.log.push(`FN ${b.fn} TN ${b.tn} ${b.type}${b.type==='sch'?'':''} ${b.dbm} dBm`);
      }
      for(const r of rec) n.log.push(`SCH: BSIC ${r.bsic} (NCC ${r.ncc}/BCC ${r.bcc}) FN ${r.fn} ${r.dbm} dBm`);
      if(n.log.length>200) n.log.splice(0,n.log.length-200);
      n.text=(n.rx.state==='sync'?'синхр.':n.rx.state==='sch'?'жду SCH':'ищу FCCH')+
        ` · foff ${n.foff.toFixed(0)} Hz · бёрстов ${n.bid}\n`+n.log.slice(-14).join('\n');
      return {rec:outRec, burst:blk, freq:n.foff, sync:n.rx.state==='sync'?1:0};
    }
    return {rec:null, burst:null, freq:n.foff, sync:n.rx.state==='sync'?1:0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text||''; }});

function gsmHerm(y0,y1,y2,y3,t){
  const c1=0.5*(y2-y0), c2=y0-2.5*y1+2*y2-0.5*y3, c3=0.5*(y3-y0)+1.5*(y1-y2);
  return ((c3*t+c2)*t+c1)*t+y1;
}
