"use strict";
/* ============================================================
   Определитель типа сигнала (sigid). Не зависит от источника:
   работает по кадрам спектра (вход spec — rtlsdr, fft, tinySA…) или
   сам считает спектр со входа in (аудио).
   1) детектор: пол шума — морфологическое «открытие» медиан блоков,
      сегменты выше порога;
   2) трекинг по кадрам: ширина по 99% мощности, форма, занятость во времени;
   3) классификация по форме спектра — без отсчётов;
   4) если есть отсчёты — сырой IQ rtlsdr на родной частоте (spec.iq) или
      вход in — по одному сигналу за раз: перенос в ноль, децимация CIC,
      огибающая, мгновенная частота, линии в z, z², z⁴, скорость манипуляции,
      CTCSS и стереопилот.
   Выход bands — метки sig:true: 'sa' рисует их над сигналами, 'bandplan'
   пропускает через вход sigs. Эвристика, а не декодер.
   ============================================================ */

const SID_T={
  CAR:{n:'carrier',c:'#fff176'}, TONE:{n:'tone',c:'#90a4ae'}, CW:{n:'CW',c:'#4fc3f7'},
  OOK:{n:'OOK',c:'#4dd0e1'}, AM:{n:'AM',c:'#ffb74d'}, USB:{n:'USB',c:'#81c784'},
  LSB:{n:'LSB',c:'#81c784'}, SSB:{n:'SSB',c:'#81c784'}, VOICE:{n:'voice',c:'#aed581'},
  NFM:{n:'NFM',c:'#ef5350'}, WFM:{n:'WFM',c:'#ffa726'}, FSK:{n:'FSK',c:'#ce93d8'},
  MFSK:{n:'MFSK',c:'#ba68c8'}, PSK:{n:'PSK',c:'#9575cd'}, DIG:{n:'digital',c:'#7986cb'},
  OFDM:{n:'OFDM',c:'#a1887f'}, DTMF:{n:'DTMF',c:'#f06292'}, UNK:{n:'?',c:'#b0bec5'},
};
const SID_DTMF_R=[697,770,852,941], SID_DTMF_C=[1209,1336,1477,1633], SID_DTMF_K='123A456B789C*0#D';
const SID_CTCSS=[67,69.3,71.9,74.4,77,79.7,82.5,85.4,88.5,91.5,94.8,97.4,100,103.5,107.2,110.9,
  114.8,118.8,123,127.3,131.8,136.5,141.3,146.2,151.4,156.7,159.8,162.2,165.5,167.9,171.3,173.8,
  177.3,179.9,183.5,186.2,189.9,192.8,196.6,199.5,203.5,206.5,210.7,218.1,225.7,229.1,233.6,
  241.8,250.3,254.1];

// ---- аудио: своё кольцо (для анализа отсчётов) и свой спектр, если spec не подключён ----
function sidAudioPush(n,x){
  const sr=Eng.sr, size=pow2ge(Math.round(sr*Math.max(2,n.p.period*1.6)));
  let r=n.aring;
  if(!r || r.size!==size || r.sr!==sr) r=n.aring={I:new Float32Array(size),Q:null,size,w:0,filled:0,written:0,sr};
  const I=r.I, M=size-1; let w=r.w;
  for(let i=0;i<BLOCK;i++){ I[w]=x[i]; w=(w+1)&M; }
  r.w=w; r.filled=Math.min(size,r.filled+BLOCK); r.written+=BLOCK;
}
// Уэлч по 2 кадрам с перекрытием 50%; нормировка как у 'fft' — уровни совпадают на 'sa'
function sidOwnSpec(n){
  const r=n.aring, N=+n.p.fftSize;
  if(!r || r.filled<N) return null;
  let o=n.os;
  if(!o || o.N!==N){
    const win=window_('hann',N); let wg=0; for(let i=0;i<N;i++) wg+=win[i];
    o=n.os={N,win,wg,re:new Float32Array(N),im:new Float32Array(N),acc:new Float64Array(N/2),k:0,last:0,rev:0,sp:null};
  }
  if(r.written-o.last<N/2) return o.sp;
  o.last=r.written;
  const {re,im,win}=o, M=r.size-1, st=(r.w-N+r.size)&M;
  for(let i=0;i<N;i++){ re[i]=r.I[(st+i)&M]*win[i]; im[i]=0; }
  fft(re,im);
  for(let k=0;k<N/2;k++) o.acc[k]+=re[k]*re[k]+im[k]*im[k];
  if(++o.k<2) return o.sp;
  const mag=new Float32Array(N/2);
  for(let k=0;k<N/2;k++) mag[k]=2*Math.sqrt(o.acc[k]/o.k)/o.wg;
  o.acc.fill(0); o.k=0;
  return o.sp={mag,sr:Eng.sr,size:N,freqs:null,rev:++o.rev};
}

// Входящий спектр копим (мощность) не меньше 80 мс и двух длин окна: у 'fft' новый кадр на каждый
// блок с перекрытием ~90% — соседние кадры почти одинаковы, и шумовой пик «подтверждался» бы сам собой
function sidAccum(n,s,now){
  const m=s.mag, N=m.length, key=N+'|'+s.sr+'|'+(s.freqs? s.freqs[0]+':'+s.freqs[N-1] : 'a');
  let a=n.acc;
  if(!a || a.key!==key){ a=n.acc={key,P:new Float64Array(N),k:0,t0:now}; }
  const P=a.P; for(let i=0;i<N;i++) P[i]+=m[i]*m[i];
  a.k++;
  const win=s.size&&s.sr? 2000*s.size/s.sr : 0;
  if(now-a.t0<Math.max(80,win)) return null;
  const mag=new Float32Array(N); for(let i=0;i<N;i++) mag[i]=Math.sqrt(P[i]/a.k);
  P.fill(0); a.k=0; a.t0=now;
  return {mag, sr:s.sr, size:s.size, freqs:s.freqs, iq:s.iq};
}

