// TLS для моста: свой центр сертификации и серверный сертификат в каталоге (по умолчанию ~/.dsp-bridge), обновляются сами.
// Центр ограничен локальными именами и частными сетями (name constraints): даже утёкший ключ центра не годится для чужих сайтов.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, {X509Certificate} from 'node:crypto';

const dnsPermitted = (name, list) => list.some(p => name === p || (p[0] === '.' ? name.endsWith(p) : name.endsWith('.' + p)));
export const lanAddresses = () => {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!a.internal && !/^fe80:/i.test(a.address)) out.push(a.address.replace(/%.*$/, ''));
  return out;
};

// o: {cert, key} — свои файлы; иначе {tlsDir, tlsNames[]}. ipOk(ip) — разрешён ли адрес центром (частная сеть / loopback)
export async function prepareTls(o, M, ipOk) {
  if (o.cert || o.key) {
    if (!(o.cert && o.key)) throw new Error('--cert and --key go together');
    return {cert: fs.readFileSync(o.cert, 'utf8'), key: fs.readFileSync(o.key, 'utf8'), caPem: '', own: false, dir: ''};
  }
  const dir = o.tlsDir || path.join(os.homedir(), '.dsp-bridge'), f = n => path.join(dir, n);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const extra = (o.tlsNames || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const extraDns = extra.filter(n => !M.cdIp(n)), extraIps = extra.filter(n => M.cdIp(n));
  let ca, created = false, caDns = M.CD_LOCAL_DNS;
  if (fs.existsSync(f('ca.crt')) && fs.existsSync(f('ca.key'))) {
    ca = await M.certLoadCA(fs.readFileSync(f('ca.crt'), 'utf8'), fs.readFileSync(f('ca.key'), 'utf8'));
    try { caDns = JSON.parse(fs.readFileSync(f('ca.json'), 'utf8')).dns; } catch (e) { /* центр без записи — значит, с именами по умолчанию */ }
  } else {
    caDns = [...new Set([...M.CD_LOCAL_DNS, ...extraDns])];
    ca = await M.certNewCA({name: 'DSP bridge CA (' + os.hostname() + ')', constrain: {dns: caDns, nets: M.CD_LOCAL_NETS}});
    fs.writeFileSync(f('ca.crt'), ca.pem); fs.writeFileSync(f('ca.key'), ca.keyPem, {mode: 0o600}); fs.writeFileSync(f('ca.json'), JSON.stringify({dns: caDns})); created = true;
  }
  const caX = new X509Certificate(ca.pem);
  const refused = extraDns.filter(n => !dnsPermitted(n, caDns));
  if (refused.length) throw new Error('the CA in ' + dir + ' does not allow the name(s) ' + refused.join(', ') + ' (it was made for local names only) — delete ca.crt / ca.key / ca.json there to make a new CA that includes them, and trust it again');
  const host = os.hostname().toLowerCase();
  const dns = [...new Set([...(host.includes('.') ? [host] : [host + '.local']), 'localhost', ...extraDns])].filter(n => dnsPermitted(n, caDns));
  const ips = [...new Set(['127.0.0.1', '::1', ...lanAddresses(), ...extraIps])].filter(ip => M.cdIp(ip) && ipOk(ip));
  const want = JSON.stringify({dns: dns.sort(), ips: ips.sort()});
  let leaf = null, regenerated = false;
  try {
    const have = fs.readFileSync(f('leaf.json'), 'utf8'), x = new X509Certificate(fs.readFileSync(f('leaf.crt'), 'utf8'));
    if (have === want && (new Date(x.validTo) - Date.now()) / 864e5 > 30 && x.checkIssued(caX)) leaf = {cert: fs.readFileSync(f('leaf.crt'), 'utf8'), key: fs.readFileSync(f('leaf.key'), 'utf8')};
  } catch (e) { /* нет или не читается — сделаем заново */ }
  if (!leaf) {
    const l = await M.certNewLeaf(ca, {cn: dns[0] || ips[0], dns, ips});
    fs.writeFileSync(f('leaf.crt'), l.chainPem); fs.writeFileSync(f('leaf.key'), l.keyPem, {mode: 0o600}); fs.writeFileSync(f('leaf.json'), want);
    leaf = {cert: l.chainPem, key: l.keyPem}; regenerated = true;
  }
  const fp = crypto.createHash('sha256').update(caX.raw).digest('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:');
  return {...leaf, caPem: ca.pem, caFile: f('ca.crt'), fingerprint: fp, dns, ips, dir, own: true, created, regenerated};
}
