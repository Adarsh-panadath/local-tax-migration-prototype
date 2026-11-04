// Browser app for the local-tax migration prototype. No framework, no build step.
import { analyseCompany, DEFAULT_THRESHOLDS } from './engine/analysis.mjs';
import { MODEL_VERSION } from './engine/cluster.mjs';
import { effectiveAll, emptyDecisions, gapStage, gapCoveredBy, readiness, agencyAccounts, w2Preview, reconcile, liveTaxes, STAGE_LABEL, automate, automationStats, exceptions as openExceptions, AUTOMATION_RULES, DEFAULT_POLICY, NEEDS_EMPLOYER } from './engine/workflow.mjs';
import { monthSpan, rateText, cloudMonths, desktopMonths } from './engine/util.mjs';
import { buildReport, casesCSV } from './report.mjs';
import { GROUPS, runScenarios } from './scenarios.mjs';
import { loadSqlJs, createDatabase, readData, readCompany, writeResults, resultRows, tableSummary, describeTable, TABLE_NOTES, RULE_CHECKS, tryRule, exportDatabase, SCHEMA, runQuery, csvTemplate, companyFromCsv, CSV_COLUMNS, applyCorrection, lookupIndex, addressKey } from './db.mjs';
import { generateBusinesses, SEED } from './generate.mjs';
import { lineFacts, gapFacts, lineOpinion, gapOpinion, answer as builtInAnswer, suggestions as aiSuggestions, opinionText, opinionFormat, RULES } from './assistant.mjs';
import { PROVIDERS, loadConfig, configLabel, complete as completeWithKey } from './llm.mjs';
import { createChat } from './chat.mjs';
import { runLab, KEY_NAMES } from './mllab.mjs';

const STORE = 'local-tax-migration:brd-v3';
const UPLOADS = 'local-tax-migration:uploads';
const VIEWS = ['move', 'review', 'expert', 'golive', 'analysis', 'model', 'lab', 'data', 'scenarios', 'audit'];

// Demo sign-in: each role sees only its own screens. All three work on the same business:
// the owner moves it, the expert decides what the rules leave, the admin looks under the hood.
const ROLES = {
  owner: { icon: 'building', label: 'Business owner', side: 'Customer', blurb: 'Moves their own business to Online payroll', tabs: [['move', 'Move'], ['review', 'To do'], ['golive', 'Go live']] },
  expert: { icon: 'user', label: 'Payroll tax expert', side: 'Intuit staff', blurb: 'Decides the lines the rules leave', tabs: [['expert', 'Queue']] },
  admin: { icon: 'gauge', label: 'Admin', side: 'Intuit staff', blurb: 'The engine, the model and the data', tabs: [['analysis', 'Engine'], ['model', 'Model'], ['lab', 'ML Lab'], ['data', 'Data'], ['scenarios', 'Scenarios'], ['audit', 'Log']] },
};
const roleOf = () => ROLES[state.role];
const canOpen = (view) => state.role === 'admin' || Boolean(roleOf()?.tabs.some(([id]) => id === view));
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
// The hosted demo blocks file downloads, so it offers copy buttons instead.
const HOSTED = Boolean(document.querySelector('meta[name="ltm-hosted"]'));

let data = null;
let state = loadState();
const cache = new Map();
let scenarioResults = null; // run once per page load, on the starting data
let pendingFocus = null;    // an employee row to scroll to after the next render (analysis, go live)
let focusEmployee = null;   // an employee whose first record a workspace should select
let lastView = null;
let afterRender = null;     // one-off scroll adjustment after the next render
let listY = 0;              // phone: where the record list was scrolled before opening a record
let keepDetail = false;     // a link that opens a record in another view keeps the detail open
let byKeyboard = false;     // the last activation came from the keyboard (move focus to what it opened)
let resetArmed = false;     // Reset needs a second click within a few seconds
let resetTimer = null;
let moving = null;          // the short "moving" sequence after Move to Online payroll: { companyId, step, timer }
let files = null;           // the demo files as loaded, the database's seed
let db = null;              // the in-browser SQLite database (null if it could not start)
let dbError = null;
let uploads = loadUploads(); // a Desktop file uploaded on the Data page, which then replaces the demo business: [] or [{ company, addresses, file }]
let uploadMsg = null;       // the last upload's result: { tone, title, items }
let query = { sql: 'SELECT route, COUNT(*) AS lines\nFROM results\nGROUP BY route\nORDER BY lines DESC', result: null, error: null };
let generated = null;       // the demo business (152 employees), made from a fixed seed on every visit
let lookupIdx = null;       // address lookup by street and ZIP, for addresses the employer adds
let outcomesKey = null;     // the state the outcome tables were last written for
let lab = { seed: SEED, total: 1200, result: null, running: false, error: null };
const more = {};            // "Show all" toggles for long lists
// The Model page's "Try the clustering" panel: one made-up employee and Desktop item, run through the real engine.
let trial = { label: 'Sch Dist Wthld', law: '177', kind: 'tax', town: 'Pickerington', site: '', rate: '1', name: 'Asha Verma', result: null, opened: null };

// Ask AI. In the hosted app on claude.ai, Claude answers (the page's `sample` capability, on the viewer's own
// account); on the website or a local copy, a model the user connected with their own key; otherwise, or if
// the viewer says no, the built-in assistant answers from the same facts.
// via: 'claude' (hosted app), 'key' (a model the user connected with their own API key) or null (built-in).
const ai = { state: 'checking', sample: null, via: null, label: '', cfg: null, hosted: false };
let chat = null;
const aiName = () => (ai.via === 'claude' ? 'Claude' : ai.via === 'key' ? PROVIDERS[ai.cfg.provider].short : 'The built-in assistant');
// One call for both kinds of real model: a prompt string or [{role, content}] turns ending on the user.
function aiCall(input, { onText, signal, cache } = {}) {
  if (ai.via === 'claude') return ai.sample(input, { modelTier: 'quick', signal, onText, ...(cache === false ? { cache: false } : {}) });
  if (ai.via === 'key') return completeWithKey(ai.cfg, input, { onText, signal });
  return Promise.reject({ code: 'not_granted', message: 'No AI model is connected.' });
}

// ---------- state ----------

function freshState() {
  return { role: null, companyId: 'G-001', settings: { forceShadow: {}, thresholds: {} }, decisions: {}, audit: [], filters: { review: 'todo', expert: 'open' }, sel: {}, selIndex: {}, query: {}, moveStep: {}, detailOpen: false, corrections: [], added: [] };
}
function loadUploads() {
  try { return JSON.parse(localStorage.getItem(UPLOADS) ?? '[]').slice(-1); } catch { return []; }
}
function saveUploads() {
  try { localStorage.setItem(UPLOADS, JSON.stringify(uploads)); } catch { /* the upload still works for this visit */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const saved = JSON.parse(raw);
      const fresh = freshState();
      return { ...fresh, ...saved, role: ROLES[saved.role] ? saved.role : null, settings: { ...fresh.settings, ...(saved.settings ?? {}) }, filters: { ...fresh.filters, ...(saved.filters ?? {}) }, sel: saved.sel ?? {}, selIndex: saved.selIndex ?? {}, query: saved.query ?? {}, moveStep: saved.moveStep ?? {}, corrections: saved.corrections ?? [], added: saved.added ?? [] };
    }
  } catch { /* storage unavailable: start fresh */ }
  return freshState();
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* demo still works without storage */ }
}

const currentView = () => {
  const h = location.hash.replace('#', '');
  if (VIEWS.includes(h) && canOpen(h)) return h;
  return roleOf()?.tabs[0][0] ?? 'move';
};
const companyById = (id = state.companyId) => data.companies.find((c) => c.company_id === id);
const decisionsFor = (id = state.companyId) => (state.decisions[id] ??= emptyDecisions());
const peekDecisions = (id) => state.decisions[id] ?? emptyDecisions(); // read without adding an entry
const settingsKey = () => JSON.stringify(state.settings);
// The engine's analysis of one business, kept until its data or the settings change.
// A Desktop file the engine stops on is kept too, so it is not analysed again on every screen.
function analysisFor(id = state.companyId) {
  const key = `${id}|${settingsKey()}`;
  if (!cache.has(key)) {
    try { cache.set(key, analyseCompany(companyById(id), data, state.settings)); } catch (err) {
      if (err.name !== 'DataError') throw err;
      cache.set(key, err);
    }
  }
  const v = cache.get(key);
  if (v instanceof Error) throw v;
  return v;
}
function forgetCompany(id) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}|`)) cache.delete(k);
  outcomesKey = null;
}
// The analysis index also holds placeholders for addresses the lookup does not know.
const addressById = (id) => analysisFor().idx.addresses.get(id) ?? data.geocoder.addresses.find((a) => a.address_id === id);
const stateName = (st) => data.catalog.states[st]?.name ?? st ?? 'Unknown state';

function log(actor, action, target, detail = '') {
  state.audit.unshift({ at: new Date().toISOString(), company_id: state.companyId, actor, action, target, detail, model_version: MODEL_VERSION });
  state.audit = state.audit.slice(0, 500);
}

// ---------- formatting ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => usd.format(n);
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const initials = (name) => String(name).split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (name, size = '') => `<span class="avatar${size ? ` ${size}` : ''}" aria-hidden="true">${esc(initials(name))}</span>`;
const MARK = { pass: '✓', fail: '×', warn: '!', info: 'i' };
// Line icons (24px grid, stroke drawn in the current text colour).
const ICONS = {
  landmark: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  tick: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  user: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  steps: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  spark: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="m5.6 5.6 2.1 2.1"/><path d="m16.3 16.3 2.1 2.1"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m5.6 18.4 2.1-2.1"/><path d="m16.3 7.7 2.1-2.1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  list: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  out: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
};
const icon = (name, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
const mark = (tone) => `<span class="mark ${tone}" aria-hidden="true">${MARK[tone]}</span>`;
// A round arrow button in a card's corner that opens the screen with the detail.
const arrowLink = (href, label) => `<a class="arrow-btn" href="${href}" aria-label="${esc(label)}" title="${esc(label)}">${icon('out')}</a>`;
// Big figures keep the cents (or the denominator) in a softer grey, so the whole number reads first.
const bigMoney = (n) => { const [whole, cents] = money(n).split('.'); return `<span class="fig">${esc(whole)}<span class="dim">.${esc(cents)}</span></span>`; };
const bigOf = (n, total) => `<span class="fig">${n}<span class="dim">/${total}</span></span>`;
// Overlapping initials for a group of people, with "+N" for the rest.
const avatarStack = (names, max = 4) => `<span class="stack" aria-hidden="true">${names.slice(0, max).map((n) => `<span class="avatar">${esc(initials(n))}</span>`).join('')}${names.length > max ? `<span class="avatar more">+${names.length - max}</span>` : ''}</span>`;
const labelOf = (l) => (String(l ?? '').trim() ? l : '(blank label)');
const domId = (s) => String(s).replace(/[^A-Za-z0-9]/g, '-');
const ROUTE = {
  local_tax: { label: 'Local tax', tone: 'accent' },
  not_a_tax: { label: 'Not a tax', tone: '' },
  not_in_database: { label: 'Not in database', tone: 'warn' },
  custom_entry: { label: 'Custom entry', tone: 'info' },
  stop: { label: 'Not owed', tone: 'bad' },
};
const STAGE_TONE = { awaiting_employer: 'accent', with_expert: 'warn', confirmed: 'good', moved_to_deduction: 'info', employer_managed: 'info', stopped: 'bad' };
const pill = (text, tone = '', extra = '') => `<span class="pill ${tone} ${extra}"><span class="dot"></span>${esc(text)}</span>`;
const taxShort = (t) => (t.type === 'school_district' ? t.name : t.name.replace(/^City of /, '').replace(/ income tax$/, ' city tax'));
const basisText = (b) => ({ home: 'home address', work: 'work location', higher: 'higher of home and work rate' })[b] ?? b;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3600);
}

// ---------- summaries ----------

function summary(id = state.companyId) {
  const a = analysisFor(id);
  const d = decisionsFor(id);
  const cases = effectiveAll(a, d);
  const routes = { local_tax: 0, not_a_tax: 0, not_in_database: 0 };
  for (const c of a.cases) routes[c.route] += 1;
  const openGaps = a.gaps.filter((g) => !['added', 'covered'].includes(gapStage(g, d, cases))).length;
  const touched = cases.some((c) => c.decision.employer || c.decision.expert) || Object.keys(d.gaps).length > 0;
  return {
    a, d, cases, routes,
    awaiting: cases.filter((c) => c.stage === 'awaiting_employer').length + openGaps,
    expert: cases.filter((c) => c.stage === 'with_expert').length,
    info: cases.filter(waitsForEmployer).length, // waiting for a home address or a work location from the employer
    accounts: d.live ? 0 : agencyAccounts(a, d).filter((x) => !x.complete).length, // agencies with no account number yet
    verified: cases.filter((c) => c.stage === 'awaiting_employer' && c.verified).length,
    status: d.reconciled ? 'Reconciled' : d.live ? 'Live' : touched ? 'In review' : 'Not started',
  };
}

function statesInUse(a) {
  const set = new Set(a.cases.map((c) => c.state));
  for (const s of a.company.worksites) set.add(addressById(s.address_id).state);
  return set;
}

// ---------- shell ----------

// After a re-render, put keyboard focus back on the same control, or on the record that replaced it,
// so a keyboard user is not sent back to the top of the page after every action.
function focusSelector(el) {
  if (!el || el === document.body || !app.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (!el.dataset?.action) return null;
  return ['action', 'id', 'key', 'value', 'view', 'rule'].filter((k) => el.dataset[k] != null).map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('');
}

function render() {
  if (!data) return;
  queueMicrotask(() => chat?.refresh());
  if (!state.role) { app.innerHTML = signIn(); lastView = null; return; }
  const view = currentView();
  // A screen this role cannot open shows its first screen, and the address says so.
  if (location.hash.length > 1 && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  const prevFocus = focusSelector(document.activeElement);
  let s;
  try {
    s = summary();
  } catch (err) {
    if (err.name !== 'DataError') { crashed(err); return; }
    // A Desktop file that cannot be analysed: say what is wrong instead of showing a broken page.
    const other = uploads.length ? generated.companies[0] : null;
    app.innerHTML = `<main class="main" id="main" tabindex="-1"><div class="page"><div class="page-head"><h1>${esc(companyById().name)}: the Desktop file cannot be analysed</h1>
      <p class="lede">Fix these problems in the file first. Nothing has been mapped.</p></div>
      <ul class="marks">${err.issues.map((i) => `<li>${mark('fail')}<span>${esc(i.text)}</span></li>`).join('')}</ul>
      ${other ? `<p><button class="btn" type="button" data-action="remove-upload">Back to ${esc(other.name)}</button></p>` : ''}${footnote()}</div></main>`;
    return;
  }
  const wide = view === 'review' || view === 'expert';
  const listScroll = lastView === view ? document.querySelector('.records')?.scrollTop : null;
  let body;
  try {
    body = { move: viewMove, lab: viewLab, analysis: viewAnalysis, review: viewReview, expert: viewExpert, golive: viewGoLive, scenarios: viewScenarios, model: viewModel, audit: viewAudit, data: viewData }[view](s);
  } catch (err) { crashed(err); return; }
  app.innerHTML = `<button class="skip" type="button" data-action="skip">Skip to main content</button>${appbar(view, s)}<main class="main" id="main" tabindex="-1"><div class="page${wide ? ' wide' : ''}">${body}${footnote()}</div></main>`;
  lastView = view;
  labelStackedTables();
  if (wide) {
    if (listScroll != null) { const r = document.querySelector('.records'); if (r) r.scrollTop = listScroll; }
    applySearch(view);
    // Keep the selected record visible inside the list, without moving the page.
    const list = document.querySelector('.records');
    const cur = list?.querySelector('.record[aria-current="true"]');
    if (list && cur && list.scrollHeight > list.clientHeight) {
      const lr = list.getBoundingClientRect();
      const ir = cur.getBoundingClientRect();
      if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top;
      else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom;
    }
  }
  // On a narrow screen the step tabs scroll sideways: keep the current one in view.
  const tabs = document.querySelector('.tabs');
  const cur = tabs?.querySelector('a[aria-current="page"]');
  if (tabs && cur && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, cur.offsetLeft - tabs.offsetLeft - 16);
  if (afterRender) { const fn = afterRender; afterRender = null; fn(); }
  if (prevFocus && !app.contains(document.activeElement)) {
    const target = document.querySelector(prevFocus) ?? (byKeyboard && wide ? document.getElementById('detail-title') : null);
    target?.focus({ preventScroll: true });
  }
  if (pendingFocus) {
    const id = pendingFocus;
    pendingFocus = null;
    const target = document.querySelector(`[data-employee="${CSS.escape(id)}"]`);
    if (target) {
      target.classList.add('spotlight');
      target.scrollIntoView({ block: 'start' });
    }
  }
}

// On a phone, tables marked "stacked" show each row as a small card: every cell is labelled with its column.
function labelStackedTables() {
  for (const t of app.querySelectorAll('table.stacked')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of t.tBodies[0]?.rows ?? []) [...tr.cells].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; });
  }
}

// A bug must never leave a blank or stale screen: say so and offer a clean start.
function crashed(err) {
  console.error(err);
  lastView = null;
  app.innerHTML = `<main class="main" id="main" tabindex="-1"><div class="page"><div class="empty crash" role="alert"><strong>This screen could not be shown.</strong>
    <span>${esc(err?.message ?? String(err))}</span>
    <span>Your saved demo may be from an older version. Starting again clears it.</span>
    <div class="row"><button class="btn primary" type="button" data-action="hard-reset">Start the demo again</button><a class="btn" href="#">Go to the first screen</a></div></div>${footnote()}</div></main>`;
}

function applySearch(view) {
  const q = (state.query[view] ?? '').trim().toLowerCase();
  const items = [...document.querySelectorAll('.records li[data-text]')];
  let shown = 0;
  for (const li of items) {
    const hit = !q || li.dataset.text.includes(q);
    li.hidden = !hit;
    if (hit) shown += 1;
  }
  for (const g of document.querySelectorAll('.records > .rec-group')) g.hidden = !g.querySelector('li[data-text]:not([hidden])');
  const empty = document.getElementById('queue-empty');
  if (empty) {
    empty.hidden = shown > 0;
    const p = empty.querySelector('p');
    p.textContent = items.length && !shown ? `No records match "${q}".` : p.dataset.empty;
  }
  const list = document.querySelector('.records');
  if (list) list.hidden = shown === 0;
}

// The scenarios check the six small test files exactly as shipped: no uploads, no added addresses.
function scenarios() {
  scenarioResults ??= runScenarios(fromFiles(files, [], null));
  return scenarioResults;
}

// Screens about the business show its status line; the ML Lab, data and scenarios are not about its progress.
const COMPANY_VIEWS = new Set(['move', 'review', 'expert', 'golive', 'analysis']);
const GLOBAL_VIEWS = new Set(['lab', 'data', 'scenarios']);


function appbar(view, s) {
  const co = s.a.company;
  const role = roleOf();
  // A step shows a tick once nothing is left in it, so the customer's tabs double as a progress tracker.
  const moved = Boolean(s.d.autoRun || s.d.live);
  const finished = { move: moved, review: moved && s.awaiting === 0 && s.info === 0 && s.accounts === 0, golive: Boolean(s.d.reconciled), expert: s.expert - s.info === 0 };
  const steps = state.role === 'owner';
  const tab = ([id, text], i) => {
    const n = s.status === 'Not started' && steps ? 0 : id === 'review' ? s.awaiting + s.info + s.accounts : id === 'expert' ? s.expert - s.info : 0;
    const done = steps && finished[id];
    const mark = steps ? `<span class="step">${done ? `${icon('tick')}<span class="sr-only">Done:</span>` : i + 1}</span>` : '';
    return `<a href="#${id}"${view === id ? ' aria-current="page"' : ''}${done ? ' class="done"' : ''}>${mark}${text}${n ? `<span class="count" aria-label="${n} open">${n}</span>` : ''}${id === 'scenarios' ? `<span class="count ok">${scenarioCount()}</span>` : ''}</a>`;
  };
  // One business per migration: its name is shown, never picked.
  const company = `<span class="company-box static">${icon('building')}<span class="co-name">${esc(co.name)}</span><span class="plan">${esc(co.plan)}</span></span>`;
  // The account menu holds what is not part of the work: resetting the demo and signing out.
  const user = `<details class="user-menu"><summary class="user-chip" aria-label="Account: ${esc(role.label)}"><span class="avatar role-ic">${icon(role.icon)}</span><span class="user-text"><strong>${esc(role.label)}</strong><small>${esc(role.side)}</small></span>${icon('chevron', 'um-chev')}</summary>
      <div class="um-menu">
        <p class="um-who"><strong>${esc(role.label)}</strong><span>Demo account, no password</span></p>
        <button class="um-item reset${resetArmed ? ' armed' : ''}" type="button" data-action="reset">${icon('reset')}<span>${resetArmed ? 'Click again to reset' : 'Reset the demo'}</span></button>
        <button class="um-item" type="button" data-action="sign-out">${icon('out')}<span>Sign out</span></button>
      </div>
    </details>`;
  const total = s.cases.length;
  const lines = s.cases.filter((c) => c.stage === 'awaiting_employer').length;
  const gaps = s.awaiting - lines;
  const action = lines + gaps + s.expert;
  const expertOnly = s.expert - s.info;
  // Everything the employer still has to give or confirm, counted the same way as the To do tab and the summary.
  const employer = lines + gaps + s.info + s.accounts;
  const items = total + s.a.gaps.length; // Desktop lines plus expected taxes nobody withheld
  const statusTone = { 'Not started': 'info', 'In review': 'accent', Live: 'good', Reconciled: 'good' }[s.status];
  const status = COMPANY_VIEWS.has(view) ? `<div class="batchbar">
      <span class="status ${statusTone}"><span class="dot"></span>${esc(s.status)}</span>
      <span class="batch-progress"><span class="progress" role="img" aria-label="${items - action} of ${items} items settled"><span style="width:${(items ? ((items - action) / items) * 100 : 0).toFixed(1)}%"></span></span><span><b>${items - action}</b> of ${items} settled</span></span>
      ${s.status === 'Not started' ? '' : action || employer ? `${employer ? `<span class="batch-need warn"><b>${employer}</b> ${state.role === 'owner' ? 'need you' : 'with the employer'}</span>` : ''}${expertOnly ? `<span class="batch-need blue"><b>${expertOnly}</b> with an expert</span>` : ''}` : `<span class="batch-need done">${icon('tick')}Nothing waiting</span>`}
      ${s.d.autoRun ? `<span class="batch-auto">${icon('spark')}<b>${pct(automationStats(s.a, s.d).share, 0)}</b> automated</span>` : ''}
    </div>` : '';
  return `<header class="appbar">
    <div class="topbar">
      <a class="logo" href="#${role.tabs[0][0]}"><span class="logo-tile">${icon('landmark')}</span><span class="logo-text"><strong>Local Tax Migration</strong><small>Desktop to Online payroll, demo</small></span></a>
      <nav class="tabs${role.tabs.length > 4 ? ' many' : ''}" aria-label="${esc(role.label)} screens">${role.tabs.map(tab).join('')}</nav>
      <div class="top-tools">
        ${company}
        ${user}
      </div>
    </div>
    ${status}
  </header>`;
}

// ---------- sign in (demo accounts, no passwords) ----------

// The product tour: a short film on the front page, what the product does and then a walkthrough of the
// real screens. It plays in a dialog that lives outside the app's markup, so a re-render never stops it.
const TOUR = { video: './media/tour.mp4', poster: './media/tour-poster.jpg', thumb: './media/tour-thumb.jpg', length: '0:57' };
let tourDialog = null;
function openTour(from) {
  if (!tourDialog) {
    tourDialog = document.createElement('dialog');
    tourDialog.className = 'tour-dialog';
    tourDialog.setAttribute('aria-labelledby', 'tour-h');
    tourDialog.innerHTML = `<div class="tour-box">
      <header class="tour-head"><h2 id="tour-h">Product tour</h2><span>${TOUR.length}</span><button type="button" class="tour-close" aria-label="Close the tour">${icon('close')}</button></header>
      <video class="tour-video" controls playsinline preload="none" poster="${TOUR.poster}"><source src="${TOUR.video}" type="video/mp4"><p>This browser cannot play the video.</p></video>
    </div>`;
    document.body.append(tourDialog);
    const video = tourDialog.querySelector('video');
    tourDialog.querySelector('.tour-close').addEventListener('click', () => tourDialog.close());
    // A click on the dark area around the player closes it.
    tourDialog.addEventListener('click', (e) => { if (e.target === tourDialog) tourDialog.close(); });
    tourDialog.addEventListener('close', () => { video.pause(); tourDialog.opener?.focus({ preventScroll: true }); });
  }
  tourDialog.opener = from ?? null;
  tourDialog.showModal();
  const video = tourDialog.querySelector('video');
  video.play().catch(() => { /* the person presses play */ });
  video.focus({ preventScroll: true });
}

// The front page: what the product does for a business, the film, and the demo accounts. The figures are
// the demo business's, worked out by the same engine and rules, so the page cannot promise more than it does.
function signIn() {
  const co = companyById();
  const account = (id, lead = false) => {
    const r = ROLES[id];
    return `<div class="acct${lead ? ' lead' : ''}"><span class="acct-ic">${icon(r.icon)}</span><div class="acct-text"><span class="acct-side">${esc(r.side)}</span><strong>${esc(r.label)}</strong><span>${esc(r.blurb)}</span>${lead ? `<span class="acct-biz">${icon('building')}${esc(co.name)}, ${plural(co.employees.length, 'employee')}</span>` : ''}</div><button class="btn${lead ? ' primary' : ''}" type="button" data-action="sign-in" data-role="${id}">Sign in${lead ? icon('arrow') : ''}</button></div>`;
  };
  // What the product does, in three lines. No figures here: the demo business's numbers belong inside the demo.
  const point = (ic, k, v) => `<li><span class="hp-ic">${icon(ic)}</span><span><strong>${k}</strong>${v}</span></li>`;
  return `<main class="signin" id="main" tabindex="-1">
    <section class="hero" aria-labelledby="hero-h">
      <div class="hero-in">
        <div class="hero-copy">
          <span class="brandmark"><span class="logo-tile">${icon('landmark')}</span>Local Tax Migration</span>
          <h1 id="hero-h">Move your local taxes with confidence.</h1>
          <p class="hero-sub">From Desktop to Online payroll, with every city and school-district tax checked line by line.</p>
          <div class="hero-cta">
            <button class="btn primary lg" type="button" data-action="sign-in" data-role="owner">Try it as a business${icon('arrow')}</button>
            <button class="btn ghost lg" type="button" data-action="tour">${icon('play')}Watch the tour<span class="len">${TOUR.length}</span></button>
          </div>
          <ul class="hero-points">
            ${point('pin', 'Checked by address', 'Each employee’s home and work address set the taxes they owe.')}
            ${point('spark', 'Settled by your rules', 'Approve the rules once. People see only the exceptions.')}
            ${point('list', 'Traced to the dollar', 'Year-to-date withholding is tied out before go-live.')}
          </ul>
        </div>
        <button class="tour" type="button" data-action="tour" aria-label="Watch the product tour (${TOUR.length})">
          <span class="tour-chrome" aria-hidden="true"><i></i><i></i><i></i></span>
          <img src="${TOUR.thumb}" alt="" width="960" height="540" decoding="async">
          <span class="tour-play" aria-hidden="true">${icon('play')}</span>
          <span class="tour-label"><b>Watch the product tour</b><span>${TOUR.length} · what it does for your business</span></span>
        </button>
      </div>
    </section>
    <section class="signin-panel" aria-labelledby="signin-h">
      <div class="signin-head"><h2 id="signin-h">Open the demo</h2><p>Pick a role. Demo accounts, no passwords.</p></div>
      <div class="acct-grid">${account('owner', true)}${account('expert')}${account('admin')}</div>
    </section>
    ${footnote()}
  </main>`;
}

function scenarioCount() {
  const r = scenarios();
  return `${r.filter((x) => x.pass).length}/${r.length}`;
}

function footnote() {
  return `<p class="footnote">Academic prototype for the BDA group exam, Case 19. Copying to Online payroll is simulated; the local tax checks are real. The business, its people and wages are fictional; Ohio tax rates are real (2026). Not affiliated with Intuit.</p>`;
}

// ---------- automation ----------

const policyOf = (d) => ({ ...DEFAULT_POLICY, ...(d.policy ?? {}) });
const ruleLabel = (id) => AUTOMATION_RULES.find((r) => r.id === id)?.label ?? id;
const EXCEPTION_TEXT = { held: 'Held after an undo', rule_off: 'Its rule is switched off', account_missing: 'No account number' };
const exceptionText = (x) => EXCEPTION_TEXT[x.reason] ?? REASON_SHORT[x.reason] ?? x.reason;

// Run the employer's automation rules for one company and record every automatic step in the log.
function runAutomationFor(id, { explicit = false } = {}) {
  const a = analysisFor(id);
  const current = decisionsFor(id);
  if (explicit) delete current.liveHold;
  const res = automate(a, current, policyOf(current));
  res.decisions.autoRun = true;
  state.decisions[id] = res.decisions;
  const prev = state.companyId;
  state.companyId = id;
  for (const x of res.actions) log('Automation', x.action, x.target, [`Rule: ${ruleLabel(x.rule)}`, x.detail].filter(Boolean).join('. '));
  state.companyId = prev;
  return res;
}

// What automation would do now, without changing anything (for the preview before the first run).
function automationPreview(s) {
  const res = automate(s.a, s.d, policyOf(s.d));
  return { ...res, stats: automationStats(s.a, res.decisions) };
}


// ---------- 0 move to Online payroll ----------
// The way a customer starts: a short wizard (start, check, move) and a summary with an exception report.
// The copy of employees, pay items and year-to-date totals is simulated; the local tax checks and the
// employer's rules run for real on the demo data, through the same engine as every other screen.

const MOVE_STEPS = ['Start', 'Check', 'Move', 'Summary'];
const MOVE_TICK_MS = 420;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function moveStepper(at) {
  const item = (text, i) => {
    const cls = i < at ? 'done' : i === at ? 'now' : '';
    return `<li${cls ? ` class="${cls}"` : ''}${i === at ? ' aria-current="step"' : ''}><span class="wz-n">${i < at ? `${icon('tick')}<span class="sr-only">Done:</span>` : i + 1}</span><span class="wz-t">${text}</span></li>`;
  };
  return `<ol class="wizard" aria-label="Steps of the move">${MOVE_STEPS.map(item).join('')}</ol>`;
}

function moveFacts(s) {
  const a = s.a;
  const co = a.company;
  return {
    employees: co.employees.length,
    items: co.items.length,
    lines: a.cases.length,
    custom: a.cases.filter((c) => c.item.origin === 'custom').length,
    expected: a.employees.reduce((n, e) => n + e.expected.list.length, 0),
    names: co.employees.map((e) => e.name),
    desktop: desktopMonths(co),
    first: MONTH_NAMES[co.migration_month - 1],
  };
}

function viewMove(s) {
  const id = state.companyId;
  if (moving?.companyId === id) return moveProgress(s);
  if (s.d.autoRun || s.d.live) return moveSummary(s);
  return state.moveStep[id] === 'check' ? moveCheck(s) : moveStart(s);
}

function moveStart(s) {
  const f = moveFacts(s);
  const co = s.a.company;
  const ytd = f.desktop.length ? `${monthSpan(f.desktop)}, from Desktop` : 'None: the move is in January';
  return `${moveStepper(0)}
    <section class="move-hero" aria-labelledby="move-h">
      <div class="move-copy">
        <h1 id="move-h" class="move-h" tabindex="-1">Move ${co.name.length <= 24 ? `<span class="nowrap">${esc(co.name)}</span>` : esc(co.name)} <span class="soft">to Online payroll</span></h1>
        <p class="lede">Employees, pay items and totals copy across. Local taxes are checked line by line first.</p>
        <div class="move-facts">
          <span class="with-stack">${avatarStack(f.names, 3)}${plural(f.employees, 'employee')}</span>
          <span>${icon('calendar')}First Online payroll in ${esc(f.first)}</span>
          <span>${icon('layers')}${esc(co.plan)} plan</span>
        </div>
        <div class="row move-cta"><button class="btn primary lg" type="button" data-action="move-next">Get started${icon('arrow')}</button></div>
      </div>
      <div class="move-side">
        <h2 id="what-h">What moves</h2>
        <ul class="moves" aria-labelledby="what-h">
          <li><span class="mv-ic">${icon('users')}</span><div><strong>Employees and addresses</strong><span>${plural(f.employees, 'employee')}</span></div><span class="mv-how">Copied</span></li>
          <li><span class="mv-ic">${icon('layers')}</span><div><strong>Pay items and deductions</strong><span>${plural(f.items, 'Desktop item')}</span></div><span class="mv-how">Copied</span></li>
          <li><span class="mv-ic">${icon('calendar')}</span><div><strong>Year-to-date totals</strong><span>${esc(ytd)}</span></div><span class="mv-how">Copied</span></li>
          <li class="key"><span class="mv-ic">${icon('pin')}</span><div><strong>Local taxes</strong><span>${plural(f.lines, 'Desktop line')}</span></div><span class="mv-how">Checked</span></li>
        </ul>
      </div>
    </section>`;
}

function moveCheck(s) {
  const prev = automationPreview(s);
  const st = prev.stats;
  const left = prev.exceptions;
  const expert = left.filter((x) => x.owner === 'expert').length;
  const employer = left.length - expert;
  const policy = policyOf(s.d);
  const share = pct(st.share, 0);
  const chips = [
    `<span class="chip good"><b>${st.auto}</b> settled by rule</span>`,
    expert ? `<span class="chip blue"><b>${expert}</b> for an expert</span>` : '',
    employer ? `<span class="chip warn"><b>${employer}</b> for the employer</span>` : '',
  ].join('');
  const leftList = left.length
    ? `<ul class="exc-list compact">${left.map((x) => `<li>${x.employee ? avatar(x.employee) : `<span class="avatar">${icon('landmark')}</span>`}<span class="who"><strong>${esc(x.employee ?? x.item)}</strong>${x.employee ? `<span>"${esc(labelOf(x.item))}"</span>` : '<span>Agency account</span>'}</span><span class="exc-tags">${badge(exceptionText(x), x.owner === 'expert' ? 'blue' : 'warn')}<span class="owner ${x.owner === 'expert' ? 'blue' : 'warn'}">${x.owner === 'expert' ? 'Expert' : 'Employer'}</span></span></li>`).join('')}</ul>`
    : `<p class="auto-done flat">${icon('check')}Nothing is left for a person. The company can go live by itself.</p>`;
  const rules = AUTOMATION_RULES.map((r) => `<label class="rule"><input type="checkbox" data-action="auto-rule" data-rule="${r.id}"${policy[r.id] ? ' checked' : ''}><span><strong>${esc(r.label)}</strong><span>${esc(r.help)}</span></span></label>`).join('');
  const issues = s.a.dataIssues;
  return `${moveStepper(1)}
    <div class="page-head"><h1 id="move-h" class="move-h" tabindex="-1">Check before you move</h1>
      <p class="lede">What your rules will settle, and what stays for a person.</p></div>
    <div class="check-grid">
      <section class="panel check-result" aria-labelledby="res-h">
        <h2 id="res-h">Local taxes after the move</h2>
        <div class="auto-score flat">
          <span class="ring" role="img" aria-label="${share} can be settled by rule" style="--p:${(st.share * 100).toFixed(1)}"><span>${share}</span></span>
          <div><p class="auto-line"><b>${st.auto}</b> of ${plural(st.total, 'item')} can be settled by rule</p></div>
        </div>
        <div class="chips">${chips}</div>
        <div class="check-left"><span class="label">${left.length ? `Will stay for a person (${left.length})` : 'Will stay for a person'}</span>${leftList}</div>
      </section>
      <section class="panel check-rules" aria-labelledby="rules-h">
        <div class="section-head"><h2 id="rules-h">Rules you approve</h2><p>Switch one off to decide those lines yourself.</p></div>
        <div class="rules-list">${rules}</div>
      </section>
    </div>
    ${issues.length ? `<section class="panel section" aria-labelledby="dq-h"><h2 id="dq-h">Problems found in the Desktop file</h2><p class="small muted">These were cleaned up so the check could run. Fix them in the file as well.</p><ul class="marks">${issues.map((i) => `<li>${mark('warn')}<span>${esc(i.text)}</span></li>`).join('')}</ul></section>` : ''}
    <div class="move-actions">
      <button class="btn" type="button" data-action="move-back">${icon('back')}Back</button>
      <p class="small muted">Nothing switches on until a rule or a person confirms it.</p>
      <button class="btn primary lg" type="button" data-action="move-run">Move to Online payroll${icon('arrow')}</button>
    </div>`;
}

function moveTasks(s) {
  const f = moveFacts(s);
  const st = automationStats(s.a, s.d);
  return [
    ['Copy employees and addresses', plural(f.employees, 'employee')],
    ['Copy pay items and year-to-date totals', f.desktop.length ? `${plural(f.items, 'item')}, ${monthSpan(f.desktop)}` : `${plural(f.items, 'item')}, no Desktop months`],
    ['List each employee\'s expected taxes', plural(f.expected, 'expected tax', 'expected taxes')],
    ['Group custom labels', plural(f.custom, 'custom line')],
    ['Route every line', `${s.routes.local_tax} local tax, ${s.routes.not_a_tax} not a tax, ${s.routes.not_in_database} to an expert`],
    ['Apply your rules', `${st.auto} of ${st.total} settled`],
  ];
}

function moveProgress(s) {
  const tasks = moveTasks(s);
  const step = moving.step;
  const rows = tasks.map(([text, result], i) => {
    const cls = i < step ? 'done' : i === step ? 'now' : '';
    const mk = i < step ? `<span class="mv-mark done">${icon('tick')}</span>` : i === step ? '<span class="mv-mark now"><span class="spin"></span></span>' : '<span class="mv-mark"></span>';
    return `<li${cls ? ` class="${cls}"` : ''}>${mk}<span class="mv-t">${esc(text)}</span><span class="mv-r">${i < step ? esc(result) : ''}</span></li>`;
  }).join('');
  return `${moveStepper(2)}
    <section class="panel moving" aria-labelledby="moving-h">
      <h1 id="moving-h">Moving ${esc(s.a.company.name)}</h1>
      <div class="progress wide" role="progressbar" aria-label="Move progress" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${step}"><span style="width:${((step / tasks.length) * 100).toFixed(1)}%"></span></div>
      <ol class="mv-steps">${rows}</ol>
    </section>`;
}

// Play the short sequence, then show the summary. People who prefer less motion go straight there.
function startMoving(cid) {
  if (moving) clearTimeout(moving.timer);
  moving = null;
  const settle = () => { document.getElementById('welcome-h')?.focus({ preventScroll: true }); };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { afterRender = () => { window.scrollTo(0, 0); settle(); }; return; }
  moving = { companyId: cid, step: 0, timer: null };
  const total = moveTasks(summary(cid)).length;
  const tick = () => {
    if (!moving) return;
    if (currentView() !== 'move' || state.companyId !== moving.companyId) { moving = null; return; }
    moving.step += 1;
    if (moving.step > total) {
      moving = null;
      render();
      settle();
      return;
    }
    render();
    moving.timer = setTimeout(tick, moving.step === total ? 520 : MOVE_TICK_MS);
  };
  moving.timer = setTimeout(tick, MOVE_TICK_MS);
  afterRender = () => window.scrollTo(0, 0);
}

// "7 items and 1 agency account need": an account number is not one of the tax items, so it is counted apart.
function needText(left) {
  const accounts = left.filter((x) => x.kind === 'account').length;
  const items = left.length - accounts;
  return `${listAnd([items ? plural(items, 'item') : '', accounts ? plural(accounts, 'agency account') : ''].filter(Boolean))} ${left.length === 1 ? 'needs' : 'need'}`;
}

function moveSummary(s) {
  const a = s.a;
  const d = s.d;
  const f = moveFacts(s);
  const st = automationStats(a, d);
  const left = openExceptions(a, d);
  const expert = left.filter((x) => x.owner === 'expert');
  const employer = left.filter((x) => x.owner !== 'expert');
  const share = pct(st.share, 0);
  const policy = policyOf(d);
  const headline = d.live
    ? `Every local tax is settled${d.reconciled ? ', live and reconciled' : ' and live'}.`
    : left.length
      ? `${st.auto} of ${plural(st.total, 'local tax item')} settled by rule. ${needText(left)} a person before the first Online payroll in ${f.first}.`
      : 'Every local tax item is settled. The go-live checks are next.';
  const waitTone = expert.length && !employer.length ? 'blue' : left.length ? 'warn' : 'good';
  const waitSub = left.length ? [expert.length ? `${expert.length} with an expert` : '', employer.length ? `${employer.length} with the employer` : ''].filter(Boolean).join(', ') : 'Nothing waiting';
  // A customer cannot open the expert queue: their row says who has it instead.
  const open = (x) => (x.kind === 'account' ? `<button class="btn" type="button" data-action="focus-missing" data-agency="${esc(x.item)}">Add account</button>`
    : x.needs === 'address' ? `<button class="btn" type="button" data-action="focus-missing" data-employee="${esc(x.employee_id)}">Add address</button>`
    : x.needs === 'work_location' ? `<button class="btn" type="button" data-action="focus-missing" data-employee="${esc(x.employee_id)}">Answer</button>`
      : x.owner === 'expert' && !canOpen('expert') ? ''
        : `<button class="btn" type="button" data-action="goto" data-view="${x.owner === 'expert' ? 'expert' : 'review'}" data-key="${esc(x.kind === 'gap' ? `g|${x.gap_id}` : `c|${x.case_id}`)}">Open</button>`);
  const waitHref = employer.length ? '#review' : expert.length && canOpen('expert') ? '#expert' : null;
  const rules = AUTOMATION_RULES.map((r) => `<label class="rule"><input type="checkbox" data-action="auto-rule" data-rule="${r.id}"${policy[r.id] ? ' checked' : ''}${d.live ? ' disabled' : ''}><span><strong>${esc(r.label)}</strong><span>${esc(r.help)}</span></span></label>`).join('');
  const report = left.length
    ? `<ul class="exc-list">${left.map((x) => `<li>${x.employee ? avatar(x.employee) : `<span class="avatar">${icon('landmark')}</span>`}<span class="who"><strong>${esc(x.employee ?? x.item)}</strong>${x.employee ? `<span>"${esc(labelOf(x.item))}"</span>` : '<span>Agency account</span>'}</span><span class="exc-tags">${badge(exceptionText(x), x.owner === 'expert' ? 'blue' : 'warn')}<span class="owner ${x.owner === 'expert' ? 'blue' : 'warn'}">${x.owner === 'expert' ? 'Expert' : 'Employer'}</span></span>${open(x)}</li>`).join('')}</ul>`
    : `<p class="auto-done flat">${icon('check')}No exceptions. Nothing needs a person.</p>`;
  const accounts = employer.filter((x) => x.kind === 'account').length;
  const people = (need) => new Set(employer.filter((x) => x.needs === need).map((x) => x.employee_id)).size;
  const addresses = people('address');
  const workplaces = people('work_location');
  const decides = employer.filter((x) => x.kind !== 'account' && !x.needs).length;
  const employerText = listAnd([
    addresses ? `adds ${plural(addresses, 'home address', 'home addresses')}` : '',
    workplaces ? `says where ${plural(workplaces, 'person works', 'people work')}` : '',
    accounts ? `adds ${plural(accounts, 'agency account number')}` : '',
    decides ? `decides ${plural(decides, 'item')}` : '',
  ].filter(Boolean));
  const next = [
    { done: !expert.length, text: expert.length ? `An expert decides ${plural(expert.length, 'line')}` : 'No line needs an expert' },
    { done: !employer.length, text: employer.length ? `The employer ${employerText}` : 'Nothing waits for the employer' },
    { done: Boolean(d.live), text: `The go-live checks pass and confirmed taxes switch on${policy.go_live ? ', by rule once nothing is waiting' : ''}` },
    { done: Boolean(d.reconciled), text: `First Online payroll in ${f.first}, then reconcile after it and after the first quarter` },
  ];
  return `${moveStepper(3)}
    <section class="welcome" aria-labelledby="welcome-h">
      <div class="wl-main">
        <span class="wl-ic">${icon('cloud')}</span>
        <div><h1 id="welcome-h" class="move-h" tabindex="-1">${esc(a.company.name)} <span class="soft">is ${d.live ? 'live ' : ''}in Online payroll</span></h1><p>${esc(headline)}</p></div>
      </div>
      <span class="ring on-brand" role="img" aria-label="${share} settled automatically" style="--p:${(st.share * 100).toFixed(1)}"><span>${share}</span></span>
    </section>
    <div class="wl-tiles">
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('monitor')}Copied from Desktop</span></div><span class="n">${f.employees}${avatarStack(f.names, 3)}</span><p>${f.employees === 1 ? 'employee' : 'employees'}, ${plural(f.lines, 'local tax line')}${f.desktop.length ? `, ${monthSpan(f.desktop)} totals` : ''}</p></div>
      <div class="wl-tile good"><div class="tile-head"><span class="t">${icon('spark')}Settled by rule</span></div><span class="n">${bigOf(st.auto, st.total)}</span><p>items${st.manual ? `; ${st.manual} more by a person` : ''}</p></div>
      <div class="wl-tile ${waitTone}"><div class="tile-head"><span class="t">${icon(left.length ? 'user' : 'check')}Waiting for a person</span>${waitHref ? arrowLink(waitHref, 'Open what is waiting') : ''}</div><span class="n">${left.length}</span><p>${esc(waitSub)}</p></div>
    </div>
    <div class="wl-grid">
      <section class="card" aria-labelledby="exc-h">
        <div class="card-head"><div><h2 id="exc-h">Left for a person</h2></div></div>
        <div class="card-body">${report}</div>
      </section>
      <section class="card" aria-labelledby="next-h">
        <div class="card-head"><div><h2 id="next-h">What happens next</h2></div>${arrowLink('#golive', 'Open the go-live checks')}</div>
        <div class="card-body"><ol class="next-steps">${next.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="mv-mark${x.done ? ' done' : ''}">${x.done ? `${icon('tick')}<span class="sr-only">Done:</span>` : ''}</span><span>${esc(x.text)}</span></li>`).join('')}</ol></div>
        ${fold('list', `Your rules (${AUTOMATION_RULES.filter((r) => policy[r.id]).length} of ${AUTOMATION_RULES.length} on)`, `<div class="rules-list">${rules}</div>`)}
      </section>
    </div>`;
}

