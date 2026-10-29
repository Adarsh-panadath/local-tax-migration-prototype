// Every scenario the BRD v3 design has to handle, with a live check against the demo data.
// The website's Scenario coverage page and the automated tests both run this list.
import { analyseCompany, evaluateGates } from './engine/analysis.mjs';
import { effectiveAll, emptyDecisions, gapStage, readiness, dollarTieOut, w2Preview, reconcile, liveTaxes, STAGE_LABEL } from './engine/workflow.mjs';
import { monthSpan, rateCheck } from './engine/util.mjs';
import { buildReport, casesCSV } from './report.mjs';

export const GROUPS = [
  { id: 'data', title: 'Before step 1: check the Desktop file' },
  { id: 'state', title: 'Step 1: find the state' },
  { id: 'expected', title: 'Step 2: list the expected taxes' },
  { id: 'model', title: 'Step 3: cluster custom labels, and the gates' },
  { id: 'route', title: 'Step 4: route every line' },
  { id: 'gaps', title: 'Gaps: expected but not withheld' },
  { id: 'people', title: 'Step 5: employer and expert decisions' },
  { id: 'golive', title: 'Go-live checks' },
  { id: 'history', title: 'W-2 history' },
  { id: 'reconcile', title: 'Reconcile' },
  { id: 'timing', title: 'Joiners, leavers and the migration month' },
];

