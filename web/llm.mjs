// Connecting a language model with your own API key, for the AI assistant and the Ask AI chat.
//
// In the hosted app on claude.ai the page uses Claude through its `sample` capability instead (see app.mjs):
// claude.ai blocks pages from calling other servers, so keys only work on the website or a local copy.
//
// The key is typed into the chat's settings and kept in this browser only (localStorage). It is sent only
// to the provider the person chose. It is never in the code, the repository or the published files.
//
// Three request formats cover the common providers:
//   gemini    - Google's own API (x-goog-api-key header), which accepts both AIza… and AQ.… keys
//   openai    - the OpenAI chat-completions format, also used by Groq, OpenRouter, Ollama and others
//   anthropic - the Claude API, with Anthropic's opt-in header for calls made from a web page
// Every call takes a prompt string or turns [{role: 'user' | 'assistant', content}], streams the answer
// through onText({text, delta}), and rejects with {code, message, text?}.

const STORE = 'local-tax-migration:llm';

export const PROVIDERS = {
  gemini: { name: 'Google Gemini', short: 'Gemini', protocol: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', keyHint: 'AIza… or AQ.…', where: 'aistudio.google.com/apikey' },
  openai: { name: 'OpenAI', short: 'OpenAI', protocol: 'openai', base: 'https://api.openai.com/v1', keyHint: 'sk-…', where: 'platform.openai.com/api-keys' },
  anthropic: { name: 'Anthropic Claude API', short: 'Claude API', protocol: 'anthropic', base: 'https://api.anthropic.com/v1', keyHint: 'sk-ant-…', where: 'console.anthropic.com' },
  groq: { name: 'Groq', short: 'Groq', protocol: 'openai', base: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…', where: 'console.groq.com/keys' },
  openrouter: { name: 'OpenRouter (many models)', short: 'OpenRouter', protocol: 'openai', base: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…', where: 'openrouter.ai/keys' },
  ollama: { name: 'Ollama on this computer', short: 'Ollama', protocol: 'openai', base: 'http://localhost:11434/v1', noKey: true, where: 'ollama.com (start it with OLLAMA_ORIGINS=* so this page may call it)' },
  custom: { name: 'Other (OpenAI-compatible address)', short: 'Custom', protocol: 'openai', base: '' },
};

export const configLabel = (cfg) => `${PROVIDERS[cfg.provider]?.short ?? cfg.provider}: ${cfg.model}`;

export function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    return c && PROVIDERS[c.provider] ? c : null;
  } catch { return null; }
}
export function saveConfig(cfg) {
  try { localStorage.setItem(STORE, JSON.stringify(cfg)); return true; } catch { return false; }
}
export function clearConfig() {
  try { localStorage.removeItem(STORE); } catch { /* nothing saved */ }
}

const fail = (code, message, text) => Object.assign({ code, message }, text ? { text } : {});
const baseOf = (cfg) => String(cfg.base || PROVIDERS[cfg.provider]?.base || '').replace(/\/+$/, '');

function headersFor(cfg, json = true) {
  const p = PROVIDERS[cfg.provider];
  const h = json ? { 'content-type': 'application/json' } : {};
  if (p.protocol === 'gemini') h['x-goog-api-key'] = cfg.key;
  else if (p.protocol === 'anthropic') Object.assign(h, { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  else if (cfg.key) h.authorization = `Bearer ${cfg.key}`;
  return h;
}

async function request(url, init) {
  try { return await fetch(url, init); } catch (e) {
    if (e?.name === 'AbortError' || init.signal?.aborted) throw fail('cancelled', 'Stopped.');
    throw fail('network', 'Could not reach the AI service from this page.');
  }
}

async function httpError(res) {
  let msg = '';
  try { const j = await res.json(); msg = j?.error?.message ?? j?.message ?? ''; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api.?key|credential|auth/i.test(msg))) return fail('auth', msg || 'The key was not accepted.');
  if (res.status === 404) return fail('bad_model', msg || 'That model was not found for this key.');
  if (res.status === 429) return fail('rate_limited', msg || 'Too many requests, or the key reached its limit.');
  return fail('upstream_error', msg || `The service answered ${res.status}.`);
}

/** Same-side turns merged, so every format sees user and assistant turns alternate. */
function normalize(input) {
  const turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const out = [];
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    if (out.at(-1)?.role === role) out.at(-1).content += `\n\n${t.content}`;
    else out.push({ role, content: String(t.content) });
  }
  return out;
}

/** The models a key can use, sorted by name. Also tells whether the key works. */
export async function listModels(cfg, { signal } = {}) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw fail('bad_model', 'Choose a provider.');
  if (!p.noKey && !cfg.key) throw fail('auth', 'Paste an API key first.');
  const url = p.protocol === 'gemini' ? `${baseOf(cfg)}/models?pageSize=200` : `${baseOf(cfg)}/models`;
  const res = await request(url, { headers: headersFor(cfg, false), signal });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const ids = p.protocol === 'gemini'
    ? (j.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''))
    : (j.data ?? j.models ?? []).map((m) => String(m.id ?? m.name ?? ''));
  return [...new Set(ids.filter(Boolean))].sort();
}

