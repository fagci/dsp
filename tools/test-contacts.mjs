// Контакты: каноническая форма адресов, vCard, идентичности, слияние: node tools/test-contacts.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({Math, Uint8Array, TextEncoder, TextDecoder, Array, Map, Set, Error, String, Number, Object, Date, JSON, parseInt, RegExp});
vm.runInContext(fs.readFileSync(path.join(root, 'modules/contacts-kernels.js'), 'utf8'), ctx, {filename: 'contacts-kernels.js'});
vm.runInContext('this.K={ctPhone,ctAddr,ctKey,ctVcardParse,ctPersonRow,ctIdentRows,ctFromRec,ctFromPhoneRec,ctMergeTwo,ctDupGroups,ctMergePlan,ctBook,ctWho,ctFindPerson}', ctx);
const K = ctx.K;
let bad = 0;
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };

// телефон
eq('phone: formatted', K.ctPhone('+7 (916) 123-45-67'), '+79161234567');
eq('phone: 8 → +7', K.ctPhone('8 916 123 45 67'), '+79161234567');
eq('phone: 10 digits of a mobile → +7', K.ctPhone('9161234567'), '+79161234567');
eq('phone: 00 prefix', K.ctPhone('0049 30 123456'), '+4930123456');
eq('phone: international kept', K.ctPhone('+49 30 123456'), '+4930123456');
eq('phone: too short is not a phone', K.ctPhone('112'), '');
eq('phone: empty', K.ctPhone(''), '');
// адреса
eq('addr: email with name', K.ctAddr('email', 'Bob <Bob@Ex.ORG>'), 'bob@ex.org');
eq('addr: xmpp resource dropped', K.ctAddr('xmpp', 'Ann@Ex.org/phone'), 'ann@ex.org');
eq('addr: telegram @name', K.ctAddr('telegram', '@Ivan_K'), '@ivan_k');
eq('addr: telegram bare name', K.ctAddr('telegram', 'Ivan_K'), '@ivan_k');
eq('addr: telegram numeric id kept', K.ctAddr('telegram', '123456'), '123456');
eq('addr: irc op prefix and case', K.ctAddr('irc', '@Nick'), 'nick');
eq('addr: aprs upper', K.ctAddr('aprs', 'k1abc-9'), 'K1ABC-9');
eq('key: same phone, different writing', K.ctKey('sms', '8 916 123-45-67') === K.ctKey('sms', '+79161234567'), true);
eq('key: sms and phone are one address book entry kind', K.ctAddr('sms', '+7 916 123 45 67'), K.ctAddr('phone', '89161234567'));
eq('key: empty address', K.ctKey('email', ''), '');

// vCard: 3.0 со сложенными строками и экранированием
const v3 = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Петрова;Анна;;;\r\nFN:Анна Петрова\r\nTEL;TYPE=CELL:+7 (916) 123-45-67\r\nTEL;TYPE=HOME:8 495 111-22-33\r\nEMAIL;TYPE=INTERNET:Anna@Ex.org\r\nORG:ООО Ромашка;Отдел\r\nBDAY:1990-05-17\r\nNOTE:первая строка\\nвторая\\, с запятой\r\nCATEGORIES:друзья,радио\r\nEND:VCARD\r\n';
const c1 = K.ctVcardParse(v3)[0];
eq('vcard 3.0: name from N (given family)', c1.name, 'Анна Петрова');
eq('vcard 3.0: phones normalised', c1.phones, ['+79161234567', '+74951112233']);
eq('vcard 3.0: email', c1.emails, ['anna@ex.org']);
eq('vcard 3.0: org, birthday, tags', [c1.org, c1.birthday, c1.tags], ['ООО Ромашка, Отдел', '1990-05-17', ['друзья', 'радио']]);
eq('vcard 3.0: note unescaped', c1.note, 'первая строка\nвторая, с запятой');
// складывание строк
const folded = 'BEGIN:VCARD\nVERSION:3.0\nFN:Очень длинное\n  имя человека\nTEL:+7 999 000 11 22\nEND:VCARD\n';
eq('vcard: folded line is joined', K.ctVcardParse(folded)[0].name, 'Очень длинное имя человека');
// 2.1 с QUOTED-PRINTABLE (старые телефоны)
const qp = 'BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=98=D0=B2=D0=B0=D0=BD=D0=BE=D0=B2;=D0=98=D0=B2=D0=B0=D0=BD;;;\nTEL;CELL:89160000001\nEND:VCARD\n';
const c2 = K.ctVcardParse(qp)[0];
eq('vcard 2.1 quoted-printable name', c2.name, 'Иван Иванов');
eq('vcard 2.1 phone', c2.phones, ['+79160000001']);
// несколько карточек, карточка без имени берёт телефон
const many = K.ctVcardParse('BEGIN:VCARD\nTEL:+7 900 111 22 33\nEND:VCARD\nBEGIN:VCARD\nFN:Боб\nEND:VCARD\nBEGIN:VCARD\nNOTE:пустая\nEND:VCARD');
eq('vcard: nameless card is named by its phone, empty card dropped', many.map(c => c.name), ['+79001112233', 'Боб']);
eq('vcard: item1.TEL group prefix', K.ctVcardParse('BEGIN:VCARD\nFN:X\nitem1.TEL:+7 900 111 22 33\nEND:VCARD')[0].phones, ['+79001112233']);

