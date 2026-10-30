// Browser app for the BRD v3 local-tax migration prototype. No framework, no build step.
import { analyseCompany, DEFAULT_THRESHOLDS } from './engine/analysis.mjs';
import { MODEL_VERSION } from './engine/cluster.mjs';
import { effectiveAll, emptyDecisions, gapStage, gapCoveredBy, readiness, w2Preview, reconcile, liveTaxes, STAGE_LABEL, automate, automationStats, exceptions as openExceptions, AUTOMATION_RULES, DEFAULT_POLICY } from './engine/workflow.mjs';
import { monthSpan, rateText, cloudMonths } from './engine/util.mjs';
import { buildReport, casesCSV } from './report.mjs';
import { GROUPS, runScenarios } from './scenarios.mjs';

const STORE = 'local-tax-migration:brd-v3';
const VIEWS = ['clients', 'analysis', 'review', 'expert', 'golive', 'reconcile', 'scenarios', 'model', 'audit'];
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

// ---------- state ----------

function freshState() {
  return { companyId: 'C-FHS', settings: { forceShadow: {}, thresholds: {} }, decisions: {}, audit: [], filters: { review: 'todo', expert: 'open' }, sel: {}, selIndex: {}, query: {}, detailOpen: false };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const saved = JSON.parse(raw);
      const fresh = freshState();
      return { ...fresh, ...saved, settings: { ...fresh.settings, ...(saved.settings ?? {}) }, filters: { ...fresh.filters, ...(saved.filters ?? {}) }, sel: saved.sel ?? {}, selIndex: saved.selIndex ?? {}, query: saved.query ?? {} };
    }
  } catch { /* storage unavailable: start fresh */ }
  return freshState();
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* demo still works without storage */ }
}

