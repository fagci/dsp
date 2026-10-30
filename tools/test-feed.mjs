// Ленты Mastodon и Bluesky (разбор, запросы, опрос против имитаций серверов): node tools/test-feed.mjs
import http from 'node:http';
import {loadMsgr} from './node/load.mjs';
import {nodeIo, createMsgrBridge} from './node/bridge.mjs';
const M = loadMsgr(), io = nodeIo();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' != ' + JSON.stringify(b));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }

// ---- разбор ----
eq('html → text', M.mgHtmlText('<p>Привет <a href="x">#<span>radio</span></a> &amp; &lt;b&gt;<br>строка 2 &#33; &#x1F44B;</p><p>абзац</p>'), 'Привет #radio & <b>\nстрока 2 ! 👋\n\nабзац');
eq('spec: tags, exclusion, accounts, feeds, keywords', M.mgFeedSpec('#SDR radio -#spam -nsfw @alice.bsky.social at://did:plc:x/app.bsky.feed.generator/f home local'),
  {tags: ['sdr', 'radio'], none: ['spam', 'nsfw'], actors: ['alice.bsky.social'], feeds: ['at://did:plc:x/app.bsky.feed.generator/f'], home: true, local: true});
eq('spec: a bsky.app feed link', M.mgFeedSpec('https://bsky.app/profile/a.b/feed/cats').feeds, ['https://bsky.app/profile/a.b/feed/cats']);
eq('mastodon url: first tag in the path, others as any[], exclusions as none[]', M.mgMastoUrl('https://m.example/', M.mgFeedSpec('#sdr #radio -#spam'), {sinceId: '123', limit: 40}),
  'https://m.example/api/v1/timelines/tag/sdr?any[]=radio&none[]=spam&since_id=123&limit=40');
eq('mastodon url: public / local / home', [M.mgMastoUrl('https://m', M.mgFeedSpec(''), {}), M.mgMastoUrl('https://m', M.mgFeedSpec('local'), {limit: 5}), M.mgMastoUrl('https://m', M.mgFeedSpec('home'), {})],
  ['https://m/api/v1/timelines/public?limit=40', 'https://m/api/v1/timelines/public?local=true&limit=5', 'https://m/api/v1/timelines/home?limit=40']);
ok('mastodon ids compare as numbers of any length', M.mgIdGt('1000', '999') && !M.mgIdGt('999', '1000') && M.mgIdGt('113000000000000002', '113000000000000001'));
const st = {id: '1', created_at: '2026-10-30T10:00:00.000Z', content: '<p>Hello <a href="#" class="hashtag">#<span>sdr</span></a></p>', url: 'https://m/@a/1', language: 'en',
  account: {acct: 'a@m.example', display_name: 'Аня', avatar_static: 'https://m/a.png'}, tags: [{name: 'sdr'}, {name: 'radio'}], favourites_count: 3, reblogs_count: 1, replies_count: 2,
  media_attachments: [{type: 'video', url: 'v'}, {type: 'image', url: 'https://m/full.jpg', preview_url: 'https://m/small.jpg'}], spoiler_text: ''};
const mp = M.mgMastoPost(st);
eq('mastodon post', [mp.from, mp.name, mp.text, mp.tags, mp.lang, mp.image, mp.likes, mp.t], ['a@m.example', 'Аня', 'Hello #sdr', 'sdr, radio', 'en', 'https://m/small.jpg', 3, Date.parse('2026-10-30T10:00:00Z')]);
const boost = M.mgMastoPost({id: '2', created_at: st.created_at, account: {acct: 'booster'}, reblog: st});
eq('mastodon boost shows the original with the booster noted', [boost.from, boost.boost_by, boost.text], ['a@m.example', 'booster', 'Hello #sdr']);
const bv = {uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', author: {handle: 'alice.bsky.social', displayName: 'Alice', did: 'did:plc:abc', avatar: 'https://cdn/a.jpg'},
  record: {text: 'Тест #Linux и #sdr', createdAt: '2026-10-30T11:00:00.000Z', langs: ['ru'], facets: [{features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'Linux'}]}], tags: ['extra']},
  embed: {$type: 'app.bsky.embed.images#view', images: [{thumb: 'https://cdn/t.jpg', fullsize: 'https://cdn/f.jpg'}]}, likeCount: 5, repostCount: 1, replyCount: 0};
