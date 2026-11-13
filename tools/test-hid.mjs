// HID-периферия (клавиатура + мышь + медиа, геймпад): node tools/test-hid.mjs
// Круг «собрали → разобрали → поля совпали», дескрипторы, текст → клавиши, жесты тачпада. Эфир не нужен.
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,parseInt,isFinite});
vm.runInContext(fs.readFileSync(new URL('../modules/hid-kernels.js',import.meta.url),'utf8')+
 ';this.K={HID_DEVICES,hidDescInfo,hidKeySpec,hidTextKeys,hidKeyChar,hidKbdBuild,hidKbdParse,hidLedBuild,hidLedParse,hidMouseBuild,hidMouseParse,hidMediaBuild,hidMediaParse,hidPadBuild,hidPadParse,hidHat,hidReportParse,hidRegisterCmd,hidReportCmd,hidPadLayout,hidHit,HidTouch,HidOut,hidBytes,hidxHex,hidAccel,HID_MEDIA,hidRefKeys,hidRefDevices,hidCmdName,hidUsb,hidDeviceFromRow,hidSpecFromCode,hidApplyCmd}',ctx);
const K=ctx.K, J=o=>JSON.stringify(o);

// дескрипторы: отчёты нужных размеров, скобки сбалансированы
const di=K.hidDescInfo(K.HID_DEVICES.combo.hex), by=id=>di.reports.find(r=>r.id===id)||{};
ok('combo descriptor: keyboard 8 in / 1 out, mouse 5, media 2',di.balanced && by(1).input===8 && by(1).output===1 && by(2).input===5 && by(3).input===2,J(di));
const dp=K.hidDescInfo(K.HID_DEVICES.gamepad.hex);
ok('gamepad descriptor: one 9-byte report',dp.balanced && dp.reports.length===1 && dp.reports[0].input===9,J(dp));
ok('descriptors fit the app limit (4096 bytes)',K.hidBytes(K.HID_DEVICES.combo.hex).length<4096);

// клавиатура: собрали → разобрали
const kb=K.hidKbdBuild(3,[4,5,0,6]);
ok('keyboard report: 8 bytes, zeros dropped',kb.length===8 && J(kb)==='[3,0,4,5,6,0,0,0]',J(kb));
const kp=K.hidKbdParse(kb);
ok('keyboard loop: mod, keys, names',kp.mod===3 && J(kp.keys)==='[4,5,6]' && J(kp.names)==='["a","b","c"]' && kp.ctrl && kp.shift && !kp.alt,J(kp));
ok('keyboard: at most 6 keys',K.hidKbdBuild(0,[1,2,3,4,5,6,7,8]).length===8 && K.hidKbdParse(K.hidKbdBuild(0,[1,2,3,4,5,6,7,8])).keys.length===6);
ok('LED loop: num + caps',J(K.hidLedParse(K.hidLedBuild({num:1,caps:1})))===J({num:true,caps:true,scroll:false,compose:false,kana:false}));

// мышь
const mb=K.hidMouseBuild(5,-30,127,-1,3), mp=K.hidMouseParse(mb);
ok('mouse loop: buttons, dx, dy, wheel, pan',mp.left && !mp.right && mp.middle && mp.dx===-30 && mp.dy===127 && mp.wheel===-1 && mp.pan===3,J(mp));
ok('mouse: values clamp to ±127',K.hidMouseParse(K.hidMouseBuild(0,500,-500,0,0)).dx===127 && K.hidMouseParse(K.hidMouseBuild(0,500,-500,0,0)).dy===-127);

// медиа
for(const nm of ['vol+','vol-','mute','play','next','prev','home','back','tvmenu']){
  const sp=K.hidKeySpec(nm), r=K.hidMediaParse(K.hidMediaBuild(sp.media));
  ok('media loop: '+nm,r && r.name===nm,J(r));
}
ok('media: 16-bit usage little-endian (Home 0x223)',J(K.hidMediaBuild(0x223))==='[35,2]' && K.hidMediaParse([0,0]).name==='');

