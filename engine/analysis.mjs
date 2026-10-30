// The BRD v3 pipeline for one company:
//   1 find the state · 2 list expected taxes · 3 cluster custom items · 4 route every item · (5 employer confirms, see workflow.mjs)
import { clusterLabels, assignLabel, MODEL_VERSION } from './cluster.mjs?v=abe177840a';
import { normalize } from './text.mjs?v=abe177840a';
import { desktopMonths, cloudMonths, employedMonths, itemAmount, monthSpan, range, round2, sum, rateCheck } from './util.mjs?v=abe177840a';

export const DEFAULT_THRESHOLDS = {
  silhouetteFloor: 0.5,   // state-level cluster quality needed before suggestions are shown
  precisionTarget: 0.98,  // precision on high-confidence suggestions, measured in shadow mode
  minSample: 40,          // demo-scale minimum of expert-labelled items; production needs far more
  itemFloor: 0.25,        // an item's own silhouette below this counts as a weak signal
};

const STATE_HINTS = [
  { state: 'OH', pattern: /\b(oh|ohio)\b/i },
  { state: 'PA', pattern: /\b(pa|penn|pennsylvania)\b/i },
];

const TAX_TRACKING = new Set(['Local Income Tax', 'Other']);
const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function indexData({ catalog, geocoder }) {
  const addresses = new Map(geocoder.addresses.map((a) => [a.address_id, a]));
  const taxes = new Map();
  for (const [code, state] of Object.entries(catalog.states)) {
    for (const t of state.taxes) taxes.set(t.tax_id, { ...t, state: code });
  }
  return { catalog, addresses, taxes };
}

// ---------- Data checks: run before anything else ----------
// Errors stop the analysis (nothing sensible can be computed). Warnings are cleaned up and reported.

export class DataError extends Error {
  constructor(issues) {
    super(`The Desktop file cannot be analysed: ${issues.map((i) => i.text).join(' ')}`);
    this.name = 'DataError';
    this.issues = issues;
  }
}

const isMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12;

