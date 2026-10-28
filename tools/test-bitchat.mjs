// Протокол bitchat (упаковка/разбор): node tools/test-bitchat.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Uint8Array,TextEncoder,TextDecoder,Math});
vm.runInContext(fs.readFileSync(path.join(root,'modules/bitchat-kernels.js'),'utf8'),ctx);
const M=vm.runInContext('({bcEncode,bcDecode,bcSigningBytes,bcEncodeAnnounce,bcDecodeAnnounce,bcPad,bcUnpad,bcOptimalBlockSize,bcHex,bcUnhex,BC_SERVICE_UUID,BC_CHAR_UUID})',ctx);

let bad=0; const eq=(n,a,b)=>{ const sa=JSON.stringify(a instanceof Uint8Array?[...a]:a), sb=JSON.stringify(b instanceof Uint8Array?[...b]:b);
  if(sa!==sb){ bad++; console.log('FAIL',n,sa,'!=',sb); } else console.log('ok  ',n); };

// Публичное сообщение без подписи: кодируем↔разбираем, поля совпадают
{ const senderID=Uint8Array.from([1,2,3,4,5,6,7,8]);
  const payload=new TextEncoder().encode('hello mesh');
  const pkt={type:2,ttl:7,senderID,recipientID:null,timestamp:1700000000123,payload,signature:null};
  const bin=M.bcEncode(pkt);
  eq('header size (14+8, без подписи/получателя)',bin.length,14+8+payload.length);
  const d=M.bcDecode(bin);
  eq('type', d.typeName,'message'); eq('ttl',d.ttl,7); eq('timestamp',d.timestamp,1700000000123);
  eq('senderID',d.senderID,senderID); eq('payload',d.payload,payload); eq('recipientID',d.recipientID,null); eq('signature',d.signature,null);
}

// С подписью (64 байта) и получателем (directed) — флаги и доп. поля на месте
{ const senderID=new Uint8Array(8).fill(9), recipientID=new Uint8Array(8).fill(5), sig=new Uint8Array(64).fill(0xAB);
  const payload=new TextEncoder().encode('hi');
  const pkt={type:1,ttl:5,senderID,recipientID,timestamp:42,payload,signature:sig};
  const bin=M.bcEncode(pkt);
  eq('header+sender+recipient+payload+sig',bin.length,14+8+8+payload.length+64);
  const d=M.bcDecode(bin);
  eq('recipientID',d.recipientID,recipientID); eq('signature',d.signature,sig); eq('type',d.typeName,'announce');
  // toBinaryDataForSigning: тот же пакет, но ttl=0 и без подписи
  const signing=M.bcSigningBytes(pkt), pktZero={...pkt,ttl:0,signature:null};
  eq('signing bytes == encode(ttl=0,без подписи)',signing,M.bcEncode(pktZero));
}

// TLV announce: никнейм + оба публичных ключа — кодируем↔разбираем
{ const noisePub=new Uint8Array(32).fill(1), signPub=new Uint8Array(32).fill(2);
  const a={nickname:'tester',noisePublicKey:noisePub,signingPublicKey:signPub};
  const bin=M.bcEncodeAnnounce(a), d=M.bcDecodeAnnounce(bin);
  eq('announce nickname',d.nickname,'tester'); eq('announce noisePub',d.noisePublicKey,noisePub); eq('announce signPub',d.signingPublicKey,signPub);
}
// TLV неизвестного типа — декодер пропускает и разбирает остальное (вперёд-совместимость)
{ const noisePub=new Uint8Array(32).fill(3), signPub=new Uint8Array(32).fill(4);
  const unknown=Uint8Array.of(0x99,2,0xAA,0xBB);
  const known=M.bcEncodeAnnounce({nickname:'x',noisePublicKey:noisePub,signingPublicKey:signPub});
  const bin=new Uint8Array(known.length+unknown.length); bin.set(known); bin.set(unknown,known.length);
  const d=M.bcDecodeAnnounce(bin);
  eq('announce с неизвестным TLV: никнейм всё равно разобран',d.nickname,'x');
}

// Паддинг PKCS#7-подобный: блок 256 для короткого кадра, round-trip pad→unpad
{ const data=new Uint8Array(20).fill(7);
  eq('optimal block for 20+16 bytes',M.bcOptimalBlockSize(20),256);
  const padded=M.bcPad(data,256);
  eq('padded length',padded.length,256);
  eq('unpad restores original',M.bcUnpad(padded),data);
}

// UUID совпадают со справочником data/bluetooth-uuids.json (tools/bt-uuids.mjs)
{ const uuids=JSON.parse(fs.readFileSync(path.join(root,'data/bluetooth-uuids.json'),'utf8'));
  const has=u=>uuids.rows.some(r=>r.uuid.toLowerCase()===u.toLowerCase());
  eq('service UUID в справочнике',has(M.BC_SERVICE_UUID),true);
  eq('characteristic UUID в справочнике',has(M.BC_CHAR_UUID),true);
}

// hex↔байты
{ const b=Uint8Array.from([0,1,0xab,0xff]);
  eq('bcHex',M.bcHex(b),'0001abff'); eq('bcUnhex',M.bcUnhex('0001ABFF'),b); }

console.log(bad?('\n'+bad+' FAIL'):'\nall ok'); process.exit(bad?1:0);
