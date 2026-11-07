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
    // opt.app — как настоящее приложение: записи src:'net' и др. только подписавшимся ({sub:['net']}) и пачками-массивами раз в 40 мс; ответы src:'cmd' сразу
    const subs = new Set(); let buf = [], tm = null;
    const lat = opt.latency | 0;                                   // задержка в каждую сторону, мс (Wi-Fi между ноутбуком и телефоном)
    const raw = (t) => { const w = () => { try { sock.write(wsFrame(t)); } catch (e) { /* закрыт */ } }; if (lat) setTimeout(w, lat); else w(); };
    const send = (o) => {
      if (!opt.app || o.src === 'cmd') return raw(JSON.stringify(o));
      if (!subs.has(o.src)) return;
      buf.push(o); if (!tm) tm = setTimeout(() => { tm = null; const b = buf; buf = []; raw(JSON.stringify(b)); }, 40);
    };
    const app = mockApp(send, opt); apps.add(app);
    const par = wsParser({
      onMsg: (t) => { let m; try { m = JSON.parse(t); } catch (e) { return; } if (m && Array.isArray(m.sub)) { subs.clear(); for (const x of m.sub) subs.add(x); } else if (m && m.cmd) { if (lat) setTimeout(() => app.send(m), lat); else app.send(m); } },
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
