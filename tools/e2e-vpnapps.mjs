// Выбор приложений для VPN-монитора в браузере: List apps → Table → фильтр → «rows» монитора → vpn.start {mode, apps}; смена фильтра пересоздаёт туннель.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-vpnapps.mjs
import { createRequire } from 'node:module';
import { mockBridgeWs } from './netmock-ws.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = [
  { src: 'app', uid: 10234, pkg: 'com.a.one', pkgs: ['com.a.one', 'com.a.two'], label: 'One', system: false },
  { src: 'app', uid: 10300, pkg: 'org.telegram.messenger', pkgs: ['org.telegram.messenger'], label: 'Telegram', system: false },
  { src: 'app', uid: 10400, pkg: 'com.android.chrome', pkgs: ['com.android.chrome'], label: 'Chrome', system: false },
];
const got = [];
const br = await mockBridgeWs(0, { app: true, extra: (j, reply) => {
  got.push(j);
  if (j.cmd === 'vpn.apps') { reply(j.id, j.cmd, null, { apps: APPS }); return true; }
  if (j.cmd === 'vpn.start') { reply(j.id, j.cmd, null, {}); return true; }
  return false;
} });

const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate((p) => {
  clearAll();
  const vm = addNode('vpnmon', 40, 40, { url: 'ws://127.0.0.1:' + p, mode: 'only these' });
  const t = addNode('table', 500, 40, { list: '@patch', key: 'uid', initial: false, cols: ['label', 'uid', 'pkg', 'system'] });
  addEdge(vm.id, 'installed', t.id, 'rec'); addEdge(t.id, 'rows', vm.id, 'rows'); markWiresDirty(); window.__vm = vm; window.__t = t;
}, br.port);
await pg.click('#run'); await wait(1000);
await pg.evaluate(() => vpnConnect(__vm)); await wait(800);
await pg.evaluate(() => vpnListApps(__vm)); await wait(1500);
ok('apps reply reached the node', got.some((g) => g.cmd === 'vpn.apps' && g.system === false), JSON.stringify(got.map((g) => g.cmd)));
const nrows = await pg.evaluate(() => (__vm.selRows || []).length);
ok('Table got the installed apps and gives them to «rows»', nrows === 3, String(nrows));

// без выбора режим «only these» не стартует: понятный статус
await pg.evaluate(() => { __t.p.filter = 'zzz-nothing'; tblDerive(__t); });
await wait(600);
await pg.evaluate(() => vpnStart(__vm)); await wait(600);
const st0 = await pg.evaluate(() => __vm.status);
ok('empty choice: tells to pick apps, no start sent', /pick the apps/.test(st0) && !got.some((g) => g.cmd === 'vpn.start'), st0);

// выбор из текста
await pg.evaluate(() => { __vm.p.apps = 'org.telegram.messenger 10400'; vpnStart(__vm); }); await wait(800);
const s1 = got.filter((g) => g.cmd === 'vpn.start').pop();
ok('start carries mode and packages/uids from the text', s1 && s1.mode === 'only' && s1.apps?.includes('org.telegram.messenger') && s1.uids?.includes(10400), JSON.stringify(s1));

// выбор из таблицы по фильтру → смена выбора при работающем мониторе пересоздаёт туннель (новый vpn.start)
await pg.evaluate(() => { __vm.p.apps = ''; __vm.on = true; __t.p.filter = 'telegram'; tblDerive(__t); });
await wait(3500);
const starts = got.filter((g) => g.cmd === 'vpn.start');
const last = starts[starts.length - 1];
ok('changing the choice re-sends vpn.start with the filtered app', last && JSON.stringify(last.apps) === '["org.telegram.messenger"]' && !last.uids, JSON.stringify(starts.map((x) => [x.mode, x.apps, x.uids])));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); br.close();
if (bad) { console.log(bad + ' failed'); process.exit(1); }
console.log('e2e vpnapps: all ok');