// геймпад
const pb=K.hidPadBuild({btn:0x8005,hat:K.hidHat(1,1,0,0),x1:-1,y1:.5,x2:0,y2:1,lt:1,rt:.5}), pp=K.hidPadParse(pb);
ok('gamepad loop: buttons, hat NE, axes, triggers',J(pp.buttons)==='[1,3,16]' && pp.hat===2 && pp.x1===-1 && Math.abs(pp.y1-.5)<.01 && pp.x2===0 && pp.y2===1 && pp.lt===1 && Math.abs(pp.rt-.5)<.01,J(pp));
ok('hat: 8 directions and none',[[1,0,0,0,1],[1,1,0,0,2],[0,1,0,0,3],[0,1,1,0,4],[0,0,1,0,5],[0,0,1,1,6],[0,0,0,1,7],[1,0,0,1,8],[0,0,0,0,0],[1,0,1,0,0]].every(a=>K.hidHat(a[0],a[1],a[2],a[3])===a[4]));
ok('gamepad: axes clamp, report is 9 bytes',K.hidPadBuild({x1:5,lt:9}).length===9 && K.hidPadParse(K.hidPadBuild({x1:5,lt:9})).x1===1);

// имена клавиш
ok('key names: letters, arrows, combos',J(K.hidKeySpec('a'))==='{"mod":0,"key":4}' && K.hidKeySpec('up').key===0x52 && J(K.hidKeySpec('Ctrl+Alt+Delete'))==='{"mod":5,"key":76}');
ok('key names: alias from a D-pad corner',K.hidKeySpec('a',{a:'back'}).media===0x224 && K.hidKeySpec('b',{a:'back'}).key===5);
ok('key names: unknown → null',K.hidKeySpec('qqq')===null && K.hidKeySpec('foo+a')===null && K.hidKeySpec('')===null);
ok('«home» is the TV button, «khome» the keyboard key',K.hidKeySpec('home').media===0x223 && K.hidKeySpec('khome').key===0x4A);

// текст → клавиши → текст (US)
const txt='Hello, World! 123 {ok}\n';
const t1=K.hidTextKeys(txt,'us'); ok('text: every ASCII char has a key',t1.skipped===0 && t1.strokes.length===[...txt].length);
ok('text loop (US): strokes → same text',t1.strokes.map(s=>K.hidKeyChar(s.mod,s.key)).join('')===txt,t1.strokes.map(s=>K.hidKeyChar(s.mod,s.key)).join(''));
ok('text: capital uses Shift, lower does not',K.hidTextKeys('Aa','us').strokes[0].mod===2 && K.hidTextKeys('Aa','us').strokes[1].mod===0);
const ru=K.hidTextKeys('Привет, мир!','ru');
ok('text (RU host layout): Cyrillic letters sit on the physical keys',ru.skipped===0 && ru.strokes[0].mod===2 && ru.strokes[0].key===K.hidKeySpec('g').key && ru.strokes[1].key===K.hidKeySpec('h').key,J(ru.strokes.slice(0,2)));
ok('text (RU): comma is Shift+/, full stop is /',K.hidTextKeys(',','ru').strokes[0].mod===2 && K.hidTextKeys('.','ru').strokes[0].key===0x38);
ok('text: characters without a key are counted, not typed',K.hidTextKeys('a€b','us').skipped===1 && K.hidTextKeys('a€b','us').strokes.length===2);

