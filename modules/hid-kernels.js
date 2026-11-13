"use strict";
/* ============================ HID-периферия: ядро (без DOM) ============================
   Телефон как своя клавиатура + мышь + медиа-пульт (одно устройство с тремя report id) и как геймпад.
   Ядро: дескрипторы, сборка / разбор отчётов (зеркальные пары …Build / …Parse), текст → нажатия клавиш (US и ЙЦУКЕН хоста),
   имена клавиш и медиа-кнопок, раскладка и жесты тачпада. Транспорт — команды hid.* приложения (tools/android/README.md).
   Проверка: node tools/test-hid.mjs. Тестовые сигналы с кодом Power — не излучать в эфир. */

// ---------- дескрипторы ----------
// combo: 1 — клавиатура (8 байт: модификаторы, резерв, 6 кодов; output 1 байт — светодиоды), 2 — мышь (кнопки, dx, dy, колесо, pan — 5 байт),
//        3 — Consumer Control (16-битный код Usage, 2 байта)
const hidxId=id=>'85'+(id&255).toString(16).padStart(2,'0');
// фрагменты дескриптора по ролям; id — report id (в составном устройстве у каждой роли свой)
const hidKbdDesc=id=>'05010906a101'+hidxId(id)+'0507'+'19e029e7'+'15002501'+'75019508'+'8102'+'95017508'+'8101'+'95057501'+'0508'+'19012905'+'9102'+'95017503'+'9101'+
  '95067508'+'15002565'+'0507'+'19002965'+'8100'+'c0';
const hidMouseDesc=id=>'05010902a101'+hidxId(id)+'0901a100'+'05091901'+'2903'+'15002501'+'95037501'+'8102'+'95017505'+'8101'+
  '0501'+'093009310938'+'1581257f'+'75089503'+'8106'+'050c0a3802'+'1581257f'+'75089501'+'8106'+'c0c0';
const hidConsDesc=id=>'050c0901a101'+hidxId(id)+'150026ff03'+'1900'+'2aff03'+'75109501'+'8100'+'c0';
const HID_COMBO_HEX=hidKbdDesc(1)+hidMouseDesc(2)+hidConsDesc(3);
// gamepad: report id 1 — 16 кнопок (2 байта), hat (4 бита, 1…8 по часовой от севера, 0 — нет) + 4 бита резерва, X Y Z Rz (int8), два триггера (0…255)
const HID_PAD_HEX=
  '05010905a1018501'+'0509'+'19012910'+'15002501'+'75019510'+'8102'+
  '0501'+'0939'+'15012508'+'75049501'+'8142'+'75049501'+'8103'+
  '0501'+'09300931'+'09320935'+'1581257f'+'75089504'+'8102'+
  '0502'+'09c509c4'+'150026ff00'+'75089502'+'8102'+'c0';
