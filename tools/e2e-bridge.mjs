// Мосты в браузере: SMB Client, File Copy и серверы HTTP / FTP / TFTP над чужой шарой (поле source) через мост-имитатор на сокетах Node.
// Нужны Playwright, статика на :8123 (python3 -m http.server 8123) и impacket: SMB_PY=/путь/к/python node tools/e2e-bridge.mjs
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockBridgeWs } from './netmock-ws.mjs';
const sh = promisify(execFile);
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const py = process.env.SMB_PY || 'python3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-smb-')); fs.writeFileSync(path.join(dir, 'a.txt'), 'file a'); fs.mkdirSync(path.join(dir, 'd')); fs.writeFileSync(path.join(dir, 'd', 'b.bin'), Buffer.alloc(5000, 9));
const img = Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 5) & 255)); fs.writeFileSync(path.join(dir, 'boot.img'), img);
const sp = spawn(py, ['-c', `
import sys
from impacket import smbserver
from impacket.ntlm import compute_nthash
s=smbserver.SimpleSMBServer(listenAddress='127.0.0.1',listenPort=44530); s.addShare('PUB',sys.argv[1],'t'); s.setSMB2Support(True)
s.addCredential('bob',1000,'',compute_nthash('pw').hex()); s.setLogFile('/dev/null'); print('r',flush=True); s.start()`, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => sp.stdout.once('data', r)); await wait(300);
const br = await mockBridgeWs(0, { app: true });
const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {});
await pg.waitForFunction(() => typeof addNode === 'function' && typeof MOD !== 'undefined' && MOD.smbcli && MOD.filecopy, null, { timeout: 90000 });
await wait(1500);
const URL = 'ws://127.0.0.1:' + br.port;
await pg.evaluate((u) => {
  clearAll();
  window.__sc = addNode('smbcli', 40, 40, { url: u, host: '127.0.0.1', port: 44530, share: 'PUB', user: 'bob', pass: 'pw', action: 'list', path: '/' });
  window.__fc = addNode('filecopy', 40, 400, { url: u, from: 'smb://bob:pw@127.0.0.1:44530/PUB/d', to: 'files://E2E/copy/', overwrite: true });
  markWiresDirty();
}, URL);
await pg.click('#run'); await wait(1500);
const idle = (id) => pg.waitForFunction((id) => !Graph.map[id].busy, id, { timeout: 30000 });

await pg.evaluate(() => smbcliRun(__sc)); await wait(300); await idle(await pg.evaluate(() => __sc.id));
let r = await pg.evaluate(() => ({ s: __sc.status, ok: __sc.ok, rows: String(__sc.outText).split('\n').map((l) => l.replace(/^d (.*)$/, '$1/').replace(/^- /, '')).join() }));
ok('SMB Client: list', r.ok === 1 && r.rows === 'd/,a.txt,boot.img', JSON.stringify(r));
await pg.evaluate(() => { __sc.p.action = 'download'; __sc.p.path = '/boot.img'; smbcliRun(__sc); }); await wait(300); await idle(await pg.evaluate(() => __sc.id));
r = await pg.evaluate(() => ({ s: __sc.status, n: __sc.outBin && __sc.outBin.d.length, h: __sc.outBin && Array.from(__sc.outBin.d.subarray(0, 8)) }));
ok('SMB Client: download 200 KB to «bin»', r.n === 200000 && r.h.join() === img.subarray(0, 8).join(), JSON.stringify(r));
await pg.evaluate(() => { __sc.p.action = 'upload'; __sc.p.path = '/up/hello.txt'; __sc.p.body = 'sent from the page'; smbcliRun(__sc); }); await wait(300); await idle(await pg.evaluate(() => __sc.id));
ok('SMB Client: upload creates the folder and the file', fs.existsSync(path.join(dir, 'up/hello.txt')) && fs.readFileSync(path.join(dir, 'up/hello.txt'), 'utf8') === 'sent from the page');
await pg.evaluate(() => { __sc.p.pass = 'bad'; __sc.p.action = 'list'; smbcliRun(__sc); }); await wait(300); await idle(await pg.evaluate(() => __sc.id));
ok('SMB Client: wrong password shows a readable status', /logon failed/.test(await pg.evaluate(() => __sc.status)), await pg.evaluate(() => __sc.status));