const bp = M.mgBskyPost(bv);
eq('bluesky post (facet, record tags and #words, deduplicated)', [bp.from, bp.url, bp.tags, bp.lang, bp.image, bp.likes], ['alice.bsky.social', 'https://bsky.app/profile/alice.bsky.social/post/3kxyz', 'extra, Linux, sdr', 'ru', 'https://cdn/t.jpg', 5]);
eq('bluesky repost reason', M.mgBskyPost({post: bv, reason: {$type: 'app.bsky.feed.defs#reasonRepost', by: {handle: 'bob.bsky.social'}}}, {$type: 'app.bsky.feed.defs#reasonRepost', by: {handle: 'bob.bsky.social'}}).boost_by, 'bob.bsky.social');
eq('bluesky urls', M.mgBskyUrls('https://public.api.bsky.app/', M.mgFeedSpec('#sdr @alice.bsky.social'), {feeds: ['at://did:plc:x/app.bsky.feed.generator/f'], limit: 10}).map(u => u.kind + ' ' + u.url.split('/xrpc/')[1].split('?')[0]),
  ['search app.bsky.feed.searchPosts', 'author app.bsky.feed.getAuthorFeed', 'feed app.bsky.feed.getFeed']);
ok('none-tags drop a post', !M.mgFeedKeep({tags: 'sdr, Spam'}, M.mgFeedSpec('-#spam')) && M.mgFeedKeep({tags: 'sdr'}, M.mgFeedSpec('-#spam')));


// ---- RSS / Atom / JSON Feed ----
const RSS2 = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE rss [<!ENTITY xxe "boom">]><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>RTL-SDR &amp; friends</title><language>en-us</language>
<item><title><![CDATA[New <b>antenna</b> for 433 MHz]]></title><link>https://ex.org/a1</link><guid isPermaLink="false">a1</guid><pubDate>Wed, 29 Oct 2026 10:00:00 +0000</pubDate>
<dc:creator>Аня</dc:creator><category>SDR</category><category><![CDATA[Antennas]]></category>
<description>&lt;p&gt;Short &amp;amp; sweet &lt;img src="https://ex.org/i.jpg"&gt;&lt;/p&gt;</description><content:encoded><![CDATA[<p>Full text with <a href="x">link</a> &amp; image <img src="https://ex.org/full.png"> &xxe;</p>]]></content:encoded></item>
<item><title>Spam item</title><link>https://ex.org/a2</link><guid>a2</guid><pubDate>Thu, 30 Oct 2026 09:00:00 GMT</pubDate><category>spam</category><enclosure url="https://ex.org/pic.jpg" type="image/jpeg" length="1"/></item>
</channel></rss>`;
const f1 = M.mgRssParse(RSS2);
eq('rss2: feed title, count, entities and CDATA', [f1.title, f1.items.length, f1.items[0].title], ['RTL-SDR & friends', 2, 'New antenna for 433 MHz']);
eq('rss2: fields', [f1.items[0].id, f1.items[0].url, f1.items[0].author, f1.items[0].tags, f1.items[0].t, f1.items[0].lang], ['a1', 'https://ex.org/a1', 'Аня', 'SDR, Antennas', Date.parse('2026-10-29T10:00:00Z'), 'en-us']);
ok('rss2: content:encoded is stripped to text, the custom entity from the DTD is not expanded', /^Full text with link & image/.test(f1.items[0].summary) && !/boom/.test(f1.items[0].summary), f1.items[0].summary);
eq('rss2: image from the markup, and from an image enclosure', [f1.items[0].image, f1.items[1].image], ['https://ex.org/full.png', 'https://ex.org/pic.jpg']);
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="ru"><title>Лента</title>
<entry><title type="html">Hello &amp;amp; bye</title><link rel="self" href="https://ex.org/self"/><link rel="alternate" href="https://ex.org/e1"/><id>tag:ex.org,2026:1</id><updated>2026-10-30T08:00:00Z</updated><published>2026-10-29T08:00:00Z</published>
<author><name>Боб</name></author><category term="linux"/><summary>Кратко</summary><media:thumbnail url="https://ex.org/t.jpg"/></entry></feed>`;
const f2 = M.mgRssParse(ATOM);
eq('atom: title, alternate link, id, date (published wins), author, category, thumbnail, language', [f2.items[0].title, f2.items[0].url, f2.items[0].id, f2.items[0].t, f2.items[0].author, f2.items[0].tags, f2.items[0].image, f2.items[0].lang, f2.items[0].summary],
  ['Hello & bye', 'https://ex.org/e1', 'tag:ex.org,2026:1', Date.parse('2026-10-29T08:00:00Z'), 'Боб', 'linux', 'https://ex.org/t.jpg', 'ru', 'Кратко']);
