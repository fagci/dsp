// Настольный мост для узла «Network (DSP app)»: те же команды tcp.* / udp.* / net.info, что у Android-приложения (NetHub.kt),
// на сокетах Node — TCP/UDP-клиент и сервер, пакеты приходят записями с hex (src:'net', ev:'data'). Вместе с HEX Structure
// (схемы rtltcp-cmd, rtltcp-header, eth, ipv4, tcp…) это крафт и приём произвольных пакетов с компьютера, без телефона.
//   node tools/net-bridge.mjs [--port 8765] [--host 127.0.0.1] [--token секрет] [--origin https://мой.сайт]
// В узле Network: url = ws://127.0.0.1:8765. Принимает только страницы с разрешённым Origin (по умолчанию localhost и fagci.github.io).
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wsAccept, wsFrame, wsParser, originOk, DEFAULT_ORIGINS } from './termux/bridge.mjs';
import { mockApp } from './netmock.mjs';

export function createNetBridge(opt = {}) {
  const o = { host: '127.0.0.1', port: 8765, token: '', origins: DEFAULT_ORIGINS, log: () => {}, ...opt };
  const apps = new Set();
  const server = http.createServer((q, s) => { s.end('DSP network bridge (tcp/udp for the Network node)'); });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !originOk(req.headers.origin, o.origins)) { o.log('refused origin ' + req.headers.origin); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (o.token && new URL(req.url, 'http://x').searchParams.get('token') !== o.token) { o.log('refused: wrong token'); sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    const send = (j) => { try { sock.write(wsFrame(JSON.stringify(j))); } catch (e) { /* закрыт */ } };
    const app = mockApp(send, {}); apps.add(app); o.log('page connected');
    sock.on('data', wsParser({
      onMsg: (t) => { let m; try { m = JSON.parse(t); } catch (e) { return; } if (m && m.cmd) { o.log(m.cmd + ' ' + JSON.stringify(m).slice(0, 120)); app.send(m); } },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } },
      onPing: (p) => { try { sock.write(wsFrame(p, 10)); } catch (e) { /* закрыт */ } },
    }));
    const bye = () => { if (apps.delete(app)) { app.stop(); o.log('page left'); } };
    sock.on('close', bye); sock.on('error', bye);
  });
  return {
    start: () => new Promise((ok) => server.listen(o.port, o.host, () => ok(server.address().port))),
    stop: () => { for (const a of apps) a.stop(); apps.clear(); server.close(); server.closeAllConnections?.(); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = process.argv.slice(2), g = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const host = g('host', '127.0.0.1');
  const b = createNetBridge({ host, port: +g('port', 8765), token: g('token', ''), origins: [...DEFAULT_ORIGINS, ...a.flatMap((x, i) => x === '--origin' ? [a[i + 1]] : [])], log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
  if (host !== '127.0.0.1' && !g('token', '')) console.error('warning: open to the network without --token — anyone on it can open TCP/UDP connections from this computer');
  console.log('network bridge: ws://' + host + ':' + await b.start() + '  (node «Network (DSP app)» → url)');
}
