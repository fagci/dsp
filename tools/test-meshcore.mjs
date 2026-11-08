// Разбор MeshCore: node tools/test-meshcore.mjs
// Кадры собраны вручную по meshcore-dev/meshcore (Packet.cpp, Utils.cpp, AdvertDataHelpers.cpp), не сняты с реальной ноды.
// AES-128-ECB и HMAC-SHA256 проверены отдельно тест-векторами NIST/RFC 4231 при написании; здесь — сборка↔разбор пакета целиком.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const bytesHex=(a,o,n)=>{ let s=''; for(let i=o||0;i<(n==null?a.length:(o||0)+n);i++) s+=(a[i]<16?'0':'')+a[i].toString(16); return s.toUpperCase(); };
const atob=s=>Buffer.from(s,'base64').toString('binary');
const ctx=vm.createContext({BigInt,Map,Math,Uint8Array,DataView,ArrayBuffer,Object,Array,Error,TextDecoder,TextEncoder,parseInt,String,isFinite,bytesHex,atob});
vm.runInContext(fs.readFileSync(path.join(root,'modules/meshcore-kernels.js'),'utf8'),ctx);
const M=vm.runInContext('({mcAesSchedule,mcAesEncryptBlock,mcAesDecryptBlock,mcPskSecret,mcEncryptThenMac,mcDecode,mcSane,mcSha512,mcEd25519Verify,mcAdvertSig,MC_PUBLIC_PSK})',ctx);

