// Browser app for the BRD v3 local-tax migration prototype. No framework, no build step.
import { analyseCompany, DEFAULT_THRESHOLDS } from './engine/analysis.mjs';
import { MODEL_VERSION } from './engine/cluster.mjs';
import { effectiveAll, emptyDecisions, gapStage, gapCoveredBy, readiness, w2Preview, reconcile, liveTaxes, STAGE_LABEL, automate, automationStats, exceptions as openExceptions, AUTOMATION_RULES, DEFAULT_POLICY, NEEDS_ADDRESS } from './engine/workflow.mjs';
import { monthSpan, rateText, cloudMonths, desktopMonths } from './engine/util.mjs';
import { buildReport, casesCSV } from './report.mjs';
import { GROUPS, runScenarios } from './scenarios.mjs';
import { loadSqlJs, createDatabase, readData, readCompanies, writeOutcomes, tableSummary, runQuery, csvTemplate, companyFromCsv, CSV_COLUMNS, applyCorrection, lookupIndex, addressKey } from './db.mjs';
import { generateBusinesses, SEED } from './generate.mjs';
import { runLab, KEY_NAMES } from './mllab.mjs';

const STORE = 'local-tax-migration:brd-v3';
const UPLOADS = 'local-tax-migration:uploads';
const VIEWS = ['move', 'review', 'expert', 'golive', 'portfolio', 'model', 'lab', 'analysis', 'data', 'scenarios', 'audit'];

// Demo sign-in: each role sees only its own screens. Admin can also open any record from a scenario.
// The owner moves one business. Intuit staff see every business: the expert by queue, the admin as a portfolio.
const ROLES = {
  owner: { icon: 'building', label: 'Business owner', side: 'Customer', blurb: 'Moves their own business to Online payroll', tabs: [['move', 'Move'], ['review', 'To do'], ['golive', 'Go live']] },
  expert: { icon: 'user', label: 'Payroll tax expert', side: 'Intuit staff', blurb: 'Decides the lines the rules leave', tabs: [['expert', 'Queue']] },
  admin: { icon: 'gauge', label: 'Admin', side: 'Intuit staff', blurb: 'Every business, the model and the data', tabs: [['portfolio', 'Portfolio'], ['model', 'Model'], ['lab', 'ML Lab'], ['analysis', 'Engine'], ['data', 'Data'], ['scenarios', 'Scenarios'], ['audit', 'Log']] },
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
let uploads = loadUploads(); // Desktop files uploaded on the Data page: [{ company, addresses }]
let uploadMsg = null;       // the last upload's result: { tone, title, items }
let query = { sql: 'SELECT route, COUNT(*) AS lines\nFROM line_outcomes\nGROUP BY route\nORDER BY lines DESC', result: null, error: null };
let generated = null;       // the synthetic businesses (100+ employees each), made from a fixed seed on every visit
let lookupIdx = null;       // address lookup by street and ZIP, for addresses the employer adds
const previews = new Map(); // one row per business for the portfolio: what the rules settle and what is left
let warming = null;         // the portfolio's first pass over every business, a few at a time: { done, total, timer }
let outcomesKey = null;     // the state the outcome tables were last written for
let lab = { seed: SEED, total: 1200, result: null, running: false, error: null };
const more = {};            // "Show all" toggles for long lists

// ---------- state ----------

function freshState() {
  return { role: null, companyId: 'G-001', settings: { forceShadow: {}, thresholds: {} }, decisions: {}, audit: [], filters: { review: 'todo', expert: 'open' }, sel: {}, selIndex: {}, query: {}, moveStep: {}, detailOpen: false, corrections: [] };
}
function loadUploads() {
  try { return JSON.parse(localStorage.getItem(UPLOADS) ?? '[]'); } catch { return []; }
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
      return { ...fresh, ...saved, role: ROLES[saved.role] ? saved.role : null, settings: { ...fresh.settings, ...(saved.settings ?? {}) }, filters: { ...fresh.filters, ...(saved.filters ?? {}) }, sel: saved.sel ?? {}, selIndex: saved.selIndex ?? {}, query: saved.query ?? {}, moveStep: saved.moveStep ?? {}, corrections: saved.corrections ?? [] };
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
  for (const m of [cache, previews]) for (const k of [...m.keys()]) if (k.startsWith(`${id}|`)) m.delete(k);
  outcomesKey = null;
}
const sourceOf = (id) => (id.startsWith('G-') ? 'generated' : id.startsWith('U-') ? 'upload' : 'story');
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
    info: cases.filter((c) => c.stage === 'with_expert' && NEEDS_ADDRESS.has(c.reason) && !c.decision.sentToExpert).length, // waiting for an address from the employer
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
  if (!state.role) { app.innerHTML = signIn(); lastView = null; return; }
  const view = currentView();
  const prevFocus = focusSelector(document.activeElement);
  let s;
  try {
    s = summary();
  } catch (err) {
    if (err.name !== 'DataError') throw err;
    // A Desktop file that cannot be analysed: say what is wrong instead of showing a broken page.
    const other = data.companies.find((c) => c.company_id !== state.companyId);
    app.innerHTML = `<main class="main" id="main" tabindex="-1"><div class="page"><div class="page-head"><h1>${esc(companyById().name)}: the Desktop file cannot be analysed</h1>
      <p class="lede">Fix these problems in the file first. Nothing has been mapped.</p></div>
      <ul class="marks">${err.issues.map((i) => `<li>${mark('fail')}<span>${esc(i.text)}</span></li>`).join('')}</ul>
      ${other ? `<p><button class="btn" type="button" data-action="company-switch" data-id="${esc(other.company_id)}">Open ${esc(other.name)}</button></p>` : ''}${footnote()}</div></main>`;
    return;
  }
  const wide = view === 'review' || view === 'expert';
  const listScroll = lastView === view ? document.querySelector('.records')?.scrollTop : null;
  const body = { move: viewMove, portfolio: viewPortfolio, lab: viewLab, analysis: viewAnalysis, review: viewReview, expert: viewExpert, golive: viewGoLive, scenarios: viewScenarios, model: viewModel, audit: viewAudit, data: viewData }[view](s);
  app.innerHTML = `<button class="skip" type="button" data-action="skip">Skip to main content</button>${appbar(view, s)}<main class="main" id="main" tabindex="-1"><div class="page${wide ? ' wide' : ''}">${body}${footnote()}</div></main>`;
  lastView = view;
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
    empty.textContent = items.length && !shown ? `No records match "${q}".` : empty.dataset.empty;
  }
}

// The scenarios check the six story clients exactly as shipped: no uploads, no added addresses.
function scenarios() {
  scenarioResults ??= runScenarios(fromFiles(files, [], null));
  return scenarioResults;
}

// Screens that are about one business show its status line; the rest are about every business or the model.
const COMPANY_VIEWS = new Set(['move', 'review', 'expert', 'golive', 'analysis']);
const GLOBAL_VIEWS = new Set(['portfolio', 'lab', 'data', 'scenarios']);