// ---- детектор ----
// пол шума: медианы блоков → эрозия+дилатация (открытие) окном ~1/8 полосы → интерполяция по бинам.
// Сигналы уже окна «срезаются», медленный завал краёв фильтра приёмника остаётся.
function sidFloor(n,pw,N){
  const B=Math.max(8,N>>7), nb=Math.ceil(N/B), R=Math.max(2,nb>>4);
  const blk=new Float32Array(nb), er=new Float32Array(nb), op=new Float32Array(nb);
  const scr=n._scr&&n._scr.length>=B? n._scr : (n._scr=new Float32Array(B));
  const rat=new Float32Array(nb);                    // p90/медиана блока — разброс шума
  for(let j=0;j<nb;j++){
    const a=j*B, b=Math.min(N,a+B); let c=0;
    for(let i=a;i<b;i++) scr[c++]=pw[i];
    blk[j]=cfarSelect(scr,c,c>>1);
    rat[j]=cfarSelect(scr,c,Math.floor(.9*(c-1)))/(blk[j]||1e-30);
  }
  n.fluctDb=10*Math.log10(cfarSelect(rat,nb,nb>>1)||1);
  for(let j=0;j<nb;j++){ let m=Infinity;
    for(let k=Math.max(0,j-R);k<=Math.min(nb-1,j+R);k++) if(blk[k]<m) m=blk[k]; er[j]=m; }
  for(let j=0;j<nb;j++){ let m=0;
    for(let k=Math.max(0,j-R);k<=Math.min(nb-1,j+R);k++) if(er[k]>m) m=er[k]; op[j]=Math.max(m,1e-30); }
  const fl=n._fl&&n._fl.length===N? n._fl : (n._fl=new Float32Array(N));
  for(let i=0;i<N;i++){
    const t=(i+.5)/B-.5, j=clamp(Math.floor(t),0,nb-1), j2=Math.min(nb-1,j+1), f=clamp(t-j,0,1);
    fl[i]=op[j]+(op[j2]-op[j])*f;
  }
  return fl;
}
function sidSegments(n,s){
  const m=s.mag, N=m.length;
  if(N<16) return [];
  const pw=n._pw&&n._pw.length===N? n._pw : (n._pw=new Float32Array(N));
  for(let i=0;i<N;i++){ const v=m[i]; pw[i]=v*v; }
  // DC-выброс приёмника — в центре IQ-спектра
  if(s.iq){ const c=N>>1, v=(pw[c-4]+pw[c+4])/2; for(let i=c-1;i<=c+1;i++) pw[i]=Math.min(pw[i],v); }
  // неусреднённый спектр (разброс шума ~5 дБ против ~0.5) — порог выше, иначе шумовые пики
  const fl=sidFloor(n,pw,N), thrDb=n.p.thr+Math.max(0,(n.fluctDb-1.5)*1.2), thr=Math.pow(10,thrDb/10);
  n.thrDb=thrDb;
  const binHz=Math.abs(specHz(s,1)-specHz(s,0))||1;
  const runs=[]; let a=-1, last=-1;
  for(let i=1;i<N-1;i++){
    if(pw[i]>fl[i]*thr && pw[i]>1e-24){ if(a<0) a=i; last=i; }
    else if(a>=0 && i-last>Math.max(2,Math.round((last-a+1)*.15))){ runs.push([a,last]); a=-1; }
  }
  if(a>=0) runs.push([a,last]);
  // сильный сегмент режем по провалам глубже 30 дБ от пика: два тона с брызгами манипуляции между ними
  for(let r=runs.length-1;r>=0;r--){
    const [a,b]=runs[r]; let pk=a; for(let i=a;i<=b;i++) if(pw[i]>pw[pk]) pk=i;
    const lv=pw[pk]*1e-3, sub=[]; let sa=-1;
    for(let i=a;i<=b+1;i++){
      const on=i<=b && pw[i]>lv && pw[i]>fl[i]*thr;
      if(on && sa<0) sa=i; else if(!on && sa>=0){ sub.push([sa,i-1]); sa=-1; }
    }
    // узкие нули внутри одного сигнала (FSK, MFSK) — не разрез: промежуток должен быть шире кусков
    for(let i=sub.length-1;i>0;i--){
      const x=sub[i-1], y=sub[i];
      if(y[0]-x[1]<Math.max(4,x[1]-x[0]+1,y[1]-y[0]+1)){ x[1]=y[1]; sub.splice(i,1); }
    }
    if(sub.length>1) runs.splice(r,1,...sub);
  }
  const out=[];
  for(const [a,b] of runs){
    let pk=a, tot=0, cen=0;
    for(let i=a;i<=b;i++){ const e=Math.max(0,pw[i]-fl[i]); tot+=e; cen+=e*i; if(pw[i]>pw[pk]) pk=i; }
    if(tot<=0) continue;
    const snr=10*Math.log10(pw[pk]/fl[pk]);
    if(b===a && snr<thrDb+3) continue;                  // одиночный бин — только с запасом
    // 99% мощности
    let c=0, i0=a, i1=b;
    for(let i=a;i<=b;i++){ c+=Math.max(0,pw[i]-fl[i]); if(c>=tot*.005){ i0=i; break; } }
    c=0; for(let i=a;i<=b;i++){ c+=Math.max(0,pw[i]-fl[i]); if(c>=tot*.995){ i1=i; break; } }
    let l3=pk, r3=pk;
    while(l3>a && pw[l3-1]>=pw[pk]/2) l3--;
    while(r3<b && pw[r3+1]>=pw[pk]/2) r3++;
    // плоскость (геом./арифм. среднее) и выпирание несущей над остальной полосой
    let sl=0, sa=0, cnt=0, rest=0, rc=0;
    for(let i=i0;i<=i1;i++){
      const e=Math.max(pw[i]-fl[i],fl[i]*1e-3);
      sl+=Math.log(e); sa+=e; cnt++;
      if(Math.abs(i-pk)>1){ rest+=e; rc++; }
    }
    const obw=Math.abs(specHz(s,i1)-specHz(s,i0))+binHz;
    out.push({lo:specHz(s,a)-binHz/2, hi:specHz(s,b)+binHz/2, fc:specHz(s,cen/tot), obw,
      bw3:Math.abs(specHz(s,r3)-specHz(s,l3))+binHz,
      flat:cnt>2? Math.exp(sl/cnt)/(sa/cnt) : 0,
      carDb:rc>1? 10*Math.log10(Math.max(pw[pk]-fl[pk],1e-30)/(rest/rc)) : 0,
      asym:i1>i0? (cen/tot-(i0+i1)/2)/(i1-i0+1) : 0,
      snr, db:20*Math.log10(m[pk]+1e-12), floorDb:10*Math.log10(fl[pk])});
  }
  out.sort((x,y)=>y.snr-x.snr);
  // слабые «сигналы» вплотную к сильному — его боковые лепестки
  for(let i=out.length-1;i>0;i--){ const w=out[i];
    if(out.some((b,j)=>j<i && b.snr-w.snr>20 && Math.abs(b.fc-w.fc)<3*b.obw+w.obw)) out.splice(i,1); }
  n.floorDb=10*Math.log10(fl[N>>1]||1e-30);
  n.binHz=binHz;
  return out.slice(0,48);
}

