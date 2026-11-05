"use strict";
/* ============================ Учётки (Credentials): чистая логика ============================
   crClean(list) — валидация и дедуп по имени (регистронезависимо); crFind(list, name) → запись или null.
   Тип (CR_TYPES) переключает примеры полей (CR_EXAMPLE); crGuess(server) угадывает тип по схеме адреса. */

const CR_NAME=/^[A-Za-z0-9_.-]{1,24}$/;
const CR_TYPES=['email','matrix','xmpp','irc','ntfy','telegram','nostr','aprs','mastodon','bluesky','proxy','custom'];
const CR_EXAMPLE={
  email:   {server:'imaps://imap.gmail.com:993',          smtp:'smtps://smtp.gmail.com:465'},
  matrix:  {server:'https://matrix.org',                  smtp:''},
  xmpp:    {server:'xmpp://conversations.im:5222',        smtp:''},
  irc:     {server:'ircs://irc.libera.chat:6697',         smtp:''},
  ntfy:    {server:'https://ntfy.sh',                     smtp:''},
  telegram:{server:'',                                    smtp:''},
  nostr:   {server:'wss://relay.damus.io wss://nos.lol',  smtp:''},
  aprs:    {server:'aprs://rotate.aprs2.net:14580',       smtp:''},
  mastodon:{server:'https://mastodon.social',             smtp:''},
  bluesky: {server:'https://public.api.bsky.app',         smtp:''},
  proxy:   {server:'socks5://127.0.0.1:9050 · http://proxy.lan:3128', smtp:''},
  custom:  {server:'imaps://… · https://… · ircs://…',    smtp:''},
};
function crGuess(server){
  const s=String(server||'').trim().toLowerCase();
  if(/^imaps?:/.test(s)||/^smtps?:/.test(s)) return 'email';
  if(/^xmpp/.test(s)) return 'xmpp';
  if(/^ircs?:/.test(s)) return 'irc';
  if(/^aprs/.test(s)) return 'aprs';
  if(/^socks[45]h?:/.test(s)) return 'proxy';
  if(/^wss:/.test(s)) return 'nostr';
  if(/^https?:/.test(s)) return 'ntfy';
  return 'custom';
}
function crClean(list){
  const out=[], seen=new Set();
  for(const c of Array.isArray(list)?list:[]){
    if(!c||typeof c!=='object') continue;
    const name=String(c.name||'').trim();
    if(!CR_NAME.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const server=String(c.server||'').trim();
    const type=CR_TYPES.includes(c.type) ? c.type : crGuess(server);
    out.push({name, type, server, user:String(c.user||''), pass:String(c.pass||''), smtp:String(c.smtp||'')});
  }
  return out;
}
function crFind(list,name){
  const n=String(name||'').trim().toLowerCase();
  return (Array.isArray(list)?list:[]).find(c=>c&&String(c.name||'').toLowerCase()===n)||null;
}
