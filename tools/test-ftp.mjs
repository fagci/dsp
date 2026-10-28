// FTP-сервер и клиент (modules/ftp-kernels.js): против python ftplib, curl и pyftpdlib. node tools/test-ftp.mjs
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKernels, mockSock } from './netmock.mjs';
const sh = promisify(execFile);
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js', 'ftp-kernels.js'], 'NetSock,VfsMem,FtpServer,FtpClient,ftpParseList,ftpLsLine,nsEnc,nsDec');
const ns = mockSock(K);
const dec = (b) => Buffer.from(b).toString();
const py = (code, ...args) => sh('python3', ['-I', '-c', code, ...args], { timeout: 30000 });

// разбор листингов
const pl = K.ftpParseList('drwxr-xr-x 2 u g 4096 Jan  1 12:00 sub dir\r\n-rw-r--r-- 1 u g 12 Feb 10 2020 a b.txt\r\n01-02-23 10:30AM <DIR> Dos\r\n05-06-21 01:00PM 1234 d.txt\r\ntype=file;size=7;modify=20200101000000; m.bin\r\ntype=cdir; .\r\n');
ok('parse LIST (unix, DOS, MLSD)', pl.length === 5 && pl[0].dir && pl[0].name === 'sub dir' && pl[1].size === 12 && pl[2].dir && pl[3].size === 1234 && pl[4].name === 'm.bin' && pl[4].size === 7, JSON.stringify(pl));

// --- наш сервер ---
const vfs = new K.VfsMem();
await vfs.write('/readme.txt', Buffer.from('hello ftp'));
await vfs.write('/pub/data.bin', Uint8Array.from({ length: 200000 }, (_, i) => (i * 3) & 255));
const log = [];
const srv = new K.FtpServer(ns, vfs, { write: true, host: '127.0.0.1', onLog: (r) => log.push(r.ev + ' ' + r.path) });
const { port, dataPort } = await srv.start(0, false);
ok('control and data ports', port > 0 && dataPort > 0 && dataPort !== port);

const script = `
import ftplib,sys,io
f=ftplib.FTP(); f.connect('127.0.0.1',int(sys.argv[1])); f.login()
out={}
out['pwd']=f.pwd()
out['nlst']=sorted(f.nlst())
b=io.BytesIO(); f.retrbinary('RETR /pub/data.bin',b.write); out['len']=len(b.getvalue()); out['b3']=b.getvalue()[3]
out['size']=f.size('readme.txt')
f.cwd('pub'); out['cwd']=f.pwd()
f.storbinary('STOR up.txt',io.BytesIO(b'x'*70000))
out['up']=f.size('up.txt')
f.mkd('newdir'); f.rename('up.txt','newdir/moved.txt'); out['moved']=f.size('newdir/moved.txt')
f.delete('newdir/moved.txt'); f.rmd('newdir')
lines=[]; f.retrlines('LIST',lines.append); out['list']=len(lines)
try: f.retrbinary('RETR /nope',lambda x:0)
except ftplib.error_perm as e: out['err']=str(e)[:3]
f.quit(); print(out)
`;
let o = (await py(script, String(port))).stdout;
const R = eval('(' + o.replace(/True/g, 'true') + ')');
ok('ftplib: login, pwd, nlst, download 200 KB', R.pwd === '/' && R.nlst.join() === 'pub,readme.txt' && R.len === 200000 && R.b3 === 9, o);
ok('ftplib: size, cwd, upload 70 KB, mkd/rename/delete/rmd', R.size === 9 && R.cwd === '/pub' && R.up === 70000 && R.moved === 70000, o);
ok('ftplib: LIST lines, 550 for missing', R.list === 1 && R.err === '550', o);
ok('after the session: files are right', !(await vfs.stat('/pub/up.txt')) && !(await vfs.stat('/pub/newdir')) && (await vfs.stat('/pub/data.bin')).size === 200000);
const cu = await sh('curl', ['-s', '--max-time', '20', 'ftp://127.0.0.1:' + port + '/readme.txt']);
ok('curl download', cu.stdout === 'hello ftp');
await sh('curl', ['-s', '--max-time', '20', '-T', '/etc/hostname', 'ftp://127.0.0.1:' + port + '/h.txt']);
ok('curl upload', (await vfs.stat('/h.txt'))?.size > 0);
const cl = await sh('curl', ['-s', '--max-time', '20', 'ftp://127.0.0.1:' + port + '/pub/']);
ok('curl listing', /data\.bin/.test(cl.stdout) && /200000/.test(cl.stdout), cl.stdout);
ok('server log', log.some((l) => l === 'download /readme.txt') && log.some((l) => l.startsWith('upload ')), log.join());
await srv.stop();

