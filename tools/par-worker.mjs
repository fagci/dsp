// worker thread of tools/test-dvbt2-par.mjs: one DvbOfdm instance running frame jobs
import {parentPort} from 'node:worker_threads';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Float32Array,Array,Error,Promise,Object,JSON,WebAssembly,TextDecoder,TextEncoder,DataView,console});
vm.runInContext(fs.readFileSync(path.join(root,'modules/leandvb-kernels.js'),'utf8')+';this.DvbOfdm=DvbOfdm;',ctx);
const d=await ctx.DvbOfdm.create(fs.readFileSync(path.join(root,'vendor/dvbofdm.wasm'))); d.initPool();
parentPort.on('message',m=>{ const o=d.run(new Uint8Array(m.d)); parentPort.postMessage({seq:m.seq,d:o.buffer},[o.buffer]); });
parentPort.postMessage({ready:true});
