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

// ---------- RSS / Atom / RSS 1.0 (RDF) / JSON Feed ----------
// Лента — чужой текст: DOMParser нет в Node, поэтому свой терпимый разбор. DTD и пользовательские сущности не раскрываем.
function mgXmlTree(src){
  const s=String(src); const root={name:'#root',attrs:{},kids:[],text:''}, stack=[root]; let i=0, nodes=0;
  const top=()=>stack[stack.length-1];
  while(i<s.length){
    const lt=s.indexOf('<',i);
    if(lt<0){ top().text+=mgXmlUnesc(s.slice(i)); break; }
    if(lt>i) top().text+=mgXmlUnesc(s.slice(i,lt));
    if(s.startsWith('<!--',lt)){ const e=s.indexOf('-->',lt+4); i=e<0 ? s.length : e+3; continue; }
    if(s.startsWith('<![CDATA[',lt)){ const e=s.indexOf(']]>',lt+9); top().text+=s.slice(lt+9,e<0 ? s.length : e); i=e<0 ? s.length : e+3; continue; }
    if(s[lt+1]==='?'){ const e=s.indexOf('?>',lt); i=e<0 ? s.length : e+2; continue; }
    if(s[lt+1]==='!'){                                         // <!DOCTYPE … [ … ]> — пропускаем целиком
      let d=0, k=lt+2; for(;k<s.length;k++){ if(s[k]==='[') d++; else if(s[k]===']') d--; else if(s[k]==='>' && d<=0) break; }
      i=k+1; continue;
    }
    let q='', end=-1;
    for(let k=lt+1;k<s.length;k++){ const c=s[k]; if(q){ if(c===q) q=''; } else if(c==='"' || c==="'") q=c; else if(c==='>'){ end=k; break; } }
    if(end<0) break;
    const tag=s.slice(lt+1,end); i=end+1;
    if(tag[0]==='/'){                                          // закрывающий: поднимаемся до одноимённого, лишние закрываем (ленты бывают кривыми)
      const name=tag.slice(1).trim(); let k=stack.length-1; while(k>0 && stack[k].name!==name) k--;
      if(k>0) while(stack.length>k){ const n=stack.pop(); top().kids.push(n); }
      continue;
    }
    const self=tag.endsWith('/'), body=self ? tag.slice(0,-1) : tag, m=/^([^\s/]+)/.exec(body); if(!m) continue;
    if(++nodes>60000 || stack.length>120) throw new Error('feed is too complex');
    const node={name:m[1],attrs:{},kids:[],text:''};
    for(const a of body.slice(m[1].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]]=mgXmlUnesc(a[2]!==undefined ? a[2] : a[3]);
    if(self) top().kids.push(node); else stack.push(node);
  }
  while(stack.length>1){ const n=stack.pop(); top().kids.push(n); }
  return root;
}
const mgNodeText=n=>(n.text||'')+n.kids.map(mgNodeText).join('');
const mgKidText=(n,name)=>{ const k=mgKid(n,name); return k ? mgNodeText(k).trim() : ''; };
const mgFirstImg=h=>{ const m=/<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(String(h||'')); return m ? mgXmlUnesc(m[1]) : ''; };
const mgDesc=h=>{ const t=mgHtmlText(h); return t.length>600 ? t.slice(0,597)+'…' : t; };

// → {title, items:[{id,title,summary,url,tags,image,author,t,lang}]}; бросает ошибку, если это не лента
function mgRssParse(text){
  text=String(text||'').replace(/^﻿/,'').trimStart();
  if(text[0]==='{'){                                           // JSON Feed
    let j; try{ j=JSON.parse(text); }catch(e){ throw new Error('not a feed'); }
    if(!j || !Array.isArray(j.items)) throw new Error('not a feed');
    return {title:String(j.title||''),items:j.items.map(it=>({id:String(it.id||it.url||''),title:String(it.title||''),summary:mgDesc(it.summary||it.content_html||it.content_text||''),url:String(it.url||it.external_url||''),
      tags:(it.tags||[]).join(', '),image:String(it.image||it.banner_image||mgFirstImg(it.content_html)),author:String(((it.authors||[])[0]||it.author||{}).name||''),t:Date.parse(it.date_published||it.date_modified)||0,lang:String(it.language||j.language||'')}))};
  }
  const root=mgXmlTree(text), feed=root.kids.find(k=>/^(rss|feed|rdf:rdf|rdf)$/i.test(mgLocal(k.name)) || /^(rss|feed|RDF)$/.test(mgLocal(k.name)));
  if(!feed) throw new Error('not a feed — the answer is not RSS, Atom or JSON Feed (is it a web page?)');
  const kind=mgLocal(feed.name).toLowerCase(), chan=kind==='rss' ? mgKid(feed,'channel')||feed : feed;
  const title=mgKidText(chan,'title'), lang=mgKidText(chan,'language')||feed.attrs['xml:lang']||'';
  const entries=kind==='feed' ? mgKids(feed,'entry') : (kind==='rss' ? mgKids(chan,'item') : mgKids(feed,'item'));
  const items=entries.map(e=>{
    const cats=mgKids(e,'category').map(c=>c.attrs.term||c.attrs.label||mgNodeText(c).trim()).concat(mgKids(e,'subject').map(c=>mgNodeText(c).trim())).filter(Boolean);
    let url=mgKidText(e,'link');
    const links=mgKids(e,'link'); if(kind==='feed'){ const alt=links.find(l=>!l.attrs.rel || l.attrs.rel==='alternate') || links[0]; url=alt ? alt.attrs.href||'' : ''; }
    const html=mgKidText(e,'encoded')||mgKidText(e,'content')||mgKidText(e,'description')||mgKidText(e,'summary');
    const enc=mgKids(e,'enclosure').find(x=>/^image\//i.test(x.attrs.type||'')), th=mgKid(e,'thumbnail')||mgKid(e,'content'), mt=th && /image|jpe?g|png|webp|gif/i.test((th.attrs.type||'')+(th.attrs.medium||'')+(th.attrs.url||'')) ? th : mgKid(e,'thumbnail');
    const date=mgKidText(e,'pubDate')||mgKidText(e,'published')||mgKidText(e,'updated')||mgKidText(e,'date');
    const author=mgKidText(e,'creator')||(kind==='feed' ? mgKidText(mgKid(e,'author')||{kids:[],text:''},'name') : '')||mgKidText(e,'author');
    return {id:mgKidText(e,'guid')||mgKidText(e,'id')||e.attrs['rdf:about']||url||mgKidText(e,'title'),title:mgHtmlText(mgKidText(e,'title')),summary:mgDesc(mgKidText(e,'summary')||html),url:url.trim(),
      tags:[...new Set(cats)].join(', '),image:String((enc&&enc.attrs.url)||(mt&&mt.attrs.url)||mgFirstImg(html)||''),author:mgHtmlText(author),t:Date.parse(date)||0,lang:String(e.attrs['xml:lang']||lang)};
  });
  return {title:mgHtmlText(title),items};
}
// слова канала → подходит ли запись: любое из включаемых слов в заголовке / тексте / рубриках, ни одного из исключаемых
function mgRssMatch(it,spec){
  const hay=mgFeedLow(it.title+' '+it.summary+' '+it.tags);
  if(spec.none.some(w=>hay.includes(w))) return false;
  return !spec.tags.length || spec.tags.some(w=>hay.includes(w));
}