// ---- трекинг: тот же сигнал из кадра в кадр, признаки — скользящим средним ----
const sidPop=x=>{ let c=0; for(;x;x&=x-1) c++; return c; };
function sidTrack(n,segs,s,now){
  const tracks=n.tracks;
  for(const t of tracks){ t.hist=(t.hist<<1)>>>0; t.hit=false; t.age++; }
  for(const g of segs){
    // широкий всплеск поверх нескольких узких треков (брызги манипуляции) — только отметка «есть»
    const under=tracks.filter(t=>t.ok && t.lo>=g.lo-n.binHz && t.hi<=g.hi+n.binHz && t.obw*3<g.obw);
    if(under.length>=2){ for(const t of under){ t.hist|=1; t.hit=true; t.t=now; } continue; }
    const tol=Math.max(2*n.binHz,(g.hi-g.lo)*.25);
    let t=tracks.find(t=>g.lo<=t.hi+tol && g.hi>=t.lo-tol && Math.abs(g.fc-t.fc)<=Math.max(tol,(t.hi-t.lo)*.6));
    if(t && t.hit){                                   // второй кусок того же сигнала в этом кадре
      t.lo=Math.min(t.lo,g.lo); t.hi=Math.max(t.hi,g.hi); continue; }
    if(!t){ tracks.push(t={id:++n.tid, t0:now, age:1, ...g, wvar:0, hist:0, ok:false, iq:null, iqT:0}); }
    else {
      const k=t.ok && g.obw>4*t.obw? .1 : .3, e=(a,b)=>a+(b-a)*k;   // резкое расширение — скорее всплеск
      t.wvar=e(t.wvar,Math.abs(g.obw-t.obw)/Math.max(t.obw,1));
      const kw=g.hi-g.lo>t.hi-t.lo? .6 : .2;
      t.lo+=(g.lo-t.lo)*kw; t.hi+=(g.hi-t.hi)*kw;
      for(const f of ['fc','obw','bw3','flat','carDb','asym','snr','floorDb']) t[f]=e(t[f],g[f]);
      t.db=g.db;
    }
    t.hist|=1; t.hit=true; t.t=now;
    // слабый узкий — 3 из 4 кадров: шумовой выброс в одном месте дважды почти не повторяется
    if(!t.ok && sidPop(t.hist&15)>=(t.snr<n.thrDb+6 && t.obw<=3*n.binHz? 3 : 2)) t.ok=true;
  }
  const hold=Math.max(2000,n.p.period*1500), [lo0,hi0]=specSpan(s);
  n.tracks=tracks.filter(t=>(t.hit || (t.ok? now-t.t<=hold : (t.hist&15)!==0)) && t.fc>=lo0 && t.fc<=hi0);
}
// занятость и число включений за окно истории
function sidDuty(t){
  const w=Math.min(32,t.age), h=w>=32? t.hist : t.hist&((1<<w)-1);
  let on=0, tr=0, prev=0;
  for(let i=w-1;i>=0;i--){ const b=(h>>>i)&1; on+=b; if(b&&!prev) tr++; prev=b; }
  return {duty:w? on/w : 0, trans:tr};
}

// ---- сигналы из треков: DTMF и FSK-пары склеиваются в один ----
function sidSignals(n,s){
  const tr=n.tracks.filter(t=>t.ok).sort((a,b)=>a.fc-b.fc), used=new Set(), out=[];
  const narrow=t=>t.obw<=Math.max(2.5*n.binHz,80);
  const near=(f,tab)=>tab.findIndex(x=>Math.abs(f-x)<=x*.025);
  for(let i=0;i<tr.length;i++) for(let j=i+1;j<tr.length;j++){
    const a=tr[i], b=tr[j]; if(used.has(a)||used.has(b)||!narrow(a)||!narrow(b)) continue;
    const r=near(a.fc,SID_DTMF_R), c=near(b.fc,SID_DTMF_C);
    if(r>=0 && c>=0 && (a.hist&b.hist&15) && Math.abs(a.db-b.db)<10){
      used.add(a); used.add(b); out.push(sidGroup(n,[a,b],{dtmf:SID_DTMF_K[r*4+c]})); }
  }
  for(let i=0;i+1<tr.length;i++){
    const a=tr[i], b=tr[i+1]; if(used.has(a)||used.has(b)) continue;
    const gap=b.fc-a.fc;
    // два ровных тона одного уровня; отказ по отсчётам (n.noPair) — больше не склеиваем
    if(gap>=40 && gap<=Math.max(1200,25*n.binHz) && a.obw<=gap*.5 && b.obw<=gap*.5 && Math.abs(a.db-b.db)<6 &&
       Math.max(a.obw,b.obw)<=2.5*Math.min(a.obw,b.obw) &&
       sidDuty(a).duty>.6 && sidDuty(b).duty>.6 && !n.noPair.has(a.id+'+'+b.id)){
      used.add(a); used.add(b); out.push(sidGroup(n,[a,b],{pair:true, shift:gap})); }
  }
  for(const t of tr) if(!used.has(t)) out.push(sidGroup(n,[t],{}));
  return out;
}
function sidGroup(n,ts,ext){
  const lead=ts.reduce((a,b)=>b.snr>a.snr?b:a), lo=Math.min(...ts.map(t=>t.lo)), hi=Math.max(...ts.map(t=>t.hi));
  const {duty,trans}=sidDuty(lead);
  return {key:ts.map(t=>t.id).join('+'), tracks:ts, lead, lo, hi,
    fc:ts.length>1? (ts[0].fc+ts[ts.length-1].fc)/2 : lead.fc,
    obw:ts.length>1? ts[ts.length-1].fc-ts[0].fc+Math.max(...ts.map(t=>t.obw)) : lead.obw,
    snr:lead.snr, db:Math.max(...ts.map(t=>t.db)), duty, trans, binHz:n.binHz, rf:n.rf, ...ext};
}

// ---- классификация по спектру (без отсчётов) ----
function sidSpecClass(g){
  const t=g.lead, bw=g.obw, bin=g.binHz;
  if(g.dtmf) return {t:'DTMF', conf:.85, tag:'DTMF '+g.dtmf, det:'row/column tones, key '+g.dtmf};
  if(g.pair) return {t:'FSK', conf:.45, tag:'FSK '+fmtHz(g.shift,0)+'Hz', det:'two alternating tones, shift '+fmtHz(g.shift,0)+'Hz', shift:g.shift};
  if(bw<=Math.max(2.5*bin,50)){
    if(g.duty>.1 && g.duty<.9 && g.trans>=3) return {t:'CW', conf:.55, tag:'CW', det:'narrow, on/off keyed'};
    return g.rf? {t:'CAR', conf:.4, tag:'carrier', det:'narrow, steady'} : {t:'TONE', conf:.4, tag:'tone', det:'narrow, steady'};
  }
  if(bw>=4e6) return t.flat>.6? {t:'OFDM', conf:.5, tag:'OFDM '+fmtHz(bw,1), det:'wide flat-top block'}
                              : {t:'DIG', conf:.3, tag:'wide '+fmtHz(bw,1), det:'wideband'};
  if(bw>=80e3 && bw<=320e3){
    if(t.flat>.8 && t.bw3>bw*.6 && t.wvar<.08) return {t:'DIG', conf:.4, tag:'digital '+fmtHz(bw,0), det:'flat-top, constant width'};
    return {t:'WFM', conf:.55, tag:'WFM', det:'broadcast-width FM'};
  }
  if(t.carDb>=10 && bw>=2e3 && bw<=20e3 && Math.abs(t.asym)<.2) return {t:'AM', conf:.55, tag:'AM', det:'carrier '+t.carDb.toFixed(0)+' dB over symmetric sidebands'};
  if(bw>=5e3 && bw<80e3){
    if(t.flat>.7 && t.bw3>bw*.55 && t.wvar<.1 && g.duty>.6) return {t:'DIG', conf:.4, tag:'digital '+fmtHz(bw,1), det:'flat-top, constant width'};
    return {t:'NFM', conf:.45, tag:'NFM', det:''};
  }
  if(bw>=1.5e3 && bw<5e3){
    if(t.flat>.75 && t.wvar<.1 && g.duty>.7) return {t:'DIG', conf:.35, tag:'data '+fmtHz(bw,1), det:'flat, constant width (modem)'};
    // голос: энергия у нижних звуковых частот — у USB это нижний край полосы, у LSB верхний
    const sb=t.asym<-.06? 'USB' : t.asym>.06? 'LSB' : 'SSB';
    return {t:sb, conf:sb==='SSB'? .3 : .4, tag:sb, det:'no carrier, energy at the '+(sb==='USB'?'lower':sb==='LSB'?'upper':'—')+' edge'};
  }
  if(bw>=12 && bw<=80) return {t:'MFSK', conf:.4, tag:'MFSK '+fmtHz(bw,0)+'Hz', det:'narrow weak-signal MFSK width'};
  if(bw>80 && bw<1.5e3) return t.flat>.5? {t:'MFSK', conf:.35, tag:'MFSK '+fmtHz(bw,0)+'Hz', det:'flat, several tones'}
                                         : {t:'DIG', conf:.3, tag:'narrow data', det:'narrowband data (PSK/FSK)'};
  return {t:'UNK', conf:.2, tag:'?', det:''};
}

