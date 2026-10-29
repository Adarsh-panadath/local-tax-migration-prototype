// The BRD v3 pipeline for one company:
//   1 find the state · 2 list expected taxes · 3 cluster custom items · 4 route every item · (5 employer confirms, see workflow.mjs)
import { clusterLabels, MODEL_VERSION } from './cluster.mjs';
import { normalize } from './text.mjs';
import { desktopMonths, itemAmount, monthSpan, range, round2, sum, rateText } from './util.mjs';

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

// ---------- Step 2: expected taxes from addresses ----------

function addressPeriods(employee) {
  const sorted = [...employee.addresses].sort((a, b) => a.from_month - b.from_month);
  return sorted.map((a, i) => ({
    address_id: a.address_id,
    months: range(a.from_month, i + 1 < sorted.length ? sorted[i + 1].from_month - 1 : 12),
  }));
}

export function expectedTaxes(employee, company, idx) {
  const site = company.worksites.find((s) => s.site_id === employee.site_id);
  const work = idx.addresses.get(site.address_id);
  const periods = addressPeriods(employee);
  const notes = [];
  const byTax = new Map();
  const add = (tax, months, required, basis, address) => {
    const key = tax.tax_id;
    const prev = byTax.get(key);
    if (prev) {
      prev.months = [...new Set([...prev.months, ...months])].sort((a, b) => a - b);
      prev.required = prev.required || required;
    } else {
      byTax.set(key, { tax_id: key, tax, months: [...months], required, basis, address });
    }
  };
  const findCity = (state, place) =>
    [...idx.taxes.values()].find((t) => t.state === state && t.type === 'municipal' && t.place.toLowerCase() === String(place).toLowerCase());

  const workState = idx.catalog.states[work.state];
  if (workState.rollout !== 'enabled') {
    notes.push({ tone: 'info', text: `${workState.name} is not enabled yet, so expected taxes are not listed for this work location.` });
  } else {
    const city = findCity(work.state, work.municipality);
    if (city) add(city, range(1, 12), true, 'work', work);
  }

  if (!periods.length) {
    notes.push({ tone: 'warn', text: 'No home address came across from Desktop, so home-based taxes (school district, home city) cannot be listed. Ask the employee to confirm their address.' });
  }
  for (const p of periods) {
    const home = idx.addresses.get(p.address_id);
    const homeState = idx.catalog.states[home.state];
    if (homeState.rollout !== 'enabled') {
      notes.push({ tone: 'info', text: `${homeState.name} is not enabled yet, so home-based taxes are not listed (${monthSpan(p.months)}).` });
      continue;
    }
    if (home.school_district && home.school_district.startsWith('NO-TAX')) {
      const nt = homeState.no_tax_districts.find((d) => d.place.toLowerCase() === home.city.toLowerCase());
      notes.push({ tone: 'info', text: `${nt?.name ?? 'This school district'} has no school-district income tax (${monthSpan(p.months)}).` });
    } else if (home.school_district) {
      const sd = [...idx.taxes.values()].find((t) => t.type === 'school_district' && t.code === home.school_district);
      if (sd) add(sd, p.months, true, 'home', home);
    }
    const homeCity = findCity(home.state, home.municipality);
    const workCity = findCity(work.state, work.municipality);
    if (homeCity && homeCity !== workCity) add(homeCity, p.months, false, 'home', home);
  }
  return { periods, work, list: [...byTax.values()], notes };
}

// ---------- Step 1: state ----------

function detectState(item, employee, company, idx) {
  if (item.origin === 'system' && item.system_tax_id) {
    return { state: idx.taxes.get(item.system_tax_id)?.state ?? null, source: 'Desktop tax item' };
  }
  const hint = STATE_HINTS.find((h) => h.pattern.test(item.label));
  if (hint) return { state: hint.state, source: `label "${item.label}"` };
  const first = employee.addresses[0] && idx.addresses.get(employee.addresses[0].address_id);
  if (first) return { state: first.state, source: 'home address' };
  const site = company.worksites.find((s) => s.site_id === employee.site_id);
  return { state: idx.addresses.get(site.address_id).state, source: 'work address' };
}

// States an item may belong to: the label's own hint, else the states of the people it is assigned to.
function itemStates(item, company, idx) {
  const hint = STATE_HINTS.find((h) => h.pattern.test(item.label));
  if (hint) return new Set([hint.state]);
  const states = new Set();
  for (const e of company.employees.filter((x) => x.items.includes(item.item_id))) {
    const first = e.addresses[0] && idx.addresses.get(e.addresses[0].address_id);
    const site = company.worksites.find((s) => s.site_id === e.site_id);
    states.add(first ? first.state : idx.addresses.get(site.address_id).state);
  }
  return states;
}

// ---------- Step 3: models per state ----------

