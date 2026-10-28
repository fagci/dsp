// Tunnel: BLE GATT ↔ Network (ядро): node tools/test-tunnel.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({String,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/tunnel-kernels.js'),'utf8'),ctx);
const M=vm.runInContext('({tnInit,tnStep})',ctx);

let bad=0; const eq=(n,a,b)=>{ const sa=JSON.stringify(a), sb=JSON.stringify(b);
  if(sa!==sb){ bad++; console.log('FAIL',n,sa,'!=',sb); } else console.log('ok  ',n); };

const p={addr:'AA:BB:CC:DD:EE:FF', svc:'180d', chr:'2a37', mode:'tcp', resp:false, closeOnDrop:true};

// Без клиента: GATT notify не улетает (некуда), а до события open conn ещё null
{ const s=M.tnInit();
  let r=M.tnStep(s,[{src:'gatt',ev:'notify',svc:'180d',chr:'2a37',hex:'ff'}],[],p);
  eq('без клиента: netCmd нет',r.netCmd,null); eq('conn ещё не известен',r.conn,null);
}

// TCP-клиент подключился (accept conn=7) → GATT notify летит с ЕГО conn, а не 1
{ const s=M.tnInit();
  M.tnStep(s,[],[{src:'net',ev:'accept',conn:7}],p);
  const r=M.tnStep(s,[{src:'gatt',ev:'notify',svc:'180d',chr:'2a37',hex:'deadbeef'}],[],p);
  eq('notify → tcp.send на реальный conn',r.netCmd,[{cmd:'tcp.send',conn:7,hex:'deadbeef'}]);
}

// Данные из сети (тот же conn) → gatt.write на нужный адрес/характеристику
{ const s=M.tnInit();
  M.tnStep(s,[],[{src:'net',ev:'open',conn:3}],p);
  const r=M.tnStep(s,[],[{src:'net',ev:'data',conn:3,hex:'cafebabe'}],p);
  eq('net data → gatt.write',r.gattCmd,[{cmd:'gatt.write',addr:p.addr,svc:p.svc,chr:p.chr,hex:'cafebabe',resp:false}]);
}

// close закрывает именно свой conn, посторонний close не трогает текущий
{ const s=M.tnInit();
  M.tnStep(s,[],[{src:'net',ev:'open',conn:3}],p);
  M.tnStep(s,[],[{src:'net',ev:'close',conn:99}],p);
  eq('чужой close не сбрасывает conn',s.conn,3);
  M.tnStep(s,[],[{src:'net',ev:'close',conn:3}],p);
  eq('свой close сбрасывает conn',s.conn,null);
}

// Характеристика не совпадает — notify игнорируется
{ const s=M.tnInit();
  M.tnStep(s,[],[{src:'net',ev:'open',conn:1}],p);
  const r=M.tnStep(s,[{src:'gatt',ev:'notify',svc:'180d',chr:'ffff',hex:'ab'}],[],p);
  eq('другая характеристика — не наша',r.netCmd,null);
}

// GATT отключился при closeOnDrop → закрывает сетевое соединение и сбрасывает conn
{ const s=M.tnInit();
  M.tnStep(s,[],[{src:'net',ev:'accept',conn:5}],p);
  const r=M.tnStep(s,[{src:'gatt',ev:'disconnected'}],[],p);
  eq('disconnected → tcp.close того же conn',r.netCmd,[{cmd:'tcp.close',conn:5}]);
  eq('conn сброшен после disconnected',r.conn,null);
}
// closeOnDrop выключен — ничего не шлём, обрыв — дело пользователя
{ const s=M.tnInit(); const p2={...p,closeOnDrop:false};
  M.tnStep(s,[],[{src:'net',ev:'accept',conn:5}],p2);
  const r=M.tnStep(s,[{src:'gatt',ev:'disconnected'}],[],p2);
  eq('closeOnDrop:false — ничего не посылаем',r.netCmd,null); eq('conn остаётся',r.conn,5);
}

// UDP-режим: notify → udp.send с host/port/conn
{ const s=M.tnInit(); const pu={...p,mode:'udp',host:'10.0.0.5',port:5000};
  M.tnStep(s,[],[{src:'net',ev:'open',conn:2}],pu);
  const r=M.tnStep(s,[{src:'gatt',ev:'notify',svc:'180d',chr:'2a37',hex:'11'}],[],pu);
  eq('udp.send с host/port/conn',r.netCmd,[{cmd:'udp.send',host:'10.0.0.5',port:5000,conn:2,hex:'11'}]);
  const r2=M.tnStep(s,[{src:'gatt',ev:'disconnected'}],[],pu);
  eq('udp closeOnDrop → udp.close',r2.netCmd,[{cmd:'udp.close',conn:2}]);
}

console.log(bad?('\n'+bad+' FAIL'):'\nall ok'); process.exit(bad?1:0);