// справочник устройств (список Table «Reference/HID Devices», data/hid-ref.json — tools/hid-ref.mjs): имя, дескриптор, subclass, роли → report id
const HID_DEVICES={
  combo:{hex:HID_COMBO_HEX,subclass:0xC0,name:'DSP keyboard + mouse + media',ids:{kbd:1,mouse:2,media:3},note:'TV / PC remote: touchpad, keys, volume, Home / Back'},
  gamepad:{hex:HID_PAD_HEX,subclass:0x08,name:'DSP gamepad',ids:{pad:1},note:'16 buttons, hat, 2 sticks, 2 triggers (9-byte report)'},
  keyboard:{hex:hidKbdDesc(1),subclass:0x40,name:'DSP keyboard',ids:{kbd:1},note:'keyboard only (8-byte report, LEDs back)'},
  mouse:{hex:hidMouseDesc(1),subclass:0x80,name:'DSP mouse',ids:{mouse:1},note:'mouse only: 3 buttons, dx, dy, wheel, pan'},
  remote:{hex:hidConsDesc(1),subclass:0x00,name:'DSP media remote',ids:{media:1},note:'consumer control only: volume, play, Home, Back…'},
  'keyboard + media':{hex:hidKbdDesc(1)+hidConsDesc(2),subclass:0x40,name:'DSP keyboard + media',ids:{kbd:1,media:2},note:'keyboard and media keys, no pointer'},
};
const hidIdsText=ids=>Object.keys(ids).map(k=>k+':'+ids[k]).join(' ');
const hidIdsParse=t=>{ const o={}; for(const m of String(t||'').matchAll(/([a-z]+)\s*[:=]\s*(\d+)/gi)) o[m[1].toLowerCase()]=+m[2]; return o; };
// строка справочника устройств (запись rec из Table) → {name, hex, subclass, ids} | null
function hidDeviceFromRow(r){
  if(!r || typeof r!=='object') return null;
  const hex=hidBytes(r.descriptor||r.hex); if(!hex.length || hex.length>4096) return null;
  const ids=hidIdsParse(r.ids);                       // нет ролей — своё устройство: управляется только сырыми отчётами {report, hex}
  return {name:String(r.title||r.name||'').trim(),hex:hidxHex(hex),subclass:+r.subclass||0,ids};
}
// разбор дескриптора: по каждому report id — размеры input / output / feature в байтах (проверка, что отчёты собираются по нему)
function hidDescInfo(hex){
  const b=hidBytes(hex), reps={}; let id=0, size=0, count=0, i=0, depth=0;
  const get=r=>reps[r]||(reps[r]={id:r,input:0,output:0,feature:0});
  while(i<b.length){
    const h=b[i], bs=h&3, n=bs===3?4:bs, type=(h>>2)&3, tag=h>>4;
    let v=0; for(let k=0;k<n;k++) v|=b[i+1+k]<<(8*k);
    i+=1+n;
    if(type===1){ if(tag===7) size=v; else if(tag===9) count=v; else if(tag===8) id=v; }
    else if(type===0){
      if(tag===8) get(id).input+=size*count; else if(tag===9) get(id).output+=size*count; else if(tag===11) get(id).feature+=size*count;
      else if(tag===10) depth++; else if(tag===12) depth--;
    }
  }
  const out=Object.values(reps).map(r=>({id:r.id,input:Math.ceil(r.input/8),output:Math.ceil(r.output/8),feature:Math.ceil(r.feature/8)}));
  return {reports:out,balanced:depth===0};
}

// ---------- байты ----------
const hidBytes=h=>{ h=String(h||'').replace(/0x/ig,'').replace(/[^0-9a-f]/ig,''); const o=[]; for(let i=0;i+1<h.length;i+=2) o.push(parseInt(h.substr(i,2),16)); return o; };
const hidxHex=a=>Array.from(a,x=>(x&255).toString(16).padStart(2,'0')).join('');
const hidS8=v=>Math.max(-127,Math.min(127,Math.round(+v||0)));
const hidU8=v=>Math.max(0,Math.min(255,Math.round(+v||0)));

// ---------- клавиши ----------
const HID_MOD={ctrl:1,control:1,shift:2,alt:4,option:4,gui:8,win:8,cmd:8,meta:8,super:8,rctrl:16,rshift:32,ralt:64,altgr:64,rgui:128};
const HID_KEYS={enter:0x28,ok:0x28,return:0x28,esc:0x29,escape:0x29,backspace:0x2A,tab:0x2B,space:0x2C,minus:0x2D,equal:0x2E,
  caps:0x39,capslock:0x39,printscreen:0x46,scrolllock:0x47,pausebreak:0x48,insert:0x49,home:0x4A,pgup:0x4B,pageup:0x4B,delete:0x4C,del:0x4C,end:0x4D,pgdn:0x4E,pagedown:0x4E,
  right:0x4F,left:0x50,down:0x51,up:0x52,numlock:0x53,menu:0x65,compose:0x65};
