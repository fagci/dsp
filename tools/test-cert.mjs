// Сертификаты (modules/cert-kernels.js): свой центр и серверные сертификаты — проверка openssl, X509Certificate и настоящим TLS: node tools/test-cert.mjs
import {X509Certificate, createPublicKey} from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadMsgr} from './node/load.mjs';
const M = loadMsgr();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
const servers = [];
const handshake = (cert, key, ca, host, ip) => new Promise(res => {          // → {ok} | {err}
  const srv = https.createServer({cert, key}, (q, r) => r.end('hi')); servers.push(srv);
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    const q = https.get({host: ip || '127.0.0.1', port, ...(/^[\d.]+$/.test(host) ? {} : {servername: host}), ca, path: '/', headers: {host}}, r => { r.resume(); r.on('end', () => res({ok: true})); });
    q.on('error', e => res({err: e.code || e.message}));
  });
});

// --- IP-адреса ---
const hex = b => b && Buffer.from(b).toString('hex');
ok('ip parser: v4 / v6 / :: / embedded v4 / junk', hex(M.cdIp('192.168.0.5')) === 'c0a80005' && hex(M.cdIp('::1')) === '00000000000000000000000000000001' && hex(M.cdIp('fe80::1:2')) === 'fe800000000000000000000000010002'
  && hex(M.cdIp('::ffff:1.2.3.4')) === '00000000000000000000ffff01020304' && hex(M.cdIp('2001:db8::')) === '20010db8000000000000000000000000' && M.cdIp('300.1.1.1') === null && M.cdIp('example.com') === null && M.cdIp('1:2:3') === null);

// --- центр: самоподписанный, CA:TRUE, ограничения ---
const ca = await M.certNewCA({name: 'Test CA'});
const caC = new X509Certificate(ca.pem);
ok('CA: parses, self-signed, CA:TRUE, signs certificates', caC.ca === true && caC.verify(caC.publicKey) && /Test CA/.test(caC.subject) && /DSP workbench/.test(caC.subject));
ok('CA: valid for ~10 years, not before "now" (an hour back for clock skew)', (new Date(caC.validTo) - Date.now()) / 864e5 > 3640 && new Date(caC.validFrom) < new Date());
fs.writeFileSync(path.join(tmp, 'ca.pem'), ca.pem);
const leaf = await M.certNewLeaf(ca, {dns: ['pi.lan', 'localhost'], ips: ['127.0.0.1', '192.168.0.5', '::1']});
const lc = new X509Certificate(leaf.pem);
ok('leaf: signed by the CA, not a CA, names and addresses in SAN', lc.verify(caC.publicKey) && lc.checkIssued(caC) && lc.ca === false && lc.checkHost('pi.lan') === 'pi.lan' && !!lc.checkIP('192.168.0.5') && !!lc.checkIP('127.0.0.1') && !!lc.checkIP('::1') && !lc.checkHost('evil.example'), lc.subjectAltName);
ok('leaf: serverAuth, valid about a year', lc.keyUsage.includes('1.3.6.1.5.5.7.3.1') && (new Date(lc.validTo) - Date.now()) / 864e5 < 366 && (new Date(lc.validTo) - Date.now()) / 864e5 > 360);
ok('leaf: a certificate for nothing is refused', await M.certNewLeaf(ca, {dns: [], ips: []}).then(() => false, e => /at least one name/.test(e.message)));

// --- независимая проверка openssl ---
const ossl = spawnSync('openssl', ['version']).status === 0;
if (ossl) {
  fs.writeFileSync(path.join(tmp, 'leaf.pem'), leaf.pem);
  const v = spawnSync('openssl', ['verify', '-CAfile', path.join(tmp, 'ca.pem'), '-verify_hostname', 'pi.lan', '-verify_ip', '192.168.0.5', path.join(tmp, 'leaf.pem')], {encoding: 'utf8'});
  ok('openssl verify: chain, host name and IP address', v.status === 0 && /OK/.test(v.stdout), v.stdout + v.stderr);
  const t = spawnSync('openssl', ['x509', '-in', path.join(tmp, 'ca.pem'), '-noout', '-text'], {encoding: 'utf8'}).stdout;
  ok('openssl x509: CA basic constraints, key usage and name constraints are well-formed', /CA:TRUE, pathlen:0/.test(t) && /Certificate Sign, CRL Sign/.test(t) && /Name Constraints: critical/.test(t) && /DNS:.lan/.test(t) && /IP:192\.168\.0\.0\/255\.255\.0\.0/.test(t) && /IP:FC00:0:0:0:0:0:0:0\/FE00:0:0:0:0:0:0:0/.test(t), t.split('X509v3 extensions')[1]?.slice(0, 900));
  const tl = spawnSync('openssl', ['x509', '-in', path.join(tmp, 'leaf.pem'), '-noout', '-text'], {encoding: 'utf8'}).stdout;
  ok('openssl x509: leaf extensions', /CA:FALSE/.test(tl) && /Digital Signature/.test(tl) && /TLS Web Server Authentication/.test(tl) && /Authority Key Identifier/.test(tl) && /ecdsa-with-SHA256/.test(tl), tl.split('X509v3 extensions')[1]?.slice(0, 700));
} else console.log('skip: openssl not installed');

