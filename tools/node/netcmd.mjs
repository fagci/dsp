// Сетевые команды приложения DSP на ноутбуке: ping, tcp.connect / listen / send / close, udp.open / send / request / close, net.info — тот же
// JSON-протокол, что у моста телефона (tools/android, NetHub.kt), чтобы узлы Network, Batch Check, HTTP Client, rtl_tcp Server и другие
// работали с мостом ноутбука без изменений (крафт и приём пакетов, rtl_tcp для SDR++ / GQRX). Пределы те же, что у приложения: серверы от
// порта 1024, 32 соединения, 4 сервера, 16 UDP-сокетов; tcp.connect с binary:true — байты кадрами [2][conn u32 BE][данные] (sendBin),
// страница шлёт [1][conn u32 BE][данные] в bin().
// Запрос страницы: {cmd, id, …}. Ответ: {src:'cmd', id, cmd, ok, …}; события сокета: {src:'net', ev:'data'|'close', conn, hex}.
// Защита та же, что у CORS-прокси моста: Origin и токен проверены до этого места, адрес разрешается и проверяется по классу
// (loopback / локальная сеть / служебные — по флагам моста), --hosts ограничивает имена. Остальные команды телефона — «unsupported».
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import os from 'node:os';
import {spawn} from 'node:child_process';

// ---- ping: системная утилита, без shell; разбор вывода не зависит от языка системы (считаем строки с ttl=, время — «time=12 ms» / «время=12мс») ----
export function pingArgs(platform, ip, count, sec) {
  if (platform === 'win32') return ['-n', String(count), '-w', String(sec * 1000), ip];
  if (platform === 'darwin') return ['-c', String(count), '-W', String(sec * 1000), '-n', ip];
  return ['-c', String(count), '-W', String(sec), '-n', ip];
}
export function parsePing(text, sent) {
  const times = []; let got = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!/ttl[=:]/i.test(line)) continue;                       // «Reply from …: TTL expired in transit» — не ответ узла
    got++;
    const m = /(?:time|время|zeit|temps)\s*([=<])\s*([\d.,]+)/i.exec(line);
    if (m) times.push(m[1] === '<' ? 0.5 : parseFloat(m[2].replace(',', '.')));
  }
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  return {got: Math.min(got, sent), sent, avg: Math.round(avg * 100) / 100, min: times.length ? Math.min(...times) : 0, max: times.length ? Math.max(...times) : 0};
}
const okName = h => /^[A-Za-z0-9._:-]{1,253}$/.test(h) && !h.startsWith('-');