for(let i=0;i<26;i++) HID_KEYS[String.fromCharCode(97+i)]=0x04+i;
for(let i=1;i<=9;i++) HID_KEYS[String(i)]=0x1D+i;
HID_KEYS['0']=0x27;
for(let i=1;i<=12;i++) HID_KEYS['f'+i]=0x3A+i-1;
// медиа-кнопки Consumer Control (usage page 0x0C)
const HID_MEDIA={'vol+':0xE9,volup:0xE9,'vol-':0xEA,voldown:0xEA,mute:0xE2,play:0xCD,pause:0xCD,playpause:0xCD,next:0xB5,prev:0xB6,previous:0xB6,stop:0xB7,
  ff:0xB3,rew:0xB4,eject:0xB8,home:0x223,back:0x224,forward:0x225,search:0x221,favorites:0x22A,power:0x30,sleep:0x32,brightup:0x6F,brightdown:0x70,
  mail:0x18A,calc:0x192,browser:0x196,tvmenu:0x40,guide:0x8D,info:0x9C,channelup:0x9C,channeldown:0x9D};
HID_KEYS.khome=0x4A;                                   // «home» — медиа-кнопка Home (Android TV), клавиша Home клавиатуры — «khome»
const HID_KEYNAME={}; for(const k of Object.keys(HID_KEYS)) if(!HID_KEYNAME[HID_KEYS[k]] || HID_KEYNAME[HID_KEYS[k]].length>k.length) HID_KEYNAME[HID_KEYS[k]]=k;
Object.assign(HID_KEYNAME,{0x28:'enter',0x29:'esc',0x4B:'pgup',0x4E:'pgdn',0x4C:'delete',0x4A:'khome',0x2C:'space',0x2A:'backspace'});
const HID_MEDIANAME={}; for(const [k,v] of [['vol+',0xE9],['vol-',0xEA],['mute',0xE2],['play',0xCD],['next',0xB5],['prev',0xB6],['stop',0xB7],['ff',0xB3],['rew',0xB4],['eject',0xB8],['home',0x223],['back',0x224],['forward',0x225],['search',0x221],['favorites',0x22A],['power',0x30],['sleep',0x32],['tvmenu',0x40],['guide',0x8D],['info',0x9C],['channeldown',0x9D],['mail',0x18A],['calc',0x192],['browser',0x196],['brightup',0x6F],['brightdown',0x70]]) HID_MEDIANAME[v]=k;

// «ctrl+shift+t», «a», «vol+», «up»; псевдонимы (например, с D-pad) — таблицей alias {a:'back',…}
// → {mod,key} | {media} | null
function hidKeySpec(name,alias){
  let s=String(name||'').trim().toLowerCase(); if(!s) return null;
  if(alias && Object.prototype.hasOwnProperty.call(alias,s)) s=String(alias[s]).trim().toLowerCase();
  if(Object.prototype.hasOwnProperty.call(HID_MEDIA,s)) return {media:HID_MEDIA[s]};
  let last=s, mods=[];
  if(s.length>1){ const parts=s.split('+'); last=parts.pop(); if(last==='') last='+'; mods=parts.filter(x=>x!==''); }
  let mod=0; for(const m of mods){ if(!HID_MOD[m]) return null; mod|=HID_MOD[m]; }
  if(last==='+') return {mod:mod|2,key:0x2E};
  if(HID_MOD[last] && !mods.length) return {mod:HID_MOD[last],key:0};
  if(Object.prototype.hasOwnProperty.call(HID_KEYS,last)) return {mod,key:HID_KEYS[last]};
  return null;
}
// строка справочника кодов (Table «Reference/HID Keys»: name, kind, page, code) или команда {page, code} → то же {mod,key} | {media}
function hidSpecFromCode(page,code){
  page=+page; code=+code; if(!(code>=0)) return null;
  if(page===12) return {media:code};
  if(page===7) return {mod:0,key:code};
  if(page===-1) return {mod:code,key:0};                // «page -1» — бит модификатора (kind modifier в справочнике)
  return null;
}
// справочник → строки Table: клавиши, модификаторы, медиа-кнопки (имена, как их понимает hidKeySpec)
function hidRefKeys(){
  const rows=[], grp=c=>c>=4&&c<=0x1D?'letters':c>=0x1E&&c<=0x27?'digits':c>=0x3A&&c<=0x45?'function':c>=0x49&&c<=0x52?'navigation':c===0x28||c===0x29||c===0x2A||c===0x2B||c===0x2C?'editing':'other';
  const add=(name,kind,page,code,group,note)=>rows.push({name,kind,page:String(page),code:String(code),hex:'0x'+code.toString(16),group,note:note||''});
  for(const k of Object.keys(HID_KEYS)){ const c=HID_KEYS[k]; if(HID_KEYNAME[c]===k || ['ok','return','escape','capslock','pageup','pagedown','del'].includes(k)) add(k,'key',7,c,grp(c),k==='ok'?'= enter (D-pad centre)':''); }
  for(const k of ['ctrl','shift','alt','gui','rctrl','rshift','ralt','rgui']) add(k,'modifier',-1,HID_MOD[k],'modifier','bit mask in the keyboard report');
  const mg=u=>u===0xE9||u===0xEA||u===0xE2?'volume':u>=0xB3&&u<=0xB8||u===0xCD?'transport':u===0x223||u===0x224||u===0x225||u===0x221||u===0x22A||u===0x40||u===0x8D||u===0x9C||u===0x9D?'tv':'system';
  for(const k of Object.keys(HID_MEDIA)){ const u=HID_MEDIA[k]; add(k,'media',12,u,mg(u),k==='power'||k==='sleep' ? 'can switch the host off — use deliberately' : ''); }
  return rows;
}
function hidRefDevices(){
  return Object.keys(HID_DEVICES).map(k=>{ const d=HID_DEVICES[k], i=hidDescInfo(d.hex);
    return {name:k,title:d.name,subclass:String(d.subclass),ids:hidIdsText(d.ids),reports:i.reports.map(r=>r.id+': in '+r.input+' B'+(r.output?' / out '+r.output+' B':'')).join('; '),descriptor:d.hex,note:d.note}; });
}