await pg.evaluate(() => fcopyRun(__fc)); await wait(300); await idle(await pg.evaluate(() => __fc.id));
r = await pg.evaluate(async () => { const v = new VfsFiles('E2E', new Map()); const l = await v.list('/copy'); return { l: l.map((x) => x.name + ':' + x.size).join(), s: __fc.status, ok: __fc.ok, prog: __fc.progress }; });
ok('File Copy: smb://…/PUB/d → files://E2E/copy/ (folder with 1 file)', r.l === 'b.bin:5000' && r.ok === 1 && r.prog === 1, JSON.stringify(r));
await pg.evaluate(() => { __fc.p.from = 'files://E2E/copy/b.bin'; __fc.p.to = 'smb://bob:pw@127.0.0.1:44530/PUB/pushed/'; fcopyRun(__fc); }); await wait(300); await idle(await pg.evaluate(() => __fc.id));
ok('File Copy: one file from Files → a folder on the share', fs.existsSync(path.join(dir, 'pushed/b.bin')) && fs.statSync(path.join(dir, 'pushed/b.bin')).size === 5000, await pg.evaluate(() => __fc.status));
await pg.evaluate(() => { __fc.p.from = 'smb://bob:pw@127.0.0.1:44530/PUB/nothing'; __fc.p.to = 'files://E2E/x/'; fcopyRun(__fc); }); await wait(300); await idle(await pg.evaluate(() => __fc.id));
ok('File Copy: missing source → ok=0 and a clear status', await pg.evaluate(() => __fc.ok === 0 && /not found/.test(__fc.status)), await pg.evaluate(() => __fc.status));

// серверы над шарой
await pg.evaluate((u) => {
  window.__fs = addNode('ftpsrv', 600, 40, { url: u, port: 42121, lan: false, write: true, source: 'smb://bob:pw@127.0.0.1:44530/PUB' });
  window.__hs = addNode('httpsrv', 600, 300, { url: u, port: 48080, lan: false, write: false, source: 'smb://bob:pw@127.0.0.1:44530/PUB' });
  window.__ts = addNode('netlisten', 600, 560, { url: u, mode: 'tftp server', port: 46969, write: false, source: 'smb://bob:pw@127.0.0.1:44530/PUB', window: 32 });
  markWiresDirty();
}, URL);
await wait(500);
await pg.evaluate(() => { ftpsrvStart(__fs); httpsrvStart(__hs); netlistenStart(__ts); });
await pg.waitForFunction(() => __fs.running && __hs.running && __ts.running, null, { timeout: 30000 });
const o = await sh('python3', ['-I', '-c', `
import ftplib,io,json,urllib.request
f=ftplib.FTP(); f.connect('127.0.0.1',42121); f.login()
o={'nlst':sorted(f.nlst())}
bio=io.BytesIO(); f.retrbinary('RETR /boot.img',bio.write); o['ftp']=len(bio.getvalue())
f.storbinary('STOR /via-ftp.txt',io.BytesIO(b'ftp to smb')); o['up']=f.size('/via-ftp.txt')
o['http']=len(urllib.request.urlopen('http://127.0.0.1:48080/boot.img').read())
o['idx']=('a.txt' in urllib.request.urlopen('http://127.0.0.1:48080/').read().decode())
print(json.dumps(o))`], { timeout: 60000 });
const j = JSON.parse(o.stdout);
ok('FTP server over SMB (through the page): list, 200 KB download, upload', j.nlst.includes('boot.img') && j.ftp === 200000 && j.up === 10 && fs.readFileSync(path.join(dir, 'via-ftp.txt'), 'utf8') === 'ftp to smb', o.stdout);
ok('HTTP server over SMB: file and index page', j.http === 200000 && j.idx === true, o.stdout);
const tg = path.join(os.tmpdir(), 'e2e-tftp-got-' + process.pid + '.img');
await sh('curl', ['-s', '--max-time', '15', '--tftp-blksize', '1428', 'tftp://127.0.0.1:46969/boot.img', '-o', tg]).catch(() => { });
ok('TFTP server over SMB: image arrives intact', fs.existsSync(tg) && fs.readFileSync(tg).equals(img));
await wait(600);
const st = await pg.evaluate(() => ({ b: __ts.bridge, st: __ts.srv && __ts.srv.tftp.stats }));
ok('bridge state is shown and TFTP counted the read', /smb:\/\/127\.0\.0\.1\/PUB/.test(st.b) && st.st.reads === 1, JSON.stringify(st));
await pg.evaluate(() => { ftpsrvStop(__fs); httpsrvStop(__hs); netlistenStop(__ts); }); await wait(500);
ok('no page errors', errs.length === 0, errs.join(' | '));

try { fs.rmSync(tg); } catch (e) { }
sp.kill(); br.close(); await b.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