export function checkCompanyData(company, idx) {
  const errors = [];
  const warnings = [];
  const fail = (text) => errors.push({ tone: 'fail', text });
  const warn = (text) => warnings.push({ tone: 'warn', text });
  if (!isMonth(company.migration_month)) fail(`The migration month must be a whole number from 1 to 12, not ${JSON.stringify(company.migration_month)}.`);

  const sites = new Map();
  for (const s of company.worksites ?? []) {
    if (sites.has(s.site_id)) fail(`Work site ${s.site_id} appears twice.`);
    sites.set(s.site_id, s);
    const a = idx.addresses.get(s.address_id);
    if (!a) fail(`Work site "${s.name ?? s.site_id}" has an address (${s.address_id}) the address lookup does not know, so its state and city tax cannot be found.`);
    else if (!idx.catalog.states[a.state]) warn(`Work site "${s.name ?? s.site_id}" is in ${a.state}, which the tax catalog does not cover yet.`);
  }
  if (!sites.size) fail('The company has no work site, so no state or city tax can be found.');

  const items = new Map();
  for (const i of company.items ?? []) {
    if (items.has(i.item_id)) fail(`Payroll item ${i.item_id} appears twice.`);
    items.set(i.item_id, i);
    const c = i.calc ?? {};
    const validRate = c.kind === 'percent' ? typeof c.rate === 'number' && c.rate >= 0 && c.rate <= 100
      : c.kind === 'flat_annual' ? typeof c.amount === 'number' && c.amount >= 0 : false;
    if (!validRate) fail(`Payroll item "${i.label}" (${i.item_id}) needs a rate from 0% to 100% or a flat yearly amount of $0 or more.`);
    if (i.origin === 'system' && !idx.taxes.has(i.system_tax_id)) fail(`System item "${i.label}" points at tax ${i.system_tax_id}, which is not in the catalog.`);
    if (typeof i.label !== 'string') warn(`Payroll item ${i.item_id} has no name, so it is treated as blank and goes to an expert.`);
  }

  const ids = new Set();
  const unknownAddresses = new Map();
  const employees = [];
  for (const e of company.employees ?? []) {
    const who = e.name || e.employee_id;
    if (ids.has(e.employee_id)) fail(`Employee ${e.employee_id} appears twice.`);
    ids.add(e.employee_id);
    if (!sites.has(e.site_id)) fail(`${who} is assigned to work site ${e.site_id}, which does not exist.`);
    if (typeof e.monthly_wages !== 'number' || !(e.monthly_wages >= 0)) fail(`${who} needs monthly wages of $0 or more.`);
    const hired = e.hired_month ?? 1;
    const left = e.left_month ?? 12;
    if (!isMonth(hired) || !isMonth(left) || hired > left) fail(`${who} has an invalid employment window (joined in month ${hired}, left in month ${left}). Both must be months 1 to 12, and joining comes first.`);
    const starts = new Set();
    const addresses = [];
    for (const a of e.addresses ?? []) {
      if (!isMonth(a.from_month)) { fail(`${who} has a home address starting in month ${JSON.stringify(a.from_month)}; it must be 1 to 12.`); continue; }
      if (starts.has(a.from_month)) fail(`${who} has two home addresses starting in ${monthSpan([a.from_month])}.`);
      starts.add(a.from_month);
      const known = idx.addresses.get(a.address_id);
      if (!known) {
        warn(`${who}: home address ${a.address_id} (from ${monthSpan([a.from_month])}) is not in the address lookup. Lines that depend on it go to an expert.`);
        unknownAddresses.set(a.address_id, { address_id: a.address_id, line1: `Address ${a.address_id}`, city: 'not in the lookup', state: null, zip: '', school_district: null, municipality: null, missing: true });
      } else if (!idx.catalog.states[known.state]) {
        warn(`${who} lives in ${known.state}, which the tax catalog does not cover yet.`);
      }
      addresses.push(a);
    }
    const seen = new Set();
    const itemIds = [];
    for (const id of e.items ?? []) {
      if (!items.has(id)) { warn(`${who} has payroll item ${id}, which is not in the Desktop item list. It is left out.`); continue; }
      if (seen.has(id)) { warn(`${who} has "${items.get(id).label}" listed twice. It is counted once.`); continue; }
      seen.add(id);
      itemIds.push(id);
    }
    employees.push({ ...e, addresses, items: itemIds });
  }
  if (!employees.length) warn('The company has no employees, so there is nothing to migrate.');

  const cleanItems = [...items.values()].map((i) => (typeof i.label === 'string' ? i : { ...i, label: '' }));
  const cleanIdx = unknownAddresses.size ? { ...idx, addresses: new Map([...idx.addresses, ...unknownAddresses]) } : idx;
  return { errors, warnings, company: { ...company, items: cleanItems, employees }, idx: cleanIdx };
}

// ---------- Gates (exact boundaries: a value equal to the threshold passes) ----------

export function evaluateGates({ rollout, silhouette, precision, sample }, thresholds = DEFAULT_THRESHOLDS) {
  return {
    rollout: rollout === true,
    silhouette: silhouette >= thresholds.silhouetteFloor,
    precision: precision >= thresholds.precisionTarget,
    sample: sample >= thresholds.minSample,
  };
}

// ---------- Step 2: expected taxes from addresses ----------

function addressPeriods(employee, employed) {
  const sorted = [...employee.addresses].sort((a, b) => a.from_month - b.from_month);
  return sorted
    .map((a, i) => ({
      address_id: a.address_id,
      months: range(a.from_month, i + 1 < sorted.length ? sorted[i + 1].from_month - 1 : 12).filter((m) => employed.includes(m)),
    }))
    .filter((p) => p.months.length);
}

const findCity = (idx, state, place) =>
  [...idx.taxes.values()].find((t) => t.state === state && t.type === 'municipal' && t.place.toLowerCase() === String(place ?? '').toLowerCase());

