// VPN-монитор: разбор записей, строки, агрегация по приложению (modules/vpnmon-kernels.js): node tools/test-vpnmon.mjs
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../modules/vpnmon-kernels.js', import.meta.url), 'utf8') + ';this.K={vpnCmd,vpnLine,vpnFlowRow,vpnAppAgg,vpnAppRow,vpnFmtBytes};', ctx);
const K = ctx.K;
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };

ok('vpnCmd start/stop/packets', JSON.stringify(K.vpnCmd('start', { packets: true })) === '{"cmd":"vpn.start","packets":true}'
  && JSON.stringify(K.vpnCmd('stop', {})) === '{"cmd":"vpn.stop"}' && JSON.stringify(K.vpnCmd('packets', { packets: false })) === '{"cmd":"vpn.packets","on":false}'
  && K.vpnCmd('nope', {}) === null);

ok('vpnFmtBytes', K.vpnFmtBytes(500) === '500 B' && K.vpnFmtBytes(2048) === '2.0 KB' && K.vpnFmtBytes(5 * 1048576) === '5.0 MB' && K.vpnFmtBytes(2 * 1073741824) === '2.00 GB');

const open = { ev: 'open', id: 1, proto: 'tcp', dst: '93.184.216.34', dport: 443, host: 'example.com', l7: 'tls', state: 'established', app: 'Chrome', uid: 10234, pkgs: ['com.android.chrome'], up: 0, down: 0, dur: 0, t: 1000 };
ok('vpnLine: open', K.vpnLine(open) === 'Chrome → example.com:443 (tcp) tls', K.vpnLine(open));
ok('vpnLine: open without a host falls back to the address', K.vpnLine({ ...open, host: null }) === 'Chrome → 93.184.216.34:443 (tcp) tls');
ok('vpnLine: open without an app label falls back to uid', K.vpnLine({ ...open, app: null }) === 'uid 10234 → example.com:443 (tcp) tls');
const close = { ...open, ev: 'close', up: 1200, down: 54000 };
ok('vpnLine: close', K.vpnLine(close) === 'Chrome ✕ example.com — 1.2 KB up, 52.7 KB down', K.vpnLine(close));
ok('vpnLine: state / dns / summary / pkt', K.vpnLine({ ev: 'state', on: true }) === 'VPN monitor is on'
  && K.vpnLine({ ev: 'state', on: false, msg: 'turned off' }) === 'VPN monitor is off (turned off)'
  && K.vpnLine({ ev: 'dns', name: 'example.com', ips: ['93.184.216.34', '93.184.216.35'] }) === 'dns example.com → 93.184.216.34, 93.184.216.35'
  && K.vpnLine({ ev: 'summary', open: 3, flows: 40, bytesUp: 1000, bytesDown: 2000000 }) === '3 open · 40 total · 1000 B up, 1.9 MB down'
  && K.vpnLine({ ev: 'pkt', dir: 'out', n: 64 }) === '→ 64 B' && K.vpnLine({ ev: 'pkt', dir: 'in', n: 1400 }) === '← 1400 B');

ok('vpnFlowRow: shapes open/stat/close, skips other kinds', K.vpnFlowRow(open).app === 'Chrome' && K.vpnFlowRow(open).host === 'example.com'
  && K.vpnFlowRow(close).state === 'closed' && K.vpnFlowRow({ ...open, ev: 'stat' }).state === 'established' && K.vpnFlowRow({ ev: 'dns' }) === null);

// агрегация по приложению: два потока одного приложения, счётчики растут по разнице, не суммой абсолютных значений
const st = new Map();
K.vpnAppAgg(st, { ev: 'open', id: 1, app: 'Chrome', uid: 10234, host: 'a.com', up: 0, down: 0, t: 1 });
K.vpnAppAgg(st, { ev: 'open', id: 2, app: 'Chrome', uid: 10234, host: 'b.com', up: 0, down: 0, t: 2 });
K.vpnAppAgg(st, { ev: 'stat', id: 1, app: 'Chrome', uid: 10234, host: 'a.com', up: 500, down: 2000, t: 3 });
let row = K.vpnAppRow(st.get('Chrome'));
ok('aggregate: two open flows, bytes counted once', row.flows === 2 && row.open === 2 && row.up === 500 && row.down === 2000 && row.hosts === 'a.com, b.com', JSON.stringify(row));
K.vpnAppAgg(st, { ev: 'stat', id: 1, app: 'Chrome', uid: 10234, host: 'a.com', up: 800, down: 2000, t: 4 });
row = K.vpnAppRow(st.get('Chrome'));
ok('aggregate: a later stat adds only the difference', row.up === 800, JSON.stringify(row));
K.vpnAppAgg(st, { ev: 'close', id: 1, app: 'Chrome', uid: 10234, host: 'a.com', up: 900, down: 2500, t: 5 });
row = K.vpnAppRow(st.get('Chrome'));
ok('aggregate: close adds the final difference and drops the open count', row.open === 1 && row.up === 900 && row.down === 2500, JSON.stringify(row));
K.vpnAppAgg(st, { ev: 'open', id: 3, app: 'Camera', uid: 10050, host: '', up: 0, down: 0, t: 6 });
ok('aggregate: a different app is a separate row', st.size === 2 && st.get('Camera').flows === 1);
ok('aggregate: skips non-flow events', (() => { const n = st.size; K.vpnAppAgg(st, { ev: 'dns', name: 'x' }); return st.size === n; })());
ok('aggregate: unlabeled uid groups by uid, not merged with named apps', (() => {
  const s2 = new Map();
  K.vpnAppAgg(s2, { ev: 'open', id: 9, uid: 10099, up: 0, down: 0, t: 1 });
  return s2.get('uid 10099').flows === 1;
})());

console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
