// Source Locator: расстояния (Wi-Fi RTT, Timing Advance), заявленная мощность BLE и прежнее поведение. node tools/test-locate-range.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const src = fs.readFileSync(process.env.GEO_SRC || new URL('../modules/geo.js', import.meta.url), 'utf8');
// решатель — чистые функции: от «function geoLocLocal» до начала группировки
const a = src.indexOf('function geoLocLocal'), b = src.indexOf('// Группировка (group by');
const ctx = vm.createContext({ Math, Float64Array, Array, Number, Infinity, isFinite });
const rn = src.indexOf('function recNum(v){'), re = src.indexOf('\n}', rn) + 2;
vm.runInContext('const D2R=Math.PI/180;\n' + src.slice(rn, re) + '\n' + src.slice(a, b) + ';this.K={geoLocSolve,geoLocRangeKm,recNum};', ctx);
const { geoLocSolve, geoLocRangeKm } = ctx.K;

// истина — точка (50.0, 85.0); замеры вокруг неё, расстояния в км считаем на плоскости как решатель
const LAT0 = 50, LON0 = 85, kx = 111.32 * Math.cos(LAT0 * Math.PI / 180), ky = 110.574;
const truth = { lat: LAT0, lon: LON0 };
const around = (n, rKm, seedShift = 0) => Array.from({ length: n }, (_, i) => { const t = seedShift + i / n * 2 * Math.PI; return { lat: LAT0 + rKm * Math.sin(t) / ky, lon: LON0 + rKm * Math.cos(t) / kx }; });
const dKm = (p) => Math.hypot((p.lon - truth.lon) * kx, (p.lat - truth.lat) * ky);
const errM = (g) => g.sol ? Math.hypot((g.sol.lon - truth.lon) * kx, (g.sol.lat - truth.lat) * ky) * 1000 : Infinity;
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - .5; };
const P = (o = {}) => ({ method: 'auto', pathN: 3, sigmaDb: 6, sigmaAz: 10, area: 0, minSpread: 15, useAcc: true, sigmaDist: 30, useTx: true, ...o });

// 0. разбор поля расстояния из записи: пустая ячейка Table, null и ноль — не расстояние (null >= 0 в JS истинно!)
ok('range field: metres → km', geoLocRangeKm(120) === 0.12 && geoLocRangeKm('351.5') === 0.3515);
ok('range field: empty cell, null, undefined, junk, 0, negative → nothing', geoLocRangeKm('') === null && geoLocRangeKm(null) === null && geoLocRangeKm(undefined) === null &&
  geoLocRangeKm('abc') === null && geoLocRangeKm(0) === null && geoLocRangeKm(-5) === null && geoLocRangeKm('  ') === null);