export function expectedTaxes(employee, company, idx) {
  const employed = employedMonths(employee);
  const site = company.worksites.find((s) => s.site_id === employee.site_id);
  const work = idx.addresses.get(site.address_id);
  const periods = addressPeriods(employee, employed);
  const remote = Boolean(employee.remote);
  const notes = [];
  const byTax = new Map();
  const unresolvedMonths = [];
  const add = (tax, months, required, basis, address) => {
    const prev = byTax.get(tax.tax_id);
    if (prev) {
      prev.months = [...new Set([...prev.months, ...months])].sort((a, b) => a - b);
      prev.required = prev.required || required;
    } else {
      byTax.set(tax.tax_id, { tax_id: tax.tax_id, tax, months: [...months], required, basis, address });
    }
  };

  if ((employee.hired_month ?? 1) > 1) notes.push({ tone: 'info', text: `Joined in ${monthSpan([employee.hired_month])}, so taxes apply from then.` });
  if ((employee.left_month ?? 12) < 12) {
    const gone = (employee.left_month ?? 12) < company.migration_month;
    notes.push({ tone: 'info', text: `Left after ${monthSpan([employee.left_month])}.${gone ? ' No Online paychecks, but the Desktop history still needs the right labels for the W-2.' : ''}` });
  }

  // Work location. A remote employee works where they live, so the city tax follows the home address.
  const workState = idx.catalog.states[work.state] ?? { name: work.state, rollout: 'not_in_catalog' };
  const workCityFor = (homeAddress) => (remote ? (homeAddress ? findCity(idx, homeAddress.state, homeAddress.municipality) : null) : findCity(idx, work.state, work.municipality));
  if (remote) {
    notes.push({ tone: 'info', text: 'Works from home, so the city tax follows the home address (where the work is done), not the office.' });
  } else if (workState.rollout !== 'enabled') {
    notes.push({ tone: 'info', text: `${workState.name} is not enabled yet, so expected taxes are not listed for this work location.` });
  } else {
    const city = workCityFor(null);
    if (city) add(city, employed, true, 'work', work);
  }

  if (!periods.length) {
    notes.push({ tone: 'warn', text: `No home address came across from Desktop, so home-based taxes (school district${remote ? ', and the city tax for this remote worker' : ', home city'}) cannot be listed. Ask the employee to confirm their address.` });
  }
  for (const p of periods) {
    const home = idx.addresses.get(p.address_id);
    if (home.missing) {
      unresolvedMonths.push(...p.months);
      notes.push({ tone: 'warn', text: `Home address ${p.address_id} is not in the address lookup (${monthSpan(p.months)}). Confirm the address before mapping.` });
      continue;
    }
    const homeState = idx.catalog.states[home.state] ?? { name: home.state, rollout: 'not_in_catalog' };
    if (homeState.rollout !== 'enabled') {
      notes.push({ tone: 'info', text: `Lives in ${homeState.name}, which is not enabled yet, so home-based taxes are not listed (${monthSpan(p.months)}).` });
      continue;
    }
    if (home.school_district === 'UNRESOLVED') {
      unresolvedMonths.push(...p.months);
      notes.push({ tone: 'warn', text: `The address lookup could not place ${home.line1}, ${home.city} in a school district (${monthSpan(p.months)}). Confirm the address before mapping.` });
    } else if (home.school_district && home.school_district.startsWith('NO-TAX')) {
      const nt = homeState.no_tax_districts.find((d) => d.place.toLowerCase() === home.city.toLowerCase());
      notes.push({ tone: 'info', text: `${nt?.name ?? 'This school district'} has no school-district income tax (${monthSpan(p.months)}).` });
    } else if (home.school_district) {
      const sd = [...idx.taxes.values()].find((t) => t.type === 'school_district' && t.code === home.school_district);
      if (sd) add(sd, p.months, true, 'home', home);
    }
    const homeCity = findCity(idx, home.state, home.municipality);
    if (remote) {
      if (homeCity) add(homeCity, p.months, true, 'work', home);
    } else if (homeCity && homeCity !== workCityFor(null)) {
      add(homeCity, p.months, false, 'home', home);
    }
  }
  const covered = new Set(periods.flatMap((p) => p.months));
  return {
    periods,
    work,
    remote,
    employed,
    list: [...byTax.values()],
    notes,
    unresolvedMonths,
    missingMonths: employed.filter((m) => !covered.has(m)),
  };
}

// ---------- Step 1: state ----------

function employeeStates(employee, company, idx) {
  const states = new Set(employee.addresses.map((a) => idx.addresses.get(a.address_id)?.state).filter(Boolean));
  const site = company.worksites.find((s) => s.site_id === employee.site_id);
  states.add(idx.addresses.get(site.address_id).state);
  return states;
}