const currentView = () => {
  const h = location.hash.replace('#', '');
  return VIEWS.includes(h) ? h : 'analysis';
};
const companyById = (id = state.companyId) => data.companies.find((c) => c.company_id === id);
const decisionsFor = (id = state.companyId) => (state.decisions[id] ??= emptyDecisions());
function analysisFor(id = state.companyId) {
  const key = `${id}|${JSON.stringify(state.settings)}`;
  if (!cache.has(key)) cache.set(key, analyseCompany(companyById(id), data, state.settings));
  return cache.get(key);
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
const MARK = { pass: '✓', fail: '×', warn: '!', info: 'i' };
// Line icons (24px grid, stroke drawn in the current text colour).
const ICONS = {
  landmark: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
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
};
const icon = (name, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
const mark = (tone) => `<span class="mark ${tone}" aria-hidden="true">${MARK[tone]}</span>`;
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

function render() {
  if (!data) return;
  const view = currentView();
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
  const body = { clients: viewClients, analysis: viewAnalysis, review: viewReview, expert: viewExpert, golive: viewGoLive, reconcile: viewReconcile, scenarios: viewScenarios, model: viewModel, audit: viewAudit }[view](s);
  app.innerHTML = `${appbar(view, s)}<main class="main" id="main" tabindex="-1"><div class="page${wide ? ' wide' : ''}">${body}${footnote()}</div></main>`;
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
  if (afterRender) { const fn = afterRender; afterRender = null; fn(); }
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
  const items = [...document.querySelectorAll('.records > li')];
  let shown = 0;
  for (const li of items) {
    const hit = !q || li.dataset.text.includes(q);
    li.hidden = !hit;
    if (hit) shown += 1;
  }
  const empty = document.getElementById('queue-empty');
  if (empty) {
    empty.hidden = shown > 0;
    empty.textContent = items.length && !shown ? `No records match "${q}".` : empty.dataset.empty;
  }
}

function scenarios() {
  scenarioResults ??= runScenarios(data);
  return scenarioResults;
}

const STEP_TABS = [['analysis', 'Analysis'], ['review', 'Review'], ['expert', 'Expert'], ['golive', 'Go live'], ['reconcile', 'Reconcile']];
const OVERSIGHT = [['scenarios', 'Scenarios', 'list'], ['model', 'Governance', 'gauge'], ['audit', 'Decision log', 'history'], ['clients', 'All clients', 'grid']];

function appbar(view, s) {
  const co = s.a.company;
  const options = data.companies.map((c) => `<option value="${esc(c.company_id)}"${c.company_id === state.companyId ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const tab = ([id, text], i) => {
    const n = id === 'review' ? s.awaiting : id === 'expert' ? s.expert : 0;
    return `<a href="#${id}"${view === id ? ' aria-current="page"' : ''}><span class="step">${i + 1}</span>${text}${n ? `<span class="count" aria-label="${n} open">${n}</span>` : ''}</a>`;
  };
  const total = s.cases.length;
  const decided = s.cases.filter((c) => !['awaiting_employer', 'with_expert'].includes(c.stage)).length;
  const lines = s.cases.filter((c) => c.stage === 'awaiting_employer').length;
  const gaps = s.awaiting - lines;
  const action = lines + gaps + s.expert;
  const share = total ? decided / total : 0;
  const used = statesInUse(s.a);
  const statusTone = { 'Not started': 'info', 'In review': 'accent', Live: 'good', Reconciled: 'good' }[s.status];
  const modeText = Object.values(s.a.models).filter((m) => used.has(m.state))
    .map((m) => `<span class="mode ${m.mode === 'assisted' ? 'good' : 'warn'}"><span class="dot"></span>${esc(m.name)} ${m.mode === 'assisted' ? 'suggestions on' : 'in shadow mode'}</span>`).join('');
  const sc = scenarios();
  const passed = sc.filter((x) => x.pass).length;
  const links = OVERSIGHT.map(([id, text, ic]) => `<a href="#${id}"${view === id ? ' aria-current="page"' : ''}>${icon(ic)}${text}${id === 'scenarios' ? `<span class="count ok">${passed}/${sc.length}</span>` : ''}</a>`).join('');
  const breakdown = `${plural(lines, 'line')} waiting for the employer, ${s.expert} with an expert, ${plural(gaps, 'expected tax', 'expected taxes')} not withheld`;
  return `<header class="appbar">
    <div class="appbar-main">
      <a class="logo" href="#analysis"><span class="logo-tile">${icon('landmark')}</span><span class="logo-text"><strong>Local Tax Migration</strong><small>Desktop to Online Payroll · demo</small></span></a>
      <label class="company-box"><span class="sr-only">Client</span>${icon('building')}<select id="company" data-action="company">${options}</select><span class="plan">${esc(co.plan)}</span></label>
      <nav class="tabs" aria-label="Migration steps">${STEP_TABS.map(tab).join('')}</nav>
      <button class="btn reset" type="button" data-action="reset" title="Clear every decision and start the demo again">${icon('reset')}<span>Reset</span></button>
    </div>
    <div class="batchbar">
      <span class="status ${statusTone}"><span class="dot"></span>${esc(s.status)}</span>
      <span class="batch-progress"><span class="progress" role="img" aria-label="${decided} of ${total} lines decided"><span style="width:${(share * 100).toFixed(1)}%"></span></span><span><b>${decided}</b> of ${total} lines decided</span></span>
      <span class="batch-need" title="${esc(breakdown)}">${action ? `<b>${action}</b> need action` : 'Nothing waiting'}</span>
      ${s.d.autoRun ? `<span class="batch-auto">${icon('spark')}<b>${pct(automationStats(s.a, s.d).share, 0)}</b> automated</span>` : ''}
      ${modeText}
      <nav class="batch-links" aria-label="Oversight">${links}</nav>
    </div>
  </header>`;
}

function scenarioCount() {
  const r = scenarios();
  return `${r.filter((x) => x.pass).length}/${r.length}`;
}

function footnote() {
  return `<p class="footnote">Academic prototype for the BDA group exam, Case 19. Ohio school-district codes, names and rates come from the Ohio Department of Taxation's 2026 list; the Lancaster (2.3%) and Columbus (2.5%) city rates come from the cities' own pages. Companies, people, addresses, account numbers and wages are fictional. Not affiliated with or endorsed by Intuit.</p>`;
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

function automationCard(s) {
  const d = s.d;
  const ran = Boolean(d.autoRun);
  const view = ran ? { decisions: d, exceptions: openExceptions(s.a, d), stats: automationStats(s.a, d) } : automationPreview(s);
  const st = view.stats;
  const left = view.exceptions;
  const share = pct(st.share, 0);
  const policy = policyOf(d);
  const rules = AUTOMATION_RULES.map((r) => `<label class="rule"><input type="checkbox" data-action="auto-rule" data-rule="${r.id}"${policy[r.id] ? ' checked' : ''}${d.live ? ' disabled' : ''}><span><strong>${esc(r.label)}</strong><span>${esc(r.help)}</span></span></label>`).join('');
  const owner = (x) => (x.owner === 'expert' ? 'Expert' : 'Employer');
  const open = (x) => (x.kind === 'account' ? '<a class="btn" href="#golive">Add it</a>'
    : `<button class="btn" type="button" data-action="goto" data-view="${x.owner === 'expert' ? 'expert' : 'review'}" data-key="${esc(x.kind === 'gap' ? `g|${x.gap_id}` : `c|${x.case_id}`)}">Open</button>`);
  const leftList = left.length
    ? `<div class="auto-left"><span class="label">${ran ? 'Left for a person' : 'Will be left for a person'} (${left.length})</span><ul>${left.map((x) => `<li><span class="who"><strong>${esc(x.employee ?? x.item)}</strong>${x.employee ? `<span>"${esc(labelOf(x.item))}"</span>` : ''}</span><span class="badge ${x.reason === 'account_missing' || x.owner === 'employer' ? 'warn' : REASON_TONE[x.reason] === 'bad' ? 'bad' : 'warn'}">${esc(exceptionText(x))}</span><span class="owner">${owner(x)}</span>${open(x)}</li>`).join('')}</ul></div>`
    : `<p class="auto-done">${icon('check')}${d.live ? `Everything is settled. ${d.liveAuto ? 'The company went live and reconciled automatically.' : 'The company is live.'}` : 'Nothing is left for a person.'}</p>`;
  const headline = ran
    ? `<b>${st.auto}</b> of ${st.total} settled automatically`
    : `<b>${st.auto}</b> of ${st.total} can be settled automatically`;
  const sub = ran
    ? `${st.manual ? `${plural(st.manual, 'decision')} by a person. ` : ''}${left.length ? 'The rest finishes by itself once these are decided.' : ''}`
    : 'One click applies the rules below. Lines the BRD reserves for people are never guessed.';
  return `<section class="auto-card" aria-labelledby="auto-h">
    <div class="auto-head">
      <div class="auto-title"><span class="auto-ic">${icon('spark')}</span><div><h2 id="auto-h">Automatic migration</h2><p>${ran ? (d.live ? 'Done.' : 'On. It re-runs after every decision a person makes.') : 'Ready to run.'}</p></div></div>
      ${d.live ? '' : `<button class="btn ${ran ? '' : 'primary lg'}" type="button" data-action="run-auto">${icon('spark')}${ran ? 'Run again' : 'Run automatic migration'}</button>`}
    </div>
    <div class="auto-score">
      <span class="auto-big">${share}</span>
      <div><p class="auto-line">${headline}</p><div class="progress wide" role="img" aria-label="${share} settled automatically"><span style="width:${(st.share * 100).toFixed(1)}%"></span></div>${sub ? `<p class="auto-sub">${esc(sub)}</p>` : ''}</div>
    </div>
    ${leftList}
    <details class="fold auto-rules"><summary>${icon('list')}Rules the employer approved (${AUTOMATION_RULES.filter((r) => policy[r.id]).length} of ${AUTOMATION_RULES.length} on)${icon('chevron', 'chev')}</summary><div class="fold-body">${rules}</div></details>
  </section>`;
}

// ---------- clients (accountant) ----------

function viewClients() {
  const totals = { auto: 0, total: 0, left: 0, ran: 0 };
  const rows = data.companies.map((c) => {
    const s = summary(c.company_id);
    const tone = { 'Not started': '', 'In review': 'accent', Live: 'good', Reconciled: 'good' }[s.status];
    const st = automationStats(s.a, s.d);
    const left = openExceptions(s.a, s.d).length;
    totals.auto += st.auto; totals.total += st.total; totals.left += s.d.autoRun ? left : 0; totals.ran += s.d.autoRun ? 1 : 0;
    return `<tr>
      <td><strong>${esc(c.name)}</strong><div class="small muted">${[...statesInUse(s.a)].map((x) => esc(stateName(x))).join(', ')}. Moves in ${monthSpan([c.migration_month])}.</div>${c.description ? `<div class="small">${esc(c.description)}</div>` : ''}</td>
      <td>${esc(c.plan)}</td>
      <td class="num">${c.employees.length}</td>
      <td class="num">${s.a.cases.length}</td>
      <td class="num">${pct(st.share, 0)}</td>
      <td class="num">${left}</td>
      <td>${pill(s.status, tone)}</td>
      <td><div class="row nowrap"><button class="btn" type="button" data-action="open-client" data-id="${esc(c.company_id)}">Open</button>${s.d.live ? '' : `<button class="btn quiet" type="button" data-action="run-auto" data-company="${esc(c.company_id)}">${s.d.autoRun ? 'Run again' : 'Run automation'}</button>`}</div></td>
    </tr>`;
  }).join('');
  return `<div class="page-head"><h1>Clients moving to Online payroll</h1>
    <p class="lede">Run the automatic migration for every client at once. The rules settle what they can; each client keeps only its true exceptions for a person.</p></div>
    <div class="auto-strip"><span class="auto-big">${pct(totals.total ? totals.auto / totals.total : 0, 0)}</span><span><b>${totals.auto}</b> of ${totals.total} lines and expected taxes settled automatically${totals.ran ? `; ${plural(totals.left, 'item')} left for a person` : ''}</span><button class="btn primary" type="button" data-action="run-auto-all">${icon('spark')}Run automation for every client</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Client</th><th>Plan</th><th class="num">Employees</th><th class="num">Desktop lines</th><th class="num">Automated</th><th class="num">Left for a person</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ---------- 1 analysis ----------

function viewAnalysis(s) {
  const a = s.a;
  const used = [...statesInUse(a)];
  const byState = used.map((st) => `${stateName(st)} ${a.cases.filter((c) => c.state === st).length}`).join(', ');
  const expectedCount = a.employees.reduce((n, e) => n + e.expected.list.length, 0);
  const missingAddr = a.employees.filter((e) => !e.expected.periods.length).length;
  const custom = a.cases.filter((c) => c.item.origin === 'custom').length;
  const modelLine = used.map((st) => `${a.models[st].name}: ${a.models[st].mode === 'assisted' ? 'suggestions on' : 'shadow mode'}`).join('; ');
  const confirmed = s.cases.filter((c) => !['awaiting_employer', 'with_expert'].includes(c.stage)).length;
  const items = a.company.items.map((i) => {
    const users = a.company.employees.filter((e) => e.items.includes(i.item_id)).length;
    return `<tr><td><strong>${esc(labelOf(i.label))}</strong></td><td>${i.law_id}</td><td>${i.origin === 'custom' ? 'Custom' : 'System-defined'}</td><td>${esc(i.item_type)}, ${esc(i.tracking_type)}</td><td>${esc(rateText(i))}</td><td>${esc(i.agency)}</td><td class="num">${users}</td></tr>`;
  }).join('');
  const people = a.employees.map((e) => {
    const site = a.company.worksites.find((w) => w.site_id === e.site_id);
    const homes = e.expected.periods.length
      ? e.expected.periods.map((p) => { const ad = addressById(p.address_id); return `${esc([ad.line1, ad.city, ad.state].filter(Boolean).join(', '))} <span class="muted">(${monthSpan(p.months)})</span>`; }).join('<br>')
      : '<span class="bad-text">Missing in Desktop</span>';
    const expected = e.expected.list.length ? e.expected.list.map((x) => esc(taxShort(x.tax)) + (x.required ? '' : ' (optional)')).join('<br>') : '<span class="muted">None listed</span>';
    return `<tr data-employee="${esc(e.employee_id)}"><td><strong>${esc(e.name)}</strong>${employmentText(e) ? `<div class="small muted">${esc(employmentText(e))}</div>` : ''}</td><td>${homes}</td><td>${esc(site.name)}${e.remote ? '<div class="small muted">Works from home</div>' : ''}</td><td>${expected}</td></tr>`;
  }).join('');

  return `<div class="page-head"><h1>${esc(a.company.name)}: migration analysis</h1>
    <p class="lede">${plural(a.employees.length, 'employee')} and ${plural(a.cases.length, 'Desktop payroll line')} to check (one line per employee per item). ${s.routes.local_tax} match a tax on the employee's expected list, ${s.routes.not_a_tax} ${s.routes.not_a_tax === 1 ? 'is' : 'are'} not a tax, ${s.routes.not_in_database} need an expert, and ${plural(a.gaps.length, 'expected tax', 'expected taxes')} had no Desktop item at all.</p></div>
    ${automationCard(s)}
    <section class="section" aria-labelledby="pipe-h">
      <div class="section-head"><h2 id="pipe-h">The five steps</h2><p>Run while the company is still on Desktop. Every line ends in exactly one route, and nothing goes live without the employer.</p></div>
      <ol class="pipeline">
        <li><strong>Find the state</strong><p>From the item's label, or else the employee's address.</p><span class="result">${esc(byState)}</span></li>
        <li><strong>List expected taxes</strong><p>Home and work addresses give a short list of taxes each person should have.</p><span class="result">${plural(expectedCount, 'expected tax', 'expected taxes')}${missingAddr ? `, ${plural(missingAddr, 'address', 'addresses')} missing` : ''}</span></li>
        <li><strong>Cluster custom items</strong><p>Custom labels are grouped within each state and named by the closest defined entry.</p><span class="result">${plural(custom, 'custom line')}. ${esc(modelLine)}</span></li>
        <li><strong>Route every item</strong><p>Local tax, not a tax, or not in database. Gaps are flagged both ways.</p><span class="result">${s.routes.local_tax} / ${s.routes.not_a_tax} / ${s.routes.not_in_database}, ${plural(a.gaps.length, 'gap')}</span></li>
        <li><strong>Employer confirms</strong><p>By rules the employer approved once; people handle only the exceptions.</p><span class="result">${confirmed} of ${s.cases.length} decided</span></li>
      </ol>
    </section>
    <section class="routes" aria-label="Route counts">
      <div class="route-tile local"><span class="n">${s.routes.local_tax}</span><span class="t">Local tax</span><p>Matches a defined tax on the expected list.</p></div>
      <div class="route-tile nontax"><span class="n">${s.routes.not_a_tax}</span><span class="t">Not a tax</span><p>After-tax in Desktop, or a known non-tax item.</p></div>
      <div class="route-tile notdb"><span class="n">${s.routes.not_in_database}</span><span class="t">Not in database</span><p>No match, weak signal, conflict, or shadow mode.</p></div>
      <div class="route-tile gap"><span class="n">${a.gaps.length}</span><span class="t">Expected, not withheld</span><p>On the expected list, but no Desktop item covers it.</p></div>
    </section>
    ${a.company.company_id === 'C-FHS' ? demoGuide() : companyNote(a.company)}
    ${a.dataIssues.length ? `<section class="section" aria-labelledby="dq-h">
      <div class="section-head"><h2 id="dq-h">Problems found in the Desktop file</h2><p>Checked before anything else. These were cleaned up so the analysis could run; fix them in the file before the move.</p></div>
      <ul class="marks">${a.dataIssues.map((i) => `<li>${mark('warn')}<span>${esc(i.text)}</span></li>`).join('')}</ul>
    </section>` : ''}
    <section class="section" aria-labelledby="items-h">
      <div class="section-head"><h2 id="items-h">What came across from Desktop</h2><p>Law ID 177 or 0 marks an employer-created custom item. Its name is free text.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Item label</th><th>Law ID</th><th>Kind</th><th>Desktop setting</th><th>Rate</th><th>Agency on file</th><th class="num">Employees</th></tr></thead><tbody>${items}</tbody></table></div>
    </section>
    <section class="section" aria-labelledby="people-h">
      <div class="section-head"><h2 id="people-h">Employees and their expected taxes</h2><p>From the demo address lookup. In production this is Intuit's tax applicability API.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Home address</th><th>Works at</th><th>Expected taxes</th></tr></thead><tbody>${people}</tbody></table></div>
    </section>`;
}

function employmentText(e) {
  const parts = [];
  if ((e.hired_month ?? 1) > 1) parts.push(`Joined ${monthSpan([e.hired_month])}`);
  if ((e.left_month ?? 12) < 12) parts.push(`Left after ${monthSpan([e.left_month])}`);
  return parts.join(', ');
}

function companyNote(company) {
  return `<section class="panel section" aria-labelledby="note-h">
    <h2 id="note-h">What this client shows</h2>
    <p>${esc(company.description ?? '')}</p>
    <p class="small muted">Every case and its live check is listed on <a href="#scenarios">Scenario coverage</a>, with a link to the employee it concerns.</p>
  </section>`;
}

function demoGuide() {
  return `<section class="panel section" aria-labelledby="guide-h">
    <h2 id="guide-h">Try the demo</h2>
    <ol class="marks">
      <li>${mark('info')}<span>Click <strong>Run automatic migration</strong> above. The employer's rules settle 16 of 18 items: the verified matches, Priya Shah at the official 1.0% rate, Sara Lee's union dues, Raj Patel's missing Teays Valley tax, and Mike Brown's school tax (not owed in Columbus City Schools).</span></li>
      <li>${mark('info')}<span><a href="#expert">Expert queue</a>: only two lines are left. Mark Kevin O'Neil's garnishment as not a tax, and map Tom Reed's "Local Tax" to Lancaster CSD once his address is known.</span></li>
      <li>${mark('info')}<span>Automation accepts both decisions, goes live and reconciles. Check <a href="#golive">Go live</a> for the W-2 boxes and the <a href="#audit">Decision log</a> for every automatic step and its rule.</span></li>
    </ol>
  </section>`;
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
  review: [['todo', 'Needs decision'], ['verified', 'Verified'], ['expert', 'With expert', 'warn'], ['done', 'Done'], ['all', 'All']],
  expert: [['open', 'Open', 'warn'], ['decided', 'Decided'], ['all', 'All']],
};
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
const rateFmt = (r) => `${Number(r).toFixed(2)}%`;
const taxCode = (t) => (t.type === 'school_district' ? `SD ${t.code}` : t.place);
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
      if (c.verified) return ['Verified', 'good'];
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
    ? { confirmed: ['Auto-confirmed', 'done'], moved_to_deduction: ['Auto: deduction', 'done'], employer_managed: ['Auto: employer-managed', 'done'], stopped: ['Auto: stopped', 'done-bad'] }
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
  const items = list.map((r) => {
    return `<li data-text="${esc(r.text)}"><button type="button" class="record" data-action="select" data-key="${esc(r.key)}"${sel?.key === r.key ? ' aria-current="true"' : ''}>
      <span class="rec-top"><strong>${esc(r.name)}</strong>${badge(r.badge, r.tone)}</span>
      <span class="rec-map"><span class="from">${esc(r.from)}</span>${icon('arrow')}<span class="to ${r.toTone}">${esc(r.to)}</span></span>
    </button></li>`;
  }).join('');
  const emptyText = {
    todo: 'Nothing is waiting for the employer.', verified: 'No verified matches are waiting.', expert: 'No lines are with an expert.',
    done: 'No decisions yet.', all: 'No records.', open: 'The expert queue is empty.', decided: 'No expert decisions yet.',
  }[filter];
  const title = view === 'review' ? 'Employer review' : 'Expert queue';
  const blurb = view === 'review' ? plural(all.length, 'record') : `${all.filter((r) => r.groups.has('open')).length} open`;
  const autoStats = automationStats(s.a, s.d);
  const foot = view === 'review'
    ? (s.d.autoRun || live
      ? `<div class="queue-foot"><p>${icon('spark')}Automation is on: ${autoStats.auto} of ${autoStats.total} settled automatically.${live ? '' : ' Anything left here is an exception for a person.'}</p></div>`
      : `<div class="queue-foot"><button class="btn primary" type="button" data-action="run-auto">${icon('spark')}Run automatic migration</button><p>Settles ${automationPreview(s).stats.auto} of ${autoStats.total} by the employer's rules; only exceptions stay here.</p></div>`)
    : '<div class="queue-foot"><p>Lines the system would not decide alone. An Intuit payroll expert decides; the employer still confirms before anything goes live.</p></div>';
  let detail;
  if (!sel) detail = `${mobileBack(view)}<div class="empty"><strong>${esc(emptyText)}</strong><span>${view === 'review' ? (s.expert ? `${plural(s.expert, 'line')} still with an expert. Those stay off until an expert decides and you confirm.` : 'Every line has a decision.') : 'Every line the system could not settle has an expert decision.'}</span><a class="btn" href="#golive">Go to go-live checks</a></div>`;
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

const mobileBack = (view) => `<div class="mobile-back"><button class="btn quiet" type="button" data-action="back">${icon('back')}Back to the ${view === 'review' ? 'review' : 'expert'} queue</button></div>`;

function viewReview(s) { return workspace('review', s); }
function viewExpert(s) { return workspace('expert', s); }

// ---------- record detail ----------

function recordHeader({ name, id, meta, badgeHtml, flow, why, stage, next }) {
  return `<div class="rec-header">
    <div class="rec-title">
      <div><h2>${esc(name)}</h2><p class="sub"><span class="idchip">${esc(id)}</span>${meta}</p></div>
      ${badgeHtml}
    </div>
    ${flow}
    ${why ? `<p class="why">${esc(why)}</p>` : ''}
    <div class="next"><span class="next-ic">${icon('arrow')}</span><div><span class="next-label">Next step<span>${esc(stage)}</span></span><p>${esc(next)}</p></div></div>
  </div>`;
}

// The record's story in one line: what Desktop had, and where it goes in Online payroll.
const flowSide = (side, label, title, meta, tone = '') => `<div class="flow-side ${side} ${tone}"><span class="flow-label">${label}</span><strong>${title}</strong>${meta ? `<span class="flow-meta">${meta}</span>` : ''}</div>`;
const flow = (from, to) => `<div class="flow">${from}<span class="flow-arrow" aria-hidden="true">${icon('arrow')}</span>${to}</div>`;

function caseFlow(c) {
  const item = c.item;
  const from = flowSide('from', 'Desktop payroll', esc(labelOf(item.label)), esc(`Law ID ${item.law_id} · ${item.origin === 'custom' ? 'custom item' : 'system item'} · ${rateText(item)}`));
  let to;
  if (c.route === 'local_tax') {
    const title = c.proposal.map((p) => `${esc(p.tax.name)}${c.proposal.length > 1 ? ` <span class="flow-when">${esc(monthSpan(p.months))}</span>` : ''}`).join('<br>');
    const p = c.proposal[0];
    const meta = c.proposal.length > 1 ? 'Split by the move' : `${p.tax.type === 'school_district' ? `SD ${p.tax.code} · ` : ''}${rateFmt(p.tax.rate)} · ${basisText(p.basis)}`;
    to = flowSide('to', 'Online payroll', title, esc(meta), c.verified || c.stage === 'confirmed' ? 'good' : 'warn');
  } else if (c.route === 'not_a_tax') to = flowSide('to', 'Online payroll', 'Non-tax deduction', 'Moves to deductions; never filed as a tax', 'neutral');
  else if (c.route === 'custom_entry') to = flowSide('to', 'Online payroll', esc(c.entry.name), esc(`Custom entry · employer-managed · ${c.entry.flat ? `${money(c.entry.flat)} a year` : `${c.entry.rate}%`}`), 'blue');
  else if (c.route === 'stop') to = flowSide('to', 'Online payroll', 'Stop withholding', esc(c.ytd ? `${money(c.ytd)} to correct with the agency` : 'Nothing was withheld'), 'bad');
  else to = flowSide('to', 'Online payroll', 'Waiting for an expert', esc(REASON_SHORT[c.reason] ?? 'Needs an expert'), REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn');
  return flow(from, to);
}

function caseWhy(c) {
  if (c.route === 'local_tax') {
    const p = c.proposal[0];
    if (p.fromExpert) return `Mapped by an expert: ${expertText(c)}.`;
    const where = p.address ? ` Found from the ${basisText(p.basis)}: ${[p.address.line1, p.address.city].filter(Boolean).join(', ')}.` : '';
    return `${c.reasonText}${where}`;
  }
  if (c.route === 'not_a_tax') return c.decision.expert?.action === 'not_a_tax' ? 'An expert decided this is not a tax.' : c.reasonText;
  if (c.route === 'custom_entry') return `Employer-managed: you pay and file it. ${c.entry.agency}, ${basisText(c.entry.basis)}, ${c.entry.frequency}.`;
  if (c.route === 'stop') return c.decision.expert?.note || 'An expert found this tax does not apply to this employee.';
  return `${c.reasonText} It stays off until an expert decides.`;
}

function nextStep(c, view, live) {
  if (live) return OPEN_STAGES.has(c.stage) ? 'This company is live, so decisions are locked. Undo go-live to change them.' : `Done: ${STAGE_LABEL[c.stage].toLowerCase()}. This company is live.`;
  if (view === 'expert') {
    if (c.stage === 'with_expert') return EXPERT_HINT[c.reason] ?? 'Decide how this line should migrate.';
    return `Decided: ${expertText(c)}. The employer ${c.stage === 'awaiting_employer' ? 'confirms it next' : 'has confirmed it'}.`;
  }
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
  const meta = `<span class="meta">${esc(stateName(c.state))} · ${c.model ? (c.model.shown ? 'model shown' : 'model logged only') : 'rules only'}</span>`;
  if (c.decision.expert) return `<div class="banner info">${icon('user', 'lg')}<div><strong>Expert decision:</strong> ${esc(expertText(c))}. The system's original findings are under "How the system decided".</div>${meta}</div>`;
  const issues = c.evidence.filter((x) => x.tone === 'fail' || x.tone === 'warn').map((x) => x.text);
  if (c.decision.sentToExpert) issues.push('The employer sent this line to an expert.');
  if (!issues.length) {
    const why = c.route === 'local_tax' ? 'On the expected list, the rate matches, no conflicts.' : c.route === 'not_a_tax' ? 'Desktop and the label agree this is not a tax.' : 'No blocking conflicts.';
    return `<div class="banner good">${icon('check', 'lg')}<div><strong>All checks passed.</strong> ${why}</div>${meta}</div>`;
  }
  const tone = c.stage === 'with_expert' && REASON_TONE[c.reason] === 'bad' ? 'bad' : 'warn';
  return `<div class="banner ${tone}">${icon('alert', 'lg')}<div><strong>${plural(issues.length, 'thing', 'things')} to check</strong><ul>${issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>${meta}</div>`;
}

function mappingTable(rows) {
  return `<section class="card" aria-label="Desktop versus Online mapping">
    <div class="card-head"><span class="card-title">${icon('swap')}Desktop versus Online mapping</span><span class="meta">QuickBooks Desktop → QuickBooks Online Payroll</span></div>
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
      fromExpert ? note('blue', 'user', 'Mapped by an expert') : custom ? note('good', 'check', `Clustered as ${c.model?.entry_label ?? 'a defined tax'}`) : note('good', 'check', 'Intuit-defined item')]);
    rows.push(['Jurisdiction', custom ? none('Not recorded in Desktop') : src(s.a.idx.taxes.get(item.system_tax_id)?.name ?? item.system_tax_id), target((p) => `${p.tax.place} · ${basisText(p.basis)}`), note('good', 'pin', 'From the address lookup')]);
    const sameAgency = c.proposal.every((p) => String(p.tax.agency).toLowerCase() === String(item.agency ?? '').toLowerCase());
    rows.push(['Agency', item.agency ? src(item.agency) : none('None on file'), target((p) => p.tax.agency), sameAgency ? note('good', 'check', 'Same agency') : note('', 'info', 'Replaced by the official agency')]);
    rows.push(['Rate', src(rateText(item)), target((p) => `${rateFmt(p.tax.rate)}${p.tax.base ? ` ${p.tax.base.toLowerCase()}` : ''}`, (p) => (p.rate.status === 'over' || p.rate.status === 'under' ? 'warn' : '')), stack(c.proposal.map((p) => {
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
  if (c.model) rows.push(['Model suggestion', none('Label only'), c.model.entry_label ? tgt(c.model.entry_label, 'blue') : none('No defined entry'), note(c.model.shown ? 'blue' : '', 'spark', `${c.model.confidence} confidence, silhouette ${c.model.item_silhouette.toFixed(2)}${c.model.shown ? '' : ' (logged, hidden)'}`)]);
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
    ${recordHeader({ name: c.employee_name, id: e.employee_id, meta, badgeHtml: badge(b, tone), flow: caseFlow(c), why: caseWhy(c), stage: STAGE_LABEL[c.stage], next: nextStep(c, view, live) })}
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
  if (s.d.live) return `<div class="action-bar">${logNote}<a class="btn" href="#golive">Live: see go-live</a></div>`;
  if (view === 'expert') {
    if (c.stage === 'with_expert') return `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="goto" data-view="review" data-key="${key}">Open in employer review</button></div>`;
    return `<div class="action-bar">${logNote}<button class="btn" type="button" data-action="expert-undo" data-id="${id}">Reopen</button><button class="btn primary" type="button" data-action="goto" data-view="review" data-key="${key}">Open in employer review</button></div>`;
  }
  if (c.stage === 'with_expert') {
    const items = c.decision.sentToExpert && !c.decision.expert ? [`<button class="btn" type="button" data-action="unsend-expert" data-id="${id}">Take it back from the expert</button>`] : [];
    return `<div class="action-bar">${logNote}${moreMenu(items)}<button class="btn primary" type="button" data-action="goto" data-view="expert" data-key="${key}">Open in the expert queue</button></div>`;
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
  const [b, tone] = { awaiting_employer: ['Not withheld', 'bad'], added: ['Added', 'done'], covered: ['Covered', 'done'] }[stage];
  const gapFlow = flow(
    flowSide('from', 'Desktop payroll', 'No item', esc(g.pastMonths.length ? `Nothing withheld ${monthSpan(g.pastMonths)}` : 'Nothing to withhold yet'), ''),
    flowSide('to', 'Online payroll', esc(g.tax.name), esc(`${g.tax.type === 'school_district' ? `SD ${g.tax.code} · ` : ''}${rateFmt(g.tax.rate)} · ${basisText(g.basis)}`), stage === 'awaiting_employer' ? 'bad' : stage === 'added' ? 'good' : 'neutral'));
  const why = stage === 'covered'
    ? `An expert mapped "${by?.item.label ?? ''}" to this tax, so it is not added twice.`
    : `Expected from the ${basisText(g.basis)} ${[g.address.line1, g.address.city].filter(Boolean).join(', ')}, ${monthSpan(g.months)}, but no Desktop item withholds it.`;
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
    ${recordHeader({ name: g.employee_name, id: e.employee_id, meta: `${esc(site.name)} · ${money(e.monthly_wages)} a month`, badgeHtml: badge(b, tone), flow: gapFlow, why, stage: stage === 'awaiting_employer' ? 'Waiting for the employer' : stage === 'added' ? 'Added' : 'Covered', next })}
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
  no_address: 'Get the home address from the employee, then map the line to the district for that address.',
  address_unresolved: 'Confirm the address (new builds are often missing from boundary files), then map the line to the right district.',
  ambiguous: 'More than one expected tax fits. Pick the right one from the list.',
  employer_sent: 'The employer disagreed with the suggestion. Check the address and the Desktop item, then decide.',
};

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
  const sel = (name, values, current) => `<select id="${name}-${id}" name="${name}">${values.map(([v, t]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<section class="card" aria-label="Expert decision">
    <div class="card-head"><span class="card-title">${icon('user')}Expert decision</span><span class="meta">Goes back to the employer to confirm</span></div>
    <div class="card-body tools">
      ${EXPERT_HINT[c.reason] ? `<p class="hint-line">${esc(EXPERT_HINT[c.reason])}</p>` : ''}
      <div class="map-row">
        <label class="field" for="map-${id}">Map to a defined tax${stateTaxes.length ? `<select id="map-${id}"><option value="">Choose a tax</option>${options}</select>` : `<select id="map-${id}" disabled><option>No ${esc(stateName(c.state))} taxes in the catalogue yet</option></select>`}</label>
        <button class="btn primary" type="button" data-action="expert-map" data-id="${esc(c.case_id)}" data-select="map-${id}"${stateTaxes.length ? '' : ' disabled'}>Map</button>
      </div>
      <div class="row">
        <button class="btn" type="button" data-action="expert-nontax" data-id="${esc(c.case_id)}">Mark as not a tax</button>
        <button class="btn danger" type="button" data-action="expert-stop" data-id="${esc(c.case_id)}">Not owed: stop withholding</button>
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
    <p class="lede">Confirmed taxes switch on with the first cloud payroll. Past Desktop withholding is relabelled to the confirmed tax so the W-2 is right; the amounts never change. Anything still with an expert stays off.</p></div>
    ${live ? `<div class="live-banner"><span>Live since ${new Date(s.d.liveAt).toLocaleString()}: ${plural(liveCount, 'employee tax', 'employee taxes')} switched on.</span><div class="row"><a class="btn" href="#reconcile">Reconcile</a><button class="btn quiet" type="button" data-action="undo-live">Undo go-live (demo)</button></div></div>` : ''}
    <div class="two-col">
      <section class="panel section" aria-labelledby="checks-h">
        <h2 id="checks-h">Checks before the first cloud payroll</h2>
        <ul class="checks">${r.checks.map((c) => `<li>${mark(c.pass ? 'pass' : 'fail')}<div><strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span></div></li>`).join('')}</ul>
        ${r.expert.length ? `<p class="small muted">${plural(r.expert.length, 'line')} still with an expert will stay off: ${r.expert.map((c) => `${esc(c.employee_name)} "${esc(labelOf(c.item.label))}"`).join(', ')}.</p>` : ''}
        ${live ? '' : `<div><button class="btn primary" type="button" data-action="go-live"${r.ready ? '' : ' disabled'}>Go live with confirmed taxes</button></div>`}
      </section>
      <section class="panel section" aria-labelledby="tie-h">
        <h2 id="tie-h">Where every Desktop dollar goes</h2>
        <p class="small muted">${money(tie.accounted)} of ${money(tie.total)} local tax withheld in Desktop this year has a destination.</p>
        <div class="tie-bar" role="img" aria-label="Share of Desktop local tax dollars by destination">${bar}</div>
        <div class="table-wrap"><table><thead><tr><th>Destination</th><th class="num">Lines</th><th class="num">Amount</th></tr></thead><tbody>${tieRows}</tbody></table></div>
      </section>
    </div>
    <section class="section" aria-labelledby="acct-h">
      <div class="section-head"><h2 id="acct-h">Agency accounts</h2><p>QuickBooks needs the account number and deposit frequency to pay and file. Filled from Desktop where the item had them.</p></div>
      ${r.accounts.length ? `<div class="table-wrap"><table><thead><tr><th>Agency</th><th>Account number</th><th>Deposit frequency</th><th>Source</th></tr></thead><tbody>${accounts}</tbody></table></div>` : '<div class="empty"><span>No taxes are confirmed yet, so no agency accounts are needed.</span></div>'}
    </section>
    <section class="section" aria-labelledby="w2-h">
      <div class="section-head"><h2 id="w2-h">W-2 local boxes</h2><p>Projected for 2026: Desktop withholding relabelled for January to September, plus Online payroll from October.</p></div>
      <div class="w2-grid">${w2.map(w2Card).join('')}</div>
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

function viewReconcile(s) {
  const head = `<div class="page-head"><h1>Reconcile</h1><p class="lede">After the first cloud payroll and again after the first quarter, withholding is compared with what each employee's addresses say they owe, and every mismatch is flagged.</p></div>`;
  if (!s.d.live) return `${head}<div class="empty"><strong>Go live first.</strong><span>Reconciliation runs on real cloud paychecks, so it starts after the confirmed taxes are switched on.</span><a class="btn" href="#golive">Open go-live checks</a></div>`;
  if (!s.d.reconciled) return `${head}<div class="empty"><strong>Ready to run.</strong><span>The demo simulates October's first payroll and the October to December quarter at the official rates.</span><button class="btn primary" type="button" data-action="run-reconcile">Run first payroll and first quarter</button></div>`;
  const r = reconcile(s.a, s.d);
  const rows = r.rows.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.agency)}</div></td><td>${x.employees.map(esc).join(', ')}</td><td class="num">${money(x.firstPayroll)}</td><td class="num">${money(x.quarter)}</td><td>${pill(x.payer, x.qb ? 'good' : 'info')}</td></tr>`).join('');
  const fails = r.flags.filter((f) => f.tone === 'fail').length;
  return `${head}
    <div class="row">${pill(`${plural(r.rows.length, 'tax', 'taxes')} withheld`, 'accent')}${pill(`${money(r.totals.quarter)} this quarter`, 'info')}${pill(fails ? `${plural(fails, 'expected tax', 'expected taxes')} missing` : 'No expected tax missing', fails ? 'bad' : 'good')}</div>
    <div class="table-wrap"><table><thead><tr><th>Tax</th><th>Employees</th><th class="num">First payroll (Oct)</th><th class="num">First quarter</th><th>Who pays and files</th></tr></thead><tbody>${rows}</tbody></table></div>
    <section class="section" aria-labelledby="flags-h"><div class="section-head"><h2 id="flags-h">Flags</h2><p>${s.a.company.plan === 'Core' ? 'This company is on the Core plan, so it pays and files local taxes itself.' : 'Taxes QuickBooks supports are paid and filed automatically on this plan.'}</p></div>
      ${r.flags.length ? `<ul class="marks panel">${r.flags.map((f) => `<li>${mark(f.tone)}<span>${esc(f.text)}</span></li>`).join('')}</ul>` : '<div class="empty"><span>No mismatches.</span></div>'}
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
    <div class="section-head"><h2 id="th-h">Try the gates</h2><p>Change a threshold to see a state switch between suggestions and shadow mode. A value exactly equal to the threshold passes. ${locked ? 'This company is live, so the thresholds are locked here.' : 'Changes apply to every client in this demo.'}</p></div>
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
      <p class="small muted">The model is fitted once per state on the expert-labelled labels, so these gates are the same for every client. Coverage: ${pct(m.coverage, 0)} of labelled labels get a high-confidence suggestion; the rest go to people. Silhouette says how well the groups are formed, not whether the names are right, so precision is measured separately against expert answers.${m.forced ? ' Shadow mode is forced on for this state.' : ''}</p>
      ${unassigned}
      <div class="cluster-list">${clusters}</div>
    </section>`;
  }).join('');
  return `<div class="page-head"><h1>Model governance</h1>
    <p class="lede">Custom labels are clustered within each state and each cluster is named by its closest defined entry. Suggestions appear only in a state that passes every gate. Otherwise the model runs in shadow mode: it logs suggestions so precision can be measured, and people decide. Highlighted labels belong to this client (outlined ones were new to the model and joined the nearest cluster); dotted ones are weak signals that go to an expert.</p></div>
    <p class="small muted">Model: ${esc(MODEL_VERSION)}.</p>
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
  const VIEW_NAME = { review: 'Employer review', expert: 'Expert queue', golive: 'Go live', reconcile: 'Reconcile', model: 'Model governance', analysis: 'Analysis' };
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
  return `<div class="page-head"><h1>Scenario coverage</h1>
    <p class="lede">Every case the BRD design has to handle, including the boundary values. Each row runs a live check against the starting data when the page loads; the same checks run in the automated tests. Use the button on a row to open the client and employee it concerns.</p></div>
    <div class="score ${passed === results.length ? 'all' : ''}"><span class="n">${passed} of ${results.length}</span><span>scenarios pass</span></div>
    ${groups}`;
}

// ---------- decision log ----------

function viewAudit(s) {
  const entries = state.audit.filter((a) => a.company_id === state.companyId);
  const rows = entries.map((a) => `<tr><td class="small">${esc(new Date(a.at).toLocaleString())}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td class="small muted">${esc(a.detail)}</td></tr>`).join('');
  return `<div class="page-head"><h1>Decision log</h1>
    <p class="lede">Every decision by the employer, an expert or governance, with the model version that produced the suggestion. Export the full report with every line, its route, outcome and evidence.</p></div>
    <div class="row">${HOSTED
      ? `<button class="btn primary" type="button" data-action="copy-json">Copy report (JSON)</button>
      <button class="btn" type="button" data-action="copy-csv">Copy lines (CSV)</button>
      <span class="small muted">Downloads work when you run the app locally.</span>`
      : `<button class="btn primary" type="button" data-action="export-json">Download report (JSON)</button>
      <button class="btn" type="button" data-action="export-csv">Download lines (CSV)</button>
      <button class="btn quiet" type="button" data-action="copy-json">Copy report</button>`}
    </div>
    <label class="sr-only" for="copy-box">Report JSON</label><textarea class="copy-box" id="copy-box" readonly hidden></textarea>
    ${entries.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Line</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><strong>No decisions yet.</strong><span>Decisions on the review screen and in the expert queue appear here.</span><a class="btn" href="#review">Open employer review</a></div>'}`;
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
  toast(`Confirmed ${plural(list.length, 'verified match', 'verified matches')} for ${companyById(companyId).name}`);
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
    case 'company-switch':
      state.companyId = el.dataset.id;
      toast(`Opened ${companyById().name}`);
      break;
    case 'company':
      state.companyId = el.value;
      state.detailOpen = false;
      toast(`Opened ${companyById().name}`);
      break;
    case 'reset':
      state = freshState();
      cache.clear();
      toast('Demo reset to its starting data');
      break;
    case 'open-client':
      state.companyId = id;
      save();
      location.hash = '#review';
      return;
    case 'bulk':
      bulkConfirm(el.dataset.company ?? state.companyId);
      break;
    case 'run-auto': {
      const cid = el.dataset.company ?? state.companyId;
      const res = runAutomationFor(cid, { explicit: true });
      const st = automationStats(analysisFor(cid), res.decisions);
      toast(`${st.auto} of ${st.total} settled automatically.${res.exceptions.length ? ` ${plural(res.exceptions.length, 'item')} left for a person.` : res.decisions.live ? ' The company is live.' : ''}`);
      break;
    }
    case 'run-auto-all': {
      let auto = 0; let total = 0; let left = 0;
      for (const c of data.companies) {
        if (decisionsFor(c.company_id).live) continue;
        const res = runAutomationFor(c.company_id, { explicit: true });
        const st = automationStats(analysisFor(c.company_id), res.decisions);
        auto += st.auto; total += st.total; left += res.exceptions.length;
      }
      toast(`Automation settled ${auto} of ${total} items across every client; ${plural(left, 'item')} left for a person.`);
      break;
    }
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
      afterRender = scrollToDetail;
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
      const view = el.dataset.view;
      if (view === 'review' || view === 'expert') {
        state.filters[view] = 'all';
        state.detailOpen = Boolean(el.dataset.employee);
        if (el.dataset.employee) { focusEmployee = el.dataset.employee; keepDetail = true; }
      } else if (el.dataset.employee) pendingFocus = el.dataset.employee;
      save();
      const target = `#${el.dataset.view}`;
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
const AUTO_FOLLOW = new Set(['decide', 'unsend-expert', 'add-gap', 'expert-map', 'expert-nontax', 'expert-stop', 'expert-custom', 'account', 'auto-rule']);

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || ['SELECT', 'INPUT', 'FORM', 'TEXTAREA'].includes(el.tagName)) return;
  if (el.disabled) return;
  handle(el.dataset.action, el);
});
app.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el && ['company', 'account', 'force-shadow', 'threshold'].includes(el.dataset.action)) handle(el.dataset.action, el);
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
});

// Keep the selected record's detail in view after choosing it: on a phone the list is replaced by the
// detail, and on a wide screen the page scrolls back up if the detail's top is out of view.
function scrollToDetail() {
  const d = document.querySelector('.detail');
  if (!d) return;
  const top = d.getBoundingClientRect().top + window.scrollY - 10;
  if (window.innerWidth <= 900 || window.scrollY > top) window.scrollTo(0, Math.max(0, top));
}

async function boot() {
  try {
    const get = async (file) => {
      const res = await fetch(new URL(`./data/${file}`, import.meta.url));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      return res.json();
    };
    const [catalog, geocoder, pool, companies] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json', 'companies.json'].map(get));
    data = { catalog, geocoder, pools: pool.pools, companies: companies.companies };
    if (!data.companies.some((c) => c.company_id === state.companyId)) state.companyId = data.companies[0].company_id;
    render();
  } catch (err) {
    app.innerHTML = `<p class="boot">The demo data did not load (${esc(err.message)}). Run <code>npm run build</code> and <code>npm start</code>, then open http://localhost:3000.</p>`;
  }
}

boot();
