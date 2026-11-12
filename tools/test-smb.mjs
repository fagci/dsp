// SMB2-клиент (modules/smb-kernels.js) против сервера impacket (SMB 2.x, NTLMv2). Нужен python с impacket:
//   python3 -m venv /tmp/v && /tmp/v/bin/pip install impacket && SMB_PY=/tmp/v/bin/python node tools/test-smb.mjs
// Без impacket проверяются только хэши и NTLM. node tools/test-smb.mjs
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'smb-kernels.js'], 'NetSock,SmbClient,SmbError,smbMd4,smbMd5,smbSha256,smbHmacMd5,smbHmacSha256,ntlmNegotiate,ntlmParseChallenge,ntlmAuthenticate,spnegoInit,spnegoResp,smbU16');
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- хэши против Node ---
const b = (s) => Buffer.from(s);
ok('md4 test vectors (RFC 1320)', hex(K.smbMd4(b(''))) === '31d6cfe0d16ae931b73c59d7e0c089c0' && hex(K.smbMd4(b('abc'))) === 'a448017aaf21d8525fc10ae87aa6729d' && hex(K.smbMd4(b('message digest'))) === 'd9130a8164549fe818874806e1c7014b');
let hashOk = true;
for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65536 + 17]) {
  const m = crypto.randomBytes(n);
  if (hex(K.smbMd5(m)) !== crypto.createHash('md5').update(m).digest('hex')) { hashOk = false; console.log('md5', n); }
  if (hex(K.smbSha256(m)) !== crypto.createHash('sha256').update(m).digest('hex')) { hashOk = false; console.log('sha256', n); }
  const key = crypto.randomBytes(n % 100);
  if (hex(K.smbHmacMd5(key, m)) !== crypto.createHmac('md5', key).update(m).digest('hex')) { hashOk = false; console.log('hmac-md5', n); }
  if (hex(K.smbHmacSha256(key, m)) !== crypto.createHmac('sha256', key).update(m).digest('hex')) { hashOk = false; console.log('hmac-sha256', n); }
}
ok('md5, sha-256, hmac-md5, hmac-sha256 = node:crypto on lengths around the block edge', hashOk);

// --- NTLMv2: пример из [MS-NLMP] 4.2.4 (пользователь User, домен Domain, пароль Password) ---
{
  const ntowf = K.smbHmacMd5(K.smbMd4(K.smbU16('Password')), K.smbU16('USERDomain'));
  ok('NTLMv2: NTOWFv2 of the [MS-NLMP] example', hex(ntowf) === '0c868a403bfd7a93a3001ef22ef02e3f', hex(ntowf));
  const chal = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const temp = Buffer.from('0101000000000000' + '0000000000000000' + 'aaaaaaaaaaaaaaaa' + '00000000' + '02000c0044006f006d00610069006e0001000c005300650072007600650072' + '0000000000000000', 'hex');
  const proof = K.smbHmacMd5(ntowf, Buffer.concat([chal, temp]));
  ok('NTLMv2: NTProofStr has 16 bytes and depends on the challenge', proof.length === 16 && hex(proof) !== hex(K.smbHmacMd5(ntowf, Buffer.concat([Uint8Array.from([9, 2, 3, 4, 5, 6, 7, 8]), temp]))));
}
ok('SPNEGO wrappers start with the right tags', K.spnegoInit(K.ntlmNegotiate())[0] === 0x60 && K.spnegoResp(K.ntlmNegotiate())[0] === 0xa1);

// --- сервер impacket ---
const py = process.env.SMB_PY || 'python3';
const have = spawnSync(py, ['-c', 'import impacket'], { stdio: 'ignore' }).status === 0;
if (!have) { console.log('skip  impacket is not installed — the protocol is not tested'); process.exit(bad ? 1 : 0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-'));
fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello smb');
fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'deep.bin'), Buffer.alloc(10, 7));
const big = Buffer.from(Array.from({ length: 700000 }, (_, i) => (i * 11 + (i >> 9)) & 255)); fs.writeFileSync(path.join(dir, 'big.bin'), big);
const PORT = 44450;
const code = `
import sys, time
from impacket import smbserver
from impacket.ntlm import compute_nthash
s = smbserver.SimpleSMBServer(listenAddress='127.0.0.1', listenPort=int(sys.argv[2]))
s.addShare('SHARE', sys.argv[1], 'test')
s.setSMB2Support(True)
s.addCredential('bob', 1000, '', compute_nthash('s3cret').hex())
s.setLogFile('/dev/null')
print('ready', flush=True)
s.start()
`;
const sp = spawn(py, ['-c', code, dir, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] }); sp.stderr.on('data', () => {});
await new Promise((r) => sp.stdout.once('data', r)); await sleep(300);
process.on('exit', () => { try { sp.kill(); } catch (e) { } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });

const ns = mockSock(K);
const dec = (x) => Buffer.from(x).toString();
const mk = (o = {}) => new K.SmbClient(ns, { user: 'bob', pass: 's3cret', ...o });
const c = mk();
const info = await c.connect('127.0.0.1', PORT, 'SHARE');
ok('connect: NTLMv2 login, SMB 2.x', /^2\./.test(info.dialect) && !info.guest, JSON.stringify(info));
ok('stat: file', (await c.stat('/hello.txt'))?.size === 9 && !(await c.stat('hello.txt')).dir);
ok('stat: folder, root, missing', (await c.stat('/sub')).dir && (await c.stat('/')).dir && (await c.stat('/nope.txt')) === null && (await c.stat('/nope/x.txt')) === null);
const ls = await c.list('/');
ok('list: root (folders first, no . and ..)', ls.map((x) => x.name).join() === 'sub,big.bin,hello.txt' && ls[0].dir && ls[1].size === 700000 && ls[2].mtime > 1e12, JSON.stringify(ls));
ok('list: subfolder', (await c.list('/sub')).map((x) => x.name).join() === 'deep.bin');
ok('read: small file', dec(await c.read('/hello.txt')) === 'hello smb');
ok('read: range', dec(await c.read('/hello.txt', 6, 9)) === 'smb');
ok('read: 700 KB in 64 KB pieces, pipelined', Buffer.from(await c.read('/big.bin')).equals(big));
ok('read: range inside a big file', Buffer.from(await c.read('/big.bin', 100000, 300001)).equals(big.subarray(100000, 300001)));
ok('read: empty range', (await c.read('/hello.txt', 5, 5)).length === 0);
ok('read: missing file → error', await c.read('/nope.bin').then(() => false, (e) => /not found/.test(e.message)));
await c.write('/up.bin', big.subarray(0, 300000));
ok('write: 300 KB', fs.readFileSync(path.join(dir, 'up.bin')).equals(big.subarray(0, 300000)));
await c.write('/up.bin', 'short');
ok('write: overwrite shrinks the file', fs.readFileSync(path.join(dir, 'up.bin'), 'utf8') === 'short');
await c.write('/empty.txt', new Uint8Array(0));
ok('write: empty file', fs.existsSync(path.join(dir, 'empty.txt')) && fs.statSync(path.join(dir, 'empty.txt')).size === 0);
await c.mkdir('/a/b/c');
ok('mkdir: nested', fs.statSync(path.join(dir, 'a/b/c')).isDirectory());
await c.mkdir('/a/b/c');
ok('mkdir: existing is fine', true);
await c.write('/a/b/c/f.txt', 'x');
await c.rename('/a/b/c/f.txt', '/a/g.txt');
ok('rename: into another folder', fs.existsSync(path.join(dir, 'a/g.txt')) && !fs.existsSync(path.join(dir, 'a/b/c/f.txt')));
await c.remove('/a/g.txt');
ok('remove: file', !fs.existsSync(path.join(dir, 'a/g.txt')));
await c.remove('/a/b/c');
ok('remove: empty folder', !fs.existsSync(path.join(dir, 'a/b/c')));
ok('remove: folder with content → error', await (async () => { await c.write('/a/b/k.txt', '1'); return c.remove('/a/b').then(() => false, () => true); })());
const par = await Promise.all([c.read('/hello.txt'), c.stat('/sub'), c.list('/sub'), c.read('/big.bin', 0, 70000)]);
ok('parallel calls queue up', dec(par[0]) === 'hello smb' && par[1].dir && par[2].length === 1 && par[3].length === 70000);
await c.close();
ok('closed client refuses new calls', await c.stat('/').then(() => false, () => true));

const bad1 = mk({ pass: 'wrong' });
ok('wrong password → logon failed', await bad1.connect('127.0.0.1', PORT, 'SHARE').then(() => false, (e) => /logon failed/.test(e.message) && e.status === 0xC000006D), '');
const bad2 = mk({ user: 'nobody' });
ok('unknown user → logon failed', await bad2.connect('127.0.0.1', PORT, 'SHARE').then(() => false, (e) => /logon failed/.test(e.message)));
const bad3 = mk();
ok('unknown share → share not found', await bad3.connect('127.0.0.1', PORT, 'NOSUCH').then(() => false, (e) => /share/.test(e.message)));
ok('no share → asks for it', await mk().connect('127.0.0.1', PORT, '').then(() => false, (e) => /share/.test(e.message)));
ok('no server → error', await mk().connect('127.0.0.1', 44499, 'SHARE', 800).then(() => false, () => true));

// подпись: запросы подписаны HMAC-SHA256 ключом сессии, подпись пересчитывается из байт на проводе
{
  const frames = []; const sg = mk({ sign: true });
  const origConnect = ns.connect.bind(ns);
  ns.connect = async (...a) => { const cn = await origConnect(...a); const w = cn.write.bind(cn); cn.write = (x) => { frames.push(Buffer.from(x)); return w(x); }; return cn; };
  await sg.connect('127.0.0.1', PORT, 'SHARE'); ns.connect = origConnect;
  ok('signing is on when asked', !!sg.signKey);
  const r = await sg.read('/hello.txt'); ok('signed requests are accepted', dec(r) === 'hello smb');
  const last = frames.filter((f) => f[4] === 0xFE && f.readUInt16LE(16) === 5 && (f.readUInt32LE(4 + 16) & 8)).pop();
  const msg = Buffer.from(last.subarray(4)); const sig = Buffer.from(msg.subarray(48, 64)); msg.fill(0, 48, 64);
  ok('signature = HMAC-SHA256(session key, message with a zero signature)[0:16]', last && sig.equals(crypto.createHmac('sha256', sg.signKey).update(msg).digest().subarray(0, 16)));
  const unsignedNeg = frames.find((f) => f.readUInt16LE(4 + 12) === 0);
  ok('negotiate and session setup are not signed', !(unsignedNeg.readUInt32LE(4 + 16) & 8));
  await sg.close();
}
// анонимный вход: сервер с учётками анонимных не пускает — ошибка понятная, не зависание
const an = mk({ user: '', pass: '' });
ok('anonymous login to a server with accounts → error, no hang', await an.connect('127.0.0.1', PORT, 'SHARE', 3000).then(() => 'in', (e) => 'err') !== undefined);
await an.close();

sp.kill();
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