// пароль и только чтение
const s2 = new K.FtpServer(ns, vfs, { user: 'bob', pass: 'pw', write: false, host: '127.0.0.1' });
const p2 = (await s2.start(0, false)).port;
const c0 = new K.FtpClient(ns);
ok('wrong password refused', await c0.connect('127.0.0.1', p2, 'bob', 'bad').then(() => false, (e) => /530/.test(e.message)));
const c1 = new K.FtpClient(ns); await c1.connect('127.0.0.1', p2, 'bob', 'pw');
ok('read-only: upload refused', await c1.put('x.txt', 'x').then(() => false, (e) => /550/.test(e.message)));
ok('read-only: download works', dec(await c1.get('/readme.txt')) === 'hello ftp');
await c1.quit(); await s2.stop();

// --- наш клиент против нашего сервера и против pyftpdlib ---
const s3 = new K.FtpServer(ns, vfs, { write: true, host: '127.0.0.1' }); const p3 = (await s3.start(0, false)).port;
const c = new K.FtpClient(ns); await c.connect('127.0.0.1', p3);
ok('client: pwd, list', (await c.pwd()) === '/' && (await c.list()).some((f) => f.name === 'pub' && f.dir));
const up = Uint8Array.from({ length: 300000 }, (_, i) => i & 255);
await c.put('/pub/c.bin', up);
const back = await c.get('/pub/c.bin');
ok('client: 300 KB upload and back', back.length === 300000 && back[299999] === (299999 & 255));
await c.rename('/pub/c.bin', '/pub/d.bin'); ok('client: rename, size', (await c.size('/pub/d.bin')) === 300000);
await c.del('/pub/d.bin'); ok('client: delete', !(await vfs.stat('/pub/d.bin')));
ok('client: error code', await c.get('/none').then(() => false, (e) => /550/.test(e.message)));
await c.quit(); await s3.stop();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-'));
fs.writeFileSync(path.join(dir, 'a b.txt'), 'real server');
fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'z.bin'), Buffer.alloc(100000, 5));
const ps = spawn('python3', ['-I', '-c', `
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
a=DummyAuthorizer(); a.add_user('u','p',sys.argv[1],perm='elradfmw'); a.add_anonymous(sys.argv[1])
H=FTPHandler; H.authorizer=a; H.passive_ports=range(40100,40120)
s=FTPServer(('127.0.0.1',40099),H); print('ready',flush=True); s.serve_forever()`, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => ps.stdout.once('data', r));
const rc = new K.FtpClient(ns); await rc.connect('127.0.0.1', 40099, 'u', 'p');
const ls = await rc.list();
ok('pyftpdlib: list', ls.some((f) => f.name === 'a b.txt' && f.size === 11) && ls.some((f) => f.name === 'sub' && f.dir), JSON.stringify(ls));
ok('pyftpdlib: download', dec(await rc.get('a b.txt')) === 'real server' && (await rc.get('sub/z.bin')).length === 100000);
await rc.put('new.txt', 'from dsp'); ok('pyftpdlib: upload', fs.readFileSync(path.join(dir, 'new.txt'), 'utf8') === 'from dsp');
await rc.mkd('md'); await rc.rename('new.txt', 'md/n2.txt'); ok('pyftpdlib: mkd, rename', fs.existsSync(path.join(dir, 'md', 'n2.txt')));
await rc.del('md/n2.txt'); await rc.rmd('md'); ok('pyftpdlib: delete, rmd', !fs.existsSync(path.join(dir, 'md')));
await rc.quit(); ps.kill(); fs.rmSync(dir, { recursive: true, force: true });

ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