// ---- отсчёты: IQ rtlsdr (spec.iq) или аудиокольцо ----
function sidSource(n,s){
  if(s && s.iq && s.iq.ring) return {ring:s.iq.ring, sr:s.iq.sr, fc:s.iq.fc};
  if(n.aring && n.inOn && (!s || !s.freqs)) return {ring:n.aring, sr:n.aring.sr, fc:0};
  return null;
}
// один сигнал за раз: перенос в ноль + CIC-2 с децимацией до ~3× полосы, копим до period
function sidFocusNew(n,src,g,now){
  // центр — середина сегмента: центроид у многотоновых гуляет, края тогда уходят на скат ФНЧ
  const B=Math.max(g.obw*1.3,Math.min((g.hi-g.lo)*1.1,g.obw*2),150), D=Math.max(1,Math.floor(src.sr/(3*B))), fs2=src.sr/D;
  // узким (медленная манипуляция) — до period, совсем узким (FT8, WSPR) — полтора, широким хватает полсекунды
  const dur=g.obw<100? n.p.period*1.5 : g.obw<3e3? n.p.period*.75 : .5;
  const cap=Math.min(32768,Math.round(fs2*dur)), r=src.ring;
  return {key:g.key, dur, ring:r, fc:src.fc, off:(g.pair||g.dtmf? g.fc : (g.lo+g.hi)/2)-src.fc, sr:src.sr, B, D, fs2, cap,
    zi:new Float32Array(cap), zq:new Float32Array(cap), m:0,
    pos:r.written-Math.min(r.filled,cap*D), cr:1, ci:0, k:0,
    s1r:0,s1i:0,s2r:0,s2i:0,d1r:0,d1i:0,d2r:0,d2i:0, t0:now};
}
function sidFocusFeed(fx){
  const r=fx.ring, size=r.size;
  let avail=r.written-fx.pos;
  if(avail>r.filled){                                 // кольцо обогнало — непрерывность потеряна, заново
    fx.pos=r.written-r.filled; fx.m=0; avail=r.filled; }
  avail=Math.min(avail,(fx.cap-fx.m)*fx.D);
  if(avail<=0) return;
  const I=r.I, Q=r.Q, D=fx.D, w=-2*Math.PI*fx.off/fx.sr, wr=Math.cos(w), wi=Math.sin(w), g=1/(D*D);
  let p=((r.w-(r.written-fx.pos))%size+size)%size;
  let {cr,ci,k,s1r,s1i,s2r,s2i,d1r,d1i,d2r,d2i,m}=fx;
  const zi=fx.zi, zq=fx.zq;
  for(let j=0;j<avail;j++){
    const xr=I[p], xi=Q? Q[p] : 0;
    const yr=xr*cr-xi*ci, yi=xr*ci+xi*cr, t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t;
    s1r+=yr; s1i+=yi; s2r+=s1r; s2i+=s1i;
    if(++k===D){ k=0;
      const c1r=s2r-d1r, c1i=s2i-d1i; d1r=s2r; d1i=s2i;
      const c2r=c1r-d2r, c2i=c1i-d2i; d2r=c1r; d2i=c1i;
      zi[m]=c2r*g; zq[m]=c2i*g; m++; }
    if(++p===size) p=0;
  }
  const nm=1/Math.hypot(cr,ci);
  Object.assign(fx,{cr:cr*nm,ci:ci*nm,k,s1r,s1i,s2r,s2i,d1r,d1i,d2r,d2i,m});
  fx.pos+=avail;
}
function sidFocusStep(n,src,sigs,now){
  let fx=n.fx;
  if(fx && (!src || fx.ring!==src.ring || fx.fc!==src.fc || !sigs.some(g=>g.key===fx.key))) fx=n.fx=null;
  if(!src) return;
  if(!fx){
    if(now-(n.fxLast||0)<150) return;
    if(n.wPend && now-n.fxLast<3000) return;          // ждём воркер (зависший — бросаем)
    n.wPend=null;
    // новые — сразу, уже разобранные — не чаще раза в 4 с
    const c=sigs.filter(g=>g.snr>=n.p.thr+2 && (!g.lead.iqT || now-g.lead.iqT>4000))
      .sort((a,b)=>(a.lead.iqT-b.lead.iqT) || (b.snr-a.snr))[0];
    if(!c) return;
    fx=n.fx=sidFocusNew(n,src,c,now);
  }
  sidFocusFeed(fx);
  if(fx.m>=fx.cap || now-fx.t0>=fx.dur*1000+500){
    const g=sigs.find(x=>x.key===fx.key);
    n.fx=null; n.fxLast=now;
    if(!g) return;
    g.lead.iqT=now;
    const w=sidWorker(n);
    if(!w){ sidIqDone(n,g,sidIqFeatures(fx)); return; }
    // разбор — в воркере: десятки мс одним куском на главном потоке дали бы щелчок в звуке
    const id=++n.wid; n.wPend={id,g};
    w.postMessage({id,zi:fx.zi,zq:fx.zq,m:fx.m,B:fx.B,fs2:fx.fs2,off:fx.off},[fx.zi.buffer,fx.zq.buffer]);
  }
}
function sidIqDone(n,g,f){
  if(!f) return;
  if(g.pair){                                         // пара не подтвердилась как FSK — это два разных сигнала
    const c=sidIqClass(f,g);
    if(c?.t!=='FSK' || Math.abs(c.spacing-g.shift)>g.shift*.25){ if(n.noPair.size>200) n.noPair.clear(); n.noPair.add(g.key); }
    else g.lead.iq=f;
  } else g.lead.iq=f;
}
// воркер собирается из исходников тех же функций — код анализа один
function sidWorker(n){
  if(n.worker!==undefined) return n.worker;
  n.worker=null;
  if(typeof Worker==='undefined' || typeof Blob==='undefined') return null;
  try{
    const src=[fft,cfarSelect,sidPctl,sidLine,sidIqFeatures].map(f=>f.toString()).join('\n')+
      '\nonmessage=e=>{ let f=null; try{ f=sidIqFeatures(e.data); }catch(_){} postMessage({id:e.data.id,f}); };';
    const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
    n.worker=new Worker(url); URL.revokeObjectURL(url);
    n.worker.onmessage=e=>{ const p=n.wPend;
      if(p && p.id===e.data.id){ n.wPend=null; sidIqDone(n,p.g,e.data.f); } };
    n.worker.onerror=()=>{ n.worker.terminate(); n.worker=null; n.wPend=null; };
  }catch(_){ n.worker=null; }
  return n.worker;
}

