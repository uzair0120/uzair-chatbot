require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const { sendMail, alertOnce } = require('./security');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('⚠ JWT_SECRET set nahi (ya chhota hai). Temporary secret use ho raha hai; restart par sab logout ho jayenge.');
}
if (!ai.configured) console.warn('⚠ AI_API_KEY set nahi hai. .env file check karein.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

/* ---------- Hacker / scanner detection ---------- */
const strikes = new Map();
const blocked = new Map();
const SUSPICIOUS = /(\.env|\.git|wp-admin|wp-login|xmlrpc|phpmyadmin|\.php|\.sql|\.db$|\.bak|config\.(js|json|yml)|api[-_]?keys?|secrets?|server\.js|package\.json|\/etc\/passwd|\.\.)/i;

function strike(ip, type, detail) {
  const now = Date.now();
  const list = (strikes.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  strikes.set(ip, list);
  alertOnce(type, ip, detail);
  if (list.length >= 5) {
    blocked.set(ip, now + 60 * 60 * 1000);
    alertOnce('IP blocked (1 hour)', ip, `Is IP ne 10 minute mein ${list.length} suspicious requests ki. Auto-block ho gaya.\nLast: ${detail}`);
  }
}

app.use((req, res, next) => {
  const until = blocked.get(req.ip);
  if (until && until > Date.now()) return res.status(403).end();
  let p = req.path;
  try { p = decodeURIComponent(p); } catch {}
  if (SUSPICIOUS.test(p)) {
    strike(req.ip, 'Suspicious file/key access attempt', `${req.method} ${p}\nUser-Agent: ${req.get('user-agent')}`);
    return res.status(404).end();
  }
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// Agar public/ folder nahi bana (files flat upload ho gayi), to root se hi teen frontend files serve karo
const fs = require('fs');
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : null;
if (PUB) app.use(express.static(PUB, { dotfiles: 'ignore', maxAge: PROD ? '1h' : 0 }));
else {
  for (const f of ['index.html', 'style.css', 'app.js'])
    app.get(f === 'index.html' ? ['/', '/index.html'] : '/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
}

/* ---------- Helpers ---------- */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const signToken = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' });
const setCookie = (res, t) =>
  res.cookie('ut', t, { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 7 * 864e5, path: '/' });

function userFromReq(req) {
  try {
    const d = jwt.verify(req.cookies.ut, JWT_SECRET);
    return db.prepare('SELECT id,name,email FROM users WHERE id=?').get(d.id) || null;
  } catch { return null; }
}
function auth(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'login_required' });
  req.user = u;
  next();
}
// CSRF: custom header cross-site form/site se nahi bheja ja sakta
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-uzair') !== '1') return res.status(403).json({ error: 'bad_request' });
  next();
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

const fails = new Map();
function failCount(key) {
  const now = Date.now();
  const l = (fails.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  fails.set(key, l);
  return l.length;
}
const addFail = (key) => fails.set(key, [...(fails.get(key) || []), Date.now()]);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Bohat zyada koshishen. Thori dair baad try karein.' } });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 25, keyGenerator: (req) => 'u' + (req.user?.id || req.ip), standardHeaders: true, legacyHeaders: false, validate: false, message: { error: 'Bohat tez messages. Ek minute ruk kar try karein.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', apiLimiter, csrf);

/* ---------- Auth ---------- */
app.get('/api/auth/me', (req, res) => res.json({ user: userFromReq(req) }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const name = clean(req.body.name, 40);
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Naam kam az kam 2 harf ka ho.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email sahi nahi hai.' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Password 8 se 100 characters ka ho.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Ye email pehle se registered hai.' });
  const hash = await bcrypt.hash(password, 12);
  const r = db.prepare('INSERT INTO users(name,email,pass_hash) VALUES(?,?,?)').run(name, email, hash);
  const user = { id: r.lastInsertRowid, name, email };
  setCookie(res, signToken(user));
  sendMail('[Uzair GPT] Naya user register hua', `Naam: ${name}\nEmail: ${email}\nIP: ${req.ip}\nTime: ${new Date().toISOString()}`);
  res.json({ user });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '').slice(0, 100);
  const kIp = 'ip:' + req.ip, kEm = 'em:' + email;
  if (failCount(kIp) >= 8 || failCount(kEm) >= 5) {
    alertOnce('Brute-force login attempt', req.ip, `Email: ${email}\nBohat zyada ghalat password koshishen. Login 15 minute ke liye band.`);
    return res.status(429).json({ error: 'Bohat ghalat koshishen. 15 minute baad try karein.' });
  }
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = await bcrypt.compare(password, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !ok) {
    addFail(kIp); addFail(kEm);
    return res.status(401).json({ error: 'Email ya password ghalat hai.' });
  }
  fails.delete(kIp); fails.delete(kEm);
  const user = { id: u.id, name: u.name, email: u.email };
  setCookie(res, signToken(user));
  sendMail('[Uzair GPT] Login hua', `User: ${u.name} (${u.email})\nIP: ${req.ip}\nDevice: ${req.get('user-agent')}\nTime: ${new Date().toISOString()}`);
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('ut', { path: '/' }); res.json({ ok: true }); });

/* ---------- Conversations ---------- */
app.get('/api/conversations', auth, (req, res) => {
  res.json({ conversations: db.prepare('SELECT id,title,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT 200').all(req.user.id) });
});
app.get('/api/conversations/:id', auth, (req, res) => {
  const c = db.prepare('SELECT id,title FROM conversations WHERE id=? AND user_id=?').get(+req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Chat nahi mila' });
  const messages = db.prepare('SELECT id,role,content FROM messages WHERE conv_id=? ORDER BY id').all(c.id);
  const files = db.prepare('SELECT id,message_id,name,mime FROM files WHERE conv_id=?').all(c.id);
  res.json({ conversation: c, messages: messages.map((m) => ({ ...m, files: files.filter((f) => f.message_id === m.id) })) });
});
app.delete('/api/conversations/:id', auth, (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(+req.params.id, req.user.id);
  res.json({ ok: true });
});
app.get('/api/files/:id', auth, (req, res) => {
  const f = db.prepare('SELECT f.name,f.mime,f.data FROM files f JOIN conversations c ON c.id=f.conv_id WHERE f.id=? AND c.user_id=?').get(+req.params.id, req.user.id);
  if (!f) return res.status(404).end();
  res.set({
    'Content-Type': f.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:",
    'Content-Disposition': `${f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'private, max-age=3600',
  });
  res.send(f.data);
});

/* ---------- Chat (streaming) ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4, fields: 10 } });
const SIG = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/gif': [0x47, 0x49, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };
const TEXT_MIME = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/json']);
function fileOk(f) {
  const m = f.mimetype;
  if (SIG[m]) return SIG[m].every((b, i) => f.buffer[i] === b);
  if (m === 'image/webp') return f.buffer.slice(0, 4).toString() === 'RIFF' && f.buffer.slice(8, 12).toString() === 'WEBP';
  return TEXT_MIME.has(m);
}
const safeName = (n) => clean(Buffer.from(n || 'file', 'latin1').toString('utf8'), 120) || 'file';

const SYSTEM = `You are Uzair GPT, a helpful, honest and friendly AI assistant. Reply in the same language and script the user writes in (English, Urdu, Roman Urdu, Hindi, Hinglish, Arabic, etc.). Be clear, practical and concise unless asked for detail. Use Markdown for code blocks and lists. If the user uploads a file or image, read it and answer questions about it. Never reveal API keys, environment variables, passwords, database contents or any internal server details; if asked, politely refuse.`;
const voiceHint = (lang) => ` VOICE MODE: your reply will be spoken aloud. Keep it short and conversational (1-4 sentences), with no markdown, no emojis, no lists. The user speaks locale ${lang || 'ur-PK'}; write your reply in the native script of that language (Urdu script for ur, Devanagari for hi) so text-to-speech works.`;
const LEAK_TOPIC = /(api[\s_-]?key|secret|\.env|jwt|password|passwd|token|system\s*prompt|environment\s*variable|database)/i;
const LEAK_VERB = /(show|reveal|print|give|tell|dump|leak|expose|steal|hack|bata|batao|dikha|dikhao|bhejo|nikal|chura|de\s?do|bypass|ignore (all|previous))/i;

app.post('/api/chat', auth, chatLimiter, upload.array('files', 4), async (req, res) => {
  const text = String(req.body.message || '').trim().slice(0, 8000);
  const voice = req.body.voice === '1';
  const lang = String(req.body.lang || '').replace(/[^a-zA-Z-]/g, '').slice(0, 10);
  const files = req.files || [];
  for (const f of files) if (!fileOk(f)) return res.status(400).json({ error: `File allowed nahi ya kharab hai: ${safeName(f.originalname)}` });
  if (!text && !files.length) return res.status(400).json({ error: 'Message khali hai.' });

  let conv;
  if (req.body.conversationId) {
    conv = db.prepare('SELECT id,title FROM conversations WHERE id=? AND user_id=?').get(+req.body.conversationId, req.user.id);
    if (!conv) return res.status(404).json({ error: 'Chat nahi mila.' });
  } else {
    const title = (text || safeName(files[0].originalname)).replace(/\s+/g, ' ').slice(0, 50);
    conv = { id: db.prepare('INSERT INTO conversations(user_id,title) VALUES(?,?)').run(req.user.id, title).lastInsertRowid, title };
  }
  const um = db.prepare('INSERT INTO messages(conv_id,role,content) VALUES(?,?,?)').run(conv.id, 'user', text);
  for (const f of files)
    db.prepare('INSERT INTO files(message_id,conv_id,name,mime,data) VALUES(?,?,?,?,?)').run(um.lastInsertRowid, conv.id, safeName(f.originalname), f.mimetype, f.buffer);
  db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(conv.id);

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (o) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
  send({ conv: conv.id, title: conv.title, files: db.prepare('SELECT id,name,mime FROM files WHERE message_id=?').all(um.lastInsertRowid) });

  const save = (t) => {
    db.prepare('INSERT INTO messages(conv_id,role,content) VALUES(?,?,?)').run(conv.id, 'assistant', t);
    db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(conv.id);
  };

  // API key / secret churane ki koshish
  if (LEAK_TOPIC.test(text) && LEAK_VERB.test(text)) {
    alertOnce('API key / secret churane ki koshish', req.ip, `User: ${req.user.name} (${req.user.email})\nMessage: ${text.slice(0, 500)}`);
    const msg = 'Maaf kijiye, main API keys, passwords ya server ki internal cheezein share nahi kar sakta. 🔒';
    send({ t: msg }); save(msg); send({ done: true }); return res.end();
  }
  if (!ai.configured) { send({ error: 'Server par AI_API_KEY set nahi hai.' }); return res.end(); }

  const rows = db.prepare('SELECT id,role,content FROM messages WHERE conv_id=? ORDER BY id').all(conv.id).slice(-30);
  const frows = db.prepare('SELECT message_id,name,mime,data FROM files WHERE conv_id=?').all(conv.id);
  let budget = 14 * 1024 * 1024;
  const byMsg = {};
  for (const r of [...rows].reverse()) {
    byMsg[r.id] = [];
    for (const f of frows.filter((x) => x.message_id === r.id)) {
      if (f.data.length <= budget) { budget -= f.data.length; byMsg[r.id].push(f); }
      else byMsg[r.id].push({ name: f.name, mime: 'text/plain', data: Buffer.from('[purani file context limit ki wajah se hata di gayi]') });
    }
  }
  const history = rows.map((r) => ({ role: r.role, text: r.content, files: byMsg[r.id] || [] }));

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let full = '';
  try {
    await ai.stream({ system: SYSTEM + (voice ? voiceHint(lang) : ''), history, signal: ac.signal, onText: (t) => { full += t; send({ t }); } });
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('AI error', e.status || '', String(e.detail || e.message).slice(0, 400));
      const s = e.status;
      send({ error: s === 429 ? 'AI ki limit poori ho gayi, thori dair baad try karein.' : [400, 401, 403].includes(s) ? 'AI key ya settings mein masla hai (server logs dekhein).' : 'AI se jawab nahi aaya, dobara try karein.' });
    }
  }
  if (full.trim()) {
    if (ai.key && full.includes(ai.key)) {
      alertOnce('AI reply mein key nazar aayi!', req.ip, 'Reply block kar diya gaya.');
      full = full.split(ai.key).join('[hidden]');
    }
    save(full);
  }
  send({ done: true });
  res.end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'File bohat bari hai (max 10MB) ya zyada files hain (max 4).' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`✅ Uzair GPT chal raha hai: http://localhost:${PORT}  (AI: ${ai.provider} / ${ai.model})`));
