// Мост приложения DSP (NetHub.kt) на сокетах Node: tcp.* / udp.* / net.info — для тестов сетевых протоколов без телефона.
// Те же ограничения, что в приложении: порты серверов от 1024, 32 соединения, 4 сервера, 16 UDP-сокетов.
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import vm from 'node:vm';

export function loadKernels(files, expose) {
  const ctx = vm.createContext({ TextEncoder, TextDecoder, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Math, Date, Promise, atob, btoa });
  for (const f of files) vm.runInContext(fs.readFileSync(new URL('../modules/' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  vm.runInContext('this.K={' + expose + '}', ctx);
  return ctx.K;
}

export function mockApp(feed, opt = {}) {
  let ids = 0;
  const tcp = new Map(), servers = new Map(), udp = new Map();
  const ev = (o) => setImmediate(() => feed({ src: 'net', t: Date.now(), ...o }));
  const reply = (id, cmd, err, extra = {}) => setImmediate(() => feed({ src: 'cmd', cmd, id, ok: !err, ...(err ? { err: 'error', msg: err } : {}), ...extra }));
  const hex = (b) => b.toString('hex');
  const payload = (j) => j.hex != null ? Buffer.from(j.hex, 'hex') : j.text != null ? Buffer.from(j.text, 'utf8') : null;
  const watch = (n, s) => {
    s.on('data', (b) => ev({ ev: 'data', conn: n, proto: 'tcp', hex: hex(b), n: b.length, text: b.toString() }));
    s.on('error', () => {});
    s.on('close', () => { if (tcp.delete(n)) ev({ ev: 'close', conn: n, proto: 'tcp' }); });
  };
  const run = (j) => {
    const { cmd, id } = j;
    switch (cmd) {
      case 'tcp.connect': {
        if (tcp.size >= 32) return reply(id, cmd, '32 connections at most');
        const s = net.connect({ host: j.host, port: j.port });
        s.setTimeout(j.timeout || 5000, () => s.destroy(new Error('timeout')));
        s.once('error', (e) => reply(id, cmd, e.code || e.message));
        s.once('connect', () => {
          s.setTimeout(0);
          const n = ++ids; tcp.set(n, s);
          ev({ ev: 'open', conn: n, proto: 'tcp', peer: j.host + ':' + j.port });
          reply(id, cmd, null, { conn: n });
          setImmediate(() => watch(n, s));
        });
        return;
      }
      case 'tcp.listen': {
        if (!(j.port >= 1024 && j.port <= 65535) && j.port !== 0) return reply(id, cmd, 'port: 1024…65535 (an app cannot take lower ones)');
        if (servers.size >= 4) return reply(id, cmd, '4 servers at most');
        const sid = ++ids;
        const ss = net.createServer((s) => {
          if (tcp.size >= 32) return s.destroy();
          const n = ++ids; tcp.set(n, s);
          ev({ ev: 'accept', conn: n, server: sid, proto: 'tcp', peer: s.remoteAddress + ':' + s.remotePort });
          setImmediate(() => watch(n, s));
        });
        ss.on('error', (e) => reply(id, cmd, e.code || e.message));
        ss.listen(j.port, j.lan === false ? '127.0.0.1' : '0.0.0.0', () => { servers.set(sid, ss); reply(id, cmd, null, { server: sid, port: ss.address().port }); });
        ss.on('close', () => { if (servers.delete(sid)) ev({ ev: 'close', server: sid, proto: 'tcp' }); });
        return;
      }
      case 'tcp.send': {
        const s = tcp.get(j.conn); if (!s) return reply(id, cmd, 'no such connection');
        const d = payload(j); if (!d) return reply(id, cmd, 'hex or text');
        if (d.length > 65535) return reply(id, cmd, 'too big');
        return s.write(d, () => reply(id, cmd, null, { n: d.length }));
      }
      case 'tcp.close': case 'udp.close': {
        const n = j.server != null ? j.server : j.conn;
        const t = tcp.get(n); if (t) { tcp.delete(n); t.destroy(); ev({ ev: 'close', conn: n, proto: 'tcp' }); }
        const sv = servers.get(n); if (sv) { servers.delete(n); sv.close(); ev({ ev: 'close', server: n, proto: 'tcp' }); }
        const u = udp.get(n); if (u) { udp.delete(n); u.close(); ev({ ev: 'close', conn: n, proto: 'udp' }); }
        return reply(id, cmd, null);
      }
      case 'udp.open': {
        if (udp.size >= 16) return reply(id, cmd, '16 sockets at most');
        if (j.port && j.port < 1024) return reply(id, cmd, 'port: 0 (any) or 1024…65535');
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true }), n = ++ids;
        s.on('error', (e) => reply(id, cmd, e.message));
        s.on('message', (b, r) => ev({ ev: 'data', conn: n, proto: 'udp', peer: r.address + ':' + r.port, hex: hex(b), n: b.length, text: b.toString() }));
        s.bind(j.port || 0, () => { if (j.broadcast) s.setBroadcast(true); udp.set(n, s); reply(id, cmd, null, { conn: n, port: s.address().port }); });
        return;
      }
      case 'udp.send': {
        const d = payload(j); if (!d) return reply(id, cmd, 'hex or text');
        const own = udp.get(j.conn), s = own || dgram.createSocket('udp4');
        const go = () => s.send(d, j.port, j.host, (e) => { if (!own) s.close(); reply(id, cmd, e ? e.message : null, { n: d.length }); });
        if (!own && j.broadcast) s.bind(0, () => { s.setBroadcast(true); go(); }); else go();
        return;
      }
      case 'udp.request': {
        const d = payload(j); if (!d) return reply(id, cmd, 'hex or text');
        const s = dgram.createSocket('udp4'), t0 = process.hrtime.bigint();
        const to = setTimeout(() => { s.close(); reply(id, cmd, 'no answer from ' + j.host + ':' + j.port + ' in ' + (j.timeout || 3000) + ' ms'); }, j.timeout || 3000);
        s.once('message', (b) => { clearTimeout(to); s.close(); reply(id, cmd, null, { hex: hex(b), n: b.length, ms: Number(process.hrtime.bigint() - t0) / 1e6, server: j.host }); });
        s.send(d, j.port, j.host);
        return;
      }
      case 'net.info': return reply(id, cmd, null, { dns: [], ips: opt.ips || ['127.0.0.1'], iface: 'lo', gateway: '', wifi: true, cell: false, root: !!opt.root });
      default:
        if (opt.extra) { const r = opt.extra(j, reply); if (r !== false) return; }
        return reply(id, cmd, 'unknown command');
    }
  };
  return {
    send: (j) => setImmediate(() => run(j)),
    stop: () => { for (const s of tcp.values()) s.destroy(); for (const s of servers.values()) s.close(); for (const s of udp.values()) s.close(); tcp.clear(); servers.clear(); udp.clear(); },
    counts: () => ({ tcp: tcp.size, servers: servers.size, udp: udp.size }),
  };
}

// NetSock поверх mockApp
export function mockSock(K, opt) {
  let app;
  const ns = new K.NetSock((j) => app.send(j));
  app = mockApp((r) => ns.feed(r), opt);
  ns.app = app;
  return ns;
}