const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ok = (pass, detail) => ({ pass: Boolean(pass), detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ROUTE_WORD = { local_tax: 'local tax', not_a_tax: 'not a tax', not_in_database: 'expert' };
const RATE_WORD = { match: 'rate matches', no_history: 'no Desktop months to compare', over: 'over-withheld', under: 'under-withheld', not_comparable: 'flat amount' };
const stage = (s) => STAGE_LABEL[s]?.toLowerCase() ?? s;

// The decisions the main demo walks through (Fairfield Hardware Supply).
export function fhsDemoDecisions(a) {
  const d = emptyDecisions();
  const id = (name, label) => a.cases.find((c) => c.employee_name === name && c.item.label === label).case_id;
  d.cases[id("Kevin O'Neil", 'Wage Garnishment')] = { expert: { action: 'not_a_tax' } };
  d.cases[id('Mike Brown', 'School Tax')] = { expert: { action: 'stop', note: 'No school-district tax at this address.' } };
  d.cases[id('Tom Reed', 'Local Tax')] = { expert: { action: 'map', tax_id: 'OH-SD-2305' } };
  for (const c of effectiveAll(a, d)) if (c.stage === 'awaiting_employer') d.cases[c.case_id] = { ...(d.cases[c.case_id] ?? {}), employer: { action: c.route } };
  for (const g of a.gaps) d.gaps[g.gap_id] = { action: 'add' };
  return d;
}

export function scenarioContext(data) {
  const cache = new Map();
  const company = (id) => data.companies.find((c) => c.company_id === id);
  const analyse = (id, settings = {}) => {
    const key = `${id}|${JSON.stringify(settings)}`;
    if (!cache.has(key)) cache.set(key, analyseCompany(company(id), data, settings));
    return cache.get(key);
  };
  const find = (id, name, label, settings) => {
    const c = analyse(id, settings).cases.find((x) => x.employee_name === name && x.item.label === label);
    if (!c) throw new Error(`No line "${label}" for ${name}`);
    return c;
  };
  const eff = (id, name, label, decisions = emptyDecisions(), settings) => {
    const a = analyse(id, settings);
    return effectiveAll(a, decisions).find((x) => x.employee_name === name && x.item.label === label);
  };
  const emp = (id, name) => analyse(id).employees.find((e) => e.name === name);
  const gap = (id, name, taxId) => analyse(id).gaps.find((g) => g.employee_name === name && g.tax_id === taxId);
  const decide = (a, d, pairs) => {
    for (const [name, label, value] of pairs) {
      const c = a.cases.find((x) => x.employee_name === name && x.item.label === label);
      d.cases[c.case_id] = { ...(d.cases[c.case_id] ?? {}), ...value };
    }
    return d;
  };
  return { data, analyse, find, eff, emp, gap, decide };
}

export const SCENARIOS = [
  // ---------- Data checks (Ridgeview Print Shop has a deliberately messy file) ----------
  {
    id: 'data-blank-label', group: 'data', title: 'An item with a blank name',
    where: { company: 'C-RPS', employee: 'E01', view: 'expert' },
    expect: 'A name of only spaces has nothing to cluster, so an expert decides, and the school tax shows as a gap.',
    check: (x) => {
      const c = x.find('C-RPS', 'Leah Turner', '   ');
      const g = x.gap('C-RPS', 'Leah Turner', 'OH-SD-2305');
      return ok(c.route === 'not_in_database' && c.reason === 'weak_signal' && c.model.empty && g, `Route: ${ROUTE_WORD[c.route]} (${c.reason.replace('_', ' ')}); gap: ${g ? g.tax.name : 'none'}`);
    },
  },
  {
    id: 'data-unknown-address', group: 'data', title: 'An address the lookup has never seen',
    where: { company: 'C-RPS', employee: 'E02', view: 'expert' },
    expect: 'Reported as a file problem; the school line goes to an expert, while the work-based city tax still matches.',
    check: (x) => {
      const a = x.analyse('C-RPS');
      const school = x.find('C-RPS', 'Marco Silva', 'School Tax');
      const city = x.find('C-RPS', 'Marco Silva', 'Lancaster City Tax');
      const warned = a.dataIssues.some((i) => /H-404/.test(i.text));
      return ok(warned && school.reason === 'address_unresolved' && city.route === 'local_tax', `File problem reported: ${warned ? 'yes' : 'no'}; school tax: ${ROUTE_WORD[school.route]}; city tax: ${ROUTE_WORD[city.route]}`);
    },
  },
  {
    id: 'data-missing-item', group: 'data', title: 'An employee points at an item that does not exist',
    where: { company: 'C-RPS', employee: 'E03', view: 'analysis' },
    expect: 'The missing item is left out and reported; the rest of the employee still migrates.',
    check: (x) => {
      const a = x.analyse('C-RPS');
      const lines = a.cases.filter((c) => c.employee_name === 'Nina Brooks');
      const warned = a.dataIssues.some((i) => /I-OLD/.test(i.text));
      return ok(warned && lines.length === 2 && lines.every((c) => c.route === 'local_tax'), `Reported: ${warned ? 'yes' : 'no'}; lines kept: ${lines.map((c) => c.item.label).join(', ')}`);
    },
  },
  {
    id: 'data-duplicate-item', group: 'data', title: 'The same item listed twice for one person',
    where: { company: 'C-RPS', employee: 'E03', view: 'review' },
    expect: 'Counted once, so the dollars are not doubled.',
    check: (x) => {
      const a = x.analyse('C-RPS');
      const city = a.cases.filter((c) => c.employee_name === 'Nina Brooks' && c.item.label === 'Lancaster City Tax');
      const warned = a.dataIssues.some((i) => /listed twice/.test(i.text));
      return ok(warned && city.length === 1 && city[0].ytd === 848.7, `Lines: ${city.length}; year to date ${usd(city[0]?.ytd ?? 0)}`);
    },
  },
  {
    id: 'data-zero-rate', group: 'data', title: 'A 0% rate in Desktop',
    where: { company: 'C-RPS', employee: 'E04', view: 'review' },
    expect: 'Matched to the right district, flagged as under-withheld, and not bulk-confirmed.',
    check: (x) => {
      const c = x.eff('C-RPS', 'Victor Hale', 'School District Tax');
      const r = c.proposal[0]?.rate;
      return ok(c.ytd === 0 && r?.status === 'under' && r.difference === -405 && !c.verified, `${c.proposal[0]?.tax.name}: ${RATE_WORD[r?.status]} by ${usd(Math.abs(r?.difference ?? 0))}`);
    },
  },
  {
    id: 'data-move-state', group: 'data', title: 'Moves to another state mid-year',
    where: { company: 'C-RPS', employee: 'E05', view: 'review' },
    expect: 'Ohio school tax until June; Desktop kept withholding after the move to Pennsylvania, so those months are not owed.',
    check: (x) => {
      const c = x.find('C-RPS', 'Ruth Adams', 'School Tax');
      const e = x.emp('C-RPS', 'Ruth Adams');
      const noted = e.expected.notes.some((n) => /Pennsylvania/.test(n.text));
      return ok(same(c.proposal[0]?.months, range(1, 6)) && same(c.unowed?.months, [7, 8, 9]) && c.unowed.amount === 166.5 && noted, `${c.proposal[0]?.tax.name} ${monthSpan(c.proposal[0]?.months ?? [])}; not owed ${usd(c.unowed?.amount ?? 0)} in ${monthSpan(c.unowed?.months ?? [])}`);
    },
  },
  {
    id: 'data-blocked', group: 'data', title: 'Problems that stop the analysis',
    where: { company: 'C-RPS', view: 'analysis' },
    expect: 'A migration month outside 1 to 12, negative wages, joining after leaving, a duplicate employee or a rate over 100% stops the run with a plain message.',
    check: (x) => {
      const base = x.data.companies.find((c) => c.company_id === 'C-RPS');
      const broken = [
        ['migration month 13', (c) => { c.migration_month = 13; }, /migration month/],
        ['migration month 0', (c) => { c.migration_month = 0; }, /migration month/],
        ['negative wages', (c) => { c.employees[0].monthly_wages = -1; }, /monthly wages/],
        ['joined after leaving', (c) => { c.employees[0].hired_month = 8; c.employees[0].left_month = 3; }, /employment window/],
        ['duplicate employee', (c) => { c.employees.push({ ...c.employees[0] }); }, /appears twice/],
        ['rate over 100%', (c) => { c.items[0].calc.rate = 150; }, /0% to 100%/],
        ['unknown work site', (c) => { c.employees[0].site_id = 'S9'; }, /work site S9/],
      ];
      const results = broken.map(([name, mutate, pattern]) => {
        const c = structuredClone(base);
        mutate(c);
        try { analyseCompany(c, x.data, {}); return [name, false]; } catch (err) { return [name, err.name === 'DataError' && err.issues.some((i) => pattern.test(i.text))]; }
      });
      const caught = results.filter(([, y]) => y).length;
      return ok(caught === broken.length, `${caught} of ${broken.length} stopped with a clear message${caught < broken.length ? `; missed: ${results.filter(([, y]) => !y).map(([n]) => n).join(', ')}` : ''}`);
    },
  },
  {
    id: 'data-unsafe-text', group: 'data', title: 'Labels with code or spreadsheet formulas',
    where: { company: 'C-RPS', view: 'audit' },
    expect: 'Treated as plain text: routed to an expert, and the CSV export cannot run a formula.',
    check: (x) => {
      const c = structuredClone(x.data.companies.find((y) => y.company_id === 'C-RPS'));
      c.items[0].label = '=HYPERLINK("http://example.com","School Tax")';
      c.items[1].label = '<img src=x onerror=alert(1)>';
      const a = analyseCompany(c, x.data, {});
      const csv = casesCSV(buildReport(a, emptyDecisions(), []));
      const safe = !/(^|,)"?=HYPERLINK/m.test(csv) && csv.includes(`'=HYPERLINK`);
      const routed = a.cases.filter((y) => y.item.label.startsWith('<img')).every((y) => y.route === 'not_in_database');
      return ok(safe && routed, `CSV formula neutralised: ${safe ? 'yes' : 'no'}; code-like label sent to an expert: ${routed ? 'yes' : 'no'}`);
    },
  },

  // ---------- Step 1 ----------
  {
    id: 'state-label', group: 'state', title: 'The label names the state',
    where: { company: 'C-HVD', employee: 'E01', view: 'review' },
    expect: '"OH School Dist" is read as Ohio from its own label.',
    check: (x) => { const c = x.find('C-HVD', 'Dana Whitfield', 'OH School Dist'); return ok(c.state === 'OH' && /from the label/.test(c.evidence[0].text), c.evidence[0].text); },
  },
  {
    id: 'state-home', group: 'state', title: 'No state in the label: use the home address',
    where: { company: 'C-FHS', employee: 'E01', view: 'review' },
    expect: '"School Tax" says nothing about a state, so the home address decides.',
    check: (x) => { const c = x.find('C-FHS', 'John Carter', 'School Tax'); return ok(c.state === 'OH' && /home address/.test(c.evidence[0].text), c.evidence[0].text); },
  },
  {
    id: 'state-work', group: 'state', title: 'No home address either: use the work address',
    where: { company: 'C-FHS', employee: 'E05', view: 'review' },
    expect: 'Tom Reed has no home address, so the work site decides.',
    check: (x) => { const c = x.find('C-FHS', 'Tom Reed', 'Local Tax'); return ok(c.state === 'OH' && /work address/.test(c.evidence[0].text), c.evidence[0].text); },
  },
  {
    id: 'state-system', group: 'state', title: 'A system-defined item already carries its state',
    where: { company: 'C-FHS', employee: 'E01', view: 'review' },
    expect: 'Lancaster City Tax (Law ID 4120) is Intuit-defined, so no guessing is needed.',
    check: (x) => { const c = x.find('C-FHS', 'John Carter', 'Lancaster City Tax'); return ok(/Desktop tax item/.test(c.evidence[0].text) && c.route === 'local_tax', c.evidence[0].text); },
  },
  {
    id: 'state-conflict', group: 'state', title: 'The label names a state the employee has no address in',
    where: { company: 'C-HHF', employee: 'E10', view: 'expert' },
    expect: '"PA EIT" on an Ohio worker goes to an expert instead of being guessed.',
    check: (x) => { const c = x.find('C-HHF', 'Chloe Adams', 'PA EIT'); return ok(c.route === 'not_in_database' && c.reason === 'state_conflict', c.reasonText); },
  },

  // ---------- Step 2 ----------
  {
    id: 'expected-basis', group: 'expected', title: 'School tax follows home; city tax follows work',
    where: { company: 'C-FHS', employee: 'E01', view: 'analysis' },
    expect: 'John Carter: Lancaster CSD from his home, Lancaster city tax from his work site.',
    check: (x) => {
      const l = x.emp('C-FHS', 'John Carter').expected.list;
      const sd = l.find((e) => e.tax_id === 'OH-SD-2305');
      const city = l.find((e) => e.tax_id === 'OH-CITY-LANCASTER');
      return ok(sd?.basis === 'home' && city?.basis === 'work' && sd.required && city.required, l.map((e) => `${e.tax.name} (${e.basis})`).join(', '));
    },
  },
  {
    id: 'expected-no-tax-district', group: 'expected', title: 'A school district with no income tax',
    where: { company: 'C-FHS', employee: 'E03', view: 'review' },
    expect: 'Columbus City Schools levies none, so Mike Brown has no school tax on his list.',
    check: (x) => { const e = x.emp('C-FHS', 'Mike Brown').expected; return ok(!e.list.some((t) => t.tax.type === 'school_district') && e.notes.some((n) => /Columbus City School District has no/.test(n.text)), e.notes.map((n) => n.text).join(' ')); },
  },
  {
    id: 'expected-courtesy', group: 'expected', title: 'Home-city tax is optional courtesy withholding',
    where: { company: 'C-FHS', employee: 'E03', view: 'review' },
    expect: 'Columbus (home) is listed as optional; Lancaster (work) is required.',
    check: (x) => { const l = x.emp('C-FHS', 'Mike Brown').expected.list; const col = l.find((t) => t.tax_id === 'OH-CITY-COLUMBUS'); return ok(col && !col.required && l.find((t) => t.tax_id === 'OH-CITY-LANCASTER')?.required, col ? 'Columbus optional, Lancaster required' : 'Columbus not listed'); },
  },
  {
    id: 'expected-move-split', group: 'expected', title: 'A move between two taxed districts splits the year',
    where: { company: 'C-FHS', employee: 'E06', view: 'review' },
    expect: 'Ana Gomez: Bloom-Carroll Jan to May, Lancaster from June.',
    check: (x) => { const c = x.find('C-FHS', 'Ana Gomez', 'School Tax'); return ok(same(c.proposal.map((p) => [p.tax_id, p.months]), [['OH-SD-2303', range(1, 5)], ['OH-SD-2305', range(6, 12)]]), c.proposal.map((p) => `${p.tax.name} ${monthSpan(p.months)}`).join('; ')); },
  },
  {
    id: 'expected-move-at-migration', group: 'expected', title: 'A move in the migration month',
    where: { company: 'C-HHF', employee: 'E03', view: 'review' },
    expect: 'Noah Diaz: Desktop history stays with Lancaster; Online starts Pickerington in October. Still verified.',
    check: (x) => {
      const c = x.eff('C-HHF', 'Noah Diaz', 'School Tax');
      const [old, now] = c.proposal;
      return ok(old.tax_id === 'OH-SD-2305' && same(old.months, range(1, 9)) && now.tax_id === 'OH-SD-2307' && same(now.months, [10, 11, 12]) && now.rate.status === 'no_history' && c.verified, c.proposal.map((p) => `${p.tax.name} ${monthSpan(p.months)} (${RATE_WORD[p.rate.status]})`).join('; '));
    },
  },
  {
    id: 'expected-remote', group: 'expected', title: 'Remote worker: city tax follows the home',
    where: { company: 'C-HHF', employee: 'E08', view: 'review' },
    expect: 'Mia Young works from Columbus, so Columbus city tax is required and Lancaster is not.',
    check: (x) => { const l = x.emp('C-HHF', 'Mia Young').expected.list; const col = l.find((t) => t.tax_id === 'OH-CITY-COLUMBUS'); return ok(col?.required && !l.some((t) => t.tax_id === 'OH-CITY-LANCASTER'), l.map((t) => `${t.tax.name}${t.required ? '' : ' (optional)'}`).join(', ')); },
  },
  {
    id: 'expected-home-other-state', group: 'expected', title: 'Lives in a state that is not switched on',
    where: { company: 'C-HHF', employee: 'E14', view: 'review' },
    expect: 'Ella Price lives in Pennsylvania and works in Lancaster: only the Lancaster city tax is listed.',
    check: (x) => { const e = x.emp('C-HHF', 'Ella Price').expected; return ok(same(e.list.map((t) => t.tax_id), ['OH-CITY-LANCASTER']) && e.notes.some((n) => /Pennsylvania/.test(n.text)), e.notes.map((n) => n.text).join(' ')); },
  },
  {
    id: 'expected-no-address', group: 'expected', title: 'No home address on file',
    where: { company: 'C-HHF', employee: 'E16', view: 'expert' },
    expect: 'Isaac Long\'s school tax cannot be placed without an address, so it goes to an expert.',
    check: (x) => { const c = x.find('C-HHF', 'Isaac Long', 'School Tax'); return ok(c.route === 'not_in_database' && c.reason === 'no_address', c.reasonText); },
  },
  {
    id: 'expected-unresolved', group: 'expected', title: 'The address lookup cannot place the address',
    where: { company: 'C-HHF', employee: 'E11', view: 'expert' },
    expect: 'A new build not in the boundary files: the school tax waits for a person.',
    check: (x) => { const c = x.find('C-HHF', 'Ryan Scott', 'School Tax'); return ok(c.route === 'not_in_database' && c.reason === 'address_unresolved', c.reasonText); },
  },

  // ---------- Step 3 ----------
  {
    id: 'model-abbreviation', group: 'model', title: 'Abbreviations land in the right cluster',
    where: { company: 'C-KSF', employee: 'E01', view: 'review' },
    expect: '"Schl Dist W/H" is recognised as a school-district tax with high confidence.',
    check: (x) => { const c = x.find('C-KSF', 'Grace Kim', 'Schl Dist W/H'); return ok(c.model.key === 'school_district' && c.model.confidence === 'high', `${c.model.entry_label}, label silhouette ${c.model.item_silhouette.toFixed(2)}`); },
  },
  {
    id: 'model-new-label', group: 'model', title: 'A label the model was never trained on',
    where: { company: 'C-HVD', employee: 'E02', view: 'model' },
    expect: '"School District Tax" is not in the labelled pool; it joins the nearest cluster.',
    check: (x) => { const c = x.find('C-HVD', 'Luis Ortega', 'School District Tax'); return ok(!c.model.in_pool && c.model.key === 'school_district' && c.model.confidence === 'high', `${c.model.entry_label}, label silhouette ${c.model.item_silhouette.toFixed(2)}`); },
  },
  {
    id: 'model-vague', group: 'model', title: 'A vague label stays unnamed',
    where: { company: 'C-FHS', employee: 'E05', view: 'expert' },
    expect: '"Local Tax" names no kind of tax, so an expert decides.',
    check: (x) => { const c = x.find('C-FHS', 'Tom Reed', 'Local Tax'); return ok(c.reason === 'weak_signal' && !c.model.entry, c.reasonText); },
  },
  {
    id: 'model-empty', group: 'model', title: 'Nothing left after removing the place name',
    where: { company: 'C-HHF', employee: 'E15', view: 'expert' },
    expect: 'An item called just "Lancaster" has no words to compare, so an expert decides.',
    check: (x) => { const c = x.find('C-HHF', 'Henry Ward', 'Lancaster'); return ok(c.reason === 'weak_signal' && c.model.empty, c.evidence.find((e) => e.step === 3)?.text); },
  },
  {
    id: 'model-shadow-rollout', group: 'model', title: 'State not switched on: shadow mode',
    where: { company: 'C-KSF', employee: 'E02', view: 'model' },
    expect: 'Pennsylvania suggestions are logged but hidden; a person decides every custom line.',
    check: (x) => { const a = x.analyse('C-KSF'); const c = x.find('C-KSF', 'Marcus Bell', 'PA Local EIT'); return ok(a.models.PA.mode === 'shadow' && !a.models.PA.gates.rollout && c.reason === 'shadow' && c.model && !c.model.shown, `Logged: ${c.model?.entry_label ?? 'none'}; shown: no`); },
  },
  {
    id: 'gate-silhouette', group: 'model', title: 'Silhouette exactly at the 0.50 floor',
    where: { company: 'C-FHS', view: 'model' },
    expect: '0.50 passes; 0.4999 fails.',
    check: () => { const g = (s) => evaluateGates({ rollout: true, silhouette: s, precision: 1, sample: 100 }).silhouette; return ok(g(0.5) && !g(0.4999), `0.50: ${g(0.5) ? 'pass' : 'fail'}, 0.4999: ${g(0.4999) ? 'pass' : 'fail'}`); },
  },
  {
    id: 'gate-precision', group: 'model', title: 'Precision exactly at the 98% target',
    where: { company: 'C-FHS', view: 'model' },
    expect: '98% passes; 97.99% fails.',
    check: () => { const g = (p) => evaluateGates({ rollout: true, silhouette: 1, precision: p, sample: 100 }).precision; return ok(g(0.98) && g(49 / 50) && !g(0.9799), `49 of 50 (98%): ${g(49 / 50) ? 'pass' : 'fail'}, 97.99%: ${g(0.9799) ? 'pass' : 'fail'}`); },
  },
  {
    id: 'gate-sample', group: 'model', title: 'Sample size exactly at the minimum',
    where: { company: 'C-FHS', view: 'model' },
    expect: '40 labelled labels pass; 39 fail.',
    check: () => { const g = (n) => evaluateGates({ rollout: true, silhouette: 1, precision: 1, sample: n }).sample; return ok(g(40) && !g(39), `40: ${g(40) ? 'pass' : 'fail'}, 39: ${g(39) ? 'pass' : 'fail'}`); },
  },
  {
    id: 'gate-item-floor', group: 'model', title: 'A label exactly at the 0.25 confidence floor',
    where: { company: 'C-FHS', view: 'model' },
    expect: 'A label whose silhouette equals the floor is high confidence; a hair above the label is not.',
    check: (x) => {
      const s = x.find('C-FHS', 'John Carter', 'School Tax').model.item_silhouette;
      const at = x.find('C-FHS', 'John Carter', 'School Tax', { thresholds: { itemFloor: s } }).model.confidence;
      const above = x.find('C-FHS', 'John Carter', 'School Tax', { thresholds: { itemFloor: s + 1e-9 } }).model.confidence;
      return ok(at === 'high' && above === 'low', `Floor set to ${s.toFixed(4)}: ${at} confidence; just above: ${above}`);
    },
  },
  {
    id: 'gate-flip', group: 'model', title: 'One gate failing switches the whole state to shadow',
    where: { company: 'C-FHS', view: 'model' },
    expect: 'Set the floor to Ohio\'s measured silhouette: suggestions stay on. Raise it by 0.001: shadow mode.',
    check: (x) => {
      const s = x.analyse('C-FHS').models.OH.silhouette;
      const at = x.analyse('C-FHS', { thresholds: { silhouetteFloor: s } }).models.OH.mode;
      const above = x.analyse('C-FHS', { thresholds: { silhouetteFloor: s + 0.001 } });
      const c = above.cases.find((y) => y.employee_name === 'John Carter' && y.item.label === 'School Tax');
      return ok(at === 'assisted' && above.models.OH.mode === 'shadow' && c.reason === 'shadow', `Floor ${s.toFixed(3)}: suggestions on; floor ${(s + 0.001).toFixed(3)}: shadow mode`);
    },
  },
  {
    id: 'gate-force-shadow', group: 'model', title: 'Shadow mode forced by governance',
    where: { company: 'C-FHS', view: 'model' },
    expect: 'Custom lines go to people; Intuit-defined items and after-tax deductions still route.',
    check: (x) => {
      const s = { forceShadow: { OH: true } };
      const school = x.find('C-FHS', 'John Carter', 'School Tax', s);
      const city = x.find('C-FHS', 'John Carter', 'Lancaster City Tax', s);
      const dues = x.find('C-FHS', 'Sara Lee', 'Union Dues', s);
      return ok(school.reason === 'shadow' && city.route === 'local_tax' && dues.route === 'not_a_tax', `School Tax: ${ROUTE_WORD[school.route]}; Lancaster City Tax: ${ROUTE_WORD[city.route]}; Union Dues: ${ROUTE_WORD[dues.route]}`);
    },
  },

  // ---------- Step 4 ----------
  {
    id: 'route-verified', group: 'route', title: 'Exact match at the right rate',
    where: { company: 'C-FHS', employee: 'E01', view: 'review' },
    expect: 'On the expected list, rate equal: verified and safe to confirm in bulk.',
    check: (x) => { const c = x.eff('C-FHS', 'John Carter', 'School Tax'); return ok(c.route === 'local_tax' && c.verified, `${c.proposal[0].tax.name}, ${RATE_WORD[c.proposal[0].rate.status]}, verified`); },
  },
  {
    id: 'route-same-item', group: 'route', title: 'One Desktop item, a different district for each person',
    where: { company: 'C-FHS', view: 'review' },
    expect: '"School Tax" becomes Lancaster for John Carter and Pickerington for Priya Shah.',
    check: (x) => { const j = x.find('C-FHS', 'John Carter', 'School Tax'); const p = x.find('C-FHS', 'Priya Shah', 'School Tax'); return ok(j.proposal[0].tax_id === 'OH-SD-2305' && p.proposal[0].tax_id === 'OH-SD-2307', `John: ${j.proposal[0].tax.name}; Priya: ${p.proposal[0].tax.name}`); },
  },
  {
    id: 'route-over', group: 'route', title: 'Over-withheld: Desktop rate too high',
    where: { company: 'C-FHS', employee: 'E02', view: 'review' },
    expect: 'Priya Shah: 1.5% in Desktop, 1.0% official, $207 too much.',
    check: (x) => { const r = x.find('C-FHS', 'Priya Shah', 'School Tax').proposal[0].rate; return ok(r.status === 'over' && r.difference === 207, `Over-withheld by ${usd(r.difference)}`); },
  },
  {
    id: 'route-under', group: 'route', title: 'Under-withheld: Desktop rate too low',
    where: { company: 'C-HHF', employee: 'E01', view: 'review' },
    expect: 'Ethan Moore: 1.5% in Desktop, 2.0% official in Bremen, $189 too little.',
    check: (x) => { const c = x.eff('C-HHF', 'Ethan Moore', 'School Tax'); const r = c.proposal[0].rate; return ok(r.status === 'under' && r.difference === -189 && !c.verified, `Under-withheld by ${usd(Math.abs(r.difference))}`); },
  },
  {
    id: 'route-tolerance', group: 'route', title: 'Rate comparison at the boundary',
    where: { company: 'C-FHS', view: 'review' },
    expect: '1.5% vs 1.5% is a match; 1.4999% vs 1.5% is under-withheld.',
    check: () => {
      const tax = { rate: 1.5 };
      const r = (rate) => rateCheck({ calc: { kind: 'percent', rate } }, tax, [1, 2, 3], 4000).status;
      return ok(r(1.5) === 'match' && r(1.4999) === 'under' && r(1.5001) === 'over', `1.5%: ${RATE_WORD[r(1.5)]}; 1.4999%: ${RATE_WORD[r(1.4999)]}; 1.5001%: ${RATE_WORD[r(1.5001)]}`);
    },
  },
  {
    id: 'route-after-tax', group: 'route', title: 'After-tax deduction in Desktop',
    where: { company: 'C-FHS', employee: 'E04', view: 'review' },
    expect: 'Union dues move to deductions and are never filed as a tax.',
    check: (x) => { const c = x.find('C-FHS', 'Sara Lee', 'Union Dues'); return ok(c.route === 'not_a_tax', c.reasonText); },
  },
  {
    id: 'route-conflict-garnish', group: 'route', title: 'Desktop says tax, the label says garnishment',
    where: { company: 'C-FHS', employee: 'E08', view: 'expert' },
    expect: 'The evidence disagrees, so an expert decides.',
    check: (x) => { const c = x.find('C-FHS', "Kevin O'Neil", 'Wage Garnishment'); return ok(c.reason === 'conflict', c.evidence.find((e) => e.step === 4)?.text); },
  },
  {
    id: 'route-conflict-deduction', group: 'route', title: 'Desktop says deduction, the label says school tax',
    where: { company: 'C-HHF', employee: 'E09', view: 'expert' },
    expect: 'Jacob King\'s "SD Tax" was set up as an after-tax deduction: an expert decides.',
    check: (x) => { const c = x.find('C-HHF', 'Jacob King', 'SD Tax'); return ok(c.reason === 'conflict', c.evidence.find((e) => e.step === 4)?.text); },
  },
  {
    id: 'route-not-expected', group: 'route', title: 'Withheld, but not owed at this address',
    where: { company: 'C-FHS', employee: 'E03', view: 'expert' },
    expect: 'Mike Brown paid a school tax that Columbus City Schools does not levy.',
    check: (x) => { const c = x.find('C-FHS', 'Mike Brown', 'School Tax'); return ok(c.reason === 'not_expected', c.evidence.find((e) => e.step === 4)?.text); },
  },
  {
    id: 'route-wrong-city', group: 'route', title: 'An Intuit-defined item for the wrong city',
    where: { company: 'C-HHF', employee: 'E08', view: 'expert' },
    expect: 'Mia Young works from home in Columbus, so her Lancaster city item is not expected.',
    check: (x) => { const c = x.find('C-HHF', 'Mia Young', 'Lancaster City Tax'); return ok(c.route === 'not_in_database' && c.reason === 'not_expected', c.evidence.find((e) => e.step === 4)?.text); },
  },
  {
    id: 'route-duplicate', group: 'route', title: 'The same tax withheld twice',
    where: { company: 'C-HHF', employee: 'E05', view: 'expert' },
    expect: 'Liam Turner has "School Tax" and "School Dist Tax": one stays, the other goes to an expert.',
    check: (x) => { const keep = x.find('C-HHF', 'Liam Turner', 'School Tax'); const dup = x.find('C-HHF', 'Liam Turner', 'School Dist Tax'); return ok(keep.route === 'local_tax' && dup.reason === 'duplicate' && dup.duplicateOf === keep.case_id, dup.evidence.find((e) => /Duplicate/.test(e.text))?.text); },
  },
  {
    id: 'route-place-mismatch', group: 'route', title: 'The label names a different place than the address',
    where: { company: 'C-HHF', employee: 'E06', view: 'review' },
    expect: '"Pickerington SD" for a Lancaster resident: the address wins, flagged, not bulk-confirmable.',
    check: (x) => { const c = x.eff('C-HHF', 'Ava Martin', 'Pickerington SD'); return ok(c.proposal[0]?.tax_id === 'OH-SD-2305' && c.flags.includes('label_place_mismatch') && !c.verified, c.evidence.find((e) => /names Pickerington/.test(e.text))?.text); },
  },
  {
    id: 'route-optional', group: 'route', title: 'Only the optional courtesy tax fits',
    where: { company: 'C-HHF', employee: 'E07', view: 'review' },
    expect: 'Lucas Hall\'s "Columbus City Tax" matches optional home-city withholding; the employer decides.',
    check: (x) => { const c = x.eff('C-HHF', 'Lucas Hall', 'Columbus City Tax'); return ok(c.proposal[0]?.tax_id === 'OH-CITY-COLUMBUS' && c.proposal[0].optional && !c.verified, `${c.proposal[0]?.tax.name}, optional, not verified`); },
  },
  {
    id: 'route-unowed', group: 'route', title: 'Moved out of the district; Desktop kept withholding',
    where: { company: 'C-HHF', employee: 'E02', view: 'review' },
    expect: 'Olivia Grant moved to Columbus in July: Jul to Sep ($171) was not owed and needs a correction.',
    check: (x) => { const c = x.eff('C-HHF', 'Olivia Grant', 'School Tax'); return ok(same(c.proposal[0].months, range(1, 6)) && c.unowed?.amount === 171 && same(c.unowed.months, [7, 8, 9]) && !c.verified, `Relabel ${monthSpan(c.proposal[0].months)}; not owed ${monthSpan(c.unowed?.months ?? [])}: ${usd(c.unowed?.amount ?? 0)}`); },
  },
  {
    id: 'route-one-each', group: 'route', title: 'Every Desktop line ends in exactly one route',
    where: { company: 'C-FHS', view: 'analysis' },
    expect: 'Local tax, not a tax, or not in database, for every company. Missing or repeated item references are reported, not counted.',
    check: (x) => {
      let n = 0;
      let lines = 0;
      for (const co of x.data.companies) {
        const a = x.analyse(co.company_id);
        const known = new Set(co.items.map((i) => i.item_id));
        lines += co.employees.reduce((s, e) => s + new Set(e.items.filter((id) => known.has(id))).size, 0);
        n += a.cases.filter((c) => ['local_tax', 'not_a_tax', 'not_in_database'].includes(c.route)).length;
      }
      return ok(n === lines, `${n} of ${lines} lines routed`);
    },
  },

  // ---------- Gaps ----------
  {
    id: 'gap-basic', group: 'gaps', title: 'An expected tax nobody withheld',
    where: { company: 'C-FHS', employee: 'E07', view: 'review' },
    expect: 'Raj Patel lives in Teays Valley but has no school tax item: about $648 back tax.',
    check: (x) => { const g = x.gap('C-FHS', 'Raj Patel', 'OH-SD-6503'); return ok(g?.backTaxEstimate === 648, g ? `${g.tax.name}, back tax ${usd(g.backTaxEstimate)}` : 'No gap found'); },
  },
  {
    id: 'gap-partial', group: 'gaps', title: 'A gap for part of the year after a move',
    where: { company: 'C-HHF', employee: 'E04', view: 'review' },
    expect: 'Emma Wilson moved from Columbus to Lancaster in June: Lancaster school tax from June, $216 back tax.',
    check: (x) => { const g = x.gap('C-HHF', 'Emma Wilson', 'OH-SD-2305'); return ok(g && same(g.months, range(6, 12)) && g.backTaxEstimate === 216, g ? `${monthSpan(g.months)}, back tax ${usd(g.backTaxEstimate)}` : 'No gap found'); },
  },
  {
    id: 'gap-remote', group: 'gaps', title: 'A remote worker\'s home-city tax',
    where: { company: 'C-HHF', employee: 'E08', view: 'review' },
    expect: 'Mia Young owes Columbus city tax that Desktop never withheld.',
    check: (x) => { const g = x.gap('C-HHF', 'Mia Young', 'OH-CITY-COLUMBUS'); return ok(g?.backTaxEstimate === 1170, g ? `${g.tax.name}, back tax ${usd(g.backTaxEstimate)}` : 'No gap found'); },
  },
  {
    id: 'gap-covered', group: 'gaps', title: 'A gap closes when an expert maps the conflicting line',
    where: { company: 'C-HHF', employee: 'E09', view: 'expert' },
    expect: 'Mapping Jacob King\'s "SD Tax" to Lancaster CSD covers his school-tax gap; no double withholding.',
    check: (x) => {
      const a = x.analyse('C-HHF');
      const d = x.decide(a, emptyDecisions(), [['Jacob King', 'SD Tax', { expert: { action: 'map', tax_id: 'OH-SD-2305' } }]]);
      const g = x.gap('C-HHF', 'Jacob King', 'OH-SD-2305');
      const r = readiness(a, d);
      return ok(gapStage(g, d, a) === 'covered' && !r.openGaps.some((o) => o.gap_id === g.gap_id), gapStage(g, d, a) === 'covered' ? 'Covered by the expert\'s mapping' : 'Still open');
    },
  },

  // ---------- Step 5 ----------
  {
    id: 'people-employer-required', group: 'people', title: 'Nothing goes live without the employer',
    where: { company: 'C-FHS', employee: 'E05', view: 'review' },
    expect: 'Even after an expert maps a line, it waits for the employer.',
    check: (x) => {
      const a = x.analyse('C-FHS');
      const d = x.decide(a, emptyDecisions(), [['Tom Reed', 'Local Tax', { expert: { action: 'map', tax_id: 'OH-SD-2305' } }]]);
      const c = effectiveAll(a, d).find((y) => y.employee_name === 'Tom Reed' && y.item.label === 'Local Tax');
      return ok(c.stage === 'awaiting_employer' && liveTaxes(a, d).length === 0, `${STAGE_LABEL[c.stage]}; taxes live: ${liveTaxes(a, d).length}`);
    },
  },
  {
    id: 'people-send-to-expert', group: 'people', title: 'The employer disagrees with a suggestion',
    where: { company: 'C-FHS', employee: 'E01', view: 'review' },
    expect: '"Send to expert" moves even a verified match to the expert queue; the expert\'s answer comes back to the employer.',
    check: (x) => {
      const a = x.analyse('C-FHS');
      const d = x.decide(a, emptyDecisions(), [['John Carter', 'School Tax', { sentToExpert: { note: 'Moved last month' } }]]);
      const sent = effectiveAll(a, d).find((y) => y.employee_name === 'John Carter' && y.item.label === 'School Tax');
      x.decide(a, d, [['John Carter', 'School Tax', { expert: { action: 'map', tax_id: 'OH-SD-2305' } }]]);
      const back = effectiveAll(a, d).find((y) => y.employee_name === 'John Carter' && y.item.label === 'School Tax');
      return ok(sent.stage === 'with_expert' && !sent.verified && back.stage === 'awaiting_employer', `After sending: ${stage(sent.stage)}; after the expert: ${stage(back.stage)}`);
    },
  },
  {
    id: 'people-custom-entry', group: 'people', title: 'An expert creates a structured custom entry',
    where: { company: 'C-KSF', employee: 'E02', view: 'expert' },
    expect: 'York LST becomes an employer-managed tax that QuickBooks never pays.',
    check: (x) => {
      const a = x.analyse('C-KSF');
      const d = x.decide(a, emptyDecisions(), [['Marcus Bell', 'LST', { expert: { action: 'custom_entry', entry: { name: 'York LST', agency: 'York Adams Tax Bureau', type: 'Local services tax', basis: 'work', frequency: 'Quarterly', flat: 52 } }, employer: { action: 'custom_entry' } }]]);
      const row = reconcile(a, d).rows.find((r) => r.name === 'York LST');
      return ok(row?.payer === 'You pay and file (employer-managed)' && row.quarter === 13, row ? `${row.payer}, ${usd(row.quarter)} a quarter` : 'Not in reconciliation');
    },
  },
  {
    id: 'people-stop', group: 'people', title: 'An expert stops a line that is not owed',
    where: { company: 'C-FHS', employee: 'E03', view: 'expert' },
    expect: 'Mike Brown\'s school tax stops, and the Desktop amount is flagged for a correction.',
    check: (x) => {
      const a = x.analyse('C-FHS');
      const d = x.decide(a, emptyDecisions(), [['Mike Brown', 'School Tax', { expert: { action: 'stop', note: 'No tax' }, employer: { action: 'stop' } }]]);
      const f = reconcile(a, d).flags.find((y) => /Mike Brown: .* needs a correction/.test(y.text));
      return ok(Boolean(f), f?.text ?? 'No correction flag');
    },
  },

  // ---------- Go live ----------
  {
    id: 'golive-pass', group: 'golive', title: 'All four checks pass after the demo flow',
    where: { company: 'C-FHS', view: 'golive' },
    expect: 'Every line decided, gaps handled, every dollar placed, every agency account on file.',
    check: (x) => { const a = x.analyse('C-FHS'); const r = readiness(a, fhsDemoDecisions(a)); return ok(r.ready, `${r.checks.filter((c) => c.pass).length} of ${r.checks.length} checks pass`); },
  },
  {
    id: 'golive-account', group: 'golive', title: 'A missing agency account number blocks go-live',
    where: { company: 'C-HVD', view: 'golive' },
    expect: 'Hocking Valley Dental cannot go live until the Lancaster account number is entered.',
    check: (x) => {
      const a = x.analyse('C-HVD');
      const d = emptyDecisions();
      for (const c of effectiveAll(a, d)) d.cases[c.case_id] = { employer: { action: c.route } };
      const before = readiness(a, d).ready;
      d.accounts['City of Lancaster Income Tax Department'] = { account: 'LAN-778812', frequency: 'Quarterly' };
      return ok(!before && readiness(a, d).ready, `Without the account: ${before ? 'ready' : 'blocked'}; with it: ${readiness(a, d).ready ? 'ready' : 'blocked'}`);
    },
  },
  {
    id: 'golive-tie-out', group: 'golive', title: 'Every Desktop tax dollar has a destination',
    where: { company: 'C-FHS', view: 'golive' },
    expect: 'After the demo flow, nothing is left waiting.',
    check: (x) => { const a = x.analyse('C-FHS'); const t = dollarTieOut(a, fhsDemoDecisions(a)); return ok(t.waiting === 0 && t.accounted === t.total, `${usd(t.accounted)} of ${usd(t.total)}`); },
  },
  {
    id: 'golive-tie-unowed', group: 'golive', title: 'Not-owed months go to corrections, not to the tax',
    where: { company: 'C-HHF', employee: 'E02', view: 'golive' },
    expect: 'Olivia Grant\'s $171 after her move goes to "correction needed".',
    check: (x) => {
      const a = x.analyse('C-HHF');
      const d = x.decide(a, emptyDecisions(), [['Olivia Grant', 'School Tax', { employer: { action: 'local_tax' } }]]);
      const stopped = dollarTieOut(a, d).rows.find((r) => r.stage === 'stopped');
      return ok(stopped?.amount === 171, `Correction needed: ${usd(stopped?.amount ?? 0)}`);
    },
  },

  // ---------- W-2 ----------
  {
    id: 'history-relabel', group: 'history', title: 'Desktop history is relabelled, not recalculated',
    where: { company: 'C-FHS', employee: 'E01', view: 'golive' },
    expect: 'John Carter\'s box 19: $526.50 from Desktop plus $175.50 from Online.',
    check: (x) => { const a = x.analyse('C-FHS'); const l = w2Preview(a, fhsDemoDecisions(a)).find((w) => w.employee.name === 'John Carter').lines.find((y) => y.key === 'OH-SD-2305'); return ok(l.desktop === 526.5 && l.cloud === 175.5 && l.total === 702, `Desktop ${usd(l.desktop)} + Online ${usd(l.cloud)} = ${usd(l.total)}`); },
  },
  {
    id: 'history-split', group: 'history', title: 'A move gives two W-2 school-district lines',
    where: { company: 'C-FHS', employee: 'E06', view: 'golive' },
    expect: 'Ana Gomez gets Bloom-Carroll and Lancaster lines.',
    check: (x) => { const a = x.analyse('C-FHS'); const w = w2Preview(a, fhsDemoDecisions(a)).find((y) => y.employee.name === 'Ana Gomez'); return ok(w.lines.some((l) => l.key === 'OH-SD-2303') && w.lines.some((l) => l.key === 'OH-SD-2305'), w.lines.map((l) => l.box20).join('; ')); },
  },
  {
    id: 'history-off-rate', group: 'history', title: 'Wrong-rate history is shown as actually withheld',
    where: { company: 'C-FHS', employee: 'E02', view: 'golive' },
    expect: 'Priya Shah\'s W-2 keeps the $621 Desktop really took, with a note about the $207.',
    check: (x) => { const a = x.analyse('C-FHS'); const w = w2Preview(a, fhsDemoDecisions(a)).find((y) => y.employee.name === 'Priya Shah'); const l = w.lines.find((y) => y.key === 'OH-SD-2307'); return ok(l.desktop === 621 && w.notes.some((n) => /over by \$207/.test(n)), `Desktop part ${usd(l.desktop)}`); },
  },

  // ---------- Reconcile ----------
  {
    id: 'reconcile-premium', group: 'reconcile', title: 'Premium or Elite: QuickBooks pays and files',
    where: { company: 'C-FHS', view: 'reconcile' },
    expect: 'Supported taxes are paid and filed by QuickBooks.',
    check: (x) => { const a = x.analyse('C-FHS'); const r = reconcile(a, fhsDemoDecisions(a)); return ok(r.rows.length && r.rows.every((y) => y.payer === 'QuickBooks pays and files'), `${r.rows.length} taxes, QuickBooks pays and files`); },
  },
  {
    id: 'reconcile-core', group: 'reconcile', title: 'Core plan: the employer pays and files',
    where: { company: 'C-HVD', view: 'reconcile' },
    expect: 'Same taxes, but the employer files them.',
    check: (x) => {
      const a = x.analyse('C-HVD');
      const d = emptyDecisions();
      for (const c of effectiveAll(a, d)) d.cases[c.case_id] = { employer: { action: c.route } };
      const r = reconcile(a, d);
      return ok(r.rows.length && r.rows.every((y) => y.payer === 'You pay and file'), `${r.rows.length} taxes, you pay and file`);
    },
  },
  {
    id: 'reconcile-missing', group: 'reconcile', title: 'A skipped expected tax shows up as a red flag',
    where: { company: 'C-FHS', view: 'reconcile' },
    expect: 'If Raj Patel\'s Teays Valley tax is not added, reconciliation catches it.',
    check: (x) => { const a = x.analyse('C-FHS'); const d = fhsDemoDecisions(a); d.gaps = {}; const f = reconcile(a, d).flags.find((y) => y.tone === 'fail'); return ok(f && /Raj Patel: Teays Valley/.test(f.text), f?.text ?? 'No red flag'); },
  },

  // ---------- Timing ----------
  {
    id: 'timing-hired', group: 'timing', title: 'Joined mid-year',
    where: { company: 'C-HHF', employee: 'E12', view: 'review' },
    expect: 'Zoe Clark joined in April: Desktop history is Apr to Sep, W-2 wages start in April.',
    check: (x) => {
      const a = x.analyse('C-HHF');
      const c = a.cases.find((y) => y.employee_name === 'Zoe Clark' && y.item.label === 'School Tax');
      const d = x.decide(a, emptyDecisions(), [['Zoe Clark', 'School Tax', { employer: { action: 'local_tax' } }]]);
      const l = w2Preview(a, d).find((w) => w.employee.name === 'Zoe Clark').lines[0];
      return ok(same(c.ytdByMonth.map((y) => y.month), range(4, 9)) && l.wages === 3400 * 9, `Desktop ${monthSpan(c.ytdByMonth.map((y) => y.month))}; W-2 wages ${usd(l.wages)}`);
    },
  },
  {
    id: 'timing-left', group: 'timing', title: 'Left before the move',
    where: { company: 'C-HHF', employee: 'E13', view: 'golive' },
    expect: 'Owen Baker left in June: no Online taxes, but his history is still relabelled for the W-2.',
    check: (x) => {
      const a = x.analyse('C-HHF');
      const d = x.decide(a, emptyDecisions(), [['Owen Baker', 'School Tax', { employer: { action: 'local_tax' } }], ['Owen Baker', 'Lancaster City Tax', { employer: { action: 'local_tax' } }]]);
      const live = liveTaxes(a, d).filter((t) => t.employee.name === 'Owen Baker');
      const w = w2Preview(a, d).find((y) => y.employee.name === 'Owen Baker');
      return ok(live.length === 0 && w.lines.length === 2 && w.lines.every((l) => l.cloud === 0 && l.desktop > 0), `Online taxes: ${live.length}; W-2 lines: ${w.lines.map((l) => `${l.box20} ${usd(l.desktop)}`).join(', ')}`);
    },
  },
  {
    id: 'timing-january', group: 'timing', title: 'The company moves in January',
    where: { company: 'C-LVB', view: 'review' },
    expect: 'No Desktop history to relabel or compare; a gap has no back tax.',
    check: (x) => {
      const c = x.eff('C-LVB', 'Sofia Reyes', 'School Tax');
      const g = x.gap('C-LVB', 'Daniel Cho', 'OH-SD-2307');
      return ok(c.ytd === 0 && c.proposal[0].rate.status === 'no_history' && c.verified && g?.backTaxEstimate === 0 && g.cloudMonths.length === 12, `Sofia Reyes: ${RATE_WORD[c.proposal[0].rate.status]}; Daniel Cho's gap: back tax ${usd(g?.backTaxEstimate ?? 0)}`);
    },
  },
];

export function runScenarios(data) {
  const ctx = scenarioContext(data);
  return SCENARIOS.map((s) => {
    try {
      const r = s.check(ctx);
      return { ...s, pass: r.pass, detail: r.detail ?? '' };
    } catch (err) {
      return { ...s, pass: false, detail: `The check could not run: ${err.message}` };
    }
  });
}
