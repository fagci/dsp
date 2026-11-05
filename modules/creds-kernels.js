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
// подсказки к полям формы по типу: что писать в «login» и «password» (то, как это понимает узел)
const CR_HINT={
  email:   {user:'you@gmail.com',                 pass:'password (for Gmail — an app password)'},
  matrix:  {user:'username (without @ and :server)', pass:'password — or an access token with the login left empty'},
  xmpp:    {user:'you@example.org (full address)',  pass:'password'},
  irc:     {user:'nick (or the login of the server)', pass:'server / NickServ password, if any'},
  ntfy:    {user:'login — or empty',               pass:'password, or the access token (tk_…)'},
  telegram:{user:'empty',                          pass:'bot token from @BotFather'},
  nostr:   {user:'empty',                          pass:'private key (nsec… or hex); empty — a new anonymous key per session'},
  aprs:    {user:'your callsign (N0CALL-7)',        pass:'APRS-IS passcode (empty — receive only)'},
  mastodon:{user:'empty',                          pass:'access token'},
  bluesky: {user:'handle.bsky.social',              pass:'app password'},
  proxy:   {user:'login (if the proxy asks)',       pass:'password (if the proxy asks)'},
  custom:  {user:'login',                          pass:'password / token'},
};
const CR_REGISTER=['xmpp','matrix'];                              // где аккаунт можно создать прямо из узла (открытая регистрация)
// тип учётки для узла: явный credType параметра, иначе по протоколу узла (xmpp → xmpp), иначе custom
const crTypeFor=(credType,proto)=>CR_TYPES.includes(credType) ? credType : CR_TYPES.includes(proto) && proto!=='proxy' ? proto : 'custom';
// свободное имя учётки: xmpp1, xmpp2…
function crFreeName(list,base){
  const used=new Set((Array.isArray(list)?list:[]).map(c=>String(c.name||'').toLowerCase())), b=String(base||'acct').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,20)||'acct';
  for(let i=1;;i++){ const n=b+i; if(!used.has(n.toLowerCase())) return n; }
}
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
