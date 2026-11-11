// CORS-прокси Node-моста: node tools/test-proxy.mjs
import http from 'node:http';
import net from 'node:net';
import {createMsgrBridge, ipClass, hostOk} from './node/bridge.mjs';
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];

// классы адресов
const cls = {'8.8.8.8': 'public', '127.0.0.1': 'loopback', '10.1.2.3': 'private', '192.168.0.101': 'private', '172.20.0.1': 'private', '172.32.0.1': 'public', '169.254.169.254': 'linklocal',
  '0.0.0.0': 'unspecified', '224.0.0.1': 'multicast', '::1': 'loopback', '::': 'unspecified', 'fe80::1': 'linklocal', 'fd00::1': 'private', '::ffff:127.0.0.1': 'loopback', '::ffff:7f00:1': 'loopback',
  '::ffff:169.254.169.254': 'linklocal', '2606:4700::1111': 'public', 'nope': 'invalid'};
ok('address classes', Object.entries(cls).every(([ip, c]) => ipClass(ip) === c), JSON.stringify(Object.entries(cls).filter(([ip, c]) => ipClass(ip) !== c).map(([ip]) => [ip, ipClass(ip)])));

// «цель» без CORS-заголовков
let upstreamClosed = 0; const seen = [];
const target = http.createServer((req, res) => {
  seen.push({url: req.url, range: req.headers.range, ua: req.headers['user-agent'], cookie: req.headers.cookie, auth: req.headers.authorization});
  if (req.url === '/text') { res.writeHead(200, {'content-type': 'text/plain', 'set-cookie': 'a=b'}); return res.end('hello ' + 'x'.repeat(100)); }
  if (req.url === '/range') { const full = Buffer.from('0123456789'); const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || ''); if (!m) { res.writeHead(200, {'accept-ranges': 'bytes'}); return res.end(full); }
    res.writeHead(206, {'content-range': `bytes ${m[1]}-${m[2] ?? 9}/10`, 'accept-ranges': 'bytes'}); return res.end(full.subarray(+m[1], (m[2] ? +m[2] : 9) + 1)); }
  if (req.url === '/redir') { res.writeHead(302, {location: '/text'}); return res.end(); }
  if (req.url === '/redir-meta') { res.writeHead(302, {location: 'http://169.254.169.254/latest/meta-data/'}); return res.end(); }
  if (req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c));
    return req.on('end', () => {
      const body = Buffer.concat(chunks); seen.at(-1).body = body.toString(); seen.at(-1).ct = req.headers['content-type']; seen.at(-1).method = 'POST';
      if (req.url === '/post-redir') { res.writeHead(307, {location: '/post-echo'}); return res.end(); }
      if (req.url === '/post-ndjson') {                      // как Ollama: строки приходят по одной, не дожидаясь конца
        res.writeHead(200, {'content-type': 'application/x-ndjson'}); let n = 0;
        const t = setInterval(() => { res.write(JSON.stringify({n: n++}) + '\n'); if (n >= 3) { clearInterval(t); res.end(JSON.stringify({done: true}) + '\n'); } }, 60); return;
      }
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({echo: body.toString(), len: body.length}));
    });
  }
  if (req.url === '/q?a=1&b=2') { res.writeHead(200); return res.end('query kept'); }
  if (req.url === '/stream') {                              // бесконечный поток, как MJPEG: кадр раз в 40 мс
    res.writeHead(200, {'content-type': 'multipart/x-mixed-replace; boundary=f'}); let n = 0;
    const t = setInterval(() => res.write('--f\r\nframe ' + (n++) + '\r\n'), 40); res.on('close', () => { clearInterval(t); upstreamClosed++; }); return;
  }
  res.writeHead(404); res.end('nope');
}); servers.push(target);
const tp = await listen(target), T = 'http://127.0.0.1:' + tp;

const mk = async opt => { const b = createMsgrBridge({port: 0, ...opt}); const port = (await b.listen()).port; servers.push({close: () => b.close()}); return {b, port}; };
const get = (port, path, headers = {}, method = 'GET') => new Promise(res => { const q = http.request({port, path, method, headers}, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({status: r.statusCode, headers: r.headers, body: d})); }); q.on('error', e => res({err: e.message})); q.end(); });
const px = (port, url, extra = '') => '/proxy?' + extra + 'url=' + encodeURIComponent(url);

