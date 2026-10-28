// Сканер сети (modules/netscan-kernels.js): адреса, порты, TCP / UDP-пробы, ARP: node tools/test-netscan.mjs
import net from 'node:net';
import dgram from 'node:dgram';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'netscan-kernels.js'], 'NetSock,scanTargets,scanPortList,scanLocalCidr,scanClassify,scanArpParse,scanRun,scanTcp,scanUdp,scanNbNames,scanSnmpDescr,SCAN_UDP,SCAN_SERVICES,nsBytes,nsEnc,nsDec');

// --- чистая логика ---
ok('cidr /30', K.scanTargets('10.0.0.0/30').join() === '10.0.0.1,10.0.0.2');
ok('cidr /24 without network and broadcast', K.scanTargets('192.168.1.77/24').length === 254 && K.scanTargets('192.168.1.77/24')[0] === '192.168.1.1');
ok('range and list', K.scanTargets('10.0.0.5-7, 10.0.0.9, 10.0.0.6').join() === '10.0.0.5,10.0.0.6,10.0.0.7,10.0.0.9');
ok('range to a full address', K.scanTargets('10.0.0.254-10.0.1.1').length === 4);
ok('bad targets', ['10.0.0.256', '10.0.0.0/8', 'abc', '10.0.0.9-3'].every((t) => { try { K.scanTargets(t); return false; } catch (e) { return true; } }));
ok('too many', (() => { try { K.scanTargets('10.0.0.0/16', 1000); return false; } catch (e) { return /more than/.test(e.message); } })());
ok('ports', K.scanPortList('22, 80,8000-8002,22').join() === '22,80,8000,8001,8002' && K.scanPortList('top').length > 30 && K.scanPortList('all').length === 65535);
ok('bad ports', ['0', '70000', '10-5', 'x'].every((t) => { try { K.scanPortList(t); return false; } catch (e) { return true; } }));
ok('local network from net.info', K.scanLocalCidr(['fe80::1', '192.168.43.7']) === '192.168.43.0/24' && K.scanLocalCidr(['8.8.8.8']) === '');
ok('connect errors', K.scanClassify('ConnectException: connect failed: ECONNREFUSED (Connection refused)') === 'refused'
  && K.scanClassify('failed to connect to /10.0.0.9 (port 80) after 400ms: EHOSTUNREACH (No route to host)') === 'unreach'
  && K.scanClassify('SocketTimeoutException: connect timed out') === 'timeout' && K.scanClassify('boom') === 'error');
const arp = K.scanArpParse('IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         aa:bb:cc:00:11:22     *        wlan0\n192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        wlan0\n192.168.1.20     0x1         0x2         DE:AD:BE:EF:00:01     *        wlan0\n');
ok('arp table', arp.length === 2 && arp[0].mac === 'aa:bb:cc:00:11:22' && arp[1].mac === 'de:ad:be:ef:00:01' && arp[1].dev === 'wlan0', JSON.stringify(arp));
const nei = K.scanArpParse('192.168.1.1 dev wlan0 lladdr aa:bb:cc:00:11:22 REACHABLE\n192.168.1.5 dev wlan0  FAILED\n192.168.1.6 dev wlan0 lladdr 11:22:33:44:55:66 STALE\n');
ok('ip neigh', nei.length === 2 && nei[1].ip === '192.168.1.6');
// ответы протоколов
const nb = new Uint8Array(57 + 18 * 2 + 10); nb[56] = 2;
nb.set(Buffer.from('MYPC           '), 57); nb[57 + 15] = 0; nb.set(Buffer.from('WORKGROUP     '), 57 + 18); nb[57 + 18 + 15] = 0;
ok('netbios names', K.scanNbNames(nb) === 'MYPC WORKGROUP', K.scanNbNames(nb));
const snmp = K.nsBytes('3040020100040670 75626c6963a2330201010201 00020100 30283026 06082b0601020101 0100 0414'.replace(/ /g, '') + Buffer.from('Linux router 5.4').toString('hex').padEnd(40, '0')); // не точный BER — проверяем поиск OID
ok('snmp sysDescr', /Linux router/.test(K.scanSnmpDescr(snmp)), K.scanSnmpDescr(snmp));
ok('udp probes are well-formed', K.SCAN_UDP[53].pkt().length === 29 && K.SCAN_UDP[123].pkt().length === 48 && K.SCAN_UDP[161].pkt()[0] === 0x30 && K.SCAN_UDP[161].pkt().length === 40 && K.SCAN_UDP[137].pkt().length === 50, [53, 161, 137].map((p) => K.SCAN_UDP[p].pkt().length).join());