// символ → [модификатор, код клавиши]; layout 'us' (хост на английской раскладке) или 'ru' (ЙЦУКЕН: клавиши — физические позиции)
const HID_US_SHIFT={'!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0','_':'-','+':'=','{':'[','}':']','|':'\\',':':';','"':"'",'~':'`','<':',','>':'.','?':'/'};
const HID_US_PLAIN={'-':0x2D,'=':0x2E,'[':0x2F,']':0x30,'\\':0x31,';':0x33,"'":0x34,'`':0x35,',':0x36,'.':0x37,'/':0x38,' ':0x2C,'\n':0x28,'\t':0x2B};
const HID_RU_ROWS={'йцукенгшщзхъ':'qwertyuiop[]','фывапролджэ':"asdfghjkl;'",'ячсмитьбю':'zxcvbnm,.','ё':'`'};
const HID_RU={}; for(const [ru,us] of Object.entries(HID_RU_ROWS)) for(let i=0;i<ru.length;i++) HID_RU[ru[i]]=us[i];
function hidCharKey(ch,layout){
  if(layout==='ru'){
    const lo=ch.toLowerCase();
    if(HID_RU[lo]){ const k=hidCharKey(HID_RU[lo],'us'); return [lo!==ch?2:0,k[1]]; }
    if(ch==='.') return [0,0x38];                       // в русской раскладке точка и запятая — на клавише «/»
    if(ch===',') return [2,0x38];
    if(ch==='?') return [2,0x24];                       // Shift+7
    if(ch==='"') return [2,0x1F];                       // Shift+2
    if(ch==='№') return [2,0x20];
    if(ch===':') return [2,0x23];
    if(ch===';') return [2,0x21];
    if(/[0-9 \n\t\-=]/.test(ch) || '!%*()_+'.includes(ch)) return hidCharKey(ch,'us');
    return null;
  }
  if(ch>='a' && ch<='z') return [0,0x04+ch.charCodeAt(0)-97];
  if(ch>='A' && ch<='Z') return [2,0x04+ch.charCodeAt(0)-65];
  if(ch>='1' && ch<='9') return [0,0x1D+(+ch)];
  if(ch==='0') return [0,0x27];
  if(HID_US_PLAIN[ch]!=null) return [0,HID_US_PLAIN[ch]];
  if(HID_US_SHIFT[ch]){ const k=hidCharKey(HID_US_SHIFT[ch],'us'); return [2,k[1]]; }
  return null;
}
// текст → список нажатий [{mod,key}] (символы без клавиши пропускаются, их число — в skipped)
function hidTextKeys(text,layout){
  const out=[]; let skipped=0;
  for(const ch of String(text||'').replace(/\r\n?/g,'\n')){ const k=hidCharKey(ch,layout||'us'); if(k) out.push({mod:k[0],key:k[1]}); else skipped++; }
  return {strokes:out,skipped};
}
// обратное: {mod,key} → символ (US) — для проверки «собрали → разобрали»
function hidKeyChar(mod,key){
  const shift=!!(mod&34);
  for(let c=32;c<127;c++){ const ch=String.fromCharCode(c), k=hidCharKey(ch,'us'); if(k && k[1]===key && !!(k[0]&2)===shift) return ch; }
  if(key===0x28) return '\n'; if(key===0x2B) return '\t';
  return '';
}