const count = new Intl.NumberFormat('en-US');
const num = (n) => count.format(n);

// ---------- ML Lab (admin): proof that the label clustering works, on far more labels ----------
// It runs the engine's own clustering code on a labelled set (web/mllab.mjs), holds part back, and grades
// every suggestion against the known answer. Every number on this screen is computed when it runs.

const LAB_SIZES = [[600, '600 labels'], [1200, '1,200 labels'], [2400, '2,400 labels (a few seconds)']];
const mapGroup = (key) => (key === 'school_district' ? 1 : key === 'municipal' ? 2 : key === 'ambiguous' ? 0 : 3);
const MAP_GROUPS = [[1, 'School district'], [2, 'City tax'], [3, 'Not a tax (5 kinds)'], [0, 'Ambiguous']];
const keyName = (k) => KEY_NAMES[k] ?? k;

function scheduleLab() {
  lab.running = true;
  lab.error = null;
  setTimeout(() => {
    try { lab.result = runLab(files.catalog, { seed: lab.seed, total: lab.total }); } catch (err) { lab.error = err.message; }
    lab.running = false;
    if (state.role && currentView() === 'lab') render();
  }, 60);
}

// Silhouette for every k tried, with the BRD gate. One series, so no legend: the title names it.
function silhouetteChart(r, floor) {
  const W = 520; const H = 230; const L = 38; const R = 18; const T = 18; const B = 32;
  const ks = r.curve.map((p) => p.k);
  const vals = r.curve.map((p) => p.silhouette);
  const k0 = ks[0]; const k1 = ks.at(-1);
  const yMax = Math.max(0.6, Math.ceil((Math.max(...vals) + 0.05) * 10) / 10);
  const yMin = Math.min(0, Math.floor(Math.min(...vals) * 10) / 10);
  const x = (k) => L + ((k - k0) / Math.max(1, k1 - k0)) * (W - L - R);
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const grid = [];
  for (let v = yMin; v <= yMax + 1e-9; v += 0.1) grid.push(Number(v.toFixed(1)));
  const xt = [k0, ...[5, 10, 15, 20, 25, 30, 40].filter((k) => k > k0 + 1 && k < k1 - 1), k1];
  const path = r.curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.k).toFixed(1)} ${y(p.silhouette).toFixed(1)}`).join(' ');
  const gy = y(floor);
  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="Silhouette for k from ${k0} to ${k1}. Best ${r.silhouette.toFixed(3)} at k ${r.k}. Gate ${floor.toFixed(2)}.">
    ${grid.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
    ${xt.map((k) => `<text class="tick" x="${x(k)}" y="${H - B + 18}" text-anchor="middle">${k}</text>`).join('')}
    <text class="tick" x="${W - R}" y="${H - 2}" text-anchor="end">clusters (k)</text>
    <line class="gate" x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}"/><text class="gate-t" x="${L + 6}" y="${gy - 6}">Gate ${floor.toFixed(2)}</text>
    <path class="line" d="${path}"/>
    <circle class="pick" cx="${x(r.k)}" cy="${y(r.silhouette)}" r="5.5"/>
    <text class="pick-t" x="${x(r.k) > W - 90 ? x(r.k) + 6 : x(r.k)}" y="${y(r.silhouette) + (Math.abs(y(r.silhouette) - gy) < 26 && y(r.silhouette) >= gy ? 22 : -12)}" text-anchor="${x(r.k) > W - 90 ? 'end' : 'middle'}">k ${r.k}: ${r.silhouette.toFixed(3)}</text>
    ${r.curve.map((p) => `<circle class="hit" cx="${x(p.k)}" cy="${y(p.silhouette)}" r="9" data-tip="k ${p.k}: silhouette ${p.silhouette.toFixed(3)}"/>`).join('')}
  </svg>`;
}

