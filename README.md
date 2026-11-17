# StreamNest

A video sharing website with private messaging and 24-hour stories.

## What it does

- **Accounts:** sign up, sign in, sign out. Passwords are stored as scrypt hashes, never as plain text.
- **Videos:** upload (MP4 or WebM), watch with streaming, search, categories, views, likes, comments.
- **Channels:** every user has a channel page. People can subscribe, and the home page has a Subscriptions feed.
- **Messages:** private one-to-one chats. New messages arrive live, with an unread badge. You can share a video into a chat.
- **Stories:** text or photo posts that disappear after 24 hours.

## What you need

- **Node.js 22.13 or newer.** Check with `node -v`.
- Nothing else. There are no packages to install. The database is the SQLite engine built into Node.

## Run it on your computer

```bash
cd streamnest
npm run seed     # optional: adds 4 short sample videos
npm start
```

Open http://localhost:3000 in your browser.

**How to tell it worked:** the home page shows the sample videos. Sign up, then upload a short MP4.

To try messaging, open a second browser (or a private window), sign up as a second person, and chat.

## Run the tests

```bash
npm test
```

You should see `# pass 13` and `# fail 0`.

## Settings

Set these as environment variables. All are optional.

| Name | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | The port the server listens on. |
| `DATA_DIR` | `./data` | Where the database and uploaded files are saved. **Back this folder up.** |
| `MAX_VIDEO_MB` | `200` | Largest video upload allowed, in MB. |
| `COOKIE_SECURE` | off | Set to `1` when the site runs on HTTPS. Required in production. |
| `TRUST_PROXY` | off | Set to `1` when the server sits behind a proxy or load balancer that sets `X-Forwarded-For`. |

## Put it on the internet

You need a host that gives you:

1. **A server that keeps running.** A small virtual private server (VPS) works, or any platform that runs Node or Docker.
2. **A permanent disk.** Videos and the database are saved to `DATA_DIR`. Some platforms wipe the disk on every restart, which would delete everything. Check this before you choose.
3. **HTTPS.** Put the app behind a web server or proxy that handles HTTPS (for example Caddy or Nginx), or use a platform that adds it for you. Then set `COOKIE_SECURE=1` and `TRUST_PROXY=1`.
4. **Long uploads allowed.** If a proxy sits in front, raise its upload size limit to match `MAX_VIDEO_MB`, and its timeout so big uploads can finish.

### With Docker

```bash
docker build -t streamnest .
docker run -d -p 3000:3000 -v streamnest-data:/data \
  -e COOKIE_SECURE=1 -e TRUST_PROXY=1 --name streamnest streamnest
```

The `-v streamnest-data:/data` part keeps your videos and database when the container restarts.

### Without Docker

Copy the folder to the server, then run `npm start` with a process manager such as systemd, so it restarts after crashes and reboots.

## Limits you should know before real users join

- **No video conversion.** Videos play as uploaded. MP4 with H.264 video plays in all browsers. Some phone videos (for example HEVC from iPhones) may not play in every browser.
- **One server.** Files sit on that server's disk. This is fine for a small site. A big site would move videos to object storage and a CDN, which costs money.
- **No email.** There is no password reset or email check yet.
- **No moderation tools.** There is no "report" button or admin panel yet.
- **Messages are private but not end-to-end encrypted.** Anyone with access to the server's database can read them.
- **Legal pages.** Before opening to the public you need Terms of Use, a Privacy Policy, and a way to handle copyright complaints. Ask a lawyer about the rules in your country.

## Project layout

```
server.js        the whole back end: API, uploads, streaming, live messages
seed.js          adds the sample videos
public/          the website: index.html, style.css, app.js
samples/         sample videos used by seed.js
test/            automated tests
Dockerfile       container setup
```