// очередь: HidOut
const o=new ctx.K.HidOut();
o.type('Hi','us'); let q=o.take();
ok('type: press + release per character',q.length===4 && q[0].id===1 && K.hidKbdParse(q[0].bytes).mod===2 && K.hidKbdParse(q[1].bytes).keys.length===0,J(q));
o.keyDown(K.hidKeySpec('ctrl')); o.keyDown(K.hidKeySpec('c')); q=o.take();
ok('chord: modifier stays while a key is held',K.hidKbdParse(q[1].bytes).mod===1 && K.hidKbdParse(q[1].bytes).keys[0]===6,J(q));
o.keyUp(K.hidKeySpec('c')); o.keyUp(K.hidKeySpec('ctrl')); q=o.take();
ok('chord release: everything lifted',q.length===2 && J(K.hidKbdParse(q[1].bytes).keys)==='[]' && K.hidKbdParse(q[1].bytes).mod===0);
o.keyDown(K.hidKeySpec('vol+')); o.keyUp(K.hidKeySpec('vol+')); q=o.take();
ok('media key: id 3, press and release',q.length===2 && q[0].id===3 && K.hidMediaParse(q[0].bytes).name==='vol+' && K.hidMediaParse(q[1].bytes).usage===0);
o.move(300,-5,0,0); q=o.take();
ok('mouse move over 127 is split into chunks, sum is kept',q.length===3 && q.every(r=>r.id===2) && q.reduce((s,r)=>s+K.hidMouseParse(r.bytes).dx,0)===300 && q.reduce((s,r)=>s+K.hidMouseParse(r.bytes).dy,0)===-5);
o.move(.4,0,0,0); o.move(.4,0,0,0); o.move(.4,0,0,0); q=o.take();
ok('fractional motion accumulates (no lost slow moves)',q.length===1 && K.hidMouseParse(q[0].bytes).dx===1,J(q));
o.button(1,true); o.move(3,0,0,0); q=o.take();
ok('drag: the pressed button rides on move reports',K.hidMouseParse(q[q.length-1].bytes).left && K.hidMouseParse(q[q.length-1].bytes).dx===3);
o.button(1,false); o.take(); o.releaseAll(); q=o.take();
ok('releaseAll: keyboard, mouse and media reports are zero',q.length===3 && q.every(r=>r.bytes.every(b=>b===0)));

// команды приложению
const rc=K.hidRegisterCmd('combo',''), rg=K.hidRegisterCmd('gamepad',' Pad ');
ok('register command: custom type, descriptor hex, subclass, name',rc.cmd==='hid.register' && rc.type==='custom' && rc.descriptor===K.HID_DEVICES.combo.hex && rc.subclass===0xC0 && rc.name==='DSP keyboard + mouse + media' && rg.name==='Pad' && rg.subclass===8);
ok('report command: report id goes as rid (id is the request number), hex; addr only when given',J(K.hidReportCmd(2,[1,2,3,4,5]))==='{"cmd":"hid.report","rid":2,"hex":"0102030405"}' && K.hidReportCmd(1,[0],'AA:BB:CC:DD:EE:FF').addr==='AA:BB:CC:DD:EE:FF');

// USB (root): те же отчёты, другие команды
const ur=K.hidRegisterCmd('combo','','usb (root)'), ub=K.hidReportCmd(2,[1,2,3,4,5],'AA:BB:CC:DD:EE:FF','usb (root)');
ok('usb register: usbhid.register, descriptor + subclass, no BT-only fields',ur.cmd==='usbhid.register' && ur.descriptor===K.HID_DEVICES.combo.hex && ur.subclass===0xC0 && !('type' in ur) && K.hidRegisterCmd('combo','').cmd==='hid.register');
ok('usb report: usbhid.report, no host address',ub.cmd==='usbhid.report' && !('addr' in ub) && ub.rid===2 && !('id' in ub) && ub.hex==='0102030405');
ok('transport names: bluetooth by default',K.hidCmdName('','list')==='hid.list' && K.hidCmdName('bluetooth','unregister')==='hid.unregister' && K.hidCmdName('usb (root)','list')==='usbhid.list' && K.hidUsb('USB'));

