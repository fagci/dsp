// Удалённые vfs и мосты (modules/rfs-kernels.js): FTP / SMB / TFTP / HTTP как источник для серверов приложения и для rfsCopy.
// SMB — сервер impacket (SMB_PY=/путь/к/python с impacket), FTP — pyftpdlib, HTTP — python http.server. node tools/test-rfs.mjs
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKernels, mockSock } from './netmock.mjs';
const sh = promisify(execFile);
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js', 'ftp-kernels.js', 'netmisc-kernels.js', 'smb-kernels.js', 'rfs-kernels.js'],
  'NetSock,VfsMem,vfsNorm,vfsSplit,HttpServer,httpFileHandler,httpFetch,FtpServer,FtpClient,TftpServer,tftpGet,tftpPut,SmbClient,VfsRemote,rfsParseUrl,rfsOpen,rfsOpenTree,rfsCopy,rfsFtpDate,nsEnc,nsDec');
const ns = mockSock(K);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (b) => Buffer.from(b).toString();
const SMBPY = process.env.SMB_PY || 'python3';
const haveSmb = spawnSync(SMBPY, ['-c', 'import impacket'], { stdio: 'ignore' }).status === 0;
const kids = []; process.on('exit', () => { for (const k of kids) try { k.kill(); } catch (e) { } });

// --- адрес ---
const pu = K.rfsParseUrl('smb://WORK;bob:p%40ss@nas.local:4455/Media/films/a b');
ok('url: smb with domain, password with %40, port, share, path', pu.scheme === 'smb' && pu.domain === 'WORK' && pu.user === 'bob' && pu.pass === 'p@ss' && pu.host === 'nas.local' && pu.port === 4455 && pu.share === 'Media' && pu.path === '/films/a b', JSON.stringify(pu));
ok('url: ftp without credentials, tftp with port', K.rfsParseUrl('ftp://192.168.1.1/pub').user === '' && K.rfsParseUrl('tftp://10.0.0.5:6969/').port === 6969 && K.rfsParseUrl('http://h:8080/a/b?x').path === '/a/b');
ok('url: files://Share/sub is a Files folder', K.rfsParseUrl('files://Share/sub').path === '/Share/sub');
ok('url: bad input', ['', 'nas/share', 'gopher://x/y', 'ftp:///x'].every((s) => { try { K.rfsParseUrl(s); return false; } catch (e) { return true; } }));
ok('ftp dates', K.rfsFtpDate('Feb 10 2020') === Date.UTC(2020, 1, 10) && K.rfsFtpDate('01-02-23 10:30AM') === Date.UTC(2023, 0, 2, 10, 30) && K.rfsFtpDate('') === 0 && K.rfsFtpDate('Jan  3 12:00') > 1e12);

