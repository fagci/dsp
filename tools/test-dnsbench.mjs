// Замер DNS-серверов (modules/dnsbench-kernels.js) на поддельных серверах: node tools/test-dnsbench.mjs
import dgram from 'node:dgram';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'dnsq-kernels.js', 'dnsbench-kernels.js'], 'NetSock,dnsBench,dnsbServers,dnsbPct,dnsbDev,dnsbAvg');

ok('percentile / average / deviation', K.dnsbPct([1, 2, 3, 4, 5], .5) === 3 && K.dnsbPct([10, 20], .95) === 19.5 && K.dnsbPct([], .5) === null && K.dnsbAvg([2, 4]) === 3 && Math.abs(K.dnsbDev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < .001);
const sv = K.dnsbServers([{ Server: '1.1.1.1', Name: 'Cloudflare' }, { ip: '8.8.8.8' }, { server: 'bad name' }, { address: '1.1.1.1' }], 'Quad9 = 9.9.9.9\n208.67.222.222, 94.140.14.14:5353\n42\nlocal=127.0.0.1:5300');
ok('servers from rows and text', sv.length === 6 && sv[0].name === 'Cloudflare' && sv[1].name === '8.8.8.8' && sv[2].name === 'Quad9' && sv[4].port === 5353 && sv[5].port === 5300 && sv[5].name === 'local', JSON.stringify(sv));

// поддельный DNS: delay — задержка, mode: ok | drop | hijack
const fake = (delay, mode) => new Promise((res) => {
  const s = dgram.createSocket('udp4');
  s.on('message', (q, i) => {
    if (mode === 'drop') return;
    let p = 12; const labels = []; while (q[p]) { labels.push(q.subarray(p + 1, p + 1 + q[p]).toString()); p += q[p] + 1; } const qend = p + 5;
    const fresh = labels[0].startsWith('dsp-') && mode !== 'hijack';
    const head = Buffer.from(q.subarray(0, 12)); head[2] = 0x81; head[3] = 0x80 | (fresh ? 3 : 0); head[6] = 0; head[7] = fresh ? 0 : 1;
    const parts = [head, q.subarray(12, qend)]; if (!fresh) parts.push(Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4]));
    setTimeout(() => s.send(Buffer.concat(parts), i.port, i.address), delay);
  });
  s.bind(0, '127.0.0.1', () => res({ s, port: s.address().port }));
});
const A = await fake(5, 'ok'), B = await fake(40, 'ok'), C = await fake(0, 'drop'), D = await fake(12, 'hijack');
const ns = mockSock(K);
const list = [['Slow', B], ['Fast', A], ['Dead', C], ['Liar', D]].map(([name, f]) => ({ name, ip: '127.0.0.1', port: f.port }));
const recs = []; const prog = [];
const r = await K.dnsBench(ns, list, { names: ['a.test', 'b.test'], rounds: 3, timeout: 250, onRec: (x) => recs.push(x), onProgress: (d, t) => prog.push([d, t]) });
const by = Object.fromEntries(recs.filter((x) => x.state === 'done').map((x) => [x.name, x]));
ok('every server has a record', Object.keys(by).length === 4);
ok('fast server: ~5 ms, no loss, NXDOMAIN right', by.Fast.cached_avg > 3 && by.Fast.cached_avg < 25 && by.Fast.loss === 0 && by.Fast.nxdomain === 'ok' && by.Fast.ok === 12, JSON.stringify(by.Fast));
ok('slow server: ~40 ms and slower than the fast one', by.Slow.cached_avg > 35 && by.Slow.score > by.Fast.score * 2, JSON.stringify(by.Slow));
ok('dead server: all lost, no score', by.Dead.loss === 100 && by.Dead.ok === 0 && by.Dead.score === null && by.Dead.cached_avg === null, JSON.stringify(by.Dead));
ok('NXDOMAIN replaced by an address is noticed', by.Liar.nxdomain === 'replaced', JSON.stringify(by.Liar));
const ranks = recs.filter((x) => x.state === 'ranked').sort((a, b) => a.rank - b.rank);
ok('ranking: fast, liar, slow; the dead one is not ranked', ranks.length === 3 && ranks.map((x) => x.id.split(':')[1]).join() === [A, D, B].map((f) => f.port).join(), JSON.stringify(ranks));
ok('summary and progress', r.tested === 4 && r.ranked === 3 && r.best.name === 'Fast' && prog.length > 10 && prog.at(-1)[0] === prog.at(-1)[1], JSON.stringify(prog.at(-1)));
const rc = []; await K.dnsBench(ns, [list[1]], { names: ['a.test'], rounds: 2, mode: 'cached', timeout: 250, onRec: (x) => rc.push(x) });
ok('cached mode: no fresh numbers', rc[0].fresh_avg === null && rc[0].nxdomain === '' && rc[0].ok === 2, JSON.stringify(rc[0]));
const rf = []; await K.dnsBench(ns, [list[1]], { rounds: 2, mode: 'fresh', timeout: 250, onRec: (x) => rf.push(x) });
ok('fresh mode: only fresh', rf[0].cached_avg === null && rf[0].fresh_avg > 0 && rf[0].ok === 4, JSON.stringify(rf[0]));
let cnt = 0; const rs = []; await K.dnsBench(ns, list, { names: ['a.test'], rounds: 3, timeout: 100, stop: () => ++cnt > 6, onRec: (x) => rs.push(x) });
ok('stop ends early', rs.filter((x) => x.state === 'done').length < 4);
for (const f of [A, B, C, D]) f.s.close(); ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
