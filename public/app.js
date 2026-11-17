'use strict';
(() => {
  /* ---------- basics ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const CATS = ['Music', 'Gaming', 'Learning', 'Vlogs', 'Tech', 'Art', 'Other'];
  const HUES = [38, 12, 160, 200, 265, 330];
  const PAGE = 24;
  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const IC = {
    like: svg('<path d="M12 20.5S3.5 15.5 3.5 9.3A4.3 4.3 0 0 1 12 7.5a4.3 4.3 0 0 1 8.5 1.8c0 6.2-8.5 11.2-8.5 11.2z"/>'),
    share: svg('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
    chat: svg('<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'),
    bin: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>', ' stroke-width="2.4"'),
    back: svg('<path d="M15 5l-7 7 7 7"/>', ' stroke-width="2.4"'),
    play: svg('<path d="M7 4v16l13-8z" fill="currentColor"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
  };

  const S = {
    me: null, unread: 0, view: '', arg: '',
    home: { cat: 'All', q: '', videos: [], done: false, loading: false, tok: 0, error: '' },
    stories: [], watch: null, convos: [], convosLoaded: false,
    chat: { user: null, msgs: [], loading: false, error: '' },
    story: null, draft: null, pick: null, es: null, armed: null, busy: new Set(),
  };

  /* ---------- talking to the server ---------- */
  async function api(method, url, body) {
    const init = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'StreamNest' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, init); } catch { throw new Error('Cannot reach the server. Check your connection.'); }
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok) {
      const e = new Error((data && data.error) || `Request failed (${r.status}).`);
      e.status = r.status;
      if (r.status === 401 && S.me) setMe(null, 0);
      throw e;
    }
    return data;
  }
  function uploadFile(file, kind, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/uploads?kind=${kind}`);
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.setRequestHeader('X-Requested-With', 'StreamNest');
      x.responseType = 'json';
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) resolve(x.response);
        else reject(new Error((x.response && x.response.error) || `Upload failed (${x.status}).`));
      };
      x.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
      x.send(file);
    });
  }

  /* ---------- formatting ---------- */
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)} min ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)} h ago`;
    const d = h / 24; if (d < 30) return `${Math.floor(d)} d ago`;
    return new Date(ms).toLocaleDateString();
  }
  function fmtDur(sec) {
    const s = Math.round(sec || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  }
  const fmtNum = (n) => new Intl.NumberFormat('en', { notation: 'compact' }).format(n || 0);
  const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
  function hueOf(str) { let h = 0; for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
  const firstChar = (s) => (Array.from(String(s || '').trim())[0] || '?').toUpperCase();
  const avatar = (u, cls = 'ava') => `<span class="${cls}" data-hue="${hueOf(u && u.username)}" aria-hidden="true">${esc(firstChar(u && (u.displayName || u.username)))}</span>`;
  const thumb = (v) => `<div class="thumb" data-hue="${hueOf(v.id + v.title)}"><span class="ph">${esc(firstChar(v.title))}</span>${v.thumbUrl ? `<img src="${esc(v.thumbUrl)}" alt="" loading="lazy" data-fallback>` : ''}${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ''}</div>`;
  const card = (v) => `<a class="card" href="#/watch/${enc(v.id)}">${thumb(v)}<div class="cmeta">${avatar(v.author)}<div><h3>${esc(v.title)}</h3><p class="sub">${esc(v.author.displayName)}</p><p class="sub">${plural(v.views, 'view')} · ${ago(v.createdAt)}</p></div></div></a>`;
  const empty = (title, text, extra = '') => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${extra}</div>`;

  /* Colours come from data-hue attributes. Setting them through the style API
   * (not inline style="" text) keeps the strict Content-Security-Policy happy. */
  function html(el, markup) {
    if (!el) return;
    el.innerHTML = markup;
    if (el.dataset && el.dataset.hue) el.style.setProperty('--h', el.dataset.hue);
    $$('[data-hue]', el).forEach((n) => n.style.setProperty('--h', n.dataset.hue));
  }

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function notice(text) { const el = $('#notice'); el.textContent = text || ''; el.hidden = !text; }
  function remember() { try { sessionStorage.setItem('sn-next', location.hash || '#/'); } catch { /* storage off */ } }
  function needLogin() { if (S.me) return true; remember(); location.hash = '#/login'; return false; }

  /* ---------- account + live events ---------- */
  function renderAccount() {
    html($('#account'), S.me
      ? `<a class="who" href="#/c/${enc(S.me.username)}" title="Your channel" aria-label="Your channel">${avatar(S.me, 'ava sm')}</a><button class="btn ghost" data-act="logout">Sign out</button>`
      : '<a class="btn pri" href="#/login">Sign in</a>');
    renderBadge();
  }
  function renderBadge() {
    const b = $('#badge');
    b.textContent = S.unread > 99 ? '99+' : String(S.unread);
    b.hidden = !S.unread;
  }
  function setMe(user, unread) {
    S.me = user;
    S.unread = unread || 0;
    renderAccount();
    connectEvents();
  }
  function connectEvents() {
    if (S.es) { S.es.close(); S.es = null; }
    if (!S.me || !window.EventSource) return;
    S.es = new EventSource('/api/events');
    S.es.addEventListener('chat', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onChat(m);
    });
  }
  function onChat(m) {
    if (!S.me) return;
    const mine = same(m.from, S.me.username);
    const other = mine ? m.to : m.from;
    const open = S.view === 'messages' && S.chat.user && same(S.chat.user.username, other);
    if (open) {
      if (!S.chat.msgs.some((x) => x.id === m.id)) { S.chat.msgs.push(m); renderLog(); }
      if (!mine) markRead(other);
    } else if (!mine) {
      S.unread += 1;
      renderBadge();
      toast(`New message from ${m.from}`);
    }
    if (S.view === 'messages') loadConvos();
  }
  function markRead(username) {
    api('POST', `/api/messages/${enc(username)}/read`).then((d) => {
      S.unread = d.unread;
      renderBadge();
      const c = S.convos.find((x) => same(x.user.username, username));
      if (c && c.unread) { c.unread = 0; renderConvos(); }
    }).catch(() => {});
  }

  /* ---------- router ---------- */
  const VIEWS = { '': 'home', watch: 'watch', upload: 'upload', messages: 'messages', c: 'channel', login: 'login', signup: 'signup', me: 'me' };
  function hashParts() {
    return location.hash.replace(/^#\/?/, '').split('/').map((p) => { try { return decodeURIComponent(p); } catch { return ''; } });
  }
  function route() {
    closeStory();
    closeSheet();
    const [a = '', b = ''] = hashParts();
    const view = VIEWS[a] || 'home';
    if (view === 'me') { location.replace(S.me ? `#/c/${enc(S.me.username)}` : '#/login'); return; }
    if ((view === 'upload' || view === 'messages') && !S.me) { remember(); location.replace('#/login'); return; }
    if ((view === 'login' || view === 'signup') && S.me) { location.replace('#/'); return; }
    if (S.view === 'watch' && view !== 'watch') {
      const p = $('#player');
      if (p) { p.pause(); p.removeAttribute('src'); p.load(); }
      S.watch = null;
    }
    S.view = view;
    S.arg = b;
    S.armed = null;
    $$('.view').forEach((sec) => { sec.hidden = sec.id !== `v-${view}`; });
    const tab = view === 'channel' && S.me && same(b, S.me.username) ? 'me' : view;
    $$('.tabs a').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (view === 'home') showHome();
    else if (view === 'watch') showWatch(b);
    else if (view === 'channel') showChannel(b);
    else if (view === 'upload') showUpload();
    else if (view === 'messages') showMessages(b);
    else if (view === 'login') setTimeout(() => $('#li-user').focus(), 0);
    else if (view === 'signup') setTimeout(() => $('#su-user').focus(), 0);
  }

  /* ---------- home ---------- */
  function showHome() {
    renderChips();
    loadStories();
    loadVideos(true);
  }
  function renderChips() {
    const cats = ['All'].concat(S.me ? ['Subscriptions'] : [], CATS);
    if (!cats.includes(S.home.cat)) S.home.cat = 'All';
    html($('#chips'), cats.map((c) => `<button class="chip${S.home.cat === c ? ' on' : ''}" data-act="cat" data-cat="${c}" aria-pressed="${S.home.cat === c}">${c}</button>`).join(''));
  }
  async function loadVideos(reset) {
    const H = S.home;
    if (!reset && (H.loading || H.done)) return;
    const tok = ++H.tok;
    H.loading = true;
    if (reset) { H.videos = []; H.done = false; H.error = ''; }
    renderGrid();
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (H.q) p.set('q', H.q);
    if (H.cat === 'Subscriptions') p.set('feed', 'subs');
    else if (H.cat !== 'All') p.set('cat', H.cat);
    const last = H.videos[H.videos.length - 1];
    if (!reset && last) p.set('before', String(last.createdAt));
    try {
      const d = await api('GET', `/api/videos?${p}`);
      if (tok !== H.tok) return;
      H.videos = H.videos.concat(d.videos);
      H.done = d.videos.length < PAGE;
    } catch (e) {
      if (tok !== H.tok) return;
      H.error = e.message;
    }
    H.loading = false;
    renderGrid();
  }
  function renderGrid() {
    const H = S.home;
    let markup = H.videos.map(card).join('');
    if (!H.videos.length) {
      if (H.loading) markup = '<p class="sub">Loading videos…</p>';
      else if (H.error) markup = empty('Could not load videos', H.error);
      else if (H.cat === 'Subscriptions') markup = empty('Nothing here yet', 'Subscribe to channels to see their new videos here.');
      else if (H.q || H.cat !== 'All') markup = empty('No videos match', 'Try another search or category.');
      else markup = empty('No videos yet', 'Be the first. Press Upload to share a video.');
    }
    html($('#grid'), markup);
    const more = $('#more');
    more.hidden = !H.videos.length || H.done;
    more.disabled = H.loading;
    more.textContent = H.loading ? 'Loading…' : 'Load more';
  }

  /* ---------- stories ---------- */
  async function loadStories() {
    try { S.stories = (await api('GET', '/api/stories')).stories; } catch { /* keep the old list */ }
    renderRail();
  }
  function storyGroups() {
    const map = new Map();
    for (const s of S.stories) {
      const k = s.author.username.toLowerCase();
      if (!map.has(k)) map.set(k, { author: s.author, items: [] });
      map.get(k).items.push(s);
    }
    const groups = [...map.values()];
    if (S.me) {
      const i = groups.findIndex((g) => same(g.author.username, S.me.username));
      if (i > 0) groups.unshift(groups.splice(i, 1)[0]);
    }
    return groups;
  }
  function renderRail() {
    let markup = S.me ? '<button class="st add" data-act="add-story"><span class="ring"><span class="plus">+</span></span><span>Add story</span></button>' : '';
    markup += storyGroups().map((g) => `<button class="st" data-act="open-story" data-user="${esc(g.author.username)}"><span class="ring">${avatar(g.author, 'ava xl')}</span><span>${esc(S.me && same(g.author.username, S.me.username) ? 'Your story' : g.author.displayName)}</span></button>`).join('');
    const rail = $('#rail');
    html(rail, markup);
    rail.hidden = !markup;
  }
  function storySheet() {
    if (!needLogin()) return;
    S.draft = { hue: HUES[0], file: null, url: '' };
    openSheet(`<div class="sheet-head"><h2>New story</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">${IC.x}</button></div>
      <div class="prev" id="story-prev"></div>
      <textarea class="field" id="story-text" rows="2" maxlength="200" placeholder="What is happening?" aria-label="Story text"></textarea>
      <div class="hues" id="hues" aria-label="Background colour"></div>
      <label for="story-file">Photo (optional)<input class="field" type="file" id="story-file" accept="image/jpeg,image/png,image/webp"></label>
      <button class="btn pri" data-act="post-story" id="story-post">Share story</button>
      <p class="sub">Stories disappear after 24 hours.</p>
      <p class="status bad" id="story-status" role="alert"></p>`);
    drawDraft();
  }
  function drawDraft() {
    const d = S.draft;
    const p = $('#story-prev');
    if (!d || !p) return;
    p.style.setProperty('--h', d.hue);
    p.style.backgroundImage = d.url ? `url("${d.url}")` : '';
    p.textContent = ($('#story-text').value || '').trim() || (d.url ? '' : 'Your story');
    html($('#hues'), HUES.map((h) => `<button class="hue${h === d.hue ? ' on' : ''}" data-act="hue" data-h="${h}" data-hue="${h}" aria-label="Colour ${h}" aria-pressed="${h === d.hue}"></button>`).join(''));
  }
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1440 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('That photo could not be read.'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read. Use JPG, PNG or WebP.')); };
      img.src = url;
    });
  }
  async function postStory() {
    const d = S.draft;
    if (!d) return;
    const text = $('#story-text').value.trim();
    const btn = $('#story-post');
    const st = $('#story-status');
    if (!text && !d.file) { st.textContent = 'Write something or add a photo.'; return; }
    btn.disabled = true;
    st.textContent = '';
    try {
      let image = null;
      if (d.file) image = (await uploadFile(await shrinkImage(d.file), 'image')).id;
      const r = await api('POST', '/api/stories', { text, hue: d.hue, image });
      S.stories.push(r.story);
      closeSheet();
      renderRail();
      toast('Story shared');
    } catch (e) {
      st.textContent = e.message;
      btn.disabled = false;
    }
  }
  function openStory(username) {
    const groups = storyGroups();
    const i = groups.findIndex((g) => same(g.author.username, username));
    if (i < 0) return;
    const list = [];
    groups.slice(i).concat(groups.slice(0, i)).forEach((g) => g.items.forEach((s) => list.push(s)));
    S.story = { list, i: 0, t: null };
    showStory();
  }
  function showStory() {
    const st = S.story;
    if (!st) return;
    clearTimeout(st.t);
    const s = st.list[st.i];
    if (!s) { closeStory(); return; }
    const group = st.list.filter((x) => same(x.author.username, s.author.username));
    const gi = group.indexOf(s);
    const sv = $('#sv');
    html(sv, `<div class="svcard" data-hue="${Number(s.hue) || 0}">
      ${s.imageUrl ? `<img class="pic" src="${esc(s.imageUrl)}" alt="" data-fallback>` : ''}
      ${s.text ? `<div class="svtext${s.imageUrl ? ' cap' : ''}">${esc(s.text)}</div>` : ''}
      <div class="svtop"><div class="bars">${group.map((x, k) => `<i class="${k < gi ? 'done' : k === gi ? 'now' : ''}"><b></b></i>`).join('')}</div>
        <div class="svwho">${avatar(s.author)}<span><b>${esc(s.author.displayName)}</b> <small>${ago(s.createdAt)}</small></span>
          <span class="x">${s.mine ? `<button class="icon-btn" data-act="del-story" aria-label="Delete this story">${IC.bin}</button>` : ''}<button class="icon-btn" data-act="close-story" aria-label="Close stories">${IC.x}</button></span>
        </div></div>
      <button class="tap l" data-act="story-prev" aria-label="Previous story"></button><button class="tap r" data-act="story-next" aria-label="Next story"></button>
    </div>`);
    sv.hidden = false;
    st.t = setTimeout(() => stepStory(1), 5000);
  }
  function stepStory(n) {
    const st = S.story;
    if (!st) return;
    st.i = Math.max(0, st.i + n);
    if (st.i >= st.list.length) { closeStory(); return; }
    showStory();
  }
  function closeStory() {
    if (S.story) clearTimeout(S.story.t);
    S.story = null;
    const sv = $('#sv');
    sv.hidden = true;
    sv.innerHTML = '';
  }
  async function deleteStory() {
    const st = S.story;
    if (!st) return;
    clearTimeout(st.t);
    const s = st.list[st.i];
    try {
      await api('DELETE', `/api/stories/${enc(s.id)}`);
      S.stories = S.stories.filter((x) => x.id !== s.id);
      st.list.splice(st.i, 1);
      renderRail();
      toast('Story deleted');
      if (st.i >= st.list.length) closeStory(); else showStory();
    } catch (e) { toast(e.message); showStory(); }
  }

  /* ---------- watch ---------- */
  async function showWatch(id) {
    const root = $('#v-watch');
    html(root, '<p class="sub">Loading video…</p>');
    let d;
    try { d = await api('GET', `/api/videos/${enc(id)}`); } catch (e) {
      if (S.view === 'watch' && S.arg === id) {
        html(root, empty(e.status === 404 ? 'Video not found' : 'Could not load this video', e.status === 404 ? 'It may have been deleted.' : e.message, '<a class="link" href="#/">Back to home</a>'));
      }
      return;
    }
    if (S.view !== 'watch' || S.arg !== id) return;
    const v = d.video;
    S.watch = { v, comments: [], viewed: false };
    html(root, `<div class="watch"><div class="wmain">
        <div class="player"><video id="player" controls playsinline preload="metadata"></video>
          <div class="perr" id="perr" hidden>This video cannot play in your browser. MP4 files with H.264 video play almost everywhere.</div></div>
        <div id="wmeta"></div>
        <section class="comments"><h2 id="ccount">Comments</h2><div id="cform"></div><ul id="clist"></ul></section>
      </div><aside class="side"><h2>Up next</h2><div id="upnext"></div></aside></div>`);
    document.title = `${v.title} · StreamNest`;
    const p = $('#player');
    if (v.thumbUrl) p.poster = v.thumbUrl;
    p.addEventListener('error', () => { if (p.getAttribute('src')) $('#perr').hidden = false; });
    p.addEventListener('play', () => {
      const w = S.watch;
      if (!w || w.viewed || w.v.id !== v.id) return;
      w.viewed = true;
      api('POST', `/api/videos/${enc(v.id)}/view`).then((r) => {
        if (r.counted && S.watch && S.watch.v.id === v.id) { S.watch.v.views += 1; renderWatchMeta(); }
      }).catch(() => {});
    });
    p.src = v.videoUrl;
    renderWatchMeta();
    renderCommentForm();
    loadComments();
    loadUpNext(v.id);
  }
  function renderWatchMeta() {
    const w = S.watch;
    if (!w) return;
    const v = w.v;
    const a = v.author;
    html($('#wmeta'), `<h1 class="wtitle">${esc(v.title)}</h1>
      <div class="wrow">
        <a class="wby" href="#/c/${enc(a.username)}">${avatar(a)}<span><b>${esc(a.displayName)}</b><span class="sub">${plural(a.subscribers, 'subscriber')}</span></span></a>
        ${v.mine ? '' : `<button class="btn${a.subscribed ? '' : ' pri'}" data-act="subscribe" data-user="${esc(a.username)}" data-on="${a.subscribed ? 1 : 0}">${a.subscribed ? 'Subscribed' : 'Subscribe'}</button>`}
        <span class="grow"></span>
        <button class="btn${v.liked ? ' on' : ''}" data-act="like" aria-pressed="${v.liked}" aria-label="Like">${IC.like}<span>${fmtNum(v.likes)}</span></button>
        <button class="btn" data-act="share">${IC.share}<span>Share</span></button>
        ${v.mine ? `<button class="btn warn" data-act="del-video">${IC.bin}<span>${S.armed === 'video' ? 'Tap again to delete' : 'Delete'}</span></button>` : `<a class="btn" href="#/messages/${enc(a.username)}">${IC.chat}<span>Message</span></a>`}
      </div>
      <div class="desc"><b>${plural(v.views, 'view')} · ${esc(new Date(v.createdAt).toLocaleDateString())} · ${esc(v.category)}</b>${v.description ? `<p>${esc(v.description)}</p>` : ''}</div>`);
  }
  function renderCommentForm() {
    html($('#cform'), S.me
      ? `<form class="cform" id="comment-form">${avatar(S.me)}<input class="field" id="comment-text" maxlength="1000" placeholder="Add a comment" autocomplete="off" aria-label="Comment"><button class="btn pri" type="submit">Post</button></form>`
      : '<p class="sub"><a class="link" href="#/login" data-act="remember">Sign in</a> to like, comment and share.</p>');
  }
  async function loadComments() {
    const id = S.watch.v.id;
    try {
      const d = await api('GET', `/api/videos/${enc(id)}/comments`);
      if (!S.watch || S.watch.v.id !== id) return;
      S.watch.comments = d.comments;
    } catch { /* show what we have */ }
    renderComments();
  }
  function renderComments() {
    if (!S.watch) return;
    const list = S.watch.comments;
    $('#ccount').textContent = plural(list.length, 'comment');
    html($('#clist'), list.map((c) => `<li class="com">${avatar(c.author)}<div><a href="#/c/${enc(c.author.username)}"><b>${esc(c.author.displayName)}</b></a> <small>${ago(c.createdAt)}</small><p>${esc(c.body)}</p>${c.canDelete ? `<button class="tiny" data-act="del-comment" data-id="${c.id}">Delete</button>` : ''}</div></li>`).join('')
      || '<li class="sub">No comments yet. Start the conversation.</li>');
  }
  async function postComment() {
    const inp = $('#comment-text');
    const body = inp.value.trim();
    if (!body || !S.watch) return;
    inp.disabled = true;
    try {
      const d = await api('POST', `/api/videos/${enc(S.watch.v.id)}/comments`, { body });
      S.watch.comments.unshift(d.comment);
      inp.value = '';
      renderComments();
    } catch (e) { toast(e.message); }
    inp.disabled = false;
    inp.focus();
  }
  async function deleteComment(id) {
    try {
      await api('DELETE', `/api/comments/${enc(id)}`);
      S.watch.comments = S.watch.comments.filter((c) => String(c.id) !== String(id));
      renderComments();
    } catch (e) { toast(e.message); }
  }
  async function loadUpNext(id) {
    let list = [];
    try { list = (await api('GET', '/api/videos?limit=13')).videos.filter((x) => x.id !== id).slice(0, 12); } catch { list = []; }
    if (!S.watch || S.watch.v.id !== id) return;
    html($('#upnext'), list.map((x) => `<a class="mini" href="#/watch/${enc(x.id)}">${thumb(x)}<div><h3>${esc(x.title)}</h3><p class="sub">${esc(x.author.displayName)}</p><p class="sub">${plural(x.views, 'view')}</p></div></a>`).join('') || '<p class="sub">Nothing else yet.</p>');
  }
  async function toggleLike() {
    if (!needLogin() || !S.watch || S.busy.has('like')) return;
    const v = S.watch.v;
    S.busy.add('like');
    try { Object.assign(v, await api(v.liked ? 'DELETE' : 'POST', `/api/videos/${enc(v.id)}/like`)); renderWatchMeta(); } catch (e) { toast(e.message); }
    S.busy.delete('like');
  }
  async function deleteVideo() {
    if (!S.watch) return;
    if (S.armed !== 'video') {
      S.armed = 'video';
      renderWatchMeta();
      setTimeout(() => { if (S.armed === 'video') { S.armed = null; renderWatchMeta(); } }, 4000);
      return;
    }
    S.armed = null;
    try {
      await api('DELETE', `/api/videos/${enc(S.watch.v.id)}`);
      toast('Video deleted');
      location.hash = '#/';
    } catch (e) { toast(e.message); renderWatchMeta(); }
  }
  async function toggleSubscribe(btn) {
    if (!needLogin()) return;
    const user = btn.dataset.user;
    const on = btn.dataset.on === '1';
    btn.disabled = true;
    try {
      const d = await api(on ? 'DELETE' : 'POST', `/api/users/${enc(user)}/subscribe`);
      if (S.watch && same(S.watch.v.author.username, user)) {
        Object.assign(S.watch.v.author, { subscribed: d.subscribed, subscribers: d.subscribers });
        renderWatchMeta();
      }
      if (S.view === 'channel') showChannel(S.arg);
    } catch (e) { toast(e.message); btn.disabled = false; }
  }
  function shareVideo() {
    if (!needLogin() || !S.watch) return;
    const v = S.watch.v;
    pickPerson('Send this video to', async (u) => {
      closeSheet();
      try {
        await api('POST', `/api/messages/${enc(u.username)}`, { video: v.id });
        toast(`Sent to ${same(u.username, S.me.username) ? 'your notes' : u.displayName}`);
      } catch (e) { toast(e.message); }
    });
  }

  /* ---------- channel ---------- */
  async function showChannel(name) {
    const root = $('#v-channel');
    if (!root.innerHTML.trim() || root.dataset.user !== name.toLowerCase()) html(root, '<p class="sub">Loading channel…</p>');
    let u;
    let videos;
    try {
      const [a, b] = await Promise.all([api('GET', `/api/users/${enc(name)}`), api('GET', `/api/videos?limit=60&user=${enc(name)}`)]);
      u = a.user;
      videos = b.videos;
    } catch (e) {
      if (S.view === 'channel' && S.arg === name) html(root, empty(e.status === 404 ? 'Channel not found' : 'Could not load this channel', e.status === 404 ? 'Check the name and try again.' : e.message));
      return;
    }
    if (S.view !== 'channel' || S.arg !== name) return;
    root.dataset.user = name.toLowerCase();
    document.title = `${u.displayName} · StreamNest`;
    const actions = u.isMe
      ? `<a class="btn pri" href="#/upload">${IC.plus}<span>Upload</span></a>`
      : `<button class="btn${u.subscribed ? '' : ' pri'}" data-act="subscribe" data-user="${esc(u.username)}" data-on="${u.subscribed ? 1 : 0}">${u.subscribed ? 'Subscribed' : 'Subscribe'}</button><a class="btn" href="#/messages/${enc(u.username)}">${IC.chat}<span>Message</span></a>`;
    html(root, `<div class="chead">${avatar(u, 'ava xxl')}<div class="cinfo"><h1>${esc(u.displayName)}</h1><p class="sub">@${esc(u.username)} · ${plural(u.subscribers, 'subscriber')} · ${plural(u.videoCount, 'video')} · joined ${esc(new Date(u.joinedAt).toLocaleDateString())}</p></div><div class="cact">${actions}</div></div>
      <div class="grid">${videos.map(card).join('') || empty(u.isMe ? 'You have no videos yet' : 'No videos yet', u.isMe ? 'Press Upload to share your first one.' : 'Check back later.')}</div>`);
  }

  /* ---------- upload ---------- */
  function showUpload() {
    const sel = $('#up-cat');
    if (!sel.options.length) sel.innerHTML = CATS.map((c) => `<option>${c}</option>`).join('');
  }
  /* Read the length and grab a frame for the thumbnail, in the browser. */
  function probe(file) {
    return new Promise((resolve) => {
      const out = { duration: 0, thumb: null };
      let done = false;
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      const finish = () => { if (done) return; done = true; clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(out); };
      const timer = setTimeout(finish, 10000);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadedmetadata = () => {
        out.duration = Number.isFinite(v.duration) ? v.duration : 0;
        try { v.currentTime = Math.min(2, (out.duration || 2) / 3); } catch { finish(); }
      };
      v.onseeked = () => {
        try {
          const w = 640;
          const h = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          c.toBlob((b) => { out.thumb = b; finish(); }, 'image/jpeg', 0.82);
        } catch { finish(); }
      };
      v.onerror = finish;
      v.src = url;
    });
  }
  async function submitUpload() {
    const f = $('#up-file').files[0];
    const title = $('#up-title').value.trim();
    const st = $('#up-status');
    const btn = $('#up-submit');
    const bar = $('#up-bar');
    const say = (t, bad) => { st.textContent = t; st.classList.toggle('bad', !!bad); };
    const setBar = (p) => { bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; };
    if (!f) { say('Choose a video file first.', true); return; }
    if (!title) { say('Add a title.', true); return; }
    btn.disabled = true;
    try {
      say('Reading the video…');
      const meta = await probe(f);
      bar.hidden = false;
      setBar(0);
      say('Uploading… keep this page open.');
      const up = await uploadFile(f, 'video', (p) => { setBar(p); say(`Uploading… ${Math.round(p * 100)}%. Keep this page open.`); });
      let thumbId = null;
      if (meta.thumb) { try { thumbId = (await uploadFile(meta.thumb, 'image')).id; } catch { thumbId = null; } }
      say('Publishing…');
      const d = await api('POST', '/api/videos', { upload: up.id, thumb: thumbId, title, description: $('#up-desc').value, category: $('#up-cat').value, duration: meta.duration });
      $('#upload-form').reset();
      say('');
      bar.hidden = true;
      toast('Your video is live');
      location.hash = `#/watch/${enc(d.video.id)}`;
    } catch (e) {
      say(e.message, true);
      bar.hidden = true;
    }
    btn.disabled = false;
  }

  /* ---------- messages ---------- */
  function showMessages(name) {
    $('#msgs').classList.toggle('chat-open', !!name);
    loadConvos();
    if (name) openChat(name);
    else { S.chat = { user: null, msgs: [], loading: false, error: '' }; renderChat(); }
  }
  async function loadConvos() {
    try { S.convos = (await api('GET', '/api/conversations')).conversations; S.convosLoaded = true; } catch { /* keep the old list */ }
    renderConvos();
  }
  function renderConvos() {
    if (!S.me) return;
    const cur = S.chat.user;
    html($('#tlist'), S.convos.map((c) => {
      const self = same(c.user.username, S.me.username);
      const last = c.last;
      const preview = (same(last.from, S.me.username) && !self ? 'You: ' : '') + (last.body || (last.video ? 'Shared a video' : ''));
      return `<a class="trow${cur && same(cur.username, c.user.username) ? ' on' : ''}" href="#/messages/${enc(c.user.username)}">${avatar(c.user)}<div><b>${esc(self ? 'Notes to self' : c.user.displayName)}</b><small>${esc(preview)}</small></div>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</a>`;
    }).join('') || `<p class="sub pad">${S.convosLoaded ? 'No chats yet. Press New chat to start one.' : 'Loading chats…'}</p>`);
  }
  async function openChat(name) {
    S.chat = { user: { username: name, displayName: name }, msgs: [], loading: true, error: '' };
    renderChat();
    try {
      const d = await api('GET', `/api/messages/${enc(name)}`);
      if (S.view !== 'messages' || !same(S.arg, name)) return;
      S.chat = { user: d.user, msgs: d.messages, loading: false, error: '' };
    } catch (e) {
      if (S.view !== 'messages' || !same(S.arg, name)) return;
      S.chat.loading = false;
      S.chat.error = e.status === 404 ? 'This person does not exist.' : e.message;
    }
    renderChat();
    renderConvos();
    if (!S.chat.error) { markRead(name); setTimeout(() => { const i = $('#msg-text'); if (i && window.innerWidth > 860) i.focus(); }, 0); }
  }
  function renderChat() {
    const u = S.chat.user;
    const form = $('#send-form');
    if (!u) {
      html($('#chead'), '<h2>Your messages</h2>');
      html($('#log'), '<p class="sub center">Pick a chat, or press New chat to start one.</p>');
      form.hidden = true;
      return;
    }
    const self = S.me && same(u.username, S.me.username);
    html($('#chead'), `<a class="icon-btn back" href="#/messages" aria-label="Back to chats">${IC.back}</a><a class="chat-who" href="#/c/${enc(u.username)}">${avatar(u)}<h2>${esc(self ? 'Notes to self' : u.displayName)}</h2></a>`);
    form.hidden = !!S.chat.error || S.chat.loading;
    renderLog();
  }
  function renderLog() {
    const log = $('#log');
    const c = S.chat;
    if (c.loading) { html(log, '<p class="sub center">Loading messages…</p>'); return; }
    if (c.error) { html(log, `<p class="sub center">${esc(c.error)}</p>`); return; }
    html(log, c.msgs.map((m) => `<div class="bub${same(m.from, S.me.username) ? ' mine' : ''}">${m.body ? `<p>${esc(m.body)}</p>` : ''}${m.video ? `<a class="vshare" href="#/watch/${enc(m.video.id)}">${IC.play}<span>${esc(m.video.title || 'Shared video')}</span></a>` : (!m.body ? '<p><i>Shared a video that was deleted</i></p>' : '')}<time>${ago(m.createdAt)}</time></div>`).join('')
      || '<p class="sub center">No messages yet. Say hello.</p>');
    log.scrollTop = log.scrollHeight;
  }
  async function sendMessage() {
    const inp = $('#msg-text');
    const body = inp.value.trim();
    if (!body || !S.chat.user) return;
    const to = S.chat.user.username;
    inp.value = '';
    try {
      const d = await api('POST', `/api/messages/${enc(to)}`, { body });
      if (S.chat.user && same(S.chat.user.username, to) && !S.chat.msgs.some((x) => x.id === d.message.id)) {
        S.chat.msgs.push(d.message);
        renderLog();
      }
      loadConvos();
    } catch (e) { inp.value = body; toast(e.message); }
  }

  /* ---------- sheet + people picker ---------- */
  function openSheet(markup) {
    html($('#sheet'), markup);
    $('#scrim').hidden = false;
    const f = $('#sheet input, #sheet textarea');
    if (f) f.focus();
  }
  function closeSheet() {
    if (S.draft && S.draft.url) URL.revokeObjectURL(S.draft.url);
    S.draft = null;
    S.pick = null;
    $('#scrim').hidden = true;
    $('#sheet').innerHTML = '';
  }
  function pickPerson(title, cb) {
    openSheet(`<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">${IC.x}</button></div>
      <input class="field" id="people-q" placeholder="Search by name or username" autocomplete="off" aria-label="Search people" maxlength="40">
      <div id="people"><p class="sub">Loading people…</p></div>`);
    S.pick = cb;
    searchPeople('');
  }
  let peopleTok = 0;
  async function searchPeople(q) {
    const tok = ++peopleTok;
    let markup;
    try {
      const d = await api('GET', `/api/users?q=${enc(q)}`);
      markup = d.users.map((u) => `<button class="trow" data-act="pick" data-user="${esc(u.username)}" data-name="${esc(u.displayName)}">${avatar(u)}<div><b>${esc(same(u.username, S.me.username) ? 'Notes to self' : u.displayName)}</b><small>@${esc(u.username)}</small></div></button>`).join('') || '<p class="sub">No one found.</p>';
    } catch (e) { markup = `<p class="sub">${esc(e.message)}</p>`; }
    if (tok === peopleTok) html($('#people'), markup);
  }

  /* ---------- sign in / sign up ---------- */
  async function submitAuth(kind) {
    const form = $(`#${kind}-form`);
    const st = $(`#${kind}-status`);
    const btn = form.querySelector('button[type=submit]');
    const body = kind === 'login'
      ? { username: $('#li-user').value.trim(), password: $('#li-pass').value }
      : { username: $('#su-user').value.trim(), displayName: $('#su-name').value.trim(), password: $('#su-pass').value };
    btn.disabled = true;
    st.textContent = '';
    try {
      const d = await api('POST', `/api/${kind}`, body);
      form.reset();
      setMe(d.user, d.unread);
      toast(kind === 'login' ? `Welcome back, ${d.user.displayName}` : 'Your account is ready');
      let next = '#/';
      try { next = sessionStorage.getItem('sn-next') || '#/'; sessionStorage.removeItem('sn-next'); } catch { next = '#/'; }
      if (/^#\/(login|signup)/.test(next)) next = '#/';
      if (location.hash !== next) location.hash = next; else route();
    } catch (e) { st.textContent = e.message; }
    btn.disabled = false;
  }
  async function logout() {
    try { await api('POST', '/api/logout'); } catch { /* sign out locally anyway */ }
    setMe(null, 0);
    S.convos = [];
    S.convosLoaded = false;
    toast('Signed out');
    if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
  }

  /* ---------- events ---------- */
  const ACTIONS = {
    cat: (b) => { S.home.cat = b.dataset.cat; renderChips(); loadVideos(true); },
    more: () => loadVideos(false),
    logout,
    remember,
    like: toggleLike,
    share: shareVideo,
    subscribe: toggleSubscribe,
    'del-video': deleteVideo,
    'del-comment': (b) => deleteComment(b.dataset.id),
    'new-chat': () => pickPerson('Start a chat with', (u) => { closeSheet(); location.hash = `#/messages/${enc(u.username)}`; }),
    pick: (b) => { const cb = S.pick; if (cb) cb({ username: b.dataset.user, displayName: b.dataset.name }); },
    'close-sheet': closeSheet,
    'add-story': storySheet,
    hue: (b) => { if (S.draft) { S.draft.hue = Number(b.dataset.h); drawDraft(); } },
    'post-story': postStory,
    'open-story': (b) => openStory(b.dataset.user),
    'story-next': () => stepStory(1),
    'story-prev': () => stepStory(-1),
    'close-story': closeStory,
    'del-story': deleteStory,
  };
  document.addEventListener('click', (e) => {
    if (e.target === $('#scrim')) { closeSheet(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const fn = ACTIONS[b.dataset.act];
    if (!fn) return;
    if (b.tagName === 'BUTTON') e.preventDefault();
    fn(b, e);
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === 'search-form') {
      S.home.q = $('#search').value.trim();
      $('#search').blur();
      if (S.view !== 'home') location.hash = '#/'; else loadVideos(true);
    } else if (id === 'comment-form') postComment();
    else if (id === 'send-form') sendMessage();
    else if (id === 'upload-form') submitUpload();
    else if (id === 'login-form') submitAuth('login');
    else if (id === 'signup-form') submitAuth('signup');
  });
  let peopleTimer;
  document.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'search' && !e.target.value && S.home.q) { S.home.q = ''; if (S.view === 'home') loadVideos(true); }
    else if (id === 'story-text') drawDraft();
    else if (id === 'people-q') { clearTimeout(peopleTimer); const q = e.target.value; peopleTimer = setTimeout(() => searchPeople(q), 200); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'story-file' || !S.draft) return;
    const f = e.target.files[0];
    if (S.draft.url) URL.revokeObjectURL(S.draft.url);
    S.draft.file = f || null;
    S.draft.url = f ? URL.createObjectURL(f) : '';
    drawDraft();
  });
  document.addEventListener('keydown', (e) => {
    if (S.story) {
      if (e.key === 'Escape') closeStory();
      else if (e.key === 'ArrowRight') stepStory(1);
      else if (e.key === 'ArrowLeft') stepStory(-1);
      return;
    }
    if (e.key === 'Escape' && !$('#scrim').hidden) closeSheet();
  });
  // Broken thumbnails fall back to the coloured letter underneath.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-fallback')) t.remove();
  }, true);
  window.addEventListener('hashchange', () => { document.title = 'StreamNest'; route(); });

  /* ---------- start ---------- */
  async function init() {
    try {
      const d = await api('GET', '/api/me');
      S.me = d.user;
      S.unread = d.unread;
    } catch (e) { notice(e.message); }
    renderAccount();
    connectEvents();
    route();
    setInterval(() => { if (S.view === 'home' && !document.hidden) loadStories(); }, 60000);
  }
  init();
})();
