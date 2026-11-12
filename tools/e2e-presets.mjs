// Сборка всех встроенных пресетов в браузере: неизвестные модули, потерянные провода (нет узла/пина, несовместимые типы), ошибки.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-presets.mjs [подстрока имени]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const only = process.argv[2] || '';
const b = await chromium.launch(); const pg = await b.newPage();
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {});
await pg.waitForFunction(() => typeof PRESETS === 'object' && typeof addNode === 'function', null, { timeout: 90000 });
await pg.waitForTimeout(1500);
const res = await pg.evaluate(async (only) => {
  const out = [], names = Object.keys(PRESETS).filter(n => n.includes(only));
  const oAN = addNode, oAE = addEdge, oErr = console.error, oWarn = console.warn; let cur;
  const bad = m => cur.push(m);
  addNode = (t, ...a) => { const n = oAN(t, ...a); if (!n) bad('нет модуля «' + t + '»'); return n; };
  addEdge = (f, fp, t, tp) => {
    const A = Graph.map[f], B = Graph.map[t];
    if (!A || !B) bad('провод к несозданному узлу ' + (A ? '' : f) + ' → ' + (B ? '' : t));
    else if (f === t) bad('провод узла на себя ' + A.type + '.' + fp);
    else {
      const po = portsOf(A, 'outs').find(o => o.n === fp), pi = portsOf(B, 'ins').find(o => o.n === tp);
      if (!po) bad('нет выхода ' + A.type + '.' + fp);
      else if (!pi) bad('нет входа ' + B.type + '.' + tp);
      else if (po.t !== pi.t && po.t !== 'val' && pi.t !== 'val') bad('типы ' + A.type + '.' + fp + '(' + po.t + ') → ' + B.type + '.' + tp + '(' + pi.t + ')');
    }
    return oAE(f, fp, t, tp);
  };
  console.error = (...a) => { bad('console.error: ' + a.join(' ').slice(0, 160)); };
  console.warn = () => {};
  for (const name of names) {
    cur = [];
    const was = Undo.busy; Undo.busy = true;
    try { clearAll(); PRESETS[name](); autoLayout(); serialize(); } catch (e) { bad('исключение: ' + (e && e.message)); }
    finally { Undo.busy = was; }
    if (cur.length) out.push([name, [...new Set(cur)]]);
  }
  addNode = oAN; addEdge = oAE; console.error = oErr; console.warn = oWarn; clearAll();
  return { total: names.length, out };
}, only);
await b.close();
for (const [n, m] of res.out) console.log('FAIL', n, '\n   ' + m.join('\n   '));
console.log(res.out.length ? res.out.length + ' из ' + res.total + ' пресетов с проблемами' : 'ok: ' + res.total + ' пресетов');
process.exit(res.out.length ? 1 : 0);
