"use strict";
/* ============================ Ленты: Mastodon и Bluesky ============================
   Чистая логика без DOM (страница и Node). Читаются публичные ленты — без входа, где сервер это разрешает:
   • Mastodon: GET /api/v1/timelines/tag/:тег (+ any[] / none[]), /timelines/public, /timelines/home (последняя — с токеном);
     анонимный доступ включает админ инстанса, токен — необязателен.
   • Bluesky: ленты аккаунтов (getAuthorFeed) и кастомные ленты (getFeed) — без входа; поиск по тегу (searchPosts) —
     только со входом (app password), публичный сервер отвечает 403.
   Запись поста (rec): {id, from, name, text, url, tags, lang, avatar, image, likes, boosts, replies, cw, boost_by, t}.
   Разбор — tools/test-feed.mjs. */

const mgFeedLow=s=>String(s).toLowerCase();
const FEED_ENT={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function mgHtmlText(h){                                       // HTML поста Mastodon → простой текст с переводами строк
  return String(h||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>\s*<p[^>]*>/gi,'\n\n').replace(/<[^>]*>/g,'')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{
      if(e[0]==='#'){ const c=e[1]==='x' || e[1]==='X' ? parseInt(e.slice(2),16) : +e.slice(1); try{ return String.fromCodePoint(c); }catch(x){ return ''; } }
      return FEED_ENT[mgFeedLow(e)] ?? m;
    }).trim();
}
// «#radio sdr -#spam @user.bsky.social at://did/app.bsky.feed.generator/x home local» → части запроса
function mgFeedSpec(s){
  const o={tags:[],none:[],actors:[],feeds:[],home:false,local:false};
  for(let t of String(s||'').split(/[\s,;]+/).filter(Boolean)){
    const low=mgFeedLow(t);
    if(low==='home') o.home=true; else if(low==='local') o.local=true;
    else if(/^at:\/\//.test(t) || /^https?:\/\/bsky\.app\/profile\/[^/]+\/feed\//i.test(t)) o.feeds.push(t);
    else if(t[0]==='@') o.actors.push(t.slice(1));
    else if(t[0]==='-'){ t=t.replace(/^-#?/,''); if(t) o.none.push(mgFeedLow(t)); }
    else { t=t.replace(/^#/,''); if(t) o.tags.push(mgFeedLow(t)); }
  }
  return o;
}
const mgFeedHas=(tags,list)=>list.length>0 && tags.some(t=>list.includes(mgFeedLow(t)));
const mgFeedKeep=(rec,spec)=>!mgFeedHas(rec.tags ? String(rec.tags).split(',').map(x=>x.trim()).filter(Boolean) : [],spec.none);

// ---------- Mastodon ----------
function mgMastoUrl(server,spec,o){                           // o: {sinceId,maxId,limit}
  const q=[]; const add=(k,v)=>q.push(k+'='+encodeURIComponent(v));
  let path='/api/v1/timelines/public';
  if(spec.tags.length){
    path='/api/v1/timelines/tag/'+encodeURIComponent(spec.tags[0]);
    for(const t of spec.tags.slice(1)) add('any[]',t);
    for(const t of spec.none) add('none[]',t);
    if(spec.local) add('local','true');
  } else if(spec.home) path='/api/v1/timelines/home';
  else if(spec.local) add('local','true');
  if(o.sinceId) add('since_id',o.sinceId);
  if(o.maxId) add('max_id',o.maxId);
  add('limit',o.limit||40);
  return String(server).replace(/\/+$/,'')+path+'?'+q.join('&');
}
const mgIdGt=(a,b)=>{ a=String(a); b=String(b); return a.length!==b.length ? a.length>b.length : a>b; };   // id Mastodon — число-строка без ограничения длины
function mgMastoPost(st){
  if(!st || typeof st!=='object') return null;
  const boost=st.reblog && typeof st.reblog==='object' ? st.reblog : null, s=boost||st, a=s.account||{};
  const img=(s.media_attachments||[]).find(m=>m.type==='image');
  return {id:String(st.id),from:String(a.acct||a.username||''),name:String(a.display_name||a.acct||a.username||''),text:mgHtmlText(s.content),url:String(s.url||s.uri||''),
    tags:(s.tags||[]).map(t=>t.name).join(', '),lang:String(s.language||''),avatar:String(a.avatar_static||a.avatar||''),image:img ? String(img.preview_url||img.url||'') : '',
    likes:+s.favourites_count||0,boosts:+s.reblogs_count||0,replies:+s.replies_count||0,cw:String(s.spoiler_text||''),
    boost_by:boost ? String((st.account||{}).acct||'') : '',t:Date.parse(st.created_at)||0};
}

// ---------- Bluesky ----------
const mgBskyRkey=uri=>String(uri).split('/').pop();
function mgBskyPost(view,reason){
  const p=view && view.post ? view.post : view; if(!p || !p.record) return null;
  const r=p.record, a=p.author||{}, tags=new Set();
  for(const t of r.tags||[]) tags.add(String(t));
  for(const f of r.facets||[]) for(const ft of f.features||[]) if(ft.tag) tags.add(String(ft.tag));
  for(const m of String(r.text||'').matchAll(/(?:^|\s)#([\p{L}\p{N}_]{1,64})/gu)) tags.add(m[1]);
  const e=p.embed||{}, img=(e.images||[])[0] || (e.media && (e.media.images||[])[0]), ext=e.external || (e.media && e.media.external);
  const by=reason && /reasonRepost/.test(reason.$type||'') && reason.by ? String(reason.by.handle||'') : '';
  return {id:String(p.uri),from:String(a.handle||''),name:String(a.displayName||a.handle||''),text:String(r.text||''),
    url:'https://bsky.app/profile/'+(a.handle||a.did)+'/post/'+mgBskyRkey(p.uri),tags:[...tags].join(', '),lang:String((r.langs||[])[0]||''),
    avatar:String(a.avatar||''),image:img ? String(img.thumb||img.fullsize||'') : ext && ext.thumb ? String(ext.thumb) : '',
    likes:+p.likeCount||0,boosts:+p.repostCount||0,replies:+p.replyCount||0,cw:'',boost_by:by,t:Date.parse(r.createdAt||p.indexedAt)||0};
}
function mgBskyUrls(server,spec,o){                           // → [{kind,url}]; kind: search | author | feed
  const base=String(server).replace(/\/+$/,'')+'/xrpc/', lim=o.limit||30, out=[];
  for(const t of spec.tags) out.push({kind:'search',url:base+'app.bsky.feed.searchPosts?q='+encodeURIComponent('#'+t)+'&sort=latest&limit='+lim});
  for(const a of spec.actors) out.push({kind:'author',url:base+'app.bsky.feed.getAuthorFeed?actor='+encodeURIComponent(a)+'&filter=posts_no_replies&limit='+lim});
  for(const f of o.feeds||[]) out.push({kind:'feed',url:base+'app.bsky.feed.getFeed?feed='+encodeURIComponent(f)+'&limit='+lim});
  return out;
}
const mgBskyPosts=j=>(j && (j.feed ? j.feed.map(x=>mgBskyPost(x,x.reason)) : (j.posts||[]).map(x=>mgBskyPost(x)))||[]).filter(Boolean);
