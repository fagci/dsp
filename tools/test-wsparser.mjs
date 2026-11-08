// Разбор кадров WebSocket в мостах (wsParser, tools/termux/bridge.mjs): нарезка на куски как угодно, маски, длины на границах, фрагменты, пинги
// node tools/test-wsparser.mjs
import crypto from 'node:crypto';
import { wsParser, wsFrame } from './termux/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };

// кадр клиента (с маской, как из браузера); fin / op настраиваются
function cframe(payload, { op = 2, fin = true, mask = true } = {}) {
  const n = payload.length;
  const h = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | n])
    : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 127, 0, 0, 0, 0]), Buffer.from([n >>> 24, n >>> 16, n >>> 8, n].map((x) => x & 255))]);
  if (!mask) return Buffer.concat([h, payload]);
  const mk = crypto.randomBytes(4), m = Buffer.from(payload);
  for (let i = 0; i < n; i++) m[i] ^= mk[i & 3];
  return Buffer.concat([h, mk, m]);
}
function run(stream, split) {
  const bins = [], texts = [], pings = []; let closed = 0;
  const feed = wsParser({ onMsg: (t) => texts.push(t), onBin: (b) => bins.push(Buffer.from(b)), onClose: () => closed++, onPing: (p) => pings.push(Buffer.from(p)) });
  for (let o = 0; o < stream.length;) { const k = Math.max(1, split()); feed(stream.subarray(o, o + k)); o += k; }
  return { bins, texts, pings, closed };
}
const rnd = (n) => crypto.randomBytes(n);

// длины на границах (63/64 — порог 32-битного снятия маски, 125/126, 65535/65536), маска и без неё, куски разного размера
for (const len of [0, 1, 3, 4, 5, 63, 64, 65, 125, 126, 127, 1000, 4095, 4096, 4097, 65535, 65536, 100000, 524288, 1 << 20]) {
  const p = rnd(len);
  for (const mask of [true, false]) {
    for (const [name, split] of [['whole', () => 1 << 30], ['1 byte', () => 1], ['7 bytes', () => 7], ['64 KB', () => 65536], ['random', () => 1 + (crypto.randomInt(0, 90000))]]) {
      if (name === '1 byte' && len > 5000) continue;
      const r = run(cframe(p, { mask }), split);
      if (!(r.bins.length === 1 && r.bins[0].equals(p))) { ok('len ' + len + (mask ? ' masked ' : ' plain ') + name, false, JSON.stringify({ n: r.bins.length, l: r.bins[0] && r.bins[0].length })); }
    }
  }
}
ok('all sizes / masks / chunkings reassemble byte for byte', bad === 0);

// несколько кадров подряд в одном куске и через границу куска; текст и двоичные вперемешку
{
  const parts = [rnd(10), Buffer.from('{"a":1}'), rnd(70000), Buffer.from('текст'), rnd(300)];
  const stream = Buffer.concat(parts.map((p, i) => cframe(p, { op: i === 1 || i === 3 ? 1 : 2 })));
  for (const split of [() => 1 << 30, () => 9, () => 65536, () => 1 + crypto.randomInt(0, 40000)]) {
    const r = run(stream, split);
    ok('mixed text / binary frames', r.bins.length === 3 && r.bins[0].equals(parts[0]) && r.bins[1].equals(parts[2]) && r.bins[2].equals(parts[4]) && r.texts.join('|') === '{"a":1}|текст', JSON.stringify({ b: r.bins.length, t: r.texts }));
  }
}
// фрагментированное сообщение (continuation) и пинг посреди него
{
  const a = rnd(5000), b = rnd(7000), c = rnd(10);
  const stream = Buffer.concat([cframe(a, { op: 2, fin: false }), cframe(Buffer.from('p'), { op: 9 }), cframe(b, { op: 0, fin: false }), cframe(c, { op: 0, fin: true })]);
  const r = run(stream, () => 1 + crypto.randomInt(0, 3000));
  ok('fragmented message is joined, ping answered in the middle', r.bins.length === 1 && r.bins[0].equals(Buffer.concat([a, b, c])) && r.pings.length === 1 && r.pings[0].toString() === 'p');
}
// слишком большой кадр и close
{
  const big = Buffer.concat([Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 0, 0, 0x20, 0, 0]), Buffer.alloc(4)]);
  ok('frame over 1 MiB closes the connection', run(big, () => 1 << 30).closed === 1);
  ok('close frame', run(cframe(Buffer.alloc(0), { op: 8 }), () => 1).closed === 1);
}
// кадр сервера (без маски), каким отвечает wsFrame, читается тем же разбором
{
  const p = rnd(3000), r = run(wsFrame(p, 2), () => 777);
  ok('wsFrame output is parsed back', r.bins.length === 1 && r.bins[0].equals(p));
}
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
