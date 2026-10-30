"use strict";
/* ============================ Значки устройств — ядро ============================
   Библиотека простых значков (SVG 24×24, без сети) для сетевых и радиоустройств и правило «запись → значок» по полям:
   явное icon / devtype / type, затем имя, производитель (OEM), класс Bluetooth, службы, порты.
   dvIconKey(rec) → ключ или '' (не угадали); dvIconUri(ключ,цвет) → data:-адрес картинки для Graph (image) и любых <img>.
   Граф берёт значок сам, если у узла нет ни shape / image / glyph; токен {@icon} в правилах Rec → Entities даёт ключ.
   Проверяется в tools/test-devicon.mjs. */

const DV_ICONS={
  router:'<rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 17h.01M10 17h.01M8 14l-2-5M16 14l2-5"/>',
  switch:'<rect x="2" y="9" width="20" height="8" rx="1.5"/><path d="M5 13h.01M8 13h.01M11 13h.01M14 13h.01M17 13h.01"/>',
  ap:'<path d="M4 9a11 11 0 0 1 16 0M7 12.5a7 7 0 0 1 10 0M10 16a3 3 0 0 1 4 0"/><circle cx="12" cy="19.5" r="1"/>',
  modem:'<rect x="3" y="12" width="18" height="8" rx="1.5"/><path d="M7 16h.01M10 16h.01M16 12V6M13 8l3-3 3 3"/>',
  phone:'<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  tablet:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 18h2"/>',
  laptop:'<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M2.5 19h19l-2-4h-15z"/>',
  desktop:'<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  server:'<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  nas:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h3"/>',
  camera:'<rect x="3" y="7" width="14" height="10" rx="2"/><path d="M17 11l4-2.5v7L17 13"/>',
  tv:'<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  printer:'<path d="M7 9V3h10v6M7 17H4V9h16v8h-3"/><rect x="7" y="14" width="10" height="7"/>',
  speaker:'<rect x="6" y="2.5" width="12" height="19" rx="2"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7" r="1"/>',
  headphones:'<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  watch:'<rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M9 7l.7-4h4.6l.7 4M9 17l.7 4h4.6l.7-4M12 10v2.5l1.5 1"/>',
  car:'<path d="M3 15v-3l2-5h14l2 5v3zM3 15v3h3v-3M18 15v3h3v-3"/><path d="M7 12h.01M17 12h.01"/>',
  tag:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4V2"/>',
  bulb:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  plug:'<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  drone:'<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><path d="M7 8l2 2M17 8l-2 2M7 16l2-2M17 16l-2-2"/>',
  gamepad:'<rect x="2.5" y="7" width="19" height="11" rx="5"/><path d="M7 10.5v4M5 12.5h4M16 11h.01M18 14h.01"/>',
  sensor:'<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17"/>',
  radio:'<rect x="3" y="8" width="18" height="12" rx="2"/><circle cx="15" cy="14" r="3"/><path d="M7 12h3M7 16h3M6 8l11-5"/>',
  antenna:'<path d="M12 12v9M8 21h8M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 4.5a10.6 10.6 0 0 1 0 15"/><circle cx="12" cy="12" r="1.5"/>',
  tower:'<path d="M12 8l-5 13M12 8l5 13M9 15h6M10.5 11h3"/><circle cx="12" cy="5" r="1.5"/><path d="M7.5 3.5a6 6 0 0 0 0 3M16.5 3.5a6 6 0 0 1 0 3"/>',
  sim:'<path d="M6 2h8l5 5v15H6z"/><rect x="9" y="12" width="7" height="7" rx="1"/>',
  bluetooth:'<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  wifi:'<path d="M2.5 9a14 14 0 0 1 19 0M6 12.5a9 9 0 0 1 12 0M9.3 16a4.3 4.3 0 0 1 5.4 0"/><circle cx="12" cy="19.5" r="1"/>',
  iot:'<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  device:'<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h8M8 14h5"/>',
};
// правила по тексту имён и производителя; порядок важен — первое совпадение
const DV_RULES=[
  ['router',/\b(router|gateway|mikrotik|routerboard|keenetic|tp-?link\s*(archer|tl-)?|asus\s*rt-|zyxel|huawei\s*(hg|b\d)|dir-\d|openwrt|ubiquiti\s*(edgerouter|udm))\b/i],
  ['switch',/\b(switch|catalyst|procurve|edgeswitch|poe\s*switch)\b/i],
  ['ap',/\b(access\s*point|\bap\b|unifi|uap-|cap\s*ac|eero|deco|mesh|repeater|extender|wlan\s*ap)\b/i],
  ['modem',/\b(modem|cpe|ont\b|gpon|lte\s*router|mifi|hotspot|dongle)\b/i],
  ['camera',/\b(camera|cam\b|ipcam|hikvision|dahua|reolink|onvif|rtsp|doorbell|nvr|dvr|wyze|ezviz|imou|axis\s*\w*cam|gopro)\b/i],
  ['tv',/\b(tv|smart\s*tv|bravia|webos|tizen|roku|chromecast|fire\s*tv|android\s*tv|apple\s*tv|vizio|hisense|dlna\s*renderer|miracast)\b/i],
  ['printer',/\b(printer|laserjet|deskjet|officejet|ecotank|brother\s*(hl|mfc|dcp)|canon\s*(mf|lbp|pixma)|epson|xerox|lexmark|mfp|scanner)\b/i],
  ['speaker',/\b(speaker|soundbar|sonos|homepod|echo\s*(dot|show)?|alexa|jbl|bose|marshall|boombox|yandex\s*(station|dot)|google\s*home|nest\s*(mini|audio)|bluesound|airplay)\b/i],
  ['headphones',/\b(headphones?|earbuds?|airpods?|buds|earphones?|headset|wh-1000|wf-1000|galaxy\s*buds|powerbeats|freebuds|redmi\s*buds)\b/i],
  ['watch',/\b(watch|band\b|mi\s*band|fitbit|garmin|amazfit|galaxy\s*fit|huawei\s*band|wear\s*os|whoop|oura|tracker\s*band)\b/i],
  ['tag',/\b(airtag|smarttag|tile\b|chipolo|tag\b|tracker|find\s*my|beacon|ibeacon|eddystone)\b/i],
  ['car',/\b(car\b|auto\b|vehicle|toyota|bmw|audi|tesla|carplay|android\s*auto|obd|elm327|ford\s*sync|hands-?free\s*kit)\b/i],
  ['drone',/\b(drone|dji|mavic|phantom|parrot\s*(anafi|bebop)|uav|quadcopter|remote\s*id|skydio|autel)\b/i],
  ['gamepad',/\b(gamepad|controller|joy-?con|dualshock|dualsense|xbox|playstation|ps[345]\b|nintendo|switch\s*pro|steam\s*(deck|controller)|joystick)\b/i],
  ['nas',/\b(nas\b|synology|qnap|diskstation|readynas|wd\s*my\s*cloud|truenas|unraid)\b/i],
  ['server',/\b(server|esxi|proxmox|vmware|idrac|ilo\b|supermicro|poweredge|proliant|vm\b)\b/i],
  ['laptop',/\b(laptop|notebook|macbook|thinkpad|latitude|xps|zenbook|vivobook|surface\s*(laptop|book|pro)|chromebook|ideapad|pavilion|probook)\b/i],
  ['desktop',/\b(desktop|imac|mac\s*(mini|pro|studio)|workstation|optiplex|thinkcentre|\bpc\b|raspberry|raspberrypi|nuc\b)\b/i],
  ['tablet',/\b(ipad|tablet|galaxy\s*tab|mediapad|lenovo\s*tab|kindle|fire\s*hd)\b/i],
  ['phone',/\b(iphone|phone|pixel\s*\d|galaxy\s*(s|a|z|note)\d|xiaomi|redmi|poco|oneplus|oppo|vivo|realme|honor|huawei\s*p|nokia|motorola|moto\s*g|samsung\s*sm-|android)\b/i],
  ['bulb',/\b(bulb|lamp|light|led\s*strip|hue|yeelight|lifx|tradfri|wiz\b|govee|nanoleaf|philips\s*hue)\b/i],
  ['plug',/\b(plug|socket|outlet|relay|sonoff|shelly|tasmota|smart\s*switch|tuya|power\s*strip|kasa)\b/i],
  ['sensor',/\b(sensor|thermometer|hygrometer|temperature|humidity|co2|smoke|motion|pir\b|xiaomi\s*mijia|ruuvi|switchbot|aqara|zigbee|z-wave|thermostat|nest\s*protect|weather)\b/i],
  ['tower',/\b(cell|bts\b|enodeb|gnodeb|base\s*station|lac\b|plmn|gsm-si|lte-sib)\b/i],
  ['radio',/\b(radio|transceiver|sdr\b|rtl-?sdr|hackrf|airspy|uv-?k5|baofeng|walkie|dmr|lora|meshtastic|ham\b)\b/i],
  ['antenna',/\b(antenna|ant\b)\b/i],
  ['iot',/\b(esp32|esp8266|espressif|arduino|stm32|nrf5\d|nordic|iot|microcontroller|tuya|shelly)\b/i],
];
// Bluetooth Class of Device, главный класс; GAP-appearance (BLE) — по старшим битам категории
const DV_MAJOR={computer:'laptop',phone:'phone',lan:'router',audio:'headphones',peripheral:'gamepad',imaging:'printer',wearable:'watch',health:'sensor',toy:'gamepad'};
const DV_UUID={'180d':'watch','1812':'gamepad','110b':'headphones','110a':'headphones','111e':'phone','1800':'','181a':'sensor','181c':'','1826':'watch'};
// ключ значка по записи: '' — не угадали
function dvIconKey(r){
  if(!r || typeof r!=='object') return '';
  for(const k of ['icon','devtype','device_type','kind']){ const v=String(r[k]??'').trim().toLowerCase(); if(v && DV_ICONS[v]) return v; }
  const major=String(r.major??'').trim().toLowerCase(); if(DV_MAJOR[major]) return DV_MAJOR[major];
  const t=String(r.type??'').trim().toLowerCase();
  if(DV_ICONS[t] && t!=='device') return t;
  const txt=[r.name,r.label,r.model,r.product,r.hostname,r.vendor,r.oem,r.mfr,r.wpsMfr,r.manufacturer,r.ssid,r.service,r.banner,r.server,r.upnp,r.type,r.os,r.proto==='ble' ? '' : ''].filter(x=>x!=null && x!=='').join(' ');
  if(txt) for(const [k,re] of DV_RULES) if(re.test(txt)) return k;
  const u=Array.isArray(r.uuids) ? r.uuids : typeof r.uuids==='string' ? r.uuids.split(/[\s,]+/) : [];
  for(const x of u){ const s=String(x).toLowerCase().replace(/^0x/,'').replace(/^0000([0-9a-f]{4})-.*$/,'$1'); if(DV_UUID[s]) return DV_UUID[s]; }
  const ports=new Set((Array.isArray(r.ports) ? r.ports : String(r.ports??'').split(/[\s,]+/)).map(Number));
  if(ports.has(554)||ports.has(8554)) return 'camera';
  if(ports.has(9100)||ports.has(631)) return 'printer';
  if(ports.has(5000)&&ports.has(5001)) return 'nas';
  if(ports.has(22)&&(ports.has(80)||ports.has(443))&&ports.size>=3) return 'server';
  if(r.src==='ble' || r.proto==='ble') return 'bluetooth';
  if(r.src==='bt') return 'bluetooth';
  if(r.src==='wifi' || r.proto==='wifi') return r.bssid ? 'ap' : '';
  return '';
}
const dvIconUris=new Map();
// data:-адрес круглого значка: фон bg (по умолчанию тёмно-синий), штрих светлый
function dvIconUri(key,bg){
  const body=DV_ICONS[key]||DV_ICONS.device, ck=key+'|'+(bg||''), hit=dvIconUris.get(ck); if(hit) return hit;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 32 32" width="96" height="96"><circle cx="12" cy="12" r="15.5" fill="'+(bg||'#2b3a4d')+'"/><g fill="none" stroke="#eaf2ff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+body+'</g></svg>';
  const u='data:image/svg+xml;utf8,'+encodeURIComponent(svg);
  if(dvIconUris.size>400) dvIconUris.clear();
  dvIconUris.set(ck,u); return u;
}
