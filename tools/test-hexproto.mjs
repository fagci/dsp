// HEX Structure: библиотека сетевых протоколов (modules/hex-proto.js, httpdis-kernels.js): node tools/test-hexproto.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ Math, Uint8Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, Array, Map, Set, Error, String, Number, BigInt, Object, Date, JSON, isNaN, parseInt, atob, btoa, decodeURIComponent, escape, encodeURIComponent });
for (const f of ['httpdis-kernels.js', 'hex-kernels.js', 'hex-formats.js', 'hex-proto.js']) vm.runInContext(fs.readFileSync(path.join(root, 'modules', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.H={hexParse,hexBuild,hexFromHex,hexToHex,hexToRec,hexSchemaCheck,HEX_LIB,hxTryParse,hxRec}', ctx);
const H = ctx.H;
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const hx = (s) => H.hexFromHex(s.replace(/\s/g, ''));
const parse = (sch, s) => H.hexParse(sch, typeof s === 'string' ? hx(s) : s);
const flat = (r) => H.hexToRec(r, true);
const val = (r, k) => r.vals[k];
const text = (s) => new TextEncoder().encode(s);

// все схемы проходят проверку
const errs = [];
for (const [k, v] of Object.entries(H.HEX_LIB)) { const e = H.hexSchemaCheck(v, H.HEX_LIB, k); if (e && e.length) errs.push(k + ': ' + e.join('; ')); }
ok('every schema is valid', !errs.length, errs.slice(0, 4).join(' | '));

// DNS: запрос example.com A и ответ со сжатием имени
let r = parse('dns', '1234 0100 0001 0000 0000 0000 07 6578616d706c65 03 636f6d 00 0001 0001');
ok('dns query', val(r, 'id') === 0x1234 && val(r, 'qd[0].name') === 'example.com' && val(r, 'qd[0].qtype') === 1 && r.ok, JSON.stringify(r.vals).slice(0, 200));
r = parse('dns', '1234 8180 0001 0001 0000 0000 07 6578616d706c65 03 636f6d 00 0001 0001 c00c 0001 0001 0000012c 0004 5db8d822');
ok('dns answer: pointer + A record', val(r, 'an[0].name') === 'example.com' && val(r, 'an[0].rdata.addr') === '93.184.216.34' && val(r, 'an[0].ttl') === 300 && val(r, 'rcode') === 0, JSON.stringify(r.vals).slice(0, 300));
const b = H.hexBuild('dns', { id: 0xbeef, rd: 1, qdcount: 1, 'qd[0].name': 'a.b.c', 'qd[0].qtype': 28, 'qd[0].qclass': 1 });
ok('dns build', H.hexToHex(b.bytes).endsWith('0161016201630000' + '1c0001') , H.hexToHex(b.bytes));

// DHCP discover
let dh = '01 01 06 00 3903f326 0000 8000 00000000 00000000 00000000 00000000 ' + 'aabbccddeeff' + '00'.repeat(10) + '00'.repeat(64) + '00'.repeat(128) + '63825363 350101 ff';
r = parse('dhcp', dh);
ok('dhcp discover', val(r, 'xid') === 0x3903f326 && val(r, 'magic') === 0x63825363 && val(r, 'options[0].code') === 53 && val(r, 'options[0].data.type') === 1, JSON.stringify(r.vals).slice(-200));

// NTP клиент
r = parse('ntp', '1b' + '00'.repeat(47));
ok('ntp client', val(r, 'vn') === 3 && val(r, 'mode') === 3 && r.ok);

// TFTP RRQ
r = parse('tftp', '0001' + Buffer.from('test.txt').toString('hex') + '00' + Buffer.from('octet').toString('hex') + '00');
ok('tftp rrq', val(r, 'filename') === 'test.txt' && val(r, 'mode') === 'octet', JSON.stringify(r.vals));
r = H.hexBuild('tftp', { opcode: 1, filename: 'a.bin', mode: 'octet' });
ok('tftp build', H.hexToHex(r.bytes) === '0001' + '612e62696e' + '00' + '6f6374657400', H.hexToHex(r.bytes));

// MQTT
r = parse('mqtt', '10 0c 0004 4d515454 04 02 003c 0000');
ok('mqtt connect', val(r, 'type') === 1 && val(r, 'remlen') === 12 && val(r, 'payload.name') === 'MQTT' && val(r, 'payload.keepalive') === 60, JSON.stringify(r.vals));
r = parse('mqtt', '30 07 0003 612f62 6869');
ok('mqtt publish qos0', val(r, 'payload.topic') === 'a/b' && val(r, 'payload.message') !== undefined, JSON.stringify(r.vals));
r = parse('mqtt', '32 09 0003 612f62 0001 6869');
ok('mqtt publish qos1 has packet id', val(r, 'payload.pid') === 1 && val(r, 'payload.topic') === 'a/b', JSON.stringify(r.vals));
r = parse('mqtt', '30 80 01 ' + '00'.repeat(128));
ok('mqtt varint 2 bytes (128)', val(r, 'remlen') === 128, String(val(r, 'remlen')));
r = H.hexBuild('mqtt', { type: 12, flags: 0, remlen: 321, payload: '' });
ok('varint build 321 = c1 02', H.hexToHex(r.bytes).startsWith('c0c102'), H.hexToHex(r.bytes));

// Modbus TCP
r = parse('modbus', '0001 0000 0006 01 03 0000 000a');
ok('modbus read request', val(r, 'func') === 3 && val(r, 'data.addr') === 0 && val(r, 'data.qty') === 10, JSON.stringify(r.vals));
r = parse('modbus', '0001 0000 0007 01 03 04 0001 0002');
ok('modbus read response', val(r, 'data.bytes') === 4 && String(val(r, 'data.values')).replace(/\s/g, '') === '00010002', JSON.stringify(r.vals));
r = parse('modbus', '0001 0000 0003 01 83 02');
ok('modbus exception', val(r, 'data.code') === 2);

// WebSocket / HTTP2 / TLS / LLDP / VLAN / VXLAN / GRE / WoL / CAN / CoAP
r = parse('websocket', '81 05 68656c6c6f');
ok('websocket text', val(r, 'fin') === 1 && val(r, 'opcode') === 1 && val(r, 'plen') === 5, JSON.stringify(r.vals));
r = parse('websocket', '82 7e 0100 ' + '00'.repeat(256));
ok('websocket 16-bit length', val(r, 'plen16') === 256);
r = parse('http2-frame', '000004 08 00 00000000 0000ffff');
ok('http2 window_update', val(r, 'len') === 4 && val(r, 'type') === 8 && val(r, 'sid') === 0);
r = parse('tls-record', '15 0303 0002 02 28');
ok('tls alert', val(r, 'type') === 21 && val(r, 'fragment.level') === 2 && val(r, 'fragment.desc') === 40, JSON.stringify(r.vals));
const ch = '1303' + '' ; // не используется
const body = '0303' + '11'.repeat(32) + '00' + '0002' + '1301' + '01' + '00' + '0014' + '0000' + '0010' + '000e' + '00' + '000b' + Buffer.from('example.com').toString('hex');
r = parse('tls-record', '16 0301 0043 01 00003f ' + body);
ok('tls client hello: SNI', val(r, 'fragment.body.version') === 0x303 && val(r, 'fragment.body.exts[0].data.host') === 'example.com', JSON.stringify(r.vals).slice(-260));
r = parse('lldp', '0207 04 aabbccddeeff 0405 07 6574683 0 0602 0078 0000'.replace('6574683 0', '65746830'));
ok('lldp tlvs', val(r, 'tlvs[0].type') === 1 && val(r, 'tlvs[1].value.id') !== undefined && val(r, 'tlvs[2].value.ttl') === 120, JSON.stringify(r.vals).slice(0, 300));
r = parse('vlan', '6064 0800 45');
ok('vlan tag', val(r, 'pcp') === 3 && val(r, 'vid') === 100 && val(r, 'type') === 0x800, JSON.stringify(r.vals));
r = parse('vxlan', '08 000000 000064 00');
ok('vxlan vni', val(r, 'vni') === 100);
r = parse('gre', '8000 0800 0000 0000');
ok('gre with checksum', val(r, 'ck') === 1 && val(r, 'proto') === 0x800 && val(r, 'csum') === 0, JSON.stringify(r.vals));
r = parse('gre', '2000 0800 0000002a');
ok('gre with key', val(r, 'ky') === 1 && val(r, 'key') === 42 && val(r, 'ck') === 0, JSON.stringify(r.vals));
r = parse('wol', 'ff'.repeat(6) + 'aabbccddeeff'.repeat(16));
ok('wol', val(r, 'mac') === 'aa:bb:cc:dd:ee:ff', JSON.stringify(r.vals).slice(0, 120));
r = parse('can', '23010000 03 000000 aabbcc0000000000');
ok('can frame (little-endian id)', val(r, 'id') === 0x123 && val(r, 'dlc') === 3, JSON.stringify(r.vals));
r = parse('coap', '42 01 1234 aabb ff');
ok('coap con get with token', val(r, 'type') === 0 && val(r, 'tkl') === 2 && val(r, 'cdetail') === 1 && val(r, 'mid') === 0x1234, JSON.stringify(r.vals));
r = parse('rip', '02 02 0000 0002 0000 0a000000 ff000000 00000000 00000001');
ok('rip entry', val(r, 'entries[0].ip') === '10.0.0.0' && val(r, 'entries[0].metric') === 1, JSON.stringify(r.vals));
r = parse('radius', '01 07 0019 ' + '11'.repeat(16) + '01 06 74657374');
ok('radius user-name', val(r, 'code') === 1 && val(r, 'attrs[0].type') === 1, JSON.stringify(r.vals).slice(0, 200));
r = parse('bgp', 'ff'.repeat(16) + '0013 04');
ok('bgp keepalive', val(r, 'type') === 4);
r = parse('igmp', '16 00 09f4 e00000fb');
ok('igmp v2 report', val(r, 'type') === 0x16 && val(r, 'group') === '224.0.0.251');

// HTTP через поле http: разбор и сборка
const post = text('POST /api/login?x=1 HTTP/1.1\r\nHost: a.b\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n{"u":"a","p":[1]}');
r = parse('http', post);
ok('http parse: method / path / host / json', val(r, 'http.method') === 'POST' && val(r, 'http.path') === '/api/login' && val(r, 'http.h.host') === 'a.b' && val(r, 'http.json.u') === 'a' && val(r, 'http.q.x') === '1', JSON.stringify(r.vals).slice(0, 300));
r = parse('http', text('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'));
ok('http response', val(r, 'http.status') === 404 && val(r, 'http.reason') === 'Not Found');
r = parse('sip', text('INVITE sip:bob@x SIP/2.0\r\nVia: SIP/2.0/UDP a\r\n\r\n'));
ok('sip invite', val(r, 'sip.method') === 'INVITE' && val(r, 'sip.h.via') !== undefined, JSON.stringify(r.vals));
r = H.hexBuild('http', { 'http.method': 'GET', 'http.path': '/x', 'http.h.Host': 'h' });
ok('http build from fields', new TextDecoder().decode(r.bytes) === 'GET /x HTTP/1.1\r\nHost: h\r\n\r\n', JSON.stringify(new TextDecoder().decode(r.bytes)));
r = parse('smtp', text('EHLO x\r\nMAIL FROM:<a@b>\r\n'));
ok('smtp lines', val(r, 'lines[0].v') === 'EHLO x' && val(r, 'lines[1].v') === 'MAIL FROM:<a@b>', JSON.stringify(r.vals));

// стыковка слоёв: eth → ipv4 → udp → dns; eth → ipv4 → tcp → http
const udpDns = '1234 0100 0001 0000 0000 0000 07 6578616d706c65 03 636f6d 00 0001 0001';
const dnsLen = hx(udpDns).length, udpLen = 8 + dnsLen, ipLen = 20 + udpLen;
const frame = 'ffffffffffff 001122334455 0800 45 00 ' + ipLen.toString(16).padStart(4, '0') + ' 0000 0000 40 11 0000 c0a80001 08080808 ' + 'c350 0035 ' + udpLen.toString(16).padStart(4, '0') + ' 0000 ' + udpDns;
r = parse('eth', frame);
ok('eth → ipv4 → udp → dns', val(r, 'payload.payload.data.qd[0].name') === 'example.com', Object.keys(r.vals).filter((k) => /name|data/.test(k)).join(','));
process.exit(bad ? 1 : 0);