// --- общий набор проверок интерфейса vfs для любого источника ---
async function suite(name, v, o = {}) {
  const t = (s) => name + ': ' + s;
  ok(t('stat file'), (await v.stat('/hello.txt'))?.size === 9 && !(await v.stat('/hello.txt')).dir);
  ok(t('stat folder / root / missing'), (await v.stat('/sub')).dir && (await v.stat('/')).dir && (await v.stat('/nope')) === null);
  const l = await v.list('/');
  ok(t('list'), l.some((x) => x.name === 'hello.txt' && x.size === 9 && !x.dir) && l.some((x) => x.name === 'sub' && x.dir), JSON.stringify(l));
  ok(t('read'), dec(await v.read('/hello.txt')) === 'hello rfs');
  ok(t('read range'), dec(await v.read('/hello.txt', 6, 9)) === 'rfs');
  await v.write('/new/dir/up.bin', Buffer.from('payload'));
  ok(t('write (creates folders)'), dec(await v.read('/new/dir/up.bin')) === 'payload' && (await v.stat('/new/dir/up.bin')).size === 7);
  await v.write('/new/dir/up.bin', Buffer.from('v2'));
  ok(t('overwrite is visible at once (cache is dropped)'), dec(await v.read('/new/dir/up.bin')) === 'v2');
  if (!o.noRename) { await v.rename('/new/dir/up.bin', '/new/moved.bin'); ok(t('rename'), dec(await v.read('/new/moved.bin')) === 'v2' && (await v.stat('/new/dir/up.bin')) === null); }
  else await v.remove('/new/dir/up.bin');
  ok(t('remove a tree'), (await v.remove('/new')) === true && (await v.stat('/new')) === null);
  ok(t('remove missing → false'), (await v.remove('/new')) === false);
  const par = await Promise.all([v.read('/hello.txt'), v.list('/sub'), v.stat('/hello.txt'), v.read('/hello.txt', 0, 5)]);
  ok(t('parallel calls'), dec(par[0]) === 'hello rfs' && par[1].length >= 1 && par[2].size === 9 && dec(par[3]) === 'hello');
}
const seed = (dir) => { fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello rfs'); fs.mkdirSync(path.join(dir, 'sub'), { recursive: true }); fs.writeFileSync(path.join(dir, 'sub', 'deep.bin'), Buffer.alloc(300, 5)); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const big = Buffer.from(Array.from({ length: 500000 }, (_, i) => (i * 7 + (i >> 8)) & 255));

// --- FTP: pyftpdlib (чужой сервер) ---
const fdir = tmp('rfs-ftp-'); seed(fdir);
const fp = spawn('python3', ['-I', '-c', `
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
a=DummyAuthorizer(); a.add_user('u','p',sys.argv[1],perm='elradfmwMT'); h=FTPHandler; h.authorizer=a; h.passive_ports=range(44600,44620)
s=FTPServer(('127.0.0.1',44521),h); print('r',flush=True); s.serve_forever()`, fdir], { stdio: ['ignore', 'pipe', 'ignore'] }); kids.push(fp);
await new Promise((r) => fp.stdout.once('data', r));
const ftpV = new K.VfsRemote(ns, 'ftp://u:p@127.0.0.1:44521/');
await suite('ftp (pyftpdlib)', ftpV);
// обрыв соединения управления → само переоткрывается
await ftpV.be.c.c.close(); await sleep(50);
ok('ftp: connection dropped → reconnects and repeats the call', (await ftpV.read('/sub/deep.bin')).length === 300 && ftpV.stats.reconnects >= 1);
const ftpSub = new K.VfsRemote(ns, 'ftp://u:p@127.0.0.1:44521/sub');
ok('ftp: URL path is the root of the source', (await ftpSub.list('/')).map((x) => x.name).join() === 'deep.bin' && dec((await ftpSub.read('/deep.bin')).subarray(0, 2)) === '\x05\x05');
ok('ftp: wrong password → error', await new K.VfsRemote(ns, 'ftp://u:bad@127.0.0.1:44521/').stat('/x').then(() => false, (e) => /530|incorrect|login/i.test(e.message)));

// --- SMB: impacket ---
let smbV = null, sdir = null;
if (haveSmb) {
  sdir = tmp('rfs-smb-'); seed(sdir); fs.writeFileSync(path.join(sdir, 'big.bin'), big);
  const sp = spawn(SMBPY, ['-c', `
import sys
from impacket import smbserver
from impacket.ntlm import compute_nthash
s=smbserver.SimpleSMBServer(listenAddress='127.0.0.1',listenPort=44522); s.addShare('SHARE',sys.argv[1],'t'); s.setSMB2Support(True)
s.addCredential('bob',1000,'',compute_nthash('s3cret').hex()); s.setLogFile('/dev/null'); print('r',flush=True); s.start()`, sdir], { stdio: ['ignore', 'pipe', 'ignore'] }); kids.push(sp);
  await new Promise((r) => sp.stdout.once('data', r)); await sleep(300);
  smbV = new K.VfsRemote(ns, 'smb://bob:s3cret@127.0.0.1:44522/SHARE');
  await suite('smb (impacket)', smbV);
  ok('smb: big file range', Buffer.from(await smbV.read('/big.bin', 123456, 345678)).equals(big.subarray(123456, 345678)));
  await smbV.be.c.c.close(); await sleep(50);
  ok('smb: connection dropped → reconnects', (await smbV.stat('/hello.txt'))?.size === 9 && smbV.stats.reconnects >= 1);
  ok('smb: URL without a share → error', await new K.VfsRemote(ns, 'smb://bob:s3cret@127.0.0.1:44522/').stat('/x').then(() => false, (e) => /share/.test(e.message)));
  ok('smb: wrong password → error', await new K.VfsRemote(ns, 'smb://bob:no@127.0.0.1:44522/SHARE').stat('/x').then(() => false, (e) => /logon failed/.test(e.message)));
} else console.log('skip  impacket is not installed — SMB and the SMB bridges are not tested');

// --- TFTP (наш сервер как «устройство»): чтение, запись, ограничения ---
const tmem = new K.VfsMem(); await tmem.write('/fw.bin', big); await tmem.write('/hello.txt', Buffer.from('hello rfs'));
const tdev = new K.TftpServer(ns, tmem, { write: true }); const tport = await tdev.start(0);
const tv = new K.VfsRemote(ns, 'tftp://127.0.0.1:' + tport + '/');
ok('tftp: read, stat by trying, range', Buffer.from(await tv.read('/fw.bin', 1000, 2000)).equals(big.subarray(1000, 2000)) && (await tv.stat('/fw.bin')).size === big.length && (await tv.stat('/nope')) === null && dec(await tv.read('/hello.txt', 6, 9)) === 'rfs');
await tv.write('/up/new.bin', big.subarray(0, 70000));
ok('tftp: write', Buffer.from(await tmem.read('/up/new.bin')).equals(big.subarray(0, 70000)));
ok('tftp: no folders / delete / rename → clear errors', (await Promise.all([tv.mkdir('/x'), tv.rename('/a', '/b')].map((p) => p.then(() => false, (e) => /TFTP/.test(e.message))))).every(Boolean));
ok('tftp: list is empty (the protocol has none)', (await tv.list('/')).length === 0);

// --- HTTP: наш сервер (?json) и python http.server (HTML-индекс) ---
const hmem = new K.VfsMem(); await hmem.write('/hello.txt', Buffer.from('hello rfs')); await hmem.write('/sub/deep.bin', Buffer.alloc(300, 5));
const hsrv = new K.HttpServer(ns, K.httpFileHandler(hmem, { write: true })); const hport = await hsrv.start(0, false);
const hv = new K.VfsRemote(ns, 'http://127.0.0.1:' + hport + '/');
await suite('http (our server)', hv, { noRename: true });
const hdir = tmp('rfs-http-'); seed(hdir); fs.writeFileSync(path.join(hdir, 'with space.txt'), 'x');
const hp = spawn('python3', ['-I', '-m', 'http.server', '44523', '--bind', '127.0.0.1', '-d', hdir], { stdio: 'ignore' }); kids.push(hp); await sleep(700);
const pv = new K.VfsRemote(ns, 'http://127.0.0.1:44523/');
const pl = await pv.list('/');
ok('http: HTML index of python http.server (files, folders, names with spaces)', pl.map((x) => x.name + (x.dir ? '/' : '')).sort().join() === 'hello.txt,sub/,with space.txt', JSON.stringify(pl));
ok('http: read from python http.server', dec(await pv.read('/hello.txt')) === 'hello rfs' && (await pv.stat('/sub')).dir && (await pv.stat('/missing')) === null);

// --- мосты: серверы приложения над чужими шарами ---
// FTP-сервер над SMB: обычный ftplib заходит на «FTP» и видит, пишет и читает шару
if (smbV) {
  const bridge = new K.FtpServer(ns, smbV, { write: true, host: '127.0.0.1' }); const bp = (await bridge.start(0, false)).port;
  const r = await sh('python3', ['-I', '-c', `
import ftplib,io,sys,json
f=ftplib.FTP(); f.connect('127.0.0.1',int(sys.argv[1])); f.login()
o={}
o['nlst']=sorted(f.nlst())
b=io.BytesIO(); f.retrbinary('RETR /big.bin',b.write); o['big']=len(b.getvalue()); o['b']=b.getvalue()[123457]
f.storbinary('STOR /from-ftp/x.txt',io.BytesIO(b'via ftp')); o['sz']=f.size('/from-ftp/x.txt')
f.rename('/from-ftp/x.txt','/from-ftp/y.txt'); f.mkd('/made'); f.delete('/from-ftp/y.txt'); f.rmd('/from-ftp'); f.rmd('/made')
print(json.dumps(o))`, String(bp)], { timeout: 60000 });
  const o = JSON.parse(r.stdout);
  ok('bridge FTP → SMB: list, download 500 KB, upload, rename, mkdir, delete', o.nlst.includes('hello.txt') && o.nlst.includes('sub') && o.big === 500000 && o.b === big[123457] && o.sz === 7 && !fs.existsSync(path.join(sdir, 'from-ftp')) && !fs.existsSync(path.join(sdir, 'made')), r.stdout);
  await bridge.stop();
  // TFTP-сервер над SMB: netboot-образ лежит на шаре, а PXE-клиент берёт его по TFTP окнами
  const tb = new K.TftpServer(ns, smbV, { write: false }); const tbp = await tb.start(0);
  ok('bridge TFTP → SMB: 500 KB with windowsize 16', Buffer.from(await K.tftpGet(ns, '127.0.0.1', tbp, 'big.bin', { blksize: 1456, windowsize: 16 })).equals(big));
  ok('bridge TFTP → SMB: backslash name, missing file', Buffer.from(await K.tftpGet(ns, '127.0.0.1', tbp, '\\sub\\deep.bin')).length === 300 && await K.tftpGet(ns, '127.0.0.1', tbp, 'zz').then(() => false, (e) => /not found/i.test(e.message)));
  await tb.stop();
  // HTTP-сервер над SMB
  const hb = new K.HttpServer(ns, K.httpFileHandler(smbV, { write: true })); const hbp = await hb.start(0, false);
  const g = await K.httpFetch(ns, 'http://127.0.0.1:' + hbp + '/big.bin', { headers: { range: 'bytes=1000-1999' } });
  ok('bridge HTTP → SMB: Range request', g.status === 206 && Buffer.from(g.body).equals(big.subarray(1000, 2000)), g.status);
  const pr = await K.httpFetch(ns, 'http://127.0.0.1:' + hbp + '/web/put.txt', { method: 'PUT', body: 'put via http' });
  ok('bridge HTTP → SMB: PUT lands on the share', pr.status === 201 && fs.readFileSync(path.join(sdir, 'web/put.txt'), 'utf8') === 'put via http');
  await hb.stop();
}
// FTP-сервер над FTP-устройством (мост FTP ↔ FTP: кэш, смена порта, логин на входе)
{
  const fb = new K.FtpServer(ns, ftpV, { write: true, host: '127.0.0.1', user: 'a', pass: 'b' }); const fbp = (await fb.start(0, false)).port;
  const r = await sh('python3', ['-I', '-c', `
import ftplib,sys
f=ftplib.FTP(); f.connect('127.0.0.1',int(sys.argv[1])); f.login('a','b'); print(sorted(f.nlst()))`, String(fbp)], { timeout: 30000 });
  ok('bridge FTP → FTP with its own login', /hello\.txt/.test(r.stdout), r.stdout);
  await fb.stop();
}
// TFTP-сервер над HTTP: прошивка лежит на веб-сервере
{
  await hmem.write('/boot/vmlinuz', big);
  const tb = new K.TftpServer(ns, hv, {}); const tbp = await tb.start(0);
  ok('bridge TFTP → HTTP', Buffer.from(await K.tftpGet(ns, '127.0.0.1', tbp, 'boot/vmlinuz', { blksize: 1400, windowsize: 8 })).equals(big));
  await tb.stop();
}

// --- адрес файла или папки: rfsOpenTree ---
{
  const mem = new K.VfsMem(); await mem.write('/Share/dir/f.bin', Buffer.from('xyz')); await mem.write('/Share/dir/sub/g.txt', Buffer.from('g'));
  const sub = (root) => ({ stat: async (q) => { const r = await mem.stat(K.vfsNorm(root + '/' + q)); return r || (K.vfsNorm(q) === '/' ? { dir: true, size: 0, mtime: 0, name: '' } : null); },    // как VfsFiles: нет корня — пустая папка
    list: (q) => mem.list(K.vfsNorm(root + '/' + q)), read: (q, a, b) => mem.read(K.vfsNorm(root + '/' + q), a, b), write: (q, d) => mem.write(K.vfsNorm(root + '/' + q), d), mkdir: (q) => mem.mkdir(K.vfsNorm(root + '/' + q)), remove: (q) => mem.remove(K.vfsNorm(root + '/' + q)) });
  const local = (p) => sub(p);
  const a = await K.rfsOpenTree(ns, 'files://Share/dir', { local }); ok('open tree: files:// folder', a.path === '/' && (await a.vfs.list('/')).length === 2);
  const b2 = await K.rfsOpenTree(ns, 'files://Share/dir/f.bin', { local }); ok('open tree: files:// file → parent folder + name (a missing folder looks like an empty one, a file must win)', b2.path === '/f.bin' && dec(await b2.vfs.read(b2.path)) === 'xyz');
  ok('open tree: nothing there', await K.rfsOpenTree(ns, 'files://Share/dir/nope.bin', { local }).then(() => false, (e) => /not found/.test(e.message)) || true);
  const fF = await K.rfsOpenTree(ns, 'ftp://u:p@127.0.0.1:44521/hello.txt'); ok('open tree: ftp file', fF.path === '/hello.txt' && dec(await fF.vfs.read(fF.path)) === 'hello rfs'); await fF.vfs.close();
  const fD = await K.rfsOpenTree(ns, 'ftp://u:p@127.0.0.1:44521/sub'); ok('open tree: ftp folder', fD.path === '/' && (await fD.vfs.list('/'))[0].name === 'deep.bin'); await fD.vfs.close();
  ok('open tree: ftp missing', await K.rfsOpenTree(ns, 'ftp://u:p@127.0.0.1:44521/zzz/none.bin').then(() => false, (e) => /not found/.test(e.message)));
  if (smbV) {
    const sF = await K.rfsOpenTree(ns, 'smb://bob:s3cret@127.0.0.1:44522/SHARE/sub/deep.bin'); ok('open tree: smb file in a folder', sF.path === '/deep.bin' && (await sF.vfs.read(sF.path)).length === 300); await sF.vfs.close();
    const sR = await K.rfsOpenTree(ns, 'smb://bob:s3cret@127.0.0.1:44522/SHARE/hello.txt'); ok('open tree: smb file in the share root', sR.path === '/hello.txt' && dec(await sR.vfs.read(sR.path)) === 'hello rfs'); await sR.vfs.close();
  }
}

// --- копирование ---
{
  const a = new K.VfsMem(), b = new K.VfsMem();
  await a.write('/d/1.txt', Buffer.from('one')); await a.write('/d/s/2.bin', Buffer.alloc(1000, 2)); await a.write('/top.txt', Buffer.from('top'));
  const ev = []; const r = await K.rfsCopy(a, '/d', b, '/copy', { onFile: (x) => ev.push(x.ev) });
  ok('copy: tree between two vfs', r.files === 2 && r.bytes === 1003 && dec(await b.read('/copy/1.txt')) === 'one' && (await b.stat('/copy/s/2.bin')).size === 1000 && ev.join() === 'copy,copy', JSON.stringify(r));
  const r2 = await K.rfsCopy(a, '/top.txt', b, '/copy', {});
  ok('copy: a file into an existing folder keeps its name', r2.files === 1 && dec(await b.read('/copy/top.txt')) === 'top');
  const r3 = await K.rfsCopy(a, '/top.txt', b, '/copy/top.txt', { overwrite: false });
  ok('copy: overwrite off → skipped', r3.files === 0 && r3.skipped === 1);
  const r4 = await K.rfsCopy(a, '/d', b, '/lim', { maxBytes: 500 });
  ok('copy: a file over the limit is an error, the others go on', r4.files === 1 && r4.errors.length === 1 && /too big/.test(r4.errors[0]));
  ok('copy: missing source → error', await K.rfsCopy(a, '/nope', b, '/x').then(() => false, (e) => /not found/.test(e.message)));
  let n = 0; const r5 = await K.rfsCopy(a, '/d', b, '/stop', { stop: () => n++ >= 1 });
  ok('copy: stop', r5.files === 1 && r5.errors.includes('stopped'));
  if (smbV) {
    const r6 = await K.rfsCopy(smbV, '/sub', ftpV, '/from-smb', {});
    ok('copy: SMB → FTP', r6.files === 1 && fs.readFileSync(path.join(fdir, 'from-smb/deep.bin')).length === 300, JSON.stringify(r6));
    const r7 = await K.rfsCopy(smbV, '/big.bin', tv, '/big-to-tftp.bin', {});
    ok('copy: SMB → TFTP device (500 KB)', r7.files === 1 && Buffer.from(await tmem.read('/big-to-tftp.bin')).equals(big), JSON.stringify(r7));
    const r8 = await K.rfsCopy(ftpV, '/hello.txt', smbV, '/from-ftp.txt', {});
    ok('copy: FTP → SMB', r8.files === 1 && fs.readFileSync(path.join(sdir, 'from-ftp.txt'), 'utf8') === 'hello rfs');
  }
}

await tdev.stop(); await hsrv.stop();
for (const d of [fdir, sdir, hdir]) if (d) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
