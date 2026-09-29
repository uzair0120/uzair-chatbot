// AI provider layer: Google Gemini ya Anthropic Claude (key se auto-detect)
const KEY = process.env.AI_API_KEY || process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const provider = process.env.AI_PROVIDER || (KEY.startsWith('sk-ant-') ? 'anthropic' : 'gemini');
const MODEL = process.env.AI_MODEL || (provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gemini-2.5-flash');

const isText = (m) => m.startsWith('text/') || m === 'application/json';

async function* sse(resp) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
}

async function fail(r) {
  const e = new Error('AI HTTP ' + r.status);
  e.status = r.status;
  e.detail = await r.text().catch(() => '');
  return e;
}

async function gemini({ system, history, signal, onText }) {
  const contents = history
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...m.files.map((f) =>
          isText(f.mime)
            ? { text: `[File: ${f.name}]\n${f.data.toString('utf8').slice(0, 100000)}` }
            : { inline_data: { mime_type: f.mime, data: f.data.toString('base64') } }
        ),
        ...(m.text ? [{ text: m.text }] : []),
      ],
    }))
    .filter((c) => c.parts.length);

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 4096 },
      }),
    }
  );
  if (!r.ok) throw await fail(r);
  for await (const d of sse(r)) {
    try {
      const j = JSON.parse(d);
      for (const p of j.candidates?.[0]?.content?.parts || []) if (p.text && !p.thought) onText(p.text);
    } catch {}
  }
}

async function anthropic({ system, history, signal, onText }) {
  const msgs = [];
  for (const m of history) {
    const content = [
      ...m.files.map((f) => {
        if (f.mime.startsWith('image/'))
          return { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } };
        if (f.mime === 'application/pdf')
          return { type: 'document', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } };
        return { type: 'text', text: `[File: ${f.name}]\n${f.data.toString('utf8').slice(0, 100000)}` };
      }),
      ...(m.text ? [{ type: 'text', text: m.text }] : []),
    ];
    if (!content.length) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content.push(...content);
    else msgs.push({ role: m.role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: msgs, stream: true }),
  });
  if (!r.ok) throw await fail(r);
  for await (const d of sse(r)) {
    try {
      const j = JSON.parse(d);
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') onText(j.delta.text);
    } catch {}
  }
}

module.exports = {
  key: KEY,
  provider,
  model: MODEL,
  configured: !!KEY,
  stream: (opts) => (provider === 'anthropic' ? anthropic(opts) : gemini(opts)),
};