// разбор записи по id/длине (то, что делает узел HID Report Decode)
ok('report decode by id: key / mouse / media / LEDs',K.hidReportParse('combo',1,kb).kind==='key' && K.hidReportParse('combo',2,mb).kind==='mouse' && K.hidReportParse('combo',3,[0xE9,0]).name==='vol+' && K.hidReportParse('combo',1,[2]).kind==='leds' && K.hidReportParse('combo',9,[1,2])===null && K.hidReportParse('gamepad',1,pb).kind==='pad');

// тачпад
const L=K.hidPadLayout(300,260);
ok('layout: pad above the buttons, three rows, nothing outside',L.pad.y+L.pad.h<=Math.min(...L.btns.map(b=>b.y)) && L.btns.length===12 && L.btns.every(b=>b.x>=0 && b.x+b.w<=300 && b.y+b.h<=260),J(L.pad));
ok('hit test: button, pad, outside',K.hidHit(L,L.btns[1].x+2,L.btns[1].y+2).id==='play' && K.hidHit(L,150,L.pad.y+20).kind==='pad' && K.hidHit(L,-5,-5)===null);
const g=new K.HidTouch({gain:2});
let a=[...g.down(1,100,100,0),...g.move(1,110,100,10),...g.move(1,115,105,20),...g.up(1,30)];
ok('one finger: moves the cursor with gain, no click after travel',a.filter(x=>x.a==='move').reduce((s,x)=>s+x.dx,0)===30 && !a.some(x=>x.a==='click'),J(a));
a=[...g.down(1,50,50,1000),...g.up(1,1100)];
ok('tap: left click',J(a)==='[{"a":"click","b":1}]',J(a));
a=[...g.down(1,50,50,1200),...g.move(1,60,70,1230),...g.move(1,90,70,1260),...g.up(1,1300)];
ok('tap then touch-and-drag: press, motion, release (no extra click)',a[0].a==='press' && a.some(x=>x.a==='move') && a[a.length-1].a==='release' && !a.some(x=>x.a==='click'),J(a));
a=[...g.down(1,50,50,5000),...g.down(2,90,50,5010),...g.up(2,5060),...g.up(1,5070)];
ok('two-finger tap: right click',J(a)==='[{"a":"click","b":2}]',J(a));
const g2=new K.HidTouch({scroll:.5});
a=[...g2.down(1,50,50,9000),...g2.down(2,90,50,9000),...g2.move(1,50,70,9020),...g2.move(2,90,70,9020),...g2.move(1,50,90,9040),...g2.move(2,90,90,9040),...g2.up(2,9100),...g2.up(1,9100)];
ok('two fingers: scroll, finger down = wheel down, no click',a.some(x=>x.a==='scroll' && x.wheel<0) && !a.some(x=>x.a==='click' || x.a==='move'),J(a));
ok('acceleration: faster strokes go further',K.hidAccel(20,1,1)>K.hidAccel(2,1,1)*10/1.0 && K.hidAccel(5,1,0)===5);