const RDF = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Old</title></channel><item rdf:about="https://ex.org/r1"><title>RDF item</title><link>https://ex.org/r1</link><dc:date>2026-10-28T00:00:00Z</dc:date><dc:subject>radio</dc:subject></item></rdf:RDF>`;
const f3 = M.mgRssParse(RDF); eq('rss 1.0 (RDF): item, date, subject', [f3.items.length, f3.items[0].id, f3.items[0].tags, f3.items[0].t], [1, 'https://ex.org/r1', 'radio', Date.parse('2026-10-28T00:00:00Z')]);
const f4 = M.mgRssParse(JSON.stringify({version: 'https://jsonfeed.org/version/1.1', title: 'JF', items: [{id: '1', url: 'https://ex.org/j1', title: 'T', content_text: 'body', tags: ['a', 'b'], date_published: '2026-10-30T00:00:00Z', authors: [{name: 'Z'}]}]}));
eq('json feed', [f4.title, f4.items[0].tags, f4.items[0].author, f4.items[0].summary], ['JF', 'a, b', 'Z', 'body']);
ok('a web page is not a feed', (() => { try { M.mgRssParse('<html><body>hi</body></html>'); return false; } catch (e) { return /not a feed/.test(e.message); } })());
ok('a truncated feed is read as far as it goes', M.mgRssParse('<rss><channel><title>T</title><item><title>one</title><link>l</link></item><item><title>two').items.length === 2);
ok('words: any of them, exclusion wins, categories count', M.mgRssMatch({title: 'New Antenna', summary: '', tags: ''}, M.mgFeedSpec('antenna sdr')) && !M.mgRssMatch({title: 'New Antenna', summary: 'spam inside', tags: ''}, M.mgFeedSpec('antenna -spam')) && M.mgRssMatch({title: 'x', summary: '', tags: 'SDR'}, M.mgFeedSpec('sdr')) && M.mgRssMatch({title: 'anything', summary: '', tags: ''}, M.mgFeedSpec('')));

// ---- опрос против имитаций ----
const rig = (proto, cfg) => { const r = {msgs: [], st: []}; r.s = M.mgConnect(proto, {retry: false, via: 'page', io, pollMs: 5000, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])}); r.state = () => (r.st.at(-1) || [])[0]; return r; };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
const mkStatus = (id, tags, extra = {}) => ({id: String(id), created_at: new Date(Date.now() - (1000 - id) * 1000).toISOString(), content: '<p>post ' + id + '</p>', url: 'https://m/' + id, language: 'en', account: {acct: 'u' + id}, tags: tags.map(name => ({name})), media_attachments: [], ...extra});

