// Browser app for the BRD v3 local-tax migration prototype. No framework, no build step.
import { analyseCompany } from './engine/analysis.mjs';
import { MODEL_VERSION } from './engine/cluster.mjs';
import { effectiveAll, emptyDecisions, gapStage, readiness, w2Preview, reconcile, liveTaxes, STAGE_LABEL } from './engine/workflow.mjs';
import { monthSpan, rateText } from './engine/util.mjs';
import { buildReport, casesCSV } from './report.mjs';

const STORE = 'local-tax-migration:brd-v3';
const VIEWS = ['clients', 'analysis', 'review', 'expert', 'golive', 'reconcile', 'model', 'audit'];
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
// The hosted demo blocks file downloads, so it offers copy buttons instead.
const HOSTED = Boolean(document.querySelector('meta[name="ltm-hosted"]'));

let data = null;
let state = loadState();
const cache = new Map();

// ---------- state ----------

function freshState() {
  return { companyId: 'C-FHS', settings: { forceShadow: {} }, decisions: {}, audit: [], filter: 'action', open: {} };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...freshState(), ...JSON.parse(raw) };
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
  const key = `${id}|${JSON.stringify(state.settings.forceShadow)}`;
  if (!cache.has(key)) cache.set(key, analyseCompany(companyById(id), data, state.settings));
  return cache.get(key);
}
const addressById = (id) => data.geocoder.addresses.find((a) => a.address_id === id);

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
const mark = (tone) => `<span class="mark ${tone}" aria-hidden="true">${MARK[tone]}</span>`;
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
  const openGaps = a.gaps.filter((g) => gapStage(g, d) !== 'added').length;
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
  const s = summary();
  const body = { clients: viewClients, analysis: viewAnalysis, review: viewReview, expert: viewExpert, golive: viewGoLive, reconcile: viewReconcile, model: viewModel, audit: viewAudit }[view](s);
  app.innerHTML = `${topbar(s)}${rail(view, s)}<main class="main" id="main" tabindex="-1"><div class="page">${body}${footnote()}</div></main>`;
}