// Businesses in groups: the generated ones (100+ employees) first, then the small story clients, then uploads.
function companyOptions() {
  const opt = (c) => `<option value="${esc(c.company_id)}"${c.company_id === state.companyId ? ' selected' : ''}>${esc(c.name)}${sourceOf(c.company_id) === 'generated' ? ` (${c.employees.length})` : ''}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '');
  const by = (src) => data.companies.filter((c) => sourceOf(c.company_id) === src);
  return group('Generated businesses, employees in brackets', by('generated')) + group('Story clients, one case each', by('story')) + group('Uploaded', by('upload'));
}

function appbar(view, s) {
  const co = s.a.company;
  const role = roleOf();
  // A step shows a tick once nothing is left in it, so the customer's tabs double as a progress tracker.
  const moved = Boolean(s.d.autoRun || s.d.live);
  const finished = { move: moved, review: moved && s.awaiting === 0 && s.info === 0, golive: Boolean(s.d.reconciled), expert: s.expert === 0 };
  const steps = state.role === 'owner';
  const tab = ([id, text], i) => {
    const n = id === 'review' ? s.awaiting + s.info : id === 'expert' ? s.expert : 0;
    const done = steps && finished[id];
    const mark = steps ? `<span class="step">${done ? `${icon('tick')}<span class="sr-only">Done:</span>` : i + 1}</span>` : '';
    return `<a href="#${id}"${view === id ? ' aria-current="page"' : ''}${done ? ' class="done"' : ''}>${mark}${text}${n ? `<span class="count" aria-label="${n} open">${n}</span>` : ''}${id === 'scenarios' ? `<span class="count ok">${scenarioCount()}</span>` : ''}</a>`;
  };
  const company = state.role === 'owner'
    ? `<span class="company-box static">${icon('building')}<span class="co-name">${esc(co.name)}</span><span class="plan">${esc(co.plan)}</span></span>`
    : GLOBAL_VIEWS.has(view) ? ''
      : `<label class="company-box"><span class="sr-only">Business</span>${icon('building')}<select id="company" data-action="company">${companyOptions()}</select><span class="plan">${esc(co.plan)}</span></label>`;
  const user = `<span class="user-chip"><span class="avatar role-ic">${icon(role.icon)}</span><span class="user-text"><strong>${esc(role.label)}</strong><small>${esc(role.side)}</small></span></span>
    <button class="btn quiet signout" type="button" data-action="sign-out">Sign out</button>`;
  const total = s.cases.length;
  const lines = s.cases.filter((c) => c.stage === 'awaiting_employer').length;
  const gaps = s.awaiting - lines;
  const action = lines + gaps + s.expert;
  const expertOnly = s.expert - s.info;
  const items = total + s.a.gaps.length; // Desktop lines plus expected taxes nobody withheld
  const statusTone = { 'Not started': 'info', 'In review': 'accent', Live: 'good', Reconciled: 'good' }[s.status];
  const status = COMPANY_VIEWS.has(view) ? `<div class="batchbar">
      <span class="status ${statusTone}"><span class="dot"></span>${esc(s.status)}</span>
      <span class="batch-progress"><span class="progress" role="img" aria-label="${items - action} of ${items} items settled"><span style="width:${(items ? ((items - action) / items) * 100 : 0).toFixed(1)}%"></span></span><span><b>${items - action}</b> of ${items} settled</span></span>
      ${action ? `${lines + gaps ? `<span class="batch-need warn"><b>${lines + gaps}</b> with the employer</span>` : ''}${s.info ? `<span class="batch-need warn"><b>${s.info}</b> waiting for an address</span>` : ''}${expertOnly ? `<span class="batch-need blue"><b>${expertOnly}</b> with an expert</span>` : ''}` : `<span class="batch-need done">${icon('tick')}Nothing waiting</span>`}
      ${s.d.autoRun ? `<span class="batch-auto">${icon('spark')}<b>${pct(automationStats(s.a, s.d).share, 0)}</b> automated</span>` : ''}
    </div>` : '';
  return `<header class="appbar">
    <div class="topbar">
      <a class="logo" href="#${role.tabs[0][0]}"><span class="logo-tile">${icon('landmark')}</span><span class="logo-text"><strong>Local Tax Migration</strong><small>Desktop to Online payroll, demo</small></span></a>
      <nav class="tabs" aria-label="${esc(role.label)} screens">${role.tabs.map(tab).join('')}</nav>
      <div class="top-tools">
        ${company}
        ${user}
        <button class="btn reset${resetArmed ? ' armed' : ''}" type="button" data-action="reset" title="Clear every decision and upload, and start the demo again">${icon('reset')}<span>${resetArmed ? 'Click again to reset' : 'Reset'}</span></button>
      </div>
    </div>
    ${status}
  </header>`;
}

// ---------- sign in (demo accounts, no passwords) ----------

function signIn() {
  const account = (id, extra = '') => {
    const r = ROLES[id];
    return `<div class="acct"><span class="avatar lg role-ic">${icon(r.icon)}</span><div class="acct-text"><strong>${esc(r.label)}</strong><span>${esc(r.blurb)}</span>${extra}</div><button class="btn primary" type="button" data-action="sign-in" data-role="${id}">Sign in</button></div>`;
  };
  const pick = `<label class="acct-pick"><span class="sr-only">Business</span><select id="signin-company">${companyOptions()}</select></label>`;
  return `<main class="signin" id="main" tabindex="-1">
    <section class="signin-brand">
      <span class="logo-tile">${icon('landmark')}</span>
      <h1>Local Tax Migration</h1>
      <p>Desktop to Online payroll, with every local tax checked line by line.</p>
      <ul class="signin-points">
        <li>${icon('check')}Rules settle most lines</li>
        <li>${icon('check')}Experts decide the rest</li>
        <li>${icon('check')}Nothing goes live without the employer</li>
      </ul>
    </section>
    <section class="signin-panel" aria-labelledby="signin-h">
      <div><h2 id="signin-h">Sign in</h2><p class="card-sub">Demo accounts, no passwords.</p></div>
      <div class="signin-group"><h3>Customer</h3>${account('owner', pick)}</div>
      <div class="signin-group"><h3>Intuit staff</h3>${account('expert')}${account('admin')}</div>
      <p class="small muted">In a real product, customers would use their Intuit account and staff the company sign-in.</p>
    </section>
    ${footnote()}
  </main>`;
}

function scenarioCount() {
  const r = scenarios();
  return `${r.filter((x) => x.pass).length}/${r.length}`;
}

function footnote() {
  return `<p class="footnote">Academic prototype for the BDA group exam, Case 19. Businesses, people and wages are fictional (60 are generated from a fixed seed); Ohio school-district and city tax rates are real (2026). Not affiliated with Intuit.</p>`;
}

// ---------- automation ----------

const policyOf = (d) => ({ ...DEFAULT_POLICY, ...(d.policy ?? {}) });
const ruleLabel = (id) => AUTOMATION_RULES.find((r) => r.id === id)?.label ?? id;
const EXCEPTION_TEXT = { held: 'Held after an undo', rule_off: 'Its rule is switched off', account_missing: 'Agency account number missing' };
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
  const taxes = new Map();
  for (const e of a.employees) for (const x of e.expected.list) taxes.set(x.tax.tax_id, x.tax);
  return {
    employees: co.employees.length,
    items: co.items.length,
    lines: a.cases.length,
    custom: a.cases.filter((c) => c.item.origin === 'custom').length,
    expected: a.employees.reduce((n, e) => n + e.expected.list.length, 0),
    labels: [...new Set(co.items.map((i) => labelOf(i.label)))],
    taxes: [...taxes.values()],
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

// Loose Desktop labels on one side, the exact taxes the addresses call for on the other.
function transferFigure(f) {
  const more = (n) => (n > 0 ? `<li class="more-n">and ${n} more</li>` : '');
  const labels = f.labels.slice(0, 4).map((l) => `<li class="loose">${esc(l)}</li>`).join('') + more(f.labels.length - 4);
  const taxes = f.taxes.slice(0, 4).map((t) => `<li class="exact">${icon('tick')}<span>${esc(taxShort(t))}</span>${typeof t.rate === 'number' ? `<b>${esc(rateFmt(t.rate))}</b>` : ''}</li>`).join('') + more(f.taxes.length - 4);
  return `<figure class="xfer">
    <div class="xfer-col desk"><span class="xfer-h">${icon('monitor')}On Desktop: labels</span><ul>${labels}</ul></div>
    <span class="xfer-arrow" aria-hidden="true">${icon('arrow')}</span>
    <div class="xfer-col online"><span class="xfer-h">${icon('cloud')}In Online payroll: exact taxes</span><ul>${taxes || '<li class="more-n">None expected at these addresses</li>'}</ul></div>
    <figcaption>Desktop knows local taxes by whatever name someone typed. Online payroll needs the exact tax for each address.</figcaption>
  </figure>`;
}

function moveStart(s) {
  const f = moveFacts(s);
  const co = s.a.company;
  const ytd = f.desktop.length ? `${monthSpan(f.desktop)}, from Desktop` : 'None: the move is in January';
  return `${moveStepper(0)}
    <section class="move-hero" aria-labelledby="move-h">
      <div class="move-copy">
        <h1 id="move-h" class="move-h" tabindex="-1">Move ${esc(co.name)} <span class="soft">to Online payroll</span></h1>
        <p class="lede">Employees, pay items and year-to-date totals move as they are. Local taxes get checked first, line by line, so each one lands on the exact tax for that person's address.</p>
        <div class="move-facts">
          <span class="with-stack">${avatarStack(f.names, 3)}${plural(f.employees, 'employee')}</span>
          <span>${icon('calendar')}First Online payroll in ${esc(f.first)}</span>
          <span>${icon('layers')}${esc(co.plan)} plan</span>
        </div>
        <div class="row move-cta"><button class="btn primary lg" type="button" data-action="move-next">Get started${icon('arrow')}</button></div>
      </div>
      ${transferFigure(f)}
    </section>
    <section class="section" aria-labelledby="what-h">
      <div class="section-head"><h2 id="what-h">What moves</h2><p>In this demo the copying is simulated. The local tax checks run for real on the demo data.</p></div>
      <ul class="moves">
        <li><span class="mv-ic">${icon('users')}</span><div><strong>Employees and addresses</strong><span>${plural(f.employees, 'employee')}, with home and work addresses</span></div><span class="mv-how">Copied</span></li>
        <li><span class="mv-ic">${icon('layers')}</span><div><strong>Pay items and deductions</strong><span>${plural(f.items, 'Desktop item')} on file</span></div><span class="mv-how">Copied</span></li>
        <li><span class="mv-ic">${icon('calendar')}</span><div><strong>Year-to-date totals</strong><span>${esc(ytd)}</span></div><span class="mv-how">Copied</span></li>
        <li class="key"><span class="mv-ic">${icon('pin')}</span><div><strong>Local taxes</strong><span>${plural(f.lines, 'Desktop line')}, one per employee per item, checked against ${plural(f.expected, 'expected tax', 'expected taxes')}</span></div><span class="mv-how">Checked line by line</span></li>
      </ul>
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
      <p class="lede">Every Desktop local tax line was checked against each employee's addresses. This is what your rules will settle, and what stays for a person to decide.</p></div>
    <div class="check-grid">
      <section class="panel check-result" aria-labelledby="res-h">
        <h2 id="res-h">Local taxes after the move</h2>
        <div class="auto-score flat">
          <span class="ring" role="img" aria-label="${share} can be settled by rule" style="--p:${(st.share * 100).toFixed(1)}"><span>${share}</span></span>
          <div><p class="auto-line"><b>${st.auto}</b> of ${plural(st.total, 'item')} can be settled by rule</p><p class="auto-sub">Desktop lines plus expected taxes nobody withheld. Lines that need judgement are never guessed.</p></div>
        </div>
        <div class="chips">${chips}</div>
        <div class="check-left"><span class="label">${left.length ? `Will stay for a person (${left.length})` : 'Will stay for a person'}</span>${leftList}</div>
      </section>
      <section class="panel check-rules" aria-labelledby="rules-h">
        <div class="section-head"><h2 id="rules-h">Rules you approve</h2><p>Each rule settles one kind of line. Switch one off to decide those lines yourself.</p></div>
        <div class="rules-list">${rules}</div>
      </section>
    </div>
    ${issues.length ? `<section class="panel section" aria-labelledby="dq-h"><h2 id="dq-h">Problems found in the Desktop file</h2><p class="small muted">These were cleaned up so the check could run. Fix them in the file as well.</p><ul class="marks">${issues.map((i) => `<li>${mark('warn')}<span>${esc(i.text)}</span></li>`).join('')}</ul></section>` : ''}
    <div class="move-actions">
      <button class="btn" type="button" data-action="move-back">${icon('back')}Back</button>
      <p class="small muted">Nothing switches on in Online payroll until a rule or a person confirms it.</p>
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
      ? `${st.auto} of ${plural(st.total, 'local tax item')} settled by rule. ${plural(left.length, 'item needs', 'items need')} a person before the first Online payroll in ${f.first}.`
      : 'Every local tax item is settled. The go-live checks are next.';
  const waitTone = expert.length && !employer.length ? 'blue' : left.length ? 'warn' : 'good';
  const waitSub = left.length ? [expert.length ? `${expert.length} with an expert` : '', employer.length ? `${employer.length} with the employer` : ''].filter(Boolean).join(', ') : 'Nothing waiting';
  // A customer cannot open the expert queue: their row says who has it instead.
  const open = (x) => (x.kind === 'account' ? '<a class="btn" href="#golive">Add it</a>'
    : x.needs === 'address' ? `<button class="btn" type="button" data-action="focus-missing" data-employee="${esc(x.employee_id)}">Add address</button>`
      : x.owner === 'expert' && !canOpen('expert') ? ''
        : `<button class="btn" type="button" data-action="goto" data-view="${x.owner === 'expert' ? 'expert' : 'review'}" data-key="${esc(x.kind === 'gap' ? `g|${x.gap_id}` : `c|${x.case_id}`)}">Open</button>`);
  const waitHref = employer.length ? (employer.every((x) => x.kind === 'account') ? '#golive' : '#review') : expert.length && canOpen('expert') ? '#expert' : null;
  const rules = AUTOMATION_RULES.map((r) => `<label class="rule"><input type="checkbox" data-action="auto-rule" data-rule="${r.id}"${policy[r.id] ? ' checked' : ''}${d.live ? ' disabled' : ''}><span><strong>${esc(r.label)}</strong><span>${esc(r.help)}</span></span></label>`).join('');
  const report = left.length
    ? `<ul class="exc-list">${left.map((x) => `<li>${x.employee ? avatar(x.employee) : `<span class="avatar">${icon('landmark')}</span>`}<span class="who"><strong>${esc(x.employee ?? x.item)}</strong>${x.employee ? `<span>"${esc(labelOf(x.item))}"</span>` : '<span>Agency account</span>'}</span><span class="exc-tags">${badge(exceptionText(x), x.owner === 'expert' ? 'blue' : 'warn')}<span class="owner ${x.owner === 'expert' ? 'blue' : 'warn'}">${x.owner === 'expert' ? 'Expert' : 'Employer'}</span></span>${open(x)}</li>`).join('')}</ul>`
    : `<p class="auto-done flat">${icon('check')}No exceptions. Nothing needs a person.</p>`;
  const accounts = employer.filter((x) => x.kind === 'account').length;
  const addresses = new Set(employer.filter((x) => x.needs === 'address').map((x) => x.employee_id)).size;
  const decides = employer.length - accounts - employer.filter((x) => x.needs === 'address').length;
  const employerText = [
    addresses ? `adds ${plural(addresses, 'home address', 'home addresses')}` : '',
    accounts ? `adds ${plural(accounts, 'agency account number')}` : '',
    decides ? `decides ${plural(decides, 'item')}` : '',
  ].filter(Boolean).join(' and ');
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
        <div class="card-head"><div><h2 id="exc-h">Exception report</h2><p class="card-sub">What the rules left for a person</p></div></div>
        <div class="card-body">${report}</div>
      </section>
      <section class="card" aria-labelledby="next-h">
        <div class="card-head"><div><h2 id="next-h">What happens next</h2><p class="card-sub">Up to the first Online payroll</p></div>${arrowLink('#golive', 'Open the go-live checks')}</div>
        <div class="card-body"><ol class="next-steps">${next.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="mv-mark${x.done ? ' done' : ''}">${x.done ? `${icon('tick')}<span class="sr-only">Done:</span>` : ''}</span><span>${esc(x.text)}</span></li>`).join('')}</ol></div>
        ${fold('list', `Your rules (${AUTOMATION_RULES.filter((r) => policy[r.id]).length} of ${AUTOMATION_RULES.length} on)`, `<div class="rules-list">${rules}</div>`)}
      </section>
    </div>`;
}

// ---------- portfolio (admin): every business at once ----------
// Each business goes through the whole engine and its rules: what the rules settled, or, for a business
// that has not moved yet, what they would settle. The first pass takes a few seconds, so it runs a few
// businesses at a time behind a progress bar; after that each row is kept until that business changes.

const count = new Intl.NumberFormat('en-US');
const num = (n) => count.format(n);
const SOURCE_TEXT = { generated: 'Generated', story: 'Story client', upload: 'Uploaded' };
const rowKey = (id) => `${id}|${settingsKey()}|${JSON.stringify(peekDecisions(id))}`;

function portfolioRow(id) {
  const key = rowKey(id);
  if (previews.has(key)) return previews.get(key);
  const c = companyById(id);
  const d = peekDecisions(id);
  const base = { id, name: c.name, source: sourceOf(id), plan: c.plan, employees: c.employees.length };
  let row;
  try {
    const a = analysisFor(id);
    const ran = Boolean(d.autoRun || d.live);
    const after = ran ? d : automate(a, d, policyOf(d)).decisions;
    const st = automationStats(a, after);
    const left = openExceptions(a, after);
    const expert = left.filter((x) => x.owner === 'expert').length;
    row = { ...base, lines: a.cases.length, st, left, expert, employer: left.length - expert, ran, status: d.reconciled ? 'Reconciled' : d.live ? 'Live' : ran ? 'Moved' : 'Not moved' };
  } catch (err) {
    if (err.name !== 'DataError') throw err;
    row = { ...base, broken: err.issues.length };
  }
  previews.set(key, row);
  return row;
}
const unchecked = () => data.companies.filter((c) => !previews.has(rowKey(c.company_id))).map((c) => c.company_id);

function warmUp() {
  if (warming) return;
  const todo = unchecked();
  if (!todo.length) return;
  const total = data.companies.length;
  warming = { done: total - todo.length, total, timer: null };
  const step = () => {
    const t0 = performance.now();
    while (todo.length && performance.now() - t0 < 40) { portfolioRow(todo.shift()); warming.done += 1; }
    const bar = document.getElementById('warm-bar');
    if (bar) { bar.setAttribute('aria-valuenow', String(warming.done)); bar.firstElementChild.style.width = `${((warming.done / total) * 100).toFixed(1)}%`; }
    const text = document.getElementById('warm-n');
    if (text) text.textContent = `${warming.done} of ${total}`;
    if (todo.length) { warming.timer = setTimeout(step, 0); return; }
    warming = null;
    if (state.role && ['portfolio', 'data'].includes(currentView())) render();
  };
  warming.timer = setTimeout(step, 30);
}

function warmPanel() {
  const total = data.companies.length;
  const done = warming?.done ?? total - unchecked().length;
  return `<section class="panel warm" aria-labelledby="warm-h">
    <h2 id="warm-h">Checking every business</h2>
    <div class="progress wide" id="warm-bar" role="progressbar" aria-label="Businesses checked" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${((done / total) * 100).toFixed(1)}%"></span></div>
    <p class="small muted"><b id="warm-n">${done} of ${total}</b>. Each one goes through the whole engine: addresses, label clusters, routes and the rules.</p>
  </section>`;
}

const BINS = [[0, 0.9, 'Under 90%'], [0.9, 0.95, '90–95%'], [0.95, 0.98, '95–98%'], [0.98, 0.99, '98–99%'], [0.99, 1, '99–100%'], [1, 2, '100%']];
const niceMax = (n) => { const step = n <= 8 ? 2 : n <= 20 ? 5 : n <= 40 ? 10 : 20; return Math.max(step * 4, Math.ceil(n / step) * step); };

function viewPortfolio() {
  const head = `<div class="page-head"><h1>Portfolio <span class="soft">every business moving to Online payroll</span></h1></div>`;
  if (unchecked().length) { warmUp(); return head + warmPanel(); }
  const rows = data.companies.map((c) => portfolioRow(c.company_id));
  const ok = rows.filter((r) => !r.broken);
  const sum = (f) => ok.reduce((n, r) => n + f(r), 0);
  const employees = rows.reduce((n, r) => n + r.employees, 0);
  const auto = sum((r) => r.st.auto);
  const total = sum((r) => r.st.total);
  const left = sum((r) => r.left.length);
  const expert = sum((r) => r.expert);
  const notMoved = ok.filter((r) => !r.ran).length;
  const of = (src) => rows.filter((r) => r.source === src).length;
  const mix = [of('generated') ? `${of('generated')} generated, 100+ employees each` : '', of('story') ? `${of('story')} story clients` : '', of('upload') ? `${of('upload')} uploaded` : ''].filter(Boolean).join('; ');

  // How many businesses fall in each band of "share settled by rule".
  const bins = BINS.map(([lo, hi, label]) => ({ label, n: ok.filter((r) => r.st.share >= lo && r.st.share < hi).length }));
  const top = niceMax(Math.max(...bins.map((b) => b.n)));
  const axis = [1, 0.75, 0.5, 0.25, 0].map((f) => `<span style="--y:${f * 100}">${Math.round(top * f)}</span>`).join('');
  const cols = bins.map((b) => `<li><span class="bar-wrap"><span class="bar" style="--h:${((b.n / top) * 100).toFixed(1)}"><span class="bar-val">${b.n}</span></span></span><span class="bar-lbl">${esc(b.label)}<span class="sr-only">: ${plural(b.n, 'business', 'businesses')}</span></span></li>`).join('');

  // What is left for a person, by reason. Blue is with an expert, amber with the employer.
  const reasons = new Map();
  for (const r of ok) {
    for (const x of r.left) {
      const v = reasons.get(x.reason) ?? { reason: x.reason, owner: x.owner, n: 0 };
      v.n += 1;
      reasons.set(x.reason, v);
    }
  }
  const list = [...reasons.values()].sort((a, b) => b.n - a.n);
  const rmax = Math.max(1, ...list.map((x) => x.n));
  const hbars = list.length
    ? `<ul class="hbars">${list.map((x) => `<li><span class="hb-lbl">${esc(exceptionText(x))}<span class="owner ${x.owner === 'expert' ? 'blue' : 'warn'}">${x.owner === 'expert' ? 'Expert' : 'Employer'}</span></span><span class="hb-track"><span class="hb-bar ${x.owner === 'expert' ? 'blue' : 'warn'}" style="width:${((x.n / rmax) * 100).toFixed(1)}%"></span><b>${num(x.n)}</b></span></li>`).join('')}</ul>`
    : `<p class="auto-done flat">${icon('check')}Nothing is left for a person anywhere.</p>`;

  const tone = { 'Not moved': '', Moved: 'blue', Live: 'good', Reconciled: 'good' };
  const sorted = [...rows].sort((a, b) => (b.broken ? 1e9 : b.left.length) - (a.broken ? 1e9 : a.left.length) || b.employees - a.employees);
  const shown = more.portfolio ? sorted : sorted.slice(0, 12);
  const cell = (r) => `<td><div class="client-cell"><span class="co-tile ${tone[r.status] || 'idle'}" aria-hidden="true">${esc(initials(r.name))}</span><div><strong>${esc(r.name)}</strong><div class="small muted">${SOURCE_TEXT[r.source]}, ${esc(r.plan)} plan</div></div></div></td>`;
  const open = (r) => `<td><button class="btn quiet" type="button" data-action="company-switch" data-id="${esc(r.id)}" data-view="analysis">Open</button></td>`;
  const body = shown.map((r) => (r.broken
    ? `<tr>${cell({ ...r, status: '' })}<td class="num" data-l="Employees">${r.employees}</td><td colspan="5" data-l="Status"><span class="bad-text">The engine stops on this file: ${plural(r.broken, 'problem')}</span></td>${open(r)}</tr>`
    : `<tr>${cell(r)}
      <td class="num" data-l="Employees">${num(r.employees)}</td>
      <td class="num" data-l="Desktop lines">${num(r.lines)}</td>
      <td class="num" data-l="Settled by rule"><span class="auto-cell"><b>${pct(r.st.share)}</b><span class="progress xs" aria-hidden="true"><span style="width:${(r.st.share * 100).toFixed(1)}%"></span></span></span></td>
      <td class="num" data-l="With an expert">${r.expert || '<span class="muted">0</span>'}</td>
      <td class="num" data-l="With the employer">${r.employer || '<span class="muted">0</span>'}</td>
      <td data-l="Status">${pill(r.status, tone[r.status])}</td>
      ${open(r)}
    </tr>`)).join('');

  return `${head}
    <div class="wl-tiles four">
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('building')}Businesses</span></div><span class="n">${rows.length}</span><p>${esc(mix)}</p></div>
      <div class="wl-tile"><div class="tile-head"><span class="t">${icon('users')}Employees</span></div><span class="n">${num(employees)}</span><p>${num(sum((r) => r.lines))} Desktop local tax lines</p></div>
      <div class="wl-tile good"><div class="tile-head"><span class="t">${icon('spark')}Settled by rule</span></div><span class="n">${pct(total ? auto / total : 0)}</span><p>${num(auto)} of ${num(total)} items</p></div>
      <div class="wl-tile ${left ? 'warn' : 'good'}"><div class="tile-head"><span class="t">${icon('user')}Waiting for a person</span></div><span class="n">${num(left)}</span><p>${num(expert)} with an expert, ${num(left - expert)} with employers</p></div>
    </div>
    <div class="dash-grid even">
      <section class="card chart-card" aria-labelledby="hist-h">
        <div class="card-head"><div><h2 id="hist-h">Businesses by share settled by rule</h2><p class="card-sub">${notMoved ? `${notMoved === ok.length ? 'None has moved yet: what' : `${plural(notMoved, 'business has', 'businesses have')} not moved yet: for them, what`} the rules would settle` : 'After each move'}</p></div></div>
        <div class="chart"><div class="axis" aria-hidden="true">${axis}</div><ol class="bars">${cols}</ol></div>
      </section>
      <section class="card" aria-labelledby="left-h">
        <div class="card-head"><div><h2 id="left-h">What is left for a person</h2><p class="card-sub">By reason, across every business</p></div></div>
        <div class="card-body">${hbars}</div>
      </section>
    </div>
    <section class="card" aria-labelledby="biz-h">
      <div class="card-head"><div><h2 id="biz-h">Businesses</h2><p class="card-sub">Most work left first. Open one to see how the engine read it.</p></div></div>
      <div class="table-wrap"><table class="biz-table">
        <thead><tr><th>Business</th><th class="num">Employees</th><th class="num">Desktop lines</th><th class="num">Settled by rule</th><th class="num">With an expert</th><th class="num">With the employer</th><th>Status</th><th><span class="sr-only">Open</span></th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${sorted.length > 12 ? `<div class="card-foot"><button class="btn quiet" type="button" data-action="show-more" data-key="portfolio">${more.portfolio ? 'Show the first 12' : `Show all ${sorted.length}`}</button></div>` : ''}
    </section>
    <p class="small muted">Generated businesses are synthetic: names, people, addresses and Desktop labels come from a fixed seed (${SEED}), so every visit sees the same data. The tax rates and districts are real.</p>`;
}

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
    <p class="lede">Does the label clustering work beyond the 53-label demo pool? Here it fits on Desktop-style labels, never sees a held-back part, and is graded on it.</p></div>`;
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
      <h2 id="lg-h">The BRD gates on this set</h2>
      <ul class="gate-chips">${gates.map(([g, v, ok]) => `<li class="${ok ? 'pass' : 'fail'}">${mark(ok ? 'pass' : 'fail')}<span><strong>${g}</strong>${esc(v)}</span></li>`).join('')}</ul>
      ${pill(passes ? 'Suggestions would be shown' : 'Shadow mode: logged, people decide', passes ? 'good' : 'warn')}
    </section>
    <div class="dash-grid even">
      <section class="card" aria-labelledby="sil-h">
        <div class="card-head"><div><h2 id="sil-h">Silhouette by number of clusters</h2><p class="card-sub">How well the labels separate into k groups. The best k is used.</p></div></div>
        <div class="viz-wrap">${silhouetteChart(r, floor)}</div>
      </section>
      <section class="card" aria-labelledby="map-h">
        <div class="card-head"><div><h2 id="map-h">Every label on a map</h2><p class="card-sub">Similar words sit close. Hover a point to read it.</p></div></div>
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
      <div class="card-head"><div><h2 id="cl-h">The ${r.k} clusters</h2><p class="card-sub">Named after the closest catalogue entry. Purity is the share of labels with the cluster's most common answer.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Named</th><th class="num">Labels</th><th class="num">Purity</th><th class="num">Silhouette</th><th>Most are</th><th>Examples</th></tr></thead><tbody>${clusterRows}</tbody></table></div>
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
    return `<tr><td><strong>${esc(labelOf(i.label))}</strong></td><td>${i.law_id}</td><td>${i.origin === 'custom' ? 'Custom' : 'System-defined'}</td><td>${esc(i.item_type)}, ${esc(i.tracking_type)}</td><td>${esc(rateText(i))}</td><td>${esc(i.agency)}</td><td class="num">${users}</td></tr>`;
  }).join('');
  const PEOPLE_SHOWN = 25;
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
      <div class="section-head"><h2 id="items-h">Desktop payroll items</h2><p>Law ID 177 or 0 is an employer-created item with a free-text name.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Item label</th><th>Law ID</th><th>Kind</th><th>Desktop setting</th><th>Rate</th><th>Agency on file</th><th class="num">Employees</th></tr></thead><tbody>${items}</tbody></table></div>
    </section>
    <section class="section" aria-labelledby="people-h">
      <div class="section-head"><h2 id="people-h">Employees and their expected taxes</h2><p>From the address lookup (Intuit's tax service in production).</p></div>
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Home address</th><th>Works at</th><th>Expected taxes</th></tr></thead><tbody>${people}</tbody></table></div>
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
  state_conflict: 'Wrong state', no_address: 'No address', address_unresolved: 'Address not placed', ambiguous: 'Ambiguous', employer_sent: 'Sent by employer',
};
const REASON_TONE = {
  conflict: 'bad', duplicate: 'bad', state_conflict: 'bad', not_expected: 'bad',
  no_address: 'warn', address_unresolved: 'warn', weak_signal: 'warn', ambiguous: 'warn', shadow: 'info', employer_sent: 'blue',
};
const FILTERS = {
  review: [['todo', 'Needs decision'], ['verified', 'Ready to confirm'], ['expert', 'With expert', 'warn'], ['done', 'Done'], ['all', 'All']],
  expert: [['open', 'Open', 'warn'], ['decided', 'Decided'], ['all', 'All']],
};
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
  return ['Expert decides', 'muted'];
}

function recordList(view, s) {
  const order = new Map(s.a.employees.map((e, i) => [e.employee_id, i]));
  const out = [];
  const cases = view === 'expert' ? s.cases.filter((c) => c.stage === 'with_expert' || c.decision.expert) : s.cases;
  for (const c of cases) {
    const e = c.employee;
    const [b, tone] = caseBadge(c);
    const groups = new Set(['all']);
    if (view === 'review') {
      if (c.stage === 'awaiting_employer') groups.add('todo');
      if (c.stage === 'awaiting_employer' && c.verified) groups.add('verified');
      if (c.stage === 'with_expert') groups.add('expert');
      if (!OPEN_STAGES.has(c.stage)) groups.add('done');
    } else groups.add(c.stage === 'with_expert' ? 'open' : 'decided');
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
  }
  return out.map((r, i) => ({ r, i })).sort((x, y) => order.get(x.r.employee_id) - order.get(y.r.employee_id) || x.i - y.i).map((x) => x.r);
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
    return `<li class="rec-group"><p class="rec-emp" id="${esc(gid)}">${avatar(g.name)}${esc(g.name)}</p><ul class="rec-items" aria-labelledby="${esc(gid)}">${g.rows.map((r) => `<li data-text="${esc(r.text)}"><button type="button" class="record" data-action="select" data-key="${esc(r.key)}"${sel?.key === r.key ? ' aria-current="true"' : ''}>
      <span class="rec-top"><span class="from"><span class="sr-only">${esc(r.name)}: </span>${esc(r.from)}</span>${badge(r.badge, r.tone)}</span>
      <span class="rec-map">${icon('arrow')}<span class="to ${r.toTone}">${esc(r.to)}</span></span>
    </button></li>`).join('')}</ul></li>`;
  }).join('');
  const emptyText = {
    todo: 'Nothing is waiting for the employer.', verified: 'No lines are ready to confirm.', expert: 'No lines are with an expert.',
    done: 'No decisions yet.', all: 'No records.', open: 'The expert queue is empty.', decided: 'No expert decisions yet.',
  }[filter];
  const title = view === 'review' ? 'To do' : 'Expert queue';
  const blurb = view === 'review' ? plural(all.length, 'record') : `${all.filter((r) => r.groups.has('open')).length} open`;
  const autoStats = automationStats(s.a, s.d);
  const foot = view === 'review'
    ? (s.d.autoRun || live
      ? `<div class="queue-foot"><p>${icon('spark')}${autoStats.auto} of ${autoStats.total} settled by rule.</p></div>`
      : `<div class="queue-foot"><a class="btn primary" href="#move">${icon('spark')}Start the move</a><p>Rules settle ${automationPreview(s).stats.auto} of ${autoStats.total}; only exceptions stay here.</p></div>`)
    : '<div class="queue-foot"><p>The employer confirms each decision before it goes live.</p></div>';
  let detail;
  const withExpert = s.expert - s.info;
  const reviewEmpty = [
    s.info ? `${plural(s.info, 'line waits', 'lines wait')} for an address under Missing information.` : '',
    withExpert ? `${plural(withExpert, 'line')} ${withExpert === 1 ? 'is' : 'are'} with an expert; ${withExpert === 1 ? 'it stays' : 'they stay'} off until an expert decides and you confirm.` : '',
  ].filter(Boolean).join(' ') || 'Every line has a decision.';
  if (!sel) detail = `${mobileBack(view)}<div class="empty"><strong>${esc(emptyText)}</strong><span>${view === 'review' ? esc(reviewEmpty) : 'Every line the system could not settle has an expert decision.'}</span>${canOpen('golive') ? '<a class="btn" href="#golive">Go to go-live checks</a>' : ''}</div>`;
  else if (sel.kind === 'gap') detail = gapDetail(sel.g, s);
  else detail = caseDetail(sel.c, s, view);
  return `<div class="workspace" data-open="${state.detailOpen && sel ? 'true' : 'false'}">
    <aside class="queue" aria-label="${title} list">
      <div class="queue-head">
        <div class="queue-title"><h1>${title}</h1><span>${esc(blurb)}</span></div>
        <label class="search">${icon('search')}<span class="sr-only">Search ${title.toLowerCase()}</span><input type="search" id="queue-search" placeholder="Search employee, item or tax" value="${esc(state.query[view] ?? '')}" autocomplete="off"></label>
        <div class="filter-chips" role="group" aria-label="Show">${chips}</div>
      </div>
      <ul class="records">${items}</ul>
      <p class="queue-empty" id="queue-empty" data-empty="${esc(emptyText)}"${items ? ' hidden' : ''}>${esc(emptyText)}</p>
      ${foot}
    </aside>
    <section class="detail" aria-label="Selected record">${detail}</section>
  </div>`;
}

const mobileBack = () => `<div class="mobile-back"><button class="btn quiet" type="button" data-action="back">${icon('back')}Back to the list</button></div>`;


// ---------- missing information (owner): what only the employer can give ----------
// A missing or unplaceable home address leaves the school-district lines with an expert. The owner adds it
// here: it is saved in the database, the engine checks that employee's lines again, and the rules finish them.

function missingInfo(s) {
  const people = new Map();
  for (const c of s.cases) {
    if (c.stage !== 'with_expert' || !NEEDS_ADDRESS.has(c.reason) || c.decision.sentToExpert) continue;
    const p = people.get(c.employee_id) ?? { e: c.employee, reason: c.reason, lines: 0 };
    p.lines += 1;
    people.set(c.employee_id, p);
  }
  const accounts = s.d.live ? [] : readiness(s.a, s.d).accounts.filter((a) => !a.complete);
  return { people: [...people.values()], accounts };
}

// The address on file that the lookup could not place, to correct rather than retype.
function unplacedAddress(e) {
  for (const p of e.addresses ?? []) {
    const ad = addressById(p.address_id);
    if (ad && ad.school_district === 'UNRESOLVED') return ad;
  }
  return null;
}

function missingCard(s) {
  const { people, accounts } = missingInfo(s);
  if (!people.length && !accounts.length) return '';
  const rows = people.map(({ e, reason, lines }) => {
    const cur = reason === 'address_unresolved' ? unplacedAddress(e) : null;
    const id = domId(e.employee_id);
    const st = cur?.state ?? addressById(siteOf(e, s.a).address_id)?.state ?? 'OH';
    const why = reason === 'no_address' ? 'No home address in Desktop' : `The lookup cannot place ${[cur?.line1, cur?.city, cur?.zip].filter(Boolean).join(', ') || 'the address on file'}`;
    return `<li class="mi-row" id="mi-${esc(id)}">
      <div class="mi-who">${avatar(e.name)}<div><strong>${esc(e.name)}</strong><span>${esc(why)}. ${plural(lines, 'line waits', 'lines wait')} for it.</span></div></div>
      <form class="mi-form" data-action="fix-address" data-employee="${esc(e.employee_id)}">
        <label class="mi-street"><span class="sr-only">Street for ${esc(e.name)}</span><input type="text" name="line1" id="mi-line1-${esc(id)}" placeholder="Street" value="${esc(cur?.line1 ?? '')}" autocomplete="off"${s.d.live ? ' disabled' : ''}></label>
        <label><span class="sr-only">City for ${esc(e.name)}</span><input type="text" name="city" placeholder="City" value="${esc(cur?.city ?? '')}" autocomplete="off"${s.d.live ? ' disabled' : ''}></label>
        <label class="mi-st"><span class="sr-only">State for ${esc(e.name)}</span><select name="state"${s.d.live ? ' disabled' : ''}>${['OH', 'PA'].map((x) => `<option${x === st ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="mi-zip"><span class="sr-only">ZIP code for ${esc(e.name)}</span><input type="text" name="zip" placeholder="ZIP" value="${esc(cur?.zip ?? '')}" inputmode="numeric" maxlength="5" autocomplete="off"${s.d.live ? ' disabled' : ''}></label>
        <button class="btn primary" type="submit"${s.d.live ? ' disabled' : ''}>Save</button>
        <button class="btn quiet" type="button" data-action="sample-address" data-employee="${esc(e.employee_id)}"${s.d.live ? ' disabled' : ''}>Fill a demo address</button>
      </form>
    </li>`;
  }).join('');
  const acct = accounts.map((a) => `<li class="mi-row"><div class="mi-who"><span class="avatar">${icon('landmark')}</span><div><strong>${esc(a.agency)}</strong><span>${esc([a.account ? '' : 'Account number', a.frequency ? '' : 'deposit frequency'].filter(Boolean).join(' and '))} missing. Needed to pay and file.</span></div></div><a class="btn" href="#golive">Add it</a></li>`).join('');
  return `<section class="panel missing" data-open="${state.detailOpen ? 'true' : 'false'}" aria-labelledby="mi-h">
    <div class="section-head"><h2 id="mi-h" tabindex="-1">Missing information <span class="count">${people.length + accounts.length}</span></h2><p>Only you can give these. Add one and the engine checks those lines again; your rules settle what they can.</p></div>
    <ul class="mi-list">${rows}${acct}</ul>
    ${people.length ? '<p class="small muted">The demo address lookup knows a fixed list of addresses, and "Fill a demo address" picks one near the work site. In production, Intuit\'s tax service places any US address.</p>' : ''}
  </section>`;
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

// Save an address the employer gave: in the database (then read that business back), or in memory without one.
function addCorrection(corr) {
  state.corrections = [...state.corrections.filter((x) => !(x.company_id === corr.company_id && x.employee_id === corr.employee_id)), corr];
  let found;
  if (db) {
    const r = applyCorrection(db, corr, lookupIdx);
    const [co] = readCompanies(db, corr.company_id);
    data.companies = data.companies.map((c) => (c.company_id === co.company_id ? co : c));
    if (!r.found) unplaced(r.addressId, corr);
    found = r.found;
  } else found = correctInMemory(corr);
  forgetCompany(corr.company_id);
  return found;
}
function correctInMemory(corr) {
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

function viewReview(s) { return missingCard(s) + workspace('review', s); }
function viewExpert(s) { return workspace('expert', s); }

// ---------- record detail ----------

function recordHeader({ name, id, meta, badgeHtml, flow, stage, next }) {
  return `<div class="rec-header">
    <div class="rec-title">
      <div class="rec-who">${avatar(name, 'lg')}<div><h2 id="detail-title" tabindex="-1">${esc(name)}</h2><p class="sub"><span class="idchip">${esc(id)}</span>${meta}</p></div></div>
      ${badgeHtml}
    </div>
    ${flow}
    <div class="next"><span class="next-ic">${icon('arrow')}</span><div><span class="next-label">Next step<span>${esc(stage)}</span></span><p>${esc(next)}</p></div></div>
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
  const from = flowSide('from', 'Desktop payroll', esc(labelOf(item.label)), esc(`Law ID ${item.law_id} · ${item.origin === 'custom' ? 'custom item' : 'system item'} · ${deskRate(item)}`));
  const label = targetLabel(c);
  let to;
  if (c.route === 'local_tax') {
    const title = c.proposal.map((p) => `${esc(p.tax.name)}${c.proposal.length > 1 ? ` <span class="flow-when">${esc(monthSpan(p.months))}</span>` : ''}`).join('<br>');
    const p = c.proposal[0];
    const meta = c.proposal.length > 1 ? 'Split by the move' : `${p.tax.type === 'school_district' ? `SD ${p.tax.code} · ` : ''}${rateFmt(p.tax.rate)} · ${basisText(p.basis)}`;
    to = flowSide('to', label, title, esc(meta), c.verified || c.stage === 'confirmed' ? 'good' : 'warn');
  } else if (c.route === 'not_a_tax') to = flowSide('to', label, 'Non-tax deduction', 'Moves to deductions; never filed as a tax', 'neutral');
  else if (c.route === 'custom_entry') to = flowSide('to', label, esc(c.entry.name), esc(`Custom entry · employer-managed · ${c.entry.flat ? `${money(c.entry.flat)} a year` : `${c.entry.rate}%`}`), 'blue');
  else if (c.route === 'stop') to = flowSide('to', label, 'Stop withholding', esc(c.ytd ? `${money(c.ytd)} to correct with the agency` : 'Nothing was withheld'), 'bad');
  else to = flowSide('to', label, 'Waiting for an expert', esc(REASON_SHORT[c.reason] ?? 'Needs an expert'), REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn');
  return flow(from, to);
}


function nextStep(c, view, live) {
  if (live) return OPEN_STAGES.has(c.stage) ? 'This company is live, so decisions are locked. Undo go-live to change them.' : `Done: ${STAGE_LABEL[c.stage].toLowerCase()}. This company is live.`;
  if (view === 'expert') {
    if (c.stage === 'with_expert') return EXPERT_HINT[c.reason] ?? 'Decide how this line should migrate.';
    return `Decided: ${expertText(c)}. The employer ${c.stage === 'awaiting_employer' ? 'confirms it next' : 'has confirmed it'}.`;
  }
  if (c.stage === 'with_expert' && NEEDS_ADDRESS.has(c.reason) && !c.decision.sentToExpert) return 'Add the home address under Missing information. The engine then checks this line again.';
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
  if (e?.auto) return `Done automatically (rule: ${ruleLabel(e.rule).toLowerCase()}). Undo it from the action bar if needed.`;
  return `Done: ${STAGE_LABEL[c.stage].toLowerCase()}. Undo it from the action bar if needed.`;
}

function checksBanner(c) {
  const meta = `<span class="meta">${esc(stateName(c.state))} · ${c.model ? (c.model.shown ? 'model suggestion shown' : 'model suggestion hidden') : 'Intuit-defined item'}</span>`;
  if (c.decision.expert) return `<div class="banner info">${icon('user', 'lg')}<div><strong>Expert decision:</strong> ${esc(expertText(c))}. The system's original findings are under "How the system decided".</div>${meta}</div>`;
  const issues = c.evidence.filter((x) => x.tone === 'fail' || x.tone === 'warn').map((x) => x.text);
  if (c.decision.sentToExpert) issues.push('The employer sent this line to an expert.');
  if (!issues.length) return '';
  const tone = c.stage === 'with_expert' && REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn';
  return `<div class="banner ${tone}">${icon('alert', 'lg')}<div><strong>${plural(issues.length, 'thing', 'things')} to check</strong><ul>${issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>${meta}</div>`;
}

function mappingTable(rows) {
  return `<section class="card" aria-label="Desktop versus Online mapping">
    <div class="card-head"><span class="card-title">${icon('swap')}Desktop versus Online</span></div>
    <div class="table-wrap"><table class="map-table"><thead><tr><th>Field</th><th>Desktop (source)</th><th>Online (target)</th><th>Check</th></tr></thead><tbody>
      ${rows.map(([k, a, b, n, cls]) => `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(k)}</td><td data-l="Desktop">${a}</td><td data-l="Online">${b}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>
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
    rows.push(['Jurisdiction', custom ? none('Not recorded in Desktop') : src(s.a.idx.taxes.get(item.system_tax_id)?.name ?? item.system_tax_id), target((p) => `${p.tax.place} · ${basisText(p.basis)}`), note('good', 'pin', 'From the address lookup')]);
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
    rows.push(['Tax item', srcItem, tgt('Stop withholding', 'bad'), note('blue', 'user', 'Decided by an expert')]);
    rows.push(['Rate', src(rateText(item)), tgt('0.00%', 'bad'), note('', 'info', 'Nothing withheld from Online paychecks')]);
    rows.push(ytdRow([tgt(money(c.ytd), 'bad'), note('bad', 'alert', c.ytd ? 'Not owed: correction needed with the agency' : 'Nothing withheld')]));
    return mappingTable(rows);
  }
  const other = c.duplicateOf ? s.cases.find((x) => x.case_id === c.duplicateOf) : null;
  rows.push(['Tax item', srcItem, none('No target yet'), note(REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn', 'alert', REASON_SHORT[c.reason] ?? 'Needs an expert')]);
  if (other) rows.push(['Already withheld by', none('This line'), tgt(`"${labelOf(other.item.label)}"`, 'warn'), note('bad', 'alert', 'Keeping both would withhold twice')]);
  rows.push(['Desktop setting', src(`${item.item_type}, ${item.tracking_type}`), none('An expert decides'), note('', 'info', `Law ID ${item.law_id}${custom ? ', custom item' : ''}`)]);
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

function evidenceCard(s, { employee: e, state: st, match = new Set(), steps = [], model = null, historyTarget = '', openSteps = false }) {
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
  const modelBody = model ? `<div class="model-grid">
      <div><span>Closest defined entry</span><b>${esc(model.entry_label ?? 'None')}</b></div>
      <div><span>Label silhouette</span><b>${model.item_silhouette.toFixed(2)}</b></div>
      <div><span>Confidence</span><b>${esc(model.confidence)}</b></div>
      <div><span>Shown to the employer</span><b>${model.shown ? 'Yes' : 'No (shadow or weak)'}</b></div>
    </div><p class="small muted">${esc(MODEL_VERSION)}. The model suggests a type; the address picks the exact tax; a person decides.</p>` : '';
  return `<section class="card" aria-label="Supporting evidence">
    <div class="card-head"><span class="card-title">${icon('file')}Supporting evidence</span><span class="meta">Address lookup · ${esc(stateName(st))}</span></div>
    <div class="card-body"><div class="evidence-grid">
      <div class="ev-box"><span class="label">Where the employee lives and works</span>${homes}${workRow}</div>
      <div class="ev-box"><span class="label">Expected taxes, from the addresses</span>${exp ? `<ul class="exp-list">${exp}</ul>` : '<span class="none">None listed</span>'}${notes ? `<div class="exp-notes">${notes}</div>` : ''}</div>
    </div></div>
    ${fold('steps', 'How the system decided', `<ul class="marks steps-list">${steps.map((x) => `<li>${mark(x.tone)}<span>${x.step ? `<span class="step-n">STEP ${x.step}</span>` : ''}${esc(x.text)}</span></li>`).join('')}</ul>`, openSteps)}
    ${model ? fold('spark', 'Model suggestion', modelBody) : ''}
    ${fold('history', `Decision history (${hist.length})`, hist.length ? `<ul class="history">${hist.map((a) => `<li><time datetime="${esc(a.at)}">${esc(new Date(a.at).toLocaleString())}</time><span><strong>${esc(a.actor)}</strong>: ${esc(a.action)}${a.detail ? `. ${esc(a.detail)}` : ''}</span></li>`).join('')}</ul>` : '<span class="none">No decisions yet.</span>')}
  </section>`;
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
  if (c.decision.expert) steps.push({ tone: 'info', text: `Expert decision: ${expertText(c)}.` });
  const open = !c.verified && OPEN_STAGES.has(c.stage);
  return `${mobileBack(view)}
    ${recordHeader({ name: c.employee_name, id: e.employee_id, meta, badgeHtml: badge(b, tone), flow: caseFlow(c), stage: STAGE_LABEL[c.stage], next: nextStep(c, view, live) })}
    ${checksBanner(c)}
    ${view === 'expert' && c.stage === 'with_expert' && !live ? expertTools(c, s) : ''}
    ${caseMapping(c, s)}
    ${evidenceCard(s, { employee: e, state: c.state, match: new Set(c.proposal.map((p) => p.tax_id)), steps, model: c.model, historyTarget: `${c.employee_name}: ${c.item.label}`, openSteps: open })}
    ${caseActions(c, s, view)}`;
}

const logNote = `<span class="log-note">${icon('lock')}Decisions are logged with the time and role for the audit trail.</span>`;
const moreMenu = (items) => (items.length ? `<details class="more"><summary class="btn" aria-label="More actions"><span class="more-text">More actions</span>${icon('chevron', 'more-chev')}${icon('dots', 'more-dots')}</summary><div class="more-menu">${items.join('')}</div></details>` : '');

function caseActions(c, s, view) {
  const id = esc(c.case_id);
  const key = esc(`c|${c.case_id}`);
  // Buttons that open the other person's screen only appear for a role that can open it.
  const toReview = canOpen('review') ? `<button class="btn" type="button" data-action="goto" data-view="review" data-key="${key}">Open in the employer's list</button>` : '';
  const toExpert = canOpen('expert') ? `<button class="btn primary" type="button" data-action="goto" data-view="expert" data-key="${key}">Open in the expert queue</button>` : '<span class="small muted">With an expert. You confirm once they decide.</span>';
  if (s.d.live) return `<div class="action-bar">${logNote}${canOpen('golive') ? '<a class="btn" href="#golive">Live: see go-live</a>' : '<span class="small muted">Live: decisions are locked.</span>'}</div>`;
  if (view === 'expert') {
    if (c.stage === 'with_expert') return `<div class="action-bar">${logNote}${toReview}</div>`;
    return `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="expert-undo" data-id="${id}">Reopen</button>${toReview}</div>`;
  }
  if (c.stage === 'with_expert') {
    const items = c.decision.sentToExpert && !c.decision.expert ? [`<button class="btn" type="button" data-action="unsend-expert" data-id="${id}">Take it back from the expert</button>`] : [];
    const addAddress = NEEDS_ADDRESS.has(c.reason) && !c.decision.sentToExpert ? `<button class="btn primary" type="button" data-action="focus-missing" data-employee="${esc(c.employee_id)}">Add the address</button>` : '';
    return `<div class="action-bar">${logNote}${moreMenu(items)}${addAddress || toExpert}</div>`;
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
      : stage === 'added' ? 'Done. Undo it from the action bar if needed.' : 'Nothing to do: the expert mapping covers it.';
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
    ${recordHeader({ name: g.employee_name, id: e.employee_id, meta: `${esc(site.name)} · ${money(e.monthly_wages)} a month`, badgeHtml: badge(b, tone), flow: gapFlow, stage: stage === 'awaiting_employer' ? 'Waiting for the employer' : stage === 'added' ? 'Added' : 'Covered', next })}
    ${banner}
    ${mappingTable(rows)}
    ${evidenceCard(s, { employee: e, state: g.tax.state, match: new Set([g.tax_id]), steps, historyTarget: `${g.employee_name}: ${g.tax.name}`, openSteps: stage === 'awaiting_employer' })}
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
  ambiguous: 'More than one expected tax fits. Pick the right one from the list.',
  employer_sent: 'The employer disagreed with the suggestion. Check the address and the Desktop item, then decide.',
};

const TYPE_NAME = { school_district: 'School-district tax', municipal: 'City tax', earned_income: 'Earned income tax', local_services: 'Local services tax' };
// Open lines with the same Desktop item that an expert can decide together (not the ones waiting for an
// address, and not one the employer sent back on purpose).
function sameLabelOpen(c, s) {
  return s.cases.filter((x) => x.item.item_id === c.item.item_id && x.stage === 'with_expert' && !x.decision.expert && !x.decision.sentToExpert && !NEEDS_ADDRESS.has(x.reason));
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
  const recommended = { not_expected: 'stop', duplicate: 'stop', state_conflict: 'stop', weak_signal: 'map', no_address: 'map', address_unresolved: 'map', ambiguous: 'map', employer_sent: 'map' }[c.reason] ?? null;
  const sel = (name, values, current) => `<select id="${name}-${id}" name="${name}">${values.map(([v, t]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  // The same Desktop item is usually on many employees. The expert decides what the label means once,
  // and each employee's own address picks the exact tax: the BRD's "label says which kind, address says which one".
  const same = sameLabelOpen(c, s);
  const types = [...new Set(stateTaxes.filter((t) => t.state === c.state).map((t) => t.type))];
  const sameBlock = same.length > 1 ? `<div class="same-label">
        <p><strong>"${esc(labelOf(c.item.label))}" is open on ${plural(same.length, 'line')}</strong>, one per employee. Decide what the label means once; each employee's address picks the exact tax.</p>
        <div class="row">${types.map((t) => `<button class="btn${suggestType === t ? ' primary' : ''}" type="button" data-action="expert-label" data-item="${esc(c.item.item_id)}" data-as="${t}"${suggestType === t ? ' title="The model\'s closest entry"' : ''}>${esc(TYPE_NAME[t] ?? t)} for all ${same.length}</button>`).join('')}<button class="btn" type="button" data-action="expert-label" data-item="${esc(c.item.item_id)}" data-as="not_a_tax">Not a tax for all ${same.length}</button></div>
      </div>` : '';
  return `<section class="card" aria-label="Expert decision">
    <div class="card-head"><span class="card-title">${icon('user')}Expert decision</span><span class="meta">Goes back to the employer to confirm</span></div>
    <div class="card-body tools">
      ${sameBlock}
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
          <p class="small muted">A custom entry is marked employer-managed: QuickBooks will not pay or file it. It also goes to Intuit's catalogue review so the next company can match it.</p>
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
  const tieRows = tie.rows.map((row) => `<tr><td><span class="swatch seg-${row.stage}"></span>${esc(row.label)}</td><td class="num">${row.count}</td><td class="num">${money(row.amount)}</td></tr>`).join('');
  const accounts = r.accounts.map((a, i) => `<tr>
      <td><strong>${esc(a.agency)}</strong><div class="small muted">${a.taxes.map(esc).join(', ')}</div></td>
      <td><label class="sr-only" for="acct-${i}">Account number for ${esc(a.agency)}</label><input type="text" id="acct-${i}" value="${esc(a.account)}" placeholder="Required" data-action="account" data-agency="${esc(a.agency)}" data-field="account"${live ? ' disabled' : ''}></td>
      <td><label class="sr-only" for="freq-${i}">Deposit frequency for ${esc(a.agency)}</label><select id="freq-${i}" data-action="account" data-agency="${esc(a.agency)}" data-field="frequency"${live ? ' disabled' : ''}>${['', 'Monthly', 'Quarterly', 'Semi-monthly', 'Annually'].map((f) => `<option value="${f}"${f === a.frequency ? ' selected' : ''}>${f || 'Choose'}</option>`).join('')}</select></td>
      <td class="small muted">${a.source ? `From ${esc(a.source)}` : 'Enter from the agency letter'}</td>
    </tr>`).join('');
  return `<div class="page-head"><h1>Go live</h1>
    <p class="lede">Confirmed taxes switch on with the first Online payroll. Desktop history is relabelled for the W-2; amounts never change.</p></div>
    ${live ? `<div class="live-banner"><span>Live since ${new Date(s.d.liveAt).toLocaleString()}: ${plural(liveCount, 'employee tax', 'employee taxes')} switched on.</span><div class="row"><button class="btn quiet" type="button" data-action="undo-live">Undo go-live (demo)</button></div></div>` : ''}
    <div class="two-col">
      <section class="panel section" aria-labelledby="checks-h">
        <h2 id="checks-h">Checks before the first cloud payroll</h2>
        <ul class="checks">${r.checks.map((c) => `<li>${mark(c.pass ? 'pass' : 'fail')}<div><strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span></div></li>`).join('')}</ul>
        ${r.expert.length ? `<p class="small muted">${plural(r.expert.length, 'line')} still with an expert will stay off: ${r.expert.map((c) => `${esc(c.employee_name)} "${esc(labelOf(c.item.label))}"`).join(', ')}.</p>` : ''}
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
      <div class="section-head"><h2 id="acct-h">Agency accounts</h2><p>Needed to pay and file. Filled from Desktop where it had them.</p></div>
      ${r.accounts.length ? `<div class="table-wrap"><table><thead><tr><th>Agency</th><th>Account number</th><th>Deposit frequency</th><th>Source</th></tr></thead><tbody>${accounts}</tbody></table></div>` : '<div class="empty"><span>No taxes are confirmed yet, so no agency accounts are needed.</span></div>'}
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
  const W2_SHOWN = 12;
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
  const head = `<div class="section-head"><h2 id="rec-h">Reconcile</h2><p>After the first Online payroll and the first quarter, withholding is checked against the addresses.</p></div>`;
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
    <div class="table-wrap"><table><thead><tr><th>Tax</th><th>Employees</th><th class="num">First payroll (${first})</th><th class="num">${period === 'first quarter' ? 'First quarter' : 'Online months'} (${monthSpan(cm)})</th><th>Who pays and files</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${r.flags.length ? `<ul class="marks panel">${r.flags.map((f) => `<li>${mark(f.tone)}<span>${esc(f.text)}</span></li>`).join('')}</ul>` : ''}
    <p class="small muted">${s.a.company.plan === 'Core' ? 'Core plan: the employer pays and files local taxes.' : 'QuickBooks pays and files the taxes it supports on this plan.'}</p>
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
      <span class="small muted">${f.help} BRD value: ${f.show(DEFAULT_THRESHOLDS[f.key])}.</span></label>`).join('');
  return `<section class="panel section" aria-labelledby="th-h">
    <div class="section-head"><h2 id="th-h">Gate thresholds</h2><p>Change one to see a state switch to shadow mode. A value equal to the threshold passes.${locked ? ' Locked: this client is live.' : ''}</p></div>
    <div class="threshold-grid">${fields}</div>
    ${changed ? `<div class="row"><span class="pill warn"><span class="dot"></span>Thresholds differ from the BRD</span><button class="btn quiet" type="button" data-action="reset-thresholds"${locked ? ' disabled' : ''}>Back to BRD values</button></div>` : ''}
  </section>`;
}

function viewModel(s) {
  const used = statesInUse(s.a);
  const panels = Object.values(s.a.models).filter((m) => used.has(m.state)).map((m) => {
    const t = m.thresholds;
    const gate = (name, rule, measured, pass) => `<tr><td><strong>${name}</strong></td><td>${rule}</td><td>${measured}</td><td>${pill(pass ? 'Pass' : 'Fail', pass ? 'good' : 'bad')}</td></tr>`;
    const chip = (x, extra = '') => `<span class="label-chip${extra}${x.silhouette < t.itemFloor ? ' weak' : ''}">${esc(x.label)}<b>${x.silhouette.toFixed(2)}</b></span>`;
    const clusters = [...m.clusters].sort((a, b) => b.size - a.size).map((c) => `<div class="cluster${c.kind ? '' : ' unnamed'}">
        <div class="cluster-head"><strong>${esc(c.name)}</strong><span class="small muted">${plural(c.size, 'label')}</span></div>
        <div class="meter${c.meanSilhouette < t.silhouetteFloor ? ' low' : ''}" role="img" aria-label="Mean silhouette ${c.meanSilhouette.toFixed(2)}"><span style="width:${Math.max(0, c.meanSilhouette) * 100}%"></span></div>
        <span class="small muted">Mean silhouette ${c.meanSilhouette.toFixed(2)}${c.kind ? `, ${c.kind === 'tax' ? 'tax' : 'non-tax'} entry` : ', no entry close enough'}</span>
        <div class="label-chips">${c.members.map((x) => chip(x, x.fromCompany ? ' mine' : '')).join('')}${c.assigned.map((x) => chip(x, ' mine assigned')).join('')}</div>
      </div>`).join('');
    const unassigned = m.unassigned.length ? `<p class="small warn-text">Not assigned to any cluster, because no words are left to compare after removing place names: ${m.unassigned.map((l) => `"${esc(l)}"`).join(', ')}. These go to an expert.</p>` : '';
    return `<section class="panel state-panel" aria-labelledby="st-${m.state}">
      <div class="section-head"><h2 id="st-${m.state}">${esc(m.name)}</h2>
        <div class="row">${pill(m.mode === 'assisted' ? 'Suggestions shown' : 'Shadow mode', m.mode === 'assisted' ? 'good' : 'warn')}
          <label class="switch"><input type="checkbox" data-action="force-shadow" data-state="${m.state}"${m.forced ? ' checked' : ''}${s.d.live ? ' disabled' : ''}> Force shadow mode</label></div></div>
      <div class="table-wrap"><table class="gate-table"><thead><tr><th>Gate</th><th>Rule</th><th>Measured</th><th>Result</th></tr></thead><tbody>
        ${gate('Rollout', 'State enabled for migration', data.catalog.states[m.state].rollout === 'enabled' ? 'Enabled' : 'Not yet enabled', m.gates.rollout)}
        ${gate('Silhouette', `Clusters well formed: at least ${t.silhouetteFloor.toFixed(2)}`, `${m.silhouette.toFixed(3)} with ${m.k} clusters`, m.gates.silhouette)}
        ${gate('Precision', `At least ${pct(t.precisionTarget, 0)} of high-confidence suggestions match the expert`, m.highConfidence ? `${pct(m.precision)} (${m.correct} of ${m.highConfidence})` : 'No high-confidence suggestions', m.gates.precision)}
        ${gate('Sample', `At least ${t.minSample} expert-labelled labels (demo scale)`, `${m.poolSize}`, m.gates.sample)}
      </tbody></table></div>
      <p class="small muted">Fitted once per state on expert-labelled labels. ${pct(m.coverage, 0)} of them get a high-confidence suggestion. Green labels are this client's; dotted ones are weak and go to an expert.${m.forced ? ' Shadow mode is forced on.' : ''}</p>
      ${unassigned}
      <div class="cluster-list">${clusters}</div>
    </section>`;
  }).join('');
  return `<div class="page-head"><h1>Model</h1>
    <p class="lede">Suggestions show only in a state that passes every gate; otherwise the model runs in shadow mode and people decide. ${esc(MODEL_VERSION)}.</p></div>
    ${thresholdPanel(s)}
    ${panels}`;
}

// ---------- scenario coverage ----------

function viewScenarios() {
  const results = scenarios();
  const passed = results.filter((r) => r.pass).length;
  const name = (id) => data.companies.find((c) => c.company_id === id)?.name ?? id;
  const person = (w) => {
    if (!w.employee) return '';
    const co = data.companies.find((c) => c.company_id === w.company);
    return co?.employees.find((e) => e.employee_id === w.employee)?.name ?? '';
  };
  const VIEW_NAME = { review: 'To do', expert: 'Expert queue', golive: 'Go live', reconcile: 'Go live', model: 'Model', analysis: 'Engine', audit: 'Log' };
  const groups = GROUPS.map((g) => {
    const rows = results.filter((r) => r.group === g.id).map((r) => `<tr>
        <td>${mark(r.pass ? 'pass' : 'fail')}<span class="sr-only">${r.pass ? 'Passes' : 'Fails'}</span></td>
        <td><strong>${esc(r.title)}</strong><div class="small muted">${esc(r.expect)}</div></td>
        <td class="small">${esc(r.detail)}</td>
        <td><button class="btn quiet" type="button" data-action="open-scenario" data-company="${esc(r.where.company)}" data-view="${esc(r.where.view)}" data-employee="${esc(r.where.employee ?? '')}">${esc([person(r.where) || name(r.where.company), VIEW_NAME[r.where.view]].filter(Boolean).join(', '))}</button></td>
      </tr>`).join('');
    return `<section class="section" aria-labelledby="sg-${g.id}">
      <div class="section-head"><h2 id="sg-${g.id}">${esc(g.title)}</h2></div>
      <div class="table-wrap"><table class="scenario-table"><thead><tr><th><span class="sr-only">Result</span></th><th>Scenario</th><th>What the check found</th><th>See it</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }).join('');
  return `<div class="page-head"><h1>Scenarios</h1>
    <p class="lede">Every case the BRD has to handle, with a live check. The same checks run in the automated tests.</p></div>
    <div class="score ${passed === results.length ? 'all' : ''}"><span class="n">${passed} of ${results.length}</span><span>scenarios pass</span></div>
    ${groups}`;
}

// ---------- decision log ----------

function viewAudit(s) {
  const entries = state.audit.filter((a) => a.company_id === state.companyId);
  const rows = entries.map((a) => `<tr><td class="small">${esc(new Date(a.at).toLocaleString())}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td class="small muted">${esc(a.detail)}</td></tr>`).join('');
  return `<div class="page-head"><h1>Decision log</h1>
    <p class="lede">Every decision for this client: who, when, and the rule or reason.</p></div>
    <div class="row">${HOSTED
      ? `<button class="btn primary" type="button" data-action="copy-json">Copy report (JSON)</button>
      <button class="btn" type="button" data-action="copy-csv">Copy lines (CSV)</button>
      <span class="small muted">Downloads work when you run the app locally.</span>`
      : `<button class="btn primary" type="button" data-action="export-json">Download report (JSON)</button>
      <button class="btn" type="button" data-action="export-csv">Download lines (CSV)</button>
      <button class="btn quiet" type="button" data-action="copy-json">Copy report</button>`}
    </div>
    <label class="sr-only" for="copy-box">Report JSON</label><textarea class="copy-box" id="copy-box" readonly hidden></textarea>
    ${entries.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Line</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><strong>No decisions yet for this client.</strong></div>'}`;
}

// ---------- data (admin): the database, a query box and uploads ----------

const EXAMPLES = [
  ['Lines by route', 'SELECT route, COUNT(*) AS lines\nFROM line_outcomes\nGROUP BY route\nORDER BY lines DESC'],
  ['Who decided', 'SELECT COALESCE(decided_by, \'Nobody yet\') AS decided_by, COUNT(*) AS lines\nFROM line_outcomes\nGROUP BY 1\nORDER BY lines DESC'],
  ['Biggest businesses', 'SELECT c.name, c.source, COUNT(e.employee_id) AS employees\nFROM companies c LEFT JOIN employees e ON e.company_id = c.company_id\nGROUP BY c.company_id\nORDER BY employees DESC\nLIMIT 15'],
  ['Open lines by reason', 'SELECT reason, COUNT(*) AS lines\nFROM line_outcomes\nWHERE stage = \'with_expert\'\nGROUP BY reason\nORDER BY lines DESC'],
  ['Added addresses', 'SELECT c.name, k.employee_id, k.value, k.found_in_lookup, k.at\nFROM corrections k JOIN companies c ON c.company_id = k.company_id\nORDER BY k.at DESC'],
  ['Ohio school taxes', 'SELECT code, name, rate, base\nFROM taxes\nWHERE type = \'school_district\'\nORDER BY code'],
  ['Custom Desktop labels', 'SELECT c.name AS client, d.label, d.calc_rate AS rate\nFROM desktop_items d JOIN companies c ON c.company_id = d.company_id\nWHERE d.origin = \'custom\'\nORDER BY c.sort, d.sort'],
];

function viewData() {
  const head = `<div class="page-head"><h1>Data</h1>
    <p class="lede">A SQLite database inside this page, rebuilt on every visit from the demo files and the generated businesses. Uploads and added addresses stay in this browser.</p></div>`;
  // The outcome tables need every business analysed first.
  if (db && unchecked().length) { warmUp(); return head + warmPanel(); }
  syncOutcomes();
  if (db && !query.result && !query.error) runSql(query.sql);
  const groups = db ? tableSummary(db) : [];
  const cards = groups.map((g) => `<section class="card" aria-labelledby="tg-${g.id}">
      <div class="card-head"><div><h2 id="tg-${g.id}">${esc(g.title)}</h2><p class="card-sub">${esc(g.note)}</p></div></div>
      <ul class="table-list">${g.tables.map((t) => `<li><button type="button" class="tbl" data-action="example-query" data-sql="${esc(`SELECT * FROM ${t.name} LIMIT 50`)}" title="${esc(t.columns.join(', '))}"><span class="tbl-name">${esc(t.name)}</span><span class="tbl-n">${t.rows}</span></button></li>`).join('')}</ul>
    </section>`).join('');
  const r = query.result;
  const results = query.error
    ? `<p class="query-error" role="alert">${icon('alert')}${esc(query.error)}</p>`
    : r ? (r.columns.length
      ? `<p class="small muted">${plural(r.total, 'row')}${r.total > r.rows.length ? `, first ${r.rows.length} shown` : ''}</p><div class="table-wrap result"><table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${v === null ? '<span class="none">null</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="small muted">No rows.</p>') : '';
  const msg = uploadMsg ? `<div class="banner ${uploadMsg.tone}" id="upload-msg" tabindex="-1">${icon(uploadMsg.tone === 'good' ? 'check' : 'alert', 'lg')}<div><strong>${esc(uploadMsg.title)}</strong><ul>${uploadMsg.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${uploadMsg.id && data.companies.some((c) => c.company_id === uploadMsg.id) ? `<div class="row"><button class="btn" type="button" data-action="open-client" data-id="${esc(uploadMsg.id)}">Open its move</button><button class="btn quiet" type="button" data-action="company-switch" data-id="${esc(uploadMsg.id)}" data-view="analysis">See how the engine read it</button></div>` : ''}</div></div>` : '';
  const list = uploads.length ? `<ul class="upload-list">${uploads.map((u) => `<li>${icon('file')}<span><strong>${esc(u.company.name)}</strong><span class="small muted">${esc(u.file ?? 'Uploaded file')}, ${plural(u.company.employees.length, 'employee')}</span></span><button class="btn quiet" type="button" data-action="remove-upload" data-id="${esc(u.company.company_id)}">Remove</button></li>`).join('')}</ul>` : '';
  return `${head}
    ${db ? '' : `<div class="banner warn">${icon('alert', 'lg')}<div><strong>The database could not start here.</strong> ${esc(dbError ?? '')} The app is reading the demo files directly; open the GitHub Pages site to use the database.</div></div>`}
    ${db ? `<div class="data-grid">${cards}</div>` : ''}
    <section class="card" aria-labelledby="q-h">
      <div class="card-head"><div><h2 id="q-h">Ask the data</h2><p class="card-sub">One SELECT at a time. Click a table above to look inside it.</p></div></div>
      <div class="card-body">
        <div class="chips">${EXAMPLES.map(([t, sql]) => `<button type="button" class="chip-btn" data-action="example-query" data-sql="${esc(sql)}">${esc(t)}</button>`).join('')}</div>
        <form class="query-form" data-action="run-query"><label class="sr-only" for="sql">SQL query</label><textarea id="sql" name="sql" rows="5" spellcheck="false"${db ? '' : ' disabled'}>${esc(query.sql)}</textarea><button class="btn primary" id="run-query-btn" type="submit"${db ? '' : ' disabled'}>Run query</button></form>
        ${results}
      </div>
    </section>
    <section class="card" aria-labelledby="up-h">
      <div class="card-head"><div><h2 id="up-h">Add a Desktop file</h2><p class="card-sub">A CSV with one row per employee per payroll item. It runs through the same checks and engine as the demo clients.</p></div></div>
      <div class="card-body">
        <div class="row"><label class="btn primary file-btn">${icon('file')}Choose a CSV file<input type="file" accept=".csv,text/csv" data-action="upload" class="sr-only"></label><button class="btn" type="button" data-action="template">${HOSTED ? 'Copy the template' : 'Download the template'}</button></div>
        <label class="sr-only" for="template-box">Template CSV</label><textarea class="copy-box" id="template-box" readonly hidden></textarea>
        ${msg}
        ${list}
        ${fold('list', 'Columns in the file', `<table class="col-table"><tbody>${CSV_COLUMNS.map(([c, req, help]) => `<tr><td><code class="code">${esc(c)}</code></td><td>${req ? 'Required' : 'Optional'}</td><td class="small muted">${esc(help)}</td></tr>`).join('')}</tbody></table><p class="small muted">Addresses are matched to the demo address lookup. A home address it has never seen goes to an expert; a work address it has never seen stops the file.</p>`)}
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
    toast(`Saving ${name}. If nothing downloads here, use Copy report.`);
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
      if (state.role === 'owner') state.companyId = document.getElementById('signin-company')?.value ?? state.companyId;
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
      const gone = uploads.find((u) => u.company.company_id === id);
      uploads = uploads.filter((u) => u.company.company_id !== id);
      delete state.decisions[id];
      state.corrections = state.corrections.filter((c) => c.company_id !== id);
      saveUploads();
      rebuildData();
      if (!data.companies.some((c) => c.company_id === state.companyId)) state.companyId = data.companies[0].company_id;
      if (uploadMsg?.id === id) uploadMsg = null;
      toast(`Removed ${gone?.company.name ?? 'the upload'}`);
      break;
    }
    case 'run-query':
      runSql(new FormData(el).get('sql'));
      break;
    case 'example-query':
      runSql(el.dataset.sql);
      break;
    case 'company-switch':
      state.companyId = el.dataset.id;
      toast(`Opened ${companyById().name}`);
      if (el.dataset.view && location.hash !== `#${el.dataset.view}`) { save(); location.hash = `#${el.dataset.view}`; return; }
      break;
    case 'company':
      state.companyId = el.value;
      state.detailOpen = false;
      toast(`Opened ${companyById().name}`);
      break;
    case 'reset': {
      // Two steps: the first click arms the button for a few seconds; nothing is cleared yet.
      if (!resetArmed) {
        resetArmed = true;
        el.classList.add('armed');
        el.querySelector('span').textContent = 'Click again to reset';
        toast('This clears every decision for every client. Click Reset again to confirm.');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetArmed = false;
          const b = document.querySelector('[data-action="reset"]');
          if (b) { b.classList.remove('armed'); b.querySelector('span').textContent = 'Reset'; }
        }, 5000);
        return;
      }
      resetArmed = false;
      clearTimeout(resetTimer);
      if (moving) clearTimeout(moving.timer);
      moving = null;
      state = { ...freshState(), role: state.role, companyId: state.companyId };
      uploads = [];
      uploadMsg = null;
      saveUploads();
      rebuildData();
      if (!data.companies.some((c) => c.company_id === state.companyId)) state.companyId = data.companies[0].company_id;
      toast('Demo reset to its starting data');
      break;
    }
    case 'open-client':
      state.companyId = id;
      save();
      if (location.hash === '#move') render();
      else location.hash = '#move';
      return;
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
      afterRender = () => (document.querySelector('.mi-form input[name="line1"]') ?? document.getElementById('mi-h') ?? document.getElementById('main'))?.focus({ preventScroll: true });
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
    case 'focus-missing': {
      const target = `mi-line1-${domId(el.dataset.employee)}`;
      const go = () => { const input = document.getElementById(target); if (!input) return; input.closest('.mi-row')?.scrollIntoView({ block: 'center' }); input.focus({ preventScroll: true }); };
      state.detailOpen = false;
      save();
      if (location.hash === '#review') { afterRender = go; break; }
      navFocus = go;
      location.hash = '#review';
      return;
    }
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
    case 'queue-filter':
      state.filters[el.dataset.view] = el.dataset.value;
      state.selIndex[el.dataset.view] = 0;
      break;
    case 'goto': {
      const view = el.dataset.view;
      state.sel[view] = el.dataset.key;
      state.filters[view] = 'all';
      state.detailOpen = true;
      keepDetail = true;
      save();
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
      log('Intuit governance', 'Restored the BRD thresholds', 'All states');
      toast('Thresholds are back to the BRD values');
      break;
    case 'open-scenario': {
      state.companyId = el.dataset.company;
      const view = el.dataset.view === 'reconcile' ? 'golive' : el.dataset.view; // Reconcile now sits on the Go live page
      if (view === 'review' || view === 'expert') {
        state.filters[view] = 'all';
        state.detailOpen = Boolean(el.dataset.employee);
        if (el.dataset.employee) { focusEmployee = el.dataset.employee; keepDetail = true; }
      } else if (el.dataset.employee) pendingFocus = el.dataset.employee;
      save();
      const target = `#${view}`;
      if (location.hash === target) render();
      else location.hash = target;
      return;
    }
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
const AUTO_FOLLOW = new Set(['decide', 'unsend-expert', 'add-gap', 'expert-map', 'expert-nontax', 'expert-label', 'expert-stop', 'expert-custom', 'account', 'auto-rule']);
let navFocus = null; // where focus goes after a link to another screen has rendered it

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
  for (const d of document.querySelectorAll('details.more[open]')) if (!d.contains(ev.target)) d.open = false;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const d of document.querySelectorAll('details.more[open]')) { d.open = false; d.querySelector('summary')?.focus(); }
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
// Rebuild the database from the demo files plus uploads, and read the engine's input back from it.
// Addresses the employer added are applied again on every rebuild, so they survive a reload.
function rebuildData() {
  cache.clear();
  previews.clear();
  outcomesKey = null;
  if (warming) { clearTimeout(warming.timer); warming = null; }
  scenarioResults = null;
  lookupIdx = lookupIndex(lookupAddresses());
  const known = new Set([...files.companies, ...(generated?.companies ?? []), ...uploads.map((u) => u.company)].map((c) => c.company_id));
  const corrections = state.corrections.filter((c) => known.has(c.company_id));
  if (SQLlib) {
    try {
      db?.close();
      db = createDatabase(SQLlib, files, uploads, generated);
      for (const c of corrections) applyCorrection(db, c, lookupIdx);
      data = readData(db);
      return;
    } catch (err) { dbError = err.message; db = null; }
  }
  data = fromFiles(files, uploads);
  for (const c of corrections) correctInMemory(c);
}
const lookupAddresses = () => [...files.geocoder.addresses, ...(generated?.addresses ?? [])];
// Without the database (a viewer that blocks WebAssembly), the engine reads the files directly.
function fromFiles(f, ups, gen = generated) {
  const unplacedAddresses = ups.flatMap((u) => u.addresses ?? []).map((a) => ({ ...a, school_district: 'UNRESOLVED', municipality: null }));
  return {
    catalog: f.catalog,
    geocoder: { ...f.geocoder, addresses: [...f.geocoder.addresses, ...(gen?.addresses ?? []), ...unplacedAddresses] },
    pools: f.pools,
    companies: [...f.companies, ...(gen?.companies ?? []), ...ups.map((u) => u.company)],
  };
}

// Write where every line ended up, and the decision log, into the outcome tables.
function syncOutcomes() {
  if (!db) return;
  const key = JSON.stringify([settingsKey(), data.companies.length, state.decisions, state.audit.length, state.audit[0]?.at ?? '']);
  if (key === outcomesKey) return;
  const lines = [];
  for (const c of data.companies) {
    let a;
    try { a = analysisFor(c.company_id); } catch { continue; }
    for (const k of effectiveAll(a, peekDecisions(c.company_id))) {
      const e = k.decision.employer;
      const x = k.decision.expert;
      lines.push({
        company_id: c.company_id, line_id: k.case_id, employee: k.employee_name, desktop_item: labelOf(k.item.label), state: k.state,
        route: k.route, reason: k.reason ?? null, stage: k.stage,
        online_tax: k.route === 'local_tax' ? k.proposal.map((p) => p.tax.name).join(' + ') : k.route === 'custom_entry' ? k.entry?.name ?? null : null,
        decided_by: e ? (e.auto ? 'Rule' : 'Employer') : x ? (x.auto ? 'Rule' : 'Expert') : null,
        rule: e?.rule ?? x?.rule ?? null,
      });
    }
  }
  writeOutcomes(db, lines, state.audit.map((a) => ({ at: a.at, company_id: a.company_id, actor: a.actor, action: a.action, target: a.target, detail: a.detail })));
  outcomesKey = key;
}

function runSql(sql) {
  query.sql = sql;
  if (!db) { query.result = null; query.error = 'The database is not running here.'; return; }
  syncOutcomes();
  try { query.result = runQuery(db, sql); query.error = null; } catch (err) { query.result = null; query.error = err.message; }
}

async function uploadFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  const id = `U-${Date.now().toString(36).toUpperCase()}`;
  const res = companyFromCsv(text, { ...files.geocoder, addresses: lookupAddresses() }, id);
  if (res.problems?.length) {
    uploadMsg = { tone: 'bad', title: `${file.name} was not added`, items: res.problems };
  } else {
    // The engine's own file checks: a file it cannot analyse is refused with its reasons.
    try {
      analyseCompany(res.company, fromFiles(files, [...uploads, res]), state.settings);
      uploads.push({ company: res.company, addresses: res.addresses, file: file.name });
      saveUploads();
      rebuildData();
      const a = analysisFor(id);
      log('Admin', 'Uploaded a Desktop file', res.company.name, file.name);
      uploadMsg = { tone: 'good', title: `Added ${res.company.name}`, id, items: [`${plural(res.company.employees.length, 'employee')} and ${plural(a.cases.length, 'Desktop line')}: ${a.cases.filter((c) => c.route === 'local_tax').length} local tax, ${a.cases.filter((c) => c.route === 'not_a_tax').length} not a tax, ${a.cases.filter((c) => c.route === 'not_in_database').length} to an expert.`, ...a.dataIssues.map((d) => d.text)] };
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
    generated = generateBusinesses(catalog);
    try { SQLlib = await loadSqlJs(); } catch (err) { dbError = err.message || 'WebAssembly is blocked here'; }
    rebuildData();
    if (!data.companies.some((c) => c.company_id === state.companyId)) state.companyId = data.companies.find((c) => c.company_id === 'G-001')?.company_id ?? data.companies[0].company_id;
    render();
  } catch (err) {
    app.innerHTML = `<p class="boot">The demo data did not load (${esc(err.message)}). Run <code>npm run build</code> and <code>npm start</code>, then open http://localhost:3000.</p>`;
  }
}

boot();