// спектральная линия в [fmin,fmax]; x — вещественный или комплексный (xi).
// frac — доля мощности в самом сильном пике (несущая в z, z², z⁴);
// loc — дискретная линия над локальным фоном ±W бинов (скорость манипуляции, CTCSS, пилот):
// f/db — самая выделенная, а не самая сильная, иначе побеждает сплошной «горб» низких частот.
function sidLine(xr,xi,L,fs,fmin,fmax,maxK,loc){
  const K=Math.min(maxK||8192,1<<Math.floor(Math.log2(Math.max(2,L))));
  if(K<64) return {f:0,db:0,frac:0};
  // Уэлч по всему отрезку (перекрытие 50%): манипуляция с паузами не теряет линию
  const re=new Float32Array(K), im=new Float32Array(K), P=new Float32Array(K), dc=!xi;
  let mr=0; if(dc){ for(let i=0;i<L;i++) mr+=xr[i]; mr/=L; }  // у вещественного — убираем постоянку
  for(let st=0;st+K<=L;st+=K>>1){
    for(let i=0;i<K;i++){ const w=.5-.5*Math.cos(2*Math.PI*i/K);
      re[i]=(xr[st+i]-mr)*w; im[i]=xi? xi[st+i]*w : 0; }
    fft(re,im);
    for(let i=0;i<K;i++) P[i]+=re[i]*re[i]+im[i]*im[i];
  }
  let tot=0; for(let i=0;i<K;i++) tot+=P[i];
  const bf=k=>(k<K/2? k : k-K)*fs/K;
  let best=-1, bv=0; const idx=[];
  for(let k=0;k<K;k++){ const f=bf(k), af=Math.abs(f);
    if(!xi && k>K/2) continue;
    if(af<fmin || af>fmax) continue;
    idx.push(P[k]); if(P[k]>bv){ bv=P[k]; best=k; } }
  if(best<0 || idx.length<8) return {f:0,db:0,frac:0};
  const frac=(bv+P[(best-1+K)%K]+P[(best+1)%K])/(tot||1);
  let db;
  if(loc){
    const W=Math.max(12,K>>8), S=new Float64Array(K+1);
    for(let k=0;k<K;k++) S[k+1]=S[k]+P[k];
    const avg=k=>{ const a=Math.max(0,k-W), b=Math.min(K,k+W+1), ea=Math.max(a,k-2), eb=Math.min(b,k+3);
      return ((S[b]-S[a])-(S[eb]-S[ea]))/Math.max(1,(b-a)-(eb-ea)); };
    let bp=0; best=-1;
    for(let k=0;k<K;k++){ if(!xi && k>K/2) continue; const af=Math.abs(bf(k)); if(af<fmin || af>fmax) continue;
      const pr=P[k]/(avg(k)||1e-30); if(pr>bp){ bp=pr; best=k; } }
    if(best<0) return {f:0,db:0,frac};
    // у манипуляции линии на кратных скорости; есть заметная линия на f/m — берём её
    const kb=bf(best)<0? best-K : best;
    for(let m=6;m>=2;m--){
      const k0=Math.round(kb/m); if(Math.abs(bf((k0+K)%K))<fmin) continue;
      let km=k0, pm=0;
      for(let k=k0-1;k<=k0+1;k++){ const kk=(k+K)%K, pr=P[kk]/(avg(kk)||1e-30); if(pr>pm){ pm=pr; km=kk; } }
      if(pm>=6 && pm>=bp*.05){ best=km; bp=pm; break; }
    }
    db=10*Math.log10(bp);
  } else {
    const sc=Float32Array.from(idx);
    db=10*Math.log10(P[best]/(cfarSelect(sc,sc.length,sc.length>>1)||1e-30));
  }
  const a=P[(best-1+K)%K], b0=P[best], c=P[(best+1)%K], den=a-2*b0+c, d=den<0? .5*(a-c)/den : 0;
  return {f:bf(best)+d*fs/K, db, frac};
}
function sidPctl(a,q){ const s=Float32Array.from(a); return s.length? cfarSelect(s,s.length,Math.floor(q*(s.length-1))) : 0; }

