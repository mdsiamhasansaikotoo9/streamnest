'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');

let app;
let base;
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

before(async () => {
  app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'streamnest-test-')) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

/* A tiny browser stand-in that keeps its own login cookie. */
function client() {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const headers = { 'X-Requested-With': 'StreamNest', ...extra };
    if (cookie) headers.cookie = cookie;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

const alice = client();
const bob = client();
const carol = client();
let videoId;

test('sign up checks input and stores only a password hash', async () => {
  assert.equal((await alice('POST', '/api/signup', { username: 'a', password: 'longenough' })).status, 400);
  assert.equal((await alice('POST', '/api/signup', { username: 'alice', password: 'short' })).status, 400);
  const r = await alice('POST', '/api/signup', { username: 'alice', displayName: 'Alice A', password: 'correct horse' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.displayName, 'Alice A');
  assert.equal((await bob('POST', '/api/signup', { username: 'ALICE', password: 'whatever123' })).status, 409);
  assert.equal((await bob('POST', '/api/signup', { username: 'bob', password: 'bob-password' })).status, 201);
  assert.equal((await carol('POST', '/api/signup', { username: 'carol', password: 'carol-password' })).status, 201);
  const row = app.db.prepare('SELECT pass_hash FROM users WHERE username = ?').get('alice');
  assert.match(row.pass_hash, /^scrypt\$/);
  assert.ok(!row.pass_hash.includes('correct horse'));
});

test('log in, log out, and wrong passwords', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'alice', password: 'nope-nope' })).status, 401);
  assert.equal((await c('POST', '/api/login', { username: 'ghost', password: 'nope-nope' })).status, 401);
  assert.equal((await c('POST', '/api/login', { username: 'alice', password: 'correct horse' })).status, 200);
  assert.equal((await c('GET', '/api/me')).body.user.username, 'alice');
  await c('POST', '/api/logout');
  assert.equal((await c('GET', '/api/me')).body.user, null);
});

test('changes without the site header are blocked', async () => {
  const r = await fetch(`${base}/api/logout`, { method: 'POST' });
  assert.equal(r.status, 403);
});

test('signed-out people cannot upload', async () => {
  const anon = client();
  assert.equal((await anon('POST', '/api/uploads?kind=video', fixture('tiny.mp4'), { 'Content-Type': 'video/mp4' })).status, 401);
});

test('upload checks the real file type, then publishes a video', async () => {
  const fake = await alice('POST', '/api/uploads?kind=video', Buffer.from('not really a video at all'), { 'Content-Type': 'video/mp4' });
  assert.equal(fake.status, 415);
  const up = await alice('POST', '/api/uploads?kind=video', fixture('tiny.mp4'), { 'Content-Type': 'video/mp4' });
  assert.equal(up.status, 201);
  const th = await alice('POST', '/api/uploads?kind=image', fixture('tiny.jpg'), { 'Content-Type': 'image/jpeg' });
  assert.equal(th.status, 201);
  // Bob cannot publish Alice's upload.
  assert.equal((await bob('POST', '/api/videos', { upload: up.body.id, title: 'Stolen' })).status, 400);
  assert.equal((await alice('POST', '/api/videos', { upload: up.body.id, title: '   ' })).status, 400);
  const v = await alice('POST', '/api/videos', { upload: up.body.id, thumb: th.body.id, title: 'My first clip', description: 'Hello\nworld', category: 'Tech', duration: 1 });
  assert.equal(v.status, 201);
  videoId = v.body.video.id;
  assert.equal(v.body.video.author.username, 'alice');
  // The same upload cannot be used twice.
  assert.equal((await alice('POST', '/api/videos', { upload: up.body.id, title: 'Again' })).status, 400);
  const list = await bob('GET', '/api/videos?q=first');
  assert.equal(list.body.videos.length, 1);
  assert.equal((await bob('GET', '/api/videos?cat=Music')).body.videos.length, 0);
});