/** policy: {hostOk(host), classOk(cls, host), ipClass(ip), lookup} из моста; send(rec) — запись странице; enabled=false — всё «disabled». */
export function createNetCmds({policy, send, sendBin = null, log = () => {}, enabled = true, max = 32, platform = process.platform, spawnFn = spawn}) {
  const conns = new Map(), servers = new Map(), udps = new Map(), bin = new Set(); let seq = 0;
  const MAX_SERVERS = 4, MAX_UDP = 16;
  const reply = (m, extra) => send({src: 'cmd', id: m.id, cmd: m.cmd, ok: true, ...extra});
  const fail = (m, err, msg) => send({src: 'cmd', id: m.id, cmd: m.cmd, ok: false, err, msg});
  const checkHost = host => {                                   // имя — в --hosts; литерал IP — по классу (имена проверит lookup)
    if (!okName(host)) throw Object.assign(new Error('bad host'), {code: 'args'});
    if (!policy.hostOk(host)) throw Object.assign(new Error('host ' + host + ' is not in --hosts'), {code: 'forbidden'});
    if (net.isIP(host) && !policy.classOk(policy.ipClass(host), host)) throw Object.assign(new Error('the address ' + host + ' is not allowed (' + policy.ipClass(host) + '); see --proxy-loopback / --proxy-no-private'), {code: 'forbidden'});
  };
  const resolve = host => net.isIP(host) ? Promise.resolve(host) : new Promise((ok, bad) => policy.lookup(host, {}, (e, a) => e ? bad(Object.assign(e, {code: e.code === 'ENOTFOUND' ? 'dns' : 'forbidden'})) : ok(Array.isArray(a) ? a[0].address : a)));

  async function ping(m) {
    const host = String(m.host || '').trim(), count = Math.max(1, Math.min(10, +m.count || 1)), sec = Math.max(1, Math.min(10, +m.timeout || 2));
    checkHost(host); const ip = await resolve(host);
    const out = await new Promise((ok, bad) => {
      let buf = '', p;
      try { p = spawnFn('ping', pingArgs(platform, ip, count, sec), {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true}); } catch (e) { return bad(e); }
      const t = setTimeout(() => { try { p.kill(); } catch (e) { /* уже вышел */ } }, (count * (sec + 1) + 3) * 1000);
      p.stdout.on('data', d => { buf += d; if (buf.length > 65536) buf = buf.slice(-65536); });
      p.on('error', e => { clearTimeout(t); bad(Object.assign(new Error(e.code === 'ENOENT' ? 'the ping utility is not installed on this computer' : e.message), {code: 'unsupported'})); });
      p.on('close', () => { clearTimeout(t); ok(buf); });
    });
    reply(m, {host, ip, ...parsePing(out, count)});
  }
  async function connect(m) {
    const host = String(m.host || '').trim(), port = +m.port, ms = Math.max(500, Math.min(30000, +m.timeout || 5000)), useTls = !!m.tls;
    if (!(port > 0 && port < 65536)) throw Object.assign(new Error('port 1…65535'), {code: 'args'});
    if (conns.size >= max) throw Object.assign(new Error('too many connections'), {code: 'rate'});
    checkHost(host);
    const id = ++seq;
    await new Promise((ok, bad) => {
      const opt = {host, port, lookup: policy.lookup, timeout: ms};
      const s = useTls ? tls.connect({...opt, servername: net.isIP(host) ? undefined : host}) : net.connect(opt);
      const fin = e => { s.removeListener('error', fin); s.removeListener('timeout', onTo); if (e) { s.destroy(); bad(e); } else ok(s); };
      const onTo = () => fin(new Error('connect ETIMEDOUT ' + host + ':' + port));
      s.once(useTls ? 'secureConnect' : 'connect', () => fin(null)); s.once('error', fin); s.once('timeout', onTo);
      s.pause(); conns.set(id, s);
    }).then(s => {
      s.setTimeout(0); s.setNoDelay(true);
      const wantBin = !!m.binary && !!sendBin; if (wantBin) bin.add(id);
      attach(id, s);
      reply(m, {conn: id, peer: s.remoteAddress + ':' + s.remotePort, binary: wantBin}); s.resume();
    }, e => { conns.delete(id); throw e; });
  }
  // данные и закрытие TCP-сокета (и принятого, и своего): hex-записью или двоичным кадром [2][conn][данные]
  function attach(id, s) {
    s.on('data', d => {
      if (s.writableLength > 8 << 20) return s.destroy();
      if (bin.has(id) && sendBin) { const f = Buffer.alloc(5 + d.length); f[0] = 2; f.writeUInt32BE(id, 1); d.copy(f, 5); return sendBin(f); }
      send({src: 'net', ev: 'data', proto: 'tcp', conn: id, hex: d.toString('hex'), n: d.length, text: d.toString()});
    });
    s.on('error', () => {});
    s.on('close', () => { bin.delete(id); if (conns.delete(id)) send({src: 'net', ev: 'close', proto: 'tcp', conn: id}); });
  }
  async function listen(m) {
    const port = +m.port;
    if (!((port >= 1024 && port <= 65535) || port === 0)) throw Object.assign(new Error('port: 1024…65535 (an app cannot take lower ones)'), {code: 'args'});
    if (servers.size >= MAX_SERVERS) throw Object.assign(new Error(MAX_SERVERS + ' servers at most'), {code: 'rate'});
    const sid = ++seq;
    const ss = net.createServer(s => {
      if (conns.size >= max) return s.destroy();
      const n = ++seq; conns.set(n, s); s.setNoDelay(true);
      send({src: 'net', ev: 'accept', conn: n, server: sid, proto: 'tcp', peer: s.remoteAddress + ':' + s.remotePort});
      attach(n, s);
    });
    await new Promise((ok, bad) => { ss.once('error', bad); ss.listen(port, m.lan === false ? '127.0.0.1' : '0.0.0.0', () => { ss.removeListener('error', bad); ok(); }); });
    ss.on('error', () => {});
    servers.set(sid, ss);
    ss.on('close', () => { if (servers.delete(sid)) send({src: 'net', ev: 'close', server: sid, proto: 'tcp'}); });
    reply(m, {server: sid, port: ss.address().port, ordered: true, binary: !!sendBin});
  }
  // UDP: имя — по --hosts, адрес — по классу, но многоадресные и широковещательные (mDNS, SSDP, 255.255.255.255) разрешены, раз пакеты и нужны
  async function udpTarget(m) {
    const host = String(m.host || '').trim();
    if (!okName(host)) throw Object.assign(new Error('bad host'), {code: 'args'});
    if (!policy.hostOk(host)) throw Object.assign(new Error('host ' + host + ' is not in --hosts'), {code: 'forbidden'});
    if (net.isIP(host)) {
      const cls = policy.ipClass(host);
      if (cls === 'multicast' || host === '255.255.255.255') return host;
      if (!policy.classOk(cls, host)) throw Object.assign(new Error('the address ' + host + ' is not allowed (' + cls + '); see --proxy-loopback / --proxy-no-private / --hosts'), {code: 'forbidden'});
      return host;
    }
    return resolve(host);
  }
  const payload = m => m.hex != null ? Buffer.from(String(m.hex).replace(/[^0-9a-f]/gi, ''), 'hex') : m.text != null ? Buffer.from(String(m.text), 'utf8') : null;
  const udpPort = m => { const p = +m.port; if (!(p > 0 && p < 65536)) throw Object.assign(new Error('port 1…65535'), {code: 'args'}); return p; };
  async function udpOpen(m) {
    if (udps.size >= MAX_UDP) throw Object.assign(new Error(MAX_UDP + ' sockets at most'), {code: 'rate'});
    const port = +m.port || 0;
    if (port && port < 1024) throw Object.assign(new Error('port: 0 (any) or 1024…65535'), {code: 'args'});
    const s = dgram.createSocket({type: 'udp4', reuseAddr: true}), n = ++seq;
    await new Promise((ok, bad) => { s.once('error', bad); s.bind(port, () => { s.removeListener('error', bad); ok(); }); });
    s.on('error', () => {});
    if (m.broadcast) s.setBroadcast(true);
    if (m.multicast) { try { s.addMembership(String(m.multicast)); } catch (e) { /* группы может не быть */ } }
    udps.set(n, s);
    s.on('message', (b, r) => send({src: 'net', ev: 'data', conn: n, proto: 'udp', peer: r.address + ':' + r.port, hex: b.toString('hex'), n: b.length, text: b.toString()}));
    reply(m, {conn: n, port: s.address().port});
  }
  async function udpSend(m) {
    const d = payload(m); if (!d) throw Object.assign(new Error('hex or text'), {code: 'args'});
    if (d.length > 65507) throw Object.assign(new Error('too big'), {code: 'args'});
    const ip = await udpTarget(m), port = udpPort(m), own = udps.get(+m.conn), s = own || dgram.createSocket('udp4');
    if (!own) { s.on('error', () => {}); if (m.broadcast) await new Promise(ok => s.bind(0, () => { s.setBroadcast(true); ok(); })); }
    await new Promise((ok, bad) => s.send(d, port, ip, e => { if (!own) s.close(); e ? bad(e) : ok(); }));
    reply(m, {n: d.length});
  }
  async function udpRequest(m) {
    const d = payload(m); if (!d) throw Object.assign(new Error('hex or text'), {code: 'args'});
    const ip = await udpTarget(m), port = udpPort(m), ms = Math.max(200, Math.min(30000, +m.timeout || 3000));
    const s = dgram.createSocket('udp4'), t0 = process.hrtime.bigint();
    s.on('error', () => {});
    try {
      const b = await new Promise((ok, bad) => {
        const to = setTimeout(() => bad(new Error('no answer from ' + m.host + ':' + port + ' in ' + ms + ' ms')), ms);
        s.once('message', x => { clearTimeout(to); ok(x); });
        s.send(d, port, ip, e => { if (e) { clearTimeout(to); bad(e); } });
      });
      reply(m, {hex: b.toString('hex'), n: b.length, ms: Number(process.hrtime.bigint() - t0) / 1e6, server: m.host});
    } finally { s.close(); }
  }
  function netInfo(m) {
    const ifs = Object.entries(os.networkInterfaces()).flatMap(([name, l]) => (l || []).filter(x => x.family === 'IPv4' && !x.internal).map(x => ({name, ip: x.address})));
    reply(m, {dns: dns.getServers(), ips: ifs.map(x => x.ip), iface: ifs.length ? ifs[0].name : '', gateway: '', wifi: true, cell: false, root: false});
  }
  const sockOf = m => { const s = conns.get(+m.conn); if (!s) throw Object.assign(new Error('no such connection'), {code: 'args'}); return s; };

  return {
    closeAll() { for (const s of conns.values()) s.destroy(); for (const s of servers.values()) s.close(); for (const s of udps.values()) s.close(); conns.clear(); servers.clear(); udps.clear(); bin.clear(); },
    // двоичный кадр страницы [1][conn u32 BE][данные] — поток байт в TCP-соединение без hex и ответов (rtl_tcp Server страницы)
    bin(b) { if (!enabled || b.length <= 5 || b[0] !== 1) return; const s = conns.get(b.readUInt32BE(1)); if (s && s.writableLength < 8 << 20) s.write(b.subarray(5)); },
    async handle(m) {
      try {
        if (!enabled) throw Object.assign(new Error('network commands are off on this bridge (--no-net)'), {code: 'disabled'});
        switch (m.cmd) {
          case 'ping': return await ping(m);
          case 'tcp.connect': return await connect(m);
          case 'tcp.send': {
            const s = sockOf(m), b = m.hex != null ? Buffer.from(String(m.hex).replace(/[^0-9a-f]/gi, ''), 'hex') : Buffer.from(String(m.text || ''), 'utf8');
            await new Promise((ok, bad) => s.write(b, e => e ? bad(e) : ok())); return reply(m, {n: b.length});
          }
          case 'tcp.listen': return await listen(m);
          case 'tcp.close': case 'udp.close': {
            const n = m.server != null ? +m.server : +m.conn;
            const t = conns.get(n); if (t) t.destroy();
            const sv = servers.get(n); if (sv) sv.close();
            const u = udps.get(n); if (u) { udps.delete(n); u.close(); send({src: 'net', ev: 'close', conn: n, proto: 'udp'}); }
            return reply(m, {});
          }
          case 'udp.open': return await udpOpen(m);
          case 'udp.send': return await udpSend(m);
          case 'udp.request': return await udpRequest(m);
          case 'net.info': return netInfo(m);
          default: throw Object.assign(new Error(String(m.cmd) + ' is not supported by this bridge — ping, tcp.* and udp.* only; the rest (SMS, USSD, sensors, scans) needs the DSP app on the phone'), {code: 'unsupported'});
        }
      } catch (e) {
        const code = e.code || '';
        fail(m, ['args', 'forbidden', 'dns', 'rate', 'unsupported', 'disabled'].includes(code) ? code : 'error', e.message);
        if (code === 'forbidden') log('net: refused ' + m.cmd + ' ' + (m.host || '') + ': ' + e.message);
      }
    },
  };
}