function topbar(s) {
  const options = data.companies.map((c) => `<option value="${esc(c.company_id)}"${c.company_id === state.companyId ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const used = statesInUse(s.a);
  const modes = Object.values(s.a.models).filter((m) => used.has(m.state))
    .map((m) => pill(`${m.name}: ${m.mode === 'assisted' ? 'suggestions on' : 'shadow mode'}`, m.mode === 'assisted' ? 'good' : 'warn')).join('');
  return `<header class="topbar">
    <div class="brand"><strong>Local Tax Migration</strong><span>Desktop to Online payroll · BRD v3 prototype</span></div>
    <div class="company-picker"><label for="company">Company</label><select id="company" data-action="company">${options}</select>${pill(`${s.a.company.plan} plan`, 'info')}</div>
    <div class="modes">${modes}</div>
    <button class="btn quiet" type="button" data-action="reset">Reset demo</button>
  </header>`;
}

function rail(view, s) {
  const link = (id, inner) => `<a href="#${id}"${view === id ? ' aria-current="page"' : ''}>${inner}</a>`;
  const steps = [['analysis', 'Analysis'], ['review', 'Employer review', s.awaiting], ['expert', 'Expert queue', s.expert], ['golive', 'Go live'], ['reconcile', 'Reconcile']];
  return `<nav class="rail" aria-label="Sections">
    <div class="rail-group"><span class="rail-title">Accountant</span>${link('clients', 'All clients')}</div>
    <div class="rail-group"><span class="rail-title">Migration steps</span>${steps.map(([id, text, n], i) => link(id, `<span class="num">${i + 1}</span>${text}${n ? `<span class="count" aria-label="${n} open">${n}</span>` : ''}`)).join('')}</div>
    <div class="rail-group"><span class="rail-title">Oversight</span>${link('model', 'Model governance')}${link('audit', 'Decision log')}</div>
  </nav>`;
}

function footnote() {
  return `<p class="footnote">Academic prototype for the BDA group exam, Case 19. Ohio school-district codes, names and rates come from the Ohio Department of Taxation's 2026 list; the Lancaster (2.3%) and Columbus (2.5%) city rates come from the cities' own pages. Companies, people, addresses, account numbers and wages are fictional. Not affiliated with or endorsed by Intuit.</p>`;
}

// ---------- clients (accountant) ----------

function viewClients() {
  const rows = data.companies.map((c) => {
    const s = summary(c.company_id);
    const tone = { 'Not started': '', 'In review': 'accent', Live: 'good', Reconciled: 'good' }[s.status];
    return `<tr>
      <td><strong>${esc(c.name)}</strong><div class="small muted">${[...statesInUse(s.a)].map((x) => esc(data.catalog.states[x].name)).join(', ')}</div></td>
      <td>${esc(c.plan)}</td>
      <td class="num">${c.employees.length}</td>
      <td class="num">${s.a.cases.length}</td>
      <td class="num">${s.verified}</td>
      <td class="num">${s.awaiting}</td>
      <td class="num">${s.expert}</td>
      <td>${pill(s.status, tone)}</td>
      <td><div class="row"><button class="btn" type="button" data-action="open-client" data-id="${esc(c.company_id)}">Open</button><button class="btn quiet" type="button" data-action="bulk" data-company="${esc(c.company_id)}"${s.verified && !s.d.live ? '' : ' disabled'}>Confirm ${s.verified} verified</button></div></td>
    </tr>`;
  }).join('');
  return `<div class="page-head"><h1>Clients moving to Online payroll</h1>
    <p class="lede">Where each client's local taxes stand. Verified matches (on the expected list, rate checked) can be confirmed in bulk for the employer; everything else needs the employer or an expert.</p></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Client</th><th>Plan</th><th class="num">Employees</th><th class="num">Desktop lines</th><th class="num">Verified</th><th class="num">Waiting on employer</th><th class="num">With expert</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ---------- 1 analysis ----------

function viewAnalysis(s) {
  const a = s.a;
  const used = [...statesInUse(a)];
  const byState = used.map((st) => `${data.catalog.states[st].name} ${a.cases.filter((c) => c.state === st).length}`).join(', ');
  const expectedCount = a.employees.reduce((n, e) => n + e.expected.list.length, 0);
  const missingAddr = a.employees.filter((e) => !e.expected.periods.length).length;
  const custom = a.cases.filter((c) => c.item.origin === 'custom').length;
  const modelLine = used.map((st) => `${a.models[st].name}: ${a.models[st].mode === 'assisted' ? 'suggestions on' : 'shadow mode'}`).join('; ');
  const confirmed = s.cases.filter((c) => !['awaiting_employer', 'with_expert'].includes(c.stage)).length;
  const items = a.company.items.map((i) => {
    const users = a.company.employees.filter((e) => e.items.includes(i.item_id)).length;
    return `<tr><td><strong>${esc(i.label)}</strong></td><td>${i.law_id}</td><td>${i.origin === 'custom' ? 'Custom' : 'System-defined'}</td><td>${esc(i.item_type)}, ${esc(i.tracking_type)}</td><td>${esc(rateText(i))}</td><td>${esc(i.agency)}</td><td class="num">${users}</td></tr>`;
  }).join('');
  const people = a.employees.map((e) => {
    const site = a.company.worksites.find((w) => w.site_id === e.site_id);
    const homes = e.expected.periods.length
      ? e.expected.periods.map((p) => { const ad = addressById(p.address_id); return `${esc(ad.line1)}, ${esc(ad.city)}, ${esc(ad.state)} <span class="muted">(${monthSpan(p.months)})</span>`; }).join('<br>')
      : '<span class="bad-text">Missing in Desktop</span>';
    const expected = e.expected.list.length ? e.expected.list.map((x) => esc(taxShort(x.tax)) + (x.required ? '' : ' (optional)')).join('<br>') : '<span class="muted">None listed</span>';
    return `<tr><td><strong>${esc(e.name)}</strong></td><td>${homes}</td><td>${esc(site.name)}</td><td>${expected}</td></tr>`;
  }).join('');

  return `<div class="page-head"><h1>${esc(a.company.name)}: migration analysis</h1>
    <p class="lede">${plural(a.employees.length, 'employee')} and ${plural(a.cases.length, 'Desktop payroll line')} to check (one line per employee per item). ${s.routes.local_tax} match a tax on the employee's expected list, ${s.routes.not_a_tax} ${s.routes.not_a_tax === 1 ? 'is' : 'are'} not a tax, ${s.routes.not_in_database} need an expert, and ${plural(a.gaps.length, 'expected tax', 'expected taxes')} had no Desktop item at all.</p></div>
    <section class="section" aria-labelledby="pipe-h">
      <div class="section-head"><h2 id="pipe-h">The five steps</h2><p>Run while the company is still on Desktop. Every line ends in exactly one route, and nothing goes live without the employer.</p></div>
      <ol class="pipeline">
        <li><strong>Find the state</strong><p>From the item's label, or else the employee's address.</p><span class="result">${esc(byState)}</span></li>
        <li><strong>List expected taxes</strong><p>Home and work addresses give a short list of taxes each person should have.</p><span class="result">${plural(expectedCount, 'expected tax', 'expected taxes')}${missingAddr ? `, ${plural(missingAddr, 'address', 'addresses')} missing` : ''}</span></li>
        <li><strong>Cluster custom items</strong><p>Custom labels are grouped within each state and named by the closest defined entry.</p><span class="result">${plural(custom, 'custom line')}. ${esc(modelLine)}</span></li>
        <li><strong>Route every item</strong><p>Local tax, not a tax, or not in database. Gaps are flagged both ways.</p><span class="result">${s.routes.local_tax} / ${s.routes.not_a_tax} / ${s.routes.not_in_database}, ${plural(a.gaps.length, 'gap')}</span></li>
        <li><strong>Employer confirms</strong><p>Rate checked first; only then does a tax go live.</p><span class="result">${confirmed} of ${s.cases.length} decided</span></li>
      </ol>
    </section>
    <section class="routes" aria-label="Route counts">
      <div class="route-tile local"><span class="n">${s.routes.local_tax}</span><span class="t">Local tax</span><p>Matches a defined tax on the expected list.</p></div>
      <div class="route-tile nontax"><span class="n">${s.routes.not_a_tax}</span><span class="t">Not a tax</span><p>After-tax in Desktop, or a known non-tax item.</p></div>
      <div class="route-tile notdb"><span class="n">${s.routes.not_in_database}</span><span class="t">Not in database</span><p>No match, weak signal, conflict, or shadow mode.</p></div>
      <div class="route-tile gap"><span class="n">${a.gaps.length}</span><span class="t">Expected, not withheld</span><p>On the expected list, but no Desktop item covers it.</p></div>
    </section>
    ${a.company.company_id === 'C-FHS' ? demoGuide() : ''}
    <section class="section" aria-labelledby="items-h">
      <div class="section-head"><h2 id="items-h">What came across from Desktop</h2><p>Law ID 177 or 0 marks an employer-created custom item. Its name is free text.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Item label</th><th>Law ID</th><th>Kind</th><th>Desktop setting</th><th>Rate</th><th>Agency on file</th><th class="num">Employees</th></tr></thead><tbody>${items}</tbody></table></div>
    </section>
    <section class="section" aria-labelledby="people-h">
      <div class="section-head"><h2 id="people-h">Employees and their expected taxes</h2><p>From the demo address lookup. In production this is Intuit's tax applicability API.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Home address</th><th>Works at</th><th>Expected taxes</th></tr></thead><tbody>${people}</tbody></table></div>
    </section>`;
}

function demoGuide() {
  return `<section class="panel section" aria-labelledby="guide-h">
    <h2 id="guide-h">Try the demo</h2>
    <ol class="marks">
      <li>${mark('info')}<span><a href="#review">Employer review</a>: confirm the verified matches in one click, then confirm Priya Shah at the official 1.0% rate and add Raj Patel's missing Teays Valley school tax.</span></li>
      <li>${mark('info')}<span><a href="#expert">Expert queue</a>: mark Kevin O'Neil's garnishment as not a tax, mark Mike Brown's school tax as not owed (Columbus City Schools has no income tax), and map Tom Reed's "Local Tax" once his address is known.</span></li>
      <li>${mark('info')}<span>Back on the review screen, the employer confirms each expert decision. Nothing goes live without that.</span></li>
      <li>${mark('info')}<span><a href="#golive">Go live</a>: check the dollar tie-out and the W-2 boxes, then switch the confirmed taxes on and <a href="#reconcile">reconcile</a> the first quarter.</span></li>
    </ol>
  </section>`;
}

// ---------- 2 employer review ----------

function needsAction(e, cases, s) {
  return cases.some((c) => c.stage === 'awaiting_employer') || s.a.gaps.some((g) => g.employee_id === e.employee_id && gapStage(g, s.d) !== 'added');
}

function viewReview(s) {
  const live = s.d.live;
  const filter = state.filter;
  const cards = s.a.employees.map((e) => {
    const cases = s.cases.filter((c) => c.employee_id === e.employee_id);
    if (filter === 'action' && !needsAction(e, cases, s)) return '';
    return employeeCard(e, cases, s, live);
  }).join('');
  const toolbar = `<div class="toolbar">
      <div class="segmented" role="group" aria-label="Show">
        <button type="button" data-action="filter" data-value="action" aria-pressed="${filter === 'action'}">Needs your decision</button>
        <button type="button" data-action="filter" data-value="all" aria-pressed="${filter === 'all'}">All employees</button>
      </div>
      <button class="btn primary" type="button" data-action="bulk"${s.verified && !live ? '' : ' disabled'}>Confirm ${plural(s.verified, 'verified match', 'verified matches')}</button>
    </div>`;
  const empty = `<div class="empty"><strong>Nothing is waiting for the employer.</strong><span>${s.expert ? `${plural(s.expert, 'item')} still with an expert. Those stay off until an expert decides and you confirm.` : 'Every line has a decision.'}</span><a class="btn" href="#golive">Go to go-live checks</a></div>`;
  return `<div class="page-head"><h1>Employer review</h1>
    <p class="lede">One card per employee. The expected taxes come from their addresses; each Desktop line shows where it would go and why. ${live ? 'This company is live, so decisions are locked.' : 'Verified matches are on the expected list and pass the rate check; anything else shows what is wrong.'}</p></div>
    ${toolbar}
    ${cards || empty}`;
}

function employeeCard(e, cases, s, live) {
  const site = s.a.company.worksites.find((w) => w.site_id === e.site_id);
  const work = addressById(site.address_id);
  const homes = e.expected.periods.length
    ? e.expected.periods.map((p) => { const ad = addressById(p.address_id); return `<span>Home: ${esc(ad.line1)}, ${esc(ad.city)}, ${esc(ad.state)} ${esc(ad.zip)}${e.expected.periods.length > 1 ? ` (${monthSpan(p.months)})` : ''}</span>`; }).join('')
    : '<span class="bad-text">Home: missing in Desktop</span>';
  const chips = e.expected.list.map((x) => {
    const partYear = x.months.length < 12 ? `, ${monthSpan(x.months)}` : '';
    return `<span class="chip${x.required ? '' : ' optional'}">${x.tax.type === 'school_district' ? `<span class="code">SD ${esc(x.tax.code)}</span>` : ''}${esc(taxShort(x.tax))} ${x.tax.rate}% <em>${x.basis}${x.required ? '' : ', optional'}${partYear}</em></span>`;
  }).join('');
  const notes = e.expected.notes.map((n) => `<span class="note ${n.tone === 'warn' ? 'warn' : ''}">${esc(n.text)}</span>`).join('');
  const gaps = s.a.gaps.filter((g) => g.employee_id === e.employee_id).map((g) => gapRow(g, s.d, live)).join('');
  return `<article class="employee" aria-labelledby="emp-${domId(e.employee_id)}">
    <div class="employee-head">
      <div><h3 id="emp-${domId(e.employee_id)}">${esc(e.name)}</h3><div class="facts">${homes}<span>Works at: ${esc(site.name)}, ${esc(work.city)}, ${esc(work.state)}</span><span>Monthly wages: ${money(e.monthly_wages)}</span></div></div>
      <div class="expected"><span class="expected-title">Expected taxes, from the addresses</span><div class="chips">${chips || '<span class="muted small">None listed</span>'}</div>${notes ? `<div class="notes">${notes}</div>` : ''}</div>
    </div>
    ${cases.map((c) => caseRow(c, live)).join('')}
    ${gaps}
  </article>`;
}

function proposalHtml(c) {
  if (c.route === 'local_tax') {
    return c.proposal.map((p) => {
      const off = p.rate.status === 'over' || p.rate.status === 'under';
      return `<div class="proposal"><strong>${esc(p.tax.name)}</strong>${p.tax.type === 'school_district' ? ` <span class="code">SD ${esc(p.tax.code)}</span>` : ''}
        <span class="sub">${p.tax.rate}%${p.tax.base ? ` ${esc(p.tax.base.toLowerCase())}` : ''}, ${basisText(p.basis)}, ${monthSpan(p.months)}${p.fromExpert ? '. Mapped by an expert' : ''}${off ? `. <span class="bad-text">Desktop used ${esc(p.rate.desktop)}: ${p.rate.status === 'over' ? 'over' : 'under'}-withheld ${money(Math.abs(p.rate.difference))}</span>` : ''}</span></div>`;
    }).join('');
  }
  if (c.route === 'not_a_tax') {
    const why = c.decision.expert?.action === 'not_a_tax' ? 'An expert decided this is not a tax.' : c.reasonText;
    return `<div class="proposal"><strong>Non-tax deduction</strong><span class="sub">${esc(why)} It will never be filed as a tax.</span></div>`;
  }
  if (c.route === 'custom_entry') {
    const e = c.entry;
    return `<div class="proposal"><strong>${esc(e.name)}</strong> <span class="code">Custom entry</span><span class="sub">Employer-managed: you pay and file it. ${esc(e.agency)}, ${e.flat ? `${money(e.flat)} a year` : `${e.rate}%`}, ${basisText(e.basis)}, ${esc(e.frequency)}.</span></div>`;
  }
  if (c.route === 'stop') {
    return `<div class="proposal"><strong>Not owed: stop withholding</strong><span class="sub">${esc(c.decision.expert?.note || 'An expert found this tax does not apply to this employee.')} ${money(c.ytd)} withheld so far needs a correction with the agency.</span></div>`;
  }
  return `<div class="proposal"><strong>Not in database</strong><span class="sub">${esc(c.reasonText)} An expert decides; it stays off until then.</span></div>`;
}

function caseRow(c, live) {
  const decided = !['awaiting_employer', 'with_expert'].includes(c.stage);
  const open = state.open[c.case_id] ?? !(c.verified || decided);
  const route = ROUTE[c.route];
  const evidence = [...c.evidence];
  if (c.decision.expert) evidence.push({ tone: 'info', text: `Expert decision: ${expertText(c)}.` });
  const id = domId(c.case_id);
  let actions = '';
  if (!live) {
    if (c.stage === 'with_expert') actions = '<span class="hint">In the expert queue. Stays off until an expert decides.</span>';
    else if (c.stage === 'awaiting_employer') {
      const off = c.route === 'local_tax' && c.proposal.some((p) => p.rate.status === 'over' || p.rate.status === 'under');
      const label = { local_tax: off ? 'Confirm at official rate' : 'Confirm', not_a_tax: 'Move to deductions', custom_entry: 'Accept as employer-managed', stop: 'Stop withholding' }[c.route];
      actions = `<button class="btn primary" type="button" data-action="decide" data-id="${esc(c.case_id)}">${label}</button>`;
    } else actions = `<button class="btn quiet" type="button" data-action="undo-decide" data-id="${esc(c.case_id)}">Undo</button>`;
  }
  return `<div class="case${decided ? ' decided' : ''}">
    <div class="case-item"><strong>${esc(c.item.label)}</strong>
      <div class="meta">Law ID ${c.item.law_id} (${c.item.origin === 'custom' ? 'custom' : 'system-defined'}), ${esc(rateText(c.item))}, ${money(c.ytd)} withheld ${monthSpan(c.ytdByMonth.map((x) => x.month))}</div></div>
    <div class="case-body">
      <div class="row">${pill(route.label, route.tone)}${pill(STAGE_LABEL[c.stage], STAGE_TONE[c.stage])}${c.verified && c.stage === 'awaiting_employer' ? pill('Verified', 'good') : ''}</div>
      ${proposalHtml(c)}
      <div><button class="btn quiet why" type="button" data-action="toggle" data-id="${esc(c.case_id)}" aria-expanded="${open}" aria-controls="ev-${id}">${open ? 'Hide evidence' : 'Show evidence'}</button>
      <ul class="marks" id="ev-${id}"${open ? '' : ' hidden'}>${evidence.map((x) => `<li>${mark(x.tone)}<span>${esc(x.text)}</span></li>`).join('')}</ul></div>
    </div>
    <div class="case-actions">${actions}</div>
  </div>`;
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

function gapRow(g, d, live) {
  const done = gapStage(g, d) === 'added';
  const action = live ? '' : done
    ? `<button class="btn quiet" type="button" data-action="undo-gap" data-id="${esc(g.gap_id)}">Undo</button>`
    : `<button class="btn primary" type="button" data-action="add-gap" data-id="${esc(g.gap_id)}">Add from first cloud payroll</button>`;
  return `<div class="gap-row${done ? ' done' : ''}">
    <div><strong>${done ? 'Added' : 'Expected, but no Desktop item'}: ${esc(g.tax.name)}${g.tax.type === 'school_district' ? ` (SD ${esc(g.tax.code)})` : ''}, ${g.tax.rate}%</strong>
      <div class="small">From the ${basisText(g.basis)} ${esc(g.address.line1)}, ${esc(g.address.city)}. Nothing was withheld in ${monthSpan(g.pastMonths)}; estimated back tax ${money(g.backTaxEstimate)}. ${done ? 'Withholding starts with the first cloud payroll.' : ''}</div></div>
    ${action}
  </div>`;
}

// ---------- 3 expert queue ----------

function viewExpert(s) {
  const open = s.cases.filter((c) => c.stage === 'with_expert');
  const resolved = s.cases.filter((c) => c.decision.expert);
  const live = s.d.live;
  return `<div class="page-head"><h1>Expert queue</h1>
    <p class="lede">Lines the system would not decide alone: no match, a weak cluster signal, conflicting evidence, a missing address, or a state still in shadow mode. An Intuit payroll expert decides each one. The employer still confirms before anything goes live.</p></div>
    ${open.length ? open.map((c) => expertCard(c, s, live)).join('') : '<div class="empty"><strong>The queue is empty.</strong><span>Every line the system could not settle has an expert decision.</span></div>'}
    ${resolved.length ? `<section class="section" aria-labelledby="resolved-h"><div class="section-head"><h2 id="resolved-h">Decided by an expert</h2><p>Each now waits for, or already has, the employer's confirmation.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Desktop item</th><th>Expert decision</th><th>Employer</th><th></th></tr></thead><tbody>
      ${resolved.map((c) => `<tr><td>${esc(c.employee_name)}</td><td>${esc(c.item.label)}</td><td>${esc(expertText(c))}</td><td>${pill(STAGE_LABEL[c.stage], STAGE_TONE[c.stage])}</td><td>${live ? '' : `<button class="btn quiet" type="button" data-action="expert-undo" data-id="${esc(c.case_id)}">Reopen</button>`}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}`;
}

function expertCard(c, s, live) {
  const id = domId(c.case_id);
  const stateTaxes = [...s.a.idx.taxes.values()].filter((t) => t.state === c.state);
  const expectedIds = new Set(c.employee.expected.list.map((x) => x.tax_id));
  const options = [...stateTaxes].sort((x, y) => Number(expectedIds.has(y.tax_id)) - Number(expectedIds.has(x.tax_id)))
    .map((t) => `<option value="${esc(t.tax_id)}">${esc(t.name)}${t.type === 'school_district' ? ` (SD ${esc(t.code)})` : ''}, ${t.rate}%${expectedIds.has(t.tax_id) ? ' - on expected list' : ''}</option>`).join('');
  const reasonTone = { shadow: 'info', conflict: 'bad', not_expected: 'bad', no_address: 'warn', weak_signal: 'warn', ambiguous: 'warn' }[c.reason] ?? 'warn';
  const m = c.model;
  const suggestType = m?.tax_type;
  const typeGuess = { earned_income: 'Local earned income tax', local_services: 'Local services tax', municipal: 'Municipal income tax', school_district: 'School-district income tax' }[suggestType] ?? 'Other local tax';
  const basisGuess = suggestType === 'local_services' ? 'work' : suggestType === 'earned_income' ? 'higher' : suggestType === 'municipal' ? 'work' : 'home';
  const flat = c.item.calc.kind === 'flat_annual';
  const sel = (name, values, current) => `<select id="${name}-${id}" name="${name}">${values.map(([v, t]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const chips = c.employee.expected.list.map((x) => `<span class="chip">${esc(taxShort(x.tax))} ${x.tax.rate}% <em>${x.basis}</em></span>`).join('') || '<span class="muted small">None listed</span>';
  return `<article class="expert-card" aria-labelledby="ex-${id}">
    <div class="section">
      <div class="row">${pill(c.reasonText, reasonTone, 'wrap')}</div>
      <h3 id="ex-${id}">${esc(c.employee_name)}: "${esc(c.item.label)}"</h3>
      <p class="small muted">Law ID ${c.item.law_id}, ${esc(c.item.item_type)}, tracking type "${esc(c.item.tracking_type)}", ${esc(rateText(c.item))}, agency on file "${esc(c.item.agency)}". ${money(c.ytd)} withheld Jan–Sep.</p>
      ${m ? `<p class="logged">Model suggestion${m.shown ? '' : ' (logged, hidden from the employer)'}: ${esc(m.entry_label ?? 'no defined entry')}, label silhouette ${m.item_silhouette.toFixed(2)}, ${m.confidence} confidence.</p>` : ''}
      <ul class="marks">${c.evidence.map((x) => `<li>${mark(x.tone)}<span>${esc(x.text)}</span></li>`).join('')}</ul>
      <div class="expected"><span class="expected-title">This employee's expected taxes</span><div class="chips">${chips}</div></div>
    </div>
    <div class="expert-actions">
      ${live ? '<p class="muted">This company is live. Reopen work after an undo of go-live.</p>' : `
      <div class="map-row">
        <label class="field" for="map-${id}">Map to a defined tax${stateTaxes.length ? `<select id="map-${id}"><option value="">Choose a tax</option>${options}</select>` : `<select id="map-${id}" disabled><option>No ${esc(data.catalog.states[c.state].name)} taxes in the catalogue yet</option></select>`}</label>
        <button class="btn" type="button" data-action="expert-map" data-id="${esc(c.case_id)}" data-select="map-${id}"${stateTaxes.length ? '' : ' disabled'}>Map</button>
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
      </details>`}
    </div>
  </article>`;
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
        ${r.expert.length ? `<p class="small muted">${plural(r.expert.length, 'line')} still with an expert will stay off: ${r.expert.map((c) => `${esc(c.employee_name)} "${esc(c.item.label)}"`).join(', ')}.</p>` : ''}
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
  return `<article class="w2" aria-label="W-2 local boxes for ${esc(w.employee.name)}">
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

function viewModel(s) {
  const used = statesInUse(s.a);
  const panels = Object.values(s.a.models).filter((m) => used.has(m.state)).map((m) => {
    const t = m.thresholds;
    const gate = (name, rule, measured, pass) => `<tr><td><strong>${name}</strong></td><td>${rule}</td><td>${measured}</td><td>${pill(pass ? 'Pass' : 'Fail', pass ? 'good' : 'bad')}</td></tr>`;
    const clusters = [...m.clusters].sort((a, b) => b.size - a.size).map((c) => `<div class="cluster${c.kind ? '' : ' unnamed'}">
        <div class="cluster-head"><strong>${esc(c.name)}</strong><span class="small muted">${plural(c.size, 'label')}</span></div>
        <div class="meter${c.meanSilhouette < t.silhouetteFloor ? ' low' : ''}" role="img" aria-label="Mean silhouette ${c.meanSilhouette.toFixed(2)}"><span style="width:${Math.max(0, c.meanSilhouette) * 100}%"></span></div>
        <span class="small muted">Mean silhouette ${c.meanSilhouette.toFixed(2)}${c.kind ? `, ${c.kind === 'tax' ? 'tax' : 'non-tax'} entry` : ', no entry close enough'}</span>
        <div class="label-chips">${c.members.map((x) => `<span class="label-chip${x.fromCompany ? ' mine' : ''}${x.silhouette < t.itemFloor ? ' weak' : ''}">${esc(x.label)}<b>${x.silhouette.toFixed(2)}</b></span>`).join('')}</div>
      </div>`).join('');
    return `<section class="panel state-panel" aria-labelledby="st-${m.state}">
      <div class="section-head"><h2 id="st-${m.state}">${esc(m.name)}</h2>
        <div class="row">${pill(m.mode === 'assisted' ? 'Suggestions shown' : 'Shadow mode', m.mode === 'assisted' ? 'good' : 'warn')}
          <label class="switch"><input type="checkbox" data-action="force-shadow" data-state="${m.state}"${m.forced ? ' checked' : ''}${s.d.live ? ' disabled' : ''}> Force shadow mode</label></div></div>
      <div class="table-wrap"><table class="gate-table"><thead><tr><th>Gate</th><th>Rule</th><th>Measured</th><th>Result</th></tr></thead><tbody>
        ${gate('Rollout', 'State enabled for migration', data.catalog.states[m.state].rollout === 'enabled' ? 'Enabled' : 'Not yet enabled', m.gates.rollout)}
        ${gate('Silhouette', `Clusters well formed: at least ${t.silhouetteFloor.toFixed(2)}`, `${m.silhouette.toFixed(2)} with ${m.k} clusters`, m.gates.silhouette)}
        ${gate('Precision', `At least ${pct(t.precisionTarget, 0)} of high-confidence suggestions match the expert`, m.highConfidence ? `${pct(m.precision)} (${m.correct} of ${m.highConfidence})` : 'No high-confidence suggestions', m.gates.precision)}
        ${gate('Sample', `At least ${t.minSample} expert-labelled items (demo scale)`, `${m.poolSize}`, m.gates.sample)}
      </tbody></table></div>
      <p class="small muted">Coverage: ${pct(m.coverage, 0)} of labelled items get a high-confidence suggestion; the rest go to people. Silhouette says how well the groups are formed, not whether the names are right, so precision is measured separately against expert answers.${m.forced ? ' Shadow mode is forced on for this state.' : ''}</p>
      <div class="cluster-list">${clusters}</div>
    </section>`;
  }).join('');
  return `<div class="page-head"><h1>Model governance</h1>
    <p class="lede">Custom labels are clustered within each state and each cluster is named by its closest defined entry. Suggestions appear only in a state that passes every gate. Otherwise the model runs in shadow mode: it logs suggestions so precision can be measured, and people decide. Highlighted labels belong to this company; dotted ones are weak signals that go to an expert.</p></div>
    <p class="small muted">Model: ${esc(MODEL_VERSION)}.</p>
    ${panels}`;
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
    case 'company':
      state.companyId = el.value;
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
    case 'decide':
      decide(id);
      break;
    case 'undo-decide': {
      const c = findCase(id);
      if (d.live || !d.cases[id]) break;
      delete d.cases[id].employer;
      log('Employer', 'Undid decision', `${c.employee_name}: ${c.item.label}`);
      break;
    }
    case 'add-gap': {
      if (d.live) break;
      const g = analysisFor().gaps.find((x) => x.gap_id === id);
      d.gaps[id] = { action: 'add', at: new Date().toISOString() };
      log('Employer', 'Added expected tax', `${g.employee_name}: ${g.tax.name}`, `Starts with the first cloud payroll; back tax estimate ${money(g.backTaxEstimate)}`);
      toast(`Added ${g.tax.name} for ${g.employee_name}`);
      break;
    }
    case 'undo-gap':
      if (!d.live) delete d.gaps[id];
      break;
    case 'toggle': {
      const c = findCase(id);
      const decided = !['awaiting_employer', 'with_expert'].includes(c.stage);
      const open = state.open[id] ?? !(c.verified || decided);
      state.open[id] = !open;
      break;
    }
    case 'filter':
      state.filter = el.dataset.value;
      break;
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
      const note = c.reason === 'not_expected' ? 'No tax of this kind applies at the employee\'s home address.' : 'This tax does not apply to this employee.';
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
      log('Employer', 'Undid go-live (demo)', companyById().name);
      break;
    case 'run-reconcile':
      d.reconciled = true;
      log('System', 'Reconciled first payroll and quarter', companyById().name, `${reconcile(analysisFor(), d).flags.length} flags`);
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
  save();
  render();
}

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || ['SELECT', 'INPUT', 'FORM', 'TEXTAREA'].includes(el.tagName)) return;
  if (el.disabled) return;
  handle(el.dataset.action, el);
});
app.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el && ['company', 'account', 'force-shadow'].includes(el.dataset.action)) handle(el.dataset.action, el);
});
app.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-action]');
  if (!form) return;
  ev.preventDefault();
  handle(form.dataset.action, form);
});
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
  document.getElementById('main')?.focus({ preventScroll: true });
});

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