export function runModels(company, idx, pools, settings) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds ?? {}) };
  const models = {};
  for (const [code, state] of Object.entries(idx.catalog.states)) {
    const entries = idx.catalog.defined_entries.filter((e) => e.states.includes(code));
    const pool = pools[code] ?? [];
    const companyLabels = [...new Set(company.items.filter((i) => i.origin === 'custom' && itemStates(i, company, idx).has(code)).map((i) => i.label))];
    const labels = [...pool.map((p) => p.label), ...companyLabels.filter((l) => !pool.some((p) => p.label === l))];
    const result = clusterLabels(labels, entries, state.place_names);
    const suggestionFor = (i) => {
      const cluster = result.clusters[result.assignment[i]];
      const entry = cluster?.entry ?? null;
      const itemSil = result.itemScores[i] ?? 0;
      const high = Boolean(entry) && itemSil >= thresholds.itemFloor;
      return {
        label: labels[i],
        cluster_index: cluster?.index ?? null,
        entry,
        kind: entry?.kind ?? null,
        tax_type: entry?.tax_type ?? null,
        key: entry ? (entry.kind === 'tax' ? entry.tax_type : `non_tax:${entry.entry_id}`) : null,
        item_silhouette: itemSil,
        confidence: high ? 'high' : 'low',
      };
    };
    const suggestions = labels.map((_, i) => suggestionFor(i));
    // Precision is measured only on the labelled pool, against expert answers the model never sees.
    let high = 0;
    let correct = 0;
    pool.forEach((p, i) => {
      const s = suggestions[i];
      if (s.confidence !== 'high') return;
      high += 1;
      if (s.key === p.expert_label) correct += 1;
    });
    const precision = high ? correct / high : 0;
    const coverage = pool.length ? high / pool.length : 0;
    const gates = {
      rollout: state.rollout === 'enabled',
      silhouette: result.silhouette >= thresholds.silhouetteFloor,
      precision: precision >= thresholds.precisionTarget,
      sample: pool.length >= thresholds.minSample,
    };
    const forced = Boolean(settings.forceShadow?.[code]);
    const mode = !forced && Object.values(gates).every(Boolean) ? 'assisted' : 'shadow';
    models[code] = {
      state: code,
      name: state.name,
      version: MODEL_VERSION,
      thresholds,
      labels,
      poolSize: pool.length,
      clusters: result.clusters.map((c) => ({
        index: c.index,
        name: c.entry?.label ?? 'Unnamed cluster',
        kind: c.entry?.kind ?? null,
        size: c.size,
        nameSimilarity: c.nameSimilarity,
        meanSilhouette: c.meanSilhouette,
        members: c.members.map((i) => ({ label: labels[i], silhouette: result.itemScores[i], fromCompany: i >= pool.length || companyLabels.includes(labels[i]) })),
      })),
      silhouette: result.silhouette,
      k: result.k,
      highConfidence: high,
      correct,
      precision,
      coverage,
      gates,
      forced,
      mode,
      suggest: (label) => {
        const i = labels.indexOf(label);
        return i === -1 ? null : suggestions[i];
      },
    };
  }
  return models;
}

// ---------- Step 4: route every item ----------

function rateCheck(item, tax, months, wages) {
  if (item.calc.kind !== 'percent') {
    return { status: 'not_comparable', desktop: rateText(item), official: `${tax.rate}%`, difference: 0, months };
  }
  const diff = round2(item.calc.rate - tax.rate);
  const difference = round2(((item.calc.rate - tax.rate) / 100) * wages * months.length);
  return {
    status: Math.abs(diff) < 0.0001 ? 'match' : diff > 0 ? 'over' : 'under',
    desktop: `${item.calc.rate}%`,
    official: `${tax.rate}%`,
    difference,
    months,
  };
}

function placeMentioned(label, tax, idx) {
  const words = new Set(String(label).toLowerCase().split(/[^a-z]+/));
  return tax.place && words.has(tax.place.toLowerCase());
}

