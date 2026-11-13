// Голосовые из Telegram → Whisper: выбор вложений для распознавания и итоговая запись (node tools/test-tgvoice.mjs)
import fs from 'node:fs';
import vm from 'node:vm';
import {loadMsgr} from './node/load.mjs';
const M = loadMsgr();
const ctx = vm.createContext({Math, JSON, Date, Set, Array, Object, String, Number, console});
vm.runInContext(fs.readFileSync(new URL('../modules/whisper-kernels.js', import.meta.url), 'utf8'), ctx);
const W = vm.runInContext('({wsFileJobs, wsDoneRec})', ctx);
let bad = 0;
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };

const row = (id, atts, ref) => ({id, from: 'bob', ref, text: '', atts});
const seen = new Set();
const voice = {name: 'voice-m100-5.ogg', mime: 'audio/ogg', fid: 11, kind: 'voice', dur: 7};
const doc = {name: 'a.pdf', mime: 'application/pdf', fid: 12};
const jobs = W.wsFileJobs([row('1', [voice], '-100:5'), row('2', [doc], '-100:6'), row('3', [], '-100:7'), {id: '4', text: 'без вложения'}], seen);
eq('only audio and video attachments with a Files number become jobs', jobs, [{fid: 11, name: 'voice-m100-5.ogg', ref: '-100:5', from: 'bob'}]);
eq('the same attachment is not taken twice', W.wsFileJobs(row('1', [voice], '-100:5'), seen), []);
eq('a lone record with fid is a job too (any module can feed it)', W.wsFileJobs({fid: 20, name: 'x.wav', mime: 'audio/wav'}, new Set()).map(j => [j.fid, j.name]), [[20, 'x.wav']]);
eq('a video note is accepted', W.wsFileJobs(row('9', [{name: 'c.mp4', mime: 'video/mp4', fid: 30}], '1:1'), new Set()).length, 1);
eq('without mime the file is tried (phone recorders often omit it)', W.wsFileJobs(row('8', [{name: 'm', fid: 31}], '1:1'), new Set()).length, 1);

const d = W.wsDoneRec({...jobs[0], texts: ['привет', ' это  тест ']}, '');
eq('done record: text, chat of the reply, link to the message', [d.text, d.room, d.ref, d.from, d.fid, d.kind, d.err], ['привет это тест', '-100', '-100:5', 'bob', 11, 'transcript', undefined]);
eq('done record carries the error', W.wsDoneRec({...jobs[0], texts: []}, 'decode failed').err, 'decode failed');

// круг: голосовое → Bot API → разбор → вложение → задание Whisper → ответ в тот же чат
{ const upd = M.mgTgUpdate({update: 1, chat: 42, mid: 9, from: 'anna', t: 1000, file: {kind: 'voice', id: 'F', mime: 'audio/ogg', size: 10, dur: 2}});
  const m = M.mgTgUpdates({result: [upd]}, '').msgs[0];
  const logged = {id: m.id, from: m.from, ref: m.ref, atts: [{name: m.file.name, mime: m.file.mime, fid: 5}]};   // что Messenger кладёт в rec после сохранения в Files
  const j = W.wsFileJobs(logged, new Set())[0];
  eq('loopback: the reply goes to the chat of the voice message', W.wsDoneRec({...j, texts: ['ок']}, '').room, '42'); }

console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
