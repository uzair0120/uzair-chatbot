(() => {
const $ = (s) => document.querySelector(s);
const HDR = { 'x-uzair': '1' };
let user = null, convId = null, files = [], ctrl = null, busy = false, pending = null, authMode = 'login';

/* ---------- helpers ---------- */
async function api(url, opts = {}) {
  const headers = { ...HDR, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers });
  let d = null; try { d = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error((d && d.error) || 'Error'), { status: r.status });
  return d;
}
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inl(s) {
  return s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function md(src) {
  const blocks = [];
  let s = src.replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (m, l, c) => {
    blocks.push(`<div class="code"><div class="codebar"><span>${esc(l || 'code')}</span><button class="copy">Copy</button></div><pre><code>${esc(c.replace(/\n$/, ''))}</code></pre></div>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let out = '', list = null, m;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of esc(s).split('\n')) {
    const ln = raw;
    if (/^\u0000\d+\u0000$/.test(ln.trim())) { close(); out += ln.trim(); }
    else if ((m = ln.match(/^(#{1,4})\s+(.*)/))) { close(); const n = m[1].length + 1; out += `<h${n} dir="auto">${inl(m[2])}</h${n}>`; }
    else if ((m = ln.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li dir="auto">${inl(m[1])}</li>`; }
    else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li dir="auto">${inl(m[1])}</li>`; }
    else if (!ln.trim()) close();
    else { close(); out += `<p dir="auto">${inl(ln)}</p>`; }
  }
  close();
  return out.replace(/\u0000(\d+)\u0000/g, (x, i) => blocks[i]);
}

/* ---------- theme & sidebar ---------- */
const root = document.documentElement;
try { const t = localStorage.getItem('ug-theme'); if (t) root.dataset.theme = t; } catch {}
$('#themeBtn').onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ug-theme', root.dataset.theme); } catch {}
};
const openSide = (o) => { $('#sidebar').classList.toggle('open', o); $('#overlayBg').hidden = !o; };
$('#menuBtn').onclick = () => openSide(true);
$('#closeSide').onclick = $('#overlayBg').onclick = () => openSide(false);

/* ---------- user / auth ---------- */
function renderUser() {
  const b = $('#userBox');
  if (user) {
    b.innerHTML = `<div class="avatar">${esc(user.name[0].toUpperCase())}</div><div class="uname">${esc(user.name)}</div><button class="link" id="logout">Logout</button>`;
    $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); user = null; renderUser(); newChat(); $('#convList').innerHTML = ''; };
  } else {
    b.innerHTML = `<button class="link" id="loginOpen">Login / Register</button>`;
    $('#loginOpen').onclick = () => openAuth();
  }
  $('#greet').textContent = user ? `Assalam o Alaikum, ${user.name}` : 'Assalam o Alaikum';
}
function openAuth(msg) {
  $('#authSub').textContent = msg || 'Chat shuru karne ke liye account chahiye.';
  $('#authTitle').textContent = msg ? 'Pehle login karein' : 'Uzair GPT mein khush aamdeed';
  $('#authErr').textContent = ''; $('#authModal').hidden = false; $('#aEmail').focus();
}
function setMode(m) {
  authMode = m;
  $('#tabLogin').classList.toggle('on', m === 'login'); $('#tabReg').classList.toggle('on', m === 'register');
  $('#aName').hidden = m === 'login'; $('#authGo').textContent = m === 'login' ? 'Login' : 'Account banayen';
  $('#aPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
$('#tabLogin').onclick = () => setMode('login'); $('#tabReg').onclick = () => setMode('register');
$('#authClose').onclick = () => { $('#authModal').hidden = true; };
$('#authForm').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#authGo').click(); });
$('#authGo').onclick = async () => {
  const btn = $('#authGo'); btn.disabled = true; $('#authErr').textContent = '';
  try {
    const d = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ name: $('#aName').value, email: $('#aEmail').value, password: $('#aPass').value }) });
    user = d.user; $('#aPass').value = ''; $('#authModal').hidden = true; renderUser(); loadList();
    if (pending) { const p = pending; pending = null; input.value = ''; send(p.text, p.opts); }
  } catch (e) { $('#authErr').textContent = e.message; }
  btn.disabled = false;
};

/* ---------- conversation list ---------- */
async function loadList() {
  if (!user) return;
  try {
    const { conversations } = await api('/api/conversations');
    const box = $('#convList'); box.innerHTML = '';
    if (!conversations.length) box.innerHTML = '<div class="empty">Abhi koi chat nahi</div>';
    for (const c of conversations) {
      const d = document.createElement('div'); d.className = 'conv' + (c.id === convId ? ' on' : '');
      const s = document.createElement('span'); s.textContent = c.title; s.dir = 'auto';
      const x = document.createElement('button'); x.className = 'del'; x.textContent = '🗑'; x.title = 'Delete';
      d.append(s, x);
      d.onclick = () => openConv(c.id);
      x.onclick = async (e) => { e.stopPropagation(); if (!confirm('Ye chat delete karein?')) return; await api('/api/conversations/' + c.id, { method: 'DELETE' }); if (c.id === convId) newChat(); loadList(); };
      box.appendChild(d);
    }
  } catch {}
}
async function openConv(id) {
  openSide(false);
  try {
    const d = await api('/api/conversations/' + id);
    convId = id; $('#title').textContent = d.conversation.title; $('#messages').innerHTML = ''; $('#welcome').hidden = true;
    for (const m of d.messages) addMsg(m.role, m.content, m.files.map((f) => ({ ...f, url: '/api/files/' + f.id })));
    scrollDown(true); loadList();
  } catch {}
}
function newChat() {
  if (busy && ctrl) ctrl.abort();
  convId = null; $('#messages').innerHTML = ''; $('#welcome').hidden = false; $('#title').textContent = 'Uzair GPT';
  openSide(false); loadList();
}
$('#newChat').onclick = newChat;

/* ---------- messages UI ---------- */
const scrollBox = $('#scroll');
function scrollDown(force) {
  if (force || scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 160) scrollBox.scrollTop = scrollBox.scrollHeight;
}
function addMsg(role, text, fl) {
  const d = document.createElement('div'); d.className = 'msg ' + role;
  const b = document.createElement('div'); b.className = 'bubble';
  if (fl && fl.length) {
    const a = document.createElement('div'); a.className = 'atts';
    for (const f of fl) {
      if (f.mime.startsWith('image/')) { const i = document.createElement('img'); i.src = f.url; i.alt = f.name; a.appendChild(i); }
      else { const c = document.createElement('span'); c.className = 'chip'; c.textContent = '📄 ' + f.name; a.appendChild(c); }
    }
    b.appendChild(a);
  }
  const c = document.createElement('div'); c.className = 'content'; c.dir = 'auto'; c._raw = text || '';
  if (role === 'user') c.textContent = text; else c.innerHTML = md(text || '');
  b.appendChild(c);
  if (role === 'assistant') {
    const t = document.createElement('div'); t.className = 'tools';
    const cp = document.createElement('button'); cp.textContent = '⧉ Copy';
    cp.onclick = () => { navigator.clipboard.writeText(c._raw); cp.textContent = '✓ Copied'; setTimeout(() => (cp.textContent = '⧉ Copy'), 1200); };
    const sp = document.createElement('button'); sp.textContent = '🔊 Suno';
    sp.onclick = () => { speechSynthesis.cancel(); speak(c._raw, guessLang(c._raw)); };
    t.append(cp, sp); b.appendChild(t);
  }
  d.appendChild(b); $('#messages').appendChild(d); scrollDown();
  return c;
}
$('#messages').addEventListener('click', (e) => {
  if (e.target.classList.contains('copy')) {
    const code = e.target.closest('.code').querySelector('code').textContent;
    navigator.clipboard.writeText(code); e.target.textContent = 'Copied ✓'; setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  }
});
document.querySelectorAll('.sugg').forEach((b) => (b.onclick = () => { $('#input').value = b.textContent; send(); }));

/* ---------- attachments ---------- */
function renderAttach() {
  const box = $('#attach'); box.innerHTML = '';
  files.forEach((f, i) => {
    const c = document.createElement('div'); c.className = 'chip';
    if (f.type.startsWith('image/')) { const im = document.createElement('img'); im.src = URL.createObjectURL(f); c.appendChild(im); }
    const s = document.createElement('span'); s.textContent = (f.type.startsWith('image/') ? '' : '📄 ') + f.name;
    const x = document.createElement('button'); x.textContent = '✕'; x.onclick = () => { files.splice(i, 1); renderAttach(); };
    c.append(s, x); box.appendChild(c);
  });
}
function addFiles(list) {
  for (const f of list) {
    if (files.length >= 4) { alert('Ek baar mein max 4 files.'); break; }
    if (f.size > 10 * 1024 * 1024) { alert(f.name + ' 10MB se bari hai.'); continue; }
    files.push(f);
  }
  renderAttach();
}
$('#fileBtn').onclick = () => $('#file').click();
$('#file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('#input').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
['dragover', 'dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  document.body.classList.toggle('drop', ev === 'dragover');
  if (ev === 'drop' && e.dataTransfer?.files) addFiles(e.dataTransfer.files);
}));

/* ---------- send / stream ---------- */
const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && innerWidth > 800) { e.preventDefault(); send(); } });
$('#sendBtn').onclick = () => (busy ? ctrl && ctrl.abort() : send());
function setBusy(b) { busy = b; const s = $('#sendBtn'); s.textContent = b ? '■' : '↑'; s.classList.toggle('stop', b); }

async function send(textArg, opts = {}) {
  const text = (textArg ?? input.value).trim();
  if (busy) return '';
  if (!text && !files.length) return '';
  if (!user) { pending = { text, opts }; openAuth('Message bhejne se pehle login ya register karein.'); return ''; }

  const sendFiles = opts.noFiles ? [] : files.slice();
  const fd = new FormData();
  fd.append('message', text); if (convId) fd.append('conversationId', convId);
  if (opts.voice) { fd.append('voice', '1'); fd.append('lang', opts.lang || 'ur-PK'); }
  sendFiles.forEach((f) => fd.append('files', f));
  $('#welcome').hidden = true;
  addMsg('user', text, sendFiles.map((f) => ({ name: f.name, mime: f.type, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' })));
  if (textArg === undefined) { input.value = ''; input.style.height = 'auto'; }
  files = []; renderAttach();
  const out = addMsg('assistant', ''); out.classList.add('typing');
  ctrl = new AbortController(); setBusy(true);
  let full = '', failed = null;
  try {
    const r = await fetch('/api/chat', { method: 'POST', body: fd, headers: HDR, credentials: 'same-origin', signal: ctrl.signal });
    if (!r.ok) {
      let d = {}; try { d = await r.json(); } catch {}
      if (r.status === 401) { user = null; renderUser(); openAuth('Session khatam ho gaya, dobara login karein.'); }
      throw new Error(d.error || 'Server error');
    }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.conv && !convId) { convId = ev.conv; $('#title').textContent = ev.title; }
        if (ev.t) { full += ev.t; out._raw = full; out.innerHTML = md(full); out.classList.add('typing'); scrollDown(); }
        if (ev.error) failed = ev.error;
      }
    }
  } catch (e) { if (e.name !== 'AbortError') failed = e.message; }
  out.classList.remove('typing');
  if (failed) { const er = document.createElement('div'); er.className = 'errbox'; er.textContent = failed; out.appendChild(er); }
  else if (!full) out.closest('.msg').remove();
  setBusy(false); ctrl = null; loadList();
  return full;
}

/* ---------- speech ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function guessLang(t) { return /[\u0600-\u06FF]/.test(t) ? 'ur-PK' : /[\u0900-\u097F]/.test(t) ? 'hi-IN' : 'en-US'; }
function speak(text, lang, onend) {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>\[\]()]/g, '').replace(/https?:\/\/\S+/g, '');
  const u = new SpeechSynthesisUtterance(clean); u.lang = lang;
  const v = speechSynthesis.getVoices().find((x) => x.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()) || speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  if (v) u.voice = v;
  u.onend = u.onerror = () => onend && onend();
  speechSynthesis.speak(u);
}
speechSynthesis.getVoices();

// Dictation (mic button)
let dict = null;
$('#micBtn').onclick = () => {
  if (!SR) return alert('Is browser mein voice input nahi hai. Chrome ya Edge use karein.');
  if (dict) { dict.stop(); return; }
  dict = new SR(); dict.lang = $('#liveLang').value; dict.interimResults = true; dict.continuous = true;
  const base = input.value ? input.value + ' ' : '';
  dict.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; input.value = base + t; input.dispatchEvent(new Event('input')); };
  dict.onend = () => { dict = null; $('#micBtn').classList.remove('mic-on'); };
  dict.onerror = () => {};
  dict.start(); $('#micBtn').classList.add('mic-on');
};

// Live voice mode
let liveOn = false, rec = null;
const orb = $('#orb');
const setLive = (cls, state, text) => { orb.className = cls; $('#liveState').textContent = state; if (text !== undefined) $('#liveText').textContent = text; };
function listen() {
  if (!liveOn) return;
  rec = new SR(); rec.lang = $('#liveLang').value; rec.interimResults = true; rec.continuous = false;
  let got = '';
  rec.onresult = (e) => { let t = '', fin = false; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) fin = true; } $('#liveText').textContent = t; if (fin) got = t; };
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { alert('Microphone ki ijazat dein.'); stopLive(); } };
  rec.onend = async () => {
    if (!liveOn) return;
    if (!got.trim()) return setTimeout(listen, 250);
    setLive('think', 'Soch raha hoon…');
    const lang = $('#liveLang').value;
    const reply = await send(got.trim(), { voice: true, lang, noFiles: true });
    if (!liveOn) return;
    if (!reply) return setTimeout(listen, 500);
    setLive('speak', 'Bol raha hoon… (rokne ke liye orb dabayen)', reply);
    speak(reply, lang, () => { if (liveOn) listen(); });
  };
  try { rec.start(); setLive('listen', 'Sun raha hoon…', ''); } catch { setTimeout(listen, 400); }
}
function startLive() {
  if (!SR) return alert('Live voice ke liye Chrome ya Edge use karein.');
  if (!user) { openAuth('Live baat-cheet se pehle login karein.'); return; }
  liveOn = true; $('#live').hidden = false; listen();
}
function stopLive() { liveOn = false; try { rec && rec.abort(); } catch {} speechSynthesis.cancel(); if (ctrl) ctrl.abort(); $('#live').hidden = true; }
$('#liveBtn').onclick = startLive;
$('#liveClose').onclick = $('#liveEnd').onclick = stopLive;
orb.onclick = () => { speechSynthesis.cancel(); try { rec && rec.abort(); } catch {} };
$('#liveLang').onchange = () => { try { rec && rec.abort(); } catch {} speechSynthesis.cancel(); };

/* ---------- init ---------- */
(async () => {
  try { user = (await api('/api/auth/me')).user; }
  catch (e) {
    if (e.status === 404 || e.status === 405 || e.name === 'TypeError' || !e.status) {
      const b = document.createElement('div');
      b.style.cssText = 'background:#b3261e;color:#fff;padding:10px 16px;font-size:14px;text-align:center';
      b.textContent = 'Server connected nahi hai. Ye page GitHub Pages par hai; login/AI ke liye Render wale link se kholein.';
      document.body.prepend(b);
    }
  }
  renderUser(); loadList();
})();
})();
