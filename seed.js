'use strict';
/* Adds four short sample videos so a new site does not start empty.
 * Run once with: npm run seed */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp, hashPassword } = require('./server.js');

(async () => {
  const app = createApp();
  const { db } = app;
  let user = db.prepare('SELECT id FROM users WHERE username = ?').get('streamnest');
  let password = null;
  if (!user) {
    password = crypto.randomBytes(9).toString('base64url');
    const info = db.prepare('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('streamnest', 'StreamNest Samples', await hashPassword(password), Date.now());
    user = { id: Number(info.lastInsertRowid) };
  }
  const have = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE user_id = ?').get(user.id).n;
  if (have) {
    console.log('The sample videos are already there. Nothing to do.');
  } else {
    const dir = path.join(__dirname, 'samples');
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'samples.json'), 'utf8'));
    let at = Date.now();
    for (const s of list) {
      const video = `${crypto.randomBytes(16).toString('hex')}.mp4`;
      const thumb = `${crypto.randomBytes(16).toString('hex')}.jpg`;
      fs.copyFileSync(path.join(dir, s.video), path.join(app.uploadDir, video));
      fs.copyFileSync(path.join(dir, s.thumb), path.join(app.uploadDir, thumb));
      at -= 3600 * 1000;
      db.prepare('INSERT INTO videos (id, user_id, title, description, category, file, thumb, size, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(8).toString('base64url'), user.id, s.title, s.description, s.category, video, thumb,
          fs.statSync(path.join(dir, s.video)).size, s.duration, at);
    }
    console.log(`Added ${list.length} sample videos.`);
  }
  if (password) {
    console.log(`Created the sample account "streamnest" with password: ${password}`);
    console.log('Save it now if you want to sign in as that account. It will not be shown again.');
  }
  await app.close();
})();