// --- настоящее TLS-рукопожатие ---
const t1 = await handshake(leaf.chainPem, leaf.keyPem, ca.pem, 'pi.lan'); ok('TLS: a client that trusts the CA connects (name from SAN)', t1.ok === true, JSON.stringify(t1));
const t2 = await handshake(leaf.chainPem, leaf.keyPem, ca.pem, '192.168.0.5'); ok('TLS: connecting by an IP address from SAN works', t2.ok === true, JSON.stringify(t2));
const t3 = await handshake(leaf.chainPem, leaf.keyPem, ca.pem, 'evil.example'); ok('TLS: a name that is not in the certificate is refused', t3.err === 'ERR_TLS_CERT_ALTNAME_INVALID', JSON.stringify(t3));
const other = await M.certNewCA({name: 'Other CA'}); const t4 = await handshake(leaf.chainPem, leaf.keyPem, other.pem, 'pi.lan'); ok('TLS: a client that trusts another CA refuses it', !!t4.err && !t4.ok, JSON.stringify(t4));

// --- ограничение имён ---
const bad1 = await M.certNewLeaf(ca, {dns: ['example.com']}); const t5 = await handshake(bad1.chainPem, bad1.keyPem, ca.pem, 'example.com');
ok('name constraints: the local CA cannot vouch for a public site (a stolen CA key is not a master key)', !!t5.err && !t5.ok, JSON.stringify(t5));
const bad2 = await M.certNewLeaf(ca, {ips: ['8.8.8.8']}); const t6 = await handshake(bad2.chainPem, bad2.keyPem, ca.pem, '8.8.8.8');
ok('name constraints: nor for a public IP address', !!t6.err && !t6.ok, JSON.stringify(t6));
const free = await M.certNewCA({name: 'Inspection CA', constrain: false}); const fl = await M.certNewLeaf(free, {dns: ['example.com']});
const t7 = await handshake(fl.chainPem, fl.keyPem, free.pem, 'example.com'); ok('an unconstrained CA (for inspecting your own traffic) can — and says so: constrained=false', t7.ok === true && free.constrained === false && ca.constrained === true, JSON.stringify(t7));
ok('the unconstrained CA has no name constraints extension', !/Name Constraints/.test(ossl ? (fs.writeFileSync(path.join(tmp, 'f.pem'), free.pem), spawnSync('openssl', ['x509', '-in', path.join(tmp, 'f.pem'), '-noout', '-text'], {encoding: 'utf8'}).stdout) : ''));

// --- перезагрузка центра из PEM и подпись ещё одного сертификата ---
const reloaded = await M.certLoadCA(ca.pem, ca.keyPem);
const l2 = await M.certNewLeaf(reloaded, {dns: ['second.lan']}); const l2c = new X509Certificate(l2.pem);
ok('a CA reloaded from PEM signs certificates that the original CA verifies (issuer name and key id preserved)', l2c.verify(caC.publicKey) && l2c.checkIssued(caC) && l2c.checkHost('second.lan') === 'second.lan');
const t8 = await handshake(l2.chainPem, l2.keyPem, ca.pem, 'second.lan'); ok('TLS with a certificate from the reloaded CA', t8.ok === true, JSON.stringify(t8));
// --- ключ центра, не извлекаемый из браузера ---
const sealed = await M.certNewCA({name: 'Sealed', extractable: false}); ok('a CA with a non-extractable key has no key PEM but still signs', sealed.keyPem === '' && (await M.certNewLeaf(sealed, {dns: ['x.lan']})).pem.includes('BEGIN CERTIFICATE'));
// --- много сертификатов: длины DER и знаки r/s в подписи ---
let all = true; for (let i = 0; i < 40; i++) { const l = await M.certNewLeaf(ca, {dns: ['h' + i + '.lan'], ips: i % 2 ? ['10.0.0.' + i] : []}); all = all && new X509Certificate(l.pem).verify(caC.publicKey); }
ok('40 certificates in a row all verify (DER lengths, leading zeros and high bits of the signature)', all);
for (const s of servers) s.close();
fs.rmSync(tmp, {recursive: true, force: true});
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