// ---------- отчёты: Build / Parse ----------
// клавиатура: 8 байт; keys — до 6 кодов
const hidKbdBuild=(mod,keys)=>{ const k=(keys||[]).filter(x=>x>0).slice(0,6); while(k.length<6) k.push(0); return [mod&255,0,...k]; };
function hidKbdParse(b){
  if(b.length<8) return null;
  const keys=b.slice(2,8).filter(x=>x>0);
  return {mod:b[0],keys,names:keys.map(k=>HID_KEYNAME[k]||('0x'+k.toString(16))),ctrl:!!(b[0]&17),shift:!!(b[0]&34),alt:!!(b[0]&68),gui:!!(b[0]&136)};
}
// светодиоды (output-отчёт клавиатуры): num, caps, scroll, compose, kana
const hidLedParse=b=>b.length ? {num:!!(b[0]&1),caps:!!(b[0]&2),scroll:!!(b[0]&4),compose:!!(b[0]&8),kana:!!(b[0]&16)} : null;
const hidLedBuild=l=>[(l.num?1:0)|(l.caps?2:0)|(l.scroll?4:0)|(l.compose?8:0)|(l.kana?16:0)];
// мышь: кнопки (бит 0 левая, 1 правая, 2 средняя), dx, dy, колесо, горизонтальная прокрутка — int8
const hidMouseBuild=(btn,dx,dy,wheel,pan)=>[btn&7,hidS8(dx)&255,hidS8(dy)&255,hidS8(wheel)&255,hidS8(pan)&255];
const s8=v=>v>127?v-256:v;
function hidMouseParse(b){ if(b.length<4) return null; return {btn:b[0]&7,left:!!(b[0]&1),right:!!(b[0]&2),middle:!!(b[0]&4),dx:s8(b[1]),dy:s8(b[2]),wheel:s8(b[3]),pan:b.length>4?s8(b[4]):0}; }
// media: 16-битный usage, little-endian (0 — отпущено)
const hidMediaBuild=u=>[u&255,(u>>8)&255];
function hidMediaParse(b){ if(b.length<2) return null; const u=b[0]|(b[1]<<8); return {usage:u,name:u?(HID_MEDIANAME[u]||('0x'+u.toString(16))):''}; }
// геймпад: кнопки (bit 0 = b1 … bit 15 = b16), hat 0…8, четыре оси −1…1 (→ int8), два триггера 0…1 (→ 0…255)
function hidPadBuild(f){
  const btn=f.btn|0, hat=(f.hat|0)&15, ax=v=>hidS8(Math.max(-1,Math.min(1,+v||0))*127)&255, tr=v=>hidU8(Math.max(0,Math.min(1,+v||0))*255);
  return [btn&255,(btn>>8)&255,hat,ax(f.x1),ax(f.y1),ax(f.x2),ax(f.y2),tr(f.lt),tr(f.rt)];
}
function hidPadParse(b){
  if(b.length<9) return null;
  const btn=b[0]|(b[1]<<8), q=v=>Math.round(s8(v)/127*100)/100, t=v=>Math.round(v/255*100)/100;
  const bs=[]; for(let i=0;i<16;i++) if(btn&(1<<i)) bs.push(i+1);
  return {btn,buttons:bs,hat:b[2]&15,x1:q(b[3]),y1:q(b[4]),x2:q(b[5]),y2:q(b[6]),lt:t(b[7]),rt:t(b[8])};
}
// крестовина из четырёх направлений (север / восток / юг / запад, 0/1) → hat 0…8
const hidHat=(up,right,down,left)=>[0,1,3,2,5,0,4,3,7,8,0,1,6,7,5,0][(up?1:0)|(right?2:0)|(down?4:0)|(left?8:0)];   // индекс = N | E<<1 | S<<2 | W<<3
const HID_HATDIR=['','N','NE','E','SE','S','SW','W','NW'];