/** A sensible default from a model list: fast and current, so answers come quickly in a demo. */
export function suggestedModel(provider, ids) {
  const version = (n) => Number(n.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const best = (list, score) => [...list].sort((a, b) => score(b) - score(a))[0] ?? null;
  if (provider === 'gemini') {
    const text = ids.filter((n) => /^gemini-/.test(n) && !/(embed|image|tts|audio|live|vision|native|computer|robotics|learnlm|aqa)/.test(n));
    return best(text, (n) => version(n) * 100 + (/flash/.test(n) ? 20 : 0) - (/lite/.test(n) ? 15 : 0) - (/(preview|exp)/.test(n) ? 5 : 0) - (/-\d{3}$/.test(n) ? 1 : 0)) ?? ids[0] ?? null;
  }
  if (provider === 'anthropic') return best(ids.filter((n) => /claude/.test(n)), (n) => (/haiku/.test(n) ? 50 : /sonnet/.test(n) ? 40 : 0) + version(n)) ?? ids[0] ?? null;
  if (provider === 'openai') return best(ids.filter((n) => /^gpt-/.test(n) && !/(audio|realtime|search|transcribe|tts|image)/.test(n)), (n) => version(n) * 10 + (/mini/.test(n) ? 5 : 0) - (/nano/.test(n) ? 3 : 0)) ?? ids[0] ?? null;
  return ids[0] ?? null;
}

/** Read a server-sent-events stream, handing each data line's JSON to pick() for its text. */
async function readStream(res, pick, onText, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const meta = { blocked: false };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw fail('upstream_error', chunk.error.message ?? 'The service stopped with an error.', text);
        const delta = pick(chunk, meta);
        if (delta) { text += delta; onText?.({ text, delta }); }
      }
    }
  } catch (e) {
    if (e?.code) throw e;
    if (e?.name === 'AbortError' || signal?.aborted) throw fail('cancelled', 'Stopped.', text);
    throw fail('network', 'The answer was cut off.', text);
  }
  if (!text.trim()) throw meta.blocked ? fail('refused', 'The model did not answer that.') : fail('empty_completion', 'The model gave no answer.');
  return text;
}

/** Ask the connected model. Resolves {text}. */
export async function complete(cfg, input, { onText, signal } = {}) {
  const p = PROVIDERS[cfg?.provider];
  if (!p) throw fail('bad_model', 'No AI model is connected.');
  if (!cfg.model) throw fail('bad_model', 'Choose a model first.');
  if (!p.noKey && !cfg.key) throw fail('auth', 'Paste an API key first.');
  if (signal?.aborted) throw fail('cancelled', 'Stopped.');
  const turns = normalize(input);
  let url;
  let body;
  let pick;
  if (p.protocol === 'gemini') {
    url = `${baseOf(cfg)}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
    body = { contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })), generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } };
    pick = (c, meta) => {
      if (c.promptFeedback?.blockReason || c.candidates?.[0]?.finishReason === 'SAFETY') meta.blocked = true;
      return (c.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? '').join('');
    };
  } else if (p.protocol === 'anthropic') {
    url = `${baseOf(cfg)}/messages`;
    body = { model: cfg.model, max_tokens: 1024, temperature: 0.3, stream: true, messages: turns };
    pick = (c) => (c.type === 'content_block_delta' && c.delta?.type === 'text_delta' ? c.delta.text : '');
  } else {
    url = `${baseOf(cfg)}/chat/completions`;
    body = { model: cfg.model, stream: true, temperature: 0.3, messages: turns };
    pick = (c) => c.choices?.[0]?.delta?.content ?? '';
  }
  const res = await request(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res);
  return { text: await readStream(res, pick, onText, signal) };
}
