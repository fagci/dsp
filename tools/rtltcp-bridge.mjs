// Мост «TCP rtl_tcp ↔ WebSocket» для узла rtl_tcp Server: страница сама открыть TCP-порт не может, поэтому настоящий порт
// (по умолчанию 1234) слушает этот скрипт, а страница подключается к нему по WebSocket (ws://127.0.0.1:8767).
// Что пришло по TCP (команды клиента) — уходит бинарным кадром странице; что пришло от страницы (заголовок «RTL0» и IQ) — в TCP.
// Страница получает текстовые сообщения {"client":true|false}, когда TCP-клиент подключается / уходит.
//   node tools/rtltcp-bridge.mjs [--tcp 1234] [--ws 8767] [--host 127.0.0.1] [--token секрет] [--origin https://мой.сайт]
// С --token адрес в узле: ws://host:8767/?token=секрет — или «@имя» из Settings → Devices, токен хранится там, как у моста телефона.
// В SDR++ / GQRX: источник «RTL-TCP», адрес этого компьютера, порт 1234. Для доступа из сети — --host 0.0.0.0.
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wsAccept, wsFrame, wsParser, originOk, DEFAULT_ORIGINS } from './termux/bridge.mjs';

const HIGH = 4 << 20;                                       // больше этого в очереди TCP-клиента — блок выбрасываем

export function createRtlBridge(opt = {}) {
  const o = { host: '127.0.0.1', tcp: 1234, ws: 8767, token: '', origins: DEFAULT_ORIGINS, log: () => {}, ...opt };
  let page = null, cli = null, drops = 0;                   // страница (WS), TCP-клиент
  const note = (v) => { if (page && !page.dead) try { page.sock.write(wsFrame(JSON.stringify({ client: v }))); } catch (e) { page.dead = true; } };

  const tcpSrv = net.createServer((s) => {
    if (!page || page.dead) { o.log('tcp client refused: no page'); s.destroy(); return; }
    if (cli) { o.log('tcp client refused: busy'); s.destroy(); return; }
    cli = s; s.setNoDelay(true); o.log('tcp client ' + s.remoteAddress);
    note(true);
    s.on('data', (b) => { if (page && !page.dead) try { page.sock.write(wsFrame(b, 2)); } catch (e) { page.dead = true; } });
    const gone = () => { if (cli === s) { cli = null; note(false); o.log('tcp client left'); } };
    s.on('close', gone); s.on('error', gone);
  });

  const httpSrv = http.createServer((q, r) => { r.end('rtl_tcp bridge: connect the rtl_tcp Server node here (WebSocket)'); });
  httpSrv.on('upgrade', (req, sock) => {
    if (!originOk(req.headers.origin, o.origins) || !req.headers['sec-websocket-key']) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (o.token && new URL(req.url, 'http://x').searchParams.get('token') !== o.token) { o.log('refused: wrong token'); sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    if (page && !page.dead) { sock.end('HTTP/1.1 409 Conflict\r\n\r\n'); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    const me = { sock, dead: false }; page = me; o.log('page connected');
    const close = () => { if (page === me) { page = null; me.dead = true; if (cli) cli.destroy(); o.log('page left'); } };
    sock.on('data', wsParser({
      onMsg: () => {},
      onBin: (b) => { if (cli && cli.writableLength < HIGH) cli.write(b); else drops++; },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) {} close(); },
      onPing: (p) => { try { sock.write(wsFrame(p, 10)); } catch (e) {} },
    }));
    sock.on('close', close); sock.on('error', close);
  });

  return {
    start: () => Promise.all([
      new Promise((r) => tcpSrv.listen(o.tcp, o.host, r)), new Promise((r) => httpSrv.listen(o.ws, o.host, r))]).then(() => ({
      tcp: tcpSrv.address().port, ws: httpSrv.address().port })),
    stop: () => { if (cli) cli.destroy(); if (page) page.sock.destroy(); tcpSrv.close(); httpSrv.close(); httpSrv.closeAllConnections?.(); },
    stats: () => ({ drops, page: !!page, client: !!cli }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = process.argv.slice(2), g = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const b = createRtlBridge({ host: g('host', '127.0.0.1'), tcp: +g('tcp', 1234), ws: +g('ws', 8767), token: g('token', ''), origins: [...DEFAULT_ORIGINS, ...a.flatMap((x, i) => x === '--origin' ? [a[i + 1]] : [])], log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
  if (g('host', '127.0.0.1') !== '127.0.0.1' && !g('token', '')) console.error('warning: open to the network without --token — anyone on it can take the radio and the TCP port');
  const p = await b.start();
  console.log(`rtl_tcp bridge: TCP ${g('host', '127.0.0.1')}:${p.tcp} ← SDR++/GQRX, WebSocket ws://${g('host', '127.0.0.1')}:${p.ws} ← rtl_tcp Server node`);
}