// запись о разобранном отчёте — для узла «HID Report Decode»; id/длина определяют вид
function hidReportParse(device,id,bytes){
  if(device==='gamepad'){ const r=hidPadParse(bytes); return r ? {kind:'pad',...r,hatName:HID_HATDIR[r.hat]||''} : null; }
  if(id===1 && bytes.length===1){ const l=hidLedParse(bytes); return l ? {kind:'leds',...l} : null; }
  if(id===1){ const r=hidKbdParse(bytes); return r ? {kind:'key',...r} : null; }
  if(id===2){ const r=hidMouseParse(bytes); return r ? {kind:'mouse',...r} : null; }
  if(id===3){ const r=hidMediaParse(bytes); return r ? {kind:'media',...r} : null; }
  return null;
}

// ---------- команды для приложения ----------
// transport: 'bluetooth' (hid.*, BluetoothHidDevice) или 'usb' (usbhid.*: USB-гаджет через configfs, нужен root) — записи и отчёты те же
const hidUsb=t=>/^usb/i.test(String(t||''));
const hidCmdName=(t,what)=>(hidUsb(t) ? 'usbhid.' : 'hid.')+what;
function hidRegisterCmd(device,name,transport){
  const d=device && typeof device==='object' ? device : (HID_DEVICES[device]||HID_DEVICES.combo);
  return {cmd:hidCmdName(transport,'register'),...(hidUsb(transport) ? {} : {type:'custom'}),name:String(name||'').trim()||d.name||'DSP HID',descriptor:d.hex,subclass:d.subclass||0};
}
const hidReportCmd=(id,bytes,addr,transport)=>({cmd:hidCmdName(transport,'report'),...(addr && !hidUsb(transport)?{addr}:{}),rid:id,hex:hidxHex(bytes)});

// ---------- тачпад ----------
// Раскладка холста: сверху строка состояния, тачпад, под ним ряды кнопок
const HID_BUTTONS=[
  [['prev','⏮'],['play','⏯'],['next','⏭'],['mute','mute']],
  [['vol-','vol −'],['vol+','vol +'],['home','home'],['back','back']],
  [['mb1','left'],['mb4','middle'],['mb2','right'],['enter','enter']],
];
function hidPadLayout(W,H,rows){
  const R=rows||HID_BUTTONS, g=5, top=16, bh=Math.max(22,Math.min(38,H*.11)), n=R.length;
  const pad={x:g,y:top,w:W-2*g,h:Math.max(30,H-top-n*(bh+g)-g)};
  const btns=[]; R.forEach((row,r)=>{ const y=pad.y+pad.h+g+r*(bh+g), w=(W-g*(row.length+1))/row.length;
    row.forEach(([id,label],c)=>btns.push({id,label,x:g+c*(w+g),y,w,h:bh})); });
  return {pad,btns};
}
const hidHit=(L,x,y)=>{
  for(const b of L.btns) if(x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h) return {kind:'btn',id:b.id};
  const p=L.pad; if(x>=p.x && x<=p.x+p.w && y>=p.y && y<=p.y+p.h) return {kind:'pad'};
  return null;
};
// скорость курсора: пиксели касания → шаги мыши (gain — множитель, accel — доп. усиление быстрого движения)
const hidAccel=(d,gain,accel)=>d*gain*(1+(accel||0)*Math.min(Math.abs(d),30)/30);