function sidIqFeatures(fx){
  const M=fx.m, T=31;
  if(M<T+256) return null;
  // ФНЧ (оконный sinc) — CIC соседей давит слабо
  const fcN=Math.min(.45,fx.B/2/fx.fs2), h=new Float32Array(T); let hs=0;
  for(let i=0;i<T;i++){ const x=i-(T-1)/2;
    h[i]=(x? Math.sin(2*Math.PI*fcN*x)/(Math.PI*x) : 2*fcN)*(.54-.46*Math.cos(2*Math.PI*i/(T-1))); hs+=h[i]; }
  const L=M-T-2, zr=new Float32Array(L), zi=new Float32Array(L), a=new Float32Array(L);
  for(let k=0;k<L;k++){ let sr=0, si=0;
    for(let j=0;j<T;j++){ sr+=fx.zi[k+2+j]*h[j]; si+=fx.zq[k+2+j]*h[j]; }
    zr[k]=sr/hs; zi[k]=si/hs; a[k]=Math.hypot(zr[k],zi[k]); }
  const fs=fx.fs2;
  // огибающая
  let m1=0, m2=0, m4=0;
  for(let k=0;k<L;k++){ const v=a[k]; m1+=v; m2+=v*v; m4+=v*v*v*v; }
  m1/=L; m2/=L; m4/=L;
  if(m1<=0) return null;
  const cv=Math.sqrt(Math.max(0,m2-m1*m1))/m1, kurt=m4/(m2*m2);
  const p90=sidPctl(a,.9); let low=0; for(let k=0;k<L;k++) if(a[k]<.25*p90) low++;
  const lowFrac=low/L;
  // мгновенная частота там, где огибающая выше шума
  const gate=.3*m1, fi=new Float32Array(L); let prevF=0;
  const fiv=[];
  for(let k=1;k<L;k++){
    if(a[k]>gate && a[k-1]>gate){
      const re=zr[k]*zr[k-1]+zi[k]*zi[k-1], im=zi[k]*zr[k-1]-zr[k]*zi[k-1];
      prevF=Math.atan2(im,re)*fs/(2*Math.PI); fiv.push(prevF); }
    fi[k]=prevF;
  }
  const spread=fiv.length? sidPctl(fiv,.95)-sidPctl(fiv,.05) : 0;
  // скорость по скачкам частоты и «ступенчатость»: у MFSK частота стоит на месте весь символ,
  // у аналоговой ЧМ ползёт непрерывно. Окно — треть символа.
  const dfi=new Float32Array(L); for(let k=1;k<L;k++) dfi[k]=Math.abs(fi[k]-fi[k-1]);
  const rFsk=sidLine(dfi,null,L,fs,Math.max(8,fs/L*6),fs/2.2,0,true);
  // линии нет (мало символов в захвате) — окно 20 мс: для медленных MFSK вроде FT8
  const wS=Math.max(1,Math.round(rFsk.db>=10? .3*fs/rFsk.f : .02*fs)), pl=new Uint8Array(L);
  let plat=0;
  if(wS && spread>0){
    for(let k=wS;k<L;k++) if(Math.abs(fi[k]-fi[k-wS])<.05*spread && a[k]>gate){ pl[k]=1; plat++; }
    plat/=Math.max(1,L-wS);
  }
  // длительность символа по «ступеням» (медиана длины + окно) — для MFSK надёжнее линии
  let bPlat=0;
  if(plat>.5){
    const runs=[]; let r=0;
    for(let k=0;k<L;k++){ if(pl[k]) r++; else { if(r>=2) runs.push(r); r=0; } }
    if(runs.length>=4) bPlat=fs/(sidPctl(runs,.5)+wS+1);
  }
  // гистограмма мгновенной частоты — моды FSK (при ступенчатой — только по «ступеням»)
  const H=plat>.5? 256 : 128, half=fx.B/2, hist=new Float32Array(H);
  if(plat>.5){ for(let k=0;k<L;k++) if(pl[k]){ const b=Math.floor((fi[k]+half)/(2*half)*H); if(b>=0&&b<H) hist[b]++; } }
  else for(const f of fiv){ const b=Math.floor((f+half)/(2*half)*H); if(b>=0&&b<H) hist[b]++; }
  for(let pass=0;pass<(plat>.5? 1 : 2);pass++){ const c=hist.slice();
    for(let i=0;i<H;i++) hist[i]=(c[Math.max(0,i-1)]+2*c[i]+c[Math.min(H-1,i+1)])/4; }
  let hmax=0; for(const v of hist) if(v>hmax) hmax=v;
  let modes=[];
  for(let i=1;i<H-1;i++) if(hist[i]>=hist[i-1] && hist[i]>hist[i+1] && hist[i]>=(plat>.5? .12 : .2)*hmax) modes.push(i);
  // соседние пики без глубокой впадины между ними — одна мода
  for(let i=0;i+1<modes.length;){
    const x=modes[i], y=modes[i+1]; let v=Infinity; for(let k=x;k<=y;k++) v=Math.min(v,hist[k]);
    if(v>.6*Math.min(hist[x],hist[y])){ modes.splice(hist[x]>=hist[y]? i+1 : i,1); } else i++;
  }
  const bHz=b=>(b+.5)/H*2*half-half, mf=modes.map(bHz);
  // скорость 2/4-FSK по сериям решений: уровень меняем, только подойдя к новому ближе 35% разноса
  // (гистерезис — без дребезга на переходах); кратчайшие серии — один символ
  let bRun=0;
  if(mf.length>=2 && mf.length<=4){
    // новый уровень засчитывается, если продержался hold отсчётов: проскок через промежуточные у 4-FSK — не символ
    const sp=(mf[mf.length-1]-mf[0])/(mf.length-1), runs=[], hold=Math.max(2,Math.round(fs/fx.B));
    let cur=-1, st=0, cand=-1, cst=0, cn=0;
    for(let k=1;k<L;k++){
      if(a[k]<=gate) continue;
      let bi=0, bd=Infinity;
      for(let i=0;i<mf.length;i++){ const d=Math.abs(fi[k]-mf[i]); if(d<bd){ bd=d; bi=i; } }
      if(bd>.35*sp){ cand=-1; continue; }
      if(bi===cur){ cand=-1; continue; }
      if(bi!==cand){ cand=bi; cst=k; cn=0; }
      if(++cn<hold) continue;
      if(cur>=0) runs.push(cst-st);
      cur=bi; st=cst; cand=-1;
    }
    if(runs.length>=8){
      let T=sidPctl(runs,.3); const nr=runs.filter(r=>r>.6*T && r<1.4*T);
      if(nr.length) T=nr.reduce((x,y)=>x+y,0)/nr.length;
      bRun=fs/T;
    }
  }
  // доля отсчётов около мод — у FSK почти всё, у аналоговой ЧМ размазано
  // и доля между уровнями: FSK проходит середину только на переходах, синус (ЧМ тоном) — ~26% времени
  let conc=0, mid=0;
  if(mf.length>=2 && fiv.length){
    const sp=(mf[mf.length-1]-mf[0])/(mf.length-1)*.25;
    for(const f of fiv){
      if(mf.some(x=>Math.abs(f-x)<=sp)) conc++;
      for(let i=0;i+1<mf.length;i++) if(Math.abs(f-(mf[i]+mf[i+1])/2)<=.2*(mf[i+1]-mf[i])){ mid++; break; }
    }
    conc/=fiv.length; mid/=fiv.length;
  }
  // линии в z, z², z⁴ (доля мощности в пике): несущая / BPSK / QPSK
  const z2r=new Float32Array(L), z2i=new Float32Array(L), z4r=new Float32Array(L), z4i=new Float32Array(L);
  for(let k=0;k<L;k++){ const r=zr[k], i=zi[k], r2=r*r-i*i, i2=2*r*i;
    z2r[k]=r2; z2i[k]=i2; z4r[k]=r2*r2-i2*i2; z4i[k]=2*r2*i2; }
  const L1=sidLine(zr,zi,L,fs,0,fs/2,4096), L2=sidLine(z2r,z2i,L,fs,0,fs/2,4096), L4=sidLine(z4r,z4i,L,fs,0,fs/2,4096);
  // скорость манипуляции: у FSK — по скачкам частоты, у PSK/ASK — по огибающей
  // дорогие признаки — только когда пригодятся: скорость PSK, CTCSS, стереопилот
  let rEnv=null;
  if(L2.frac>.08 || L4.frac>.05){
    const a2=new Float32Array(L); for(let k=0;k<L;k++) a2[k]=a[k]*a[k];
    rEnv=sidLine(a2,null,L,fs,Math.max(8,fs/L*6),fs/2.2,0,true);
  }
  const fm=cv<.35 && spread>0;
  const ct=fm && fs>=700 && fx.B<40e3? sidLine(fi,null,L,fs,60,260,32768,true) : null;
  const pil=fm && fs>=45000? sidLine(fi,null,L,fs,18000,20000,0,true) : null;
  // CW/OOK: длина точки по отрезкам включения огибающей
  let wpm=0;
  if(lowFrac>.1){
    const sm=Math.max(1,Math.round(fs*.003)), thr=.5*p90, runs=[]; let acc=0, on=false, st=0;
    for(let k=0;k<L;k++){ acc+=a[k]; if(k>=sm) acc-=a[k-sm];
      const v=acc/Math.min(k+1,sm)>thr;
      if(v&&!on){ on=true; st=k; } else if(!v&&on){ on=false; runs.push((k-st)/fs); } }
    if(runs.length>=4){ const d=sidPctl(runs.filter(x=>x>.01),.2); if(d>0) wpm=1.2/d; }
  }
  return {cv, kurt, lowFrac, modes:mf, conc, mid, plat, bPlat, bRun, spread, F1:L1.frac, cOff:L1.f+fx.off,
    F2:L2.frac, F4:L4.frac, bFsk:rFsk.db>=10? rFsk.f : 0, bEnv:rEnv && rEnv.db>=10? rEnv.f : 0,
    ctcss:ct && ct.db>=14? ct.f : 0, pilot:!!(pil && pil.db>=12), wpm, fs, dur:L/fs, off:fx.off};
}