// по умолчанию loopback закрыт — это и есть защита от SSRF
{ const {port} = await mk({});
  const r = await get(port, px(port, T + '/text'));
  ok('default: a loopback target is refused (SSRF guard)', r.status === 403 && /not allowed/.test(r.body), r.status + ' ' + r.body);
  ok('default: the refusal is readable by the page (CORS headers on errors)', r.headers['access-control-allow-origin'] === '*');
  const m = await get(port, px(port, 'http://169.254.169.254/latest/meta-data/'));
  ok('default: cloud metadata address is refused', m.status === 403, m.status + m.body);
  const n = await get(port, px(port, 'http://localhost:' + tp + '/text'));
  ok('default: a name that resolves to loopback is refused too (checked at connect time)', n.status === 502 && /not allowed/.test(n.body), n.status + n.body);
  const f = await get(port, px(port, 'file:///etc/passwd'));
  ok('only http and https', f.status === 400, String(f.status));
}
// с разрешённым loopback — для проверки самого прокси
const {port} = await mk({proxyLoopback: true});
{ const r = await get(port, px(port, T + '/text'), {origin: 'http://localhost:8080'});
  ok('GET passes the body and adds CORS headers', r.status === 200 && r.body.startsWith('hello ') && r.headers['access-control-allow-origin'] === '*' && r.headers['content-type'] === 'text/plain');
  ok('Private Network Access header is present (Chrome asks for it from a public page)', r.headers['access-control-allow-private-network'] === 'true');
  ok('cookies of the target are not passed to the page', !r.headers['set-cookie']);
  const pre = await get(port, '/proxy?url=x', {origin: 'http://localhost:8080', 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true'}, 'OPTIONS');
  ok('preflight answers 204 with PNA', pre.status === 204 && pre.headers['access-control-allow-private-network'] === 'true' && /GET/.test(pre.headers['access-control-allow-methods']));
  const h = await get(port, px(port, T + '/text'), {}, 'HEAD'); ok('HEAD', h.status === 200 && h.body === '');
  const rg = await get(port, px(port, T + '/range'), {range: 'bytes=2-5'}); ok('Range goes through (206, Content-Range)', rg.status === 206 && rg.body === '2345' && /bytes 2-5\/10/.test(rg.headers['content-range']));
  const rd = await get(port, px(port, T + '/redir')); ok('redirects are followed', rd.status === 200 && rd.body.startsWith('hello'));
  const rm = await get(port, px(port, T + '/redir-meta')); ok('a redirect to a forbidden address is refused', rm.status === 403, rm.status + ' ' + rm.body);
  const raw = await get(port, '/proxy?url=' + T + '/q?a=1&b=2'); ok('a raw address without {url} encoding keeps its own query', raw.status === 200 && raw.body === 'query kept', raw.status + raw.body);
  ok('the page\'s cookies and auth are not sent to the target', (await get(port, px(port, T + '/text'), {cookie: 'sid=1', authorization: 'Bearer x'})) && seen.at(-1).cookie === undefined && seen.at(-1).auth === undefined);
  ok('the target sees a polite user agent', /DSP-workbench/.test(seen.at(-1).ua));
  const p = await get(port, px(port, T + '/text'), {}, 'PUT'); ok('methods other than GET / HEAD / POST are refused', p.status === 405);
  const pre2 = await get(port, '/proxy?url=x', {origin: 'http://localhost:8080', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'}, 'OPTIONS');
  ok('preflight of a JSON POST: allowed', pre2.status === 204 && /POST/.test(pre2.headers['access-control-allow-methods']) && pre2.headers['access-control-allow-headers'] === '*');
  const nf = await get(port, px(port, T + '/missing')); ok('the real status of the target is kept (404)', nf.status === 404);
}
// POST: тело и Content-Type доходят до цели, ответ потоком, защита та же
const post = (port, path, body, headers = {}) => new Promise(res => { const q = http.request({port, path, method: 'POST', headers: {'content-type': 'application/json', ...headers}}, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({status: r.statusCode, body: d, headers: r.headers})); }); q.on('error', e => res({status: 0, body: String(e)})); q.end(body); });
{ const payload = JSON.stringify({model: 'm', messages: [{role: 'user', content: 'Привет'}]});
  const r = await post(port, px(port, T + '/post-echo'), payload, {origin: 'http://localhost:8080'});
  const j = (() => { try { return JSON.parse(r.body); } catch (e) { return {}; } })();
  ok('POST: the JSON body reaches the target intact (UTF-8)', r.status === 200 && j.echo === payload, r.status + r.body);
  ok('POST: Content-Type is passed, the answer has CORS headers', seen.at(-1).ct === 'application/json' && seen.at(-1).method === 'POST' && r.headers['access-control-allow-origin'] === '*');
  ok('POST: the page cookies are still not sent', (await post(port, px(port, T + '/post-echo'), '{}', {cookie: 'sid=1'})) && seen.at(-1).cookie === undefined);
  const t0 = Date.now(); const times = [];
  const lines = await new Promise(res => { let d = ''; const q = http.request({port, path: px(port, T + '/post-ndjson'), method: 'POST', headers: {'content-type': 'application/json'}}, r => { r.on('data', c => { times.push(Date.now() - t0); d += c; }); r.on('end', () => res(d.trim().split('\n'))); }); q.end('{}'); });
  ok('POST: the answer is streamed line by line (not buffered)', lines.length === 4 && JSON.parse(lines[3]).done === true && times.length >= 3 && times[0] < times.at(-1) - 80, JSON.stringify(times));
  const rr = await post(port, px(port, T + '/post-redir'), '{"a":1}'); ok('POST: a redirect is not followed (the body cannot be repeated), the reason is readable', rr.status === 502 && /redirect/.test(rr.body), rr.status + rr.body);
  const big = await post(port, px(port, T + '/post-echo'), 'x'.repeat(9 << 20)); ok('POST: a body over 8 MB is refused', big.status === 413 || big.status === 0, String(big.status));
  const {port: p6} = await mk({proxyLoopback: true, token: 'tk'});
  ok('POST: the token is required', (await post(p6, px(p6, T + '/post-echo'), '{}')).status === 401 && (await post(p6, px(p6, T + '/post-echo', 'token=tk&'), '{}')).status === 200);
  ok('POST: a foreign Origin is refused', (await post(p6, px(p6, T + '/post-echo', 'token=tk&'), '{}', {origin: 'https://evil.example'})).status === 403);
  const {port: p7} = await mk({}); ok('POST: loopback target refused by default (SSRF guard)', (await post(p7, px(p7, T + '/post-echo'), '{}')).status === 403);
}
// поток: кадры доходят не дожидаясь конца, а закрытие клиента закрывает цель
{ const t0 = Date.now(); const chunks = [];
  await new Promise(res => { const q = http.get({port, path: px(port, T + '/stream')}, r => { r.on('data', c => { chunks.push([Date.now() - t0, c.length]); if (chunks.length >= 3) { q.destroy(); res(); } }); }); });
  ok('an endless stream is passed on as it comes (not buffered)', chunks.length >= 3 && chunks[2][0] < 1500, JSON.stringify(chunks));
  await sleep(300); ok('closing the page connection closes the target connection', upstreamClosed >= 1, String(upstreamClosed));
}
// токен, Origin, hosts, шаблон Settings
{ const {port: p2} = await mk({proxyLoopback: true, token: 'tk'});
  ok('without the token: 401', (await get(p2, px(p2, T + '/text'))).status === 401);
  ok('wrong token: 401', (await get(p2, px(p2, T + '/text', 'token=zz&'))).status === 401);
  ok('right token: 200', (await get(p2, px(p2, T + '/text', 'token=tk&'))).status === 200);
  ok('a foreign Origin is refused even with the token', (await get(p2, px(p2, T + '/text', 'token=tk&'), {origin: 'https://evil.example'})).status === 403);
  const tpl = 'http://127.0.0.1:' + p2 + '/proxy?token=tk&url={url}'; const built = tpl.replace('{url}', encodeURIComponent(T + '/q?a=1&b=2'));
  ok('the Settings template with {url} works with a query inside the target', (await get(p2, new URL(built).pathname + new URL(built).search)).body === 'query kept');
  const {port: p3} = await mk({proxyLoopback: true, hosts: ['127.0.0.1']});
  ok('--hosts lets only listed hosts through', (await get(p3, px(p3, T + '/text'))).status === 200 && (await get(p3, px(p3, 'http://example.org/'))).status === 403);
  const {port: p4} = await mk({proxy: false}); const off = await get(p4, px(p4, T + '/text')); ok('--no-proxy turns the endpoint off', off.status === 200 && /DSP messenger bridge/.test(off.body));
  const {port: p5} = await mk({proxyLoopback: true, proxyPrivate: false}); ok('--proxy-no-private: loopback allowed explicitly, private networks still refused', (await get(p5, px(p5, 'http://192.168.1.10/'))).status === 403);
}
for (const s of servers) try { s.close(); s.closeAllConnections?.(); } catch (e) {}
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