export function analyseCompany(company, data, settings = {}) {
  const idx = indexData(data);
  const models = runModels(company, idx, data.pools, settings);
  const dMonths = desktopMonths(company);
  const items = new Map(company.items.map((i) => [i.item_id, i]));
  const employees = [];
  const cases = [];
  const gaps = [];

  for (const employee of company.employees) {
    const expected = expectedTaxes(employee, company, idx);
    const employeeCases = [];
    for (const itemId of employee.items) {
      const item = items.get(itemId);
      const ytdByMonth = dMonths.map((m) => ({ month: m, amount: itemAmount(item, employee.monthly_wages) }));
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
        model: null,
      };
      const st = detectState(item, employee, company, idx);
      c.state = st.state;
      const stateInfo = idx.catalog.states[st.state];
      c.evidence.push({ step: 1, tone: 'pass', text: `State: ${stateInfo?.name ?? st.state}, from the ${st.source}.` });
      c.evidence.push({ step: 2, tone: 'info', text: `Desktop setting: ${item.item_type}, tracking type "${item.tracking_type}", Law ID ${item.law_id}${item.law_id === 177 || item.law_id === 0 ? ' (employer-created custom item)' : ''}.` });

      const finish = (route, reason, reasonText) => {
        c.route = route;
        c.reason = reason;
        c.reasonText = reasonText;
        cases.push(c);
        employeeCases.push(c);
      };

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
          c.evidence.push({ step: 3, tone: 'fail', text: s?.entry ? `Weak cluster signal: closest entry "${s.entry.label}" but this label's silhouette is ${s.item_silhouette.toFixed(2)} (needs ${models[st.state].thresholds.itemFloor}).` : `No defined entry matches this label's cluster (silhouette ${s ? s.item_silhouette.toFixed(2) : 'n/a'}).` });
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

      // Local tax: the type must be on the employee's expected list.
      const candidates = expected.list.filter((e) => e.tax.type === taxType);
      const homeBased = taxType === 'school_district';
      if (!candidates.length) {
        if (homeBased && !expected.periods.length) {
          c.evidence.push({ step: 4, tone: 'fail', text: 'Home address missing, so the school district cannot be confirmed.' });
          finish('not_in_database', 'no_address', 'The home address is missing.');
        } else {
          c.evidence.push({ step: 4, tone: 'fail', text: `No ${taxType === 'school_district' ? 'school-district' : 'city'} tax is on this employee's expected list. Desktop withheld ${usd(c.ytd)} that may not be owed.` });
          finish('not_in_database', 'not_expected', 'Withheld, but not on the expected list.');
        }
        continue;
      }
      // Pick per month: a required tax first; a place named in the label breaks ties.
      const chosen = [];
      let ambiguous = false;
      for (const m of dMonths.concat(range(company.migration_month, 12))) {
        const options = candidates.filter((e) => e.months.includes(m));
        if (!options.length) continue;
        let pick = options.filter((e) => e.required);
        if (pick.length !== 1) {
          const named = options.filter((e) => placeMentioned(item.label, e.tax, idx));
          if (named.length === 1) pick = named;
        }
        if (pick.length !== 1) { ambiguous = true; break; }
        const found = chosen.find((x) => x.tax_id === pick[0].tax_id);
        if (found) found.months.push(m);
        else chosen.push({ tax_id: pick[0].tax_id, tax: pick[0].tax, months: [m], basis: pick[0].basis, address: pick[0].address });
      }
      if (ambiguous || !chosen.length) {
        c.evidence.push({ step: 4, tone: 'fail', text: 'More than one expected tax fits this item.' });
        finish('not_in_database', 'ambiguous', 'Several expected taxes fit.');
        continue;
      }
      for (const p of chosen) {
        const pastMonths = p.months.filter((m) => dMonths.includes(m));
        p.rate = rateCheck(item, p.tax, pastMonths, employee.monthly_wages);
        p.history = sum(c.ytdByMonth.filter((x) => pastMonths.includes(x.month)).map((x) => x.amount));
        const where = p.basis === 'home' ? `home address ${p.address.line1}, ${p.address.city}` : `work location ${p.address.line1}, ${p.address.city}`;
        c.evidence.push({ step: 4, tone: 'pass', text: `On the expected list: ${p.tax.name}${p.tax.type === 'school_district' ? ` (${p.tax.code})` : ''}, from the ${where}, ${monthSpan(p.months)}.` });
        if (p.rate.status === 'match') c.evidence.push({ step: 5, tone: 'pass', text: `Rate check: Desktop ${p.rate.desktop} = official ${p.rate.official} (${monthSpan(pastMonths)}).` });
        else if (p.rate.status === 'not_comparable') c.evidence.push({ step: 5, tone: 'info', text: `Rate check: Desktop ${p.rate.desktop} cannot be compared with ${p.rate.official}.` });
        else c.evidence.push({ step: 5, tone: 'fail', text: `Rate check: Desktop ${p.rate.desktop} vs official ${p.rate.official}. ${p.rate.status === 'over' ? 'Over' : 'Under'}-withheld ${usd(Math.abs(p.rate.difference))} in ${monthSpan(pastMonths)}.` });
      }
      c.proposal = chosen;
      finish('local_tax', 'matched', chosen.length > 1 ? 'Matched, split by address period.' : 'Matches a defined tax on the expected list.');
    }

    // Gaps the other way: required expected taxes that no Desktop item covers.
    for (const e of expected.list.filter((x) => x.required)) {
      const covered = new Set(employeeCases.filter((c) => c.route === 'local_tax').flatMap((c) => c.proposal.filter((p) => p.tax_id === e.tax_id).flatMap((p) => p.months)));
      const missing = e.months.filter((m) => !covered.has(m));
      if (!missing.length) continue;
      const pastMissing = missing.filter((m) => dMonths.includes(m));
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
      });
    }
    employees.push({ ...employee, expected, cases: employeeCases });
  }

  return { company, idx, models, employees, cases, gaps };
}

export { normalize };