{ // Mastodon: 90 постов; первый опрос — 40 свежих, затем догоняем со since_id
  let posts = Array.from({length: 90}, (_, i) => mkStatus(i + 1, i % 2 ? ['sdr'] : ['sdr', 'spam']));       // старые → новые
  const reqs = []; let denied = false;
  const srv = http.createServer((req, res) => {
    reqs.push(req.url); const u = new URL(req.url, 'http://x'), js = (o, code = 200) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (denied) return js({error: 'This API requires an authenticated user'}, 401);
    if (!u.pathname.startsWith('/api/v1/timelines/tag/sdr')) return js({error: 'nope'}, 404);
    const since = u.searchParams.get('since_id'), max = u.searchParams.get('max_id'), lim = +u.searchParams.get('limit') || 20;
    let l = posts.filter(p => !(u.searchParams.getAll('none[]').some(t => p.tags.some(x => x.name === t))));
    if (since) l = l.filter(p => +p.id > +since); if (max) l = l.filter(p => +p.id < +max);
    js(l.sort((a, b) => b.id - a.id).slice(0, lim));
  }); servers.push(srv);
  const port = await listen(srv), server = 'http://127.0.0.1:' + port;
  const A = rig('mastodon', {server, channel: '#sdr -#spam', history: 86400});
  await until(() => A.msgs.length >= 40);
  ok('mastodon: the first read gives the newest posts, oldest first, exclusions applied server-side', A.msgs.length === 40 && +A.msgs[0].id < +A.msgs[39].id && A.msgs.every(m => !/spam/.test(m.post.tags)) && reqs[0].includes('none[]=spam'), reqs[0]);
  ok('mastodon: records carry the author, text and extras for a Table', A.msgs[0].kind === 'post' && /^u/.test(A.msgs[0].from) && /^post \d+$/.test(A.msgs[0].text) && A.msgs[0].post.url.startsWith('https://m/') && A.msgs[0].post.tags === 'sdr', JSON.stringify(A.msgs[0]));
  ok('mastodon: status says what is read', /mastodon|127\.0\.0\.1/i.test(A.st.at(-1)[1]) && A.state() === 'up', JSON.stringify(A.st.at(-1)));
  for (let i = 91; i <= 140; i++) posts.push(mkStatus(i, ['sdr']));                // 50 новых — больше одной страницы
  A.s.close();
  const B = rig('mastodon', {server, channel: '#sdr', history: 0, pollMs: 5000});    // history 0: только то, что придёт после
  await until(() => B.state() === 'up');
  ok('mastodon: history 0 shows nothing at first', B.msgs.length === 0);
  for (let i = 141; i <= 190; i++) posts.push(mkStatus(i, ['sdr']));
  await sleep(100);
  B.s.close();
  const C = rig('mastodon', {server, channel: '#sdr', history: 86400, pollMs: 5000});
  await until(() => C.msgs.length >= 40);
  ok('mastodon: the first page is at most 40 posts', C.msgs.length === 40 && C.msgs.at(-1).id === '190', C.msgs.length + ' ' + C.msgs.at(-1)?.id);
  C.s.close();
  denied = true;
  const D = rig('mastodon', {server, channel: '#sdr'}); await until(() => D.state() === 'fatal');
  ok('mastodon: an instance that wants a login is explained (and not retried)', D.state() === 'fatal' && /access token/.test(D.st.at(-1)[1]), JSON.stringify(D.st.at(-1)));
  const E = rig('mastodon', {server, channel: 'home'}); await sleep(50);
  ok('mastodon: «home» without a token is refused at once', E.state() === 'fatal' && /home/.test(E.st.at(-1)[1]));
  ok('mastodon: reading is read-only', A.s.send('x') === false);
}
{ // Mastodon: догон по since_id (страницы назад до известного)
  let posts = []; const reqs = [];
  const srv = http.createServer((req, res) => {
    reqs.push(req.url); const u = new URL(req.url, 'http://x');
    const since = u.searchParams.get('since_id'), max = u.searchParams.get('max_id'), lim = +u.searchParams.get('limit');
    let l = posts.slice(); if (since) l = l.filter(p => +p.id > +since); if (max) l = l.filter(p => +p.id < +max);
    res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(l.sort((a, b) => b.id - a.id).slice(0, lim)));
  }); servers.push(srv);
  const port = await listen(srv);
  posts.push(mkStatus(1, ['x']));
  const A = rig('mastodon', {server: 'http://127.0.0.1:' + port, channel: '', history: 86400, pollMs: 5000});
  await until(() => A.msgs.length === 1);
  ok('mastodon public timeline is asked without a tag', reqs[0].startsWith('/api/v1/timelines/public'), reqs[0]);
  for (let i = 2; i <= 101; i++) posts.push(mkStatus(i, ['x']));                // 100 новых за один интервал — больше трёх страниц по 40
  await until(() => A.msgs.length === 101, 9000);
  ok('mastodon: a gap of 100 posts is caught up page by page back to the known id, once each', A.msgs.length === 101 && new Set(A.msgs.map(m => m.id)).size === 101 && A.msgs.map(m => +m.id).every((v, k, a) => !k || v > a[k - 1]), A.msgs.length + ' ' + reqs.slice(1).join(' | '));
  ok('mastodon: the catch-up used since_id and max_id', reqs.some(r => /since_id=1&/.test(r)) && reqs.some(r => /max_id=/.test(r)));
  A.s.close();
}
{ // Bluesky
  let loginOk = true; const reqs = [], posts = [];
  const mk = (n, tags = []) => ({uri: 'at://did:plc:abc/app.bsky.feed.post/p' + n, author: {handle: 'alice.bsky.social', did: 'did:plc:abc'}, record: {text: 'post ' + n + ' ' + tags.map(t => '#' + t).join(' '), createdAt: new Date(Date.now() - (100 - n) * 1000).toISOString()}});
  for (let i = 1; i <= 5; i++) posts.push(mk(i, i % 2 ? ['sdr'] : ['sdr', 'spam']));
  const srv = http.createServer(async (req, res) => {
    reqs.push(req.method + ' ' + req.url); const u = new URL(req.url, 'http://x'), js = (o, code = 200) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    const authed = req.headers.authorization === 'Bearer JWT1';
    if (u.pathname === '/xrpc/com.atproto.server.createSession') { let b = ''; for await (const d of req) b += d; const j = JSON.parse(b); return j.password === 'app-pass' ? js({accessJwt: 'JWT1', refreshJwt: 'R', handle: j.identifier}) : js({error: 'AuthenticationRequired', message: 'Invalid identifier or password'}, 401); }
    if (u.pathname === '/xrpc/app.bsky.feed.searchPosts') return authed ? js({posts: posts.filter(p => p.record.text.includes('#' + u.searchParams.get('q').slice(1)))}) : js({error: 'Forbidden', message: 'administrative rules'}, 403);
    if (u.pathname === '/xrpc/app.bsky.feed.getAuthorFeed') return js({feed: posts.slice(0, 2).map(p => ({post: p}))});
    if (u.pathname === '/xrpc/app.bsky.feed.getFeed') return js({feed: posts.slice(2, 4).map(p => ({post: p, reason: {$type: 'app.bsky.feed.defs#reasonRepost', by: {handle: 'bob'}}}))});
    if (u.pathname === '/xrpc/com.atproto.identity.resolveHandle') return js({did: 'did:plc:feedowner'});
    js({error: 'nope'}, 404);
  }); servers.push(srv);
  const port = await listen(srv), server = 'http://127.0.0.1:' + port;
  const A = rig('bluesky', {server, channel: '@alice.bsky.social', history: 86400});
  await until(() => A.msgs.length >= 2);
  ok('bluesky: an account feed is read without a login', A.msgs.length === 2 && A.msgs[0].from === 'alice.bsky.social' && !reqs.some(r => /createSession/.test(r)), JSON.stringify(reqs));
  ok('bluesky: record is ready for a table', A.msgs[0].kind === 'post' && /^post \d/.test(A.msgs[0].text) && A.msgs[0].post.url.includes('bsky.app/profile/alice.bsky.social/post/p') && A.msgs[0].id.startsWith('at://'), JSON.stringify(A.msgs[0]));
  A.s.close();
  const F = rig('bluesky', {server, channel: 'https://bsky.app/profile/someone.bsky.social/feed/cats', history: 86400});
  await until(() => F.msgs.length >= 2);
  ok('bluesky: a bsky.app feed link is resolved to an at:// uri; reposts are noted', F.msgs.length === 2 && F.msgs[0].post.boost_by === 'bob' && reqs.some(r => /getFeed\?feed=at%3A%2F%2Fdid%3Aplc%3Afeedowner%2Fapp\.bsky\.feed\.generator%2Fcats/.test(r)), JSON.stringify(reqs.slice(-3)));
  F.s.close();
  const B = rig('bluesky', {server, channel: '#sdr'}); await until(() => B.state() === 'fatal');
  ok('bluesky: search by tag without a login is explained', B.state() === 'fatal' && /app password/.test(B.st.at(-1)[1]) && /@name/.test(B.st.at(-1)[1]), JSON.stringify(B.st.at(-1)));
  const C = rig('bluesky', {server, channel: '#sdr -#spam', user: 'me.bsky.social', pass: 'app-pass', history: 86400});
  await until(() => C.msgs.length >= 3);
  ok('bluesky: search with an app password, the excluded tag is dropped', C.msgs.length === 3 && C.msgs.every(m => !/spam/.test(m.post.tags)) && reqs.some(r => /createSession/.test(r)), JSON.stringify(C.msgs.map(m => m.text)));
  const n0 = C.msgs.length; posts.push(mk(9, ['sdr'])); C.s.close();
  const D = rig('bluesky', {server, channel: '#sdr', user: 'me.bsky.social', pass: 'wrong'}); await until(() => D.state() === 'fatal');
  ok('bluesky: a wrong app password is fatal', D.state() === 'fatal' && /login refused/.test(D.st.at(-1)[1]), JSON.stringify(D.st.at(-1)));
  const E = rig('bluesky', {server, channel: ''}); ok('bluesky: nothing to read is explained', E.state() === 'fatal' && /#tags/.test(E.st.at(-1)[1]));
}
{ // RSS: опрос нескольких лент, слова, повторы, ошибка одной из лент; через Node-мост (обход CORS)
  const ft = {a: RSS2, b: ATOM}; let hits = 0; const reqs = [];
  const srv = http.createServer((req, res) => { reqs.push(req.headers['user-agent'] || ''); hits++;
    const key = req.url.slice(1);
    if (key === 'dead') { res.writeHead(404); return res.end(); }
    if (key === 'html') { res.writeHead(200, {'content-type': 'text/html'}); return res.end('<html>page</html>'); }
    res.writeHead(200, {'content-type': 'application/xml'}); res.end(ft[key]); }); servers.push(srv);
  const port = await listen(srv), base = 'http://127.0.0.1:' + port + '/';
  const A = rig('rss', {server: base + 'a ' + base + 'b ' + base + 'dead', channel: 'antenna linux -spam', history: 86400 * 400, pollMs: 60000});
  await until(() => A.msgs.length >= 2, 6000);
  ok('rss: several feeds at once, words filter, the excluded item is dropped, a dead feed is only a warning', A.msgs.length === 2 && A.msgs.every(m => !/Spam/.test(m.text)) && A.state() === 'warn' && /failed/.test(A.st.at(-1)[1]), JSON.stringify(A.st.at(-1)));
  ok('rss: records for a Table (title, summary, feed, url, tags, image)', A.msgs[0].kind === 'post' && A.msgs[0].post.title && 'summary' in A.msgs[0].post && A.msgs[0].post.feed && A.msgs[0].post.url.startsWith('https://ex.org/'), JSON.stringify(A.msgs[0]));
  ok('rss: the reader introduces itself (User-Agent)', reqs.every(u => /DSP-workbench/.test(u)));
  ok('rss: oldest first', A.msgs[0].t <= A.msgs[1].t);
  A.s.close();
  const B = rig('rss', {server: base + 'html', channel: ''}); await until(() => B.state() === 'fatal');
  ok('rss: a page instead of a feed is explained and not retried', B.state() === 'fatal' && /not a feed/.test(B.st.at(-1)[1]), JSON.stringify(B.st.at(-1)));
  const C = rig('rss', {server: 'ftp://x/feed'}); ok('rss: only http(s) addresses', C.state() === 'fatal');
  const D = rig('rss', {server: base + 'a', channel: '', history: 0}); await until(() => D.state() === 'up');
  ok('rss: history 0 shows nothing at first', D.msgs.length === 0); D.s.close();
  // через Node-мост: CORS у моста нет — он сам берёт ленту
  const br = createMsgrBridge({port: 0}); const bp = (await br.listen()).port; servers.push({close: () => br.close()});
  const E = rig('rss', {server: base + 'b', channel: 'linux', history: 86400 * 400, bridge: 'ws://127.0.0.1:' + bp, via: 'auto', io: {}});
  await until(() => E.msgs.length >= 1, 6000);
  ok('rss: with a gateway set, the Node bridge fetches the feed (auto)', E.msgs.length === 1 && /Hello/.test(E.msgs[0].text), JSON.stringify(E.st.slice(-2)));
  E.s.close();
  const lim = createMsgrBridge({port: 0, hosts: ['feeds.allowed.example']}); const lp = (await lim.listen()).port; servers.push({close: () => lim.close()});
  const L = rig('rss', {server: base + 'a', bridge: 'ws://127.0.0.1:' + lp, via: 'auto', io: {}});
  await until(() => L.st.some(s => /not in --hosts/.test(s[1])), 6000);
  ok('rss: --hosts of the bridge limits which feeds it may fetch', L.st.some(s => /not in --hosts/.test(s[1])), JSON.stringify(L.st)); L.s.close();
}
for (const s of servers) try { s.close(); s.closeAllConnections?.(); } catch (e) {}
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