// справочники для Table: устройства и коды
const rd=K.hidRefDevices(), rk=K.hidRefKeys();
ok('device reference: every descriptor balanced, report sizes listed',rd.length>=6 && rd.every(d=>K.hidDescInfo(d.descriptor).balanced && d.reports),J(rd.map(d=>d.name)));
ok('device reference: combo row = built-in combo descriptor',rd.find(d=>d.name==='combo').descriptor===K.HID_DEVICES.combo.hex && rd.find(d=>d.name==='combo').ids==='kbd:1 mouse:2 media:3');
const dv=K.hidDeviceFromRow(rd.find(d=>d.name==='remote'));
ok('device row → register: role ids kept, subclass numeric',dv && dv.ids.media===1 && !dv.ids.kbd && K.hidRegisterCmd(dv,'').descriptor===dv.hex && K.hidRegisterCmd(dv,'').name==='DSP media remote');
ok('device row: a custom descriptor without roles is accepted, junk is not',K.hidDeviceFromRow({name:'x',descriptor:'05010906a101c0'}).ids.kbd===undefined && K.hidDeviceFromRow({descriptor:''})===null && K.hidDeviceFromRow(null)===null);
ok('key reference: every row resolves to the same code as the name',rk.every(r=>{ const sp=r.kind==='modifier' ? {mod:+r.code} : K.hidSpecFromCode(r.page,r.code), by=K.hidKeySpec(r.name); return r.kind==='modifier' ? by.mod===sp.mod : by && (by.media||by.key)===(sp.media||sp.key); }),J(rk.filter(r=>r.kind!=='modifier' && !K.hidKeySpec(r.name)).slice(0,3)));
ok('key reference: letters, arrows, volume and Home are there',['a','up','enter','f5','vol+','home','back','ctrl'].every(n=>rk.some(r=>r.name===n)));
ok('data/hid-ref.json is up to date (node tools/hid-ref.mjs)',(()=>{ const f=JSON.parse(fs.readFileSync(new URL('../data/hid-ref.json',import.meta.url),'utf8')); return J(f.devices.rows)===J(rd) && J(f.keys.rows)===J(rk); })());
// команды по пину
let h=new K.HidOut(), act;
K.hidApplyCmd(h,{key:"vol+"}); q=h.take();
ok('cmd {key}: tap = press + release',q.length===2 && q[0].id===3 && K.hidMediaParse(q[0].bytes).name==='vol+');
K.hidApplyCmd(h,{page:'12',code:'226'}); q=h.take();
ok('cmd {page, code} (a Reference/HID Keys row): mute',K.hidMediaParse(q[0].bytes).name==='mute');
K.hidApplyCmd(h,{name:'a',kind:'key',page:'7',code:'4'}); q=h.take();
ok('cmd: a key-reference row types the key',K.hidKbdParse(q[0].bytes).keys[0]===4 && K.hidKbdParse(q[1].bytes).keys.length===0);
K.hidApplyCmd(h,{key:'ctrl',down:1}); K.hidApplyCmd(h,{key:'c',down:1}); K.hidApplyCmd(h,{key:'c',down:0}); K.hidApplyCmd(h,{key:'ctrl',down:0}); q=h.take();
ok('cmd: down 1 / 0 holds and releases a chord',q.length===4 && K.hidKbdParse(q[1].bytes).mod===1 && K.hidKbdParse(q[3].bytes).mod===0);
K.hidApplyCmd(h,{dx:5,dy:-3,wheel:1}); K.hidApplyCmd(h,{click:2}); q=h.take();
ok('cmd: motion and a right click',K.hidMouseParse(q[0].bytes).dx===5 && K.hidMouseParse(q[0].bytes).dy===-3 && K.hidMouseParse(q[0].bytes).wheel===1 && K.hidMouseParse(q[1].bytes).right && !K.hidMouseParse(q[2].bytes).right);
act=K.hidApplyCmd(h,{report:5,hex:'01 02'}); q=h.take();
ok('cmd: a raw report for a custom device',q.length===1 && q[0].id===5 && J(q[0].bytes)==='[1,2]' && act.length===0);
act=K.hidApplyCmd(h,{text:'hi',key:'zzz'});
ok('cmd: text goes back to the node, unknown key is an error',act.some(a=>a.text==='hi') && act.some(a=>a.error),J(act));
ok('cmd: own records (hidtx / hidrx) are ignored — no feedback loop',K.hidApplyCmd(h,{src:'hidtx',id:1,hex:'00',key:'a'}).length===0 && h.take().length===0);
h=new K.HidOut({media:1}); K.hidApplyCmd(h,{key:'a'}); K.hidApplyCmd(h,{dx:5});
ok('device without a role: that command is skipped, not sent to a wrong id',h.take().length===0);
act=K.hidApplyCmd(h,{register:1,connect:'AA:BB:CC:DD:EE:FF'});
ok('cmd: register / connect are node actions',act.length===2 && act[1].connect==='AA:BB:CC:DD:EE:FF');

if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
