"use strict";
/* ============== Спектр без пропусков: накопление пика и среднего за кадр вывода (ядро) ==============
   Раньше кадр спектра брал только последние N отсчётов, остальное выбрасывалось: при 2,4 МГц, N=4096 и 25 к/с БПФ видело
   ~4 % времени, и короткий всплеск почти всегда проскакивал между кадрами. Теперь воркер считает БПФ по каждому шагу N/2
   по всем новым отсчётам, а за кадр вывода копятся пик по бину (max) и средняя мощность (avg) — частота кадров только
   частота выдачи. Чистая логика без DOM. Проверка: node tools/test-specacc.mjs */

// Сколько отсчётов отдать воркеру: fresh — новые с прошлой выборки, avail — сколько есть в кольце, N — размер БПФ,
// kmax — потолок числа БПФ за проход (защита от перегруза: берём самые свежие). Окно захватывает ещё N/2 старых отсчётов:
// первый кадр прохода перекрывает последний кадр прошлого — стыков без данных нет.
// → {L, K, lost}: L — длина окна, K — число БПФ, lost — отсчётов, не вошедших из-за потолка.
function specAccPlan(fresh,avail,N,kmax){
  const hop=N>>1;
  if(!(avail>=N)) return {L:0,K:0,lost:0};
  let L=Math.max(N, Math.min(avail, fresh+hop));
  let K=Math.floor((L-N)/hop)+1, lost=0;
  const km=Math.max(1,kmax|0);
  if(K>km){ K=km; const L2=N+(K-1)*hop; lost=Math.max(0,fresh-(L2-hop)); L=L2; }
  return {L,K,lost};
}

// Накопитель кадра: пик по бину (амплитуда) и сумма мощности с весом K (число БПФ). acc — {N,mx,pw,K,t0}
function specAccNew(N){ return {N, mx:new Float32Array(N), pw:new Float64Array(N), K:0, t0:0}; }
function specAccAdd(acc,mag,mx,K){
  const N=acc.N, a=acc.mx, p=acc.pw;
  for(let i=0;i<N;i++){ const m=mag[i]; p[i]+=m*m*K; if(mx[i]>a[i]) a[i]=mx[i]; }
  acc.K+=K;
}
// Снять кадр: {avg,max,K} (амплитуды) и сбросить накопитель. Пусто → null.
function specAccTake(acc){
  if(!(acc.K>0)) return null;
  const N=acc.N, avg=new Float32Array(N), max=new Float32Array(N), k=1/acc.K, K=acc.K;
  for(let i=0;i<N;i++){ avg[i]=Math.sqrt(acc.pw[i]*k); max[i]=acc.mx[i]; }
  acc.mx.fill(0); acc.pw.fill(0); acc.K=0;
  return {avg,max,K};
}
// Потолок БПФ за проход по стоимости: fftMs — время одного БПФ, gapMs — период проходов, load — доля ядра (по умолчанию 0,35)
const specAccKmax=(fftMs,gapMs,load)=>!(fftMs>0) ? 256 : Math.max(1,Math.min(4096,Math.floor((load||.35)*gapMs/fftMs)));
