// Сетевые команды приложения DSP на ноутбуке: ping, tcp.connect / tcp.send / tcp.close — тот же JSON-протокол, что у моста телефона
// (tools/android, NetHub.kt), чтобы узлы Batch Check, HTTP Client и другие работали с мостом ноутбука без изменений.
// Запрос страницы: {cmd, id, …}. Ответ: {src:'cmd', id, cmd, ok, …}; события сокета: {src:'net', ev:'data'|'close', conn, hex}.
// Защита та же, что у CORS-прокси моста: Origin и токен проверены до этого места, адрес разрешается и проверяется по классу
// (loopback / локальная сеть / служебные — по флагам моста), --hosts ограничивает имена. Остальные команды телефона — «unsupported».
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
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
export function createNetCmds({policy, send, log = () => {}, enabled = true, max = 32, platform = process.platform, spawnFn = spawn}) {
  const conns = new Map(); let seq = 0;
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
      s.on('data', d => { if (s.writableLength > 8 << 20) return s.destroy(); send({src: 'net', ev: 'data', proto: 'tcp', conn: id, hex: d.toString('hex')}); });
      s.on('error', () => {}); s.on('close', () => { if (conns.delete(id)) send({src: 'net', ev: 'close', proto: 'tcp', conn: id}); });
      reply(m, {conn: id, peer: s.remoteAddress + ':' + s.remotePort}); s.resume();
    }, e => { conns.delete(id); throw e; });
  }
  const sockOf = m => { const s = conns.get(+m.conn); if (!s) throw Object.assign(new Error('no such connection'), {code: 'args'}); return s; };

  return {
    closeAll() { for (const s of conns.values()) s.destroy(); conns.clear(); },
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
          case 'tcp.close': { const s = conns.get(+m.conn); if (s) s.destroy(); return reply(m, {}); }
          default: throw Object.assign(new Error(String(m.cmd) + ' is not supported by this bridge — ping, tcp.connect / send / close only; the rest (SMS, USSD, sensors, scans) needs the DSP app on the phone'), {code: 'unsupported'});
        }
      } catch (e) {
        const code = e.code || '';
        fail(m, ['args', 'forbidden', 'dns', 'rate', 'unsupported', 'disabled'].includes(code) ? code : 'error', e.message);
        if (code === 'forbidden') log('net: refused ' + m.cmd + ' ' + (m.host || '') + ': ' + e.message);
      }
    },
  };
}
