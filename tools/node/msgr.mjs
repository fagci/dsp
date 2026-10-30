#!/usr/bin/env node
// Мессенджеры из терминала — те же протоколы, что в узле Messenger на странице (modules/msgr-*.js), без браузера.
//
//   node tools/node/msgr.mjs chat nostr --server wss://relay.damus.io --channel dsp-test --nick me
//   node tools/node/msgr.mjs chat irc --server ircs://irc.libera.chat:6697 --channel '#dsp' --nick dspbot
//   node tools/node/msgr.mjs chat xmpp --user me@example.org --pass … --channel room@conference.example.org
//   node tools/node/msgr.mjs chat ntfy --channel my-topic        (по умолчанию https://ntfy.sh)
//   node tools/node/msgr.mjs chat telegram --pass <токен бота> [--channel <chat id>]
//   node tools/node/msgr.mjs chat aprs --user N0CALL-7 [--pass <passcode>] --channel r/52.5/13.4/100   (сообщения: «@CALL текст»)
//   node tools/node/msgr.mjs chat email --server imaps://imap.example.org:993 --smtp smtps://smtp.example.org:465 --user me@example.org --pass …   (письмо: «@кому@хост тема⏎текст»)
//   node tools/node/msgr.mjs chat reticulum --server rns://host:4242 --nick me --pass <128 hex: ключ личности, пусто — новая>   (письмо: «@имя текст»)
//   node tools/node/msgr.mjs chat mastodon --server https://mastodon.social --channel '#sdr #radio -#spam'   (лента: только чтение, без входа)
//   node tools/node/msgr.mjs chat bluesky --channel '@alice.bsky.social'   (поиск по #тегу — с --user и --pass: app password)
//   node tools/node/msgr.mjs chat rss --server 'https://www.rtl-sdr.com/feed/ https://hackaday.com/blog/feed/' --channel 'sdr antenna -sponsored' --history 604800   (ленты, без CORS)
//   node tools/node/msgr.mjs chat matrix --server https://matrix.org --user … --pass … --channel '!комната:сервер'
// chat: входящие — в stdout, каждая строка stdin уходит в канал.
//
//   node tools/node/msgr.mjs relay связь.json            пересылка между каналами: [{proto,server,channel,…}, {…}, …]
// Каждое сообщение (кроме своих) уходит во все остальные записи как «[ник] текст». Пароли — в файле, права на него закрой (chmod 600).

import fs from 'node:fs';
import readline from 'node:readline';
import {parseArgs} from 'node:util';
import {loadMsgr} from './load.mjs';
import {nodeIo} from './bridge.mjs';

const M = loadMsgr();
const io = nodeIo();
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

function open(cfg, onMsg, name = cfg.proto) {
  return M.mgConnect(cfg.proto, {retry: true, via: 'page', ...cfg, io}, {
    msg: onMsg,
    status: (text, state) => log(name + ' [' + state + '] ' + text),
  });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'chat') {
  const {values: a, positionals: [proto]} = parseArgs({args: rest, allowPositionals: true, options: {
    server: {type: 'string', default: ''}, channel: {type: 'string', default: ''}, user: {type: 'string', default: ''},
    pass: {type: 'string', default: ''}, smtp: {type: 'string', default: ''}, nick: {type: 'string', default: 'dsp'}, key: {type: 'string', default: ''},
    history: {type: 'string', default: '0'}, insecure: {type: 'boolean', default: false}}});
  if (!proto) { console.error('usage: msgr.mjs chat <nostr|ntfy|matrix|telegram|irc|xmpp|aprs|email|reticulum|mastodon|bluesky|rss> [--server …] [--channel …] [--user …] [--pass …] [--nick …]'); process.exit(2); }
  const s = open({proto, ...a, history: +a.history || 0}, m => {
    console.log((m.self ? '→ ' : '') + (m.delay ? '(old) ' : '') + (m.from ? m.from + ': ' : '') + m.text);
  });
  const rl = readline.createInterface({input: process.stdin});
  rl.on('line', l => { if (l.trim()) Promise.resolve(s.send(l)).then(ok => { if (!ok) log('not sent'); }); });
  rl.on('close', () => { s.close(); setTimeout(() => process.exit(0), 200); });
} else if (cmd === 'relay' && rest[0]) {
  const eps = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
  if (!Array.isArray(eps) || eps.length < 2) { console.error('the config must be a list of at least two channels'); process.exit(2); }
  const ses = eps.map((cfg, i) => {
    const name = (cfg.name || cfg.proto + ':' + (cfg.channel || cfg.server || i));
    const s = open(cfg, m => {
      if (m.self || m.notice) return;                                 // свои сообщения (в том числе пересланные сюда) дальше не пускаем — иначе петля
      const line = '[' + (m.from || name) + '] ' + m.text;
      ses.forEach((o, j) => { if (j !== i) Promise.resolve(o.send(line)).catch(() => {}); });
    }, name);
    return s;
  });
  process.on('SIGINT', () => { ses.forEach(s => s.close()); process.exit(0); });
} else {
  console.error('node tools/node/msgr.mjs chat <proto> [options]\nnode tools/node/msgr.mjs relay config.json');
  process.exit(cmd ? 2 : 0);
}
