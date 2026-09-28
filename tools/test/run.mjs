// Смоук-тесты: headless Chromium, пресеты и узлы гоняются без звуковой карты
// (тот же цикл, что Eng.tick, но без AudioContext). Запуск: npm test
import {chromium} from 'playwright';
import {serve} from './serve.mjs';
import {fileURLToPath} from 'node:url';
import {readdir} from 'node:fs/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const only = process.argv[2];

const {srv, url} = await serve(root);
const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
// сервис-воркер перезагружает страницу ради COOP/COEP — в тестах не нужен
const page = await (await browser.newContext({serviceWorkers:'block'})).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => typeof PRESETS === 'object' && typeof Graph === 'object');

// помощники в странице
await page.evaluate(() => {
  // по умолчанию всё синхронно в главном потоке; тесты воркеров включают острова сами
  Islands.enabled = false;
  window.T = {
    // sec секунд сигнала; возвращает пик на выходе звуковой карты (L+R) за весь прогон
    run(sec){
      const n = Math.ceil(sec*Eng.sr/BLOCK);
      let pk = 0;
      for(let b=0; b<n; b++){
        for(const o of Eng.outs) o.fill(0);
        for(const nd of Graph.order) evalNode(nd);
        Eng.blocks++;
        for(let i=0; i<BLOCK; i++) pk = Math.max(pk, Math.abs(Eng.outL[i]), Math.abs(Eng.outR[i]));
      }
      return pk;
    },
    // как run, но копит выход sig-порта узла; skip — сек на прогрев (не копятся)
    capture(n, port, sec, skip=0){
      if(skip) T.run(skip);
      const cnt = Math.ceil(sec*Eng.sr/BLOCK), a = new Float32Array(cnt*BLOCK);
      for(let b=0; b<cnt; b++){
        for(const o of Eng.outs) o.fill(0);
        for(const nd of Graph.order) evalNode(nd);
        Eng.blocks++;
        const v = n.out[port]; if(v) a.set(v, b*BLOCK);
      }
      return a;
    },
    // частота по переходам через ноль (с интерполяцией), Гц
    toneHz(a, sr){
      let first = -1, last = -1, k = 0;
      for(let i=1; i<a.length; i++) if(a[i-1] < 0 && a[i] >= 0){
        const t = i-1 + a[i-1]/(a[i-1]-a[i]);
        if(first < 0) first = t; last = t; k++;
      }
      return k > 1 ? (k-1)*sr/(last-first) : 0;
    },
    peak(a){ let p = 0; for(const v of a) p = Math.max(p, Math.abs(v)); return p; },
    rms(a){ let s = 0; for(const v of a) s += v*v; return Math.sqrt(s/a.length); },
    // узлы: [[тип, {параметры}], ...] → массив узлов; провода: 'i.port>j.port'
    build(nodes, wires){
      clearAll();
      const ns = nodes.map(([t, p], i) => addNode(t, 40+i*260, 40, p||{}));
      for(const w of wires){
        const [a, b] = w.split('>'), [i, fp] = a.split('.'), [j, tp] = b.split('.');
        addEdge(ns[+i].id, fp, ns[+j].id, tp);
      }
      retopo();
      return ns;
    },
    // граф в реальном времени (ответы воркеров приходят между тактами); каждый блок — в onBlock
    async realtime(sec, onBlock){
      const t0 = performance.now(); let done = 0;
      while(performance.now()-t0 < sec*1000){
        await new Promise(r => setTimeout(r, 5));
        const need = Math.floor((performance.now()-t0)/1000*Eng.sr/BLOCK);
        for(; done<need; done++){
          for(const o of Eng.outs) o.fill(0);
          for(const nd of Graph.order) evalNode(nd);
          onBlock?.((performance.now()-t0)/1000);
        }
      }
    },
    preset(name){ PRESETS[name](); retopo(); },
    byType(t){ return Graph.nodes.filter(n => n.type===t); },
    errors(){ return Graph.nodes.filter(n => n.err).map(n => n.type+': '+(n.err.message||n.err)); },
  };
});

const files = (await readdir(new URL('./cases/', import.meta.url))).filter(f => f.endsWith('.mjs')).sort();
let fail = 0, total = 0;
for(const f of files){
  const mod = await import('./cases/'+f), cases = mod.default;
  if(mod.setup) await page.evaluate(mod.setup);     // общие помощники файла — в страницу
  for(const c of cases){
    if(only && !c.name.includes(only)) continue;
    total++;
    pageErrors.length = 0;
    const t0 = Date.now();
    let err = null;
    try{
      const res = await page.evaluate(c.fn, c.arg ?? null);
      if(res !== true) err = String(res);
      else if(pageErrors.length) err = 'pageerror: '+pageErrors.join('; ');
    }catch(e){ err = e.message.split('\n')[0]; }
    const ms = Date.now()-t0;
    if(err){ fail++; console.log(`FAIL ${c.name} (${ms} ms)\n     ${err}`); }
    else console.log(`ok   ${c.name} (${ms} ms)`);
  }
}
// Страница под сервис-воркером (COOP/COEP, как на сайте): воркеры островов должны подняться
if(!only || 'isolated page: island workers start'.includes(only)){
  total++;
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.waitForFunction(() => window.crossOriginIsolated === true && document.readyState === 'complete' && typeof Graph === 'object', null, {timeout:15000}).catch(() => {});
  const res = await p2.evaluate(async () => {
    if(!crossOriginIsolated) return 'page is not cross-origin isolated';
    Islands.setEnabled(true);
    PRESETS['IQ: Receiver from Blocks (Generator)'](); retopo();
    await new Promise(r => setTimeout(r, 1500));
    for(let i=0; i<50; i++) for(const nd of Graph.order) evalNode(nd);
    await new Promise(r => setTimeout(r, 500));
    for(const nd of Graph.order) evalNode(nd);      // ответы воркера забираются на такте
    const d = Graph.nodes.find(n => n.type==='iqDecim');
    return Islands.enabled && d._isl && d.ui?.srOut === 64000 || 'islands '+Islands.enabled+', ui '+JSON.stringify(d.ui);
  }).catch(e => e.message.split('\n')[0]);
  if(res === true) console.log('ok   isolated page: island workers start');
  else { fail++; console.log('FAIL isolated page: island workers start\n     '+res); }
  await ctx.close();
}
console.log(`\n${total-fail}/${total} passed`);
await browser.close(); srv.close();
process.exit(fail ? 1 : 0);
