// DNS: node tools/test-dnsq.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Uint8Array,Error});
vm.runInContext(fs.readFileSync(new URL('../modules/dnsq-kernels.js',import.meta.url),'utf8')+';this.K={dnsQuery,dnsParse,dnsRecs,dnsReverse};',ctx);
const K=ctx.K, hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const q=K.dnsQuery({name:'example.com',type:'A',id:0x1234});
ok('A query bytes',hex(q)==='123401000001000000000000076578616d706c6503636f6d0000010001',hex(q));
ok('MX / TXT / AAAA type codes',K.dnsQuery({name:'a.b',type:'MX',id:1}).slice(-4)[1]===15 && K.dnsQuery({name:'a.b',type:'txt',id:1})[K.dnsQuery({name:'a.b',type:'txt',id:1}).length-3]===16 && K.dnsQuery({name:'a.b',type:'AAAA',id:1}).slice(-3)[0]===28);
ok('reverse names',K.dnsReverse('1.2.3.4')==='4.3.2.1.in-addr.arpa' && K.dnsReverse('2001:db8::1').startsWith('1.0.0.0.') && K.dnsReverse('2001:db8::1').endsWith('8.b.d.0.1.0.0.2.ip6.arpa'));
ok('PTR of an address is reversed automatically',K.dnsParse(Uint8Array.from([...K.dnsQuery({name:'8.8.4.4',type:'PTR',id:2})])).questions[0].name==='4.4.8.8.in-addr.arpa');
ok('EDNS adds an OPT record',K.dnsQuery({name:'a.b',type:'A',id:1,edns:1232}).length===K.dnsQuery({name:'a.b',type:'A',id:1}).length+11 && K.dnsParse(K.dnsQuery({name:'a.b',type:'A',id:1,edns:1232})).ar===1);
ok('label over 63 bytes is refused',(()=>{ try{ K.dnsQuery({name:'a'.repeat(64)+'.com'}); return false; }catch(e){ return true; } })());
// ответ с указателями сжатия: example.com A 93.184.216.34 ttl 300, MX 10 mail.example.com
const resp=Uint8Array.from([0x12,0x34,0x81,0x80,0,1,0,2,0,0,0,0, 7,...Buffer.from('example'),3,...Buffer.from('com'),0,0,15,0,1,
  0xC0,12,0,1,0,1,0,0,1,0x2C,0,4,93,184,216,34,
  0xC0,12,0,15,0,1,0,0,0x0E,0x10,0,9,0,10,4,...Buffer.from('mail'),0xC0,12]);
const r=K.dnsParse(resp);
ok('header flags',r.qr && r.rd && r.ra && !r.aa && r.rcodeName==='NOERROR' && r.an===2,JSON.stringify(r).slice(0,100));
ok('A answer through a compression pointer',r.answers[0].name==='example.com' && r.answers[0].type==='A' && r.answers[0].data==='93.184.216.34' && r.answers[0].ttl===300,JSON.stringify(r.answers[0]));
ok('MX answer with a name that ends in a pointer',r.answers[1].data.pref===10 && r.answers[1].data.host==='mail.example.com',JSON.stringify(r.answers[1]));
const rows=K.dnsRecs(r,'8.8.8.8'); ok('rec rows',rows.length===2 && rows[1].data==='pref=10 host=mail.example.com' && rows[0].server==='8.8.8.8' && rows[0].q==='example.com');
const nx=K.dnsParse(Uint8Array.from([0,1,0x81,0x83,0,1,0,0,0,0,0,0,1,97,0,0,1,0,1])); ok('NXDOMAIN',nx.rcodeName==='NXDOMAIN' && K.dnsRecs(nx,'x')[0].rcode==='NXDOMAIN');
const txt=K.dnsParse(Uint8Array.from([0,1,0x81,0x80,0,1,0,1,0,0,0,0,1,97,0,0,16,0,1, 0xC0,12,0,16,0,1,0,0,0,60,0,9,4,...Buffer.from('v=sp'),3,...Buffer.from('f1 ')])); ok('TXT strings are joined',txt.answers[0].data==='v=spf1 ',JSON.stringify(txt.answers[0]));
const aaaa=K.dnsParse(Uint8Array.from([0,1,0x81,0x80,0,1,0,1,0,0,0,0,1,97,0,0,28,0,1, 0xC0,12,0,28,0,1,0,0,0,60,0,16,0x20,1,0x0d,0xb8,0,0,0,0,0,0,0,0,0,0,0,1])); ok('AAAA is compressed',aaaa.answers[0].data==='2001:db8::1',aaaa.answers[0].data);
ok('truncated and garbage input do not throw',K.dnsParse(resp.slice(0,30)).error!==undefined && K.dnsParse([1,2,3]).error==='short packet' && K.dnsParse(Uint8Array.from([0,1,0x81,0x80,0,1,0,0,0,0,0,0,0xC0,12,0,0,1,0,1])).error!==undefined);
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
