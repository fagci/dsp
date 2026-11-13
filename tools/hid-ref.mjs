// Справочники HID для списков Table «Reference/HID Devices» и «Reference/HID Keys»: node tools/hid-ref.mjs → data/hid-ref.json
// Строятся из ядра (modules/hid-kernels.js) — одна правда для узлов и таблиц; тест (tools/test-hid.mjs) проверяет, что строки и ядро совпадают.
import fs from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,parseInt,isFinite});
vm.runInContext(fs.readFileSync(new URL('../modules/hid-kernels.js',import.meta.url),'utf8')+';this.K={hidRefDevices,hidRefKeys}',ctx);
const dev=ctx.K.hidRefDevices(), keys=ctx.K.hidRefKeys();
const out={source:'generated from modules/hid-kernels.js (USB HID Usage Tables: pages 0x07 keyboard, 0x0C consumer)',
  devices:{cols:['name','title','subclass','ids','reports','descriptor','note'],rows:dev},
  keys:{cols:['name','kind','page','code','hex','group','note'],rows:keys}};
fs.writeFileSync(new URL('../data/hid-ref.json',import.meta.url),JSON.stringify(out));
console.log('data/hid-ref.json:',dev.length,'devices,',keys.length,'codes');