// Жесты тачпада: один палец — движение, касание — левый клик, касание двумя — правый, касание-и-сразу-тянуть (второе касание ≤ dbl мс после первого) —
// перетаскивание с зажатой левой, два пальца — прокрутка (вертикаль — колесо, горизонталь — pan).
// down(id,x,y,t) / move(id,x,y,t) / up(id,t) возвращают список действий:
//   {a:'move',dx,dy} · {a:'scroll',wheel,pan} · {a:'press',b} · {a:'release',b} · {a:'click',b}
class HidTouch{
  constructor(o){ o=o||{}; this.gain=o.gain||1; this.accel=o.accel||0; this.scroll=o.scroll||.12; this.tapMs=o.tapMs||250; this.tapPx=o.tapPx||8; this.dbl=o.dbl||300; this.natural=!!o.natural;
    this.ptr=new Map(); this.rx=0; this.ry=0; this.sx=0; this.sy=0; this.maxN=0; this.t0=0; this.travel=0; this.lastTap=-1e9; this.drag=false; }
  down(id,x,y,t){
    const out=[];
    if(!this.ptr.size){ this.maxN=0; this.travel=0; this.t0=t; this.rx=this.ry=this.sx=this.sy=0;
      if(t-this.lastTap<=this.dbl){ this.drag=true; out.push({a:'press',b:1}); } }
    this.ptr.set(id,{x,y}); this.maxN=Math.max(this.maxN,this.ptr.size);
    return out;
  }
  move(id,x,y,t){
    const p=this.ptr.get(id); if(!p) return [];
    const dx=x-p.x, dy=y-p.y; p.x=x; p.y=y;
    const n=this.ptr.size, out=[];
    if(n===1){
      this.travel+=Math.abs(dx)+Math.abs(dy);
      this.rx+=hidAccel(dx,this.gain,this.accel); this.ry+=hidAccel(dy,this.gain,this.accel);
      const mx=Math.trunc(this.rx), my=Math.trunc(this.ry);
      if(mx||my){ this.rx-=mx; this.ry-=my; out.push({a:'move',dx:mx,dy:my}); }
    } else if(n===2){
      this.travel+=(Math.abs(dx)+Math.abs(dy))/2;
      const k=this.natural?-1:1; this.sx+=k*dx/2*this.scroll; this.sy+=-k*dy/2*this.scroll;
      const w=Math.trunc(this.sy), pn=Math.trunc(this.sx);
      if(w||pn){ this.sy-=w; this.sx-=pn; out.push({a:'scroll',wheel:w,pan:pn}); }
    }
    return out;
  }
  up(id,t){
    const out=[]; if(!this.ptr.delete(id)) return out;
    if(this.ptr.size) return out;
    const tap=t-this.t0<=this.tapMs && this.travel<=this.tapPx;
    if(this.drag){ this.drag=false; out.push({a:'release',b:1}); this.lastTap=-1e9; }
    else if(tap){ out.push({a:'click',b:this.maxN>=2?2:1}); this.lastTap=this.maxN>=2?-1e9:t; }
    else this.lastTap=-1e9;
    return out;
  }
}