// --- на сокетах: узлы и порты ---
const live = new Set(['127.0.0.2', '127.0.0.4']);
const ns = mockSock(K, {
  root: true,
  extra: (j, reply) => {
    if (j.cmd === 'ping') { reply(j.id, 'ping', null, { host: j.host, sent: 1, got: live.has(j.host) ? 1 : 0, avg: 0.2 }); return true; }
    if (j.cmd === 'sys.shell.exec') { reply(j.id, 'sys.shell.exec', null, { out: '127.0.0.2 0x1 0x2 aa:bb:cc:00:11:22 * lo\n', code: 0 }); return true; }
    return false;
  },
});
const recs = [];
let r = await K.scanRun(ns, { mode: 'hosts', cidr: '127.0.0.0/29', ping: true, timeout: 300, onRec: (x) => recs.push(x) });
const hosts = recs.filter((x) => x.kind === 'host' && x.how !== 'arp');
ok('hosts sweep: ping hosts, the rest answer RST', hosts.length === 6 && hosts.find((x) => x.ip === '127.0.0.2').how === 'ping' && hosts.find((x) => x.ip === '127.0.0.3').how === 'tcp-rst', JSON.stringify(hosts.map((h) => h.ip + ':' + h.how)));
ok('MAC from the ARP table after the sweep', recs.some((x) => x.how === 'arp' && x.ip === '127.0.0.2' && x.mac === 'aa:bb:cc:00:11:22'));
ok('summary', r.hosts === 6 && r.scanned === 6);
const arpOnly = []; r = await K.scanRun(ns, { mode: 'arp', onRec: (x) => arpOnly.push(x) });
ok('arp mode', arpOnly.length === 1 && arpOnly[0].mac === 'aa:bb:cc:00:11:22');
const ns2 = mockSock(K);
ok('arp needs the shell command', await K.scanRun(ns2, { mode: 'arp' }).then(() => false, (e) => /Allow root/.test(e.message)));
ns2.app.stop();

const web = net.createServer((s) => s.on('data', () => { s.end('HTTP/1.0 200 OK\r\nServer: DspTestHttpd/1.0\r\n\r\nhi'); }));
const ssh = net.createServer((s) => s.write('SSH-2.0-OpenSSH_9.0\r\n'));
const quiet = net.createServer((s) => s.on('data', () => {}));
await Promise.all([web, ssh, quiet].map((s) => new Promise((res) => s.listen(0, '127.0.0.1', res))));
const [pw, ps, pq] = [web, ssh, quiet].map((s) => s.address().port);
const closed = await new Promise((res) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => res(p)); }); });
const pr = []; r = await K.scanRun(ns, { mode: 'ports', host: '127.0.0.1', ports: [pw, ps, pq, closed].join(), timeout: 500, onRec: (x) => pr.push(x) });
ok('port scan: 3 open, closed is not reported', pr.length === 3 && r.open === 3 && r.scanned === 4, JSON.stringify(pr));
ok('banner: ssh', pr.find((x) => x.port === ps).banner.startsWith('SSH-2.0-OpenSSH'));
ok('banner: quiet port is open without banner', pr.find((x) => x.port === pq).banner === '');
const withClosed = []; await K.scanRun(ns, { mode: 'ports', host: '127.0.0.1', ports: String(closed), showClosed: true, onRec: (x) => withClosed.push(x) });
ok('closed ports on request', withClosed.length === 1 && withClosed[0].state === 'closed');
const hp = []; await K.scanRun(ns, { mode: 'ports', host: '127.0.0.1', ports: '8080', timeout: 300, onRec: (x) => hp.push(x) });
ok('service names exist', K.SCAN_SERVICES[8080] === 'http-proxy' && K.SCAN_SERVICES[22] === 'ssh');
const tcpr = await K.scanTcp(ns, '127.0.0.1', pw, { timeout: 500 });
ok('http banner has the Server header', /DspTestHttpd\/1\.0/.test(tcpr.banner) && /HTTP\/1\.0 200/.test(tcpr.banner), tcpr.banner);
const stopAt = []; let cnt = 0;
await K.scanRun(ns, { mode: 'ports', host: '127.0.0.1', ports: '1-2000', concurrency: 8, timeout: 200, stop: () => ++cnt > 30, onRec: (x) => stopAt.push(x) });
ok('stop ends the scan early', cnt < 400, String(cnt));

// UDP: обычный эхо-сервер на произвольном порту, «закрытый» порт молчит
const echo = dgram.createSocket('udp4'); echo.on('message', (b, i) => echo.send(Buffer.from('pong'), i.port, i.address));
await new Promise((res) => echo.bind(0, '127.0.0.1', res));
const eport = echo.address().port;
const ur = await K.scanUdp(ns, '127.0.0.1', eport, { timeout: 500 });
ok('udp: answer means open', ur.state === 'open' && ur.banner === '4 B', JSON.stringify(ur));
const um = await K.scanUdp(ns, '127.0.0.1', 1, { timeout: 200 });
ok('udp: silence is open|filtered', um.state === 'open|filtered');
const urec = []; await K.scanRun(ns, { mode: 'udp', host: '127.0.0.1', ports: eport + ',' + (eport + 1), timeout: 300, onRec: (x) => urec.push(x) });
ok('udp scan reports only answered ports', urec.length === 1 && urec[0].proto === 'udp' && urec[0].port === eport);
echo.close(); web.close(); ssh.close(); quiet.close();
ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