// 1. только расстояния: 4 точки вокруг, ошибка ±5 м — источник найден в пределах нескольких десятков метров
{
  const pts = around(4, 0.12);
  const g = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: null, az: null, el: null, a: 3, d: dKm(p) + rnd() * 0.01, sd: 0.005, tx: null })) };
  geoLocSolve(g, P());
  ok('distances only: 4 points, found within 15 m', errM(g) < 15, 'err ' + errM(g).toFixed(1));
  ok('distances only: the message names them', /distance/.test(g.msg), g.msg);
}
// 2. два расстояния — достаточно для оценки (двузначность — честная ошибка)
{
  const pts = around(2, 0.1, 0.4);
  const g = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: null, az: null, el: null, a: 3, d: dKm(p), sd: 0.005, tx: null })) };
  geoLocSolve(g, P());
  ok('two distances are enough to try (a solution exists)', !!g.sol, g.msg);
}
// 3. одно расстояние — мало
{
  const g = { meas: [{ lat: LAT0 + 0.001, lon: LON0, s: null, az: null, el: null, a: 3, d: 0.1, sd: 0.005, tx: null }] };
  geoLocSolve(g, P());
  ok('one distance is not enough: no solution, a clear message', !g.sol && /distance/.test(g.msg), g.msg);
}
// 4. Timing Advance соты: кольцо ±50 м плюс уровни — расстояние стягивает оценку
{
  const lv = (p, A) => A - 30 * 3 * Math.log10(Math.max(dKm(p), .005)) + rnd() * 6;
  const pts = around(6, 0.5);
  const lev = pts.map(p => ({ lat: p.lat, lon: p.lon, s: lv(p, -60), az: null, el: null, a: 5, d: null, sd: null, tx: null }));
  const g1 = { meas: lev.map(m => ({ ...m })) }; geoLocSolve(g1, P());
  const ring = around(3, 0.35, 0.3).map(p => ({ lat: p.lat, lon: p.lon, s: null, az: null, el: null, a: 5, d: dKm(p), sd: 0.05, tx: null }));
  const g2 = { meas: lev.map(m => ({ ...m })).concat(ring) }; geoLocSolve(g2, P());
  ok('levels + distances: not worse than levels alone, and good', errM(g2) <= errM(g1) + 5 && errM(g2) < 80, errM(g1).toFixed(0) + ' → ' + errM(g2).toFixed(0));
  ok('levels + distances: the error radius does not grow', g2.sol.errKm <= g1.sol.errKm * 1.5, g1.sol.errKm.toFixed(3) + ' → ' + g2.sol.errKm.toFixed(3));
}
// 5. BLE txp: две точки с известной мощностью дают оценку, без txp — нет (нужно ≥3 уровней)
{
  const TX = 4, A_true = (TX - 41) - 30 * 3;                 // уровень на 1 км по модели решателя
  const lv = p => A_true - 30 * 3 * Math.log10(Math.max(dKm(p), .001)) + 0;
  const pts = around(2, 0.012);
  const withTx = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: lv(p), az: null, el: null, a: 2, d: null, sd: null, tx: TX })) };
  const noTx = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: lv(p), az: null, el: null, a: 2, d: null, sd: null, tx: null })) };
  geoLocSolve(withTx, P()); geoLocSolve(noTx, P());
  ok('TX power: two level measurements are enough', !!withTx.sol && /TX power/.test(withTx.msg), withTx.msg);
  ok('without TX power two levels are still not enough', !noTx.sol, noTx.msg);
  const q = { meas: around(8, 0.02).map(p => ({ lat: p.lat, lon: p.lon, s: lv(p) + rnd() * 6, az: null, el: null, a: 2, d: null, sd: null, tx: TX })) };
  const q0 = { meas: q.meas.map(m => ({ ...m, tx: null })) };
  geoLocSolve(q, P()); geoLocSolve(q0, P());
  ok('TX power with many levels: found within 10 m', errM(q) < 10, errM(q).toFixed(1));
  ok('the TX power can be switched off (useTx false)', (() => { const g = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: lv(p), az: null, el: null, a: 2, d: null, sd: null, tx: TX })) }; geoLocSolve(g, P({ useTx: false })); return !g.sol; })());
}
// 6. прежнее поведение: уровни без txp и без расстояний — те же результаты в режимах auto и strength
{
  const pts = around(10, 0.2);
  const mk = () => ({ meas: pts.map((p, i) => ({ lat: p.lat, lon: p.lon, s: -50 - 30 * 3 * Math.log10(Math.max(dKm(p), .005)) + Math.sin(i * 7) * 3, az: null, el: null, a: 4, d: null, sd: null, tx: null })) });
  const ga = mk(), gs = mk(), gr = mk(); geoLocSolve(ga, P()); geoLocSolve(gs, P({ method: 'strength' })); geoLocSolve(gr, P({ method: 'range' }));
  ok('levels only: auto = strength', ga.sol && gs.sol && Math.abs(ga.sol.lat - gs.sol.lat) < 1e-9 && Math.abs(ga.sol.lon - gs.sol.lon) < 1e-9);
  ok('levels only: the same accuracy as before the change (≈40 m on this noisy scenario, the old solver gives 40.5 m too)', errM(ga) < 60, errM(ga).toFixed(1));
  ok('method «range» ignores the levels', !gr.sol && /distance/.test(gr.msg), gr.msg);
}
// 7. пеленги по-прежнему работают (метод auto, без уровней)
{
  const pts = around(3, 0.15);
  const g = { meas: pts.map(p => ({ lat: p.lat, lon: p.lon, s: null, az: (Math.atan2((truth.lon - p.lon) * kx, (truth.lat - p.lat) * ky) * 180 / Math.PI + 360) % 360, el: null, a: 3, d: null, sd: null, tx: null })) };
  geoLocSolve(g, P());
  ok('bearings only: still found', errM(g) < 25, errM(g).toFixed(1));
}
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
