// Мост приложения DSP по WebSocket на сокетах Node: для проверки узлов страницы в браузере без телефона.
import http from 'node:http';
import { wsAccept, wsFrame, wsParser } from './termux/bridge.mjs';
import { mockApp } from './netmock.mjs';

export function mockBridgeWs(port = 0, opt = {}) {
  const apps = new Set();
  const server = http.createServer((q, s) => { s.end('mock bridge'); });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(key) + '\r\n\r\n');
    const send = (o) => { try { sock.write(wsFrame(JSON.stringify(o))); } catch (e) { /* закрыт */ } };
    const app = mockApp(send, opt); apps.add(app);
    const par = wsParser({
      onMsg: (t) => { let m; try { m = JSON.parse(t); } catch (e) { return; } if (m && m.cmd) app.send(m); },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } },
      onPing: (p) => { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) { /* закрыт */ } },
    });
    sock.on('data', par);
    const bye = () => { app.stop(); apps.delete(app); };
    sock.on('close', bye); sock.on('error', bye);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    port: server.address().port,
    close: () => { for (const a of apps) a.stop(); server.close(); },
  })));
}