test('videos stream in parts (range requests)', async () => {
  const v = (await bob('GET', `/api/videos/${videoId}`)).body.video;
  const full = fixture('tiny.mp4');
  const r = await bob('GET', v.videoUrl, undefined, { Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.body.length, 100);
  assert.equal(r.headers.get('content-range'), `bytes 0-99/${full.length}`);
  assert.deepEqual(r.body, full.subarray(0, 100));
  assert.equal((await bob('GET', v.videoUrl, undefined, { Range: `bytes=${full.length + 5}-` })).status, 416);
  assert.equal((await bob('GET', '/media/../server.js')).status, 404);
});

test('likes, views, comments and subscriptions', async () => {
  let r = await bob('POST', `/api/videos/${videoId}/like`);
  assert.deepEqual(r.body, { likes: 1, liked: true });
  r = await bob('POST', `/api/videos/${videoId}/like`);
  assert.equal(r.body.likes, 1, 'liking twice counts once');
  r = await bob('DELETE', `/api/videos/${videoId}/like`);
  assert.deepEqual(r.body, { likes: 0, liked: false });

  assert.equal((await bob('POST', `/api/videos/${videoId}/view`)).body.counted, true);
  assert.equal((await bob('POST', `/api/videos/${videoId}/view`)).body.counted, false);

  const c = await bob('POST', `/api/videos/${videoId}/comments`, { body: 'Great <b>video</b>' });
  assert.equal(c.status, 201);
  assert.equal(c.body.comment.body, 'Great <b>video</b>', 'stored as plain text; the page escapes it');
  assert.equal((await carol('DELETE', `/api/comments/${c.body.comment.id}`)).status, 403);
  assert.equal((await alice('DELETE', `/api/comments/${c.body.comment.id}`)).status, 200, 'video owner can remove comments');

  assert.equal((await bob('POST', '/api/users/alice/subscribe')).body.subscribers, 1);
  assert.equal((await alice('POST', '/api/users/alice/subscribe')).status, 400);
  assert.equal((await bob('GET', '/api/videos?feed=subs')).body.videos.length, 1);
  assert.equal((await carol('GET', '/api/videos?feed=subs')).body.videos.length, 0);
});

test('private messages reach only the two people in the chat', async () => {
  const sent = await alice('POST', '/api/messages/bob', { body: 'Hi Bob, this is private' });
  assert.equal(sent.status, 201);
  await alice('POST', '/api/messages/bob', { video: videoId });
  assert.equal((await alice('POST', '/api/messages/bob', { body: '   ' })).status, 400);

  const bobView = await bob('GET', '/api/messages/alice');
  assert.equal(bobView.body.messages.length, 2);
  assert.equal(bobView.body.messages[1].video.title, 'My first clip');
  assert.equal((await bob('GET', '/api/me')).body.unread, 2);

  // Carol asking for "alice" only sees her own chat with Alice, which is empty.
  assert.equal((await carol('GET', '/api/messages/alice')).body.messages.length, 0);
  assert.equal((await carol('GET', '/api/conversations')).body.conversations.length, 0);

  const convos = (await bob('GET', '/api/conversations')).body.conversations;
  assert.equal(convos[0].user.username, 'alice');
  assert.equal(convos[0].unread, 2);
  assert.equal((await bob('POST', '/api/messages/alice/read')).body.unread, 0);
});

test('new messages arrive live over the event stream', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'StreamNest' },
    body: JSON.stringify({ username: 'bob', password: 'bob-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await alice('POST', '/api/messages/bob', { body: 'live hello' });
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('live hello') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  ac.abort();
  assert.match(text, /event: chat/);
  assert.match(text, /live hello/);
});

test('stories show for 24 hours and only the owner can delete', async () => {
  const img = await carol('POST', '/api/uploads?kind=image', fixture('tiny.jpg'), { 'Content-Type': 'image/jpeg' });
  const s = await carol('POST', '/api/stories', { text: 'At the lake', hue: 200, image: img.body.id });
  assert.equal(s.status, 201);
  assert.ok(s.body.story.imageUrl);
  assert.equal((await carol('POST', '/api/stories', { text: '' })).status, 400);
  const t = await alice('POST', '/api/stories', { text: 'Old news', hue: 30 });
  assert.equal((await bob('GET', '/api/stories')).body.stories.length, 2);
  assert.equal((await bob('DELETE', `/api/stories/${s.body.story.id}`)).status, 403);

  app.db.prepare('UPDATE stories SET created_at = ? WHERE id = ?').run(Date.now() - 25 * 3600 * 1000, t.body.story.id);
  assert.equal((await bob('GET', '/api/stories')).body.stories.length, 1, 'expired stories are hidden');
  app.cleanup();
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM stories').get().n, 1, 'expired stories are removed');
});

test('only the owner can delete a video, and its file is removed', async () => {
  const v = (await bob('GET', `/api/videos/${videoId}`)).body.video;
  const file = path.join(app.uploadDir, path.basename(v.videoUrl));
  assert.ok(fs.existsSync(file));
  assert.equal((await bob('DELETE', `/api/videos/${videoId}`)).status, 403);
  assert.equal((await alice('DELETE', `/api/videos/${videoId}`)).status, 200);
  assert.equal((await bob('GET', `/api/videos/${videoId}`)).status, 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(file));
  const msgs = (await bob('GET', '/api/messages/alice')).body.messages;
  assert.equal(msgs.find((m) => m.body === '').video, null, 'shared links to deleted videos are cleared');
});

test('login attempts are rate limited', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 12; i++) last = await c('POST', '/api/login', { username: 'alice', password: 'wrong-wrong' });
  assert.equal(last.status, 429);
});

test('web pages are served with security headers', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/some/app/route`)).status, 200);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
});