// ---------- сборка исходящих кадров узла ----------
// Состояние клавиатуры / мыши и очередь отчётов {id, bytes}. Всё без таймеров: узел вызывает pump() по своим часам.
class HidOut{
  constructor(ids){ this.ids=ids||HID_DEVICES.combo.ids; this.mod=0; this.keys=[]; this.btn=0; this.q=[]; this.media=0; this.carry={dx:0,dy:0,wheel:0,pan:0}; }
  push(id,bytes){ if(id==null) return; this.q.push({id,bytes}); }
  keyDown(spec){
    if(!spec) return false;
    if(spec.media){ this.media=spec.media; this.push(this.ids.media,hidMediaBuild(spec.media)); return true; }
    this.mod|=spec.mod||0; if(spec.key && !this.keys.includes(spec.key)) this.keys.push(spec.key);
    this.push(this.ids.kbd,hidKbdBuild(this.mod,this.keys)); return true;
  }
  keyUp(spec){
    if(!spec) return;
    if(spec.media){ this.media=0; this.push(this.ids.media,hidMediaBuild(0)); return; }
    this.mod&=~(spec.mod||0); this.keys=this.keys.filter(k=>k!==spec.key);
    this.push(this.ids.kbd,hidKbdBuild(this.mod,this.keys));
  }
  tap(spec){ this.keyDown(spec); this.keyUp(spec); }
  type(text,layout){
    const r=hidTextKeys(text,layout);
    for(const s of r.strokes){ this.push(this.ids.kbd,hidKbdBuild(s.mod,[s.key])); this.push(this.ids.kbd,hidKbdBuild(0,[])); }
    return r;
  }
  releaseAll(){ this.mod=0; this.keys=[]; this.btn=0; this.media=0; this.push(this.ids.kbd,hidKbdBuild(0,[])); this.push(this.ids.mouse,hidMouseBuild(0,0,0,0,0)); this.push(this.ids.media,hidMediaBuild(0)); }
  button(b,down){ const m=b===1?1:b===2?2:4; this.btn=down?(this.btn|m):(this.btn&~m); this.push(this.ids.mouse,hidMouseBuild(this.btn,0,0,0,0)); }
  click(b){ this.button(b,true); this.button(b,false); }
  // относительное движение: накапливается и уходит кусками по ±127
  move(dx,dy,wheel,pan){
    const c=this.carry; c.dx+=dx||0; c.dy+=dy||0; c.wheel+=wheel||0; c.pan+=pan||0;
    for(let g=0; g<64; g++){
      const x=Math.trunc(Math.max(-127,Math.min(127,c.dx))), y=Math.trunc(Math.max(-127,Math.min(127,c.dy)));
      const w=Math.trunc(Math.max(-127,Math.min(127,c.wheel))), p=Math.trunc(Math.max(-127,Math.min(127,c.pan)));
      if(!x && !y && !w && !p) break;
      c.dx-=x; c.dy-=y; c.wheel-=w; c.pan-=p;
      this.push(this.ids.mouse,hidMouseBuild(this.btn,x,y,w,p));
    }
  }
  take(){ const q=this.q; this.q=[]; return q; }
}

// ---------- команды по пину cmd (записи rec: строки Table, Rule, свои) ----------
// {key:'vol+'} — нажать и отпустить · {key, down:1|0} — держать / отпустить · {page:12, code:233} или строка «Reference/HID Keys» — то же по коду ·
// {text:'…'} · {dx,dy,wheel,pan} · {click:1|2|3} · {btn:1|2|3, down:1|0} · {report:id, hex:'…'} — сырой отчёт (своё устройство) · {release:1}
// Возврат — действия для узла: {text}, {register}, {unregister}, {connect:addr}, {error}
function hidApplyCmd(o,c,alias){
  const act=[]; if(!c || typeof c!=='object' || c.src==='hidtx' || c.src==='hidrx') return act;
  const has=k=>c[k]!==undefined && c[k]!==null && c[k]!=='';
  const dn=has('down') ? (+c.down>0 || c.down===true || c.down==='1') : null;
  let spec=null;
  if(has('page') && has('code')) spec=c.kind==='modifier' ? {mod:+c.code,key:0} : hidSpecFromCode(c.page,c.code);
  else if(has('key')) spec=hidKeySpec(c.key,alias);
  else if(c.kind==='modifier' && has('code')) spec={mod:+c.code,key:0};
  else if(has('name') && has('kind') && has('code') && (c.kind==='key'||c.kind==='media')) spec=hidSpecFromCode(c.kind==='media' ? 12 : 7,c.code);
  if(spec){ if(dn===null) o.tap(spec); else if(dn) o.keyDown(spec); else o.keyUp(spec); }
  else if(has('key') || has('page')) act.push({error:'key: unknown «'+(has('key') ? c.key : c.page+'/'+c.code)+'»'});
  if(has('text')) act.push({text:String(c.text)});
  if(has('dx') || has('dy') || has('wheel') || has('pan')) o.move(+c.dx||0,+c.dy||0,+c.wheel||0,+c.pan||0);
  if(has('click')) o.click(+c.click||1);
  if(has('btn')) o.button(+c.btn||1,dn===null ? true : dn);
  if(has('report') && has('hex')){ const b=hidBytes(c.hex); if(b.length && b.length<=64) o.q.push({id:+c.report&255,bytes:b}); else act.push({error:'report: hex up to 64 bytes'}); }
  if(c.release) o.releaseAll();
  if(c.register) act.push({register:true});
  if(c.unregister) act.push({unregister:true});
  if(has('connect')) act.push({connect:String(c.connect)});
  return act;
}