// Every label as a point: kernel PCA of the cosine similarity the clustering uses.
function labMap(r) {
  const W = 520; const H = 360; const P = 14;
  const pts = [
    ...r.projection.train.map((p, i) => ({ p, key: r.trainTruth[i], label: r.trainLabels[i], test: false })),
    ...r.projection.extra.map((p, i) => ({ p, key: r.results[i].truth, label: r.results[i].label, test: true, res: r.results[i] })),
  ];
  const xs = pts.map((q) => q.p[0]);
  const ys = pts.map((q) => q.p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (v) => P + ((v - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const sy = (v) => P + (1 - (v - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const order = [...pts].sort((a, b) => (a.test - b.test) || (mapGroup(a.key) === 0 ? -1 : 0) - (mapGroup(b.key) === 0 ? -1 : 0));
  const tipOf = (q) => `"${q.label}": ${keyName(q.key)}. ${q.test ? `Held back; model: ${q.res.model === 'expert' ? 'to an expert' : keyName(q.res.model)}` : 'Used to fit'}`;
  const dots = order.map((q) => {
    const cx = sx(q.p[0]).toFixed(1);
    const cy = sy(q.p[1]).toFixed(1);
    const wrong = q.test && q.res.model !== 'expert' && q.res.model !== q.res.truth;
    const mark = wrong ? `<path class="pt-x" d="M${cx - 5} ${cy - 5}L${+cx + 5} ${+cy + 5}M${cx - 5} ${+cy + 5}L${+cx + 5} ${cy - 5}"/>` : '';
    return `<circle class="pt g${mapGroup(q.key)}${q.test ? ' hollow' : ''}" cx="${cx}" cy="${cy}" r="4" data-tip="${esc(tipOf(q))}"/>${mark}`;
  }).join('');
  return `<svg class="viz map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${pts.length} labels. Labels with similar words sit close together.">${dots}</svg>`;
}

function viewLab() {
  const head = `<div class="page-head"><h1>ML Lab</h1>
    <p class="lede">The label clustering, graded on labels it never saw.</p></div>`;
  const form = `<form class="lab-form panel" data-action="run-lab">
      <label class="field" for="lab-seed">Seed<input type="number" id="lab-seed" name="seed" min="1" max="99999" step="1" value="${lab.seed}"></label>
      <label class="field" for="lab-size">Labelled set<select id="lab-size" name="total">${LAB_SIZES.map(([n, t]) => `<option value="${n}"${n === lab.total ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <button class="btn primary" type="submit"${lab.running ? ' disabled' : ''}>${icon('spark')}${lab.running ? 'Running' : 'Run'}</button>
      <p class="small muted">Same seed, same labels, same result.</p>
    </form>`;
  if (lab.error) return `${head}${form}<div class="banner bad">${icon('alert', 'lg')}<div><strong>The lab stopped.</strong> ${esc(lab.error)}</div></div>`;
  if (!lab.result || lab.running) {
    if (!lab.running) scheduleLab();
    const fit = Math.round(lab.total * 0.8);
    return `${head}${form}<section class="panel warm" aria-live="polite"><div class="row"><span class="spin" aria-hidden="true"></span><div><h2>Running</h2><p class="small muted">Fitting clusters on ${num(fit)} labels, then scoring the ${num(lab.total - fit)} held back.</p></div></div></section>`;
  }
  const r = lab.result;
  const floor = DEFAULT_THRESHOLDS.silhouetteFloor;
  const target = DEFAULT_THRESHOLDS.precisionTarget;
  const gates = [
    ['Silhouette', `${r.silhouette.toFixed(3)} (at least ${floor.toFixed(2)})`, r.silhouette >= floor],
    ['Precision', `${pct(r.model.precision)} (at least ${pct(target, 0)})`, r.model.precision >= target],
    ['Sample', `${num(r.trainSize)} labels (at least ${DEFAULT_THRESHOLDS.minSample})`, r.trainSize >= DEFAULT_THRESHOLDS.minSample],
  ];
  const passes = gates.every((g) => g[2]);
  const right = r.model.suggested - r.model.wrong;
  const cmp = [
    ['Clustering model', 'Suggests only when the label sits well inside a named cluster', r.model, r.modelUnseen],
    ['Clustering, each cluster named once by an expert', `${r.clustersNamedByExpert} of ${r.k} clusters named; no label-by-label work`, r.named, r.namedUnseen],
    ['Word matching (baseline)', 'Same clean-up, then the catalogue entry with the most shared words', r.keyword, r.keywordUnseen],
  ];
  const cmpRows = cmp.map(([name, how, a, u]) => `<tr><td><strong>${esc(name)}</strong><div class="small muted">${esc(how)}</div></td><td class="num">${pct(a.coverage)}</td><td class="num"><b>${pct(a.precision)}</b></td><td class="num">${a.wrong}</td><td class="num">${pct(u.precision)}<div class="small muted">${u.wrong} wrong</div></td></tr>`).join('');
  const more1 = r.keyword.coverage > r.model.coverage ? 'more' : r.keyword.coverage < r.model.coverage ? 'fewer' : 'as many';
  const facts = [
    `Of ${num(r.testSize)} held-back labels, the model suggested an answer for ${num(r.model.suggested)} (${pct(r.model.coverage)}); ${num(right)} were right (${pct(r.model.precision)}). The other ${num(r.testSize - r.model.suggested)} went to an expert, as designed.`,
    `On the ${num(r.unseen)} labels it never saw while fitting: ${pct(r.modelUnseen.precision)} right with ${plural(r.modelUnseen.wrong, 'wrong answer')}; word matching ${pct(r.keywordUnseen.precision)} with ${plural(r.keywordUnseen.wrong, 'wrong answer')}.`,
    `Word matching made ${more1} suggestions (${pct(r.keyword.coverage)} against ${pct(r.model.coverage)}), ${r.keyword.precision >= r.model.precision ? 'at' : 'with lower'} precision (${pct(r.keyword.precision)}).`,
    `The silhouette, ${r.silhouette.toFixed(3)}, ${r.silhouette >= floor ? 'passes' : 'is below'} the ${floor.toFixed(2)} gate${r.silhouette >= floor ? '' : ': on a set this messy the state would stay in shadow mode, so suggestions are logged and people decide'}.`,
    `What clustering adds: ${num(r.distinctTrain)} different labels become ${r.k} groups an expert can check once, and every label gets a confidence that decides when to defer.`,
  ];
  const conf = `<table class="confusion"><thead><tr><th>Real answer</th>${r.cols.map((c) => `<th class="num">${esc(keyName(c))}</th>`).join('')}</tr></thead><tbody>${r.confusion.map((row) => {
    const n = row.cells.reduce((s, v) => s + v, 0) || 1;
    return `<tr><th>${esc(keyName(row.truth))}</th>${row.cells.map((v, j) => {
      const col = r.cols[j];
      const good = col === row.truth || (col === 'expert' && row.truth === 'ambiguous');
      const kind = good ? 'ok' : col === 'expert' ? 'defer' : v ? 'bad' : '';
      return `<td class="num ${kind}" style="--a:${(v / n).toFixed(3)}">${v || ''}${kind === 'bad' ? '<span class="sr-only"> wrong</span>' : ''}</td>`;
    }).join('')}</tr>`;
  }).join('')}</tbody></table>`;
  const clusters = [...r.clusters].sort((a, b) => b.size - a.size);
  const shownClusters = more.clusters ? clusters : clusters.slice(0, 10);
  const clusterRows = shownClusters.map((c) => `<tr><td><strong>${esc(c.key ? c.name : 'Unnamed')}</strong></td><td class="num">${c.size}</td><td class="num">${pct(c.purity, 0)}</td><td class="num">${c.meanSilhouette.toFixed(2)}</td><td>${esc(keyName(c.majority))}</td><td><div class="label-chips">${c.examples.slice(0, 5).map((l) => `<span class="label-chip">${esc(l)}</span>`).join('')}</div></td></tr>`).join('');
  const why = (x) => (x.modelGuess ? `confidence ${x.silhouette.toFixed(2)}${x.model === 'expert' ? `, below ${r.itemFloor.toFixed(2)}` : ''}` : 'its cluster matched no catalogue entry');
  const errRow = (x, guess) => `<li><span class="label-chip">${esc(labelOf(x.label))}</span><span class="small">Really ${esc(keyName(x.truth))}${guess ? `; model said ${esc(keyName(x.model))}` : ''}</span><span class="small muted">${esc(why(x))}</span></li>`;
  const legend = MAP_GROUPS.map(([g, t]) => `<li><span class="sw g${g}"></span>${esc(t)}</li>`).join('');
  return `${head}${form}
    <div class="wl-tiles four">
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('layers')}Labels</span></div><span class="n">${num(r.total)}</span><p>${num(r.trainSize)} to fit, ${num(r.testSize)} held back; ${num(r.unseen)} of those never seen</p></div>
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('grid')}Clusters</span></div><span class="n">${r.k}</span><p>from ${num(r.distinctTrain)} different labels; k picked by silhouette</p></div>
      <div class="wl-tile good"><div class="tile-head"><span class="t">${icon('target')}Precision</span></div><span class="n">${pct(r.model.precision)}</span><p>${num(right)} of ${num(r.model.suggested)} suggestions right</p></div>
      <div class="wl-tile blue"><div class="tile-head"><span class="t">${icon('user')}To an expert</span></div><span class="n">${pct(1 - r.model.coverage)}</span><p>${num(r.testSize - r.model.suggested)} held-back labels not confident enough</p></div>
    </div>
    <section class="panel lab-gates" aria-labelledby="lg-h">
      <h2 id="lg-h">The gates on this set</h2>
      <ul class="gate-chips">${gates.map(([g, v, ok]) => `<li class="${ok ? 'pass' : 'fail'}">${mark(ok ? 'pass' : 'fail')}<span><strong>${g}</strong>${esc(v)}</span></li>`).join('')}</ul>
      ${pill(passes ? 'Suggestions would be shown' : 'Shadow mode: logged, people decide', passes ? 'good' : 'warn')}
    </section>
    <div class="dash-grid even">
      <section class="card" aria-labelledby="sil-h">
        <div class="card-head"><div><h2 id="sil-h">Silhouette by number of clusters</h2><p class="card-sub">The best k is used.</p></div></div>
        <div class="viz-wrap">${silhouetteChart(r, floor)}</div>
      </section>
      <section class="card" aria-labelledby="map-h">
        <div class="card-head"><div><h2 id="map-h">Every label on a map</h2><p class="card-sub">Hover a point to read it.</p></div></div>
        <div class="viz-wrap">${labMap(r)}</div>
        <ul class="viz-legend">${legend}<li><span class="sw solid"></span>Used to fit</li><li><span class="sw ring"></span>Held back</li><li><span class="sw x" aria-hidden="true">×</span>Wrong suggestion</li></ul>
      </section>
    </div>
    <section class="card" aria-labelledby="cmp-h">
      <div class="card-head"><div><h2 id="cmp-h">Against simple word matching</h2><p class="card-sub">The same ${num(r.testSize)} held-back labels</p></div></div>
      <div class="table-wrap"><table class="cmp-table"><thead><tr><th>Method</th><th class="num">Suggested</th><th class="num">Right when it suggests</th><th class="num">Wrong</th><th class="num">Right on unseen labels</th></tr></thead><tbody>${cmpRows}</tbody></table></div>
      <div class="card-body"><ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
    </section>
    <section class="card" aria-labelledby="cm-h">
        <div class="card-head"><div><h2 id="cm-h">Confusion matrix</h2><p class="card-sub">Rows are the real answer, columns the model's. Green is right; red is wrong.</p></div></div>
        <div class="table-wrap">${conf}</div>
    </section>
    <section class="card" aria-labelledby="err-h">
        <div class="card-head"><div><h2 id="err-h">Where it went wrong</h2><p class="card-sub">Every wrong suggestion, and labels it sent to an expert</p></div></div>
        <div class="card-body">
          <h3 class="mini-h">Wrong (${r.model.wrong})</h3>
          ${r.misses.length ? `<ul class="err-list">${r.misses.map((x) => errRow(x, true)).join('')}</ul>` : '<p class="small muted">None.</p>'}
          <h3 class="mini-h">Sent to an expert, though it had a clear answer (first ${r.deferred.length})</h3>
          ${r.deferred.length ? `<ul class="err-list">${r.deferred.map((x) => errRow(x, false)).join('')}</ul>` : '<p class="small muted">None.</p>'}
        </div>
    </section>
    <section class="card" aria-labelledby="cl-h">
      <div class="card-head"><div><h2 id="cl-h">The ${r.k} clusters</h2><p class="card-sub">Purity: share of labels with the cluster's most common answer.</p></div></div>
      <div class="table-wrap"><table class="stacked"><thead><tr><th>Named</th><th class="num">Labels</th><th class="num">Purity</th><th class="num">Silhouette</th><th>Most are</th><th>Examples</th></tr></thead><tbody>${clusterRows}</tbody></table></div>
      ${clusters.length > 10 ? `<div class="card-foot"><button class="btn quiet" type="button" data-action="show-more" data-key="clusters">${more.clusters ? 'Show the 10 largest' : `Show all ${clusters.length}`}</button></div>` : ''}
    </section>
    <section class="card">${fold('steps', 'How the lab works', `<ol class="how-list">
      <li>Make ${num(r.total)} Desktop-style labels from real patterns: abbreviations, typos, place names, upper and lower case. Each has a known answer: school district, city tax, five kinds of deduction, or ambiguous (like "Local Tax").</li>
      <li>Hold back ${pct(r.testSize / r.total, 0)}. The model never sees those while it fits.</li>
      <li>Fit clusters on the rest with the engine's own code: words and letter triplets (TF-IDF), average linkage, k from 2 to ${r.maxK} picked by silhouette. No answers are used to fit.</li>
      <li>Score each held-back label as the engine scores a new business's label: nearest cluster, its name, and a confidence. Below ${r.itemFloor.toFixed(2)} it goes to an expert.</li>
      <li>Grade against the known answers, and against word matching. Code: <code class="code">web/mllab.mjs</code>; the numbers are checked in <code class="code">tests/scale.test.mjs</code>.</li>
    </ol><p class="small muted">Fitting took ${num(Math.round(r.fitMs))} ms and scoring ${num(Math.round(r.scoreMs))} ms in this browser.</p>`)}</section>`;
}

// ---------- 1 analysis ----------

function viewAnalysis(s) {
  const a = s.a;
  const used = [...statesInUse(a)];
  const byState = used.map((st) => `${stateName(st)}: ${plural(a.cases.filter((c) => c.state === st).length, 'line')}`).join('; ');
  const expectedCount = a.employees.reduce((n, e) => n + e.expected.list.length, 0);
  const missingAddr = a.employees.filter((e) => !e.expected.periods.length).length;
  const custom = a.cases.filter((c) => c.item.origin === 'custom').length;
  const modelLine = used.map((st) => `${a.models[st].name}: ${a.models[st].mode === 'assisted' ? 'suggestions on' : 'shadow mode'}`).join('; ');
  const confirmed = s.cases.filter((c) => !['awaiting_employer', 'with_expert'].includes(c.stage)).length;
  const items = a.company.items.map((i) => {
    const users = a.company.employees.filter((e) => e.items.includes(i.item_id)).length;
    return `<tr><td><strong>${esc(labelOf(i.label))}</strong></td><td>${i.law_id}</td><td>${i.origin === 'custom' ? '<span class="muted">Custom: names no tax</span>' : esc(a.idx.taxByLaw.get(i.law_id)?.name ?? 'Unknown Law ID')}</td><td>${esc(i.item_type)}, ${esc(i.tracking_type)}</td><td>${esc(rateText(i))}</td><td>${esc(i.agency)}</td><td class="num">${users}</td></tr>`;
  }).join('');
  const PEOPLE_SHOWN = 10;
  const people = a.employees.slice(0, more.people ? undefined : PEOPLE_SHOWN).map((e) => {
    const site = a.company.worksites.find((w) => w.site_id === e.site_id);
    const homes = e.expected.periods.length
      ? e.expected.periods.map((p) => { const ad = addressById(p.address_id); return `${esc([ad.line1, ad.city, ad.state].filter(Boolean).join(', '))} <span class="muted">(${monthSpan(p.months)})</span>`; }).join('<br>')
      : '<span class="bad-text">Missing in Desktop</span>';
    const expected = e.expected.list.length ? e.expected.list.map((x) => esc(taxShort(x.tax)) + (x.required ? '' : ' (optional)')).join('<br>') : '<span class="muted">None listed</span>';
    return `<tr data-employee="${esc(e.employee_id)}"><td><strong>${esc(e.name)}</strong>${employmentText(e) ? `<div class="small muted">${esc(employmentText(e))}</div>` : ''}</td><td>${homes}</td><td>${esc(site.name)}${e.remote ? '<div class="small muted">Works from home</div>' : ''}</td><td>${expected}</td></tr>`;
  }).join('');

  return `<div class="page-head"><h1>${esc(a.company.name)} <span class="soft">through the engine</span></h1>
    <p class="lede">${plural(a.employees.length, 'employee')}, ${plural(a.cases.length, 'Desktop line')}. ${esc(a.company.description ?? '')}</p></div>
    <section class="section" aria-labelledby="pipe-h">
      <div class="section-head"><h2 id="pipe-h">What each step found</h2></div>
      <ol class="pipeline">
        <li><strong>Find the state</strong><p>From the item's label, or else the employee's address.</p><span class="result">${esc(byState)}</span></li>
        <li><strong>List expected taxes</strong><p>Home and work addresses give a short list of taxes each person should have.</p><span class="result">${plural(expectedCount, 'expected tax', 'expected taxes')}${missingAddr ? `, ${plural(missingAddr, 'address', 'addresses')} missing` : ''}</span></li>
        <li><strong>Group custom labels</strong><p>Free-text labels are clustered within each state and named after the closest defined entry.</p><span class="result">${plural(custom, 'custom line')}. ${esc(modelLine)}</span></li>
        <li><strong>Route every line</strong><p>Local tax, not a tax, or an expert. Taxes nobody withheld are flagged too.</p><span class="result">${s.routes.local_tax} local tax, ${s.routes.not_a_tax} not a tax, ${s.routes.not_in_database} to an expert</span></li>
        <li><strong>Employer confirms</strong><p>By rules the employer approved once; people handle only the exceptions.</p><span class="result">${confirmed} of ${plural(s.cases.length, 'line')} decided</span></li>
      </ol>
    </section>
    <section class="routes" aria-label="Route counts">
      <div class="route-tile local"><span class="n">${s.routes.local_tax}</span><span class="t">Local tax</span><p>Matches a defined tax on the expected list.</p></div>
      <div class="route-tile nontax"><span class="n">${s.routes.not_a_tax}</span><span class="t">Not a tax</span><p>After-tax in Desktop, or a known non-tax item.</p></div>
      <div class="route-tile notdb"><span class="n">${s.routes.not_in_database}</span><span class="t">Needs an expert</span><p>The "not in database" route: no match, a weak signal, a conflict, or shadow mode.</p></div>
      <div class="route-tile gap"><span class="n">${a.gaps.length}</span><span class="t">Expected, not withheld</span><p>On the expected list, but no Desktop item covers it.</p></div>
    </section>
    ${a.dataIssues.length ? `<section class="section" aria-labelledby="dq-h">
      <div class="section-head"><h2 id="dq-h">Problems found in the Desktop file</h2><p>Cleaned up so the analysis could run.</p></div>
      <ul class="marks">${a.dataIssues.map((i) => `<li>${mark('warn')}<span>${esc(i.text)}</span></li>`).join('')}</ul>
    </section>` : ''}
    <section class="section" aria-labelledby="items-h">
      <div class="section-head"><h2 id="items-h">Desktop payroll items</h2><p>A Law ID names the tax. 177 or 0: created by the employer, so the address decides.</p></div>
      <div class="table-wrap"><table class="stacked"><thead><tr><th>Item label</th><th>Law ID</th><th>Tax by Law ID</th><th>Desktop setting</th><th>Rate</th><th>Agency on file</th><th class="num">Employees</th></tr></thead><tbody>${items}</tbody></table></div>
    </section>
    <section class="section" aria-labelledby="people-h">
      <div class="section-head"><h2 id="people-h">Employees and their expected taxes</h2></div>
      <div class="table-wrap"><table class="stacked"><thead><tr><th>Employee</th><th>Home address</th><th>Works at</th><th>Expected taxes</th></tr></thead><tbody>${people}</tbody></table></div>
      ${a.employees.length > PEOPLE_SHOWN ? `<div class="row"><button class="btn quiet" type="button" data-action="show-more" data-key="people">${more.people ? `Show the first ${PEOPLE_SHOWN}` : `Show all ${a.employees.length} employees`}</button></div>` : ''}
    </section>`;
}

function employmentText(e) {
  const parts = [];
  if ((e.hired_month ?? 1) > 1) parts.push(`Joined ${monthSpan([e.hired_month])}`);
  if ((e.left_month ?? 12) < 12) parts.push(`Left after ${monthSpan([e.left_month])}`);
  return parts.join(', ');
}



// ---------- 2 and 3: review workspaces (employer review and expert queue) ----------
// A list of records on the left (Desktop lines, plus expected taxes nobody withheld) and the selected
// record on the right: target, checks, Desktop-versus-Online mapping, evidence and a sticky action bar.

const OPEN_STAGES = new Set(['awaiting_employer', 'with_expert']);
const REASON_SHORT = {
  shadow: 'Shadow mode', weak_signal: 'Weak signal', conflict: 'Conflict', not_expected: 'Not expected', duplicate: 'Duplicate',
  state_conflict: 'Wrong state', no_address: 'No address', address_unresolved: 'Address not placed', work_location: 'Work location', ambiguous: 'Ambiguous', employer_sent: 'Sent by employer',
};
const REASON_TONE = {
  conflict: 'bad', duplicate: 'bad', state_conflict: 'bad', not_expected: 'bad',
  no_address: 'warn', address_unresolved: 'warn', work_location: 'warn', weak_signal: 'warn', ambiguous: 'warn', shadow: 'info', employer_sent: 'blue',
};
const FILTERS = {
  review: [['todo', 'Needs you'], ['verified', 'Ready to confirm'], ['expert', 'With expert', 'warn'], ['done', 'Done'], ['all', 'All']],
  expert: [['open', 'Open', 'warn'], ['address', 'Waiting for the employer'], ['decided', 'Decided'], ['all', 'All']],
};
// A line that needs a home address or a work location waits for the employer (on their To do), not for an expert.
const waitsForEmployer = (c) => c.stage === 'with_expert' && NEEDS_EMPLOYER.has(c.reason) && !c.decision.sentToExpert;
const waitText = (c) => (c.reason === 'work_location' ? 'Waiting for the work location' : 'Waiting for the home address');
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
const rateFmt = (r) => `${Number(r).toFixed(2)}%`;
const taxCode = (t) => (t.type === 'school_district' ? `SD ${t.code}` : t.place);
const deskRate = (item) => (item.calc.kind === 'percent' ? rateFmt(item.calc.rate) : rateText(item));
const shortTax = (t) => (t.type === 'school_district' ? `${t.place} schools` : `${t.place} city`);
const isOff = (c) => c.route === 'local_tax' && c.proposal.some((p) => p.rate.status === 'over' || p.rate.status === 'under');
const siteOf = (e, a) => a.company.worksites.find((w) => w.site_id === e.site_id);
const addrLine = (ad) => [ad.line1, ad.city, [ad.state, ad.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const fold = (ic, title, body, open = false) => `<details class="fold"${open ? ' open' : ''}><summary>${icon(ic)}${esc(title)}${icon('chevron', 'chev')}</summary><div class="fold-body">${body}</div></details>`;
const note = (tone, ic, text) => `<span class="note ${tone}">${icon(ic)}<span>${esc(text)}</span></span>`;
const place = (ic, cls, label, main, sub) => `<div class="place"><span class="pic ${cls}">${icon(ic)}</span><div><b>${esc(label)}</b><strong>${esc(main)}</strong><span>${esc(sub)}</span></div></div>`;

function homeText(e) {
  if (!e.expected.periods.length) return 'No home address';
  const cities = [...new Set(e.expected.periods.map((p) => addressById(p.address_id)?.city || 'Unknown'))];
  return `${cities.join(' to ')} home`;
}

function caseBadge(c) {
  if (c.stage === 'with_expert') return [REASON_SHORT[c.reason] ?? 'With an expert', REASON_TONE[c.reason] ?? 'warn'];
  if (c.stage === 'awaiting_employer') {
    if (c.decision.expert) return ['Expert decided', 'blue'];
    if (c.route === 'not_a_tax') return ['Not a tax', 'info'];
    if (c.route === 'local_tax') {
      if (c.verified) return ['Ready to confirm', 'good'];
      if (c.unowed?.amount) return ['Correction', 'warn'];
      if (isOff(c)) return ['Rate differs', 'warn'];
      if (c.flags.includes('label_place_mismatch')) return ['Check place', 'warn'];
      if (c.proposal.some((p) => p.optional)) return ['Optional', 'info'];
      return ['Suggested', 'accent'];
    }
    return ['To decide', 'info'];
  }
  const auto = c.decision.employer?.auto && (!c.decision.expert || c.decision.expert.auto);
  return (auto
    ? { confirmed: ['Auto: confirmed', 'done'], moved_to_deduction: ['Auto: deduction', 'done'], employer_managed: ['Auto: employer-managed', 'done'], stopped: ['Auto: stopped', 'done-bad'] }
    : { confirmed: ['Confirmed', 'done'], moved_to_deduction: ['Deduction', 'done'], employer_managed: ['Employer-managed', 'done'], stopped: ['Stopped', 'done-bad'] })[c.stage] ?? [c.stage, 'info'];
}

function caseFoot(c) {
  if (c.route === 'local_tax') return ['Proposed', c.proposal.map((p) => `${taxCode(p.tax)} ${rateFmt(p.tax.rate)}`).join(' then '), c.verified || c.stage === 'confirmed' ? 'good' : 'warn'];
  if (c.route === 'not_a_tax') return ['Proposed', 'Deduction', ''];
  if (c.route === 'custom_entry') return ['Outcome', c.entry.name, ''];
  if (c.route === 'stop') return ['Outcome', 'Stop withholding', 'bad'];
  return ['Reason', REASON_SHORT[c.reason] ?? c.reason, REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn'];
}

// Where a line is heading, in a few words, for the record list.
function caseTo(c) {
  if (c.route === 'local_tax') return [c.proposal.map((p) => `${shortTax(p.tax)} ${rateFmt(p.tax.rate)}`).join(', then '), c.verified || c.stage === 'confirmed' ? 'good' : 'warn'];
  if (c.route === 'not_a_tax') return ['Deduction', ''];
  if (c.route === 'custom_entry') return [c.entry.name, 'blue'];
  if (c.route === 'stop') return ['Stop withholding', 'bad'];
  if (waitsForEmployer(c)) return [waitText(c), 'muted'];
  return ['Expert decides', 'muted'];
}

const AGENCIES = '~agencies'; // the list group for agency accounts, after the people

function recordList(view, s) {
  const order = new Map(s.a.employees.map((e, i) => [e.employee_id, i]));
  const out = [];
  const cases = view === 'expert' ? s.cases.filter((c) => c.stage === 'with_expert' || c.decision.expert) : s.cases;
  for (const c of cases) {
    const e = c.employee;
    const [b, tone] = caseBadge(c);
    const groups = new Set(['all']);
    const needsAddress = waitsForEmployer(c);
    if (view === 'review') {
      if (c.stage === 'awaiting_employer' || needsAddress) groups.add('todo');
      if (c.stage === 'awaiting_employer' && c.verified) groups.add('verified');
      if (c.stage === 'with_expert' && !needsAddress) groups.add('expert');
      if (!OPEN_STAGES.has(c.stage)) groups.add('done');
    } else groups.add(needsAddress ? 'address' : c.stage === 'with_expert' ? 'open' : 'decided');
    const foot = caseFoot(c);
    const [to, toTone] = caseTo(c);
    out.push({
      key: `c|${c.case_id}`, kind: 'case', c, employee_id: c.employee_id, name: c.employee_name, badge: b, tone, groups, foot,
      from: labelOf(c.item.label), to, toTone,
      sub: `"${labelOf(c.item.label)}" · Law ID ${c.item.law_id}`,
      loc: `${homeText(e)} · ${siteOf(e, s.a).name}`,
      text: [c.employee_name, c.item.label, b, foot[1], ...c.proposal.map((p) => p.tax.name)].join(' ').toLowerCase(),
    });
  }
  if (view === 'review') {
    for (const g of s.a.gaps) {
      const stage = gapStage(g, s.d, s.cases);
      const e = s.a.employees.find((x) => x.employee_id === g.employee_id);
      const groups = new Set(['all', stage === 'awaiting_employer' ? 'todo' : 'done']);
      const [b, tone] = { awaiting_employer: ['Not withheld', 'bad'], added: [s.d.gaps[g.gap_id]?.auto ? 'Auto: added' : 'Added', 'done'], covered: ['Covered', 'done'] }[stage];
      out.push({
        key: `g|${g.gap_id}`, kind: 'gap', g, employee_id: g.employee_id, name: g.employee_name, badge: b, tone, groups,
        foot: ['Back tax', money(g.backTaxEstimate), stage === 'awaiting_employer' ? 'bad' : ''],
        from: 'Nothing in Desktop', to: `${shortTax(g.tax)} ${rateFmt(g.tax.rate)}`, toTone: stage === 'awaiting_employer' ? 'bad' : 'good',
        sub: `No Desktop item · ${taxShort(g.tax)}`,
        loc: `${homeText(e)} · ${siteOf(e, s.a).name}`,
        text: [g.employee_name, g.tax.name, b, 'not withheld gap'].join(' ').toLowerCase(),
      });
    }
    // An agency with no account number is one more thing only the employer can give: it is in the same list.
    if (!s.d.live) {
      for (const a of agencyAccounts(s.a, s.d).filter((x) => !x.complete)) {
        out.push({
          key: `a|${a.agency}`, kind: 'account', a, employee_id: AGENCIES, name: 'Agency accounts', badge: 'No account number', tone: 'warn', groups: new Set(['todo']),
          from: a.agency, to: 'Add the account number', toTone: 'muted',
          text: [a.agency, ...a.taxes, 'account number deposit frequency'].join(' ').toLowerCase(),
        });
      }
    }
  }
  const at = (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return out.map((r, i) => ({ r, i })).sort((x, y) => at(x.r.employee_id) - at(y.r.employee_id) || x.i - y.i).map((x) => x.r);
}

// The selected record: kept across renders; a scenario link picks the employee's first record;
// when the selected record leaves the list (decided), the next one in the same position is shown.
function pickSelection(view, list) {
  let key = state.sel[view];
  if (focusEmployee) {
    const hit = list.find((x) => x.employee_id === focusEmployee && x.groups.has('todo')) ?? list.find((x) => x.employee_id === focusEmployee);
    if (hit) key = hit.key;
    focusEmployee = null;
  }
  let i = list.findIndex((x) => x.key === key);
  if (i < 0) i = Math.min(state.selIndex[view] ?? 0, list.length - 1);
  const r = list[i] ?? null;
  state.sel[view] = r?.key ?? null;
  state.selIndex[view] = Math.max(i, 0);
  return r;
}

function workspace(view, s) {
  const all = recordList(view, s);
  const filter = FILTERS[view].some(([id]) => id === state.filters[view]) ? state.filters[view] : FILTERS[view][0][0];
  const list = all.filter((r) => r.groups.has(filter));
  const sel = pickSelection(view, list);
  const live = s.d.live;
  const chips = FILTERS[view].map(([id, text, tone]) => {
    const n = all.filter((r) => r.groups.has(id)).length;
    return `<button type="button" class="fchip${tone && n && filter !== id ? ` ${tone}` : ''}" data-action="queue-filter" data-view="${view}" data-value="${id}" aria-pressed="${filter === id}">${text}<span>${n}</span></button>`;
  }).join('');
  // One group per employee, so the name is read once and each row is just the line and where it goes.
  const groups = [];
  for (const r of list) {
    if (groups.at(-1)?.id !== r.employee_id) groups.push({ id: r.employee_id, name: r.name, rows: [] });
    groups.at(-1).rows.push(r);
  }
  const items = groups.map((g) => {
    const gid = `grp-${view}-${g.id}`;
    return `<li class="rec-group"><p class="rec-emp" id="${esc(gid)}">${g.id === AGENCIES ? `<span class="avatar">${icon('landmark')}</span>` : avatar(g.name)}${esc(g.name)}</p><ul class="rec-items" aria-labelledby="${esc(gid)}">${g.rows.map((r) => `<li data-text="${esc(r.text)}"><button type="button" class="record" data-action="select" data-key="${esc(r.key)}"${sel?.key === r.key ? ' aria-current="true"' : ''}>
      <span class="rec-top"><span class="from"><span class="sr-only">${esc(r.name)}: </span>${esc(r.from)}</span>${badge(r.badge, r.tone)}</span>
      <span class="rec-map">${icon('arrow')}<span class="to ${r.toTone}">${esc(r.to)}</span></span>
    </button></li>`).join('')}</ul></li>`;
  }).join('');
  const emptyText = {
    todo: 'Nothing needs you.', verified: 'No lines are ready to confirm.', expert: 'No lines are with an expert.',
    done: 'No decisions yet.', all: 'No records.', open: 'Nothing is waiting for an expert.', address: 'No line is waiting for the employer.', decided: 'No expert decisions yet.',
  }[filter];
  const title = view === 'review' ? 'To do' : 'Expert queue';
  const blurb = view === 'review' ? plural(all.filter((r) => r.kind !== 'account').length, 'record') : `${all.filter((r) => r.groups.has('open')).length} open`;
  const autoStats = automationStats(s.a, s.d);
  const foot = view === 'review'
    ? (s.d.autoRun || live
      ? `<div class="queue-foot"><p>${icon('spark')}${autoStats.auto} of ${autoStats.total} settled by rule.</p></div>`
      : `<div class="queue-foot"><a class="btn primary" href="#move">${icon('spark')}Start the move</a><p>Rules settle ${automationPreview(s).stats.auto} of ${autoStats.total}; only exceptions stay here.</p></div>`)
    : '<div class="queue-foot"><p>The employer confirms each decision before it goes live.</p></div>';
  let detail;
  const withExpert = s.expert - s.info;
  const reviewEmpty = [
    s.info ? `${plural(s.info, 'line waits', 'lines wait')} for information from you.` : '',
    withExpert ? `${plural(withExpert, 'line')} ${withExpert === 1 ? 'is' : 'are'} with an expert; ${withExpert === 1 ? 'it stays' : 'they stay'} off until an expert decides and you confirm.` : '',
  ].filter(Boolean).join(' ') || 'Every line has a decision.';
  if (!sel) detail = `${mobileBack(view)}<div class="empty"><strong>${esc(emptyText)}</strong><span>${view === 'review' ? esc(reviewEmpty) : 'Every line the system could not settle has an expert decision.'}</span>${canOpen('golive') ? '<a class="btn" href="#golive">Go to go-live checks</a>' : ''}</div>`;
  else if (sel.kind === 'gap') detail = gapDetail(sel.g, s);
  else if (sel.kind === 'account') detail = accountDetail(sel.a, s);
  else detail = caseDetail(sel.c, s, view);
  return `<div class="workspace" data-open="${state.detailOpen && sel ? 'true' : 'false'}">
    <aside class="queue" aria-label="${title} list">
      <div class="queue-head">
        <div class="queue-title"><h1>${title}</h1><span>${esc(blurb)}</span></div>
        <label class="search">${icon('search')}<span class="sr-only">Search ${title.toLowerCase()}</span><input type="search" id="queue-search" placeholder="Search employee, item or tax" value="${esc(state.query[view] ?? '')}" autocomplete="off"></label>
        <div class="filter-chips" role="group" aria-label="Show">${chips}</div>
      </div>
      <ul class="records"${items ? '' : ' hidden'}>${items}</ul>
      <div class="queue-empty" id="queue-empty"${items ? ' hidden' : ''}><p data-empty="${esc(emptyText)}">${esc(emptyText)}</p>${filter !== 'all' ? `<button class="btn quiet" type="button" data-action="queue-filter" data-view="${view}" data-value="all">Show all ${num(all.length)}</button>` : ''}</div>
      ${foot}
    </aside>
    <section class="detail" aria-label="Selected record">${detail}</section>
  </div>`;
}

const mobileBack = () => `<div class="mobile-back"><button class="btn quiet" type="button" data-action="back">${icon('back')}Back to the list</button></div>`;


// ---------- what only the employer can give (owner): asked for on To do, inside the record ----------
// Three kinds of fact only the employer has. A missing or unplaceable home address leaves the school-district
// lines with an expert; a city tax withheld for the home town instead of the work site needs to know where the
// person works; an agency with no account number cannot be paid. The owner gives them here: addresses and work
// locations are saved in the database, the engine checks that employee's lines again, and the rules finish them.

const FREQUENCIES = ['Monthly', 'Quarterly', 'Semi-monthly', 'Annually'];

function missingInfo(s) {
  const people = new Map();
  for (const c of s.cases) {
    if (!waitsForEmployer(c)) continue;
    const kind = c.reason === 'work_location' ? 'work' : 'address';
    const key = `${kind}|${c.employee_id}`;
    const p = people.get(key) ?? { kind, e: c.employee, reason: c.reason, lines: 0, c };
    p.lines += 1;
    people.set(key, p);
  }
  const accounts = s.d.live ? [] : agencyAccounts(s.a, s.d).filter((a) => !a.complete);
  const list = [...people.values()];
  return { addresses: list.filter((p) => p.kind === 'address'), work: list.filter((p) => p.kind === 'work'), accounts };
}

// The address on file that the lookup could not place, to correct rather than retype.
function unplacedAddress(e) {
  for (const p of e.addresses ?? []) {
    const ad = addressById(p.address_id);
    if (ad && ad.school_district === 'UNRESOLVED') return ad;
  }
  return null;
}

// The two places a person may work: the site on file, or home (the town whose tax Desktop withholds).
function workChoices(c, s) {
  const e = c.employee;
  const site = siteOf(e, s.a);
  const home = c.workProposal?.[0]?.tax ?? null;
  const homeAddr = addressById(e.expected.periods.at(-1)?.address_id ?? e.addresses?.[0]?.address_id);
  const work = e.expected.list.find((x) => x.basis === 'work' && x.tax.type === 'municipal')?.tax ?? null;
  return { site, siteTown: addressById(site.address_id)?.city ?? site.name, homeTown: homeAddr?.city ?? home?.place ?? 'home', home, work };
}

// What only the employer can give is asked for inside the record that waits for it: one card, the form, done.
// Answering saves the fact in the database, the engine checks the lines again and the rules finish them.
const taskCard = (ic, title, text, body) => `<section class="task" aria-labelledby="task-h">
    <div class="task-head"><span class="task-ic">${icon(ic)}</span><div><h3 id="task-h">${title}</h3><p>${text}</p></div></div>
    ${body}
  </section>`;

function addressForm(e, s, cur) {
  const id = domId(e.employee_id);
  const off = s.d.live ? ' disabled' : '';
  const st = cur?.state ?? addressById(siteOf(e, s.a).address_id)?.state ?? 'OH';
  return `<form class="mi-form" data-action="fix-address" data-employee="${esc(e.employee_id)}">
      <label class="mi-street"><span class="sr-only">Street for ${esc(e.name)}</span><input type="text" name="line1" id="mi-line1-${esc(id)}" placeholder="Street" value="${esc(cur?.line1 ?? '')}" autocomplete="off"${off}></label>
      <label><span class="sr-only">City for ${esc(e.name)}</span><input type="text" name="city" placeholder="City" value="${esc(cur?.city ?? '')}" autocomplete="off"${off}></label>
      <label class="mi-st"><span class="sr-only">State for ${esc(e.name)}</span><select name="state"${off}>${['OH', 'PA'].map((x) => `<option${x === st ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="mi-zip"><span class="sr-only">ZIP code for ${esc(e.name)}</span><input type="text" name="zip" placeholder="ZIP" value="${esc(cur?.zip ?? '')}" inputmode="numeric" maxlength="5" autocomplete="off"${off}></label>
      <div class="mi-actions"><button class="btn primary" type="submit"${off}>Save address</button><button class="btn quiet" type="button" data-action="sample-address" data-employee="${esc(e.employee_id)}"${off}>Fill a demo address</button></div>
    </form>`;
}

function answerCard(c, s) {
  const e = c.employee;
  const first = e.name.split(' ')[0];
  const off = s.d.live ? ' disabled' : '';
  const same = s.cases.filter((x) => x.employee_id === c.employee_id && waitsForEmployer(x) && (x.reason === 'work_location') === (c.reason === 'work_location')).length;
  const settles = same > 1 ? ` It settles ${plural(same, 'line')} for ${esc(first)}.` : '';
  if (c.reason === 'work_location') {
    const w = workChoices(c, s);
    const id = domId(e.employee_id);
    return taskCard('building', `Where does ${esc(first)} work?`, `Desktop withholds ${esc(w.homeTown)} city tax, where ${esc(first)} lives, not ${esc(w.siteTown)}'s, where the site is. A city tax is owed where the work is done.${settles}`,
      `<div class="mi-form mi-choice" role="group" aria-label="Where does ${esc(e.name)} work?">
        <button class="btn" type="button" id="mi-work-${esc(id)}" data-action="work-answer" data-employee="${esc(e.employee_id)}" data-remote="0"${off}>${icon('building')}At ${esc(w.site.name)}</button>
        <button class="btn" type="button" data-action="work-answer" data-employee="${esc(e.employee_id)}" data-remote="1"${off}>${icon('home')}From home in ${esc(w.homeTown)}</button>
      </div>`);
  }
  const cur = c.reason === 'address_unresolved' ? unplacedAddress(e) : null;
  const why = c.reason === 'no_address' ? 'Desktop has no home address for them' : `The address lookup cannot place ${esc([cur?.line1, cur?.city, cur?.zip].filter(Boolean).join(', ') || 'the address on file')}`;
  return taskCard('home', `Add ${esc(first)}'s home address`, `${why}. A school-district tax is owed where a person lives, so the line waits for it.${settles}`, addressForm(e, s, cur));
}

function accountDetail(a, s) {
  const id = domId(a.agency);
  const off = s.d.live ? ' disabled' : '';
  const files = listAnd(a.taxes.map((t) => t.replace(/ income tax$/, '')));
  const missing = [a.account ? '' : 'account number', a.frequency ? '' : 'deposit frequency'].filter(Boolean).join(' or ');
  const head = recordHeader({
    name: a.agency, id: '', avatarHtml: `<span class="avatar lg">${icon('landmark')}</span>`, meta: `Agency · pays and files ${esc(files)}`,
    badgeHtml: badge('No account number', 'warn'),
    flow: flow(flowSide('from', 'Desktop payroll', 'No account on file', `No ${esc(missing)}`), flowSide('to', 'Online payroll', `Pays and files ${esc(files)}`, 'Needs the agency account to pay and file', 'warn')),
    next: 'Add the account number and how often taxes are deposited. Both are on the agency\'s letter.',
  });
  const card = taskCard('landmark', `Add the ${esc(a.agency)} account`, `Online payroll pays and files ${esc(files)} with this agency, so it needs the account number and the deposit frequency. Desktop has no ${esc(missing)}.`,
    `<form class="mi-form" data-action="save-account" data-agency="${esc(a.agency)}">
        <label class="mi-street"><span class="sr-only">Account number for ${esc(a.agency)}</span><input type="text" name="account" id="mi-account-${esc(id)}" placeholder="Account number" value="${esc(a.account)}" autocomplete="off"${off}></label>
        <label class="mi-freq"><span class="sr-only">Deposit frequency for ${esc(a.agency)}</span><select name="frequency"${off}><option value="">Deposit frequency</option>${FREQUENCIES.map((f) => `<option${f === a.frequency ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
        <div class="mi-actions"><button class="btn primary" type="submit"${off}>Save account</button><button class="btn quiet" type="button" data-action="sample-account" data-agency="${esc(a.agency)}"${off}>Fill a demo number</button></div>
      </form>`);
  return `${mobileBack('review')}${head}${card}`;
}

// A lookup address for the demo, the same one each time for the same person. Desktop withheld a
// school-district tax for them, so it is in a district that has one: near the work site if possible.
function demoAddressFor(employeeId) {
  const a = analysisFor();
  const e = a.employees.find((x) => x.employee_id === employeeId);
  const site = addressById(siteOf(e, a).address_id);
  const st = site?.state ?? 'OH';
  const taxed = new Set((data.catalog.states[st]?.taxes ?? []).filter((t) => t.type === 'school_district').map((t) => t.code));
  const sites = new Set(data.companies.flatMap((c) => c.worksites.map((w) => w.address_id)));
  const ok = (x) => !sites.has(x.address_id) && taxed.has(x.school_district) && lookupIdx.has(addressKey(x.line1, x.zip));
  let pool = data.geocoder.addresses.filter((x) => ok(x) && x.zip === site?.zip);
  if (!pool.length) pool = data.geocoder.addresses.filter((x) => ok(x) && x.state === st);
  const h = [...employeeId].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return pool[h % pool.length] ?? null;
}

// Save what the employer gave, a home address or where someone works: in the database (then read that business
// back), or in memory without one. A later answer of the same kind replaces the earlier one.
const correctionKind = (x) => x.kind ?? 'address';
function addCorrection(corr) {
  state.corrections = [...state.corrections.filter((x) => !(x.company_id === corr.company_id && x.employee_id === corr.employee_id && correctionKind(x) === correctionKind(corr))), corr];
  let found;
  if (db) {
    const r = applyCorrection(db, corr, lookupIdx, lookupAddresses());
    data.companies = [readCompany(db)];
    if (!r.found && corr.kind !== 'work') unplaced(r.addressId, corr);
    found = r.found;
  } else found = correctInMemory(corr);
  forgetCompany(corr.company_id);
  return found;
}
function correctInMemory(corr) {
  if (corr.kind === 'work') {
    data.companies = data.companies.map((c) => (c.company_id !== corr.company_id ? c
      : { ...c, employees: c.employees.map((e) => (e.employee_id === corr.employee_id ? { ...e, remote: Boolean(corr.remote) } : e)) }));
    return true;
  }
  const found = lookupIdx.get(addressKey(corr.line1, corr.zip));
  const addressId = found ?? `${corr.company_id}-C-${corr.employee_id}`;
  data.companies = data.companies.map((c) => (c.company_id !== corr.company_id ? c
    : { ...c, employees: c.employees.map((e) => (e.employee_id === corr.employee_id ? { ...e, addresses: [{ address_id: addressId, from_month: 1 }] } : e)) }));
  if (!found) unplaced(addressId, corr);
  return Boolean(found);
}
// An address the lookup has never seen is kept, and the engine treats it as one it cannot place.
function unplaced(addressId, corr) {
  data.geocoder = { ...data.geocoder, addresses: [...data.geocoder.addresses.filter((a) => a.address_id !== addressId), { address_id: addressId, line1: corr.line1, city: corr.city, state: corr.state, zip: corr.zip, school_district: 'UNRESOLVED', municipality: null }] };
}

function viewReview(s) { return workspace('review', s); }
function viewExpert(s) { return workspace('expert', s); }

// ---------- record detail ----------

function recordHeader({ name, id, meta, badgeHtml, flow, next, avatarHtml }) {
  return `<div class="rec-header">
    <div class="rec-title">
      <div class="rec-who">${avatarHtml ?? avatar(name, 'lg')}<div><h2 id="detail-title" tabindex="-1">${esc(name)}</h2><p class="sub">${id ? `<span class="idchip">${esc(id)}</span>` : ''}${meta}</p></div></div>
      ${badgeHtml}
    </div>
    ${flow}
    <p class="next"><span class="next-ic">${icon('arrow')}</span><span><b>Next</b>${esc(next)}</span></p>
  </div>`;
}

// The record's story in one line: what Desktop had, and where it goes in Online payroll.
const flowSide = (side, label, title, meta, tone = '') => `<div class="flow-side ${side} ${tone}"><span class="flow-label">${label}</span><strong>${title}</strong>${meta ? `<span class="flow-meta">${meta}</span>` : ''}</div>`;
const flow = (from, to) => `<div class="flow">${from}<span class="flow-arrow" aria-hidden="true">${icon('arrow')}</span>${to}</div>`;

// Until someone confirms it, the Online side is a proposal, never a decision.
function targetLabel(c) {
  if (c.stage === 'awaiting_employer') return 'Proposed for Online payroll';
  if (c.stage === 'with_expert') return 'Online payroll';
  const e = c.decision.employer;
  return e?.auto ? 'Confirmed by rule' : 'Confirmed by the employer';
}

function caseFlow(c) {
  const item = c.item;
  const from = flowSide('from', 'Desktop payroll', esc(labelOf(item.label)), esc(`Law ID ${item.law_id} · ${item.origin === 'custom' ? 'custom item, names no tax' : 'system item'} · ${deskRate(item)}`));
  const label = targetLabel(c);
  let to;
  if (c.route === 'local_tax') {
    const title = c.proposal.map((p) => `${esc(p.tax.name)}${c.proposal.length > 1 ? ` <span class="flow-when">${esc(monthSpan(p.months))}</span>` : ''}`).join('<br>');
    const p = c.proposal[0];
    const meta = c.proposal.length > 1 ? `Law ID ${c.proposal.map((x) => x.tax.law_id).join(' then ')} · split by the move` : `Law ID ${p.tax.law_id} · ${rateFmt(p.tax.rate)} · ${basisText(p.basis)}`;
    to = flowSide('to', label, title, esc(meta), c.verified || c.stage === 'confirmed' ? 'good' : 'warn');
  } else if (c.route === 'not_a_tax') to = flowSide('to', label, 'Non-tax deduction', 'Moves to deductions; never filed as a tax', 'neutral');
  else if (c.route === 'custom_entry') to = flowSide('to', label, esc(c.entry.name), esc(`Custom entry · employer-managed · ${c.entry.flat ? `${money(c.entry.flat)} a year` : `${c.entry.rate}%`}`), 'blue');
  else if (c.route === 'stop') to = flowSide('to', label, 'Stop withholding', esc(c.ytd ? `${money(c.ytd)} taken by mistake, to be refunded` : 'Nothing was withheld'), 'bad');
  else if (waitsForEmployer(c)) to = flowSide('to', label, waitText(c), esc(c.reason === 'work_location' ? 'Only the employer knows; asked on To do' : `${REASON_SHORT[c.reason]}: the employer adds it on To do`), 'warn');
  else to = flowSide('to', label, 'Waiting for an expert', esc(REASON_SHORT[c.reason] ?? 'Needs an expert'), REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn');
  return flow(from, to);
}


function nextStep(c, view, live) {
  if (live) return OPEN_STAGES.has(c.stage) ? 'This company is live, so decisions are locked. Undo go-live to change them.' : `Done: ${STAGE_LABEL[c.stage].toLowerCase()}. This company is live.`;
  if (view === 'expert') {
    if (c.stage === 'with_expert') return EXPERT_HINT[c.reason] ?? 'Decide how this line should migrate.';
    return `Decided: ${expertText(c)}. The employer ${c.stage === 'awaiting_employer' ? 'confirms it next' : 'has confirmed it'}.`;
  }
  if (waitsForEmployer(c)) return view === 'review' ? `${c.reason === 'work_location' ? `Say where ${c.employee_name.split(' ')[0]} works` : 'Add the home address'} below. The engine then checks this line again and the rules finish it.` : `The employer is asked on their To do. ${c.reason === 'work_location' ? 'If you already know where they work, map the line now.' : 'If you already have the address, map the line now.'}`;
  if (c.stage === 'with_expert') return c.decision.sentToExpert && !c.decision.expert ? 'You sent this to an expert. Take it back from More actions if that was a mistake.' : 'Nothing to do yet. An expert decides first, then you confirm.';
  if (c.stage === 'awaiting_employer') {
    if (c.decision.expert) return `An expert decided: ${expertText(c)}. Confirm to accept it.`;
    if (c.route === 'not_a_tax') return 'Move it to deductions. It will never be filed as a tax.';
    if (c.route === 'local_tax') {
      if (c.unowed?.amount) return `Confirm, and flag ${money(c.unowed.amount)} withheld after the move for a correction with the agency.`;
      const off = c.proposal.find((p) => p.rate.status === 'over' || p.rate.status === 'under');
      if (off) return `Confirm at the official ${off.rate.official}. Desktop used ${off.rate.desktop}; the W-2 keeps what was really withheld.`;
      if (c.flags.includes('label_place_mismatch')) return 'Check the address: the label names another place. The address decides.';
      if (c.proposal.some((p) => p.optional)) return 'Decide whether to keep the optional home-city withholding.';
      return 'Confirm the mapping. It is on the expected list and the rate matches.';
    }
    return 'Confirm the decision.';
  }
  const e = c.decision.employer;
  if (e?.auto) return `Done automatically, by the rule "${ruleLabel(e.rule)}". Undo it below if needed.`;
  return `Done: ${STAGE_LABEL[c.stage].toLowerCase()}. Undo it below if needed.`;
}

function checksBanner(c) {
  const meta = `<span class="meta">${esc(stateName(c.state))} · ${c.model ? (c.model.shown ? 'model suggestion shown' : 'model suggestion hidden') : 'Intuit-defined item'}</span>`;
  if (c.decision.expert?.auto) return `<div class="banner info">${icon('spark', 'lg')}<div><strong>Stopped by your rule</strong> "${esc(ruleLabel(c.decision.expert.rule))}": ${esc((c.decision.expert.note ?? 'Not owed at this address.').replace(/^./, (x) => x.toLowerCase()))} ${c.ytd ? `The ${esc(money(c.ytd))} Desktop already took is to be refunded by the agency and paid back to ${esc(c.employee_name.split(' ')[0])}.` : ''}</div>${meta}</div>`;
  if (c.decision.expert) return `<div class="banner info">${icon('user', 'lg')}<div><strong>Expert decision:</strong> ${esc(expertText(c))}. The system's own findings are under How it was decided.</div>${meta}</div>`;
  const issues = c.evidence.filter((x) => x.tone === 'fail' || x.tone === 'warn').map((x) => x.text);
  if (c.decision.sentToExpert) issues.push('The employer sent this line to an expert.');
  if (!issues.length) return '';
  const tone = c.stage === 'with_expert' && REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn';
  const title = OPEN_STAGES.has(c.stage) ? `${plural(issues.length, 'thing', 'things')} to check` : plural(issues.length, 'note');
  return `<div class="banner ${OPEN_STAGES.has(c.stage) ? tone : 'info'}">${icon(OPEN_STAGES.has(c.stage) ? 'alert' : 'info', 'lg')}<div><strong>${title}</strong><ul>${issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>${meta}</div>`;
}

function mappingTable(rows) {
  return `<div class="table-wrap"><table class="map-table"><caption class="sr-only">Desktop versus Online, field by field</caption><thead><tr><th>Field</th><th>Desktop (source)</th><th>Online (target)</th><th>Check</th></tr></thead><tbody>
      ${rows.map(([k, a, b, n, cls]) => `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(k)}</td><td data-l="Desktop">${a}</td><td data-l="Online">${b}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// The record's reference detail, one tab at a time: the field-by-field mapping, the addresses and expected
// taxes, how the engine decided, and who did what. The chosen tab is kept from record to record.
let detailTab = 'map';
function detailTabs(map, ev) {
  const panels = [['map', 'Desktop vs Online', map], ['where', 'Addresses and taxes', ev.where], ['how', 'How it was decided', ev.how], ['log', `History${ev.count ? ` (${ev.count})` : ''}`, ev.log]];
  const cur = panels.some(([id]) => id === detailTab) ? detailTab : 'map';
  return `<section class="card rd-tabs" aria-label="Details">
    <div class="tabbar" role="tablist" aria-label="Details">${panels.map(([id, label]) => `<button type="button" role="tab" id="dt-${id}" aria-controls="dp-${id}" aria-selected="${id === cur}" tabindex="${id === cur ? 0 : -1}" data-action="detail-tab" data-value="${id}">${label}</button>`).join('')}</div>
    ${panels.map(([id, , html]) => `<div class="tabpanel tp-${id}" role="tabpanel" id="dp-${id}" aria-labelledby="dt-${id}" tabindex="0"${id === cur ? '' : ' hidden'}>${html}</div>`).join('')}
  </section>`;
}

function caseMapping(c, s) {
  const item = c.item;
  const custom = item.origin === 'custom';
  const srcItem = `<span class="src">${esc(labelOf(item.label))}</span>${custom ? ' <span class="none">free text</span>' : ''}`;
  const src = (t) => `<span class="src">${esc(t)}</span>`;
  const tgt = (t, cls = '') => `<span class="tgt ${cls}">${esc(t)}</span>`;
  const none = (t) => `<span class="none">${esc(t)}</span>`;
  const stack = (list) => `<div class="cell-stack">${list.join('')}</div>`;
  const desktopMonthsList = c.ytdByMonth.map((x) => x.month);
  const cloud = cloudMonths(s.a.company).filter((m) => c.employee.expected.employed.includes(m));
  const ytdRow = (n) => ['Year to date', `<span class="val">${money(c.ytd)}</span>`, n[0], n[1], 'total'];
  const rows = [];
  if (c.route === 'local_tax') {
    const target = (fn, cls = () => '') => stack(c.proposal.map((p) => tgt(fn(p), cls(p))));
    const fromExpert = c.proposal.some((p) => p.fromExpert);
    rows.push(['Tax item', srcItem, target((p) => `${p.tax.name}${p.tax.type === 'school_district' ? ` · SD ${p.tax.code}` : ''}${c.proposal.length > 1 ? ` · ${monthSpan(p.months)}` : ''}`),
      fromExpert ? note('blue', 'user', 'Mapped by an expert') : custom ? note('good', 'check', `Model suggested: ${(c.model?.entry_label ?? 'a defined tax').toLowerCase()}`) : note('good', 'check', 'Intuit-defined item')]);
    rows.push(['Law ID', src(`${item.law_id}${custom ? ' (custom)' : ''}`), target((p) => String(p.tax.law_id)), custom ? note('good', 'pin', 'Found from the address') : note('good', 'check', 'Same Law ID: mapped directly')]);
    rows.push(['Jurisdiction', custom ? none('Not recorded in Desktop') : src(s.a.idx.taxByLaw.get(item.law_id)?.name ?? `Law ID ${item.law_id}`), target((p) => `${p.tax.place} · ${basisText(p.basis)}`), note('good', 'pin', 'From the address lookup')]);
    const sameAgency = c.proposal.every((p) => String(p.tax.agency).toLowerCase() === String(item.agency ?? '').toLowerCase());
    rows.push(['Agency', item.agency ? src(item.agency) : none('None on file'), target((p) => p.tax.agency), sameAgency ? note('good', 'check', 'Same agency') : note('', 'info', 'Replaced by the official agency')]);
    rows.push(['Rate', src(deskRate(item)), target((p) => `${rateFmt(p.tax.rate)}${p.tax.base ? ` ${p.tax.base.toLowerCase()}` : ''}`, (p) => (p.rate.status === 'over' || p.rate.status === 'under' ? 'warn' : '')), stack(c.proposal.map((p) => {
      const r = p.rate;
      if (r.status === 'match') return note('good', 'check', 'No difference');
      if (r.status === 'over' || r.status === 'under') return note('warn', 'alert', `${r.status === 'over' ? 'Over' : 'Under'}-withheld ${money(Math.abs(r.difference))} (${monthSpan(r.months)})`);
      if (r.status === 'no_history') return note('', 'info', 'No Desktop months to compare');
      return note('', 'info', 'Flat amount: not compared');
    }))]);
    rows.push(['Months', desktopMonthsList.length ? src(monthSpan(desktopMonthsList)) : none('None this year'), cloud.length ? tgt(monthSpan(cloud)) : none('No Online paychecks'), note('', 'history', desktopMonthsList.length ? 'Desktop months relabelled on the W-2' : 'No Desktop history to relabel')]);
    rows.push(ytdRow(c.unowed?.amount
      ? [tgt(money(c.ytd), 'warn'), note('bad', 'alert', `${money(c.unowed.amount)} not owed (${monthSpan(c.unowed.months)}): correction needed`)]
      : [`<span class="val">${money(c.ytd)}</span>`, note('good', 'check', 'Kept as withheld')]));
    if (c.flags.includes('label_place_mismatch')) rows.splice(2, 0, ['Place in label', srcItem, target((p) => p.tax.place), note('warn', 'alert', 'The label names another place; the address decides')]);
    return mappingTable(rows);
  }
  if (c.route === 'not_a_tax') {
    rows.push(['Tax item', srcItem, tgt('Non-tax deduction'), c.decision.expert ? note('blue', 'user', 'Decided by an expert') : note('good', 'check', c.reasonText)]);
    rows.push(['Desktop setting', src(`${item.item_type}, ${item.tracking_type}`), tgt('After-tax deduction'), note('', 'info', 'Never filed as a tax')]);
    rows.push(['Rate', src(rateText(item)), tgt(rateText(item)), note('good', 'check', 'Amount unchanged')]);
    rows.push(ytdRow([`<span class="val">${money(c.ytd)}</span>`, note('', 'info', 'Stays a deduction on the W-2')]));
    return mappingTable(rows);
  }
  if (c.route === 'custom_entry') {
    const e = c.entry;
    rows.push(['Tax item', srcItem, tgt(e.name, 'blue'), note('blue', 'user', 'Structured custom entry by an expert')]);
    rows.push(['Type and basis', src(`${item.item_type}, ${item.tracking_type}`), tgt(`${e.type} · ${basisText(e.basis)}`, 'blue'), note('', 'info', 'Sent to catalogue review')]);
    rows.push(['Agency', item.agency ? src(item.agency) : none('None on file'), tgt(e.agency, 'blue'), note('', 'info', `Files ${String(e.frequency).toLowerCase()}`)]);
    rows.push(['Rate', src(rateText(item)), tgt(e.flat ? `${money(e.flat)} a year` : rateFmt(e.rate), 'blue'), note('warn', 'alert', 'Employer-managed: QuickBooks will not pay or file it')]);
    rows.push(ytdRow([`<span class="val">${money(c.ytd)}</span>`, note('good', 'check', 'Kept as withheld')]));
    return mappingTable(rows);
  }
  if (c.route === 'stop') {
    rows.push(['Tax item', srcItem, tgt('Stop withholding', 'bad'), c.decision.expert?.auto ? note('', 'spark', 'Stopped by your rule') : note('blue', 'user', 'Decided by an expert')]);
    rows.push(['Rate', src(rateText(item)), tgt('0.00%', 'bad'), note('', 'info', 'Nothing withheld from Online paychecks')]);
    rows.push(ytdRow([tgt(money(c.ytd), 'bad'), note('bad', 'alert', c.ytd ? 'Not owed: refund from the agency, back to the employee' : 'Nothing withheld')]));
    return mappingTable(rows);
  }
  const other = c.duplicateOf ? s.cases.find((x) => x.case_id === c.duplicateOf) : null;
  const decides = waitsForEmployer(c) ? 'After the employer answers' : 'An expert decides';
  rows.push(['Tax item', srcItem, none('No target yet'), note(REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn', 'alert', REASON_SHORT[c.reason] ?? 'Needs an expert')]);
  if (other) rows.push(['Already withheld by', none('This line'), tgt(`"${labelOf(other.item.label)}"`, 'warn'), note('bad', 'alert', 'Keeping both would withhold twice')]);
  rows.push(['Law ID', src(`${item.law_id}${custom ? ' (custom)' : ''}`), none(decides), note('', 'info', c.reason === 'work_location' ? 'The home town\'s tax, not the work site\'s' : custom ? 'Names no tax' : 'Tax not expected here')]);
  rows.push(['Desktop setting', src(`${item.item_type}, ${item.tracking_type}`), none(decides), note('', 'info', 'From Desktop')]);
  if (c.model) rows.push(['Model suggestion', none('Label only'), c.model.entry_label ? tgt(c.model.entry_label, 'blue') : none('No defined entry'), note(c.model.shown ? 'blue' : '', 'spark', `A suggestion only, ${c.model.confidence} confidence${c.model.shown ? '' : ' (hidden from the employer)'}`)]);
  rows.push(['Rate', src(rateText(item)), none('After the decision'), note('', 'info', 'Checked once a tax is chosen')]);
  rows.push(ytdRow(['<span class="none">Not migrated yet</span>', note('warn', 'alert', 'Stays off until decided')]));
  return mappingTable(rows);
}

function districtText(ad, s) {
  if (ad.missing) return 'Not in the address lookup';
  if (ad.school_district === 'UNRESOLVED') return 'School district: could not be placed';
  if (String(ad.school_district ?? '').startsWith('NO-TAX')) return 'School district with no income tax';
  if (!ad.school_district) return 'No school district on file';
  const sd = [...s.a.idx.taxes.values()].find((t) => t.type === 'school_district' && t.code === ad.school_district);
  return sd ? `SD ${sd.code} · ${sd.name}` : `School district ${ad.school_district}`;
}

function evidenceParts(s, { employee: e, state: st, match = new Set(), steps = [], model = null, historyTarget = '' }) {
  const site = siteOf(e, s.a);
  const work = addressById(site.address_id);
  const homes = e.expected.periods.length
    ? e.expected.periods.map((p) => { const ad = addressById(p.address_id); return place('home', ad.missing ? 'bad' : '', `Home${e.expected.periods.length > 1 ? `, ${monthSpan(p.months)}` : ''}`, addrLine(ad), districtText(ad, s)); }).join('')
    : place('home', 'bad', 'Home', 'Missing in Desktop', 'Home-based taxes cannot be listed');
  const cityTax = [...s.a.idx.taxes.values()].find((t) => t.type === 'municipal' && t.state === work.state && t.place.toLowerCase() === String(work.municipality ?? '').toLowerCase());
  const workRow = place('building', 'work', e.remote ? 'Workplace (works from home)' : 'Workplace', `${site.name}: ${addrLine(work)}`, cityTax ? `City tax: ${cityTax.name}, ${rateFmt(cityTax.rate)}` : 'No city tax in the catalogue');
  const exp = e.expected.list.map((x) => `<li class="${match.has(x.tax_id) ? 'match' : ''}"><strong>${esc(x.tax.name)}</strong><span class="r">${rateFmt(x.tax.rate)}</span><span class="m">${x.tax.type === 'school_district' ? `SD ${esc(x.tax.code)}, ` : ''}${basisText(x.basis)}, ${monthSpan(x.months)}${x.required ? '' : ', optional'}</span></li>`).join('');
  const notes = e.expected.notes.map((n) => `<span class="${n.tone === 'warn' ? 'warn' : ''}">${esc(n.text)}</span>`).join('');
  const hist = state.audit.filter((a) => a.company_id === state.companyId && a.target === historyTarget);
  const modelBody = model ? `<div class="rd-model"><h4>${icon('spark')}Model suggestion</h4><div class="model-grid">
      <div><span>Closest defined entry</span><b>${esc(model.entry_label ?? 'None')}</b></div>
      <div><span>Label silhouette</span><b>${model.item_silhouette.toFixed(2)}</b></div>
      <div><span>Confidence</span><b>${esc(model.confidence)}</b></div>
      <div><span>Shown to the employer</span><b>${model.shown ? 'Yes' : 'No (shadow or weak)'}</b></div>
    </div><p class="small muted">${esc(MODEL_VERSION)}. The model suggests a type; the address picks the exact tax; a person decides.</p></div>` : '';
  return {
    where: `<div class="evidence-grid">
      <div class="ev-box"><span class="label">Where ${esc(e.name.split(' ')[0])} lives and works · address lookup, ${esc(stateName(st))}</span>${homes}${workRow}</div>
      <div class="ev-box"><span class="label">Expected taxes, from the addresses</span>${exp ? `<ul class="exp-list">${exp}</ul>` : '<span class="none">None listed</span>'}${notes ? `<div class="exp-notes">${notes}</div>` : ''}</div>
    </div>`,
    how: `<ul class="marks steps-list">${steps.map((x) => `<li>${mark(x.tone)}<span>${x.step ? `<span class="step-n">Step ${x.step}</span>` : ''}${esc(x.text)}</span></li>`).join('')}</ul>${modelBody}`,
    log: hist.length ? `<ul class="history">${hist.map((a) => `<li><time datetime="${esc(a.at)}">${esc(new Date(a.at).toLocaleString())}</time><span><strong>${esc(a.actor)}</strong>: ${esc(a.action)}${a.detail ? `. ${esc(a.detail)}` : ''}</span></li>`).join('')}</ul>` : '<p class="none">No decisions yet.</p>',
    count: hist.length,
  };
}

function caseDetail(c, s, view) {
  const live = s.d.live;
  const e = c.employee;
  const site = siteOf(e, s.a);
  const [b, tone] = caseBadge(c);
  const meta = `${esc(site.name)} · ${money(e.monthly_wages)} a month${employmentText(e) ? ` · ${esc(employmentText(e))}` : ''}`;
  // Findings in step order (a later check can add to an earlier step); stable for equal steps.
  const steps = c.evidence.map((x, i) => ({ x, i })).sort((a, b) => (a.x.step ?? 9) - (b.x.step ?? 9) || a.i - b.i).map((y) => y.x);
  if (c.decision.sentToExpert) steps.push({ tone: 'info', text: `The employer sent this to an expert${c.decision.sentToExpert.note ? `: ${c.decision.sentToExpert.note}` : ''}.` });
  if (c.decision.expert) steps.push({ tone: 'info', text: c.decision.expert.auto ? `Stopped by the rule "${ruleLabel(c.decision.expert.rule)}".` : `Expert decision: ${expertText(c)}.` });
  // The owner answers what only they know right here; the card replaces the warning that says it is missing.
  const ask = view === 'review' && waitsForEmployer(c) && !live && canOpen('review');
  return `${mobileBack(view)}
    ${recordHeader({ name: c.employee_name, id: e.employee_id, meta, badgeHtml: badge(b, tone), flow: caseFlow(c), next: nextStep(c, view, live) })}
    ${ask ? answerCard(c, s) : checksBanner(c)}
    ${view === 'expert' && c.stage === 'with_expert' && !live ? expertTools(c, s) : ''}
    ${detailTabs(caseMapping(c, s), evidenceParts(s, { employee: e, state: c.state, match: new Set(c.proposal.map((p) => p.tax_id)), steps, model: c.model, historyTarget: `${c.employee_name}: ${c.item.label}` }))}
    ${caseActions(c, s, view)}`;
}

const logNote = `<span class="log-note">${icon('lock')}Every decision is logged with the time and role.</span>`;
const moreMenu = (items) => (items.length ? `<details class="more"><summary class="btn" aria-label="More actions"><span class="more-text">More actions</span>${icon('chevron', 'more-chev')}${icon('dots', 'more-dots')}</summary><div class="more-menu">${items.join('')}</div></details>` : '');

function caseActions(c, s, view) {
  const id = esc(c.case_id);
  const key = esc(`c|${c.case_id}`);
  // Buttons that open the other person's screen only appear for a role that can open it.
  const toReview = canOpen('review') ? `<button class="btn" type="button" data-action="goto" data-view="review" data-key="${key}">Open in the employer's list</button>` : '';
  const toExpert = canOpen('expert') ? `<button class="btn primary" type="button" data-action="goto" data-view="expert" data-key="${key}">Open in the expert queue</button>` : '';
  if (s.d.live) return canOpen('golive') ? `<div class="action-bar">${logNote}<a class="btn" href="#golive">Live: see go-live</a></div>` : '';
  if (view === 'expert') {
    if (c.stage === 'with_expert') return toReview ? `<div class="action-bar">${logNote}${toReview}</div>` : '';
    return `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="expert-undo" data-id="${id}">Reopen</button>${toReview}</div>`;
  }
  if (c.stage === 'with_expert') {
    const items = c.decision.sentToExpert && !c.decision.expert ? [`<button class="btn" type="button" data-action="unsend-expert" data-id="${id}">Take it back from the expert</button>`] : [];
    if (waitsForEmployer(c)) return '';
    return items.length || toExpert ? `<div class="action-bar">${logNote}${moreMenu(items)}${toExpert}</div>` : '';
  }
  if (c.stage === 'awaiting_employer') {
    const optional = c.route === 'local_tax' && c.proposal.some((p) => p.optional);
    const label = {
      local_tax: optional ? 'Keep courtesy withholding' : c.unowed?.amount ? 'Confirm and flag correction' : isOff(c) ? 'Confirm at official rate' : 'Confirm mapping',
      not_a_tax: 'Move to deductions', custom_entry: 'Accept as employer-managed', stop: 'Stop withholding',
    }[c.route];
    const items = c.decision.expert ? [] : [`<button class="btn" type="button" data-action="send-expert" data-id="${id}">Send to an expert</button>`];
    return `<div class="action-bar">${logNote}${moreMenu(items)}<button class="btn primary lg" type="button" data-action="decide" data-id="${id}">${icon('check')}${label}</button></div>`;
  }
  return `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="undo-decide" data-id="${id}">Undo decision</button></div>`;
}

function gapDetail(g, s) {
  const stage = gapStage(g, s.d, s.cases);
  const e = s.a.employees.find((x) => x.employee_id === g.employee_id);
  const site = siteOf(e, s.a);
  const live = s.d.live;
  const sd = g.tax.type === 'school_district' ? ` (SD ${g.tax.code})` : '';
  const by = stage === 'covered' ? gapCoveredBy(g, s.d, s.a) : null;
  const back = g.pastMonths.length ? `Nothing was withheld in ${monthSpan(g.pastMonths)}; estimated back tax ${money(g.backTaxEstimate)}.` : 'No Desktop months were missed, so there is no back tax.';
  const [b, tone] = { awaiting_employer: ['Not withheld', 'bad'], added: [s.d.gaps[g.gap_id]?.auto ? 'Auto: added' : 'Added', 'done'], covered: ['Covered', 'done'] }[stage];
  const gapFlow = flow(
    flowSide('from', 'Desktop payroll', 'No item', esc(g.pastMonths.length ? `Nothing withheld ${monthSpan(g.pastMonths)}` : 'Nothing to withhold yet'), ''),
    flowSide('to', stage === 'awaiting_employer' ? 'Proposed for Online payroll' : stage === 'added' ? (s.d.gaps[g.gap_id]?.auto ? 'Added by rule' : 'Added by the employer') : 'Covered by an expert mapping', esc(g.tax.name), esc(`${g.tax.type === 'school_district' ? `SD ${g.tax.code} · ` : ''}${rateFmt(g.tax.rate)} · ${basisText(g.basis)}`), stage === 'awaiting_employer' ? 'bad' : stage === 'added' ? 'good' : 'neutral'));
  const next = live ? 'This company is live, so decisions are locked.'
    : stage === 'awaiting_employer' ? (g.cloudMonths.length ? 'Add it from the first cloud payroll, and discuss the back tax with the agency.' : 'Record the back tax for the agency; there are no Online paychecks to withhold it from.')
      : stage === 'added' ? 'Done. Undo it below if needed.' : 'Nothing to do: the expert mapping covers it.';
  const banner = stage === 'awaiting_employer'
    ? `<div class="banner bad">${icon('alert', 'lg')}<div><strong>Expected, but nothing withheld.</strong> ${esc(back)}</div><span class="meta">Gap check</span></div>`
    : `<div class="banner ${stage === 'added' ? 'good' : 'info'}">${icon('check', 'lg')}<div><strong>${stage === 'added' ? 'Added.' : 'Covered.'}</strong> ${esc(back)}</div><span class="meta">Gap check</span></div>`;
  const rows = [
    ['Tax item', '<span class="none">No Desktop item</span>', `<span class="tgt ${stage === 'awaiting_employer' ? 'bad' : ''}">${esc(g.tax.name)}${esc(sd)}</span>`, note('bad', 'alert', 'Missing in Desktop')],
    ['Jurisdiction', '<span class="none">Not recorded</span>', `<span class="tgt">${esc(g.tax.place)} · ${esc(basisText(g.basis))}</span>`, note('good', 'pin', 'From the address lookup')],
    ['Rate', '<span class="none">None</span>', `<span class="tgt">${rateFmt(g.tax.rate)}</span>`, note('', 'info', g.tax.agency)],
    ['Months', g.pastMonths.length ? `<span class="none">Nothing withheld ${esc(monthSpan(g.pastMonths))}</span>` : '<span class="none">None missed</span>', g.cloudMonths.length ? `<span class="tgt">${esc(monthSpan(g.cloudMonths))}</span>` : '<span class="none">No Online paychecks</span>', note('', 'history', 'Starts with the first cloud payroll')],
    ['Back tax estimate', '<span class="val">$0.00</span>', `<span class="tgt ${g.backTaxEstimate ? 'warn' : ''}">${money(g.backTaxEstimate)}</span>`, note(g.backTaxEstimate ? 'warn' : '', 'info', g.backTaxEstimate ? 'Discuss with the agency' : 'Nothing owed for past months'), 'total'],
  ];
  const addLabel = g.cloudMonths.length ? 'Add from first cloud payroll' : 'Record back tax for the agency';
  const actions = live ? `<div class="action-bar">${logNote}<a class="btn" href="#golive">Live: see go-live</a></div>`
    : stage === 'awaiting_employer' ? `<div class="action-bar">${logNote}<button class="btn primary lg" type="button" data-action="add-gap" data-id="${esc(g.gap_id)}">${icon('check')}${addLabel}</button></div>`
      : stage === 'added' ? `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="undo-gap" data-id="${esc(g.gap_id)}">Undo</button></div>` : '';
  const steps = [{ step: 2, tone: 'fail', text: `${g.tax.name} is on ${g.employee_name}'s expected list (${basisText(g.basis)}, ${monthSpan(g.months)}), but no Desktop item withholds it.` }];
  if (by) steps.push({ tone: 'info', text: `Covered by the expert mapping of "${by.item.label}".` });
  return `${mobileBack('review')}
    ${recordHeader({ name: g.employee_name, id: e.employee_id, meta: `${esc(site.name)} · ${money(e.monthly_wages)} a month`, badgeHtml: badge(b, tone), flow: gapFlow, next })}
    ${banner}
    ${detailTabs(mappingTable(rows), evidenceParts(s, { employee: e, state: g.tax.state, match: new Set([g.tax_id]), steps, historyTarget: `${g.employee_name}: ${g.tax.name}` }))}
    ${actions}`;
}

function expertText(c) {
  const x = c.decision.expert;
  if (!x) return '';
  if (x.action === 'map') return `mapped to ${c.proposal[0]?.tax.name ?? x.tax_id}`;
  if (x.action === 'not_a_tax') return 'not a tax';
  if (x.action === 'custom_entry') return `structured custom entry "${x.entry.name}", employer-managed`;
  if (x.action === 'stop') return 'not owed, stop withholding';
  return x.action;
}

const EXPERT_HINT = {
  shadow: 'This state is in shadow mode, so decide by hand. The model\'s guess is only logged, to measure precision.',
  weak_signal: 'The label does not say clearly what it is. Check with the employer, then map it, mark it as not a tax, or create a custom entry.',
  conflict: 'Desktop and the label disagree. If it really is a tax, map it; otherwise mark it as not a tax.',
  not_expected: 'If the address is right, this tax is not owed: stop it, and the Desktop amount is flagged for a correction.',
  duplicate: 'Another line already withholds this tax. Usually: not owed, and the extra amount is corrected with the agency.',
  state_conflict: 'The employee has no address in the state the label names. Usually not owed; use a custom entry only if they really work there.',
  no_address: 'The employer is asked for the home address on their To do; once it is added, the engine checks this line again. If you already have it, map the line to that district.',
  address_unresolved: 'The employer is asked to correct the address on their To do. If it is a new build missing from boundary files, map the line to the right district.',
  work_location: 'Desktop withholds the city tax of the town where this person lives, not the work site\'s. The employer is asked where they work. If you already know, map the line: the home town\'s tax if they work from home.',
  ambiguous: 'More than one expected tax fits. Pick the right one from the list.',
  employer_sent: 'The employer disagreed with the suggestion. Check the address and the Desktop item, then decide.',
};

const TYPE_NAME = { school_district: 'School-district tax', municipal: 'City tax', earned_income: 'Earned income tax', local_services: 'Local services tax' };
// Open lines with the same Desktop item that an expert can decide together (not the ones waiting for an
// address, and not one the employer sent back on purpose).
function sameLabelOpen(c, s) {
  return s.cases.filter((x) => x.item.item_id === c.item.item_id && x.stage === 'with_expert' && !x.decision.expert && !x.decision.sentToExpert && !NEEDS_EMPLOYER.has(x.reason));
}

function expertTools(c, s) {
  const id = domId(c.case_id);
  const homeStates = new Set([c.state, ...c.employee.addresses.map((x) => addressById(x.address_id)?.state), addressById(siteOf(c.employee, s.a).address_id).state]);
  const stateTaxes = [...s.a.idx.taxes.values()].filter((t) => homeStates.has(t.state));
  const expectedIds = new Set(c.employee.expected.list.map((x) => x.tax_id));
  const options = [...stateTaxes].sort((x, y) => Number(expectedIds.has(y.tax_id)) - Number(expectedIds.has(x.tax_id)))
    .map((t) => `<option value="${esc(t.tax_id)}">${esc(t.name)}${t.type === 'school_district' ? ` (SD ${esc(t.code)})` : ''}, ${t.rate}%${expectedIds.has(t.tax_id) ? ' - on expected list' : ''}</option>`).join('');
  const m = c.model;
  const suggestType = m?.tax_type;
  const typeGuess = { earned_income: 'Local earned income tax', local_services: 'Local services tax', municipal: 'Municipal income tax', school_district: 'School-district income tax' }[suggestType] ?? 'Other local tax';
  const basisGuess = suggestType === 'local_services' ? 'work' : suggestType === 'earned_income' ? 'higher' : suggestType === 'municipal' ? 'work' : 'home';
  const flat = c.item.calc.kind === 'flat_annual';
  // The action the hint recommends gets the primary style; a conflict has no default answer.
  const recommended = { not_expected: 'stop', duplicate: 'stop', state_conflict: 'stop', weak_signal: 'map', no_address: 'map', address_unresolved: 'map', work_location: 'map', ambiguous: 'map', employer_sent: 'map' }[c.reason] ?? null;
  const sel = (name, values, current) => `<select id="${name}-${id}" name="${name}">${values.map(([v, t]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  // The same Desktop item is usually on many employees. The expert decides what the label means once,
  // and each employee's own address picks the exact tax: the BRD's "label says which kind, address says which one".
  const same = sameLabelOpen(c, s);
  const types = [...new Set(stateTaxes.filter((t) => t.state === c.state).map((t) => t.type))];
  const sameBlock = same.length > 1 ? `<div class="same-label">
        <p class="tools-h">Decide the label once</p>
        <p><strong>"${esc(labelOf(c.item.label))}" is open on ${plural(same.length, 'line')}</strong>, one per employee. Say what it means; each employee's address picks the exact tax.</p>
        <div class="row">${types.map((t) => `<button class="btn${suggestType === t ? ' primary' : ''}" type="button" data-action="expert-label" data-item="${esc(c.item.item_id)}" data-as="${t}"${suggestType === t ? ' title="The model\'s closest entry"' : ''}>${esc(TYPE_NAME[t] ?? t)} for all ${same.length}</button>`).join('')}<button class="btn" type="button" data-action="expert-label" data-item="${esc(c.item.item_id)}" data-as="not_a_tax">Not a tax for all ${same.length}</button></div>
      </div>` : '';
  return `<section class="card tools-card" aria-label="Your decision">
    <div class="card-head"><span class="card-title">${icon('user')}Your decision</span><span class="meta">The employer confirms it, or their rules do</span></div>
    <div class="card-body tools">
      ${sameBlock}
      ${same.length > 1 ? '<p class="tools-h">Or decide this line only</p>' : ''}
      <div class="map-row">
        <label class="field" for="map-${id}">Map to a defined tax${stateTaxes.length ? `<select id="map-${id}"><option value="">Choose a tax</option>${options}</select>` : `<select id="map-${id}" disabled><option>No ${esc(stateName(c.state))} taxes in the catalogue yet</option></select>`}</label>
        <button class="btn${recommended === 'map' ? ' primary' : ''}" type="button" data-action="expert-map" data-id="${esc(c.case_id)}" data-select="map-${id}"${stateTaxes.length ? '' : ' disabled'}>Map</button>
      </div>
      <div class="row">
        <button class="btn" type="button" data-action="expert-nontax" data-id="${esc(c.case_id)}">Mark as not a tax</button>
        <button class="btn${recommended === 'stop' ? ' primary' : ' danger'}" type="button" data-action="expert-stop" data-id="${esc(c.case_id)}">Not owed: stop withholding</button>
      </div>
      <details${c.reason === 'shadow' ? ' open' : ''}>
        <summary>Create a structured custom entry</summary>
        <form data-action="expert-custom" data-id="${esc(c.case_id)}">
          <div class="form-grid">
            <label class="field" for="name-${id}">Tax name<input type="text" id="name-${id}" name="name" required value="${esc(c.item.label)}"></label>
            <label class="field" for="agency-${id}">Agency<input type="text" id="agency-${id}" name="agency" required value="${esc(c.item.agency)}"></label>
            <label class="field" for="type-${id}">Type${sel('type', [['Local earned income tax', 'Local earned income tax'], ['Local services tax', 'Local services tax'], ['Municipal income tax', 'Municipal income tax'], ['School-district income tax', 'School-district income tax'], ['Other local tax', 'Other local tax']], typeGuess)}</label>
            <label class="field" for="basis-${id}">Applies by${sel('basis', [['home', 'Home address'], ['work', 'Work location'], ['higher', 'Higher of home and work rate']], basisGuess)}</label>
            <label class="field" for="calc-${id}">Calculation${sel('calc', [['percent', 'Percent of wages'], ['flat', 'Flat amount a year']], flat ? 'flat' : 'percent')}</label>
            <label class="field" for="value-${id}">${flat ? 'Amount a year ($)' : 'Rate (%)'}<input type="number" id="value-${id}" name="value" step="0.01" min="0" required value="${flat ? c.item.calc.amount : c.item.calc.rate}"></label>
            <label class="field" for="frequency-${id}">Filing frequency${sel('frequency', [['Monthly', 'Monthly'], ['Quarterly', 'Quarterly'], ['Semi-monthly', 'Semi-monthly'], ['Annually', 'Annually']], c.item.deposit_frequency ?? 'Quarterly')}</label>
          </div>
          <p class="small muted">Marked employer-managed: QuickBooks will not pay or file it.</p>
          <div><button class="btn primary" type="submit">Save custom entry</button></div>
        </form>
      </details>
    </div>
  </section>`;
}

// ---------- 4 go live ----------

function viewGoLive(s) {
  const r = readiness(s.a, s.d);
  const live = s.d.live;
  const w2 = w2Preview(s.a, s.d);
  const liveCount = new Set(liveTaxes(s.a, s.d).map((t) => `${t.employee.employee_id}:${t.key}`)).size;
  const tie = r.tie;
  const bar = tie.rows.map((row) => `<span class="seg-${row.stage}" style="width:${tie.total ? (row.amount / tie.total) * 100 : 0}%" title="${esc(row.label)}: ${money(row.amount)}"></span>`).join('');
  // Each destination says in a line what it means, and the mistakes can be opened as a list.
  const help = {
    confirmed: 'The address says the person owes it. The same dollars now count under the matching Online tax.',
    moved_to_deduction: 'Not a tax, like union dues. It stays an after-tax deduction.',
    employer_managed: 'A tax Online payroll does not file. The employer keeps paying it.',
    stopped: 'Desktop took a local tax the person does not owe where they live and work. It stops from the first Online payroll; the employer asks the agency for a refund and pays it back to the employee.',
    with_expert: 'Waiting for an expert or for an answer from the employer. It moves once decided.',
    awaiting_employer: 'Proposed, waiting for the employer to confirm.',
  };
  const see = (row) => (row.stage === 'stopped' && canOpen('review') ? ` <button class="link-btn" type="button" data-action="see-lines" data-q="stopped">See the ${plural(row.count, 'line')}</button>` : '');
  const tieRows = tie.rows.map((row) => `<tr><td><span class="tie-k"><span class="swatch seg-${row.stage}"></span>${esc(row.label)}</span><span class="tie-help">${esc(help[row.stage] ?? '')}${see(row)}</span></td><td class="num">${row.count}</td><td class="num">${money(row.amount)}</td></tr>`).join('');
  const accounts = r.accounts.map((a, i) => `<tr>
      <td><strong>${esc(a.agency)}</strong><div class="small muted">${a.taxes.map(esc).join(', ')}</div></td>
      <td><label class="sr-only" for="acct-${i}">Account number for ${esc(a.agency)}</label><input type="text" id="acct-${i}" value="${esc(a.account)}" placeholder="Required" data-action="account" data-agency="${esc(a.agency)}" data-field="account"${live ? ' disabled' : ''}></td>
      <td><label class="sr-only" for="freq-${i}">Deposit frequency for ${esc(a.agency)}</label><select id="freq-${i}" data-action="account" data-agency="${esc(a.agency)}" data-field="frequency"${live ? ' disabled' : ''}>${['', ...FREQUENCIES].map((f) => `<option value="${f}"${f === a.frequency ? ' selected' : ''}>${f || 'Choose'}</option>`).join('')}</select></td>
      <td class="small muted">${a.source ? `From ${esc(a.source)}` : 'Enter from the agency letter'}</td>
    </tr>`).join('');
  return `<div class="page-head"><h1>Go live</h1>
    <p class="lede">Confirmed taxes switch on with the first Online payroll.</p></div>
    ${live ? `<div class="live-banner"><span>Live since ${new Date(s.d.liveAt).toLocaleString()}: ${plural(liveCount, 'employee tax', 'employee taxes')} switched on.</span><div class="row"><button class="btn quiet" type="button" data-action="undo-live">Undo go-live (demo)</button></div></div>` : ''}
    <div class="two-col">
      <section class="panel section" aria-labelledby="checks-h">
        <h2 id="checks-h">Checks before the first cloud payroll</h2>
        <ul class="checks">${r.checks.map((c) => `<li>${mark(c.pass ? 'pass' : 'fail')}<div><strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span></div></li>`).join('')}</ul>
        ${r.expert.length ? (() => {
          const info = r.expert.filter(waitsForEmployer).length;
          const parts = [info ? `${info} ${info === 1 ? 'waits' : 'wait'} for ${state.role === 'owner' ? 'your answers' : 'the employer\'s answers'}` : '', r.expert.length - info ? `${r.expert.length - info} ${r.expert.length - info === 1 ? 'is' : 'are'} with an expert` : ''].filter(Boolean);
          return `<p class="golive-off">${icon('info')}<span>${plural(r.expert.length, 'line is', 'lines are')} not decided yet and will stay off until they are: ${parts.join(', ')}.${info && canOpen('review') ? ' <a href="#review">Open To do</a>' : ''}</span></p>`;
        })() : ''}
        ${live ? '' : `<div class="row"><button class="btn primary" type="button" data-action="go-live"${r.ready ? '' : ' disabled aria-describedby="golive-why"'}>Go live with confirmed taxes</button>${r.ready ? '' : `<span class="small muted" id="golive-why">Available once all ${r.checks.length} checks pass.</span>`}</div>`}
      </section>
      <section class="panel section" aria-labelledby="tie-h">
        <h2 id="tie-h">Where every Desktop dollar goes</h2>
        <div><p class="big">${bigMoney(tie.accounted)}</p><p class="small muted">of ${money(tie.total)} local tax withheld in Desktop this year has a destination.</p></div>
        <div class="tie-bar" role="img" aria-label="Share of Desktop local tax dollars by destination">${bar}</div>
        <div class="table-wrap"><table><thead><tr><th>Destination</th><th class="num">Lines</th><th class="num">Amount</th></tr></thead><tbody>${tieRows}</tbody></table></div>
      </section>
    </div>
    <section class="section" aria-labelledby="acct-h">
      <div class="section-head"><h2 id="acct-h">Agency accounts</h2><p>Filled from Desktop where it had them.</p></div>
      ${r.accounts.length ? `<div class="table-wrap"><table class="stacked"><thead><tr><th>Agency</th><th>Account number</th><th>Deposit frequency</th><th>Source</th></tr></thead><tbody>${accounts}</tbody></table></div>` : '<div class="empty"><span>No taxes are confirmed yet, so no agency accounts are needed.</span></div>'}
    </section>
    ${live ? reconcileSection(s) : ''}
    ${w2Section(s, w2)}`;
}

function w2Section(s, w2) {
  const dm = desktopMonths(s.a.company);
  const cm = cloudMonths(s.a.company);
  const span = dm.length ? `Desktop withholding relabelled for ${monthSpan(dm)}, plus Online payroll from ${monthSpan([cm[0]])}.` : 'The company moves in January, so every month comes from Online payroll.';
  const shown = w2.filter((w) => w.lines.length);
  const waiting = w2.length - shown.length;
  const W2_SHOWN = 3;
  const body = shown.length
    ? `<div class="w2-grid">${shown.slice(0, more.w2 ? undefined : W2_SHOWN).map(w2Card).join('')}</div>${shown.length > W2_SHOWN ? `<div class="row"><button class="btn quiet" type="button" data-action="show-more" data-key="w2">${more.w2 ? `Show the first ${W2_SHOWN}` : `Show all ${shown.length} employees`}</button></div>` : ''}${waiting ? `<p class="small muted">${plural(waiting, 'employee has', 'employees have')} no confirmed local tax yet, so no local boxes are shown for them.</p>` : ''}`
    : `<div class="empty"><strong>No local boxes yet.</strong><span>They appear once taxes are confirmed.</span></div>`;
  return `<section class="section" aria-labelledby="w2-h">
      <div class="section-head"><h2 id="w2-h">W-2 local boxes</h2><p>Projected for 2026: ${esc(span)}</p></div>
      ${body}
    </section>`;
}

function w2Card(w) {
  const boxes = w.lines.map((l) => `
    <div><span class="lbl">18 Local wages, tips, etc.</span><span class="val">${money(l.wages)}</span></div>
    <div><span class="lbl">19 Local income tax</span><span class="val">${money(l.total)}</span><span class="split">Desktop ${money(l.desktop)}</span><span class="split">Online ${money(l.cloud)}</span></div>
    <div><span class="lbl">20 Locality name</span><span class="val">${esc(l.box20)}</span>${l.employerManaged ? '<span class="split">Employer-managed</span>' : ''}</div>`).join('');
  return `<article class="w2" data-employee="${esc(w.employee.employee_id)}" aria-label="W-2 local boxes for ${esc(w.employee.name)}">
    <div class="w2-top"><span>Form W-2, local boxes</span><span>2026 projection</span></div>
    <div class="w2-name">${esc(w.employee.name)}</div>
    ${w.lines.length ? `<div class="w2-boxes">${boxes}</div>` : '<div class="w2-empty">No confirmed local tax yet.</div>'}
    ${w.notes.length ? `<div class="w2-notes">${w.notes.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
  </article>`;
}

// ---------- 5 reconcile ----------

// After go-live: withholding on the first Online payroll and quarter, compared with what the addresses say.
function reconcileSection(s) {
  const cm = cloudMonths(s.a.company);
  const first = monthSpan([cm[0]]);
  const period = cm.length <= 3 ? 'first quarter' : 'Online months';
  const head = `<div class="section-head"><h2 id="rec-h">Reconcile</h2><p>After the first payroll and the first quarter.</p></div>`;
  if (!s.d.reconciled) return `<section class="section" aria-labelledby="rec-h">${head}<div class="empty"><span>The demo simulates the first Online payroll (${first}) and ${monthSpan(cm)} at the official rates.</span><button class="btn primary" type="button" data-action="run-reconcile">Run first payroll and quarter</button></div></section>`;
  const r = reconcile(s.a, s.d);
  const names = (list) => (list.length > 4 ? `${list.slice(0, 3).map(esc).join(', ')} and ${list.length - 3} more` : list.map(esc).join(', '));
  const rows = r.rows.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.agency)}</div></td><td>${names(x.employees)}</td><td class="num">${money(x.firstPayroll)}</td><td class="num">${money(x.quarter)}</td><td>${pill(x.payer, x.qb ? 'good' : 'info')}</td></tr>`).join('');
  const fails = r.flags.filter((f) => f.tone === 'fail').length;
  return `<section class="section" aria-labelledby="rec-h">${head}
    <div class="wl-tiles">
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('landmark')}Taxes withheld</span></div><span class="n">${r.rows.length}</span><p>${r.rows.length === 1 ? 'local tax' : 'local taxes'} on Online paychecks</p></div>
      <div class="wl-tile good"><div class="tile-head"><span class="t">${icon('calendar')}Withheld in ${esc(monthSpan(cm))}</span></div><span class="n">${bigMoney(r.totals.quarter)}</span><p>at the official rates</p></div>
      <div class="wl-tile ${fails ? 'bad' : 'good'}"><div class="tile-head"><span class="t">${icon(fails ? 'alert' : 'check')}Expected but missing</span></div><span class="n">${fails}</span><p>${fails ? `${plural(fails, 'expected tax', 'expected taxes')} not withheld` : 'No expected tax missing'}</p></div>
    </div>
    <div class="table-wrap"><table class="stacked"><thead><tr><th>Tax</th><th>Employees</th><th class="num">First payroll (${first})</th><th class="num">${period === 'first quarter' ? 'First quarter' : 'Online months'} (${monthSpan(cm)})</th><th>Who pays and files</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${flagSummary(r.flags)}
    <p class="small muted">${s.a.company.plan === 'Core' ? 'Core plan: the employer pays and files local taxes.' : 'QuickBooks pays and files the taxes it supports on this plan.'}</p>
    </section>`;
}

// Reconcile notes, one row per kind with a count and the dollars, and every note in a fold.
// A business with 150 people has hundreds of notes; nobody reads them one by one.
const FLAG_KIND = {
  missing: 'Expected tax not withheld',
  with_expert: 'Still with an expert, nothing withheld',
  not_owed: 'Withheld but not owed: correction with the agency',
  rate_over: 'Past withholding too high: new paychecks use the official rate',
  rate_under: 'Past withholding too low: new paychecks use the official rate',
  employer_managed: 'Employer-managed: confirm you paid and filed it',
  optional_off: 'Optional home-city tax not set up (allowed)',
  optional_kept: 'Optional courtesy withholding kept',
};
function flagSummary(flags) {
  if (!flags.length) return '';
  const kinds = new Map();
  for (const f of flags) {
    const k = kinds.get(f.kind) ?? { kind: f.kind, tone: f.tone, n: 0, amount: 0 };
    k.n += 1;
    k.amount += f.amount ?? 0;
    kinds.set(f.kind, k);
  }
  const order = { fail: 0, warn: 1, info: 2 };
  const rows = [...kinds.values()].sort((a, b) => order[a.tone] - order[b.tone] || b.n - a.n)
    .map((k) => `<tr><td>${mark(k.tone)}<span class="flag-k">${esc(FLAG_KIND[k.kind] ?? k.kind)}</span></td><td class="num">${num(k.n)}</td><td class="num">${k.amount ? money(k.amount) : '<span class="muted">-</span>'}</td></tr>`).join('');
  return `<section class="card" aria-label="Reconcile notes">
    <div class="table-wrap"><table class="flag-table"><thead><tr><th>Note</th><th class="num">Lines</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${fold('list', `Every note (${num(flags.length)})`, `<ul class="marks">${flags.map((f) => `<li>${mark(f.tone)}<span>${esc(f.text)}</span></li>`).join('')}</ul>`)}
  </section>`;
}

// ---------- model governance ----------

const THRESHOLD_FIELDS = [
  { key: 'silhouetteFloor', label: 'Silhouette floor', help: 'State model quality needed before suggestions show.', min: 0, max: 1, step: 0.01, show: (v) => v.toFixed(2) },
  { key: 'precisionTarget', label: 'Precision target', help: 'Share of confident suggestions that must match the expert.', min: 0, max: 1, step: 0.01, show: (v) => pct(v, 0) },
  { key: 'minSample', label: 'Minimum labelled sample', help: 'Expert-labelled labels needed per state.', min: 0, max: 500, step: 1, show: (v) => String(v) },
  { key: 'itemFloor', label: 'Label confidence floor', help: 'A label below this silhouette goes to an expert.', min: 0, max: 1, step: 0.01, show: (v) => v.toFixed(2) },
];

function thresholdPanel(s) {
  const t = { ...DEFAULT_THRESHOLDS, ...state.settings.thresholds };
  const changed = Object.keys(state.settings.thresholds ?? {}).length > 0;
  const locked = s.d.live;
  const fields = THRESHOLD_FIELDS.map((f) => `<label class="field" for="th-${f.key}">${f.label}
      <input type="number" id="th-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${t[f.key]}" data-action="threshold" data-key="${f.key}"${locked ? ' disabled' : ''}>
      <span class="small muted">${f.help} Default: ${f.show(DEFAULT_THRESHOLDS[f.key])}.</span></label>`).join('');
  return `<section class="panel section" aria-labelledby="th-h">
    <div class="section-head"><h2 id="th-h">Gate thresholds</h2><p>A value equal to the threshold passes.${locked ? ' Locked: this business is live.' : ''}</p></div>
    <div class="threshold-grid">${fields}</div>
    ${changed ? `<div class="row"><span class="pill warn"><span class="dot"></span>Changed from the defaults</span><button class="btn quiet" type="button" data-action="reset-thresholds"${locked ? ' disabled' : ''}>Back to defaults</button></div>` : ''}
  </section>`;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- Ask AI ----------

// An answer as the chat shows it: the Recommendation / Confidence / Why / Check shape, bullets and bold.
function aiText(text) {
  const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  for (const raw of String(text).split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const bullet = l.match(/^[-•*]\s+(.*)$/);
    if (bullet) { (list ??= []).push(`<li>${inline(bullet[1])}</li>`); continue; }
    flush();
    const m = l.replace(/^\*\*(.+?)\*\*/, '$1').match(/^(recommendation|confidence|why|check)\s*:\s*(.*)$/i);
    if (!m) { out.push(`<p>${inline(l)}</p>`); continue; }
    const label = m[1].toLowerCase();
    if (label === 'confidence') {
      const level = (m[2].match(/^\s*(high|medium|low)/i)?.[1] ?? '').toLowerCase();
      const rest = m[2].replace(/^\s*(high|medium|low)\s*[:—–-]?\s*/i, '');
      out.push(`<p class="ai-conf">${level ? pill(`${level[0].toUpperCase()}${level.slice(1)} confidence`, { high: 'good', medium: 'warn', low: 'bad' }[level]) : ''}<span>${inline(rest)}</span></p>`);
    } else if (label === 'why') {
      out.push(m[2] ? `<p><b>Why</b> ${inline(m[2])}</p>` : '<p class="ai-label">Why</p>');
    } else out.push(`<p class="ai-${label}"><b>${label === 'check' ? 'Check' : 'Recommendation'}</b> ${inline(m[2])}</p>`);
  }
  flush();
  return out.join('');
}

// Who answers: Claude inside a claude.ai viewer; elsewhere a model the user connected with their own key;
// otherwise the built-in assistant.
function useKey(cfg) {
  const ok = cfg && cfg.model && (cfg.key || PROVIDERS[cfg.provider]?.noKey);
  ai.via = ok ? 'key' : null;
  ai.cfg = ok ? cfg : null;
  ai.label = ok ? configLabel(cfg) : '';
  ai.state = ai.via ? 'on' : 'off';
}
async function connectAI() {
  ai.hosted = Boolean(window.claude?.use);
  if (ai.hosted) {
    try { ai.sample = await window.claude.use('sample'); } catch { ai.sample = null; }
    if (ai.sample) { ai.via = 'claude'; ai.label = 'Claude'; ai.state = 'on'; } else { ai.via = null; ai.state = 'off'; }
  } else useKey(loadConfig());
  render();
}
// The chat connected or removed a key.
function aiConnected(cfg) {
  if (ai.hosted) return;
  useKey(cfg);
  render();
}

// ---------- Ask AI: what the chat sees, and what it tells you first ----------
// When the chat opens it gives a short briefing for the person and the screen: the owner's next step, the
// record open on To do or in the expert queue (the built-in opinion), the go-live checks, or what an admin
// screen shows. It changes as they move around. Then they ask questions; a connected model answers from the
// same facts, or the built-in assistant does.

const VIEW_NAMES = { move: 'Move', review: 'To do', expert: 'Expert queue', golive: 'Go live', analysis: 'Engine', model: 'Model', lab: 'ML Lab', data: 'Data', scenarios: 'Scenarios', audit: 'Log' };
const APP_GUIDE = `How the app works:
- Business owner (the customer): Move (start, check, move, summary), To do (one list of what needs the employer: home addresses, where someone works and agency account numbers, each answered inside its record, plus lines to confirm), Go live (four checks, dollar tie-out, agency accounts, W-2 preview, reconcile).
- Payroll tax expert (Intuit staff): a queue of the lines the rules could not settle; one decision per unclear label; the employer confirms.
- Admin (Intuit staff): Engine (what each step found), Model (clustering gates and "Try the clustering"), ML Lab (the clustering tested on 1,200 labels), Data (the SQLite database, 7 tables), Scenarios (checks on six test files), Log (audit trail).
- The engine lists each employee's expected local taxes from the home and work addresses. A Desktop item with a real Law ID maps straight to its tax; an item the employer created (Law ID 177 or 0) is read by a clustering model (TF-IDF words and letter trigrams, average linkage, silhouette score). Every Desktop line goes to a local tax, to deductions (not a tax), or to a person. Rules the employer approved settle most lines; nothing switches on until the employer confirms.`;

const CHAT_SUGGESTIONS = {
  signin: ['What does this app do?', 'Which role should I start with?'],
  move: ['What happens when I move?', 'What is waiting for me?', 'What does this app do?'],
  review: ['What is waiting for me?', 'Why does it matter where someone works?', 'Why do some lines need an address?'],
  expert: ['How do I decide an unclear label?', 'Why are these lines with an expert?'],
  golive: ['Am I ready to go live?', 'What is the dollar tie-out?'],
  analysis: ['Explain the engine steps', 'What does "to a person" mean?'],
  model: ['How does the clustering work?', 'What is a silhouette score?', 'Why the 0.25 floor?'],
  lab: ['What does the ML Lab prove?', 'Clustering or word matching: which is better?'],
  data: ['Explain the seven tables', 'What is a Law ID?'],
  scenarios: ['What do the scenarios check?'],
  audit: ['Who decided the most lines?'],
};

// The record the person opened on To do or in the expert queue. Until they open one, the briefing is about
// the whole screen (the one shown first on a computer is only the top of the list).
function chatRecord(s, view) {
  if (!s || (view !== 'review' && view !== 'expert') || !state.detailOpen) return null;
  const key = state.sel[view];
  const company = s.a.company;
  const c = key?.startsWith('c|') ? s.cases.find((x) => `c|${x.case_id}` === key) : null;
  if (c) {
    const decided = c.decision.expert ? (c.decision.expert.auto ? `stopped by a rule the employer approved: ${expertText(c)}` : `expert decided: ${expertText(c)}`) : c.decision.employer ? (c.decision.employer.auto ? 'confirmed by a rule the employer approved' : 'confirmed by the employer') : '';
    const facts = lineFacts(c, { company, addressById, taxByLaw: (law) => s.a.idx.taxByLaw.get(law), view, stage: waitsForEmployer(c) ? waitText(c) : STAGE_LABEL[c.stage], next: nextStep(c, view, s.d.live), decided });
    return { key, c, facts, op: lineOpinion(facts, c), title: `${c.employee_name}, "${labelOf(c.item.label)}"` };
  }
  const g = key?.startsWith('g|') ? s.a.gaps.find((x) => `g|${x.gap_id}` === key) : null;
  if (g) {
    const e = s.a.employees.find((x) => x.employee_id === g.employee_id);
    const st = gapStage(g, s.d, s.cases);
    const stage = st === 'awaiting_employer' ? 'Waiting for the employer' : st === 'added' ? (s.d.gaps[g.gap_id]?.auto ? 'Added by a rule the employer approved' : 'Added by the employer') : 'Covered by an expert mapping';
    const next = s.d.live ? 'This company is live, so decisions are locked.' : st === 'awaiting_employer' ? 'Add it from the first Online payroll.' : 'Nothing to do.';
    const facts = gapFacts(g, e, { company, addressById, view, stage, next });
    return { key, g, facts, op: gapOpinion(facts), title: `${g.employee_name}, ${g.tax.name} not withheld` };
  }
  return null;
}

// What waits for the employer, in words: "3 home addresses, 2 work locations and 1 agency account".
function employerWaits(s) {
  const m = missingInfo(s);
  const decide = s.awaiting;
  return {
    missing: m.addresses.length + m.work.length + m.accounts.length,
    text: listAnd([
      m.addresses.length ? plural(m.addresses.length, 'home address', 'home addresses') : '',
      m.work.length ? `where ${plural(m.work.length, 'person works', 'people work')}` : '',
      m.accounts.length ? plural(m.accounts.length, 'agency account number') : '',
      decide ? plural(decide, 'item to confirm', 'items to confirm') : '',
    ].filter(Boolean)),
  };
}


function chatBrief({ s, view, record }) {
  if (!state.role || !s) {
    return '**Welcome.** This prototype moves one business\'s local payroll taxes from QuickBooks Desktop to Online payroll.\n- **Business owner**: moves the business and gives what only they know.\n- **Payroll tax expert**: decides the lines the rules cannot.\n- **Admin**: sees how the engine, the model and the data work.\nFor the demo, start as the Business owner.';
  }
  const co = s.a.company;
  const wait = employerWaits(s);
  const withExpert = s.expert - s.info;
  if (record) {
    const also = view === 'review' && wait.text ? `\nAlso waiting for you: ${wait.text}.` : view === 'expert' && withExpert > (record.c?.stage === 'with_expert' ? 1 : 0) ? `\n${plural(withExpert, 'line is', 'lines are')} open in your queue.` : '';
    return opinionText(record.op) + also;
  }
  if (view === 'move') {
    if (!s.d.autoRun && !s.d.live) {
      const run = automate(s.a, s.d, policyOf(s.d));
      const st = automationStats(s.a, run.decisions);
      const left = openExceptions(s.a, run.decisions);
      const expert = left.filter((x) => x.owner === 'expert').length;
      const mine = left.filter((x) => x.owner !== 'expert');
      return `**${co.name} is ready to move.** ${num(co.employees.length)} employees and ${plural(s.cases.length, 'local-tax line')} in Desktop.\n- Your rules would settle **${st.auto} of ${st.total}** items by themselves.\n- ${mine.length ? `For you: ${needText(mine).replace(/ needs?$/, '')}.` : 'Nothing for you.'} ${expert ? `For an expert: ${plural(expert, 'item')}.` : ''}\nNext: press **Move to Online payroll**.`;
    }
    const st = automationStats(s.a, s.d);
    const next = s.d.reconciled ? 'nothing. The move is done.' : s.d.live ? 'reconcile after the first Online payroll, on **Go live**.'
      : wait.text ? 'open **To do** and answer what needs you; the lines waiting for it finish by themselves.'
        : withExpert ? 'an expert decides; then you confirm.' : 'open **Go live**.';
    return `**${st.auto} of ${st.total} items settled by rule.**\n- Waiting for you: ${wait.text || 'nothing'}.\n- With an expert: ${withExpert ? plural(withExpert, 'line') : 'nothing'}.\nNext: ${next}`;
  }
  if (view === 'review') {
    if (!wait.text && !withExpert) return '**Nothing needs you.** Every line is decided. Next: open **Go live**.';
    const m = missingInfo(s);
    const lines = [
      m.addresses.length ? `- **${plural(m.addresses.length, 'home address', 'home addresses')}**: a school-district tax follows the home, so those lines wait for it.` : '',
      m.work.length ? `- **Where ${plural(m.work.length, 'person works', 'people work')}**: Desktop withholds their home town's city tax, not the work site's. Only you know which is right.` : '',
      m.accounts.length ? `- **${plural(m.accounts.length, 'agency account number')}**: needed to pay and file ${listAnd(m.accounts.map((a) => a.agency))}.` : '',
      s.awaiting ? `- **${plural(s.awaiting, 'item')} to confirm** in the list.` : '',
      withExpert ? `- ${plural(withExpert, 'line is', 'lines are')} with an expert; you confirm after.` : '',
    ].filter(Boolean);
    return `**What needs you**\n${lines.join('\n')}\n${wait.missing ? 'Each one opens with its form, under **Needs you**; the lines waiting for it finish by themselves.' : 'Open a line to see my opinion on it.'}`;
  }
  if (view === 'expert') {
    const open = s.cases.filter((c) => c.stage === 'with_expert' && !waitsForEmployer(c));
    if (!open.length) return `**Your queue is empty.**${s.info ? ` ${plural(s.info, 'line waits', 'lines wait')} for the employer (an address or a work location); you can still map them.` : ''}`;
    const byLabel = new Map();
    for (const c of open) byLabel.set(c.item.label, [...(byLabel.get(c.item.label) ?? []), c]);
    const rows = [...byLabel].map(([label, cs]) => `- "${labelOf(label)}": ${plural(cs.length, 'line')} (${listAnd([...new Set(cs.map((c) => (REASON_SHORT[c.reason] ?? c.reason).toLowerCase()))])})`);
    return `**${plural(open.length, 'line waits', 'lines wait')} for you**, under ${plural(byLabel.size, 'label')}:\n${rows.join('\n')}\nOne decision per label covers all its lines; each person's address picks the exact tax.`;
  }
  if (view === 'golive') {
    if (s.d.live) return `**Live.** Confirmed taxes switch on with the first Online payroll.\nNext: ${s.d.reconciled ? 'nothing. Reconciled.' : 'reconcile after the first payroll and the first quarter.'}`;
    const r = readiness(s.a, s.d);
    const fails = r.checks.filter((c) => !c.pass);
    return `**${fails.length ? `${fails.length} of ${r.checks.length} checks still open.` : 'Ready to go live.'}**\n${r.checks.map((c) => `- ${c.pass ? 'Done' : '**Open**'}: ${c.label}. ${c.detail}`).join('\n')}\nNext: ${fails.length ? (fails.some((c) => c.id === 'accounts' || c.id === 'employer') ? 'answer what needs you on **To do**.' : 'an expert decides what is left.') : 'press **Go live with confirmed taxes**.'}`;
  }
  if (view === 'analysis') return `**What the engine found for ${co.name}**\n- ${plural(s.cases.length, 'Desktop line')}: ${s.routes.local_tax} local tax, ${s.routes.not_a_tax} not a tax, ${s.routes.not_in_database} to a person.\n- ${plural(s.a.gaps.length, 'expected tax', 'expected taxes')} nobody withheld.\nOpen a step to see what it checked and why.`;
  if (view === 'model') {
    const m = s.a.models.OH;
    return m ? `**Ohio label model:** ${m.k} clusters, silhouette ${m.silhouette.toFixed(2)}, ${m.mode === 'assisted' ? 'suggestions shown' : 'shadow mode'}.\n- A label below ${m.thresholds.itemFloor} confidence goes to a person.\nTry a label of your own in **Try the clustering**.` : '**No Ohio model** was built for this business.';
  }
  if (view === 'lab') return '**The ML Lab** tests the clustering on made-up labels whose answers are known, and compares it with simple word matching. Run it and compare the precision.';
  if (view === 'data') return '**One SQLite database per migration, seven tables.**\n- From the Desktop file: company, employees, payroll_items, desktop_lines.\n- From the address lookup: addresses, taxes (keyed by Law ID).\n- Ours: results.\nRun a read-only query below.';
  if (view === 'scenarios') return `**${scenarioCount()} scenarios pass.** They run live on six small test files, from file checks to reconcile.`;
  if (view === 'audit') {
    const mine = state.audit.filter((x) => x.company_id === state.companyId);
    return mine.length ? `**${plural(mine.length, 'log entry', 'log entries')}** for ${co.name.replace(/\.$/, '')}. Latest: ${mine[0].actor}, ${mine[0].action.toLowerCase()}${mine[0].target ? `: ${mine[0].target}` : ''}.` : '**Nothing logged yet.** Every decision is logged here with its time and role.';
  }
  return `**${VIEW_NAMES[view] ?? 'This screen'}.** Ask me about it.`;
}

// Which briefing applies: the chat posts a new one when this changes.
function chatKey() {
  if (!state.role) return 'signin';
  const view = currentView();
  const rec = (view === 'review' || view === 'expert') && state.detailOpen ? state.sel[view] ?? '' : '';
  return `${state.role}|${state.companyId}|${view}|${rec}`;
}

function chatContext() {
  const role = state.role ? ROLES[state.role].label : 'nobody (the sign-in page)';
  const view = state.role ? currentView() : null;
  let s = null;
  try { s = state.role ? summary() : null; } catch { s = null; }
  const record = chatRecord(s, view);
  let where = state.role ? VIEW_NAMES[view] : 'Sign in';
  if (record) where = `${VIEW_NAMES[view]}: ${record.title}`;
  let facts = record?.facts ?? null;
  if (s && view === 'model') {
    const m = s.a.models.OH;
    if (m) facts = { state: 'Ohio', silhouette: m.silhouette.toFixed(3), clusters: m.k, precision: pct(m.precision), labelled_examples: m.poolSize, mode: m.mode === 'assisted' ? 'suggestions shown' : 'shadow mode', gates: m.gates, label_confidence_floor: m.thresholds.itemFloor, cluster_names: m.clusters.map((k) => `${k.name} (${k.size})`) };
  }
  if (s && (view === 'review' || view === 'move') && !record) {
    const m = missingInfo(s);
    facts = { missing_information: { home_addresses: m.addresses.map((x) => x.e.name), where_someone_works: m.work.map((x) => ({ name: x.e.name, ...(lineFacts(x.c, { company: s.a.company, addressById, taxByLaw: (law) => s.a.idx.taxByLaw.get(law), view, stage: waitText(x.c), next: '', decided: '' }).engine.work_question ?? {}) })), agency_accounts: m.accounts.map((a) => a.agency) } };
  }
  if (s && view === 'golive') facts = { checks: readiness(s.a, s.d).checks.map((c) => ({ check: c.label, done: c.pass, detail: c.detail })) };
  let business = '';
  if (s) {
    const co = s.a.company;
    const items = s.cases.length + s.a.gaps.length;
    const action = s.awaiting + s.expert;
    business = `Business being moved: ${co.name} (${co.plan} plan), ${num(s.a.employees.length)} employees, ${num(s.cases.length)} Desktop local-tax lines and ${s.a.gaps.length} expected taxes nobody withheld. First Online payroll: ${MONTHS_LONG[co.migration_month - 1]}. Status: ${s.status}. Settled: ${items - action} of ${items}. Waiting for the employer to decide: ${s.awaiting}. Waiting for missing information from the employer: ${employerWaits(s).missing}. With an expert: ${s.expert - s.info}. The engine's routes: ${s.routes.local_tax} local tax, ${s.routes.not_a_tax} not a tax, ${s.routes.not_in_database} to a person.`;
  }
  const prompt = () => `You are "Payroll AI", the assistant built into a student prototype (SPJIMR, Business in the Digital Age, Case 19) that moves one business's local payroll taxes (Ohio city and school-district income taxes) from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Every person and business in it is made up; Ohio tax rates are real. It is not affiliated with Intuit.

${RULES}

${APP_GUIDE}

Right now the person is signed in as: ${role}. Screen: ${where}.
${business}
${facts ? `Facts of what is on screen (JSON):\n${JSON.stringify(facts, null, 1)}` : ''}

How to answer: plain text, short (under 120 words unless asked for more); bullets starting with "- " are fine. For anything about this business, its people, lines or numbers, use only the facts above and say so when they do not cover the question. For general ideas (Law ID, clustering, silhouette, local taxes, digital transformation, how a migration like this works) explain simply. Never invent rates, addresses, laws or dollar amounts. This is not tax advice.`;
  const suggestions = record ? aiSuggestions(record.facts, record.c).slice(0, 3) : CHAT_SUGGESTIONS[state.role ? view : 'signin'] ?? [];
  const check = record ? `Check ${record.title} for me and give your own opinion.\n${opinionFormat(record.facts)}` : s ? 'Look at this screen and tell me, in under 100 words, what matters most and what I should do next.' : null;
  return { key: chatKey(), where, brief: () => chatBrief({ s, view, record }), prompt, suggestions, check, builtIn: (q) => chatBuiltIn(q, { s, view, record }) };
}

// The built-in chat answers: the open record first, then common questions about the app.
function chatBuiltIn(q, { s, view, record }) {
  const t = ` ${String(q).toLowerCase()} `;
  const counts = () => {
    const withExpert = s.expert - s.info;
    const wait = employerWaits(s);
    return `${s.a.company.name}: ${s.status}. ${wait.text ? `Waiting for you: ${wait.text}. ` : ''}${withExpert ? `${plural(withExpert, 'line')} with an expert. ` : ''}${!wait.text && !withExpert ? 'Nothing is waiting. ' : ''}Go live needs four checks: every line decided, every expected tax handled, every Desktop dollar given a destination, and every agency account complete.`;
  };
  if (s && /how many|status|progress|overall|in total|whole business/.test(t)) return counts();
  if (record) {
    if (/explain|what should|what do i do|summar|simply|opinion|check this/.test(t)) return opinionText(record.op);
    const a = builtInAnswer(record.facts, q);
    if (a) return a;
    if (/why|wait|this line|this one|what happens|mean/.test(t)) return opinionText(record.op);
  }
  if (/visa|india|immigra|citizen|nationalit/.test(t)) return 'Local taxes here follow only where a person lives and works in Ohio, and the months they are on the payroll; nationality or visa does not change them. Federal and state tax residency for someone new to the US is outside this prototype.';
  if (/what does this app|what is this|about this app|purpose|what can you do/.test(t)) return 'It moves one business\'s local payroll taxes (Ohio city and school-district taxes) from QuickBooks Desktop to Online payroll. For every employee it works out the taxes owed from the home and work addresses, reads unclear Desktop labels with a clustering model, and sends each line to a local tax, to deductions or to a person. Rules the employer approves settle most lines; nothing switches on until the employer confirms.';
  if (/which role|start with|demo|where do i start/.test(t)) return 'Start as the Business owner: Move, Get started, Move to Online payroll. Answer what needs you on To do. Then the Payroll tax expert decides the unclear labels once. Back as the owner, Go live shows everything settled and reconciled. The Admin screens explain the engine, the model and the data.';
  if (/where (someone|they|he|she|people) works?|work location|works? from home|remote/.test(t)) return 'A city tax is owed where the work is done: the work site, or the home for someone who works from home. When Desktop withholds the city tax of the town where a person lives instead of the work site\'s, only the employer knows which is right. They answer on To do: from home, the home town\'s tax stays; at the site, the site\'s tax is added and the home town\'s becomes optional.';
  if (/account number|agency account|deposit/.test(t)) return 'Online payroll pays and files each local tax with its agency, so every agency needs an account number and a deposit frequency. Most come across from the Desktop items; one that is missing is asked for on To do.';
  if (/law ?id|\b177\b/.test(t)) return 'A Law ID is the unique number of each tax (the primary key of the taxes table). A Desktop item QuickBooks already knows carries its tax\'s Law ID and maps straight to it. An item the employer created carries 177 (or 0), which names no tax, so the address and the label decide. The migration turns every 177 into a real Law ID.';
  if (/cluster|silhouette|model|floor|word matching|ml lab/.test(t)) {
    const m = s?.a.models.OH;
    return `Labels are cleaned (short forms spelled out, place names removed), turned into numbers (TF-IDF on words plus letter trigrams), and grouped bottom-up by average linkage. The number of groups is the one with the best silhouette score: (b - a) / max(a, b), where a is a label's distance to its own group and b to the nearest other group.${m ? ` Ohio: ${m.k} clusters, silhouette ${m.silhouette.toFixed(2)}.` : ''} A new label below 0.25 is not confident, so a person decides. The ML Lab retests this on 1,200 labels against simple word matching.`;
  }
  if (/table|database|schema|sql/.test(t)) return 'Seven tables, one database per migration. From the Desktop file: company, employees, payroll_items, desktop_lines. From the address lookup: addresses, taxes (keyed by Law ID). Our result: results (where each Desktop line went, its Law ID and who decided). The Data screen shows the keys and lets you run read-only queries.';
  if (/scenario/.test(t)) return `${scenarioCount()} scenarios run live on six small test files: file checks, finding the state, expected taxes, clustering and gates, routing, gaps, decisions, go-live checks, W-2 history, reconcile, joiners and leavers, and automation.`;
  if (s && /waiting|settled|left|ready|go live|tie.?out|for me|check this|matters/.test(t)) return s && view && !record && /check this|matters/.test(t) ? chatBrief({ s, view, record }) : counts();
  if (/expert|unclear|decide/.test(t)) return 'The expert sees only what the rules could not settle: unclear labels, taxes the address does not support, conflicts. One decision covers every employee with the same label, and each employee\'s address picks the exact tax. The employer confirms it.';
  if (/address/.test(t)) return 'A school-district tax is owed where the person lives, so a line with no usable home address waits for the employer to add it (on To do, inside the line). The engine then checks the line again by itself.';
  return `I'm the built-in assistant, so I answer common questions about this screen and the records. ${ai.hosted ? 'Allow Claude when asked to get real AI answers.' : 'Connect an AI model (the sliders button at the top of this chat) to ask anything.'}`;
}

// ---------- try the clustering (admin, Model page) ----------
// Type a Desktop label, say where the person lives and works, and run it through the same engine as
// everything else: the clean-up, the closeness to each cluster, the confidence, and the tax the address picks.

const TRY_EXAMPLES = [
  { text: 'A new school-tax label', label: 'Sch Dist Wthld', law: '177', kind: 'tax', town: 'Pickerington', rate: '1' },
  { text: 'Same label, lives in Bremen', label: 'Sch Dist Wthld', law: '177', kind: 'tax', town: 'Bremen', rate: '2' },
  { text: 'City tax', label: 'City Inc Tax W/H', law: '177', kind: 'tax', town: 'Lancaster', rate: '2.3' },
  { text: 'Union dues', label: 'Local 9 Union Dues', law: '0', kind: 'deduction', town: 'Ashville', rate: '1' },
  { text: 'Misspelt label', label: 'Pickrngtn Schl W/H', law: '177', kind: 'tax', town: 'Pickerington', rate: '1' },
  { text: 'System item', label: 'Columbus City Tax', law: '4140', kind: 'tax', town: 'Pickerington', rate: '2.5', site: 1 },
];
const isCustomLaw = (law) => Number(law) === 177 || Number(law) === 0;

// One address the lookup knows for each Ohio town and school district, so the address is real and placeable.
function homeChoices() {
  const out = new Map();
  for (const a of data.geocoder.addresses) {
    if (a.state !== 'OH' || a.missing || a.school_district === 'UNRESOLVED' || lookupIdx.get(addressKey(a.line1, a.zip)) !== a.address_id) continue;
    const key = `${a.city}|${a.school_district}`;
    if (out.has(key)) continue;
    out.set(key, { address_id: a.address_id, town: a.city, address: a, text: a.city });
  }
  return [...out.values()].sort((x, y) => x.text.localeCompare(y.text));
}

function runTrial() {
  const co = companyById();
  const law = Number(trial.law);
  const homes = homeChoices();
  const home = homes.find((h) => h.town === trial.town) ?? null;
  const site = co.worksites.find((w) => w.site_id === trial.site) ?? co.worksites[0];
  const item = { item_id: 'I-TRY', label: trial.label, law_id: law, origin: isCustomLaw(law) ? 'custom' : 'system', item_type: trial.kind === 'deduction' ? 'Deduction' : 'Other Tax', tracking_type: trial.kind === 'deduction' ? 'None' : 'Local Income Tax', calc: { kind: 'percent', rate: Number(trial.rate) }, agency: '' };
  const emp = { employee_id: 'TRY', name: trial.name.trim() || 'New employee', site_id: site.site_id, monthly_wages: 4000, addresses: home ? [{ address_id: home.address_id, from_month: 1 }] : [], items: ['I-TRY'] };
  try {
    const ta = analyseCompany({ ...co, items: [...co.items, item], employees: [...co.employees, emp] }, data, state.settings);
    const c = effectiveAll(ta, emptyDecisions()).find((x) => x.employee_id === 'TRY');
    const model = item.origin === 'custom' && c.state ? ta.models[c.state] : null;
    trial.result = { item, emp, c, model, explain: model ? model.explain(trial.label) : null, home, site };
  } catch (err) {
    if (err.name !== 'DataError') throw err;
    trial.result = { error: err.issues.map((x) => x.text) };
  }
}

function trialCard(s) {
  const co = s.a.company;
  const taxes = data.catalog.states.OH.taxes;
  const sel = (v, cur) => (String(v) === String(cur) ? ' selected' : '');
  const lawOpts = [['177', "177, the employer's own item"], ['0', "0, the employer's own item"], ...taxes.map((t) => [String(t.law_id), `${t.law_id}, ${t.name}`])]
    .map(([v, t]) => `<option value="${v}"${sel(v, trial.law)}>${esc(t)}</option>`).join('');
  const homeOpts = `<option value=""${sel('', trial.town)}>No home address on file</option>${homeChoices().map((h) => `<option value="${esc(h.town)}"${sel(h.town, trial.town)}>${esc(h.text)}</option>`).join('')}`;
  const siteOpts = co.worksites.map((w) => `<option value="${esc(w.site_id)}"${sel(w.site_id, trial.site || co.worksites[0].site_id)}>${esc(w.name)}</option>`).join('');
  const form = `<form class="try-form" data-action="try-run">
      <fieldset class="try-set try-emp"><legend>The new employee</legend>
        <label class="field" for="try-name">Name<input type="text" id="try-name" name="name" value="${esc(trial.name)}" autocomplete="off" maxlength="60"></label>
        <label class="field" for="try-town">Lives in<select id="try-town" name="town">${homeOpts}</select></label>
        <label class="field" for="try-site">Works at<select id="try-site" name="site">${siteOpts}</select></label>
      </fieldset>
      <fieldset class="try-set try-item"><legend>Their Desktop payroll item</legend>
        <label class="field try-label" for="try-label">Label, as typed in Desktop<input type="text" id="try-label" name="label" value="${esc(trial.label)}" autocomplete="off" spellcheck="false" maxlength="60" required></label>
        <label class="field" for="try-law">Law ID<select id="try-law" name="law">${lawOpts}</select></label>
        <label class="field" for="try-kind">Desktop sets it up as<select id="try-kind" name="kind"><option value="tax"${sel('tax', trial.kind)}>A local income tax</option><option value="deduction"${sel('deduction', trial.kind)}>An after-tax deduction</option></select></label>
        <label class="field" for="try-rate">Rate %<input type="number" id="try-rate" name="rate" min="0" max="100" step="0.01" value="${esc(trial.rate)}" required></label>
      </fieldset>
      <div class="try-go"><button class="btn primary" type="submit">${icon('spark')}Run clustering</button></div>
    </form>
    <div class="chips try-examples"><span class="small muted">Examples:</span>${TRY_EXAMPLES.map((x, i) => `<button type="button" class="chip-btn" data-action="try-example" data-key="${i}">${esc(x.text)}</button>`).join('')}</div>`;
  const added = state.added.filter((x) => x.company_id === co.company_id);
  const addedList = added.length ? `<div class="try-added"><span class="label">Added in this browser</span><ul>${added.map((x) => `<li><span><strong>${esc(x.employee.name)}</strong> <span class="small muted">"${esc(labelOf(x.label))}", Law ID ${x.law}</span></span><button class="btn quiet" type="button" data-action="try-remove" data-id="${esc(x.employee.employee_id)}">Remove</button></li>`).join('')}</ul></div>` : '';
  return `<section class="card try-card" aria-labelledby="try-h">
    <div class="card-head"><div><h2 id="try-h">Try the clustering</h2><p class="card-sub">Make up an employee and a Desktop item. The real engine shows where it lands.</p></div></div>
    <div class="card-body">${form}${trialResult(co)}${addedList}</div>
  </section>`;
}

function trialResult(co) {
  const r = trial.result;
  if (!r) return '';
  if (r.error) return `<div class="banner bad" id="try-out" tabindex="-1">${icon('alert', 'lg')}<div><strong>The engine stops on this item</strong><ul>${r.error.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></div>`;
  const { c, explain: x, item, model } = r;
  const steps = [];
  if (x) {
    const floor = model.thresholds.itemFloor;
    const sug = x.suggestion;
    const best = x.clusters[0];
    steps.push(['Clean the label', x.empty
      ? `<p>Nothing is left after removing place names and punctuation, so there is nothing to compare.</p>`
      : `<p><span class="tok src">${esc(labelOf(item.label))}</span> ${icon('arrow')} ${x.tokens.map((t) => `<span class="tok">${esc(t)}</span>`).join(' ')}</p><p class="small muted">Lower case; known short forms spelled out (W/H: withholding, Schl: school, Dist: district); place names and punctuation removed.</p>`]);
    if (!x.empty) {
      const rows = x.clusters.slice(0, 4).map((k, i) => `<li${i === 0 ? ' class="best"' : ''}><span class="cl-name">${esc(k.name)} <span class="muted">(${plural(k.size, 'label')})</span></span><span class="cl-bar"><span style="width:${(Math.max(0, k.closeness) * 100).toFixed(1)}%"></span></span><b>${k.closeness.toFixed(2)}</b></li>`).join('');
      steps.push(['Compare with every cluster', `<p class="small muted">Closeness: how much the words overlap with the ${plural(model.poolSize, 'labelled example')}, cluster by cluster (1 = the same words). The nearest cluster wins; your label is shown in amber in that cluster's card below.</p><ul class="closeness">${rows}</ul>`]);
      const sure = sug.confidence === 'high';
      steps.push(['How sure is it?', `<p>Silhouette = (b − a) ÷ the larger of the two = <b>${x.silhouette.toFixed(2)}</b>${x.inPool ? ' (this exact label is one of the labelled examples)' : `, where a = ${x.a.toFixed(2)} is the distance to "${esc(best.name)}" and b = ${x.b.toFixed(2)} to the next nearest cluster`}.</p>
        <p>${sure ? `${pill('Confident', 'good')} ${x.silhouette.toFixed(2)} is at least the ${floor} floor, so the label belongs to <b>${esc(sug.entry.label)}</b>.` : `${pill('Not sure', 'warn')} ${sug.entry ? `${x.silhouette.toFixed(2)} is below the ${floor} floor: too close to call, so a person decides.` : 'The nearest cluster has no defined name, so a person decides.'}`}${model.mode !== 'assisted' ? ` ${esc(model.name)} is in shadow mode, so the suggestion is logged and a person decides.` : ''}</p>`]);
    }
  } else {
    const tax = data.catalog.states.OH.taxes.find((t) => t.law_id === item.law_id);
    steps.push(['The Law ID names the tax', `<p>Law ID <b>${item.law_id}</b> is <b>${esc(tax?.name ?? 'unknown')}</b>. No label reading and no clustering needed: the item maps by its Law ID.</p>`]);
  }
  if (c.route === 'local_tax') {
    const a = r.home?.address;
    const home = a ? `${esc(a.line1)}, ${esc(a.city)}${/^\d+$/.test(a.school_district) ? ` (school district ${esc(a.school_district)})` : ''}` : 'none on file';
    steps.push([item.origin === 'system' ? 'The tax applies at this address' : 'The address picks the exact tax', `<p>Home: ${home}. Work: ${esc(r.site.name)}.</p>
      <p>${icon('arrow')} ${c.proposal.map((p) => `<b>${esc(p.tax.name)}</b>, Law ID ${p.tax.law_id}, ${rateFmt(p.tax.rate)} (from the ${p.basis === 'home' ? 'home' : 'work'} address)`).join('; ')}</p>`]);
  }
  const verdict = c.route === 'local_tax'
    ? `<strong>${item.origin === 'system' ? `Local tax: Law ID ${item.law_id}, unchanged` : `Local tax: Law ID ${item.law_id} ${icon('arrow')} ${c.proposal.map((p) => p.tax.law_id).join(' + ')}`}</strong><span>${esc(c.proposal.map((p) => p.tax.name).join(' + '))}. ${c.verified ? 'Every check passes: ready to confirm.' : 'The employer checks it in To do.'}</span>`
    : c.route === 'not_a_tax' ? `<strong>Not a tax: moves to deductions</strong><span>${esc(c.reasonText)}</span>`
      : `<strong>Goes to an expert: ${esc(REASON_SHORT[c.reason] ?? c.reason)}</strong><span>${esc(c.reasonText)}</span>`;
  const tone = c.route === 'local_tax' ? 'good' : c.route === 'not_a_tax' ? 'info' : 'warn';
  const live = decisionsFor().live;
  const open = trial.opened ? `<button class="btn quiet" type="button" data-action="goto" data-view="${trial.opened.view}" data-key="c|${esc(trial.opened.case_id)}">Open ${esc(trial.opened.name)}'s record</button>` : '';
  return `<div class="try-out" id="try-out" tabindex="-1">
    <ol class="try-steps">${steps.map(([h, body]) => `<li><strong>${esc(h)}</strong>${body}</li>`).join('')}</ol>
    <div class="try-verdict ${tone}">${verdict}</div>
    <div class="row"><button class="btn" type="button" data-action="try-add"${live ? ' disabled title="The business is live"' : ''}>${icon('users')}Add ${esc(trial.name.trim() || 'this employee')} to ${esc(co.name)}</button>${open}</div>
  </div>`;
}

function viewModel(s) {
  const used = statesInUse(s.a);
  const panels = Object.values(s.a.models).filter((m) => used.has(m.state)).map((m) => {
    const t = m.thresholds;
    const gate = (name, rule, measured, pass) => `<tr><td><strong>${name}</strong></td><td>${rule}</td><td>${measured}</td><td>${pill(pass ? 'Pass' : 'Fail', pass ? 'good' : 'bad')}</td></tr>`;
    const chip = (x, extra = '') => `<span class="label-chip${extra}${x.silhouette < t.itemFloor ? ' weak' : ''}">${esc(x.label)}<b>${x.silhouette.toFixed(2)}</b></span>`;
    // The label from "Try the clustering", shown in the cluster it lands in.
    const tx = trial.result?.explain;
    const tryChip = (model, c) => (tx && !tx.empty && trial.result.c.state === model.state && tx.suggestion.cluster_index === c.index ? `<span class="label-chip try" title="Your label">${esc(labelOf(trial.label))}<b>${tx.silhouette.toFixed(2)}</b></span>` : '');
    // A label alone in its cluster has silhouette 0 by definition: list those together instead of one card each.
    const lone = (c) => c.members.length + c.assigned.length <= 1;
    const singles = m.clusters.filter(lone);
    const singleCard = singles.length ? `<div class="cluster singles">
        <div class="cluster-head"><strong>Labels alone in their cluster</strong><span class="small muted">${plural(singles.length, 'label')}</span></div>
        <span class="small muted">Nothing close enough to group with, so the silhouette is 0. Each is named after its closest entry.</span>
        <ul class="single-list">${singles.map((c) => `<li>${[...c.members, ...c.assigned].map((x) => chip(x, c.assigned.includes(x) ? ' mine assigned' : x.fromCompany ? ' mine' : '')).join('')}<span class="small muted">${esc(c.kind ? c.name : 'No entry close enough')}</span></li>`).join('')}</ul>
      </div>` : '';
    const clusters = [...m.clusters].filter((c) => !lone(c)).sort((a, b) => b.size - a.size).map((c) => `<div class="cluster${c.kind ? '' : ' unnamed'}">
        <div class="cluster-head"><strong>${esc(c.name)}</strong><span class="small muted">${plural(c.size, 'label')}</span></div>
        <div class="meter${c.meanSilhouette < t.silhouetteFloor ? ' low' : ''}" role="img" aria-label="Mean silhouette ${c.meanSilhouette.toFixed(2)}"><span style="width:${Math.max(0, c.meanSilhouette) * 100}%"></span></div>
        <span class="small muted">Mean silhouette ${c.meanSilhouette.toFixed(2)}${c.kind ? `, ${c.kind === 'tax' ? 'tax' : 'non-tax'} entry` : ', no entry close enough'}</span>
        <div class="label-chips">${c.members.map((x) => chip(x, x.fromCompany ? ' mine' : '')).join('')}${c.assigned.map((x) => chip(x, ' mine assigned')).join('')}${tryChip(m, c)}</div>
      </div>`).join('');
    const unassigned = m.unassigned.length ? `<p class="small warn-text">Not assigned to any cluster, because no words are left to compare after removing place names: ${m.unassigned.map((l) => `"${esc(l)}"`).join(', ')}. These go to an expert.</p>` : '';
    return `<section class="panel state-panel" aria-labelledby="st-${m.state}">
      <div class="section-head"><h2 id="st-${m.state}">${esc(m.name)}</h2>
        <div class="row">${pill(m.mode === 'assisted' ? 'Suggestions shown' : 'Shadow mode', m.mode === 'assisted' ? 'good' : 'warn')}
          <label class="switch"><input type="checkbox" data-action="force-shadow" data-state="${m.state}"${m.forced ? ' checked' : ''}${s.d.live ? ' disabled' : ''}> Force shadow mode</label></div></div>
      <div class="table-wrap"><table class="gate-table stacked"><thead><tr><th>Gate</th><th>Rule</th><th>Measured</th><th>Result</th></tr></thead><tbody>
        ${gate('Rollout', 'State enabled for migration', data.catalog.states[m.state].rollout === 'enabled' ? 'Enabled' : 'Not yet enabled', m.gates.rollout)}
        ${gate('Silhouette', `Clusters well formed: at least ${t.silhouetteFloor.toFixed(2)}`, `${m.silhouette.toFixed(3)} with ${m.k} clusters`, m.gates.silhouette)}
        ${gate('Precision', `At least ${pct(t.precisionTarget, 0)} of high-confidence suggestions match the expert`, m.highConfidence ? `${pct(m.precision)} (${m.correct} of ${m.highConfidence})` : 'No high-confidence suggestions', m.gates.precision)}
        ${gate('Sample', `At least ${t.minSample} expert-labelled labels (demo scale)`, `${m.poolSize}`, m.gates.sample)}
      </tbody></table></div>
      <p class="small muted">Green: ${esc(s.a.company.name)}'s labels. Dotted: too weak, so an expert decides.${m.forced ? ' Shadow mode is forced on.' : ''}</p>
      ${unassigned}
      <div class="cluster-list">${clusters}${singleCard}</div>
    </section>`;
  }).join('');
  return `<div class="page-head"><h1>Model</h1>
    <p class="lede">Suggestions show only where every gate passes; otherwise people decide (shadow mode).</p></div>
    ${trialCard(s)}
    ${thresholdPanel(s)}
    ${panels}`;
}

// ---------- scenario coverage ----------

function viewScenarios() {
  const results = scenarios();
  const passed = results.filter((r) => r.pass).length;
  const groups = GROUPS.map((g) => {
    const mine = results.filter((r) => r.group === g.id);
    const ok = mine.filter((r) => r.pass).length;
    const rows = mine.map((r) => `<tr>
        <td>${mark(r.pass ? 'pass' : 'fail')}<span class="sr-only">${r.pass ? 'Passes' : 'Fails'}</span></td>
        <td><strong>${esc(r.title)}</strong><div class="small muted">${esc(r.expect)}</div></td>
        <td class="small">${esc(r.detail)}</td>
      </tr>`).join('');
    // One fold per step, closed unless something in it fails.
    return `<details class="fold"${ok < mine.length ? ' open' : ''}><summary>${icon(ok === mine.length ? 'check' : 'alert')}<span class="fold-t">${esc(g.title)}</span><span class="count ${ok === mine.length ? 'ok' : 'bad'}">${ok}/${mine.length}</span>${icon('chevron', 'chev')}</summary>
      <div class="fold-body"><div class="table-wrap"><table class="scenario-table"><thead><tr><th><span class="sr-only">Result</span></th><th>Scenario</th><th>What the check found</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    </details>`;
  }).join('');
  return `<div class="page-head"><h1>Scenarios</h1>
    <p class="lede">Every case the migration must handle, checked live on small test files. The same checks run in the automated tests.</p></div>
    <div class="score ${passed === results.length ? 'all' : ''}"><span class="n">${passed} of ${results.length}</span><span>scenarios pass</span></div>
    <section class="card scen-card" aria-label="Scenarios by step">${groups}</section>`;
}

// ---------- decision log ----------

const LOG_SHOWN = 50;
let logWho = 'all'; // the Log page's "who" filter
const logTime = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function viewAudit(s) {
  const mine = state.audit.filter((a) => a.company_id === state.companyId);
  const actors = [...new Set(mine.map((a) => a.actor))];
  if (logWho !== 'all' && !actors.includes(logWho)) logWho = 'all';
  const entries = logWho === 'all' ? mine : mine.filter((a) => a.actor === logWho);
  const chips = mine.length ? `<div class="filter-chips log-who" role="group" aria-label="Show entries by">${[['all', 'Everyone', mine.length], ...actors.map((a) => [a, a, mine.filter((x) => x.actor === a).length])]
    .map(([id, text, n]) => `<button type="button" class="fchip" data-action="log-who" data-value="${esc(id)}" aria-pressed="${logWho === id}">${esc(text)}<span>${num(n)}</span></button>`).join('')}</div>` : '';
  const rows = entries.slice(0, more.audit ? undefined : LOG_SHOWN).map((a) => `<tr><td class="small nowrap">${esc(logTime(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td class="small muted">${esc(a.detail)}</td></tr>`).join('');
  return `<div class="page-head"><h1>Decision log</h1>
    <p class="lede">Who did what and when, newest first. Every rule, employer and expert step is here.</p></div>
    <div class="row">${HOSTED
      ? `<button class="btn primary" type="button" data-action="copy-json">Copy report (JSON)</button>
      <button class="btn" type="button" data-action="copy-csv">Copy lines (CSV)</button>
      <span class="small muted">Downloads work when you run the app locally.</span>`
      : `<button class="btn primary" type="button" data-action="export-json">Download report (JSON)</button>
      <button class="btn" type="button" data-action="export-csv">Download lines (CSV)</button>
      <button class="btn quiet" type="button" data-action="copy-json">Copy report</button>`}
    </div>
    <label class="sr-only" for="copy-box">Report JSON</label><textarea class="copy-box" id="copy-box" readonly hidden></textarea>
    ${chips}
    ${entries.length ? `<div class="table-wrap"><table class="stacked log-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Line</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${entries.length > LOG_SHOWN ? `<div class="row"><button class="btn quiet" type="button" data-action="show-more" data-key="audit">${more.audit ? `Show the newest ${LOG_SHOWN}` : `Show all ${num(entries.length)} entries`}</button></div>` : ''}` : '<div class="empty"><strong>No decisions yet. Run the move as the business owner and every step lands here.</strong></div>'}`;
}

// ---------- data (admin): the database, a query box and uploads ----------

const EXAMPLES = [
  ['Lines by route', 'SELECT route, COUNT(*) AS lines\nFROM results\nGROUP BY route\nORDER BY lines DESC'],
  ['Items by Law ID', 'SELECT p.label, p.law_id, t.name AS tax_by_law_id, COUNT(l.employee_id) AS employees\nFROM payroll_items p\nLEFT JOIN taxes t ON t.law_id = p.law_id\nLEFT JOIN desktop_lines l ON l.item_id = p.item_id\nGROUP BY p.item_id\nORDER BY employees DESC'],
  ['Law ID before and after', 'SELECT e.name AS employee, p.label AS desktop_item, p.law_id AS desktop_law_id, r.law_id AS online_law_id, t.name AS online_tax, r.decided_by\nFROM desktop_lines l\nJOIN employees e ON e.employee_id = l.employee_id\nJOIN payroll_items p ON p.item_id = l.item_id\nJOIN results r ON r.employee_id = l.employee_id AND r.item_id = l.item_id\nLEFT JOIN taxes t ON t.law_id = r.law_id\nLIMIT 50'],
  ['The address picks the tax', 'SELECT a.street, a.city, a.school_district, t.law_id, t.name AS school_tax, t.rate\nFROM addresses a\nJOIN taxes t ON t.code = a.school_district\nLIMIT 50'],
  ['Who decided', 'SELECT COALESCE(decided_by, \'nobody yet\') AS decided_by, COUNT(*) AS lines\nFROM results\nGROUP BY 1\nORDER BY lines DESC'],
  ['Open lines by reason', 'SELECT reason, COUNT(*) AS lines\nFROM results\nWHERE status = \'with_expert\'\nGROUP BY reason\nORDER BY lines DESC'],
  ['Who moved', 'SELECT name, moved_month, home_address_id, new_home_address_id\nFROM employees\nWHERE new_home_address_id IS NOT NULL'],
  ['No home address', 'SELECT employee_id, name\nFROM employees\nWHERE home_address_id IS NULL'],
];
const LAYER_NO = { desktop: 1, lookup: 2, results: 3 };
let schemaSel = 'employees';  // the table open in the schema view
const ruleResults = {};      // the database's answer to each rule check

// The schema, read from the database itself: four layers of tables, then one table in detail.
function schemaCard(groups) {
  const layers = groups.map((g) => `<div class="layer">
      <div class="layer-head"><span class="layer-n">${LAYER_NO[g.id]}</span><div><strong>${esc(g.title)}</strong><span>${esc(g.owner)}</span></div></div>
      <ul class="layer-tables">${g.tables.map((t) => `<li><button type="button" class="tbl" data-action="schema-table" data-key="${esc(t.name)}"${t.name === schemaSel ? ' aria-current="true"' : ''}><span class="tbl-name">${esc(t.name)}</span><span class="tbl-n">${num(t.rows)}</span></button></li>`).join('')}</ul>
    </div>`).join('');
  const t = describeTable(db, schemaSel) ?? describeTable(db, 'employees');
  const layer = groups.find((g) => g.tables.some((x) => x.name === t.name));
  const keyOf = (c) => [c.pk ? '<span class="key pk">PK</span>' : '', c.links.length ? '<span class="key fk">FK</span>' : ''].join('');
  const cols = t.columns.map((c) => `<tr><td><code class="code">${esc(c.name)}</code></td><td class="small">${esc((c.type || 'TEXT').toLowerCase())}</td><td>${keyOf(c) || '<span class="muted">-</span>'}</td><td class="small">${c.notNull ? 'Yes' : '<span class="muted">No</span>'}</td><td>${c.links.map((x) => `<button type="button" class="link-tbl" data-action="schema-table" data-key="${esc(x)}">${esc(x)}</button>`).join(' ') || '<span class="muted">-</span>'}</td></tr>`).join('');
  const fks = t.foreignKeys.map((f) => `<li><code class="code">${esc(f.from.join(', '))}</code> must match <button type="button" class="link-tbl" data-action="schema-table" data-key="${esc(f.table)}">${esc(f.table)}</button> <code class="code">${esc(f.to.join(', '))}</code></li>`).join('');
  return `<section class="card" aria-labelledby="schema-h">
    <div class="card-head"><div><h2 id="schema-h">Schema</h2><p class="card-sub">One database for this migration: ${groups.reduce((n, g) => n + g.tables.length, 0)} tables in three groups. Click a table for its columns and keys.</p></div>
      <div class="row">${HOSTED ? '<button class="btn" type="button" data-action="copy-schema">Copy schema.sql</button>' : `<button class="btn" type="button" data-action="download-schema">schema.sql</button><button class="btn primary" type="button" data-action="download-db">${icon('file')}Download the database</button>`}</div></div>
    <div class="card-body">
      <div class="layers">${layers}</div>
      <div class="tdetail" id="tdetail" tabindex="-1">
        <div class="tdetail-head"><div><h3><code>${esc(t.name)}</code></h3><p class="small muted">${esc(layer.title)}, ${plural(t.rows, 'row')}</p></div><button class="btn quiet" type="button" data-action="example-query" data-sql="${esc(`SELECT * FROM ${t.name} LIMIT 50`)}">Look inside</button></div>
        <p class="tdetail-note">${esc(TABLE_NOTES[t.name] ?? '')}</p>
        <div class="table-wrap"><table class="col-table"><thead><tr><th>Column</th><th>Type</th><th>Key</th><th>Required</th><th>Links to</th></tr></thead><tbody>${cols}</tbody></table></div>
        <div class="tdetail-links">
          ${fks ? `<div><span class="label">Foreign keys</span><ul class="fk-list">${fks}</ul></div>` : '<div><span class="label">Foreign keys</span><p class="small muted">None: nothing else has to exist first.</p></div>'}
          <div><span class="label">Rules</span>${t.checks.length ? `<ul class="fk-list">${t.checks.map((c) => `<li><code class="code wrap">${esc(c)}</code></li>`).join('')}</ul>` : '<p class="small muted">Keys only.</p>'}</div>
          <div><span class="label">Linked from</span>${t.linkedFrom.length ? `<p class="link-row">${t.linkedFrom.map((x) => `<button type="button" class="link-tbl" data-action="schema-table" data-key="${esc(x)}">${esc(x)}</button>`).join(' ')}</p>` : '<p class="small muted">No other table points here.</p>'}</div>
        </div>
        ${fold('file', 'The CREATE TABLE statement', `<pre class="sql-pre">${esc(t.sql)}</pre>`)}
      </div>
      <label class="sr-only" for="schema-box">schema.sql</label><textarea class="copy-box" id="schema-box" readonly hidden></textarea>
    </div>
    ${fold('layers', 'Diagram of the tables', '<img class="erd" src="./schema-diagram.svg" alt="Entity-relationship diagram of the seven tables: company, employees, addresses, payroll items, Desktop lines, taxes (keyed by Law ID) and results, with their keys." loading="lazy" width="1188" height="1011">')}
  </section>`;
}

// Proof that the rules are in the database, not only in the app.
function rulesCard() {
  const rows = RULE_CHECKS.map((c) => {
    const r = ruleResults[c.id];
    const answer = r ? (r.refused ? `<span class="rule-out bad">${icon('x')}Refused: ${esc(r.refused)}</span>` : `<span class="rule-out warn">${icon('alert')}Accepted, then rolled back</span>`) : '';
    return `<li><div class="rule-text"><strong>${esc(c.label)}</strong><span class="small muted">${esc(c.rule)} rule</span>${r ? `<code class="sql-line">${esc(c.sql)}</code>${answer}` : ''}</div><button class="btn" type="button" data-action="try-rule" data-key="${c.id}">Try it</button></li>`;
  }).join('');
  return `<section class="card" aria-labelledby="rules-h">
    <div class="card-head"><div><h2 id="rules-h">The database checks the data itself</h2><p class="card-sub">Each button tries to break a rule. The database refuses it.</p></div><button class="btn quiet" type="button" data-action="try-rule" data-key="all">Try all</button></div>
    <div class="card-body"><ul class="rule-list">${rows}</ul></div>
  </section>`;
}

function viewData() {
  const head = `<div class="page-head"><h1>Data</h1>
    <p class="lede">A SQLite database running in this page. It holds ${esc(companyById().name)} and its migration.</p></div>`;
  syncWork();
  if (db && !query.result && !query.error) runSql(query.sql);
  const groups = db ? tableSummary(db) : [];
  const r = query.result;
  const results = query.error
    ? `<p class="query-error" role="alert">${icon('alert')}${esc(query.error)}</p>`
    : r ? (r.columns.length
      ? `<p class="small muted">${plural(r.total, 'row')}${r.total > r.rows.length ? `, first ${r.rows.length} shown` : ''}</p><div class="table-wrap result"><table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${v === null ? '<span class="none">null</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="small muted">No rows.</p>') : '';
  const msg = uploadMsg ? `<div class="banner ${uploadMsg.tone}" id="upload-msg" tabindex="-1">${icon(uploadMsg.tone === 'good' ? 'check' : 'alert', 'lg')}<div><strong>${esc(uploadMsg.title)}</strong><ul>${uploadMsg.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></div>` : '';
  const up = uploads[0];
  const current = up ? `<div class="upload-now">${icon('file')}<span><strong>Moving ${esc(up.company.name)}</strong><span class="small muted">${esc(up.file ?? 'Uploaded file')}, ${plural(up.company.employees.length, 'employee')}</span></span><button class="btn" type="button" data-action="remove-upload">Back to ${esc(generated.companies[0].name)}</button></div>` : '';
  return `${head}
    ${db ? '' : `<div class="banner warn">${icon('alert', 'lg')}<div><strong>The database could not start here.</strong> ${esc(dbError ?? '')} The app is reading the demo files directly; open the GitHub Pages site to use the database.</div></div>`}
    ${db ? schemaCard(groups) + rulesCard() : ''}
    <section class="card" aria-labelledby="q-h">
      <div class="card-head"><div><h2 id="q-h">Ask the data</h2><p class="card-sub">Read-only SQL</p></div></div>
      <div class="card-body">
        <div class="chips">${EXAMPLES.map(([t, sql]) => `<button type="button" class="chip-btn" data-action="example-query" data-sql="${esc(sql)}">${esc(t)}</button>`).join('')}</div>
        <form class="query-form" data-action="run-query"><label class="sr-only" for="sql">SQL query</label><textarea id="sql" name="sql" rows="5" spellcheck="false"${db ? '' : ' disabled'}>${esc(query.sql)}</textarea><button class="btn primary" id="run-query-btn" type="submit"${db ? '' : ' disabled'}>Run query</button></form>
        ${results}
      </div>
    </section>
    <section class="card" aria-labelledby="up-h">
      <div class="card-head"><div><h2 id="up-h">Try your own Desktop file</h2><p class="card-sub">A CSV, one row per employee per payroll item. It replaces ${esc(generated.companies[0].name)} until you go back.</p></div></div>
      <div class="card-body">
        <div class="row"><label class="btn primary file-btn">${icon('file')}Choose a CSV file<input type="file" accept=".csv,text/csv" data-action="upload" class="sr-only"></label><button class="btn" type="button" data-action="template">${HOSTED ? 'Copy the template' : 'Download the template'}</button></div>
        <label class="sr-only" for="template-box">Template CSV</label><textarea class="copy-box" id="template-box" readonly hidden></textarea>
        ${msg}
        ${current}
        ${fold('list', 'Columns in the file', `<table class="col-table"><tbody>${CSV_COLUMNS.map(([c, req, help]) => `<tr><td><code class="code">${esc(c)}</code></td><td>${req ? 'Required' : 'Optional'}</td><td class="small muted">${esc(help)}</td></tr>`).join('')}</tbody></table><p class="small muted">A home address the lookup does not know goes to an expert; an unknown work address stops the file.</p>`)}
      </div>
    </section>`;
}

// ---------- actions ----------

function findCase(id, companyId = state.companyId) {
  return effectiveAll(analysisFor(companyId), decisionsFor(companyId)).find((c) => c.case_id === id);
}

function decide(id) {
  const d = decisionsFor();
  const c = findCase(id);
  if (!c || c.stage !== 'awaiting_employer' || d.live) return;
  d.cases[id] = { ...(d.cases[id] ?? {}), employer: { action: c.route, at: new Date().toISOString() } };
  const verb = { local_tax: 'Confirmed', not_a_tax: 'Moved to deductions', custom_entry: 'Accepted as employer-managed', stop: 'Stopped withholding' }[c.route];
  const detail = c.route === 'local_tax'
    ? `${c.proposal.map((p) => p.tax.name).join(' and ')}${c.proposal.some((p) => p.rate.status === 'over' || p.rate.status === 'under') ? ', at the official rate going forward' : ''}`
    : '';
  log('Employer', verb, `${c.employee_name}: ${c.item.label}`, detail);
  toast(`${verb}: ${c.item.label} for ${c.employee_name}`);
}

function bulkConfirm(companyId) {
  const d = decisionsFor(companyId);
  if (d.live) return;
  const list = effectiveAll(analysisFor(companyId), d).filter((c) => c.stage === 'awaiting_employer' && c.verified);
  const prev = state.companyId;
  state.companyId = companyId;
  for (const c of list) {
    d.cases[c.case_id] = { ...(d.cases[c.case_id] ?? {}), employer: { action: 'local_tax', at: new Date().toISOString(), bulk: true } };
    log('Employer (bulk)', 'Confirmed', `${c.employee_name}: ${c.item.label}`, c.proposal.map((p) => p.tax.name).join(' and '));
  }
  state.companyId = prev;
  toast(`Confirmed ${plural(list.length, 'line')} that ${list.length === 1 ? 'was' : 'were'} ready to confirm for ${companyById(companyId).name}`);
}

function setExpert(id, expert, verb, detail) {
  const d = decisionsFor();
  const c = findCase(id);
  if (!c || d.live) return;
  const next = { ...(d.cases[id] ?? {}), expert: { ...expert, at: new Date().toISOString() } };
  delete next.employer;
  d.cases[id] = next;
  log('Expert', verb, `${c.employee_name}: ${c.item.label}`, detail);
  toast(`${verb}. The employer confirms it next on the review screen.`);
}

function download(name, text, type) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Saving ${name}.`);
  } catch {
    toast('Downloads are blocked here. Use Copy report instead.');
  }
}

function handle(action, el) {
  const d = decisionsFor();
  const id = el.dataset?.id;
  switch (action) {
    case 'sign-in': {
      state.role = el.dataset.role;
      state.detailOpen = false;
      save();
      afterRender = () => { window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); };
      const home = `#${ROLES[state.role].tabs[0][0]}`;
      if (location.hash === home) break;
      location.hash = home;
      return;
    }
    case 'sign-out':
      if (moving) clearTimeout(moving.timer);
      moving = null;
      state.role = null;
      save();
      history.replaceState(null, '', location.pathname + location.search);
      break;
    case 'template': {
      const text = csvTemplate(files.geocoder);
      if (!HOSTED) { download('desktop-file-template.csv', text, 'text/csv'); return; }
      const box = document.getElementById('template-box');
      box.value = text;
      box.hidden = false;
      try { navigator.clipboard.writeText(text).then(() => toast('Template copied. Paste it into a .csv file.')).catch(() => { box.focus(); box.select(); }); } catch { box.focus(); box.select(); }
      return;
    }
    case 'remove-upload': {
      const gone = uploads[0];
      if (gone) {
        delete state.decisions[gone.company.company_id];
        state.corrections = state.corrections.filter((c) => c.company_id !== gone.company.company_id);
        state.audit = state.audit.filter((a) => a.company_id !== gone.company.company_id);
      }
      uploads = [];
      uploadMsg = null;
      saveUploads();
      rebuildData();
      toast(`Back to ${companyById().name}`);
      break;
    }
    case 'run-query':
      runSql(new FormData(el).get('sql'));
      break;
    case 'schema-table':
      schemaSel = el.dataset.key;
      afterRender = () => { const d = document.getElementById('tdetail'); if (!d) return; if (d.getBoundingClientRect().top < 0 || d.getBoundingClientRect().top > window.innerHeight * 0.6) d.scrollIntoView({ block: 'start' }); if (byKeyboard) d.focus({ preventScroll: true }); };
      break;
    case 'try-rule':
      if (!db) return;
      for (const c of RULE_CHECKS) if (el.dataset.key === 'all' || el.dataset.key === c.id) ruleResults[c.id] = tryRule(db, c.id);
      break;
    case 'download-db': {
      if (!db) return;
      syncWork();
      download('local-tax-migration.sqlite', exportDatabase(db), 'application/vnd.sqlite3');
      return;
    }
    case 'download-schema':
      download('schema.sql', SCHEMA.trimStart(), 'text/plain');
      return;
    case 'copy-schema': {
      const box = document.getElementById('schema-box');
      const text = SCHEMA.trimStart();
      const fallback = () => { box.value = text; box.hidden = false; box.focus(); box.select(); toast('Copying is blocked here. The schema is selected below; copy it manually.'); };
      try { navigator.clipboard.writeText(text).then(() => toast('schema.sql copied to the clipboard')).catch(fallback); } catch { fallback(); }
      return;
    }
    case 'example-query':
      runSql(el.dataset.sql);
      break;
    case 'hard-reset':
      try { localStorage.removeItem(STORE); localStorage.removeItem(UPLOADS); } catch { /* nothing saved */ }
      location.hash = '';
      location.reload();
      return;
    case 'reset': {
      // Two steps: the first click arms the button for a few seconds; nothing is cleared yet.
      if (!resetArmed) {
        resetArmed = true;
        el.classList.add('armed');
        el.querySelector('span').textContent = 'Click again to reset';
        toast('This clears every decision, address and upload. Click again to confirm.');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetArmed = false;
          const b = document.querySelector('[data-action="reset"]');
          if (b) { b.classList.remove('armed'); b.querySelector('span').textContent = 'Reset the demo'; }
        }, 5000);
        return;
      }
      resetArmed = false;
      clearTimeout(resetTimer);
      if (moving) clearTimeout(moving.timer);
      moving = null;
      state = { ...freshState(), role: state.role };
      uploads = [];
      uploadMsg = null;
      saveUploads();
      rebuildData();
      toast('Demo reset to its starting data');
      break;
    }
    case 'fix-address': {
      if (d.live) { toast('This business is live. Undo go-live to change an address.'); return; }
      const f = new FormData(el);
      const corr = { company_id: state.companyId, employee_id: el.dataset.employee, line1: String(f.get('line1') ?? '').trim(), city: String(f.get('city') ?? '').trim(), state: String(f.get('state') ?? 'OH'), zip: String(f.get('zip') ?? '').trim(), at: new Date().toISOString() };
      if (!corr.line1 || !/^\d{5}$/.test(corr.zip)) {
        toast('Enter the street and a 5-digit ZIP code.');
        el.querySelector(corr.line1 ? '[name="zip"]' : '[name="line1"]')?.focus();
        return;
      }
      const name = companyById().employees.find((x) => x.employee_id === corr.employee_id)?.name ?? corr.employee_id;
      const found = addCorrection(corr);
      const emp = analysisFor().employees.find((x) => x.employee_id === corr.employee_id);
      const where = (emp?.expected.list ?? []).filter((x) => x.tax.type === 'school_district').map((x) => taxShort(x.tax)).join(' and ');
      log('Employer', 'Added a home address', name, found ? `Placed by the address lookup${where ? `: ${where}` : ''}. The engine checked the lines again.` : 'The address lookup cannot place it, so the line stays with an expert');
      let steps = 0;
      if (decisionsFor().autoRun && !decisionsFor().live) steps = runAutomationFor(state.companyId).actions.length;
      toast(found
        ? `Saved and placed: ${where || 'no school-district tax at this address'}. ${steps ? `Your rules settled ${plural(steps, 'more item')}.` : decisionsFor().autoRun ? 'Nothing more for the rules to settle.' : 'The line is ready to confirm.'}`
        : `Saved, but the address lookup cannot place it. An expert checks ${name}'s line.`);
      afterRender = focusTask;
      break;
    }
    case 'sample-address': {
      const a = demoAddressFor(el.dataset.employee);
      const form = el.closest('form');
      if (!a || !form) { toast('No demo address found near this work site.'); return; }
      form.elements.line1.value = a.line1;
      form.elements.city.value = a.city;
      form.elements.state.value = a.state;
      form.elements.zip.value = a.zip;
      form.querySelector('[type="submit"]')?.focus();
      return;
    }
    case 'work-answer': {
      if (d.live) { toast('This business is live. Undo go-live to change where someone works.'); return; }
      const remote = el.dataset.remote === '1';
      const corr = { kind: 'work', company_id: state.companyId, employee_id: el.dataset.employee, remote, at: new Date().toISOString() };
      const name = companyById().employees.find((x) => x.employee_id === corr.employee_id)?.name ?? corr.employee_id;
      const before = analysisFor().employees.find((x) => x.employee_id === corr.employee_id);
      const site = before ? siteOf(before, analysisFor()).name : 'the work site';
      addCorrection(corr);
      const emp = analysisFor().employees.find((x) => x.employee_id === corr.employee_id);
      const city = (emp?.expected.list ?? []).find((x) => x.required && x.tax.type === 'municipal');
      log('Employer', 'Said where someone works', name, `${remote ? 'From home' : `At ${site}`}. ${city ? `City tax owed: ${taxShort(city.tax)}.` : ''} The engine checked the lines again.`);
      let steps = 0;
      if (decisionsFor().autoRun && !decisionsFor().live) steps = runAutomationFor(state.companyId).actions.length;
      toast(`Saved: ${name} works ${remote ? 'from home' : `at ${site}`}${city ? `, so ${taxShort(city.tax)} applies` : ''}. ${steps ? `Your rules settled ${plural(steps, 'more item')}.` : decisionsFor().autoRun ? 'Nothing more for the rules to settle.' : 'The line is ready to confirm.'}`);
      afterRender = focusTask;
      break;
    }
    case 'save-account': {
      if (d.live) { toast('This business is live. Undo go-live to change an account.'); return; }
      const f = new FormData(el);
      const account = String(f.get('account') ?? '').trim();
      const frequency = String(f.get('frequency') ?? '');
      if (!account || !frequency) {
        toast(account ? 'Choose how often taxes are deposited.' : 'Enter the account number.');
        el.querySelector(account ? '[name="frequency"]' : '[name="account"]')?.focus();
        return;
      }
      d.accounts[el.dataset.agency] = { account, frequency };
      log('Employer', 'Added an agency account', el.dataset.agency, `Account number and ${frequency.toLowerCase()} deposits`);
      toast(`Saved the account for ${el.dataset.agency}.`);
      afterRender = focusTask;
      break;
    }
    case 'sample-account': {
      const form = el.closest('form');
      if (!form) return;
      const h = [...el.dataset.agency].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 11);
      form.elements.account.value = `${el.dataset.agency.replace(/^City of /, '').slice(0, 3).toUpperCase()}-${String(100000 + (h % 900000))}`;
      if (!form.elements.frequency.value) form.elements.frequency.value = 'Monthly';
      form.querySelector('[type="submit"]')?.focus();
      return;
    }
    case 'focus-missing': {
      // From the summary: open To do on the record that waits for this answer, with its form ready.
      const s0 = summary();
      const c = el.dataset.employee ? s0.cases.find((x) => x.employee_id === el.dataset.employee && waitsForEmployer(x)) : null;
      const key = el.dataset.agency ? `a|${el.dataset.agency}` : c ? `c|${c.case_id}` : null;
      state.filters.review = 'todo';
      if (key) state.sel.review = key;
      state.detailOpen = true;
      save();
      const go = () => { scrollToDetail(); focusTask(); };
      if (location.hash === '#review') { afterRender = go; break; }
      keepDetail = true;
      navFocus = go;
      location.hash = '#review';
      return;
    }
    case 'see-lines': {
      // From Go live: the lines behind a destination, in the employer's list.
      state.filters.review = 'all';
      state.query.review = el.dataset.q;
      const first = summary().cases.find((c) => c.stage === 'stopped');
      state.sel.review = first ? `c|${first.case_id}` : null;
      save();
      location.hash = '#review';
      return;
    }
    case 'detail-tab': {
      detailTab = el.dataset.value;
      for (const t of el.closest('[role="tablist"]').querySelectorAll('[role="tab"]')) {
        const on = t === el;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      }
      return;
    }
    case 'tour':
      openTour(el);
      return;
    case 'show-more':
      more[el.dataset.key] = !more[el.dataset.key];
      break;
    case 'run-lab': {
      const f = new FormData(el);
      const seed = Math.round(Number(f.get('seed')));
      const total = Number(f.get('total'));
      if (!Number.isFinite(seed) || seed < 1 || seed > 99999) { toast('Enter a seed from 1 to 99999.'); return; }
      lab = { ...lab, seed, total: LAB_SIZES.some(([n]) => n === total) ? total : 1200, result: null, running: false, error: null };
      break;
    }
    case 'move-next':
    case 'move-back':
      if (action === 'move-next') state.moveStep[state.companyId] = 'check';
      else delete state.moveStep[state.companyId];
      afterRender = () => { window.scrollTo(0, 0); document.getElementById('move-h')?.focus({ preventScroll: true }); };
      break;
    case 'move-run': {
      const cid = state.companyId;
      if (decisionsFor(cid).live) break;
      log('Employer', 'Started the move to Online payroll', companyById().name, 'Demo: employees, pay items and totals copied (simulated); local tax rules applied');
      runAutomationFor(cid, { explicit: true });
      delete state.moveStep[cid];
      startMoving(cid);
      break;
    }
    case 'bulk':
      bulkConfirm(el.dataset.company ?? state.companyId);
      break;
    case 'auto-rule': {
      d.policy = { ...policyOf(d), [el.dataset.rule]: el.checked };
      log('Employer', el.checked ? 'Switched on an automation rule' : 'Switched off an automation rule', ruleLabel(el.dataset.rule));
      break;
    }
    case 'decide':
      decide(id);
      break;
    case 'send-expert': {
      const c = findCase(id);
      if (d.live || !c || c.stage !== 'awaiting_employer') break;
      d.cases[id] = { ...(d.cases[id] ?? {}), sentToExpert: { note: 'Disagrees with the suggested mapping', at: new Date().toISOString() } };
      delete d.cases[id].employer;
      log('Employer', 'Sent to an expert', `${c.employee_name}: ${c.item.label}`, 'Disagrees with the suggested mapping');
      toast(`Sent "${c.item.label}" for ${c.employee_name} to the expert queue`);
      break;
    }
    case 'unsend-expert': {
      const c = findCase(id);
      if (d.live || !d.cases[id]?.sentToExpert) break;
      delete d.cases[id].sentToExpert;
      log('Employer', 'Took back from the expert queue', `${c.employee_name}: ${c.item.label}`);
      break;
    }
    case 'undo-decide': {
      const c = findCase(id);
      if (d.live || !d.cases[id]) break;
      delete d.cases[id].employer;
      d.cases[id].hold = true; // automation leaves it for a person from now on
      log('Employer', 'Undid decision', `${c.employee_name}: ${c.item.label}`);
      break;
    }
    case 'add-gap': {
      if (d.live) break;
      const g = analysisFor().gaps.find((x) => x.gap_id === id);
      d.gaps[id] = { action: 'add', at: new Date().toISOString() };
      const starts = g.cloudMonths.length ? 'Starts with the first cloud payroll' : 'No Online paychecks; recorded for the agency';
      log('Employer', g.cloudMonths.length ? 'Added expected tax' : 'Recorded back tax', `${g.employee_name}: ${g.tax.name}`, `${starts}; back tax estimate ${money(g.backTaxEstimate)}`);
      toast(`${g.cloudMonths.length ? 'Added' : 'Recorded'} ${g.tax.name} for ${g.employee_name}`);
      break;
    }
    case 'undo-gap':
      if (!d.live) d.gaps[id] = { action: 'hold' };
      break;
    case 'select': {
      const view = currentView();
      if (window.innerWidth <= 900 && !state.detailOpen) listY = window.scrollY;
      state.sel[view] = el.dataset.key;
      state.detailOpen = true;
      afterRender = byKeyboard ? () => { scrollToDetail(); document.getElementById('detail-title')?.focus({ preventScroll: true }); } : scrollToDetail;
      break;
    }
    case 'back':
      state.detailOpen = false;
      afterRender = () => window.scrollTo(0, listY);
      break;
    case 'log-who':
      logWho = el.dataset.value;
      more.audit = false;
      break;
    case 'queue-filter':
      state.filters[el.dataset.view] = el.dataset.value;
      state.selIndex[el.dataset.view] = 0;
      break;
    case 'try-run':
    case 'try-example': {
      if (action === 'try-run') {
        const f = new FormData(el);
        const label = String(f.get('label') ?? '').trim();
        const rate = Number(f.get('rate'));
        if (!label) { toast('Type the Desktop item label.'); el.elements.label.focus(); return; }
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) { toast('Enter a rate from 0 to 100.'); el.elements.rate.focus(); return; }
        trial = { ...trial, label, law: String(f.get('law')), kind: String(f.get('kind')), name: String(f.get('name') ?? ''), town: String(f.get('town') ?? ''), site: String(f.get('site') ?? ''), rate: String(rate) };
      } else {
        const x = TRY_EXAMPLES[Number(el.dataset.key)];
        const sites = companyById().worksites;
        trial = { ...trial, label: x.label, law: x.law, kind: x.kind, town: x.town, rate: x.rate, site: sites[x.site ?? 0]?.site_id ?? sites[0].site_id };
      }
      trial.opened = null;
      runTrial();
      afterRender = () => document.getElementById('try-out')?.focus({ preventScroll: false });
      break;
    }
    case 'try-add': {
      const r = trial.result;
      if (!r?.c) return;
      if (d.live) { toast('This business is live. Undo go-live to add an employee.'); return; }
      const co = companyById();
      let n = 1;
      while (co.employees.some((e) => e.employee_id === `E-ADD${n}`)) n += 1;
      const { item_id, item } = itemFor(co, r.item);
      const employee = { ...r.emp, employee_id: `E-ADD${n}`, items: [item_id] };
      state.added.push({ company_id: co.company_id, site: r.site.name, employee, item, label: r.item.label, law: r.item.law_id, at: new Date().toISOString() });
      rebuildData();
      let c = analysisFor().cases.find((x) => x.employee_id === employee.employee_id);
      log('Admin', 'Added an employee', employee.name, `"${labelOf(r.item.label)}", Law ID ${r.item.law_id}${item ? ' (a new Desktop item)' : ''}`);
      const steps = d.autoRun && !d.live ? runAutomationFor(state.companyId).actions.length : 0;
      c = summary().cases.find((x) => x.employee_id === employee.employee_id) ?? c;
      const view = c.stage === 'with_expert' ? 'expert' : 'review';
      trial.opened = { view, case_id: c.case_id, name: employee.name };
      toast(`${employee.name} added to ${co.name.replace(/\.$/, '')}. ${view === 'expert' ? 'The line is in the expert queue.' : steps ? `Your rules settled ${plural(steps, 'item')}.` : 'The line is in To do.'}`);
      afterRender = () => document.querySelector('#try-out [data-action="goto"]')?.focus({ preventScroll: true });
      break;
    }
    case 'try-remove': {
      const x = state.added.find((a) => a.employee.employee_id === id && a.company_id === state.companyId);
      if (!x) return;
      if (d.live) { toast('This business is live. Undo go-live to remove an employee.'); return; }
      state.added = state.added.filter((a) => a !== x);
      if (trial.opened?.case_id?.includes(`:${id}:`)) trial.opened = null;
      rebuildData();
      log('Admin', 'Removed an added employee', x.employee.name);
      toast(`${x.employee.name} removed`);
      afterRender = () => document.getElementById('try-h')?.focus({ preventScroll: true });
      break;
    }
    case 'goto': {
      const view = el.dataset.view;
      state.sel[view] = el.dataset.key;
      state.filters[view] = 'all';
      state.detailOpen = true;
      keepDetail = true;
      save();
      navFocus = () => { const t = document.getElementById('detail-title'); t?.closest('.detail')?.scrollIntoView({ block: 'start' }); t?.focus({ preventScroll: true }); };
      if (location.hash === `#${view}`) { afterRender = navFocus; navFocus = null; break; }
      location.hash = `#${view}`;
      return;
    }
    case 'expert-map': {
      const select = document.getElementById(el.dataset.select);
      const tax = analysisFor().idx.taxes.get(select.value);
      if (!tax) { toast('Choose a tax to map this line to.'); select.focus(); return; }
      setExpert(id, { action: 'map', tax_id: tax.tax_id }, 'Mapped to a defined tax', tax.name);
      break;
    }
    case 'expert-nontax':
      setExpert(id, { action: 'not_a_tax' }, 'Marked as not a tax');
      break;
    case 'expert-label': {
      if (d.live) break;
      const s0 = summary();
      const pick = s0.cases.find((x) => x.item.item_id === el.dataset.item);
      if (!pick) break;
      const as = el.dataset.as;
      const at = new Date().toISOString();
      let done = 0;
      let none = 0;
      for (const c of sameLabelOpen(pick, s0)) {
        let expert = { action: 'not_a_tax', at, byLabel: true };
        if (as !== 'not_a_tax') {
          const x = c.employee.expected.list.find((e) => e.tax.type === as && e.required) ?? c.employee.expected.list.find((e) => e.tax.type === as);
          if (!x) { none += 1; continue; }
          expert = { action: 'map', tax_id: x.tax_id, at, byLabel: true };
        }
        const next = { ...(d.cases[c.case_id] ?? {}), expert };
        delete next.employer;
        d.cases[c.case_id] = next;
        done += 1;
      }
      const meaning = as === 'not_a_tax' ? 'Not a tax' : TYPE_NAME[as] ?? as;
      log('Expert', 'Decided a label for every employee', `"${labelOf(pick.item.label)}"`, `${meaning}: ${plural(done, 'line')}, each mapped by the employee's address${none ? `; ${none} left open: no such tax at that address` : ''}`);
      toast(`${meaning}: ${plural(done, 'line')} decided${none ? `, ${none} left open (no such tax at the address)` : ''}. The employer confirms next.`);
      break;
    }
    case 'expert-stop': {
      const c = findCase(id);
      const notes = {
        not_expected: 'No tax of this kind applies at the employee\'s address.',
        duplicate: 'Duplicate: another line already withholds this tax.',
        state_conflict: 'The employee has no address in the state this tax belongs to.',
      };
      const note = notes[c.reason] ?? 'This tax does not apply to this employee.';
      setExpert(id, { action: 'stop', note }, 'Marked as not owed', note);
      break;
    }
    case 'expert-custom': {
      const f = new FormData(el);
      const value = Number(f.get('value'));
      if (!f.get('name') || !f.get('agency') || !(value >= 0)) { toast('Fill in the tax name, agency and a number for the rate or amount.'); return; }
      const entry = {
        name: String(f.get('name')).trim(),
        agency: String(f.get('agency')).trim(),
        type: f.get('type'),
        basis: f.get('basis'),
        frequency: f.get('frequency'),
        ...(f.get('calc') === 'flat' ? { flat: value } : { rate: value }),
      };
      setExpert(id, { action: 'custom_entry', entry }, 'Created a structured custom entry', `${entry.name}, ${entry.agency}, employer-managed`);
      break;
    }
    case 'expert-undo': {
      const c = findCase(id);
      if (d.live || !d.cases[id]) break;
      delete d.cases[id].expert;
      delete d.cases[id].employer;
      d.cases[id].hold = true;
      log('Expert', 'Reopened', `${c.employee_name}: ${c.item.label}`);
      break;
    }
    case 'account': {
      const current = readiness(analysisFor(), d).accounts.find((a) => a.agency === el.dataset.agency);
      d.accounts[el.dataset.agency] = { account: current?.account ?? '', frequency: current?.frequency ?? '', [el.dataset.field]: el.value.trim() };
      log('Employer', 'Updated agency account', el.dataset.agency, el.dataset.field === 'account' ? 'Account number' : `Deposit frequency: ${el.value}`);
      break;
    }
    case 'go-live': {
      const r = readiness(analysisFor(), d);
      if (!r.ready || d.live) { toast('Finish the checks before going live.'); return; }
      d.live = true;
      d.liveAt = new Date().toISOString();
      const n = liveTaxes(analysisFor(), d).length;
      log('Employer', 'Went live', companyById().name, `${plural(n, 'employee tax', 'employee taxes')} switched on; ${plural(r.expert.length, 'line')} left with an expert`);
      toast('Live. Confirmed taxes start with the first cloud payroll.');
      break;
    }
    case 'undo-live':
      d.live = false;
      d.reconciled = false;
      d.liveHold = true;
      log('Employer', 'Undid go-live (demo)', companyById().name);
      break;
    case 'run-reconcile':
      d.reconciled = true;
      log('System', 'Reconciled first payroll and quarter', companyById().name, `${reconcile(analysisFor(), d).flags.length} flags`);
      break;
    case 'threshold': {
      const f = THRESHOLD_FIELDS.find((x) => x.key === el.dataset.key);
      const value = Number(el.value);
      if (!f || el.value === '' || !Number.isFinite(value) || value < f.min || value > f.max) { toast(`Enter a number from ${f?.min} to ${f?.max}.`); return; }
      state.settings.thresholds = { ...state.settings.thresholds, [f.key]: f.key === 'minSample' ? Math.round(value) : value };
      if (state.settings.thresholds[f.key] === DEFAULT_THRESHOLDS[f.key]) delete state.settings.thresholds[f.key];
      cache.clear();
      log('Intuit governance', 'Changed a gate threshold', f.label, f.show(state.settings.thresholds[f.key] ?? DEFAULT_THRESHOLDS[f.key]));
      break;
    }
    case 'reset-thresholds':
      state.settings.thresholds = {};
      cache.clear();
      log('Intuit governance', 'Restored the default thresholds', 'All states');
      toast('Thresholds are back to the defaults');
      break;
    case 'force-shadow': {
      state.settings.forceShadow = { ...state.settings.forceShadow, [el.dataset.state]: el.checked };
      cache.clear();
      log('Intuit governance', el.checked ? 'Forced shadow mode' : 'Lifted forced shadow mode', data.catalog.states[el.dataset.state].name);
      toast(el.checked ? 'Shadow mode forced: custom lines now go to an expert.' : 'Shadow mode lifted where the gates pass.');
      break;
    }
    case 'export-json': {
      const report = buildReport(analysisFor(), d, state.audit);
      download(`${companyById().company_id}-local-tax-report.json`, JSON.stringify(report, null, 2), 'application/json');
      return;
    }
    case 'export-csv': {
      const report = buildReport(analysisFor(), d, state.audit);
      download(`${companyById().company_id}-local-tax-lines.csv`, casesCSV(report), 'text/csv');
      return;
    }
    case 'copy-json':
    case 'copy-csv': {
      const report = buildReport(analysisFor(), d, state.audit);
      const csv = action === 'copy-csv';
      const text = csv ? casesCSV(report) : JSON.stringify(report, null, 2);
      const what = csv ? 'Lines' : 'Report';
      const box = document.getElementById('copy-box');
      const fallback = () => {
        box.value = text;
        box.hidden = false;
        box.focus();
        box.select();
        toast(`Copying is blocked here. The ${csv ? 'lines are' : 'report is'} selected below; copy manually.`);
      };
      try {
        navigator.clipboard.writeText(text).then(() => toast(`${what} copied to the clipboard`)).catch(fallback);
      } catch { fallback(); }
      return;
    }
    default:
      return;
  }
  // With automation on, every decision a person makes lets the rules finish what they now can.
  if (AUTO_FOLLOW.has(action) && decisionsFor().autoRun && !decisionsFor().live) {
    const res = runAutomationFor(state.companyId);
    if (res.actions.length) {
      const live = res.decisions.live;
      toast(`Automation took ${plural(res.actions.length, 'more step')}${live ? ': the company is now live and reconciled.' : '.'}`);
    }
  }
  save();
  render();
}
const AUTO_FOLLOW = new Set(['decide', 'unsend-expert', 'add-gap', 'expert-map', 'expert-nontax', 'expert-label', 'expert-stop', 'expert-custom', 'account', 'save-account', 'auto-rule']);
let navFocus = null; // where focus goes after a link to another screen has rendered it
// After an answer, the next thing that needs one is already open: put the cursor in its form.
const focusTask = () => (document.querySelector('.task input, .task button') ?? document.getElementById('detail-title') ?? document.getElementById('main'))?.focus({ preventScroll: true });

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || ['SELECT', 'INPUT', 'FORM', 'TEXTAREA'].includes(el.tagName)) return;
  if (el.disabled) return;
  byKeyboard = ev.detail === 0; // Enter or Space on a button reports no mouse clicks
  if (el.dataset.action === 'skip') { document.getElementById('main')?.focus(); return; }
  handle(el.dataset.action, el);
});
app.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el?.dataset.action === 'upload') { uploadFile(el); return; }
  if (el && ['company', 'account', 'force-shadow', 'threshold', 'auto-rule'].includes(el.dataset.action)) handle(el.dataset.action, el);
});
app.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-action]');
  if (!form) return;
  ev.preventDefault();
  handle(form.dataset.action, form);
});
app.addEventListener('input', (ev) => {
  if (ev.target.id !== 'queue-search') return;
  state.query[currentView()] = ev.target.value;
  save();
  applySearch(currentView());
});
// Close an open "More actions" menu when clicking elsewhere or pressing Escape.
document.addEventListener('click', (ev) => {
  for (const d of document.querySelectorAll('details.more[open], details.user-menu[open]')) if (!d.contains(ev.target)) d.open = false;
});
// Arrow keys move between a tab list's tabs.
app.addEventListener('keydown', (ev) => {
  const t = ev.target.closest?.('[role="tab"]');
  if (!t || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
  const tabs = [...t.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(t);
  const next = tabs[ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  ev.preventDefault();
  next.focus();
  next.click();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const d of document.querySelectorAll('details.more[open], details.user-menu[open]')) { d.open = false; d.querySelector('summary')?.focus(); }
});
window.addEventListener('hashchange', () => {
  if (!keepDetail) state.detailOpen = false;
  keepDetail = false;
  if (!pendingFocus) window.scrollTo(0, 0);
  render();
  if (state.detailOpen) scrollToDetail();
  document.getElementById('main')?.focus({ preventScroll: true });
  if (navFocus) { const go = navFocus; navFocus = null; go(); }
});

// Chart tooltips: any mark with data-tip shows its text next to the pointer.
const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.hidden = true;
tip.setAttribute('aria-hidden', 'true');
document.body.append(tip);
function placeTip(ev) {
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = ev.clientX + 14;
  let y = ev.clientY + 14;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
app.addEventListener('pointerover', (ev) => {
  const t = ev.target.closest?.('[data-tip]');
  if (!t) return;
  tip.textContent = t.getAttribute('data-tip');
  tip.hidden = false;
  placeTip(ev);
});
app.addEventListener('pointermove', (ev) => { if (!tip.hidden) placeTip(ev); });
app.addEventListener('pointerout', (ev) => { if (ev.target.closest?.('[data-tip]')) tip.hidden = true; });

// Keep the selected record's detail in view after choosing it: on a phone the list is replaced by the
// detail, and on a wide screen the page scrolls back up if the detail's top is out of view.
function scrollToDetail() {
  const d = document.querySelector('.detail');
  if (!d) return;
  const top = d.getBoundingClientRect().top + window.scrollY - 10;
  if (window.innerWidth <= 900 || window.scrollY > top) window.scrollTo(0, Math.max(0, top));
}

// ---------- data: the database, with the demo files as the fallback ----------

let SQLlib = null;
// The business being moved: the uploaded Desktop file if there is one, otherwise Buckeye Supply Co.
// Employees added from the Model page's "Try the clustering" panel join it on every rebuild.
const currentFile = () => {
  const biz = uploads[0] ?? { company: generated.companies[0], addresses: [] };
  return { ...biz, company: withAdded(biz.company) };
};
function withAdded(co) {
  const mine = state.added.filter((x) => x.company_id === co.company_id);
  if (!mine.length) return co;
  const items = [...co.items];
  const employees = [...co.employees];
  for (const x of mine) {
    const site = co.worksites.find((w) => w.site_id === x.site || w.name === x.site) ?? co.worksites[0];
    if (x.item && !items.some((i) => i.item_id === x.item.item_id)) items.push(x.item);
    employees.push({ ...x.employee, site_id: site.site_id });
  }
  return { ...co, items, employees };
}
// The same Desktop item if the business already has it (same label, Law ID and rate), otherwise a new one.
function itemFor(co, item) {
  const same = co.items.find((i) => i.label === item.label && i.law_id === item.law_id && i.tracking_type === item.tracking_type && i.calc?.kind === 'percent' && Number(i.calc.rate) === Number(item.calc.rate));
  if (same) return { item_id: same.item_id, item: null };
  let n = 1;
  while (co.items.some((i) => i.item_id === `I-ADD${n}`) || state.added.some((x) => x.item?.item_id === `I-ADD${n}`)) n += 1;
  return { item_id: `I-ADD${n}`, item: { ...item, item_id: `I-ADD${n}` } };
}
const lookupAddresses = () => [...files.geocoder.addresses, ...(generated?.addresses ?? [])];

// Build the database for the business being moved, and read the engine's input back from it.
// Addresses the employer added are applied again on every rebuild, so they survive a reload.
function rebuildData() {
  cache.clear();
  outcomesKey = null;
  scenarioResults = null;
  lookupIdx = lookupIndex(lookupAddresses());
  const biz = currentFile();
  state.companyId = biz.company.company_id;
  const corrections = state.corrections.filter((c) => c.company_id === state.companyId);
  if (SQLlib) {
    try {
      db?.close();
      db = createDatabase(SQLlib, { company: biz.company, addresses: biz.addresses, lookup: lookupAddresses(), catalog: files.catalog });
      for (const c of corrections) applyCorrection(db, c, lookupIdx, lookupAddresses());
      data = readData(db, { catalog: files.catalog, lookup: lookupAddresses(), pools: files.pools, lookupMeta: files.geocoder.metadata });
      return;
    } catch (err) { dbError = err.message; db = null; }
  }
  data = fromFiles({ ...files, companies: [] }, [biz]);
  for (const c of corrections) correctInMemory(c);
}
// Without the database (a viewer that blocks WebAssembly), the engine reads the files directly.
// The scenarios use this too, on the six small test files.
function fromFiles(f, ups, gen = null) {
  const unplacedAddresses = ups.flatMap((u) => u.addresses ?? []).map((a) => ({ ...a, school_district: 'UNRESOLVED', municipality: null }));
  return {
    catalog: f.catalog,
    geocoder: { ...f.geocoder, addresses: [...f.geocoder.addresses, ...(generated?.addresses ?? []), ...(gen?.addresses ?? []), ...unplacedAddresses] },
    pools: f.pools,
    companies: [...f.companies, ...ups.map((u) => u.company)],
  };
}

// Write the result tables: the engine's results, every decision and the log. Only when something changed.
function syncWork() {
  if (!db) return;
  const key = JSON.stringify([settingsKey(), state.companyId, state.decisions[state.companyId] ?? null, state.audit.length, state.audit[0]?.at ?? '', state.corrections.length]);
  if (key === outcomesKey) return;
  let analysis = null;
  try { analysis = analysisFor(); } catch (err) { if (err.name !== 'DataError') throw err; }
  writeResults(db, resultRows({ analysis, decisions: peekDecisions(state.companyId) }));
  outcomesKey = key;
}

function runSql(sql) {
  query.sql = sql;
  if (!db) { query.result = null; query.error = 'The database is not running here.'; return; }
  syncWork();
  try { query.result = runQuery(db, sql); query.error = null; } catch (err) { query.result = null; query.error = err.message; }
}

async function uploadFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  // A Desktop export for one business is a few hundred KB at most; a much larger file is not one.
  if (file.size > 5_000_000) {
    uploadMsg = { tone: 'bad', title: `${file.name} was not added`, items: [`It is ${(file.size / 1e6).toFixed(1)} MB. A Desktop file for one business is far smaller; check that this is the right file.`] };
    input.value = '';
    render();
    document.getElementById('upload-msg')?.focus({ preventScroll: false });
    return;
  }
  const text = await file.text();
  const id = `U-${Date.now().toString(36).toUpperCase()}`;
  const res = companyFromCsv(text, { ...files.geocoder, addresses: lookupAddresses() }, id);
  if (res.problems?.length) {
    uploadMsg = { tone: 'bad', title: `${file.name} was not added`, items: res.problems };
  } else {
    // The engine's own file checks: a file it cannot analyse is refused with its reasons.
    try {
      analyseCompany(res.company, fromFiles({ ...files, companies: [] }, [res]), state.settings);
      // Then the database's keys and rules: a file that breaks one is refused with the database's message.
      let refused = null;
      if (SQLlib) {
        try { createDatabase(SQLlib, { company: res.company, addresses: res.addresses, lookup: lookupAddresses(), catalog: files.catalog }).close(); } catch (err) { refused = err.message; }
      }
      if (refused) {
        uploadMsg = { tone: 'bad', title: `${file.name} was not added: the database refused it`, items: [refused] };
        input.value = '';
        render();
        document.getElementById('upload-msg')?.focus({ preventScroll: false });
        return;
      }
      // One business at a time: the file replaces the demo business until it is removed.
      if (uploads[0]) delete state.decisions[uploads[0].company.company_id];
      uploads = [{ company: res.company, addresses: res.addresses, file: file.name }];
      saveUploads();
      rebuildData();
      const a = analysisFor(id);
      log('Admin', 'Uploaded a Desktop file', res.company.name, file.name);
      uploadMsg = { tone: 'good', title: `Now moving ${res.company.name}`, items: [`${plural(res.company.employees.length, 'employee')} and ${plural(a.cases.length, 'Desktop line')}: ${a.cases.filter((c) => c.route === 'local_tax').length} local tax, ${a.cases.filter((c) => c.route === 'not_a_tax').length} not a tax, ${a.cases.filter((c) => c.route === 'not_in_database').length} to an expert.`, ...a.dataIssues.map((d) => d.text)] };
    } catch (err) {
      if (err.name !== 'DataError') throw err;
      uploadMsg = { tone: 'bad', title: `${file.name} was not added: the engine stops on it`, items: err.issues.map((x) => x.text) };
    }
  }
  input.value = '';
  save();
  render();
  document.getElementById('upload-msg')?.focus({ preventScroll: false });
}

async function boot() {
  try {
    const get = async (file) => {
      const res = await fetch(new URL(`./data/${file}`, import.meta.url));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      return res.json();
    };
    const [catalog, geocoder, pool, companies] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json', 'companies.json'].map(get));
    files = { catalog, geocoder, pools: pool.pools, poolMeta: pool.metadata, companies: companies.companies, companiesMeta: companies.metadata };
    generated = generateBusinesses(catalog, { count: 1 }); // the business being moved: Buckeye Supply Co.
    try { SQLlib = await loadSqlJs(); } catch (err) { dbError = err.message || 'WebAssembly is blocked here'; }
    rebuildData();
    render();
    chat = createChat({
      situation: chatKey, context: chatContext, ai: () => ({ via: ai.via, label: ai.label, name: aiName(), hosted: ai.hosted }), call: (turns, o) => aiCall(turns, { ...o, cache: false }),
      connected: aiConnected, claudeOff: () => { ai.state = 'off'; ai.via = null; render(); },
      format: aiText, icon, esc,
    });
    connectAI();
  } catch (err) {
    app.innerHTML = `<p class="boot">The demo data did not load (${esc(err.message)}). Run <code>npm run build</code> and <code>npm start</code>, then open http://localhost:3000.</p>`;
  }
}

boot();