// строки таблиц
const pr = K.ctPersonRow(c1);
eq('person row: multi values with « | »', [pr.name, pr.phones, pr.emails], ['Анна Петрова', '+79161234567 | +74951112233', 'anna@ex.org']);
const ids = K.ctIdentRows(c1, [{proto: 'telegram', addr: 'Anna_P'}, {proto: 'email', addr: 'ANNA@ex.org'}]);
eq('identities: phones, email once, extra', ids.map(i => i.key), ['phone:+79161234567', 'phone:+74951112233', 'email:anna@ex.org', 'telegram:@anna_p']);
eq('identities point back to the person', ids.every(i => i.contact === 'Анна Петрова'), true);

// из сообщения Messenger
eq('rec: email sender', K.ctFromRec({proto: 'email', dir: 'in', from: 'Bob', fromAddr: 'Bob@Ex.org'}), {proto: 'email', addr: 'bob@ex.org', name: 'Bob', key: 'email:bob@ex.org'});
eq('rec: telegram sender by name', K.ctFromRec({proto: 'telegram', dir: 'in', from: 'Ivan_K'}).key, 'telegram:@ivan_k');
eq('rec: own message ignored', K.ctFromRec({proto: 'irc', dir: 'out', from: 'me'}), null);
eq('rec: a feed is not a person', K.ctFromRec({proto: 'rss', dir: 'in', from: 'site'}), null);
eq('rec: no sender', K.ctFromRec({proto: 'irc', dir: 'in', from: ''}), null);
eq('phone rec: contacts.find row', K.ctFromPhoneRec({src: 'contact', id: '5', name: 'Мама', phones: ['8 916 000-00-01', '+7 916 000 00 01']}), {name: 'Мама', phones: ['+79160000001'], emails: [], org: '', note: '', birthday: '', tags: []});
eq('phone rec: other rows ignored', K.ctFromPhoneRec({src: 'sms', name: 'x'}), null);

// слияние
const people = [
  {name: 'Аня', phones: '+79161234567', emails: '', org: '', note: 'коллега', tags: 'работа'},
  {name: 'Анна Петрова', phones: '+74951112233', emails: 'anna@ex.org', org: 'Ромашка', note: '', tags: 'друзья'},
  {name: 'Боб', phones: '+79990001122', emails: '', org: '', note: '', tags: ''},
  {name: 'anna_tg', phones: '', emails: '', org: '', note: '', tags: ''},
];
const idents = [
  {proto: 'phone', addr: '+79161234567', contact: 'Аня', key: 'phone:+79161234567'},
  {proto: 'phone', addr: '+79161234567', contact: 'Анна Петрова', key: 'phone:+79161234567'},   // тот же номер у двух людей
  {proto: 'email', addr: 'anna@ex.org', contact: 'Анна Петрова', key: 'email:anna@ex.org'},
  {proto: 'telegram', addr: '@anna_p', contact: 'anna_tg', key: 'telegram:@anna_p'},
  {proto: 'phone', addr: '+79990001122', contact: 'Боб', key: 'phone:+79990001122'},
];
const groups = K.ctDupGroups(people, idents);
eq('duplicates: those sharing an identity', groups, [['Аня', 'Анна Петрова']]);
const plan = K.ctMergePlan(people, idents, groups[0]);
eq('merge: the fuller person stays', plan.target, 'Анна Петрова');
eq('merge: phones joined, no repeats', plan.person.phones, '+74951112233 | +79161234567');
eq('merge: tags joined, note kept', [plan.person.tags, plan.person.note, plan.person.org], ['друзья | работа', 'коллега', 'Ромашка']);
eq('merge: the other one is removed', plan.remove, ['Аня']);
eq('merge: its identities move to the target', plan.idents.map(i => [i.key, i.contact]), [['phone:+79161234567', 'Анна Петрова']]);
eq('merge: nothing to merge for one', K.ctMergePlan(people, idents, ['Боб']), null);
eq('merge: notes are not repeated', K.ctMergeTwo({note: 'a'}, {note: 'a'}).note, 'a');
// общий телефон в самих полях, без таблицы идентичностей
eq('duplicates: by phone fields', K.ctDupGroups([{name: 'A', phones: '8 916 111 22 33'}, {name: 'B', phones: '+79161112233'}], []), [['A', 'B']]);
// без ложных срабатываний
eq('duplicates: different people stay apart', K.ctDupGroups([{name: 'A', phones: '+79161112233'}, {name: 'B', phones: '+79161112244'}], []), []);

// адресная книга и «кто это»
const book = K.ctBook(people, idents);
eq('book: name → address per identity', book.find(b => b.proto === 'telegram'), {name: 'anna_tg', addr: '@anna_p', proto: 'telegram'});
eq('book: Messenger resolves a name (case-insensitive)', book.filter(b => b.name === 'Боб').length, 1);
eq('who: key → first person', K.ctWho(idents).get('email:anna@ex.org'), 'Анна Петрова');
// импорт без дублей
eq('import: existing person found by a differently written phone', K.ctFindPerson(people, {phones: ['+7 (495) 111-22-33'], emails: []}), 'Анна Петрова');
eq('import: found by email case-insensitive', K.ctFindPerson(people, {phones: [], emails: ['ANNA@EX.ORG']}), 'Анна Петрова');
eq('import: a new person is not found', K.ctFindPerson(people, {phones: ['+7 900 000 00 00'], emails: []}), '');

console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
