// Connecting a model with your own key: both request formats, streaming, model lists and errors,
// against a stand-in provider on this computer (no real key and no network needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { complete, listModels, suggestedModel, PROVIDERS, configLabel } from '../web/llm.mjs';

const seen = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : null;
  seen.push({ url: req.url, headers: req.headers, body: j });
  const key = req.headers.authorization?.replace('Bearer ', '') ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'];
  if (key === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); return; }
  if (req.url.includes('/models?')) { // Gemini's own model list
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.0-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.0-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }));
    return;
  }
  if (req.url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of ['Hello ', 'from ', 'Gemini.']) res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: part }] } }] })}\r\n\r\n`);
    res.end();
    return;
  }
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] })); return; }
  if (j.model === 'busy') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'slow down' } })); return; }
  if (j.model === 'silent') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of ['Hello ', 'from ', 'the model.']) {
    if (req.url.endsWith('/messages')) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: part } })}\n\n`);
    else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
  }
  res.end(req.url.endsWith('/messages') ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
test.after(() => server.close());

test('an OpenAI-compatible model streams its answer, with the key as a Bearer token', async () => {
  const parts = [];
  const r = await complete({ provider: 'custom', base, key: 'k1', model: 'm' }, [{ role: 'user', content: 'facts' }, { role: 'user', content: 'question' }], { onText: ({ delta }) => parts.push(delta) });
  assert.equal(r.text, 'Hello from the model.');
  assert.deepEqual(parts, ['Hello ', 'from ', 'the model.']);
  const req = seen.at(-1);
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer k1');
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'facts\n\nquestion' }]); // same-side turns merged
});

test('an Anthropic model gets its own headers, including the opt-in for calls from a web page', async () => {
  const r = await complete({ provider: 'anthropic', base, key: 'sk-ant', model: 'claude-haiku-5-5' }, 'hi');
  assert.equal(r.text, 'Hello from the model.');
  const req = seen.at(-1);
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(req.body.max_tokens > 0);
});

test('errors come back with a code the page can act on', async () => {
  await assert.rejects(complete({ provider: 'custom', base, key: 'bad', model: 'm' }, 'hi'), (e) => e.code === 'auth' && /Invalid API key/.test(e.message));
  await assert.rejects(complete({ provider: 'custom', base, key: 'k', model: 'busy' }, 'hi'), (e) => e.code === 'rate_limited');
  await assert.rejects(complete({ provider: 'custom', base, key: 'k', model: 'silent' }, 'hi'), (e) => e.code === 'empty_completion');
  await assert.rejects(complete({ provider: 'custom', base: 'http://127.0.0.1:9/v1', key: 'k', model: 'm' }, 'hi'), (e) => e.code === 'network');
  await assert.rejects(complete({ provider: 'custom', base, key: 'k', model: '' }, 'hi'), (e) => e.code === 'bad_model');
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(complete({ provider: 'custom', base, key: 'k', model: 'm' }, 'hi', { signal: ctl.signal }), (e) => e.code === 'cancelled');
});

test('the models a key can use are listed, so nobody has to guess a model name', async () => {
  assert.deepEqual(await listModels({ provider: 'custom', base, key: 'k' }), ['a-model', 'b-model']);
  await assert.rejects(listModels({ provider: 'custom', base, key: 'bad' }), (e) => e.code === 'auth');
});

test('every provider has an address and a short name; Ollama needs no key', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.short, id);
    assert.ok(['anthropic', 'openai', 'gemini'].includes(p.protocol), id);
    if (id !== 'custom') assert.match(p.base, /^https?:\/\//, id);
  }
  assert.equal(PROVIDERS.ollama.noKey, true);
  assert.equal(configLabel({ provider: 'openai', model: 'x' }), 'OpenAI: x');
});

test("Gemini uses Google's own format: the key in x-goog-api-key, model turns, and a streamed answer", async () => {
  const gbase = base.replace(/\/v1$/, '/v1beta');
  const parts = [];
  const r = await complete({ provider: 'gemini', base: gbase, key: 'AQ.example', model: 'gemini-3.0-flash' },
    [{ role: 'user', content: 'facts' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'question' }], { onText: ({ delta }) => parts.push(delta) });
  assert.equal(r.text, 'Hello from Gemini.');
  assert.deepEqual(parts, ['Hello ', 'from ', 'Gemini.']);
  const req = seen.at(-1);
  assert.equal(req.url, '/v1beta/models/gemini-3.0-flash:streamGenerateContent?alt=sse');
  assert.equal(req.headers['x-goog-api-key'], 'AQ.example');
  assert.equal(req.headers.authorization, undefined);
  assert.deepEqual(req.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  // The model list keeps only text models, and the default is the newest full "flash".
  const ids = await listModels({ provider: 'gemini', base: gbase, key: 'AQ.example' });
  assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-3.0-flash', 'gemini-3.0-flash-lite']);
  assert.equal(suggestedModel('gemini', ids), 'gemini-3.0-flash');
  await assert.rejects(listModels({ provider: 'gemini', base: gbase, key: 'bad' }), (e) => e.code === 'auth');
});