function detectState(item, employee, company, idx) {
  if (item.origin === 'system' && item.system_tax_id) {
    return { state: idx.taxes.get(item.system_tax_id)?.state ?? null, source: 'Desktop tax item' };
  }
  const hint = STATE_HINTS.find((h) => h.pattern.test(item.label));
  if (hint) return { state: hint.state, source: `label "${item.label}"`, fromLabel: true };
  const first = employee.addresses[0] && idx.addresses.get(employee.addresses[0].address_id);
  if (first && !first.missing) return { state: first.state, source: 'home address' };
  const site = company.worksites.find((s) => s.site_id === employee.site_id);
  return { state: idx.addresses.get(site.address_id).state, source: 'work address' };
}

// States an item may belong to: the label's own hint, else the states of the people it is assigned to.
export function itemStates(item, company, idx) {
  const hint = STATE_HINTS.find((h) => h.pattern.test(item.label));
  if (hint) return new Set([hint.state]);
  const states = new Set();
  for (const e of company.employees.filter((x) => x.items.includes(item.item_id))) {
    const first = e.addresses[0] && idx.addresses.get(e.addresses[0].address_id);
    const site = company.worksites.find((s) => s.site_id === e.site_id);
    states.add(first && !first.missing ? first.state : idx.addresses.get(site.address_id).state);
  }
  return states;
}

// ---------- Step 3: one model per state, fitted on the expert-labelled pool ----------

const keyOf = (entry) => (entry ? (entry.kind === 'tax' ? entry.tax_type : `non_tax:${entry.entry_id}`) : null);

export function runModels(company, idx, pools, settings = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds ?? {}) };
  const models = {};
  for (const [code, state] of Object.entries(idx.catalog.states)) {
    const entries = idx.catalog.defined_entries.filter((e) => e.states.includes(code));
    const pool = pools[code] ?? [];
    const poolLabels = pool.map((p) => p.label);
    // The state model is fitted on the labelled pool only, so its gates do not change from company to company.
    const fitted = clusterLabels(poolLabels, entries, state.place_names);
    const describe = (clusterIndex, itemSil, label, empty = false) => {
      const cluster = clusterIndex >= 0 ? fitted.clusters[clusterIndex] : null;
      const entry = cluster?.entry ?? null;
      const high = Boolean(entry) && itemSil >= thresholds.itemFloor;
      return {
        label,
        cluster_index: cluster?.index ?? null,
        entry,
        kind: entry?.kind ?? null,
        tax_type: entry?.tax_type ?? null,
        key: keyOf(entry),
        item_silhouette: itemSil,
        confidence: high ? 'high' : 'low',
        empty,
        in_pool: poolLabels.includes(label),
      };
    };
    const poolSuggestions = poolLabels.map((l, i) => describe(fitted.assignment[i] ?? -1, fitted.itemScores[i] ?? 0, l));

    // Precision is measured only on the labelled pool, against expert answers the model never sees.
    let high = 0;
    let correct = 0;
    pool.forEach((p, i) => {
      const s = poolSuggestions[i];
      if (s.confidence !== 'high') return;
      high += 1;
      if (s.key === p.expert_label) correct += 1;
    });
    const precision = high ? correct / high : 0;
    const coverage = pool.length ? high / pool.length : 0;
    const gates = evaluateGates({ rollout: state.rollout === 'enabled', silhouette: fitted.silhouette, precision, sample: pool.length }, thresholds);
    const forced = Boolean(settings.forceShadow?.[code]);
    const mode = !forced && Object.values(gates).every(Boolean) ? 'assisted' : 'shadow';

    // This company's custom labels: reuse the pool result when the label is in the pool, otherwise assign it.
    const companyLabels = [...new Set(company.items.filter((i) => i.origin === 'custom' && itemStates(i, company, idx).has(code)).map((i) => i.label))];
    const companySuggestions = new Map();
    for (const label of companyLabels) {
      const at = poolLabels.indexOf(label);
      if (at >= 0) companySuggestions.set(label, poolSuggestions[at]);
      else {
        const a = assignLabel(fitted, label);
        companySuggestions.set(label, describe(a.cluster, a.silhouette, label, a.empty));
      }
    }

    models[code] = {
      state: code,
      name: state.name,
      version: MODEL_VERSION,
      thresholds,
      poolSize: pool.length,
      clusters: fitted.clusters.map((c) => ({
        index: c.index,
        name: c.entry?.label ?? 'Unnamed cluster',
        kind: c.entry?.kind ?? null,
        size: c.size,
        nameSimilarity: c.nameSimilarity,
        meanSilhouette: c.meanSilhouette,
        members: c.members.map((i) => ({ label: poolLabels[i], silhouette: fitted.itemScores[i], fromCompany: companyLabels.includes(poolLabels[i]) })),
        assigned: companyLabels.filter((l) => !poolLabels.includes(l) && companySuggestions.get(l).cluster_index === c.index)
          .map((l) => ({ label: l, silhouette: companySuggestions.get(l).item_silhouette })),
      })),
      unassigned: companyLabels.filter((l) => companySuggestions.get(l).cluster_index === null),
      silhouette: fitted.silhouette,
      k: fitted.k,
      highConfidence: high,
      correct,
      precision,
      coverage,
      gates,
      forced,
      mode,
      suggest: (label) => companySuggestions.get(label) ?? null,
    };
  }
  return models;
}

