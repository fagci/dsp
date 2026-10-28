"use strict";
/* ============================ Tunnel: BLE GATT ↔ Network (DSP app) ============================
   Полноценный туннель между двумя телефонными транспортами (не разовый мост с угаданным conn:1,
   как в пресете Bridge: BLE GATT ↔ Network — recMap, modules/flow.js): отслеживает своё TCP/UDP-соединение
   по его собственным open/accept/close и шлёт именно его conn, не выдуманный. Один GATT-девайс ↔ один
   клиент/пир зараз (TCP-сервер — первый подключившийся, UDP — после первого send/приёма). Ядро без DOM —
   modules/tunnel-kernels.js (tools/test-tunnel.mjs). Входы — rec напрямую с BLE GATT / Bluetooth (gattlink)
   и Network (netlink); выходы — их же cmd. */

def({ id:'tunnel', title:'Tunnel: BLE GATT ↔ Network (DSP app)', cat:'Control', kw:'bridge gateway tunnel relay ble gatt tcp udp network bluetooth phone proxy',
  ins:[{n:'gattRec',t:'rec'},{n:'netRec',t:'rec'}], outs:[{n:'gattCmd',t:'rec'},{n:'netCmd',t:'rec'},{n:'status',t:'txt'}],
  readout:true,
  groups:[{n:'GATT side'},{n:'Network side'}],
  params:[
    {n:'addr',g:'GATT side',t:'text',d:'',label:'device address AA:BB:CC:DD:EE:FF (must match BLE GATT\'s own «connect»)'},
    {n:'svc',g:'GATT side',t:'text',d:'',label:'service UUID'},
    {n:'chr',g:'GATT side',t:'text',d:'',label:'characteristic UUID (empty — any notifying characteristic)'},
    {n:'resp',g:'GATT side',t:'check',d:false,label:'write with response'},
    {n:'mode',g:'Network side',t:'select',opts:['tcp','udp'],d:'tcp',label:'protocol (must match Network\'s own listen/open)'},
    {n:'host',g:'Network side',t:'text',d:'',label:'udp: peer host (empty — wait for the first datagram\'s sender)',adv:true},
    {n:'port',g:'Network side',t:'num',d:0,label:'udp: peer port',adv:true},
    {n:'closeOnDrop',t:'check',d:true,label:'close the network side when the GATT device disconnects'},
  ],
  init:n=>{ n.st=tnInit(); n.toGatt=0; n.toNet=0; },
  process(n,I){
    const gatt=recList(I.gattRec), net=recList(I.netRec);
    const r=tnStep(n.st, gatt, net, n.p);
    if(r.gattCmd) n.toGatt+=r.gattCmd.length;              // network → GATT (gatt.write/tcp/udp.close)
    if(r.netCmd) n.toNet+=r.netCmd.length;                 // GATT → network (tcp/udp.send или .close)
    const conn=r.conn;
    return {gattCmd:r.gattCmd, netCmd:r.netCmd, status:(conn==null ? 'no client' : 'conn '+conn)+' · GATT→net '+n.toNet+' · net→GATT '+n.toGatt};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.st.conn==null ? 'waiting for a client…' : 'bridging conn '+n.st.conn)+'\nGATT → network: '+n.toNet+'\nnetwork → GATT: '+n.toGatt;
    if(r.textContent!==t) r.textContent=t; }
});
