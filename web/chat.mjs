// Ask AI: the round button at the bottom right of every screen, and the chat window it opens. The window
// can be dragged by its header anywhere on the screen (it remembers where; double-click the header to put
// it back), resized from its corner on a computer, and becomes a bottom sheet on a phone. It reads what the
// person is looking at (context()), answers with the connected model (call()) or the built-in assistant,
// and lives outside the app's own markup, so re-rendering a screen never closes it or loses the chat.
import { PROVIDERS, loadConfig, saveConfig, clearConfig, listModels, suggestedModel, configLabel, complete } from './llm.mjs';

const POS = 'local-tax-migration:chat-pos';
const CLAUDE_OFF = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);

/**
 * context()   -> { where, prompt, suggestions, builtIn(question) } for the current screen
 * ai()        -> { via: 'claude' | 'key' | null, label, hosted }
 * call(turns, {onText, signal}) -> Promise<{text}> with the connected model
 * connected(cfg | null) -> the page now uses this key (or none)
 * claudeOff() -> Claude was declined or is unavailable in this view
 * format(text) -> HTML for an answer; icon(name) -> SVG; esc(text) -> escaped text
 */
export function createChat({ context, ai, call, connected, claudeOff, format, icon, esc }) {
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'chat-fab';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'chat-panel');
  fab.innerHTML = `<span class="chat-fab-ic" aria-hidden="true">${icon('sparkles')}</span><span class="chat-fab-text">Ask AI</span>`;

  const panel = document.createElement('section');
  panel.className = 'chat-panel';
  panel.id = 'chat-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'chat-h');
  panel.innerHTML = `
    <header class="chat-head" title="Drag to move. Double-click to put it back.">
      <span class="chat-grip" aria-hidden="true">${icon('grip')}</span>
      <span class="chat-avatar" aria-hidden="true">${icon('sparkles')}</span>
      <div class="chat-titles"><h2 id="chat-h">Payroll AI</h2><p class="chat-status"><span class="chat-dot"></span><span class="chat-status-text"></span></p></div>
      <div class="chat-tools">
        <button type="button" class="chat-icon" data-c="settings" aria-pressed="false" aria-label="Connect an AI model" title="Connect an AI model">${icon('sliders')}</button>
        <button type="button" class="chat-icon" data-c="clear" aria-label="New chat" title="New chat">${icon('reset')}</button>
        <button type="button" class="chat-icon" data-c="close" aria-label="Close the chat" title="Close (Esc)">${icon('close')}</button>
      </div>
    </header>
    <div class="chat-where">${icon('pin')}<span></span></div>
    <div class="chat-body">
      <ol class="chat-log" aria-live="polite" aria-label="Conversation"></ol>
      <div class="chat-settings" hidden></div>
      <div class="chat-sugg" aria-label="Suggested questions"></div>
      <form class="chat-compose">
        <label class="sr-only" for="chat-q">Ask Payroll AI</label>
        <textarea id="chat-q" rows="1" maxlength="800" placeholder="Ask anything about this screen…"></textarea>
        <button type="submit" class="chat-send" aria-label="Send">${icon('send')}</button>
      </form>
      <p class="chat-note">AI can be wrong. It suggests; people decide.</p>
    </div>`;
  document.body.append(fab, panel);

  const $ = (sel) => panel.querySelector(sel);
  const head = $('.chat-head');
  const log = $('.chat-log');
  const settings = $('.chat-settings');
  const sugg = $('.chat-sugg');
  const form = $('.chat-compose');
  const input = $('#chat-q');
  const send = $('.chat-send');
  const msgs = []; // {role, text, source, failed}
  let busy = null; // AbortController while an answer streams
  let note = '';
  let setMsg = null; // the settings' status line {tone, text}
  let models = null; // model ids for the provider being set up

  // ---------- position ----------
  const phone = () => window.matchMedia('(max-width: 640px)').matches;
  const place = (x, y) => {
    const r = panel.getBoundingClientRect();
    const cx = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - r.width - 8));
    const cy = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - r.height - 8));
    panel.style.left = `${cx}px`;
    panel.style.top = `${cy}px`;
  };
  const resetPlace = () => { panel.style.left = ''; panel.style.top = ''; };
  const restore = () => {
    if (phone()) return resetPlace();
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS) ?? 'null'); } catch { /* none */ }
    if (p) place(p.x, p.y); else resetPlace();
  };
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (phone() || e.button !== 0 || e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => { if (drag?.id === e.pointerId) place(e.clientX - drag.dx, e.clientY - drag.dy); });
  const drop = (e) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    panel.classList.remove('dragging');
    const r = panel.getBoundingClientRect();
    try { localStorage.setItem(POS, JSON.stringify({ x: r.left, y: r.top })); } catch { /* lasts for this visit */ }
  };
  head.addEventListener('pointerup', drop);
  head.addEventListener('pointercancel', drop);
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    try { localStorage.removeItem(POS); } catch { /* none */ }
    resetPlace();
  });
  window.addEventListener('resize', () => { if (!panel.hidden && panel.style.left) place(parseFloat(panel.style.left), parseFloat(panel.style.top)); });

  // ---------- drawing ----------
  const who = () => {
    const a = ai();
    return a.via === 'claude' ? 'Claude' : a.via === 'key' ? a.label : 'Built-in assistant';
  };

  function drawHead() {
    const a = ai();
    $('.chat-dot').classList.toggle('on', Boolean(a.via));
    $('.chat-status-text').textContent = a.via ? who() : a.hosted ? 'Built-in assistant (allow Claude to use real AI)' : 'Built-in assistant';
    $('.chat-where span').textContent = context().where;
  }

  const bubble = (m, i) => (m.role === 'user'
    ? `<li class="chat-msg user"><div class="chat-bubble"><p>${esc(m.text)}</p></div></li>`
    : `<li class="chat-msg assistant${m.failed ? ' failed' : ''}"><span class="chat-mini" aria-hidden="true">${icon('sparkles')}</span><div class="chat-bubble" id="chat-b-${i}">${m.text == null ? '<span class="chat-typing" role="img" aria-label="Thinking"><i></i><i></i><i></i></span>' : `${format(m.text)}${m.source ? `<span class="chat-src">${esc(m.source)}</span>` : ''}`}</div></li>`);

  function drawLog() {
    const a = ai();
    const hello = `<li class="chat-msg assistant"><span class="chat-mini" aria-hidden="true">${icon('sparkles')}</span><div class="chat-bubble">
      <p><b>Hi, I'm Payroll AI.</b> I can see what you are looking at, so ask me about this screen, a line, a tax or how the prototype works.</p>
      ${a.via ? `<p class="chat-hint">${esc(who())} answers, using only what this screen shows.</p>`
        : a.hosted ? '<p class="chat-hint">Claude answers once you allow it. Until then the built-in assistant answers common questions.</p>'
          : '<p class="chat-hint">No AI model is connected yet, so the built-in assistant answers common questions. <button type="button" class="chat-link" data-c="settings">Connect an AI model</button> to ask anything.</p>'}
    </div></li>`;
    log.innerHTML = hello + msgs.map(bubble).join('') + (note ? `<li class="chat-hint" role="note">${esc(note)}</li>` : '');
    log.scrollTop = log.scrollHeight;
  }

  function drawSugg() {
    const asked = new Set(msgs.filter((m) => m.role === 'user').map((m) => m.text));
    const list = context().suggestions.filter((q) => !asked.has(q)).slice(0, 3);
    sugg.hidden = !list.length || !settings.hidden;
    sugg.innerHTML = list.map((q) => `<button type="button" class="chat-chip" data-q="${esc(q)}"${busy ? ' disabled' : ''}>${esc(q)}</button>`).join('');
  }

  function drawSettings() {
    const a = ai();
    if (a.hosted) {
      settings.innerHTML = `<div class="chat-set">
        <h3>The AI here</h3>
        <p>Inside claude.ai, <b>Claude</b> answers, on the account of whoever is viewing. claude.ai asks for permission the first time; allow it to use real AI.</p>
        <p>claude.ai does not let pages call other AI services, so a Gemini, OpenAI or other key works on the website or a local copy of the prototype, not here.</p>
        <p class="chat-set-msg ${a.via === 'claude' ? 'good' : 'info'}">${a.via === 'claude' ? 'Connected: Claude.' : 'Claude is not allowed here yet, so the built-in assistant answers.'}</p>
        <button type="button" class="btn" data-c="settings">Back to the chat</button>
      </div>`;
      return;
    }
    const cfg = loadConfig();
    const pick = settings.dataset.provider || cfg?.provider || 'gemini';
    const p = PROVIDERS[pick];
    settings.innerHTML = `<div class="chat-set">
      <h3>Connect an AI model</h3>
      <p>Use your own API key. It stays in this browser and is sent only to ${esc(p.name)}. It is never in the code, the repository or the published files.</p>
      ${cfg && !setMsg ? `<p class="chat-set-msg good">Connected: ${esc(configLabel(cfg))}.</p>` : ''}
      <label class="field" for="chat-prov">Provider<select id="chat-prov">${Object.entries(PROVIDERS).map(([id, x]) => `<option value="${id}"${id === pick ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      ${p.noKey ? '' : `<div class="field"><label for="chat-key">API key${p.keyHint ? ` <span class="muted">(${esc(p.keyHint)})</span>` : ''}</label>
        <div class="chat-key"><input type="password" id="chat-key" autocomplete="off" spellcheck="false" placeholder="${cfg?.provider === pick && cfg.key ? `Saved: ends …${esc(cfg.key.slice(-4))}. Paste to replace` : 'Paste your key'}"></div></div>`}
      ${p.where ? `<p class="small muted">Get one at ${esc(p.where)}.</p>` : ''}
      <details class="chat-adv"${pick === 'custom' ? ' open' : ''}><summary>Advanced: model and address</summary>
        <label class="field" for="chat-model">Model <span class="muted">(blank: pick one for me)</span>
          <div class="chat-model"><input type="text" id="chat-model" list="chat-models" autocomplete="off" spellcheck="false" value="${esc(cfg?.provider === pick ? cfg.model : '')}"><datalist id="chat-models">${(models ?? []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div></label>
        <label class="field" for="chat-base">Address<input type="text" id="chat-base" autocomplete="off" spellcheck="false" placeholder="${esc(p.base || 'https://…/v1')}" value="${esc(cfg?.provider === pick && cfg.base ? cfg.base : '')}"></label>
      </details>
      <div class="chat-check"><button type="button" class="btn primary" data-c="connect">${icon('key')}Connect and test</button>${cfg ? '<button type="button" class="btn quiet" data-c="disconnect">Disconnect</button>' : ''}</div>
      ${setMsg ? `<p class="chat-set-msg ${setMsg.tone}" role="status">${esc(setMsg.text)}</p>` : '<p class="chat-set-msg" role="status" hidden></p>'}
      <p class="small muted">Tip: restrict the key to this one API in the provider's console, and replace it after the demo.</p>
      <button type="button" class="btn" data-c="settings">Back to the chat</button>
    </div>`;
  }

  function drawAll() {
    drawHead();
    if (!settings.hidden) drawSettings();
    else drawLog();
    drawSugg();
  }

  function showSettings(on) {
    settings.hidden = !on;
    log.hidden = on;
    form.hidden = on;
    $('.chat-note').hidden = on;
    $('[data-c="settings"][aria-pressed]').setAttribute('aria-pressed', String(on));
    setMsg = null;
    drawAll();
    if (on) (settings.querySelector('#chat-key') ?? settings.querySelector('select, button'))?.focus();
    else input.focus({ preventScroll: true });
  }

  // ---------- connecting a key ----------
  async function connect() {
    const provider = settings.querySelector('#chat-prov').value;
    const p = PROVIDERS[provider];
    const old = loadConfig();
    const typed = settings.querySelector('#chat-key')?.value.trim() ?? '';
    const key = p.noKey ? '' : typed || (old?.provider === provider ? old.key : '');
    const base = settings.querySelector('#chat-base').value.trim();
    let model = settings.querySelector('#chat-model').value.trim();
    if (!p.noKey && key.length < 12) { setMsg = { tone: 'bad', text: 'Paste the whole API key first.' }; drawSettings(); settings.querySelector('#chat-key')?.focus(); return; }
    if (provider === 'custom' && !base) { setMsg = { tone: 'bad', text: 'Type the address of the service (it ends in /v1).' }; drawSettings(); settings.querySelector('#chat-base').focus(); return; }
    const cfg = { provider, key, model, ...(base ? { base } : {}) };
    setMsg = { tone: 'info', text: `Checking the key with ${p.name}…` };
    drawSettings();
    try {
      models = await listModels(cfg);
      if (!model) model = suggestedModel(provider, models) ?? '';
    } catch (e) {
      if (e.code === 'auth' || e.code === 'network' || !model) {
        setMsg = { tone: 'bad', text: e.code === 'auth' ? `${p.name} did not accept this key. ${e.message}` : e.code === 'network' ? `Could not reach ${p.name} from this page. Check the key's restrictions and your connection${provider === 'ollama' ? ', and that Ollama runs with OLLAMA_ORIGINS=*' : ''}.` : e.message };
        drawSettings();
        return;
      }
    }
    if (!model) { setMsg = { tone: 'bad', text: 'No model was found for this key. Type a model name under Advanced.' }; drawSettings(); return; }
    cfg.model = model;
    setMsg = { tone: 'info', text: `Testing ${model}…` };
    drawSettings();
    try {
      await complete(cfg, 'Reply with the single word: ready');
    } catch (e) {
      setMsg = { tone: 'bad', text: `The key works, but ${model} did not answer: ${e.message}` };
      drawSettings();
      return;
    }
    saveConfig(cfg);
    delete settings.dataset.provider;
    connected(cfg);
    setMsg = { tone: 'good', text: `Connected: ${configLabel(cfg)}. Ask away.` };
    drawAll();
  }

  // ---------- asking ----------
  async function ask(q) {
    q = String(q ?? '').trim();
    if (!q || busy) return;
    const c = context();
    const history = msgs.filter((m) => m.text && !m.failed).slice(-8).map((m) => ({ role: m.role, content: m.text }));
    msgs.push({ role: 'user', text: q });
    const m = { role: 'assistant', text: null, source: '' };
    msgs.push(m);
    note = '';
    input.value = '';
    autosize();
    const a = ai();
    if (!a.via) {
      m.text = c.builtIn(q);
      m.source = 'Built-in assistant';
      drawLog();
      drawSugg();
      return;
    }
    busy = new AbortController();
    send.classList.add('stop');
    send.setAttribute('aria-label', 'Stop');
    send.innerHTML = icon('stop');
    const at = msgs.length - 1;
    drawLog();
    drawSugg();
    const turns = [{ role: 'user', content: c.prompt }, { role: 'assistant', content: 'Understood. I will answer from these facts.' }, ...history, { role: 'user', content: q }];
    try {
      const r = await call(turns, {
        signal: busy.signal,
        onText: ({ text }) => { const el = document.getElementById(`chat-b-${at}`); if (el) { el.classList.add('streaming'); el.textContent = text; log.scrollTop = log.scrollHeight; } },
      });
      m.text = r.text;
      m.source = who();
    } catch (e) {
      const code = e?.code ?? 'upstream_error';
      if (code === 'cancelled') { m.text = e.text || 'Stopped.'; m.failed = !e.text; m.source = e.text ? `${who()} (stopped)` : ''; }
      else {
        if (CLAUDE_OFF.has(code) && a.via === 'claude') claudeOff?.();
        m.text = c.builtIn(q);
        m.source = 'Built-in assistant';
        note = CLAUDE_OFF.has(code) ? 'Claude was not allowed here, so the built-in assistant answered.'
          : code === 'auth' ? 'The AI service did not accept the key (open the sliders to check it), so the built-in assistant answered.'
            : code === 'rate_limited' ? 'The AI is busy or the key reached its limit; try again in a minute. The built-in assistant answered.'
              : code === 'network' ? 'Could not reach the AI service from this page, so the built-in assistant answered.'
                : `The AI could not answer (${e?.message ?? code}), so the built-in assistant did.`;
      }
    }
    busy = null;
    send.classList.remove('stop');
    send.setAttribute('aria-label', 'Send');
    send.innerHTML = icon('send');
    drawAll();
    input.focus({ preventScroll: true });
  }

  // ---------- events ----------
  function open() {
    panel.hidden = false;
    fab.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    fab.querySelector('.chat-fab-ic').innerHTML = icon('close');
    fab.querySelector('.chat-fab-text').textContent = 'Close';
    restore();
    drawAll();
    input.focus({ preventScroll: true });
  }
  function close() {
    panel.hidden = true;
    fab.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
    fab.querySelector('.chat-fab-ic').innerHTML = icon('sparkles');
    fab.querySelector('.chat-fab-text').textContent = 'Ask AI';
    fab.focus({ preventScroll: true });
  }
  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (!settings.hidden) showSettings(false); else close(); }
  });
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 132)}px`; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (busy) busy.abort(); else ask(input.value); });
  sugg.addEventListener('click', (e) => { const b = e.target.closest('.chat-chip'); if (b && !b.disabled) ask(b.dataset.q); });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const c = b.dataset.c;
    if (c === 'close') close();
    else if (c === 'settings') showSettings(settings.hidden);
    else if (c === 'clear') { busy?.abort(); msgs.length = 0; note = ''; drawAll(); input.focus(); }
    else if (c === 'connect') connect();
    else if (c === 'disconnect') { clearConfig(); models = null; connected(null); setMsg = { tone: 'info', text: 'Disconnected. The key was removed from this browser.' }; drawAll(); }
  });
  settings.addEventListener('change', (e) => {
    if (e.target.id === 'chat-prov') { settings.dataset.provider = e.target.value; models = null; setMsg = null; drawSettings(); settings.querySelector('#chat-prov').focus(); }
  });

  return {
    refresh() {
      if (panel.hidden) return;
      drawHead();
      if (settings.hidden && !busy) { drawLog(); drawSugg(); }
    },
    open,
    close,
  };
}