// ---------- Step 4: route every item ----------

function placeMentioned(label, place) {
  if (!place) return false;
  const words = String(label).toLowerCase().split(/[^a-z]+/);
  return words.includes(place.toLowerCase());
}

const typeWord = (t) => (t === 'school_district' ? 'school-district' : t === 'municipal' ? 'city' : 'local');

export function analyseCompany(rawCompany, data, settings = {}) {
  const checked = checkCompanyData(rawCompany, indexData(data));
  if (checked.errors.length) throw new DataError(checked.errors);
  const { company, idx } = checked;
  const models = runModels(company, idx, data.pools, settings);
  const dMonths = desktopMonths(company);
  const cMonths = cloudMonths(company);
  const items = new Map(company.items.map((i) => [i.item_id, i]));
  const employees = [];
  const cases = [];
  const gaps = [];

  for (const employee of company.employees) {
    const expected = expectedTaxes(employee, company, idx);
    const employed = expected.employed;
    const pastMonths = dMonths.filter((m) => employed.includes(m));
    const employeeCases = [];
    for (const itemId of employee.items) {
      const item = items.get(itemId);
      const ytdByMonth = pastMonths.map((m) => ({ month: m, amount: itemAmount(item, employee.monthly_wages) }));
      const c = {
        case_id: `${company.company_id}:${employee.employee_id}:${item.item_id}`,
        company_id: company.company_id,
        employee_id: employee.employee_id,
        employee_name: employee.name,
        item_id: item.item_id,
        item,
        ytd: sum(ytdByMonth.map((x) => x.amount)),
        ytdByMonth,
        evidence: [],
        proposal: [],
        flags: [],
        unowed: null,
        model: null,
      };
      const st = detectState(item, employee, company, idx);
      c.state = st.state;
      const stateInfo = idx.catalog.states[st.state];
      c.evidence.push({ step: 1, tone: 'pass', text: `State: ${stateInfo?.name ?? st.state}, from the ${st.source}.` });
      c.evidence.push({ step: 2, tone: 'info', text: `Desktop setting: ${item.item_type}, tracking type "${item.tracking_type}", Law ID ${item.law_id}${item.law_id === 177 || item.law_id === 0 ? ' (employer-created custom item)' : ''}.` });
      if (!pastMonths.length) c.evidence.push({ step: 2, tone: 'info', text: dMonths.length ? 'No Desktop paychecks for this employee this year.' : 'The move happens in January, so there is no Desktop payroll this year to relabel.' });

      const finish = (route, reason, reasonText) => {
        c.route = route;
        c.reason = reason;
        c.reasonText = reasonText;
        cases.push(c);
        employeeCases.push(c);
      };

      // A label that names a state where this employee neither lives nor works.
      const states = employeeStates(employee, company, idx);
      if (st.fromLabel && !states.has(st.state)) {
        const where = [...states].map((s) => idx.catalog.states[s]?.name ?? s).join(' and ');
        c.evidence.push({ step: 1, tone: 'fail', text: `The label says ${stateInfo?.name ?? st.state}, but this employee lives and works in ${where}.` });
        finish('not_in_database', 'state_conflict', `The label names ${stateInfo?.name ?? st.state}, a state this employee has no address in.`);
        continue;
      }

      // Type: the Desktop item if Intuit already defined it, otherwise the state's cluster model.
      let taxType = null;
      let nonTaxEntry = null;
      if (item.origin === 'system') {
        const tax = idx.taxes.get(item.system_tax_id);
        taxType = tax?.type ?? null;
        c.evidence.push({ step: 3, tone: 'pass', text: `System-defined Desktop item: ${tax?.name ?? item.system_tax_id}. No clustering needed.` });
      } else {
        const model = models[st.state];
        const s = model?.suggest(item.label);
        c.model = s ? { ...s, entry_label: s.entry?.label ?? null, shown: model.mode === 'assisted', mode: model.mode } : null;
        if (s?.empty) c.evidence.push({ step: 3, tone: 'fail', text: 'After removing place names and punctuation, the label has no words left to compare.' });
        if (!model || model.mode !== 'assisted') {
          c.evidence.push({ step: 3, tone: 'info', text: s?.entry ? `Model suggestion logged but not shown: ${s.entry.label} (${model?.name} is in shadow mode).` : `${stateInfo?.name ?? st.state} is in shadow mode; the model's output is logged only.` });
          if (item.tracking_type === 'None') {
            finish('not_a_tax', 'after_tax', 'Desktop already treats this as an after-tax deduction.');
            continue;
          }
          finish('not_in_database', 'shadow', `${stateInfo?.name ?? st.state} is in shadow mode, so a person decides this item.`);
          continue;
        }
        if (!s || s.confidence !== 'high') {
          if (!s?.empty) c.evidence.push({ step: 3, tone: 'fail', text: s?.entry ? `Weak cluster signal: closest entry "${s.entry.label}", but this label's silhouette is ${s.item_silhouette.toFixed(2)} (needs ${models[st.state].thresholds.itemFloor}).` : `No defined entry matches this label's cluster (silhouette ${s ? s.item_silhouette.toFixed(2) : 'n/a'}).` });
          if (item.tracking_type === 'None') {
            finish('not_a_tax', 'after_tax', 'Desktop already treats this as an after-tax deduction.');
            continue;
          }
          finish('not_in_database', 'weak_signal', 'The label does not clearly match any defined tax or non-tax item.');
          continue;
        }
        c.evidence.push({ step: 3, tone: 'pass', text: `Cluster: ${s.entry.label} (this label's silhouette ${s.item_silhouette.toFixed(2)}; ${models[st.state].name} model silhouette ${models[st.state].silhouette.toFixed(2)}).` });
        if (s.kind === 'non_tax') nonTaxEntry = s.entry;
        else taxType = s.tax_type;
      }

      // Not a tax: Desktop says after-tax, or the model says non-tax and Desktop does not claim a tax.
      const desktopSaysTax = TAX_TRACKING.has(item.tracking_type);
      if (item.tracking_type === 'None' && taxType) {
        c.evidence.push({ step: 4, tone: 'fail', text: 'Conflict: the label looks like a tax, but Desktop treats it as an after-tax deduction.' });
        finish('not_in_database', 'conflict', 'Tax and non-tax evidence disagree.');
        continue;
      }
      if (item.tracking_type === 'None' && !taxType) {
        finish('not_a_tax', 'after_tax', `Desktop marks it as an after-tax deduction${nonTaxEntry ? ` and it clusters with "${nonTaxEntry.label}"` : ''}.`);
        continue;
      }
      if (nonTaxEntry && desktopSaysTax) {
        c.evidence.push({ step: 4, tone: 'fail', text: `Conflict: Desktop tracks it as "${item.tracking_type}", but the label clusters with "${nonTaxEntry.label}".` });
        finish('not_in_database', 'conflict', 'Tax and non-tax evidence disagree.');
        continue;
      }
      if (nonTaxEntry) {
        finish('not_a_tax', 'non_tax_cluster', `Clusters with "${nonTaxEntry.label}", a known non-tax item.`);
        continue;
      }

      // Local tax: the type must be on the employee's expected list. A system item may only match its own tax.
      let candidates = expected.list.filter((e) => e.tax.type === taxType);
      if (item.origin === 'system') candidates = candidates.filter((e) => e.tax_id === item.system_tax_id);
      const needsHome = taxType === 'school_district' || expected.remote;
      if (!candidates.length) {
        if (needsHome && !expected.periods.length) {
          c.evidence.push({ step: 4, tone: 'fail', text: 'Home address missing, so the tax cannot be confirmed.' });
          finish('not_in_database', 'no_address', 'The home address is missing.');
        } else if (needsHome && expected.unresolvedMonths.length) {
          c.evidence.push({ step: 4, tone: 'fail', text: 'The address could not be placed in a school district, so the tax cannot be confirmed yet.' });
          finish('not_in_database', 'address_unresolved', 'The address lookup could not place the home address.');
        } else {
          const named = item.origin === 'system' ? idx.taxes.get(item.system_tax_id)?.name : null;
          c.evidence.push({ step: 4, tone: 'fail', text: `${named ? `${named} is not` : `No ${typeWord(taxType)} tax is`} on this employee's expected list. Desktop withheld ${usd(c.ytd)} that may not be owed.` });
          finish('not_in_database', 'not_expected', 'Withheld, but not on the expected list.');
        }
        continue;
      }

      // Pick per month: a place named in the label first, then the required tax, then a single optional one.
      const chosen = [];
      const uncovered = [];
      let ambiguous = false;
      for (const m of employed) {
        const options = candidates.filter((e) => e.months.includes(m));
        if (!options.length) {
          if (pastMonths.includes(m) && !expected.unresolvedMonths.includes(m) && !expected.missingMonths.includes(m)) uncovered.push(m);
          continue;
        }
        const named = options.filter((e) => placeMentioned(item.label, e.tax.place));
        let pick = named.length === 1 ? named : options.filter((e) => e.required);
        if (pick.length !== 1 && options.length === 1) pick = options;
        if (pick.length !== 1) { ambiguous = true; break; }
        const found = chosen.find((x) => x.tax_id === pick[0].tax_id);
        if (found) found.months.push(m);
        else chosen.push({ tax_id: pick[0].tax_id, tax: pick[0].tax, months: [m], basis: pick[0].basis, address: pick[0].address, optional: !pick[0].required });
      }
      if (ambiguous) {
        c.evidence.push({ step: 4, tone: 'fail', text: 'More than one expected tax fits this item.' });
        finish('not_in_database', 'ambiguous', 'Several expected taxes fit.');
        continue;
      }
      if (!chosen.length) {
        c.evidence.push({ step: 4, tone: 'fail', text: `The ${typeWord(taxType)} tax on the expected list does not apply in the months this employee was paid.` });
        finish('not_in_database', 'not_expected', 'Withheld, but not on the expected list.');
        continue;
      }
      for (const p of chosen) {
        const past = p.months.filter((m) => pastMonths.includes(m));
        p.rate = rateCheck(item, p.tax, past, employee.monthly_wages);
        p.history = sum(c.ytdByMonth.filter((x) => past.includes(x.month)).map((x) => x.amount));
        const where = p.basis === 'home' ? `home address ${p.address.line1}, ${p.address.city}` : `${expected.remote ? 'home office' : 'work location'} ${p.address.line1}, ${p.address.city}`;
        c.evidence.push({ step: 4, tone: 'pass', text: `On the expected list: ${p.tax.name}${p.tax.type === 'school_district' ? ` (${p.tax.code})` : ''}, from the ${where}, ${monthSpan(p.months)}.` });
        if (p.optional) {
          c.flags.push('optional');
          c.evidence.push({ step: 4, tone: 'warn', text: `${p.tax.name} is optional courtesy withholding for where the employee lives. It is not required, so the employer decides whether to keep it.` });
        }
        if (p.rate.status === 'match') c.evidence.push({ step: 5, tone: 'pass', text: `Rate check: Desktop ${p.rate.desktop} = official ${p.rate.official} (${monthSpan(past)}).` });
        else if (p.rate.status === 'no_history') c.evidence.push({ step: 5, tone: 'info', text: `Rate check: no Desktop months for ${p.tax.name}, so nothing to compare. Online uses the official ${p.rate.official}${p.rate.setupDiffers ? ` (Desktop was set to ${p.rate.desktop})` : ''}.` });
        else if (p.rate.status === 'not_comparable') c.evidence.push({ step: 5, tone: 'info', text: `Rate check: Desktop ${p.rate.desktop} cannot be compared with ${p.rate.official}.` });
        else c.evidence.push({ step: 5, tone: 'fail', text: `Rate check: Desktop ${p.rate.desktop} vs official ${p.rate.official}. ${p.rate.status === 'over' ? 'Over' : 'Under'}-withheld ${usd(Math.abs(p.rate.difference))} in ${monthSpan(past)}.` });
      }
      if (uncovered.length) {
        const amount = sum(c.ytdByMonth.filter((x) => uncovered.includes(x.month)).map((x) => x.amount));
        c.unowed = { months: uncovered, amount };
        c.evidence.push({ step: 4, tone: 'fail', text: `Desktop kept withholding in ${monthSpan(uncovered)}, when no ${typeWord(taxType)} tax applied at the address: ${usd(amount)} not owed. It needs a correction with the agency.` });
      }
      // A label that names a different place than the address. The address wins, but a person should look.
      if (item.origin === 'custom') {
        const namedTaxes = [...idx.taxes.values()].filter((t) => t.state === c.state && t.type === taxType && placeMentioned(item.label, t.place));
        if (namedTaxes.length && !namedTaxes.some((t) => chosen.some((p) => p.tax_id === t.tax_id))) {
          c.flags.push('label_place_mismatch');
          c.evidence.push({ step: 4, tone: 'warn', text: `The label names ${namedTaxes.map((t) => t.place).join(', ')}, but the address points to ${chosen.map((p) => p.tax.name).join(' and ')}. The address decides; check the label before confirming.` });
        }
      }
      c.proposal = chosen;
      finish('local_tax', 'matched', chosen.length > 1 ? 'Matched, split by address period.' : 'Matches a defined tax on the expected list.');
    }

    // The same tax withheld twice for the same months: keep one line, send the other to an expert.
    const order = (c) => (c.proposal.every((p) => ['match', 'no_history'].includes(p.rate.status)) ? 0 : 1);
    const seen = new Map();
    for (const c of employeeCases.filter((x) => x.route === 'local_tax').sort((a, b) => order(a) - order(b))) {
      const keys = c.proposal.flatMap((p) => p.months.map((m) => `${p.tax_id}:${m}`));
      const clash = keys.find((k) => seen.has(k));
      if (clash) {
        const other = seen.get(clash);
        const tax = c.proposal.find((p) => clash.startsWith(`${p.tax_id}:`)).tax;
        c.duplicateOf = other.case_id;
        c.duplicateProposal = c.proposal;
        c.proposal = [];
        c.route = 'not_in_database';
        c.reason = 'duplicate';
        c.reasonText = `"${other.item.label}" already withholds ${tax.name}.`;
        c.evidence.push({ step: 4, tone: 'fail', text: `Duplicate: "${other.item.label}" already withholds ${tax.name} for the same months. Keeping both would withhold it twice (${usd(c.ytd)} extra so far).` });
        continue;
      }
      for (const k of keys) seen.set(k, c);
    }

    // Gaps the other way: required expected taxes that no Desktop item covers.
    for (const e of expected.list.filter((x) => x.required)) {
      const covered = new Set(employeeCases.filter((c) => c.route === 'local_tax').flatMap((c) => c.proposal.filter((p) => p.tax_id === e.tax_id).flatMap((p) => p.months)));
      const missing = e.months.filter((m) => !covered.has(m));
      if (!missing.length) continue;
      const pastMissing = missing.filter((m) => pastMonths.includes(m));
      gaps.push({
        gap_id: `${company.company_id}:${employee.employee_id}:${e.tax_id}`,
        employee_id: employee.employee_id,
        employee_name: employee.name,
        tax_id: e.tax_id,
        tax: e.tax,
        months: missing,
        basis: e.basis,
        address: e.address,
        backTaxEstimate: round2((e.tax.rate / 100) * employee.monthly_wages * pastMissing.length),
        pastMonths: pastMissing,
        cloudMonths: missing.filter((m) => cMonths.includes(m)),
      });
    }
    employees.push({ ...employee, expected, cases: employeeCases });
  }

  return { company, idx, models, employees, cases, gaps, dataIssues: checked.warnings };
}

export { normalize };