// ---- классификация по отсчётам ----
function sidIqClass(f,g){
  const bw=g.obw, cvLo=f.cv<(g.snr<15? .32 : .22);
  const baud=b=>b>=100? Math.round(b) : +b.toFixed(1);
  if(f.modes.length>=2 && ((cvLo && f.conc>.55 && f.mid<.16) || (f.cv<.4 && f.plat>.7))){
    const k=f.modes.length, sh=(f.modes[k-1]-f.modes[0])/(k-1), br=k>4? f.bPlat||f.bFsk : f.bRun||f.bFsk, b=br? baud(br) : 0;
    const name=k===2? '2-FSK' : k<=4? '4-FSK' : 'MFSK';
    return {t:k>4? 'MFSK' : 'FSK', conf:.7, levels:k, shift:k===2? sh : 0, spacing:sh, baud:b,
      tag:name+(k===2? ' '+fmtHz(sh,sh<1e3?0:1)+'Hz' : '')+(b? ' '+b+'Bd' : ''),
      det:k+' frequency levels, spacing '+fmtHz(sh,sh<1e3?0:1)+'Hz'+(b? ', ~'+b+' Bd' : '')};
  }
  if(f.F2>.08 && f.F2>2.5*f.F1 && f.F1<.3){ const b=f.bEnv? baud(f.bEnv) : 0;
    return {t:'PSK', conf:.7, tag:'BPSK'+(b? ' '+b+'Bd' : ''), det:'line in z² (±180° phase)'+(b? ', ~'+b+' Bd' : ''), psk:2, baud:b}; }
  if(f.F4>.05 && f.F4>2.5*f.F2 && f.F2<.05 && f.F1<.05){ const b=f.bEnv? baud(f.bEnv) : 0;
    return {t:'PSK', conf:.6, tag:'QPSK'+(b? ' '+b+'Bd' : ''), det:'line in z⁴ (4 phases)'+(b? ', ~'+b+' Bd' : ''), psk:4, baud:b}; }
  const wide=bw>Math.max(2.5*g.binHz,300), keyed=f.lowFrac>.12 && f.lowFrac<.9 && f.cv>.35;
  // ЧМ с заметной несущей (малая девиация) — раньше проверки несущей
  if(cvLo && wide && f.spread>.15*bw && !keyed){ const c=sidFm(f,g); if(c) return c; }
  if(f.F1>.25){
    if(keyed){
      const cw=bw<=Math.max(5*g.binHz,500);
      return {t:cw? 'CW' : 'OOK', conf:.7, tag:(cw? 'CW' : 'OOK')+(f.wpm? ' '+Math.round(f.wpm)+'wpm' : ''),
        det:'on/off keyed carrier'+(f.wpm? ', ~'+Math.round(f.wpm)+' WPM' : ''), wpm:f.wpm};
    }
    if(f.cv>.15 && wide) return {t:'AM', conf:.7, tag:'AM', det:'carrier + envelope modulation'};
    return {t:g.rf? 'CAR' : 'TONE', conf:.6, tag:g.rf? 'carrier' : 'tone', det:'unmodulated'};
  }
  if(cvLo && wide){ const c=sidFm(f,g); if(c) return c; }
  if(g.lead.flat>.7 && bw>=20e3) return {t:'OFDM', conf:.5, tag:'OFDM '+fmtHz(bw,1), det:'noise-like envelope, flat spectrum'};
  if(bw>=1.5e3 && bw<5e3){
    const sb=g.lead.asym<-.06? 'USB' : g.lead.asym>.06? 'LSB' : 'SSB';
    return {t:sb, conf:.55, tag:sb, det:'no carrier, varying envelope (kurtosis '+f.kurt.toFixed(1)+')'};
  }
  return null;
}

function sidFm(f,g){
  const bw=g.obw;
  if(bw>=60e3) return {t:'WFM', conf:.7, tag:f.pilot? 'WFM stereo' : 'WFM', det:'constant envelope'+(f.pilot? ', 19 kHz pilot' : ''), pilot:f.pilot};
  if(!g.rf && bw<3e3) return null;
  const ct=f.ctcss? SID_CTCSS.reduce((a,b)=>Math.abs(b-f.ctcss)<Math.abs(a-f.ctcss)? b : a) : 0;
  const okCt=ct && Math.abs(ct-f.ctcss)<2;
  return {t:'NFM', conf:.6, tag:'NFM'+(okCt? ' '+ct : ''), det:'constant envelope, deviation ±'+fmtHz(f.spread/2,1)+'Hz'+(okCt? ', CTCSS '+ct+' Hz' : ''), ctcss:okCt? ct : 0};
}
// подсказка: какой протокол и чем декодировать
function sidHint(c,g){
  const F=g.fc, sh=c.shift||0, b=c.baud||0, bw=g.obw, near=(x,y,tol)=>Math.abs(x-y)<=y*tol;
  switch(c.t){
    case 'CW': return 'Morse → morseRx / preset "Morse from Microphone"';
    case 'DTMF': return 'DTMF → dtmfRx';
    case 'FSK':
      if(bw<=80 && c.levels>2) return 'FT8/FT4/WSPR-like → ft8Rx';
      if(c.levels>2 || (!sh && c.levels)){
        if(near(b,4800,.08)) return 'DMR / P25 / NXDN96 (4-FSK 4800 Bd)';
        if(near(b,2400,.08)) return 'dPMR / NXDN48 (4-FSK 2400 Bd)';
        return '4-FSK data';
      }
      if(sh && near(sh,170,.15) && b<80) return 'RTTY 45/50 Bd → preset "RTTY: Receive Off-Air"';
      if(sh && near(sh,850,.12) && b<120) return 'RTTY/marine 850 Hz → preset "RTTY: Receive Off-Air"';
      if(sh && near(sh,1000,.15) && (near(b,1200,.1) || !b)) return 'AFSK 1200 (APRS/Packet) → ax25Rx';
      if(sh>=3e3 && sh<=1e4 && b>=400 && b<=2600) return 'POCSAG/FLEX pager (2-FSK)';
      if(near(b,9600,.1)) return 'GFSK 9600 (AIS / packet 9k6)';
      return '2-FSK → afskRx / fsk';
    case 'MFSK':
      if(bw<=80) return 'FT8/FT4/WSPR-like → ft8Rx';
      return 'Olivia/Contestia-like → oliviaRx / contestiaRx';
    case 'PSK':
      if(c.psk===2 && near(b,31.25,.1)) return 'PSK31 → preset "PSK31"';
      if(c.psk===2 && near(b,62.5,.1)) return 'PSK63';
      if(near(b,1800,.05)) return 'HFDL-like (1800 Bd PSK) → preset "HFDL: Receive and Aircraft Map"';
      return (c.psk===4? 'QPSK' : 'BPSK')+' → costas + gardner + pskdec';
    case 'AM':
      if(g.rf && F>=118e6 && F<=137e6) return 'airband AM voice → rtlsdr demod AM';
      if(g.rf && F<30e6 && bw>=6e3) return 'AM broadcast → rtlsdr demod AM';
      if(!g.rf && near(F,2400,.05)) return 'NOAA APT subcarrier → preset "NOAA APT (AM Envelope)"';
      return 'AM → rtlsdr demod AM / SAM';
    case 'NFM':
      if(g.rf && F>=137e6 && F<=138e6 && bw>=25e3) return 'NOAA APT → preset "NOAA APT (AM Envelope)"';
      return 'NFM voice → rtlsdr demod NFM'+(c.ctcss? ', CTCSS '+c.ctcss+' Hz' : '');
    case 'WFM': return 'FM broadcast → rtlsdr demod WFM'+(c.pilot? ' (stereo, RDS possible)' : '');
    case 'USB': case 'LSB': case 'SSB': return 'SSB voice → rtlsdr demod '+(c.t==='SSB'? 'USB/LSB' : c.t);
    case 'OFDM':
      if(near(bw,7.6e6,.08)) return 'DVB-T/T2';
      if(near(bw,1.54e6,.1)) return 'DAB';
      return 'OFDM → ofdmRx';
    case 'DIG':
      if(g.rf && near(bw,200e3,.2)) return 'GSM-like channel';
      if(g.rf && bw>=5e3 && bw<=30e3) return 'digital voice/data (DMR/TETRA/P25?)';
      return '';
    default: return '';
  }
}
// полоса band plan под сигналом (записи sig:true — свои же, пропускаем)
function sidPlanBand(plan,f){
  if(!Array.isArray(plan)) return null;
  let best=null, bw=Infinity;
  for(const b of plan){ if(!b || b.sig || typeof b.lo!=='number') continue;
    const hi=typeof b.hi==='number'? b.hi : b.lo, lo=Math.min(b.lo,hi), h=Math.max(b.lo,hi);
    if(f>=lo && f<=h && h-lo<bw){ bw=h-lo; best=b; } }
  return best;
}
// согласие с видом модуляции полосы — небольшая прибавка уверенности
const SID_PLAN_RX={AM:/\bAM\b|air/i, NFM:/\bFM\b|PMR|LPD|marine|rail/i, WFM:/FM broadcast|OIRT/i,
  USB:/SSB/i, LSB:/SSB/i, CW:/\bCW\b/i, FSK:/DIGI|APRS|AIS|RTTY/i, PSK:/DIGI/i, MFSK:/DIGI|FT8|FT4/i,
  OFDM:/DVB|DAB/i, DIG:/DIGI|DV|CELL|GSM/i};