let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-4)=>{ if(!(Math.abs(a-b)<=e)){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };

// AES-128 ECB: FIPS-197 Appendix B/C.1 вектор
{ const hex=h=>Uint8Array.from(h.match(/../g).map(x=>parseInt(x,16)));
  const key=hex('000102030405060708090a0b0c0d0e0f'), pt=hex('00112233445566778899aabbccddeeff'), ctExpect='69c4e0d86a7b0430d8cdb78070b4c55a';
  const sch=M.mcAesSchedule(key), ct=M.mcAesEncryptBlock(pt,sch);
  eq('aes-128 encrypt (FIPS-197)',bytesHex(ct).toLowerCase(),ctExpect);
  eq('aes-128 decrypt (FIPS-197)',bytesHex(M.mcAesDecryptBlock(ct,sch)).toLowerCase(),bytesHex(pt).toLowerCase()); }

const u32le=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
const hdr=(ptype,route)=>(ptype<<2)|route;

// ADVERT: заголовок — целиком открытый текст (имя, тип, позиция), подпись не проверяем
{ const pub=new Uint8Array(32).fill(0x11), sig=new Uint8Array(64).fill(0x22), name=[...Buffer.from('Relay-Hill')];
  const flags=0x80|0x10|2; // name + latlon + type=repeater
  const app=[flags,...u32le(1000000),...u32le(2000000),...name]; // lat=1.0, lon=2.0
  const payload=[...pub,...u32le(0x0f424092),...sig,...app];
  const pkt=Uint8Array.from([hdr(4,1),0,...payload]); // ADVERT, route=flood, 0 хопов
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('advert type',r.typeName,'advert'); eq('advert name',r.name,'Relay-Hill'); eq('advert kind',r.advTypeName,'repeater');
  near('advert lat',r.lat,1.0); near('advert lon',r.lon,2.0);
  eq('forged advert (junk signature) -> sigOk false',r.sigOk,false);
  eq('verify:false skips the check',M.mcDecode(pkt,[M.MC_PUBLIC_PSK],{verify:false}).sigOk,undefined);
  eq('direct (0 hops)',r.direct,true); }

// GRP_TXT на предустановленном канале Public — расшифровка ключом по умолчанию
{ const ks=M.mcPskSecret(M.MC_PUBLIC_PSK);
  eq('public channel hash',ks.hash,0x11);
  const text=[...Buffer.from('Alice: hello mesh')];
  const plain=Uint8Array.from([...u32le(1700000000),0,...text]);
  const enc=M.mcEncryptThenMac(ks.secret,plain);
  const pkt=Uint8Array.from([hdr(5,1),0,ks.hash,...enc]); // GRP_TXT, route=flood
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('grp_txt type',r.typeName,'group text'); eq('grp_txt text',r.text,'Alice: hello mesh'); eq('grp_txt timestamp',r.timestamp,1700000000); }

// неизвестный PSK — помечается как encrypted, без расшифровки
{ const ks=M.mcPskSecret(M.MC_PUBLIC_PSK);
  const enc=M.mcEncryptThenMac(ks.secret,Uint8Array.from([...u32le(0),0]));
  const pkt=Uint8Array.from([hdr(5,1),0,ks.hash,...enc]);
  const r=M.mcDecode(pkt,['AAAAAAAAAAAAAAAAAAAAAA==']);
  eq('wrong psk -> encrypted',r.encrypted,true); }

// транспортный маршрут (4 служебных байта transport codes) + direct, 1 хоп в пути, тип TXT_MSG — нужен ключ получателя, не читается
{ const pkt=Uint8Array.from([hdr(2,3),0x34,0x12,0,0,(1<<6)|1,0xaa,1,2,3,4,5,6]);
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('transport route',r.route,'transport direct'); eq('hop count',r.hopCount,1); eq('undecoded without peer key',!!r.undecoded,true); }

// SHA-512 (RFC 6234) и Ed25519 (RFC 8032, тест 1) + сверка с Node crypto на случайных ключах
{ const hex=h=>Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16)), lo=a=>bytesHex(a).toLowerCase();
  eq('sha512("abc")',lo(M.mcSha512(Buffer.from('abc'))),'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  eq('sha512("") (padding at 0 bytes)',lo(M.mcSha512(new Uint8Array(0))),'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e');
  eq('sha512 (2 blocks, 112 bytes)',lo(M.mcSha512(Buffer.from('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))),'8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909');
  const pub1=hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const sig1=hex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  eq('ed25519 RFC 8032 test 1',M.mcEd25519Verify(pub1,new Uint8Array(0),sig1),true);
  eq('ed25519: other message rejected',M.mcEd25519Verify(pub1,Uint8Array.of(1),sig1),false);
  const bad1=Uint8Array.from(sig1); bad1[40]^=1; eq('ed25519: flipped bit rejected',M.mcEd25519Verify(pub1,new Uint8Array(0),bad1),false);
  for(let i=0;i<4;i++){
    const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'), pub=publicKey.export({format:'der',type:'spki'}).subarray(-32);
    const msg=crypto.randomBytes(5+i*40), sig=crypto.sign(null,msg,privateKey);
    eq('ed25519 vs node crypto #'+i,M.mcEd25519Verify(pub,msg,sig),true);
    const m2=Uint8Array.from(msg); m2[0]^=0x80; eq('ed25519 tampered #'+i,M.mcEd25519Verify(pub,m2,sig),false);
  }
  // настоящий ADVERT: подпись над pubkey‖timestamp‖appdata
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'), pub=publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const u32=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
  const ts=u32(1700000123), app=[0x80|0x10|1,...u32(41734145),...u32(-80765081>>>0),...Buffer.from('SarahRose')];
  const sig=crypto.sign(null,Buffer.from([...pub,...ts,...app]),privateKey);
  const pl=[...pub,...ts,...sig,...app], pkt=Uint8Array.from([(4<<2)|1,0,...pl]);
  let r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('signed advert -> sigOk',r.sigOk,true); eq('signed advert name',r.name,'SarahRose'); near('signed advert lat',r.lat,41.734145); near('signed advert lon',r.lon,-80.765081);
  const forged=Uint8Array.from(pkt); forged[forged.length-1]^=1;                         // подделали имя — подпись не сходится
  eq('advert with altered name -> sigOk false',M.mcDecode(forged,[M.MC_PUBLIC_PSK]).sigOk,false); }

// ложные срабатывания CRC: версия ≠ 0, зарезервированный тип, обрезанная группа — отбрасываем
{ eq('version 1 rejected',M.mcDecode(Uint8Array.from([(1<<6)|(4<<2)|1,0,1,2,3]),[M.MC_PUBLIC_PSK]),null);
  eq('reserved type 12 rejected',M.mcDecode(Uint8Array.from([(12<<2)|1,0,1,2,3]),[M.MC_PUBLIC_PSK]),null);
  eq('group text shorter than channel+MAC rejected',M.mcDecode(Uint8Array.from([(5<<2)|1,0,0x11,0xaa]),[M.MC_PUBLIC_PSK]),null);
  eq('hop count -> not direct',M.mcDecode(Uint8Array.from([(2<<2)|1,1,0xaa,1,2,3]),[M.MC_PUBLIC_PSK]).direct,false); }

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
