// Умный поиск Table: регистр, ё/е, раскладка, ФИО в любом порядке, номера телефонов: node tools/test-dbsearch.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({String, Array, Object, RegExp, Math});
vm.runInContext(fs.readFileSync(path.join(root, 'modules/dbsearch-kernels.js'), 'utf8'), ctx, {filename: 'dbsearch-kernels.js'});
vm.runInContext('this.K={dbFold,dbLayout,dbWords,dbPhoneDigits,dbIsPhoneCol,dbTerm,dbMatch}', ctx);
const K = ctx.K;
let bad = 0;
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };
// строка таблицы: любое слово запроса (все термы) должно совпасть с каким-либо полем
const hit = (row, q) => q.split(/\s+/).filter(Boolean).map(K.dbTerm).every(t => Object.entries(row).some(([c, v]) => K.dbMatch(t, v, c)));

eq('fold: case, ё, diacritics', [K.dbFold('ЁЖик'), K.dbFold('Élodie'), K.dbFold('Müller')], ['ежик', 'elodie', 'muller']);
eq('layout: latin typed on the russian keys', K.dbLayout('ghbdtn'), 'привет');
eq('layout: not a keyboard word', K.dbLayout('hello world'), '');
eq('phone digits: 8 → 7, 00 dropped', [K.dbPhoneDigits('8 (916) 123-45-67'), K.dbPhoneDigits('+7 916 123 45 67'), K.dbPhoneDigits('0049 30 123456')], ['79161234567', '79161234567', '4930123456']);
eq('phone column names', ['phone', 'Phones', 'tel', 'Мобильный', 'телефон', 'mobile_2', 'name', 'freq', 'telemetry'].map(K.dbIsPhoneCol), [true, true, true, true, true, true, false, false, false]);

const ann = {name: 'Анна Петрова', phones: '+79161234567 | +74951112233', emails: 'anna@ex.org', org: 'Ромашка', freq: '145500000'};
eq('name: full', hit(ann, 'анна'), true);
eq('name: any order, word starts', hit(ann, 'петр анн'), true);
eq('name: ё = е and case', hit({name: 'Фёдор Ёлкин'}, 'федор елкин'), true);
eq('name: wrong layout', hit(ann, 'fyyf'), true);                       // «анна» набрано на латинской раскладке
eq('name: a different person is not found', hit(ann, 'борис'), false);
eq('name: only word starts, not the middle', hit(ann, 'етрова'), false);
eq('email: the address is a word', hit(ann, 'anna@ex.org'), true);
// телефоны
eq('phone: the last digits', hit(ann, '4567'), true);
eq('phone: with spaces', hit(ann, '916 123'), true);
eq('phone: full, formatted', hit(ann, '+7 (916) 123-45-67'), true);
eq('phone: written with 8', hit(ann, '89161234567'), true);
eq('phone: second number of the field', hit(ann, '111-22-33'), true);
eq('phone: a wrong number', hit(ann, '4568'), false);
eq('terms: pieces of a number are checked inside the phone digits', [hit(ann, '+7 (916) 123-45-67'), hit(ann, '+7 (916) 123-45-68')], [true, false]);
eq('phone: a short piece is looked for inside phone columns only', [hit({name: 'x', phones: '+79161234567'}, '123'), hit({name: 'x', note: '79161234567'}, '123'), hit({name: 'x', phones: '+79161234567'}, '999')], [true, false, false]);
eq('phone: only phone columns — a frequency is not matched inside', hit({name: 'x', freq: '145500000'}, '5500'), false);
eq('phone: a frequency still matches from its start', hit({name: 'x', freq: '145500000'}, '1455'), true);
eq('phone: column named tel', hit({name: 'x', tel: '8 800 555 35 35'}, '555-35-35'), true);
eq('phone: both name and phone in one query', hit(ann, 'анна 4567'), true);
eq('phone: name of another person with the right number', hit(ann, 'борис 4567'), false);
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
