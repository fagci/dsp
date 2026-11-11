// Network Monitor: расшифровка TLS только для явного списка — vpn.tls / vpn.tls.ca, записи plain / tlserror в браузере.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-vpnmon-tls.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
import { wsAccept, wsFrame, wsParser } from './termux/bridge.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Мост-заглушка минимальная: отвечает на команды (onCmd), и send() можно звать снаружи, чтобы протолкнуть любую запись (src:'vpn').
function mockVpnBridge(onCmd) {
  const server = http.createServer((q, s) => s.end('mock'));
  const socks = new Set(); const subs = new Set();
  server.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    socks.add(sock);
    const par = wsParser({
      onMsg: (t) => {
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (m && Array.isArray(m.sub)) { for (const x of m.sub) subs.add(x); return; }
        if (m && m.cmd) onCmd(m, (extra) => { try { sock.write(wsFrame(JSON.stringify({ src: 'cmd', cmd: m.cmd, id: m.id, ok: true, ...extra }))); } catch (e) {} },
          (msg, err) => { try { sock.write(wsFrame(JSON.stringify({ src: 'cmd', cmd: m.cmd, id: m.id, ok: false, err: err || 'error', msg }))); } catch (e) {} });
      },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) {} }, onPing: (p) => { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) {} },
    });
    sock.on('data', par); sock.on('close', () => socks.delete(sock)); sock.on('error', () => socks.delete(sock));
  });
  const send = (o) => { if (!subs.has(o.src)) return; for (const s of socks) try { s.write(wsFrame(JSON.stringify([o]))); } catch (e) {} };
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, send, close: () => server.close() })));
}

const got = [];
let serverTlsApps = [];                               // «правда» моста — какая-то реальная служба могла её забыть (перезапуск), страница узнаёт только переспросив
const br = await mockVpnBridge((m, reply) => {
  got.push(m);
  if (m.cmd === 'vpn.tls') { serverTlsApps = m.apps || []; reply({ apps: serverTlsApps }); return; }
  if (m.cmd === 'vpn.tls.ca') {
    if (m.reset) return reply({ pem: '-----BEGIN CERTIFICATE-----\nRESET\n-----END CERTIFICATE-----\n', fingerprint: 'AA:BB (new)', apps: serverTlsApps });
    return reply({ pem: '-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----\n', fingerprint: 'DE:AD:BE:EF', apps: serverTlsApps });
  }
  reply({});
});

const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate((p) => {
  clearAll();
  const vm = addNode('vpnmon', 40, 40, { url: 'ws://127.0.0.1:' + p, tlsApps: 'com.a.one' });
  const plainT = addNode('table', 500, 40, { list: '@patch', key: '', initial: false });    // без key: каждая запись — своя строка (один id у обеих сторон потока)
  const errT = addNode('table', 500, 300, { list: '@patch', key: '', initial: false });
  addEdge(vm.id, 'plain', plainT.id, 'rec'); addEdge(vm.id, 'tlsErr', errT.id, 'rec');
  window.__vm = vm; window.__plainT = plainT; window.__errT = errT; markWiresDirty();
}, br.port);
await pg.click('#run'); await wait(600);
await pg.evaluate(() => vpnConnect(__vm)); await wait(800);

await pg.evaluate(() => vpnSetTls(__vm)); await wait(600);
ok('vpn.tls carries the parsed app list', got.some((g) => g.cmd === 'vpn.tls' && JSON.stringify(g.apps) === '["com.a.one"]'), JSON.stringify(got));
let status = await pg.evaluate(() => __vm.status);
ok('status reflects the decrypt list after vpn.tls', /TLS decrypt: 1/.test(status), status);

await pg.evaluate(() => vpnGetCa(__vm)); await wait(600);
const st = await pg.evaluate(() => ({ pem: __vm.caPem, fp: __vm.caFingerprint, status: __vm.status }));
ok('CA pem and fingerprint land on the node', st.pem.includes('ABCD') && st.fp === 'DE:AD:BE:EF', JSON.stringify(st));
ok('status shows the fingerprint for manual verification before install', st.status.includes('DE:AD:BE:EF'), st.status);
const caOut = await pg.evaluate(() => __vm.process ? null : null); // noop, caPem is exposed via process() output below
const outCaPem = await pg.evaluate(() => { const o = MOD['vpnmon'].process(__vm, {}); return o.caPem; });
ok('caPem output carries the certificate for wiring to a Text Panel', outCaPem.includes('ABCD'), String(outCaPem));

await pg.evaluate(() => vpnResetCa(__vm)); await wait(600);
ok('reset sends {reset:true}', got.some((g) => g.cmd === 'vpn.tls.ca' && g.reset === true), JSON.stringify(got.filter((g) => g.cmd === 'vpn.tls.ca')));
const st2 = await pg.evaluate(() => __vm.caFingerprint);
ok('fingerprint updates after reset (a genuinely new CA)', st2 === 'AA:BB (new)', st2);

// записи plain / tlserror приходят через ev-поток и попадают в выделенные выходы
br.send({ src: 'vpn', ev: 'state', on: true, t: Date.now() });
br.send({ src: 'vpn', ev: 'plain', id: 7, dir: 'up', n: 11, hex: '68656c6c6f', text: 'GET / HTTP/1.1', t: Date.now() });
br.send({ src: 'vpn', ev: 'plain', id: 7, dir: 'down', n: 15, hex: '', text: 'HTTP/1.1 200 OK', t: Date.now() });
br.send({ src: 'vpn', ev: 'tlserror', id: 9, host: 'bad.example', msg: 'untrusted upstream certificate', t: Date.now() });
await wait(800);
const rows = await pg.evaluate(() => ({ plain: __plainT.all, err: __errT.all }));
ok('plain Table carries both directions with a readable preview', rows.plain.length === 2 && rows.plain[0].preview === 'GET / HTTP/1.1' && rows.plain[1].dir === 'down', JSON.stringify(rows.plain));
ok('tlsErr Table carries the failure', rows.err.length === 1 && rows.err[0].host === 'bad.example', JSON.stringify(rows.err));
const line = await pg.evaluate(() => __vm.last);
ok('the log line for the last event is the TLS error, readable', /TLS #9 bad\.example: untrusted upstream certificate/.test(line), line);
ok('no page errors', errs.length === 0, errs.join(' | '));


// Служба на телефоне перезапустилась (новый CA, OEM прибил процесс…) — список расшифровки там тихо обнулился, страница
// об этом не знает, пока не переспросит. Рвём соединение (как настоящий обрыв), сервер «забывает» список, ждём переподключения.
got.length = 0; serverTlsApps = [];
await pg.evaluate(() => { __vm.p.reconnect = true; __vm.ws.close(); });
await wait(4500);                                       // reconnect — через 3 с (vpnConnect), плюс время на onopen
const afterReconnect = await pg.evaluate(() => ({ status: __vm.status, on: !!__vm.ws }));
ok('page resends vpn.tls right after reconnecting (not only on a manual button press)', got.some((g) => g.cmd === 'vpn.tls'), JSON.stringify(got));
ok('server truth is restored and the status reflects it, without touching the button', /TLS decrypt: 1/.test(afterReconnect.status), JSON.stringify(afterReconnect));
ok('server actually has the app again (not just a stale client-side count)', JSON.stringify(serverTlsApps) === '["com.a.one"]', JSON.stringify(serverTlsApps));
await b.close(); br.close();
if (bad) { console.log(bad + ' failed'); process.exit(1); }
console.log('e2e vpnmon-tls: all ok');
