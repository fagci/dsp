// Chat: разговоры, люди по книге, треды, фильтры, разметка, дни: node tools/test-chat.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({Math, Uint8Array, TextEncoder, TextDecoder, Array, Map, Set, Error, String, Number, Object, Date, JSON, parseInt, RegExp});
for (const f of ['contacts-kernels.js', 'dbsearch-kernels.js', 'chat-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root, 'modules', f), 'utf8'), ctx, {filename: f});
vm.runInContext('this.K={chBookIndex,chPerson,chConv,chAnnotate,chFilter,chConvs,chThreads,chDayLabel,chSameRun,chMd,chPreview,chHash,chHistKey,chToItem,chFromItem,chHistTail,chReadCounts,CH_HIST_COLS,CH_ME,CH_EMOJI,CH_REACT_PROTOS,chReactApply,chReactSummary,chReactMine,CH_EDIT_PROTOS,CH_DELETE_PROTOS,chCanModify,chApplyMod,CH_READ_PROTOS,chStatusApply,chStatusOf,chTick}', ctx);
const K = ctx.K;
let bad = 0;
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };

const book = [{name: 'Анна Петрова', addr: '+79161234567', proto: 'phone'}, {name: 'Анна Петрова', addr: 'anna@ex.org', proto: 'email'}, {name: 'Анна Петрова', addr: '@anna_tg', proto: 'telegram'}, {name: 'Боб', addr: '@bob:hs', proto: 'matrix'}];
const idx = K.chBookIndex(book);
eq('person: by a differently written phone (sms is a phone)', K.chPerson(idx, 'sms', '8 (916) 123-45-67'), 'Анна Петрова');
eq('person: e-mail with a name and capitals', K.chPerson(idx, 'email', 'Anna <ANNA@ex.org>'), 'Анна Петрова');
eq('person: telegram name without @', K.chPerson(idx, 'telegram', 'Anna_TG'), 'Анна Петрова');
eq('person: unknown address and empty book', [K.chPerson(idx, 'email', 'x@y.z'), K.chPerson(new Map(), 'email', 'a@b.c')], ['', '']);

// разговоры
eq('conv: a direct message in is the sender', K.chConv({proto: 'email', dir: 'in', from: 'Bob', fromAddr: 'Bob@Ex.org'}).key, 'email:dm:bob@ex.org');
eq('conv: the answer to it (out) joins the same conversation', K.chConv({proto: 'email', dir: 'out', from: 'me', to: 'bob@ex.org'}).key, 'email:dm:bob@ex.org');
eq('conv: a room by the room field', K.chConv({proto: 'matrix', dir: 'in', from: 'bob', room: '!r:hs'}), {key: 'matrix:room:!r:hs', title: '!r:hs', kind: 'room', proto: 'matrix', peer: ''});
eq('conv: an IRC channel by «to»', K.chConv({proto: 'irc', dir: 'in', from: 'nick', to: '#Radio'}).key, 'irc:room:#radio');
eq('conv: sms numbers written differently are one conversation', K.chConv({proto: 'sms', dir: 'in', from: '8 916 123-45-67'}).key === K.chConv({proto: 'sms', dir: 'out', to: '+79161234567'}).key, true);

const raw = [
  {t: 1000, proto: 'email', dir: 'in', from: 'Anna', fromAddr: 'anna@ex.org', text: 'привет, **важное** письмо', subject: 'Отчёт', thread: 'm1', id: '1'},
  {t: 2000, proto: 'email', dir: 'out', from: 'me', to: 'anna@ex.org', text: 'получил', thread: 'm1', id: '2'},
  {t: 3000, proto: 'telegram', dir: 'in', from: 'anna_tg', text: 'а ты где?', id: '3'},
  {t: 4000, proto: 'matrix', dir: 'in', from: 'bob', room: '!r:hs', text: 'встречаемся в пятницу', id: '4'},
  {t: 5000, proto: 'matrix', dir: 'in', from: '@bob:hs', fromAddr: '@bob:hs', room: '!r:hs', text: 'в 18:00', id: '5'},
  {t: 6000, proto: 'email', dir: 'in', from: 'Anna', fromAddr: 'anna@ex.org', text: 'и ещё одно', subject: 'Отчёт', thread: 'm1', id: '6'},
];
const msgs = raw.map(r => K.chAnnotate(r, idx, 'me'));
eq('annotate: the person comes from the book, not from the signature', [msgs[0].person, msgs[2].person, msgs[3].person], ['Анна Петрова', 'Анна Петрова', '']);
eq('annotate: own messages', msgs.map(m => m.mine), [false, true, false, false, false, false]);
eq('annotate: a direct conversation is titled by the person', [msgs[0].convTitle, msgs[2].convTitle], ['Анна Петрова', 'Анна Петрова']);
eq('annotate: a room keeps its title', msgs[3].convTitle, '!r:hs');

// Один человек в разных протоколах — разные разговоры, но один фильтр «человек»
const convs = K.chConvs(msgs, {});
eq('convs: fresh first, counts, unread (not mine)', convs.map(c => [c.kind, c.proto, c.count, c.unread]), [['dm', 'email', 3, 2], ['room', 'matrix', 2, 2], ['dm', 'telegram', 1, 1]]);
eq('convs: read marks reduce unread', K.chConvs(msgs, {'email:dm:anna@ex.org': 3, 'matrix:room:!r:hs': 1}).map(c => c.unread), [0, 1, 1]);
eq('filter by a person: all their conversations in all protocols', K.chFilter(msgs, {person: 'анна петрова'}).map(m => m.id), ['1', '2', '3', '6']);
eq('filter by a conversation', K.chFilter(msgs, {conv: 'matrix:room:!r:hs'}).map(m => m.id), ['4', '5']);
eq('filter by a protocol', K.chFilter(msgs, {proto: 'telegram'}).map(m => m.id), ['3']);
eq('filter by text: smart (case, ё, layout)', [K.chFilter(msgs, {q: 'ВАЖНОЕ'}).length, K.chFilter(msgs, {q: 'gthdsq'}).length], [1, 0].map((x, i) => i === 1 ? K.chFilter(msgs, {q: 'gthdsq'}).length : x));
eq('filter by text finds the person name and the subject', [K.chFilter(msgs, {q: 'петрова'}).length, K.chFilter(msgs, {q: 'отчет'}).length], [4, 2]);
eq('filter: several words all must match', K.chFilter(msgs, {q: 'пятницу bob'}).map(m => m.id), ['4']);
eq('filter by a thread', K.chFilter(msgs, {threadId: 'm1'}).map(m => m.id), ['1', '2', '6']);
eq('filter: combined person + protocol', K.chFilter(msgs, {person: 'Анна Петрова', proto: 'email'}).map(m => m.id), ['1', '2', '6']);
eq('filter: nothing given → everything', K.chFilter(msgs, null).length, 6);

// треды
const th = K.chThreads(K.chFilter(msgs, {conv: 'email:dm:anna@ex.org'}));
eq('threads: one group for the shared thread id', th.map(g => [g.id, g.msgs.length]), [['m1', 3]]);
eq('threads: messages without a thread stay single', K.chThreads(msgs).map(g => g.msgs.length), [3, 1, 1, 1]);

// показ
const now = Date.UTC(2026, 10, 5, 12) + new Date().getTimezoneOffset() * 0;
const local = (y, m, d) => new Date(y, m, d, 12).getTime();
eq('day: today / yesterday / a date', [K.chDayLabel(local(2026, 10, 5), local(2026, 10, 5)), K.chDayLabel(local(2026, 10, 4), local(2026, 10, 5)), K.chDayLabel(local(2026, 9, 1), local(2026, 10, 5))], ['Today', 'Yesterday', '2026-10-01']);
eq('run: same author within five minutes joins, another author or a long pause does not', [K.chSameRun(msgs[3], msgs[4], 300000), K.chSameRun(msgs[3], {...msgs[4], t: msgs[3].t + 400000}, 300000), K.chSameRun(msgs[0], msgs[1], 300000)], [false, false, false]);
eq('run: the same author, same time', K.chSameRun({conv: 'a', author: 'x', mine: false, t: 1000}, {conv: 'a', author: 'x', mine: false, t: 2000}), true);
eq('md: bold, italic, strike, code and a link', K.chMd('a **b** *i* _j_ ~~s~~ `c*d` https://x.org/p?q=1.').map(t => t.t + ':' + t.v), ['text:a ', 'b:b', 'text: ', 'i:i', 'text: ', 'i:j', 'text: ', 's:s', 'text: ', 'code:c*d', 'text: ', 'a:https://x.org/p?q=1', 'text:.']);
eq('md: html is only text (nothing is interpreted here)', K.chMd('<b>x</b> <img src=x onerror=alert(1)>').map(t => t.t), ['text']);
eq('md: lone stars and snake_case are not formatting', K.chMd('2 * 3 * 4 and snake_case_name').map(t => t.t), ['text']);
eq('md: a link inside a sentence loses the trailing dot', K.chMd('see http://a.b/c.').filter(t => t.t === 'a').map(t => t.v), ['http://a.b/c']);
eq('preview: own message prefix, one line, cut', [K.chPreview({text: 'a\nb', mine: true}), K.chPreview({text: 'x'.repeat(100)}, 10)], ['You: a b', 'xxxxxxxxx…']);
// история в списке Table
eq('key: with an id', K.chHistKey({proto: 'email', id: '42', t: 1}), 'email:id:42');
eq('key: without an id it depends on time, author and text', [K.chHistKey({proto: 'irc', t: 5, from: 'a', text: 'x'}) === K.chHistKey({proto: 'irc', t: 5, from: 'a', text: 'x'}), K.chHistKey({proto: 'irc', t: 5, from: 'a', text: 'x'}) === K.chHistKey({proto: 'irc', t: 5, from: 'a', text: 'y'}), K.chHistKey({proto: 'irc', t: 5, from: 'a', text: 'x'}) === K.chHistKey({proto: 'irc', t: 6, from: 'a', text: 'x'})], [true, false, false]);
const sample = {t: Date.UTC(2026, 10, 5, 12, 30), proto: 'email', dir: 'in', from: 'Anna', fromAddr: 'anna@ex.org', to: 'me@ex.org', subject: 'Отчёт', thread: 'm1', id: '77', text: 'привет\nвторая строка', atts: [{name: 'rep.pdf', size: 3}, {name: 'a.png'}]};
const item = K.chToItem(sample);
eq('item: name is the key, fields are readable columns', [item.name, item.fields.proto, item.fields.dir, item.fields.from_addr, item.fields.atts, item.fields.conv, item.fields.t], ['email:id:77', 'email', 'in', 'anna@ex.org', 'rep.pdf | a.png', 'email:dm:anna@ex.org', sample.t]);
eq('item: every field is a known column', Object.keys(item.fields).every(k => K.CH_HIST_COLS.includes(k)), true);
eq('item: the time column is a readable local date-time', /^2026-11-05 \d\d:30:00$/.test(item.fields.time), true);
const back = K.chFromItem(item);
eq('item: message survives the round trip (attachments as names)', [back.t, back.proto, back.dir, back.from, back.fromAddr, back.to, back.subject, back.thread, back.id, back.text, back.atts.map(a => a.name)], [sample.t, 'email', 'in', 'Anna', 'anna@ex.org', 'me@ex.org', 'Отчёт', 'm1', '77', 'привет\nвторая строка', ['rep.pdf', 'a.png']]);
eq('item: the same key after the round trip (no duplicates on reload)', K.chHistKey(back), item.name);
const noId = K.chToItem({t: 9, proto: 'irc', dir: 'out', from: 'me', to: '#r', room: '#r', text: 'hi'});
eq('item without an id: the key is stable through the round trip', K.chHistKey(K.chFromItem(noId)), noId.name);
eq('item: junk record gives an empty message that is dropped by the tail', K.chHistTail([{name: 'x', fields: {}}, noId, item], 10).map(r => r.t), [9, sample.t]);
eq('tail: only the last ones, in time order', K.chHistTail([3, 1, 2, 5, 4].map(t => K.chToItem({t, proto: 'p', from: 'a', text: 't' + t})), 3).map(r => r.t), [3, 4, 5]);
eq('read counts: messages up to the saved time are read', K.chReadCounts([{conv: 'a', t: 1}, {conv: 'a', t: 2}, {conv: 'a', t: 3}, {conv: 'b', t: 5}], {a: 2}), {a: 2, b: 0});
eq('read counts: nothing saved → everything unread', K.chReadCounts([{conv: 'a', t: 1}], null), {a: 0});
// реакции: состояние и сводка
{ const st = new Map(), ME = K.CH_ME;
  K.chReactApply(st, {target: 'm1', author: 'anna', emojis: ['👍'], op: 'add'});
  K.chReactApply(st, {target: 'm1', author: 'bob', emojis: ['👍', '🔥'], op: 'add'});
  K.chReactApply(st, {target: 'm1', author: ME, emojis: ['👍'], op: 'add'});
  eq('react: counts, who, mine; more first', K.chReactSummary(st, 'm1').map(x => [x.emoji, x.count, x.mine, x.who.join('+')]), [['👍', 3, true, 'anna+bob+You'], ['🔥', 1, false, 'bob']]);
  K.chReactApply(st, {target: 'm1', author: 'anna', emojis: ['👍'], op: 'add'});
  eq('react: the same person twice is one', K.chReactSummary(st, 'm1')[0].count, 3);
  K.chReactApply(st, {target: 'm1', author: 'bob', emojis: ['🎉'], op: 'set'});
  eq('react: «set» replaces the whole set of that person (XMPP, Telegram)', K.chReactSummary(st, 'm1').map(x => x.emoji).sort(), ['🎉', '👍'].sort());
  K.chReactApply(st, {target: 'm1', author: 'anna', emojis: ['👍'], op: 'remove'});
  eq('react: remove', K.chReactSummary(st, 'm1').find(x => x.emoji === '👍').count, 1);
  eq('react: mine', [...K.chReactMine(st, 'm1')], ['👍']);
  K.chReactApply(st, {target: 'm1', author: ME, emojis: ['👍'], op: 'remove'}); K.chReactApply(st, {target: 'm1', author: 'bob', emojis: [], op: 'set'});
  eq('react: when the last reaction goes the message has no entry', [st.has('m1'), K.chReactSummary(st, 'm1')], [false, []]);
  K.chReactApply(st, {target: '', author: 'x', emojis: ['👍']}); K.chReactApply(st, null);
  eq('react: junk is ignored', st.size, 0);
  eq('react: the quick set and the protocols', [K.CH_EMOJI.length, K.CH_REACT_PROTOS], [6, ['matrix', 'xmpp', 'telegram', 'nostr']]);
  const ev = {t: 9, proto: 'matrix', dir: 'in', kind: 'reaction', target: '$m1', author: 'anna', emojis: ['👍', '❤️'], op: 'add', id: '$r1', room: '!r:hs'};
  const it = K.chToItem(ev), back = K.chFromItem(it);
  eq('history: a reaction is a row (kind, ref, emojis as text)', [it.name, it.fields.kind, it.fields.ref, it.fields.text, it.fields.op, it.fields.from], ['matrix:rx:$r1', 'reaction', '$m1', '👍 ❤️', 'add', 'anna']);
  eq('history: a reaction survives the round trip with the same key', [back.kind, back.target, back.author, back.emojis, back.op, back.id, K.chHistKey(back) === it.name], ['reaction', '$m1', 'anna', ['👍', '❤️'], 'add', '$r1', true]);
  const rm = K.chToItem({t: 10, proto: 'nostr', dir: 'in', kind: 'reaction', target: 'e1', author: 'bob', emojis: ['🔥'], op: 'remove', id: ''});
  eq('history: a reaction without an id keeps a stable key', K.chHistKey(K.chFromItem(rm)), rm.name);
  eq('history: a message keeps its reference', K.chFromItem(K.chToItem({t: 11, proto: 'telegram', dir: 'in', from: 'ivan', text: 'hi', id: '5', ref: '7:41'})).ref, '7:41');
  eq('history: all columns of a reaction are known', Object.keys(it.fields).every(k => K.CH_HIST_COLS.includes(k)), true); }
// правка и удаление
{ const mineM = K.chAnnotate({t: 1, proto: 'matrix', dir: 'out', from: 'me', room: '!r:hs', id: '$a', text: 'мой'}, new Map(), 'me');
  const bobM = K.chAnnotate({t: 2, proto: 'matrix', dir: 'in', from: 'bob', room: '!r:hs', id: '$b', text: 'bob text'}, new Map(), 'me');
  const xm = K.chAnnotate({t: 3, proto: 'xmpp', dir: 'in', from: 'anna@ex.org', fromAddr: 'anna@ex.org', id: 'x1', text: 'xmpp'}, new Map(), 'me');
  eq('modify: my own event applies to my message only', [K.chCanModify(mineM, {dir: 'out'}), K.chCanModify(bobM, {dir: 'out'})], [true, false]);
  eq('modify: an incoming event applies when the author is the author of the message', [K.chCanModify(bobM, {dir: 'in', author: 'bob'}), K.chCanModify(bobM, {dir: 'in', author: 'eve'}), K.chCanModify(mineM, {dir: 'in', author: 'me'}), K.chCanModify(bobM, {dir: 'in', author: ''})], [true, false, false, false]);
  eq('modify: a JID with a resource and capitals matches the sender', K.chCanModify(xm, {dir: 'in', author: 'Anna@Ex.org/phone'}), true);
  eq('modify: a server-checked event (force) always applies', K.chCanModify(bobM, {dir: 'in', author: '', force: true}), true);
  eq('modify: junk', [K.chCanModify(null, {}), K.chCanModify(bobM, null)], [false, false]);
  const ed = K.chApplyMod(bobM, {kind: 'edit', text: 'исправлено'});
  eq('apply edit: text, flag and raw follow; the original is untouched', [ed.text, ed.edited, ed.raw.text, bobM.text], ['исправлено', true, 'исправлено', 'bob text']);
  const dl = K.chApplyMod({...bobM, subject: 's', atts: [{name: 'a'}]}, {kind: 'delete'});
  eq('apply delete: text, subject and attachments are gone', [dl.text, dl.deleted, dl.subject, dl.atts, dl.raw.text], ['', true, '', null, '']);
  eq('preview of a deleted message', K.chPreview(dl), 'message deleted');
  eq('protocols that take edits and deletes', [K.CH_EDIT_PROTOS, K.CH_DELETE_PROTOS], [['matrix', 'xmpp', 'telegram'], ['matrix', 'xmpp', 'telegram', 'nostr']]);
  const eIt = K.chToItem({t: 20, proto: 'matrix', dir: 'in', kind: 'edit', target: '$b', author: 'bob', text: 'новый', id: '$e1', room: '!r:hs'});
  const eBack = K.chFromItem(eIt);
  eq('history: an edit is a row (kind, ref, the new text)', [eIt.name, eIt.fields.kind, eIt.fields.ref, eIt.fields.text], ['matrix:edit:$e1', 'edit', '$b', 'новый']);
  eq('history: an edit survives the round trip with the same key', [eBack.kind, eBack.target, eBack.author, eBack.text, eBack.id, K.chHistKey(eBack) === eIt.name], ['edit', '$b', 'bob', 'новый', '$e1', true]);
  const dIt = K.chToItem({t: 21, proto: 'matrix', dir: 'in', kind: 'delete', target: '$b', author: '', force: true, id: ''}), dBack = K.chFromItem(dIt);
  eq('history: a delete keeps «force» and a stable key without an id', [dBack.kind, dBack.target, dBack.force === true, K.chHistKey(dBack) === dIt.name, dIt.fields.text], ['delete', '$b', true, true, '']);
  eq('history: new columns are known', Object.keys(eIt.fields).every(k => K.CH_HIST_COLS.includes(k)) && Object.keys(dIt.fields).every(k => K.CH_HIST_COLS.includes(k)), true); }
// статусы доставки и прочтения
{ const st = new Map();
  K.chStatusApply(st, {target: 'm1', state: 'sent', detail: 'relays: 1/3'});
  eq('status: sent', K.chStatusOf(st, 'm1'), {state: 'sent', by: [], detail: 'relays: 1/3'});
  K.chStatusApply(st, {target: 'm1', state: 'delivered', author: 'anna@ex.org'});
  K.chStatusApply(st, {target: 'm1', state: 'sent'});
  eq('status: it only grows (a late «sent» does not take the delivery back)', K.chStatusOf(st, 'm1').state, 'delivered');
  K.chStatusApply(st, {target: 'm1', state: 'read', author: 'anna'}); K.chStatusApply(st, {target: 'm1', state: 'read', author: 'bob'}); K.chStatusApply(st, {target: 'm1', state: 'read', author: 'bob'});
  eq('status: read, and who read it (once each)', K.chStatusOf(st, 'm1'), {state: 'read', by: ['anna', 'bob'], detail: ''});
  K.chStatusApply(st, {target: 'f1', state: 'failed', detail: 'blocked'});
  eq('status: failed with the reason', K.chStatusOf(st, 'f1'), {state: 'failed', by: [], detail: 'blocked'});
  K.chStatusApply(st, {target: 'f1', state: 'sent', detail: 'relays: 1/1'});
  eq('status: a later success replaces a failure', K.chStatusOf(st, 'f1').state, 'sent');
  K.chStatusApply(st, {target: '', state: 'read'}); K.chStatusApply(st, {target: 'x', state: 'nonsense'}); K.chStatusApply(st, null);
  eq('status: junk is ignored; unknown messages have no status', [st.has('x'), K.chStatusOf(st, 'nope'), st.size], [false, null, 2]);
  const now = 100000;
  eq('tick: sending, then not confirmed in time', [K.chTick({pending: true, sentAt: now - 1000}, null, now).sym, K.chTick({pending: true, sentAt: now - 20000}, null, now).sym], ['…', '⚠']);
  eq('tick: a confirmed message is sent ✓; with the relay count in the tooltip', [K.chTick({}, null, now).sym, K.chTick({}, {state: 'sent', by: [], detail: 'relays: 2/3'}, now).title], ['✓', 'sent · relays: 2/3']);
  eq('tick: delivered ✓✓, read ✓✓ in colour naming the readers', [K.chTick({}, {state: 'delivered', by: []}).sym, K.chTick({}, {state: 'read', by: ['anna', 'bob']}).cls, K.chTick({}, {state: 'read', by: ['anna', 'bob']}).title], ['✓✓', 'rd', 'read by anna, bob']);
  eq('tick: failed with the reason', K.chTick({}, {state: 'failed', by: [], detail: 'blocked: spam'}).title, 'not sent: blocked: spam');
  const sIt = K.chToItem({t: 30, proto: 'xmpp', kind: 'status', target: 'm5', state: 'read', author: 'anna@ex.org', detail: ''}), sBack = K.chFromItem(sIt);
  eq('history: a status is a row (kind, ref, state in the text)', [sIt.fields.kind, sIt.fields.ref, sIt.fields.text, sIt.fields.from], ['status', 'm5', 'read', 'anna@ex.org']);
  eq('history: a status survives the round trip', [sBack.kind, sBack.target, sBack.state, sBack.author], ['status', 'm5', 'read', 'anna@ex.org']);
  eq('history: two readers of one message are two rows, the same reader twice is one', [K.chToItem({t: 1, proto: 'matrix', kind: 'status', target: 'e', state: 'read', author: 'a'}).name === K.chToItem({t: 1, proto: 'matrix', kind: 'status', target: 'e', state: 'read', author: 'b'}).name, K.chToItem({t: 1, proto: 'matrix', kind: 'status', target: 'e', state: 'read', author: 'a'}).name === K.chToItem({t: 1, proto: 'matrix', kind: 'status', target: 'e', state: 'read', author: 'a'}).name], [false, true]);
  eq('read protocols', K.CH_READ_PROTOS, ['matrix', 'xmpp']); }
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
