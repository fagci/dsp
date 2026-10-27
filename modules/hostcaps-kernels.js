"use strict";
/* Что не работает в этом окружении — не показываем: модули и встроенные пресеты, которым нужен API, которого нет в браузере
   (в WebView приложения Android нет Web Bluetooth / HID / NFC). Без DOM — tools/test-hostcaps.mjs */

// модуль → нужная возможность
const HOSTCAPS_NEEDS={bleUart:'bluetooth', bleGatt:'bluetooth', bleAdv:'bluetooth', hid:'hid', funcube:'hid', nfc:'nfc', dvbUsb:'usb'};

function hostcapsEnv(){
  try{
    return {bluetooth:!!navigator.bluetooth, hid:!!navigator.hid, nfc:typeof NDEFReader!=='undefined', usb:!!navigator.usb};
  }catch(e){ return {bluetooth:true,hid:true,nfc:true,usb:true}; }        // не удалось определить — ничего не прячем
}
let hostcapsMemo=null;
const hostcapsNow=()=>hostcapsMemo||(hostcapsMemo=hostcapsEnv());

const hostcapsHidden=(id,env=hostcapsNow())=>{ const k=HOSTCAPS_NEEDS[id]; return !!k && !env[k]; };
// встроенный пресет с хотя бы одним спрятанным модулем прячется целиком: открыть его всё равно нечем
const hostcapsPatchHidden=(patch,env=hostcapsNow())=>!!patch && Array.isArray(patch.nodes) && patch.nodes.some(n=>n && hostcapsHidden(n.type,env));
