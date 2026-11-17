'use strict';
/*
 * StreamNest server.
 * Plain Node.js (22.13 or newer). No outside packages: the database is Node's
 * built-in SQLite, and uploaded files are saved on disk in DATA_DIR/uploads.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const util = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { pipeline } = require('node:stream/promises');

const scrypt = util.promisify(crypto.scrypt);
const MB = 1024 * 1024;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SESSION_DAYS = 30;
const CATEGORIES = ['Music', 'Gaming', 'Learning', 'Vlogs', 'Tech', 'Art', 'Other'];
const MEDIA_NAME = /^[a-f0-9]{32}\.(mp4|webm|jpg|png|webp)$/;
const MEDIA_TYPES = { mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
  "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  file TEXT NOT NULL,
  thumb TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS videos_created ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS videos_user ON videos(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS likes_video ON likes(video_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_video ON comments(video_id, id);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, channel_id)
);
CREATE INDEX IF NOT EXISTS subs_channel ON subscriptions(channel_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient_id, read_at);
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  hue INTEGER NOT NULL DEFAULT 38,
  image TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stories_created ON stories(created_at);
`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

/* ---------- passwords (scrypt, salted) ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw).normalize('NFKC'), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(pw).normalize('NFKC'), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

/* ---------- small helpers ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function clean(value, max, { label = 'This field', multiline = false, required = false } = {}) {
  let s = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n') : s.replace(/\s+/g, ' ');
  s = s.trim();
  if (required && !s) fail(400, `${label} is required.`);
  if (s.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
  return s;
}

function sniff(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readJson(req, max = 64 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Send the data as JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, 'That request is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'The request could not be read.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'The request could not be read.');
  return value;
}

/* ---------- the app ---------- */
function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const uploadDir = path.join(dataDir, 'uploads');
  const publicDir = path.join(__dirname, 'public');
  const maxVideo = Number(options.maxVideoMB || process.env.MAX_VIDEO_MB || 200) * MB;
  const maxImage = 8 * MB;
  const cookieSecure = String(options.cookieSecure ?? process.env.COOKIE_SECURE ?? '') === '1';
  const trustProxy = String(options.trustProxy ?? process.env.TRUST_PROXY ?? '') === '1';

  fs.mkdirSync(uploadDir, { recursive: true });
  for (const f of fs.readdirSync(uploadDir)) if (f.startsWith('.tmp-')) fs.rmSync(path.join(uploadDir, f), { force: true });

  const db = new DatabaseSync(path.join(dataDir, 'streamnest.db'));
  db.exec(SCHEMA);
  const stmts = new Map();
  const sql = (q) => { let s = stmts.get(q); if (!s) { s = db.prepare(q); stmts.set(q, s); } return s; };

  /* rate limits (in memory, per server process) */
  const buckets = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    if (++b.n > max) fail(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress || '');

  /* sessions */
  const COOKIE = 'sn_session';
  const sessionCookie = (token, maxAge) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
  function currentUser(req) {
    if (req._user !== undefined) return req._user;
    const token = parseCookies(req)[COOKIE];
    req._user = token && token.length < 200
      ? sql('SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
        .get(sha256(token), Date.now()) || null
      : null;
    return req._user;
  }
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_DAYS * DAY);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  }
  const need = (c) => c.user || fail(401, 'Please sign in first.');

  /* uploads: stream to disk with a size cap, then check the real file type */
  async function receiveUpload(req, kind) {
    const max = kind === 'video' ? maxVideo : maxImage;
    const tooBig = `That file is too big. The limit is ${Math.round(max / MB)} MB.`;
    if (Number(req.headers['content-length']) > max) fail(413, tooBig);
    const tmp = path.join(uploadDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    let size = 0;
    try {
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > max) fail(413, tooBig);
          yield chunk;
        }
      }, fs.createWriteStream(tmp));
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      if (e instanceof HttpError) throw e;
      fail(400, 'The upload was interrupted. Please try again.');
    }
    if (!size) { await fsp.rm(tmp, { force: true }); fail(400, 'That file is empty.'); }
    const fh = await fsp.open(tmp, 'r');
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const ext = sniff(head);
    const allowed = kind === 'video' ? ['mp4', 'webm'] : ['jpg', 'png', 'webp'];
    if (!ext || !allowed.includes(ext)) {
      await fsp.rm(tmp, { force: true });
      fail(415, kind === 'video' ? 'That is not a supported video. Use MP4 or WebM.' : 'That is not a supported image. Use JPG, PNG or WebP.');
    }
    const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    await fsp.rename(tmp, path.join(uploadDir, name));
    return { name, size };
  }
  function claimUpload(userId, name, kind) {
    const row = sql('SELECT * FROM uploads WHERE name = ? AND user_id = ? AND kind = ?').get(String(name), userId, kind);
    if (!row) fail(400, 'That upload was not found. Please upload the file again.');
    sql('DELETE FROM uploads WHERE name = ?').run(row.name);
    return row;
  }
  function removeMedia(name) {
    if (name && MEDIA_NAME.test(name)) fsp.rm(path.join(uploadDir, name), { force: true }).catch(() => {});
  }

  /* public shapes: never expose numeric ids, emails or hashes */
  const media = (n) => (n ? `/media/${n}` : null);
  const pubUser = (r) => ({ username: r.username, displayName: r.display_name });
  const pubVideo = (r) => ({
    id: r.id, title: r.title, description: r.description, category: r.category,
    duration: r.duration, views: r.views, createdAt: r.created_at,
    videoUrl: media(r.file), thumbUrl: media(r.thumb), author: pubUser(r),
  });
  const subCount = (id) => sql('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(id).n;
  const isSubscribed = (u, channelId) => !!(u && sql('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(u.id, channelId));
  const unreadCount = (id) => sql('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND sender_id <> ? AND read_at IS NULL').get(id, id).n;
  const findUser = (name) => sql('SELECT id, username, display_name, created_at FROM users WHERE username = ?').get(String(name)) || fail(404, 'That person was not found.');
  const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  /* live events (Server-Sent Events) for new messages */
  const streams = new Map();
  function emit(userId, event, data) {
    const set = streams.get(userId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(payload);
  }
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  /* router */
  const routes = [];
  function route(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  }

  route('GET', '/api/health', () => ({ ok: true }));

  /* ---- accounts ---- */
  route('POST', '/api/signup', async (c) => {
    limit(`signup:${c.ip}`, 10, HOUR);
    const b = await readJson(c.req);
    const username = String(b.username ?? '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) fail(400, 'Username must be 3 to 20 letters, numbers or underscores.');
    const displayName = clean(b.displayName, 40, { label: 'Display name' }) || username;
    const password = String(b.password ?? '');
    if (password.length < 8) fail(400, 'Password must be at least 8 characters.');
    if (password.length > 200) fail(400, 'Password must be 200 characters or fewer.');
    if (sql('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken. Try another one.');
    const hash = await hashPassword(password);
    let info;
    try {
      info = sql('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?, ?, ?, ?)').run(username, displayName, hash, Date.now());
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) fail(409, 'That username is taken. Try another one.');
      throw e;
    }
    startSession(c.res, Number(info.lastInsertRowid));
    c.res.statusCode = 201;
    return { user: { username, displayName }, unread: 0 };
  });

  route('POST', '/api/login', async (c) => {
    limit(`login:${c.ip}`, 10, 15 * 60 * 1000);
    const b = await readJson(c.req);
    const row = sql('SELECT id, username, display_name, pass_hash FROM users WHERE username = ?').get(String(b.username ?? '').trim());
    const ok = await verifyPassword(String(b.password ?? ''), row ? row.pass_hash : DUMMY_HASH);
    if (!row || !ok) fail(401, 'Wrong username or password.');
    startSession(c.res, row.id);
    return { user: pubUser(row), unread: unreadCount(row.id) };
  });

  route('POST', '/api/logout', (c) => {
    const token = parseCookies(c.req)[COOKIE];
    if (token) sql('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    c.res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  });

  route('GET', '/api/me', (c) => {
    const u = c.user;
    return { user: u ? pubUser(u) : null, unread: u ? unreadCount(u.id) : 0 };
  });

  /* ---- file uploads (step 1 of posting a video or story) ---- */
  route('POST', '/api/uploads', async (c) => {
    const u = need(c);
    const kind = c.query.get('kind');
    if (kind !== 'video' && kind !== 'image') fail(400, 'Unknown upload type.');
    limit(`upload:${kind}:${u.id}`, kind === 'video' ? 30 : 120, HOUR);
    const f = await receiveUpload(c.req, kind);
    sql('INSERT INTO uploads (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)').run(f.name, u.id, kind, f.size, Date.now());
    c.res.statusCode = 201;
    return { id: f.name };
  });

  /* ---- videos ---- */
  const VIDEO_SELECT = 'SELECT v.*, u.username, u.display_name FROM videos v JOIN users u ON u.id = v.user_id';

  route('GET', '/api/videos', (c) => {
    const q = String(c.query.get('q') || '').trim().slice(0, 100);
    const cat = c.query.get('cat');
    const user = c.query.get('user');
    const before = Number(c.query.get('before')) || 0;
    const lim = Math.min(Math.max(Number(c.query.get('limit')) || 24, 1), 60);
    let where = ' WHERE 1 = 1';
    const args = [];
    if (q) { where += " AND (v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')"; args.push(likePattern(q), likePattern(q)); }
    if (cat && CATEGORIES.includes(cat)) { where += ' AND v.category = ?'; args.push(cat); }
    if (user) { where += ' AND u.username = ?'; args.push(user); }
    if (c.query.get('feed') === 'subs') {
      const me = need(c);
      where += ' AND v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?)';
      args.push(me.id);
    }
    if (before) { where += ' AND v.created_at < ?'; args.push(before); }
    args.push(lim);
    return { videos: sql(`${VIDEO_SELECT}${where} ORDER BY v.created_at DESC LIMIT ?`).all(...args).map(pubVideo) };
  });

  route('POST', '/api/videos', async (c) => {
    const u = need(c);
    const b = await readJson(c.req);
    const title = clean(b.title, 100, { label: 'Title', required: true });
    const description = clean(b.description, 5000, { label: 'Description', multiline: true });
    const category = CATEGORIES.includes(b.category) ? b.category : 'Other';
    const duration = Math.max(0, Math.min(86400, Math.round(Number(b.duration) || 0)));
    const file = claimUpload(u.id, b.upload ?? '', 'video');
    let thumb = null;
    if (b.thumb) { try { thumb = claimUpload(u.id, b.thumb, 'image').name; } catch { thumb = null; } }
    const id = crypto.randomBytes(8).toString('base64url');
    sql('INSERT INTO videos (id, user_id, title, description, category, file, thumb, size, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, u.id, title, description, category, file.name, thumb, file.size, duration, Date.now());
    c.res.statusCode = 201;
    return { video: pubVideo(sql(`${VIDEO_SELECT} WHERE v.id = ?`).get(id)) };
  });

  route('GET', '/api/videos/:id', (c) => {
    const r = sql(`${VIDEO_SELECT} WHERE v.id = ?`).get(c.params.id) || fail(404, 'Video not found.');
    const u = c.user;
    const v = pubVideo(r);
    Object.assign(v, likeState(r.id, u));
    v.author.subscribers = subCount(r.user_id);
    v.author.subscribed = isSubscribed(u, r.user_id);
    v.mine = !!(u && u.id === r.user_id);
    return { video: v };
  });

  route('DELETE', '/api/videos/:id', (c) => {
    const u = need(c);
    const r = sql('SELECT * FROM videos WHERE id = ?').get(c.params.id) || fail(404, 'Video not found.');
    if (r.user_id !== u.id) fail(403, 'You can only delete your own videos.');
    sql('DELETE FROM videos WHERE id = ?').run(r.id);
    removeMedia(r.file);
    removeMedia(r.thumb);
    return { ok: true };
  });

  const viewSeen = new Map();
  route('POST', '/api/videos/:id/view', (c) => {
    const key = `${c.user ? `u${c.user.id}` : `ip${c.ip}`}:${c.params.id}`;
    const now = Date.now();
    if ((viewSeen.get(key) || 0) > now) return { counted: false };
    const info = sql('UPDATE videos SET views = views + 1 WHERE id = ?').run(c.params.id);
    if (!info.changes) fail(404, 'Video not found.');
    viewSeen.set(key, now + 6 * HOUR);
    return { counted: true };
  });

  function likeState(videoId, u) {
    return {
      likes: sql('SELECT COUNT(*) AS n FROM likes WHERE video_id = ?').get(videoId).n,
      liked: !!(u && sql('SELECT 1 FROM likes WHERE video_id = ? AND user_id = ?').get(videoId, u.id)),
    };
  }
  route('POST', '/api/videos/:id/like', (c) => {
    const u = need(c);
    sql('SELECT 1 FROM videos WHERE id = ?').get(c.params.id) || fail(404, 'Video not found.');
    sql('INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)').run(u.id, c.params.id, Date.now());
    return likeState(c.params.id, u);
  });
  route('DELETE', '/api/videos/:id/like', (c) => {
    const u = need(c);
    sql('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(u.id, c.params.id);
    return likeState(c.params.id, u);
  });

  /* ---- comments ---- */
  const COMMENT_SELECT = 'SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.display_name, v.user_id AS video_owner FROM comments c JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id';
  const pubComment = (r, u) => ({
    id: r.id, body: r.body, createdAt: r.created_at, author: pubUser(r),
    canDelete: !!(u && (u.id === r.user_id || u.id === r.video_owner)),
  });
  route('GET', '/api/videos/:id/comments', (c) => ({
    comments: sql(`${COMMENT_SELECT} WHERE c.video_id = ? ORDER BY c.id DESC LIMIT 200`).all(c.params.id).map((r) => pubComment(r, c.user)),
  }));
  route('POST', '/api/videos/:id/comments', async (c) => {
    const u = need(c);
    limit(`comment:${u.id}`, 30, 60 * 1000);
    const b = await readJson(c.req);
    const body = clean(b.body, 1000, { label: 'Comment', multiline: true, required: true });
    sql('SELECT 1 FROM videos WHERE id = ?').get(c.params.id) || fail(404, 'Video not found.');
    const info = sql('INSERT INTO comments (video_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(c.params.id, u.id, body, Date.now());
    c.res.statusCode = 201;
    return { comment: pubComment(sql(`${COMMENT_SELECT} WHERE c.id = ?`).get(info.lastInsertRowid), u) };
  });
  route('DELETE', '/api/comments/:id', (c) => {
    const u = need(c);
    const r = sql(`${COMMENT_SELECT} WHERE c.id = ?`).get(Number(c.params.id) || 0) || fail(404, 'Comment not found.');
    if (u.id !== r.user_id && u.id !== r.video_owner) fail(403, 'You cannot delete this comment.');
    sql('DELETE FROM comments WHERE id = ?').run(r.id);
    return { ok: true };
  });

  /* ---- people and subscriptions ---- */
  route('GET', '/api/users', (c) => {
    need(c);
    const like = likePattern(String(c.query.get('q') || '').trim().slice(0, 40));
    return {
      users: sql("SELECT username, display_name FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20")
        .all(like, like).map(pubUser),
    };
  });
  route('GET', '/api/users/:username', (c) => {
    const r = findUser(c.params.username);
    const u = c.user;
    return {
      user: {
        ...pubUser(r), joinedAt: r.created_at, subscribers: subCount(r.id),
        videoCount: sql('SELECT COUNT(*) AS n FROM videos WHERE user_id = ?').get(r.id).n,
        subscribed: isSubscribed(u, r.id), isMe: !!(u && u.id === r.id),
      },
    };
  });
  route('POST', '/api/users/:username/subscribe', (c) => {
    const u = need(c);
    const r = findUser(c.params.username);
    if (r.id === u.id) fail(400, 'You cannot subscribe to yourself.');
    sql('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(u.id, r.id, Date.now());
    return { subscribed: true, subscribers: subCount(r.id) };
  });
  route('DELETE', '/api/users/:username/subscribe', (c) => {
    const u = need(c);
    const r = findUser(c.params.username);
    sql('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(u.id, r.id);
    return { subscribed: false, subscribers: subCount(r.id) };
  });

  /* ---- stories (visible for 24 hours) ---- */
  const STORY_SELECT = 'SELECT s.*, u.username, u.display_name FROM stories s JOIN users u ON u.id = s.user_id';
  const pubStory = (r, u) => ({
    id: r.id, text: r.body, hue: r.hue, imageUrl: media(r.image), createdAt: r.created_at,
    author: pubUser(r), mine: !!(u && u.id === r.user_id),
  });
  route('GET', '/api/stories', (c) => ({
    stories: sql(`${STORY_SELECT} WHERE s.created_at > ? ORDER BY s.created_at ASC LIMIT 500`).all(Date.now() - DAY).map((r) => pubStory(r, c.user)),
  }));
  route('POST', '/api/stories', async (c) => {
    const u = need(c);
    limit(`story:${u.id}`, 30, HOUR);
    const b = await readJson(c.req);
    const text = clean(b.text, 200, { label: 'Story text', multiline: true });
    const hue = (((Math.round(Number(b.hue)) || 0) % 360) + 360) % 360;
    const image = b.image ? claimUpload(u.id, b.image, 'image').name : null;
    if (!text && !image) fail(400, 'Write something or add a photo.');
    const id = crypto.randomBytes(8).toString('base64url');
    sql('INSERT INTO stories (id, user_id, body, hue, image, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, u.id, text, hue, image, Date.now());
    c.res.statusCode = 201;
    return { story: pubStory(sql(`${STORY_SELECT} WHERE s.id = ?`).get(id), u) };
  });
  route('DELETE', '/api/stories/:id', (c) => {
    const u = need(c);
    const r = sql('SELECT * FROM stories WHERE id = ?').get(c.params.id) || fail(404, 'Story not found.');
    if (r.user_id !== u.id) fail(403, 'You can only delete your own stories.');
    sql('DELETE FROM stories WHERE id = ?').run(r.id);
    removeMedia(r.image);
    return { ok: true };
  });

  /* ---- private messages ---- */
  const MSG_SELECT = 'SELECT m.*, su.username AS from_name, ru.username AS to_name, v.title AS video_title FROM messages m JOIN users su ON su.id = m.sender_id JOIN users ru ON ru.id = m.recipient_id LEFT JOIN videos v ON v.id = m.video_id';
  const pubMsg = (r) => ({
    id: r.id, from: r.from_name, to: r.to_name, body: r.body,
    video: r.video_id ? { id: r.video_id, title: r.video_title } : null,
    createdAt: r.created_at, readAt: r.read_at,
  });
  route('GET', '/api/conversations', (c) => {
    const u = need(c);
    const rows = sql(`SELECT other, MAX(id) AS last_id FROM (
        SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other, id
        FROM messages WHERE sender_id = ? OR recipient_id = ?
      ) GROUP BY other ORDER BY last_id DESC LIMIT 100`).all(u.id, u.id, u.id);
    return {
      conversations: rows.map((r) => ({
        user: pubUser(sql('SELECT username, display_name FROM users WHERE id = ?').get(r.other)),
        last: pubMsg(sql(`${MSG_SELECT} WHERE m.id = ?`).get(r.last_id)),
        unread: r.other === u.id ? 0
          : sql('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').get(r.other, u.id).n,
      })),
    };
  });
  route('GET', '/api/messages/:username', (c) => {
    const u = need(c);
    const o = findUser(c.params.username);
    const before = Number(c.query.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = sql(`${MSG_SELECT} WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) AND m.id < ? ORDER BY m.id DESC LIMIT 100`)
      .all(u.id, o.id, o.id, u.id, before);
    return { user: pubUser(o), messages: rows.reverse().map(pubMsg), hasMore: rows.length === 100 };
  });
  route('POST', '/api/messages/:username', async (c) => {
    const u = need(c);
    limit(`msg:${u.id}`, 60, 60 * 1000);
    const o = findUser(c.params.username);
    const b = await readJson(c.req);
    const body = clean(b.body, 2000, { label: 'Message', multiline: true });
    let videoId = null;
    if (b.video) {
      videoId = String(b.video);
      sql('SELECT 1 FROM videos WHERE id = ?').get(videoId) || fail(404, 'That video no longer exists.');
    }
    if (!body && !videoId) fail(400, 'Write a message first.');
    const info = sql('INSERT INTO messages (sender_id, recipient_id, body, video_id, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, o.id, body, videoId, Date.now());
    const m = pubMsg(sql(`${MSG_SELECT} WHERE m.id = ?`).get(info.lastInsertRowid));
    emit(o.id, 'chat', m);
    if (o.id !== u.id) emit(u.id, 'chat', m);
    c.res.statusCode = 201;
    return { message: m };
  });
  route('POST', '/api/messages/:username/read', (c) => {
    const u = need(c);
    const o = findUser(c.params.username);
    sql('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').run(Date.now(), o.id, u.id);
    return { unread: unreadCount(u.id) };
  });
  route('GET', '/api/events', (c) => {
    const u = need(c);
    const res = c.res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    let set = streams.get(u.id);
    if (!set) { set = new Set(); streams.set(u.id, set); }
    if (set.size >= 20) { const oldest = set.values().next().value; set.delete(oldest); oldest.end(); }
    set.add(res);
    c.req.on('close', () => { set.delete(res); if (!set.size && streams.get(u.id) === set) streams.delete(u.id); });
  });

  /* ---------- request handling ---------- */
  async function handleApi(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'StreamNest') {
      fail(403, 'Request blocked. Reload the page and try again.');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { fail(400, 'Bad address.'); } });
      const ctx = { req, res, url, params, query: url.searchParams, ip: clientIp(req), get user() { return currentUser(req); } };
      const out = await r.handler(ctx);
      if (res.headersSent) return;
      res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out === undefined ? { ok: true } : out));
      return;
    }
    fail(404, 'Not found.');
  }

  async function serveMedia(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
    const name = url.pathname.slice('/media/'.length);
    if (!MEDIA_NAME.test(name)) fail(404, 'Not found.');
    const file = path.join(uploadDir, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st) fail(404, 'Not found.');
    const headers = { 'Content-Type': MEDIA_TYPES[name.split('.').pop()], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && !(m[1] === '' && m[2] === '')) {
        if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
      }
      if (!m || (m[1] === '' && m[2] === '') || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !st.size) { res.end(); return; }
    await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { fail(400, 'Bad address.'); }
    if (p === '/') p = '/index.html';
    let file = path.join(publicDir, path.normalize(p));
    if (!file.startsWith(publicDir + path.sep)) fail(404, 'Not found.');
    let st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      if (path.extname(p)) fail(404, 'Not found.');
      file = path.join(publicDir, 'index.html');
      st = await fsp.stat(file);
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(fs.createReadStream(file), res).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    if (cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (url.pathname.startsWith('/media/')) await serveMedia(req, res, url);
      else await serveStatic(req, res, url);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) { res.destroy(); return; }
      const status = e instanceof HttpError ? e.status : 500;
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (status === 413) headers.Connection = 'close';
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'Something went wrong on the server. Please try again.' }));
    }
  });
  server.requestTimeout = 60 * 60 * 1000; // allow slow uploads of large videos

  /* hourly clean-up: expired stories, unused uploads, old sessions */
  function cleanup() {
    const now = Date.now();
    for (const r of sql('SELECT id, image FROM stories WHERE created_at <= ?').all(now - DAY)) {
      sql('DELETE FROM stories WHERE id = ?').run(r.id);
      removeMedia(r.image);
    }
    for (const r of sql('SELECT name FROM uploads WHERE created_at <= ?').all(now - DAY)) {
      sql('DELETE FROM uploads WHERE name = ?').run(r.name);
      removeMedia(r.name);
    }
    sql('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
    for (const [k, t] of viewSeen) if (t <= now) viewSeen.delete(k);
  }
  cleanup();
  const cleanTimer = setInterval(cleanup, HOUR);
  cleanTimer.unref();

  async function close() {
    clearInterval(cleanTimer);
    clearInterval(heartbeat);
    for (const set of streams.values()) for (const res of set) res.end();
    streams.clear();
    await new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    db.close();
  }

  return { server, db, close, cleanup, uploadDir, dataDir };
}

module.exports = { createApp, hashPassword, CATEGORIES };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.server.listen(port, host, () => console.log(`StreamNest is running at http://localhost:${port}`));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; app.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