function sidClassify(n,g,plan){
  let c=sidSpecClass(g), src='spectrum';
  if(g.lead.iq && !g.dtmf){ const q=sidIqClass(g.lead.iq,g); if(q){ c=q; src='IQ'; } }
  // для аудио «несущие» классы радио не к месту — речь, музыка
  if(!g.rf && ['USB','LSB','SSB','NFM','WFM'].includes(c.t)) c={t:'VOICE', conf:.3, tag:'voice?', det:'wideband audio'};
  const band=sidPlanBand(plan,g.fc);
  if(band && SID_PLAN_RX[c.t]?.test(band.label||'')) c.conf=Math.min(.95,c.conf+.15);
  return {...c, src, band:band?.label||'', hint:sidHint(c,g)};
}

def({ id:'sigid', title:'Signal Type Identifier', cat:'Analysis', readout:true, tall:true,
  // spec — спектр любого источника (у rtlsdr в нём ещё и сырой IQ для анализа отсчётов);
  // in — аудио: свой спектр, если spec не подключён, и отсчёты для анализа;
  // plan — band plan для контекста. bands — метки на 'sa' (напрямую или через bandplan.sigs).
  ins:[{n:'spec',t:'spec'},{n:'in',t:'sig'},{n:'plan',t:'bands'}],
  outs:[{n:'bands',t:'bands'},{n:'type',t:'txt'},{n:'f',t:'num'},{n:'conf',t:'num'},{n:'count',t:'num'}],
  params:[{n:'fftSize',t:'select',opts:['2048','4096','8192','16384'],d:'8192',label:'FFT size (audio input)'},
          {n:'period',t:'range',min:.5,max:5,step:.5,d:2,label:'analysis period, s'},
          {n:'thr',t:'range',min:3,max:30,step:.5,d:8,label:'detection threshold, dB'},
          {n:'maxSig',t:'range',min:1,max:20,step:1,d:8,label:'signals to label'},
          {n:'iq',t:'check',d:true,label:'sample analysis (IQ / audio)'}],
  init:n=>{ n.tracks=[]; n.tid=0; n.wid=0; n.wPend=null; n.noPair=new Set(); n.sigs=[]; n.labels=[]; n.text='waiting for spectrum…'; n.fx=null; n.aring=null; n.os=null; },
  process(n,I){
    n.inOn=!!I.in;
    if(I.in) sidAudioPush(n,I.in);
    const s=I.spec || (I.in? sidOwnSpec(n) : null);
    const now=performance.now();
    if(!s){ n.text=I.in? 'accumulating…' : 'connect spec or in'; return {bands:n.labels, count:0}; }
    const fresh=s.rev!=null? s.rev!==n._rev || s!==n._sref : s!==n._sref;
    const sa=fresh? (n._rev=s.rev, n._sref=s, sidAccum(n,s,now)) : null;
    if(sa){
      n.rf=!!s.freqs;
      sidTrack(n,sidSegments(n,sa),sa,now);
      n.sigs=sidSignals(n,s).sort((a,b)=>b.snr-a.snr).slice(0,n.p.maxSig);
      for(const g of n.sigs) g.cls=sidClassify(n,g,I.plan);
      // скобка — по полосе 99% мощности: края сегмента у сильного сигнала захватывают брызги
      n.labels=n.sigs.map(g=>({lo:Math.max(g.lo,g.fc-g.obw/2), hi:Math.min(g.hi,g.fc+g.obw/2), label:g.cls.tag, color:SID_T[g.cls.t]?.c||'#b0bec5',
        sig:true, db:g.db, conf:g.cls.conf, type:g.cls.t, f:g.fc}));
      const src=n.p.iq? sidSource(n,s) : null;
      n.text=n.sigs.length+' signal'+(n.sigs.length===1?'':'s')+' · floor '+(n.floorDb??0).toFixed(0)+' dB · samples: '+
        (src? (s.iq? 'IQ '+fmtHz(src.sr,2)+'S/s' : 'audio') : 'none')+'\n'+
        n.sigs.map((g,i)=>{ const c=g.cls;
          return (i+1)+'. '+fmtHz(g.fc,g.rf?4:2).padStart(9)+'Hz  '+c.tag+'  ('+Math.round(c.conf*100)+'%, '+c.src+')\n'+
            '   bw '+fmtHz(g.obw,1)+'Hz · SNR '+g.snr.toFixed(0)+' dB'+(c.det? ' · '+c.det : '')+(c.band? ' · in '+c.band : '')+
            (c.hint? '\n   → '+c.hint : ''); }).join('\n');
    }
    if(n.p.iq) sidFocusStep(n,sidSource(n,s),n.sigs,now);
    else n.fx=null;
    const top=n.sigs[0];
    return {bands:n.labels, type:top? top.cls.tag : '', f:top? top.fc : null, conf:top? top.cls.conf : 0, count:n.sigs.length};
  },
  dispose:n=>{ if(n.worker){ n.worker.terminate(); n.worker=null; } },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text; }});
