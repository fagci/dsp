// Ядро мессенджеров (Nostr / IRC / XMPP / разбор ответов): node tools/test-msgr.mjs
import {loadMsgr} from './node/load.mjs';
const M = loadMsgr();
let bad = 0;
const PW = Math.random().toString(36).slice(2, 10);   // не литерал — сканеры секретов
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };
const H = M.mgHex, U = M.mgUnhex;

// BIP-340: тестовые векторы из спецификации
{ const sk = U('0000000000000000000000000000000000000000000000000000000000000003');
  eq('bip340 vec0 pubkey', H(M.mgSchnorrPub(sk)), 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const sig = M.mgSchnorrSign(new Uint8Array(32), sk, new Uint8Array(32));
  eq('bip340 vec0 signature', H(sig), 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0');
  eq('bip340 vec0 verify', M.mgSchnorrVerify(sig, new Uint8Array(32), M.mgSchnorrPub(sk)), true);
  const bad1 = Uint8Array.from(sig); bad1[5] ^= 1;
  eq('bip340 corrupted signature refused', M.mgSchnorrVerify(bad1, new Uint8Array(32), M.mgSchnorrPub(sk)), false);
  const sk1 = U('b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef');
  const m1 = U('243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89');
  eq('bip340 vec1 pubkey', H(M.mgSchnorrPub(sk1)), 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659');
  const aux1 = new Uint8Array(32); aux1[31] = 1;
  eq('bip340 vec1 signature', H(M.mgSchnorrSign(m1, sk1, aux1)),
    '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a');
}

// bech32 (вектор NIP-19): nsec / npub
{ const sk = U('67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa');
  eq('nsec encode (NIP-19)', M.mgBechEnc('nsec', sk), 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
  eq('nsec decode', H(M.mgBechDec('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5').bytes), H(sk));
  eq('nostr key from nsec', H(M.mgNostrKey('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')), H(sk));
  eq('bad checksum refused', M.mgBechDec('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6'), null);
  eq('npub of 7e7e9c42… (NIP-19)', M.mgNpub('7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'), 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg');
}

// события Nostr: подпись, проверка, подмена
{ const sk = M.mgNostrGenKey();
  const ev = M.mgNostrSign(sk, {created_at: 1700000000, kind: 1, tags: [['t', 'dsp'], ['nick', 'аня']], content: 'привет, mesh 👋'});
  eq('event id = sha256 of the serialization', ev.id, M.mgNostrId(ev));
  eq('event verifies', M.mgNostrVerify(ev), true);
  eq('changed content refused', M.mgNostrVerify({...ev, content: 'другое'}), false);
  eq('changed signature refused', M.mgNostrVerify({...ev, sig: ev.sig.replace(/^./, c => c === '0' ? '1' : '0')}), false);
  eq('text of our channel', M.mgNostrText(ev, 'DSP'), {from: 'аня', text: 'привет, mesh 👋'});
  eq('other channel ignored', M.mgNostrText(ev, 'other'), null);
  const anon = M.mgNostrSign(sk, {created_at: 1, kind: 1, tags: [['t', 'dsp']], content: 'x'});
  eq('no nick → short npub', M.mgNostrText(anon, 'dsp').from.startsWith('npub1'), true);
  eq('REQ frame', JSON.parse(M.mgNostrReq('s1', 'DSP', 5)), ['REQ', 's1', {kinds: [1], '#t': ['dsp'], since: 5}]);
  eq('relay frame', M.mgNostrFrame('["EOSE","s1"]').type, 'EOSE');
  eq('garbage frame', M.mgNostrFrame('nope'), null);
  const t0 = Date.now(); for (let i = 0; i < 5; i++) M.mgNostrVerify(ev);
  console.log('     verify ≈', ((Date.now() - t0) / 5).toFixed(1), 'ms per event');
}

// ntfy / Matrix / Telegram
{ const st = {}; const ls = [...M.mgLines(st, '{"a":1}\n{"b"'), ...M.mgLines(st, ':2}\r\n\n')];
  eq('lines split across chunks', ls, ['{"a":1}', '{"b":2}']);
  eq('ntfy message', M.mgNtfyLine('{"id":"x1","time":10,"event":"message","topic":"t","title":"аня","message":"hi"}'), {id: 'x1', from: 'аня', text: 'hi', t: 10000, tags: [], prio: undefined});
  eq('ntfy keepalive ignored', M.mgNtfyLine('{"event":"keepalive"}'), null);
  const mx = M.mgMatrixSync({next_batch: 's5', rooms: {join: {'!r:hs': {timeline: {events: [
    {type: 'm.room.message', event_id: '$1', sender: '@bob:hs', origin_server_ts: 5, content: {msgtype: 'm.text', body: 'hello'}},
    {type: 'm.room.message', event_id: '$2', sender: '@me:hs', origin_server_ts: 6, content: {msgtype: 'm.emote', body: 'waves'}},
    {type: 'm.room.message', event_id: '$3', sender: '@bob:hs', content: {msgtype: 'm.image', body: 'pic.png'}},
    {type: 'm.room.member', sender: '@bob:hs', content: {}}]}}, '!x:hs': {timeline: {events: [{type: 'm.room.message', sender: '@z:hs', content: {body: 'other'}}]}}}}}, '!r:hs', '@me:hs');
  eq('matrix next batch', mx.next, 's5');
  eq('matrix messages', mx.msgs.map(m => [m.from, m.text, m.self]), [['bob', 'hello', false], ['me', '* waves', true]]);
  const tg = M.mgTgUpdates({ok: true, result: [
    {update_id: 7, message: {chat: {id: 42, title: 'Team'}, from: {username: 'bob'}, text: 'hi', date: 3}},
    {update_id: 8, message: {chat: {id: 99}, from: {first_name: 'X'}, text: 'other chat', date: 4}},
    {update_id: 9, message: {chat: {id: 42}, photo: []}}]}, '42');
  eq('telegram next offset', tg.next, 10);
  eq('telegram chat filter', tg.msgs.map(m => [m.from, m.text, m.room]), [['bob', 'hi', '42']]);
  eq('telegram: skipped are counted', tg.skipped, 1);
  const upd = {ok: true, result: [{update_id: 1, message: {chat: {id: 7, username: 'Team'}, from: {username: 'a'}, text: 'x', date: 1}}]};
  eq('telegram: a word that is not a chat id or @name (the default «dsp») filters nothing', M.mgTgUpdates(upd, 'dsp').msgs.length, 1);
  eq('telegram: @name filter, any case', [M.mgTgUpdates(upd, '@team').msgs.length, M.mgTgUpdates(upd, '@other').msgs.length], [1, 0]);
}

// IRC
{ eq('irc parse', M.mgIrcParse(':nick!u@h PRIVMSG #c :hello world'), {tags: null, prefix: 'nick!u@h', nick: 'nick', cmd: 'PRIVMSG', params: ['#c', 'hello world']});
  eq('irc parse tags/ping', M.mgIrcParse('@time=1 PING :srv').params, ['srv']);
  eq('irc format trailing', M.mgIrcFmt('PRIVMSG', '#c', 'hello world'), 'PRIVMSG #c :hello world');
  eq('irc format single word', M.mgIrcFmt('JOIN', '#c'), 'JOIN #c');
  eq('irc injection stripped', M.mgIrcFmt('PRIVMSG', '#c', 'hi\r\nQUIT :x'), 'PRIVMSG #c :hi QUIT :x');
  eq('split long', M.mgSplit('а'.repeat(500), 400).map(s => new TextEncoder().encode(s).length <= 400), [true, true, true]);
  const sent = [], got = [], st = [];
  const c = M.mgIrcClient({nick: 'dsp', pass: PW, channels: ['#test'], write: l => sent.push(l), onMsg: m => got.push(m), onStatus: (t, s) => st.push(s)});
  c.start();
  eq('registration', sent, ['PASS ' + PW, 'NICK dsp', 'USER dsp 0 * dsp']);
  c.feed(':srv 433 * dsp :Nickname is already in use\r\nPING :tok\r\n:srv 001 dsp_ :Welcome\r\n:bob!u@h PRIV');
  c.feed('MSG #test :hi there\r\n:bob!u@h PRIVMSG dsp_ :\x01ACTION waves\x01\r\n:bob!u@h PRIVMSG #test :\x01VERSION\x01\r\n');
  eq('nick change, pong, join', sent.slice(3), ['NICK dsp_', 'PONG tok', 'JOIN #test']);
  eq('messages (CTCP VERSION hidden)', got.map(m => [m.from, m.to, m.text]), [['bob', '#test', 'hi there'], ['bob', 'dsp_', '* bob waves']]);
  c.send('line1\nline2'); eq('send default channel', sent.slice(6), ['PRIVMSG #test line1', 'PRIVMSG #test line2']);
  eq('status', st.includes('up'), true);
}

// XML-разбор потока
{ const ev = []; const p = M.mgXmlParser((e, n) => ev.push([e, n && n.name, n && n.text, n && n.attrs]));
  const xml = "<?xml version='1.0'?><stream:stream xmlns='jabber:client' from='x'><message from='a@b/c' type='chat'><body>1 &lt; 2 &amp; &#1087;</body><x a=\"q>w\"/></message><presence/></stream:stream>";
  for (let i = 0; i < xml.length; i += 7) p(xml.slice(i, i + 7));          // кусками по 7 символов
  eq('xml events', ev.map(e => e[0] + ':' + e[1]), ['open:stream:stream', 'stanza:message', 'stanza:presence', 'close:null']);
  eq('xml entities', ev[1][1], 'message'); }
{ let top; const p = M.mgXmlParser((e, n) => { if (e === 'stanza') top = n; });
  p("<s:stream xmlns:s='x'><message><body>1 &lt; 2 &amp; &#1087;</body><x a=\"q>w\"/></message>");
  eq('xml body text', top.kids[0].text, '1 < 2 & п'); eq('xml attribute with >', top.kids[1].attrs.a, 'q>w'); }

// XMPP: клиент против сценария «сервера»
{ const out = [], got = [], st = []; let cli, tlsUp = false;
  const srv = s => cli.feed(s);
  cli = M.mgXmppClient({domain: 'ex.org', user: 'bob', pass: PW + 'ä', resource: 'dsp', room: 'room@conf.ex.org', nick: 'bobby',
    write: s => out.push(s), tls: done => { tlsUp = true; done(); }, onMsg: m => got.push(m), onStatus: (t, s) => st.push(s)});
  cli.start();
  eq('stream opened', /^<\?xml.*<stream:stream to='ex\.org'/.test(out[0]), true);
  srv("<stream:stream from='ex.org' id='1' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'><stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>");
  eq('starttls requested', out[1], "<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
  srv("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
  eq('tls upgraded, stream restarted', [tlsUp, out.length], [true, 3]);
  srv("<stream:stream from='ex.org' id='2' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'><stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>SCRAM-SHA-1</mechanism><mechanism>PLAIN</mechanism></mechanisms></stream:features>");
  const auth = /<auth [^>]*>(.*)<\/auth>/.exec(out[3]);
  eq('SASL PLAIN payload', Buffer.from(auth[1], 'base64').toString('utf8'), '\0bob\0' + PW + 'ä');
  srv("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
  eq('stream restarted after SASL', out.length, 5);
  srv("<stream:stream from='ex.org' id='3' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'><stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>");
  eq('bind request', /id='bind1'.*<resource>dsp<\/resource>/.test(out[5]), true);
  srv("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>bob@ex.org/dsp</jid></bind></iq>");
  eq('presence + MUC join', [out[6], /to='room@conf\.ex\.org\/bobby'.*muc/.test(out[7])], ['<presence/>', true]);
  eq('ready', [cli.ready, st[st.length - 1]], [true, 'up']);
  srv("<message type='groupchat' from='room@conf.ex.org/alice' id='a'><body>hi &amp; bye</body></message>");
  srv("<message type='groupchat' from='room@conf.ex.org/bobby'><body>mine</body></message>");
  srv("<message type='chat' from='carol@ex.org/phone'><body>psst</body></message>");
  srv("<message type='groupchat' from='room@conf.ex.org/alice'><body>old</body><delay xmlns='urn:xmpp:delay'/></message>");
  eq('incoming', got.map(m => [m.from, m.text, m.self, m.delay]), [['alice', 'hi & bye', false, false], ['bobby', 'mine', true, false], ['carol@ex.org', 'psst', false, false], ['alice', 'old', false, true]]);
  srv("<iq type='get' id='p1' from='ex.org'><ping xmlns='urn:xmpp:ping'/></iq>");
  eq('ping answered', out[out.length - 1], "<iq type='result' id='p1' to='ex.org'/>");
  cli.send('a <b> & c'); eq('send to room', /type='groupchat' to='room@conf\.ex\.org'.*<body>a &lt;b&gt; &amp; c<\/body>/.test(out[out.length - 1]), true);
  cli.send('hi','carol@ex.org'); eq('send direct', /type='chat' to='carol@ex\.org'/.test(out[out.length - 1]), true);
}
{ const st = []; const c = M.mgXmppClient({domain: 'ex.org', user: 'b', pass: PW, write() {}, tls() {}, onMsg() {}, onStatus: (t, s) => st.push(s)});
  c.start(); c.feed("<stream:stream xmlns='jabber:client' xmlns:stream='x'><stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>");
  eq('no TLS offered → password not sent', st[st.length - 1], 'fatal'); }

// APRS-IS
{ eq('passcode N0CALL', M.mgAprsPass('N0CALL'), 13023);
  eq('passcode ignores SSID and case', M.mgAprsPass('n0call-7'), 13023);
  const pos = M.mgAprsParse('N0CALL-9>APRS,TCPIP*,qAC,T2X:!5545.35N/03737.07E>Car 12V');
  eq('uncompressed position', [pos.kind, +pos.lat.toFixed(4), +pos.lon.toFixed(4), pos.symbol, pos.text], ['position', 55.7558, 37.6178, '/>', 'Car 12V']);
  const south = M.mgAprsParse('A>B:=3351.00S/15112.00W-');
  eq('southern / western hemisphere', [+south.lat.toFixed(3), +south.lon.toFixed(3)], [-33.85, -151.2]);
  const ts = M.mgAprsParse('A>B:@092345z4903.50N/07201.75W>x');
  eq('position with timestamp', [+ts.lat.toFixed(4), +ts.lon.toFixed(4)], [49.0583, -72.0292]);
  const comp = M.mgAprsParse('A>B:!/5L!!<*e7>7P[');             // пример сжатой позиции из спецификации APRS101
  eq('compressed position', [+comp.lat.toFixed(2), +comp.lon.toFixed(2), comp.symbol], [49.5, -72.75, '/>']);
  eq('message with id', (({kind, to, text, id}) => ({kind, to, text, id}))(M.mgAprsParse('A-1>APRS,TCPIP*::N0CALL   :hello there{42')), {kind: 'message', to: 'N0CALL', text: 'hello there', id: '42'});
  eq('ack', (({kind, to, id}) => ({kind, to, id}))(M.mgAprsParse('B>APRS::A-1      :ack42')), {kind: 'ack', to: 'A-1', id: '42'});
  eq('status', M.mgAprsParse('A>B:>on air').text, 'on air');
  eq('server comment is not a packet', M.mgAprsParse('# aprsc 2.1'), null);
  eq('build message', M.mgAprsMsg('N0CALL', 'K1abc-7', 'hi', '7'), 'N0CALL>APDSP,TCPIP*::K1ABC-7  :hi{7');
  eq('message text cannot inject a line', M.mgAprsMsg('A', 'B', 'x\r\ny', '1').includes('\n'), false);
  const out = [], got = [], st = [];
  const c = M.mgAprsClient({call: 'n0call', pass: '13023', filter: 'g/N0CALL', ackMs: 20, tries: 2, write: l => out.push(l), onMsg: m => got.push(m), onStatus: (t, s) => st.push([s, t])});
  c.start();
  eq('login line', out[0], 'user N0CALL pass 13023 vers DSP 1 filter g/N0CALL');
  c.line('# logresp N0CALL verified, server T2TEST'); eq('verified login', st.at(-1)[0], 'up');
  c.line('K1ABC>APRS,TCPIP*::N0CALL   :ping{5');
  eq('message to us is acked and delivered', [out[1], got[0].text, got[0].direct], ['N0CALL>APDSP,TCPIP*::K1ABC    :ack5', 'ping', true]);
  c.line('K1ABC>APRS,TCPIP*::OTHER    :not for us');
  eq('other people\'s messages pass but are not acked', [got[1].direct, out.length], [false, 2]);
  c.line('K1ABC>APRS,TCPIP*:!5545.35N/03737.07E>');
  eq('position delivered with coordinates', [got[2].kind, +got[2].lat.toFixed(2)], ['position', 55.76]);
  eq('send needs an addressee', c.send('x', ''), false);
  eq('send', c.send('привет', 'k1abc'), true); eq('sent line', out[2], 'N0CALL>APDSP,TCPIP*::K1ABC    :привет{1');
  await new Promise(r => setTimeout(r, 30)); eq('retry while unacked', out.filter(l => l.endsWith('{1')).length, 2);
  c.line('K1ABC>APRS::N0CALL   :ack1'); eq('ack stops retries', st.at(-1)[1], 'message 1 delivered');
  c.stop();
  const ro = M.mgAprsClient({call: 'N0CALL', pass: '', write() {}, onMsg() {}, onStatus: (t, s) => st.push([s, t])});
  eq('no passcode → receive only', ro.send('x', 'K1ABC'), false);
}

// Почта
{ const bin = t => Buffer.from(t, 'utf8').toString('latin1');                // как приходит из сокета: байт = символ
  const b64 = t => Buffer.from(t, 'utf8').toString('base64');
  const m1 = M.mgMailParse(bin('From: =?UTF-8?B?' + b64('Аня Петрова') + '?= <anya@ex.org>\r\nSubject: =?utf-8?Q?=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64('Тело письма\nвторая строка') + '\r\n'));
  eq('mail: RFC 2047 name, subject, base64 body', [m1.from, m1.fromAddr, m1.subject, m1.text], ['Аня Петрова', 'anya@ex.org', 'Привет', 'Тело письма\nвторая строка']);
  const multi = bin('From: bob@ex.org\r\nSubject: multi\r\nContent-Type: multipart/alternative; boundary="XX"\r\n\r\n--XX\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>html <b>version</b></p>\r\n--XX\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain =D0=BF=D1=80=D0=B8=\r\n=D0=B2=D0=B5=D1=82\r\n--XX--\r\n');
  eq('mail: multipart prefers text/plain, quoted-printable with soft break', M.mgMailParse(multi).text, 'plain привет');
  eq('mail: html only is stripped', M.mgMailParse(bin('From: a@b\r\nContent-Type: text/html\r\n\r\n<style>p{}</style><div>one<br>two &amp; three</div>')).text, 'one\ntwo & three');
  eq('mail: latin1 charset', M.mgMailParse('From: a@b\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf\xe9').text, 'café');
  const composed = M.mgMailCompose({from: 'me@ex.org', to: 'you@ex.org', subject: 'Тема', body: 'Привет\n.точка в начале', date: 0, id: 'x1'});
  const back = M.mgMailParse(bin(composed));
  eq('mail: compose → parse round trip', [back.subject, back.text, back.fromAddr], ['Тема', 'Привет\n.точка в начале', 'me@ex.org']);
  eq('mail: header injection stripped', M.mgMailCompose({from: 'a@b', to: 'c@d\r\nBcc: x@y', subject: 's', body: 'b'}).includes('\r\nBcc:'), false);
  eq('imap: literal read whole', (r => [r.text, r.lits, r.rest])(M.mgImapNext('* 1 FETCH (BODY[] {5}\r\nab\r\nc)\r\na1 OK')), ['* 1 FETCH (BODY[] \0' + '0\0)', ['ab\r\nc'], 'a1 OK']);
  eq('imap: incomplete literal waits', M.mgImapNext('* 1 FETCH (BODY[] {50}\r\nab'), null);
}
{ // IMAP: сценарий «сервера»
  const out = [], got = [], st = []; let cli;
  const srv = s => cli.feed(s);
  const raw = Buffer.from('From: Bob <bob@ex.org>\r\nSubject: hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nпривет', 'utf8').toString('latin1');
  cli = M.mgImapClient({user: 'me@ex.org', pass: 'pa"ss', box: 'INBOX', write: s => out.push(s), tls: d => { out.push('<tls>'); d(); }, onMsg: m => got.push(m), onStatus: (t, s) => st.push([s, t])});
  cli.start(); srv('* OK IMAP ready\r\n');
  eq('capability asked', out[0], 'a1 CAPABILITY\r\n');
  srv('* CAPABILITY IMAP4rev1 STARTTLS\r\na1 OK done\r\n');
  eq('starttls', out[1], 'a2 STARTTLS\r\n'); srv('a2 OK go\r\n');
  eq('tls upgraded, then login with a quoted password', out.slice(2), ['<tls>', 'a3 LOGIN "me@ex.org" "pa\\"ss"\r\n']);
  srv('a3 OK logged in\r\n'); eq('select', out[4], 'a4 SELECT "INBOX"\r\n');
  srv('* 3 EXISTS\r\n* OK [UIDNEXT 10] next\r\na4 OK [READ-WRITE] done\r\n');
  eq('ready', [cli.ready, st.at(-1)[0]], [true, 'up']);
  cli.poll(); eq('search only for new uids', out[5], 'a5 UID SEARCH UID 10:*\r\n');
  srv('* SEARCH 9\r\na5 OK done\r\n'); eq('the last old message is not new', got.length, 0);
  cli.poll(); eq('next poll from the same uid', out[6], 'a6 UID SEARCH UID 10:*\r\n');
  srv('* SEARCH 10\r\na6 OK done\r\n'); eq('fetch without setting \\Seen', out[7], 'a7 UID FETCH 10 (BODY.PEEK[])\r\n');
  srv('* 4 FETCH (UID 10 BODY[] {' + raw.length + '}\r\n' + raw + ')\r\na7 OK done\r\n');
  eq('mail delivered', got.map(m => [m.from, m.fromAddr, m.text, m.kind, m.id]), [['Bob', 'bob@ex.org', '[hi] привет', 'mail', '10']]);
  cli.poll(); eq('after it, the search starts at 11', out[8], 'a8 UID SEARCH UID 11:*\r\n');
  srv('* SEARCH\r\na8 OK done\r\n');
}
{ const st = []; const cli = M.mgImapClient({user: 'u', pass: 'p', write() {}, tls() {}, onMsg() {}, onStatus: (t, s) => st.push(s)});
  cli.start(); cli.feed('* OK hi\r\n* CAPABILITY IMAP4rev1\r\na1 OK x\r\n');
  eq('imap: no STARTTLS → password not sent', st.at(-1), 'fatal'); }
{ // SMTP
  const out = [], res = []; let cli, up = false;
  cli = M.mgSmtpClient({host: 'ex.org', user: 'me@ex.org', pass: 'pw1', from: 'Me <me@ex.org>', to: 'you@ex.org', subject: 'Тема', body: 'тело',
    write: s => out.push(s), tls: d => { up = true; d(); }, done: e => res.push(e)});
  cli.feed('220 ex.org ESMTP\r\n'); eq('ehlo', out[0], 'EHLO dsp.local\r\n');
  cli.feed('250-ex.org\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n'); eq('starttls', out[1], 'STARTTLS\r\n');
  cli.feed('220 go\r\n'); eq('tls up, ehlo again', [up, out[2]], [true, 'EHLO dsp.local\r\n']);
  cli.feed('250-ex.org\r\n250 AUTH PLAIN LOGIN\r\n');
  eq('auth plain', Buffer.from(/AUTH PLAIN (\S+)/.exec(out[3])[1], 'base64').toString(), '\0me@ex.org\0pw1');
  cli.feed('235 ok\r\n'); eq('mail from (address only)', out[4], 'MAIL FROM:<me@ex.org>\r\n');
  cli.feed('250 ok\r\n'); eq('rcpt', out[5], 'RCPT TO:<you@ex.org>\r\n');
  cli.feed('250 ok\r\n'); eq('data', out[6], 'DATA\r\n');
  cli.feed('354 go\r\n'); eq('message ends with a lone dot', out[7].endsWith('\r\n.\r\n'), true);
  cli.feed('250 queued\r\n'); eq('done without error', res, [null]);
}
{ const res = []; const c = M.mgSmtpClient({host: 'h', user: 'u', pass: 'p', from: 'a@b', to: 'c@d', subject: 's', body: 'b', write() {}, tls() {}, done: e => res.push(e)});
  c.feed('220 hi\r\n250 plain server\r\n'); eq('smtp: no STARTTLS → password not sent', /STARTTLS/.test(res[0]), true); }
{ const out = [], res = []; const c = M.mgSmtpClient({host: 'h', user: 'u', pass: 'p', from: 'a@b', to: 'c@d', subject: 's', body: 'b', secure: true, write: s => out.push(s), tls() {}, done: e => res.push(e)});
  c.feed('220 hi\r\n250 AUTH LOGIN\r\n'); eq('auth login', out[1], 'AUTH LOGIN\r\n');
  c.feed('334 VXNlcm5hbWU6\r\n'); c.feed('334 UGFzc3dvcmQ6\r\n'); eq('login steps', [out[2], out[3]], ['dQ==\r\n', 'cA==\r\n']);
  c.feed('535 bad credentials\r\n'); eq('refused credentials reported', res[0], 'SMTP 535 bad credentials'); }

console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
