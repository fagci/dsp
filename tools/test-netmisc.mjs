// WoL, NTP, syslog, TFTP, Telnet, SMTP (modules/netmisc-kernels.js) против tftpy, curl, aiosmtpd, logging: node tools/test-netmisc.mjs
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadKernels, mockSock } from './netmock.mjs';
const sh = promisify(execFile);
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js', 'netmisc-kernels.js'], 'NetSock,VfsMem,wolPacket,wolBroadcast,ntpRequest,ntpParse,syslogBuild,syslogParse,syslogListen,tftpGet,tftpPut,TftpServer,tftpParse,tftpReq,TelnetCodec,telnetEscape,smtpSend,smtpMessage,nsEnc,nsDec');
const ns = mockSock(K);
const dec = (b) => Buffer.from(b).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (f, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(20); return f(); };
const spawnPy = (code, ...args) => { const p = spawn('python3', ['-I', '-c', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); p.stderr.on('data', () => {}); return p; };
const ready = (p) => new Promise((r) => p.stdout.once('data', r));

// --- Wake-on-LAN ---
const w = K.wolPacket('aa:bb:cc:dd:ee:01');
ok('WoL magic packet', w.length === 102 && w.slice(0, 6).every((x) => x === 255) && w[6] === 0xaa && w[101] === 1 && Buffer.from(w.slice(6, 12)).equals(Buffer.from(w.slice(96, 102))));
ok('WoL: dashes ok, bad MAC refused', K.wolPacket('AA-BB-CC-DD-EE-01').length === 102 && (() => { try { K.wolPacket('zz'); return false; } catch (e) { return true; } })());
ok('broadcast address', K.wolBroadcast('192.168.43.7') === '192.168.43.255' && K.wolBroadcast('') === '255.255.255.255');
const wsock = dgram.createSocket('udp4'); const wgot = []; wsock.on('message', (b) => wgot.push(b));
await new Promise((r) => wsock.bind(0, '127.0.0.1', r));
await ns.udpSend('127.0.0.1', wsock.address().port, K.wolPacket('aa:bb:cc:dd:ee:01'), { broadcast: true });
ok('WoL sent as UDP', await wait(() => wgot.length === 1) && wgot[0].length === 102); wsock.close();

// --- NTP: сервер на Node, часы убегают на +5 с ---
const ntp = dgram.createSocket('udp4');
ntp.on('message', (b, i) => {
  const r = Buffer.alloc(48); r[0] = 0x24; r[1] = 2; r.write('GPS\0', 12);
  const ts = (ms, o) => { const s = ms / 1000 + 2208988800; r.writeUInt32BE(Math.floor(s) >>> 0, o); r.writeUInt32BE(Math.floor((s % 1) * 4294967296) >>> 0, o + 4); };
  ts(Date.now() + 5000, 32); ts(Date.now() + 5000, 40); ntp.send(r, i.port, i.address);
});
await new Promise((r) => ntp.bind(0, '127.0.0.1', r));
const t1 = Date.now(), ans = await ns.udpRequest('127.0.0.1', ntp.address().port, K.ntpRequest(t1), 1000), t4 = Date.now();
const np = K.ntpParse(ans.bytes, t1, t4);
ok('NTP: offset ≈ +5 s, stratum 2', Math.abs(np.offset - 5000) < 100 && np.stratum === 2 && np.delay >= 0 && np.delay < 200, JSON.stringify(np));
ok('NTP: short answer, kiss-of-death', (() => { try { K.ntpParse(new Uint8Array(10), 0, 0); return false; } catch (e) { return true; } })() && (() => { const k = new Uint8Array(48); k[1] = 0; k.set(Buffer.from('RATE'), 12); try { K.ntpParse(k, 0, 0); return false; } catch (e) { return /RATE/.test(e.message); } })());
ntp.close();

// --- syslog ---
const m3 = K.syslogBuild({ facility: 'local3', severity: 'warning', host: 'my host', app: 'dsp', pid: 12, msg: 'disk is full', time: Date.UTC(2024, 0, 5, 3, 4, 5) });
ok('syslog 3164 text', m3 === '<156>Jan  5 03:04:05 my_host dsp[12]: disk is full', m3);
const p3 = K.syslogParse(m3); ok('syslog 3164 roundtrip', p3.facility === 'local3' && p3.severity === 'warning' && p3.host === 'my_host' && p3.app === 'dsp' && p3.pid === '12' && p3.msg === 'disk is full', JSON.stringify(p3));
const m5 = K.syslogBuild({ format: '5424', severity: 'err', host: 'h', app: 'a', msg: 'x y', time: Date.UTC(2024, 0, 5, 3, 4, 5) });
const p5 = K.syslogParse(m5); ok('syslog 5424 roundtrip', p5.format === '5424' && p5.severity === 'err' && p5.host === 'h' && p5.msg === 'x y' && p5.time === '2024-01-05T03:04:05.000Z', m5 + ' ' + JSON.stringify(p5));
ok('syslog without PRI', K.syslogParse('just text').msg === 'just text');
const got = []; const sl = await K.syslogListen(ns, 0, (r) => got.push(r));
const lg = await sh('python3', ['-I', '-c', 'import logging,logging.handlers,sys\nh=logging.handlers.SysLogHandler(address=("127.0.0.1",int(sys.argv[1])))\nl=logging.getLogger("t");l.addHandler(h);l.setLevel(10);l.warning("from python");l.info("second")', String(sl.port)]);
ok('syslog receiver: python logging', await wait(() => got.length === 2) && got[0].msg.includes('from python') && got[0].severity === 'warning' && got[1].severity === 'info', JSON.stringify(got));
const rx = dgram.createSocket('udp4'); const sent = []; rx.on('message', (b) => sent.push(b.toString()));
await new Promise((r) => rx.bind(0, '127.0.0.1', r));
await ns.udpSend('127.0.0.1', rx.address().port, m3);
ok('syslog sender', await wait(() => sent.length === 1) && sent[0] === m3); rx.close(); await sl.close();

// --- TFTP ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tftp-')); fs.writeFileSync(path.join(dir, 'boot.bin'), Buffer.alloc(5000, 0x41)); fs.writeFileSync(path.join(dir, 'exact.bin'), Buffer.alloc(1024, 7)); fs.writeFileSync(path.join(dir, 'empty.bin'), '');
const ts = spawnPy('import tftpy,sys\ns=tftpy.TftpServer(sys.argv[1]);print("r",flush=True);s.listen("127.0.0.1",int(sys.argv[2]))', dir, '40069'); await ready(ts);
ok('tftp client: get (5000 bytes = 10 blocks)', (await K.tftpGet(ns, '127.0.0.1', 40069, 'boot.bin')).length === 5000);
ok('tftp client: get, size multiple of the block (final empty block)', (await K.tftpGet(ns, '127.0.0.1', 40069, 'exact.bin')).length === 1024);
ok('tftp client: get, empty file', (await K.tftpGet(ns, '127.0.0.1', 40069, 'empty.bin')).length === 0);
const big = Buffer.from(Array.from({ length: 70000 }, (_, i) => i * 13 & 255));
fs.writeFileSync(path.join(dir, 'big.bin'), big);
const gb = await K.tftpGet(ns, '127.0.0.1', 40069, 'big.bin', { blksize: 1428 }); ok('tftp client: blksize option', gb.length === 70000 && Buffer.from(gb).equals(big));
ok('tftp client: missing file', await K.tftpGet(ns, '127.0.0.1', 40069, 'nope').then(() => false, (e) => /not found/i.test(e.message)));
await K.tftpPut(ns, '127.0.0.1', 40069, 'up.bin', big); await sleep(200);
ok('tftp client: put 70 KB', fs.existsSync(path.join(dir, 'up.bin')) && fs.readFileSync(path.join(dir, 'up.bin')).equals(big));
await K.tftpPut(ns, '127.0.0.1', 40069, 'up2.txt', 'x'.repeat(1024), { blksize: 512 }); await sleep(200);
ok('tftp client: put, size multiple of the block', fs.readFileSync(path.join(dir, 'up2.txt')).length === 1024);
ts.kill(); fs.rmSync(dir, { recursive: true, force: true });
ok('tftp client: no server → no answer', await K.tftpGet(ns, '127.0.0.1', 40070, 'a', { timeout: 150, retries: 1 }).then(() => false, (e) => /no answer/.test(e.message)));

const vfs = new K.VfsMem(); await vfs.write('/fw.bin', big); await vfs.write('/small.txt', Buffer.from('tiny'));
const up = []; const tsrv = new K.TftpServer(ns, vfs, { write: true, onUpload: (p, b) => up.push([p, b.length]) });
const tport = await tsrv.start(0);
ok('tftp server ↔ our client: get', Buffer.from(await K.tftpGet(ns, '127.0.0.1', tport, 'fw.bin')).equals(big));
ok('tftp server ↔ our client: blksize + tsize', Buffer.from(await K.tftpGet(ns, '127.0.0.1', tport, 'fw.bin', { blksize: 1400 })).equals(big));
ok('tftp server: not found', await K.tftpGet(ns, '127.0.0.1', tport, 'zz').then(() => false, (e) => /not found/i.test(e.message)));
await K.tftpPut(ns, '127.0.0.1', tport, 'sub/new.bin', big.subarray(0, 4096)); await sleep(100);
ok('tftp server ↔ our client: put', (await vfs.stat('/sub/new.bin'))?.size === 4096 && up.length === 1);
const cg = await sh('python3', ['-I', '-c', 'import tftpy,sys\nc=tftpy.TftpClient("127.0.0.1",int(sys.argv[1]));c.download("small.txt",sys.argv[2],timeout=3)\nc.upload("fromtftpy.bin",sys.argv[3],timeout=3)', String(tport), '/tmp/tftpy-got.txt', '/etc/hostname']);
ok('tftp server ↔ tftpy: download and upload', fs.readFileSync('/tmp/tftpy-got.txt', 'utf8') === 'tiny' && (await vfs.stat('/fromtftpy.bin'))?.size > 0);
const cc = await sh('curl', ['-s', '--max-time', '8', 'tftp://127.0.0.1:' + tport + '/small.txt']); ok('tftp server ↔ curl', cc.stdout === 'tiny');
await tsrv.stop();
const ro = new K.TftpServer(ns, vfs, { write: false }); const rp = await ro.start(0);
ok('tftp server read-only refuses WRQ', await K.tftpPut(ns, '127.0.0.1', rp, 'x', 'x').then(() => false, (e) => /read only/.test(e.message))); await ro.stop();

// --- Telnet ---
const tc = new K.TelnetCodec();
let r = tc.feed(Uint8Array.from([255, 253, 24, 255, 251, 1, 255, 251, 31, ...Buffer.from('login: '), 255, 250, 31, 0, 80, 0, 24, 255, 240, 255, 255]));
ok('telnet codec: DO → WONT, WILL echo → DO, other WILL → DONT, text and IAC IAC kept', dec(r.text) === 'login: \xff'.replace('\xff', 'ÿ') || Buffer.from(r.text).equals(Buffer.concat([Buffer.from('login: '), Buffer.from([255])])), Buffer.from(r.text).toString('hex'));
ok('telnet codec: replies', Buffer.from(r.reply).equals(Buffer.from([255, 252, 24, 255, 253, 1, 255, 254, 31])), Buffer.from(r.reply).toString('hex'));
const half = new K.TelnetCodec(); const a = half.feed(Uint8Array.from([65, 255])), b = half.feed(Uint8Array.from([253, 3, 66]));
ok('telnet codec: command split across chunks', dec(a.text) === 'A' && dec(b.text) === 'B' && Buffer.from(b.reply).equals(Buffer.from([255, 252, 3])));
ok('telnet escape', Buffer.from(K.telnetEscape(Uint8Array.from([1, 255, 2]))).equals(Buffer.from([1, 255, 255, 2])));
const tn = net.createServer((s) => { s.write(Buffer.from([255, 253, 24, ...Buffer.from('Welcome\r\nlogin: ')])); s.on('data', (d) => { if (d.toString().includes('\n') && !d.includes(255)) s.write('hello ' + d.toString()); }); });
await new Promise((r2) => tn.listen(0, '127.0.0.1', r2));
const tcn = await ns.connect('127.0.0.1', tn.address().port); const codec = new K.TelnetCodec(); let txt = '';
const first = await tcn.readAny(1000); const fr = codec.feed(first); txt += dec(fr.text); if (fr.reply.length) await tcn.write(fr.reply);
await tcn.write('bob\r\n'); const second = codec.feed(await tcn.readAny(1000)); txt += dec(second.text);
ok('telnet session through the app', txt.includes('Welcome') && txt.includes('hello bob'), txt); await tcn.close(); tn.close();
const cu = await sh('curl', ['-s', '--max-time', '5', '-m', '5', 'telnet://127.0.0.1:' + 1]).catch(() => null); // только проверка, что curl есть

// --- SMTP ---
const mails = path.join(os.tmpdir(), 'mails-' + process.pid + '.json');
const sp = spawnPy(`import asyncio,json,sys
from aiosmtpd.controller import Controller
class H:
    async def handle_DATA(self,server,session,envelope):
        open(sys.argv[2],'a').write(json.dumps({'from':envelope.mail_from,'to':envelope.rcpt_tos,'data':envelope.content.decode('utf8','replace')})+'\\n'); return '250 OK queued as 1'
c=Controller(H(),hostname='127.0.0.1',port=int(sys.argv[1]));c.start();print('r',flush=True)
import time
time.sleep(60)`, '18025', mails);
await ready(sp);
const res = await K.smtpSend(ns, { host: '127.0.0.1', port: 18025, from: 'dsp@example.org', to: 'a@x.org, b@y.org', subject: 'Report', body: 'Line 1\n.dot line\nпривет' });
const mm = JSON.parse(fs.readFileSync(mails, 'utf8').trim().split('\n')[0]);
ok('smtp send: envelope', mm.from === 'dsp@example.org' && mm.to.join() === 'a@x.org,b@y.org' && /queued/.test(res), JSON.stringify(mm).slice(0, 200));
const body64 = mm.data.split(/\r?\n\r?\n/).slice(1).join('').replace(/\s/g, '');
ok('smtp send: headers and the body survive (utf-8, a line with a dot)', /Subject: Report/.test(mm.data) && Buffer.from(body64, 'base64').toString() === 'Line 1\n.dot line\nпривет', mm.data);
ok('smtp: refused recipient', await K.smtpSend(ns, { host: '127.0.0.1', port: 1, from: 'a@b', to: 'c@d', subject: 's', body: 'b', timeout: 500 }).then(() => false, () => true));
sp.kill(); fs.rmSync(mails, { force: true });
// AUTH PLAIN на простом сервере Node
const auths = [];
const fake = net.createServer((s) => {
  s.write('220 fake\r\n'); let data = false, buf = '';
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2);
    if (data) { if (l === '.') { data = false; s.write('250 ok\r\n'); } continue; }
    if (/^EHLO/.test(l)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n'); else if (/^AUTH PLAIN/.test(l)) { auths.push(Buffer.from(l.slice(11), 'base64').toString('latin1')); s.write('235 ok\r\n'); }
    else if (/^(MAIL|RCPT)/.test(l)) s.write('250 ok\r\n'); else if (l === 'DATA') { data = true; s.write('354 go\r\n'); } else if (l === 'QUIT') { s.end('221 bye\r\n'); } } });
});
await new Promise((r2) => fake.listen(0, '127.0.0.1', r2));
await K.smtpSend(ns, { host: '127.0.0.1', port: fake.address().port, from: 'a@b', to: 'c@d', subject: 's', body: 'b', user: 'u', pass: 'p' });
ok('smtp AUTH PLAIN', auths[0] === '\0u\0p', JSON.stringify(auths)); fake.close();

ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
