// Decisions by employers and experts, the go-live checks, W-2 history and reconciliation.
// Nothing here goes live without an employer decision (BRD: never activate without confirmation).
import { cloudMonths, desktopMonths, desktopCountsAsTax, monthSpan, round2, sum, rateCheck } from './util.mjs?v=b474631bbf';

const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const STAGE_LABEL = {
  awaiting_employer: 'Waiting for the employer',
  with_expert: 'With an expert',
  confirmed: 'Confirmed',
  moved_to_deduction: 'Moved to deductions',
  employer_managed: 'Employer-managed tax',
  stopped: 'Withholding stopped',
};

export function emptyDecisions() {
  return { cases: {}, gaps: {}, accounts: {}, live: false, liveAt: null, reconciled: false };
}

const RATE_OK = new Set(['match', 'no_history']);

// The case as it stands after any expert and employer decisions.
export function effectiveCase(c, decisions, analysis) {
  const d = decisions.cases[c.case_id] ?? {};
  const employee = analysis.employees.find((e) => e.employee_id === c.employee_id);
  const employed = employee.expected.employed;
  const sent = Boolean(d.sentToExpert);
  let route = sent ? 'not_in_database' : c.route;
  let proposal = sent ? [] : c.proposal;
  let reason = sent ? 'employer_sent' : c.reason;
  let reasonText = sent ? `The employer disagreed with the suggestion${d.sentToExpert.note ? `: ${d.sentToExpert.note}` : ''}.` : c.reasonText;
  let unowed = sent ? null : c.unowed;
  let entry = null;
  if ((c.route === 'not_in_database' || sent) && d.expert) {
    const a = d.expert.action;
    if (a === 'map') {
      const tax = analysis.idx.taxes.get(d.expert.tax_id);
      const onList = employee.expected.list.find((e) => e.tax_id === tax.tax_id);
      const months = (onList ? onList.months : employed).filter((m) => employed.includes(m));
      const past = months.filter((m) => desktopMonths(analysis.company).includes(m));
      proposal = [{
        tax_id: tax.tax_id,
        tax,
        months,
        basis: tax.basis,
        rate: rateCheck(c.item, tax, past, employee.monthly_wages),
        history: sum(c.ytdByMonth.filter((x) => past.includes(x.month)).map((x) => x.amount)),
        fromExpert: true,
      }];
      unowed = null;
      route = 'local_tax';
    } else if (a === 'not_a_tax') route = 'not_a_tax';
    else if (a === 'custom_entry') { route = 'custom_entry'; entry = d.expert.entry; }
    else if (a === 'stop') route = 'stop';
  }
  let stage;
  if (route === 'not_in_database') stage = 'with_expert';
  else if (!d.employer) stage = 'awaiting_employer';
  else stage = { local_tax: 'confirmed', not_a_tax: 'moved_to_deduction', custom_entry: 'employer_managed', stop: 'stopped' }[route];
  // Verified (safe to confirm in bulk): the system's own match, rate equal, nothing flagged for a person to look at.
  const verified = c.route === 'local_tax' && !sent && !d.expert && !c.unowed && !c.flags.length && proposal.every((p) => RATE_OK.has(p.rate.status));
  return { ...c, route, proposal, reason, reasonText, unowed, entry, stage, verified, decision: d, employee };
}

export function effectiveAll(analysis, decisions) {
  return analysis.cases.map((c) => effectiveCase(c, decisions, analysis));
}

/**
 * A gap is "covered" once an expert maps one of the employee's Desktop lines to that tax
 * (for example a conflicting line that turns out to be the school-district tax), "added" when the
 * employer adds it from the first cloud payroll, and otherwise waits for the employer.
 * @param scope the analysis, or the effective cases already computed for it
 */
export function gapStage(gap, decisions, scope) {
  const cases = Array.isArray(scope) ? scope : scope ? effectiveAll(scope, decisions) : [];
  const coveredBy = cases.find((c) => c.employee_id === gap.employee_id && c.route === 'local_tax' && c.decision.expert && c.proposal.some((p) => p.tax_id === gap.tax_id));
  if (coveredBy) return 'covered';
  return decisions.gaps[gap.gap_id]?.action === 'add' ? 'added' : 'awaiting_employer';
}

export function gapCoveredBy(gap, decisions, analysis) {
  return effectiveAll(analysis, decisions).find((c) => c.employee_id === gap.employee_id && c.route === 'local_tax' && c.decision.expert && c.proposal.some((p) => p.tax_id === gap.tax_id)) ?? null;
}

// ---------- Taxes that will run on cloud paychecks ----------

export function liveTaxes(analysis, decisions) {
  const cloud = cloudMonths(analysis.company);
  const out = [];
  const cases = effectiveAll(analysis, decisions);
  for (const c of cases) {
    if (c.stage === 'confirmed') {
      for (const p of c.proposal) {
        const months = p.months.filter((m) => cloud.includes(m));
        if (months.length) out.push({ key: p.tax_id, tax: p.tax, employee: c.employee, months, rate: p.tax.rate, source: 'confirmed', case_id: c.case_id, item: c.item });
      }
    }
    if (c.stage === 'employer_managed' && c.entry) {
      const months = cloud.filter((m) => c.employee.expected.employed.includes(m));
      if (months.length) out.push({ key: `CUSTOM:${c.case_id}`, tax: { tax_id: `CUSTOM:${c.case_id}`, name: c.entry.name, agency: c.entry.agency, type: c.entry.type, rate: c.entry.rate, flat: c.entry.flat, qb_pays_and_files: false, custom: true, basis: c.entry.basis }, employee: c.employee, months, rate: c.entry.rate, source: 'custom_entry', case_id: c.case_id, item: c.item });
    }
  }
  for (const g of analysis.gaps) {
    if (gapStage(g, decisions, cases) !== 'added') continue;
    const employee = analysis.employees.find((e) => e.employee_id === g.employee_id);
    const months = g.months.filter((m) => cloud.includes(m));
    if (months.length) out.push({ key: g.tax_id, tax: g.tax, employee, months, rate: g.tax.rate, source: 'added_gap', gap_id: g.gap_id });
  }
  return out;
}

export function agencyAccounts(analysis, decisions) {
  const live = liveTaxes(analysis, decisions);
  const agencies = new Map();
  for (const t of live) {
    if (!agencies.has(t.tax.agency)) agencies.set(t.tax.agency, { agency: t.tax.agency, taxes: new Set(), prefill: null });
    agencies.get(t.tax.agency).taxes.add(t.tax.name);
  }
  // Prefill from the Desktop items that were confirmed against a tax of the same agency.
  for (const c of effectiveAll(analysis, decisions)) {
    if (!['confirmed', 'employer_managed'].includes(c.stage)) continue;
    const agency = c.stage === 'employer_managed' ? c.entry?.agency : c.proposal[0]?.tax.agency;
    const a = agencies.get(agency);
    if (a && !a.prefill && c.item.agency_account) a.prefill = { account: c.item.agency_account, frequency: c.item.deposit_frequency, from: c.item.label };
  }
  return [...agencies.values()].map((a) => {
    const saved = decisions.accounts[a.agency];
    const account = saved?.account ?? a.prefill?.account ?? '';
    const frequency = saved?.frequency ?? a.prefill?.frequency ?? '';
    return { agency: a.agency, taxes: [...a.taxes], account, frequency, source: saved ? 'employer' : a.prefill ? `Desktop item "${a.prefill.from}"` : null, complete: Boolean(account && frequency) };
  });
}

// ---------- Dollar tie-out and readiness ----------

const DESTINATION = {
  confirmed: 'Relabelled to the confirmed tax',
  moved_to_deduction: 'Moved to non-tax deductions',
  employer_managed: 'Kept as an employer-managed tax',
  stopped: 'Withheld but not owed: correction needed',
  with_expert: 'Held for expert review',
  awaiting_employer: 'Waiting for the employer',
};

// Desktop local-tax dollars: lines Desktop tracked as a tax, plus any line a person reclassified as a tax.
const countsAsTaxDollars = (c) => desktopCountsAsTax(c.item) || ['local_tax', 'custom_entry'].includes(c.route);

export function dollarTieOut(analysis, decisions) {
  const rows = new Map(Object.entries(DESTINATION).map(([stage, label]) => [stage, { stage, label, amount: 0, count: 0 }]));
  let total = 0;
  const put = (stage, amount) => {
    const row = rows.get(stage);
    row.amount = round2(row.amount + amount);
    row.count += 1;
  };
  for (const c of effectiveAll(analysis, decisions)) {
    if (!countsAsTaxDollars(c)) continue;
    total += c.ytd;
    // Months withheld after the tax stopped applying are not relabelled: they need a correction.
    if (c.stage === 'confirmed' && c.unowed?.amount) {
      put('confirmed', c.ytd - c.unowed.amount);
      put('stopped', c.unowed.amount);
    } else put(c.stage, c.ytd);
  }
  const list = [...rows.values()].filter((r) => r.count);
  const waiting = rows.get('awaiting_employer').amount;
  return { total: round2(total), rows: list, waiting, accounted: round2(total - waiting) };
}

export function readiness(analysis, decisions) {
  const cases = effectiveAll(analysis, decisions);
  const waiting = cases.filter((c) => c.stage === 'awaiting_employer');
  const expert = cases.filter((c) => c.stage === 'with_expert');
  const openGaps = analysis.gaps.filter((g) => !['added', 'covered'].includes(gapStage(g, decisions, cases)));
  const accounts = agencyAccounts(analysis, decisions);
  const tie = dollarTieOut(analysis, decisions);
  const checks = [
    { id: 'employer', label: 'Every Desktop line has the employer\'s decision', pass: waiting.length === 0, detail: waiting.length ? `${waiting.length} line${waiting.length === 1 ? '' : 's'} still waiting on the review screen.` : 'All decided.' },
    { id: 'gaps', label: 'Every expected tax with no Desktop item is handled', pass: openGaps.length === 0, detail: openGaps.length ? `${openGaps.length} expected tax${openGaps.length === 1 ? '' : 'es'} not yet added.` : 'None open.' },
    { id: 'dollars', label: 'Every Desktop local-tax dollar has a destination', pass: tie.waiting === 0, detail: `${usd(tie.accounted)} of ${usd(tie.total)} accounted for.` },
    { id: 'accounts', label: 'Account number and deposit frequency for every agency', pass: accounts.every((a) => a.complete), detail: !accounts.length ? 'No taxes will run on Online paychecks yet.' : accounts.filter((a) => !a.complete).map((a) => `Missing for ${a.agency}`).join('; ') || 'All agencies complete.' },
  ];
  return { checks, ready: checks.every((c) => c.pass), expert, waiting, openGaps, accounts, tie };
}

// ---------- W-2 history (projected for the full year) ----------

const box20 = (tax) => (tax.type === 'school_district' ? `SD ${tax.code} ${tax.name.replace(/ (City|Local|Exempted Village) School District$/, '')}` : tax.name.replace(/^City of /, '').replace(/ income tax$/, ''));

export function w2Preview(analysis, decisions) {
  const dm = desktopMonths(analysis.company);
  const cm = cloudMonths(analysis.company);
  const byEmployee = new Map(analysis.employees.map((e) => [e.employee_id, { employee: e, lines: new Map(), notes: [] }]));
  const line = (emp, key, name) => {
    if (!emp.lines.has(key)) emp.lines.set(key, { key, box20: name, wages: 0, desktop: 0, cloud: 0, months: [] });
    return emp.lines.get(key);
  };
  const cases = effectiveAll(analysis, decisions);
  for (const c of cases) {
    const emp = byEmployee.get(c.employee_id);
    const wages = c.employee.monthly_wages;
    const employed = c.employee.expected.employed;
    if (c.stage === 'confirmed') {
      for (const p of c.proposal) {
        const past = p.months.filter((m) => dm.includes(m));
        const future = p.months.filter((m) => cm.includes(m));
        const l = line(emp, p.tax_id, box20(p.tax));
        l.wages = round2(l.wages + wages * (past.length + future.length));
        l.desktop = round2(l.desktop + sum(c.ytdByMonth.filter((x) => past.includes(x.month)).map((x) => x.amount)));
        l.cloud = round2(l.cloud + (p.tax.rate / 100) * wages * future.length);
        l.months.push(...p.months);
        if (p.rate.status === 'over' || p.rate.status === 'under') emp.notes.push(`${p.tax.name}: Desktop withheld at ${p.rate.desktop} instead of ${p.rate.official} in ${monthSpan(p.rate.months)} (${p.rate.status === 'over' ? 'over' : 'under'} by ${usd(Math.abs(p.rate.difference))}). The W-2 shows what was actually withheld.`);
      }
      if (c.unowed?.amount) emp.notes.push(`"${c.item.label}": ${usd(c.unowed.amount)} withheld in ${monthSpan(c.unowed.months)} was not owed. It stays off the W-2 until corrected with the agency.`);
    } else if (c.stage === 'employer_managed' && c.entry) {
      const past = dm.filter((m) => employed.includes(m));
      const future = cm.filter((m) => employed.includes(m));
      const l = line(emp, `CUSTOM:${c.case_id}`, c.entry.name);
      l.wages = round2(l.wages + wages * (past.length + future.length));
      l.desktop = round2(l.desktop + c.ytd);
      l.cloud = round2(l.cloud + (c.entry.flat ? (c.entry.flat / 12) * future.length : ((c.entry.rate ?? 0) / 100) * wages * future.length));
      l.employerManaged = true;
    } else if (c.stage === 'with_expert' || c.stage === 'awaiting_employer') {
      if (countsAsTaxDollars(c) && c.ytd) emp.notes.push(`"${c.item.label}" (${usd(c.ytd)} so far) is not on the W-2 yet: ${STAGE_LABEL[c.stage].toLowerCase()}.`);
    } else if (c.stage === 'stopped' && c.ytd) {
      emp.notes.push(`"${c.item.label}": ${usd(c.ytd)} was withheld but is not owed. It stays off the W-2 until corrected with the agency.`);
    }
  }
  for (const g of analysis.gaps) {
    if (gapStage(g, decisions, cases) !== 'added') continue;
    const emp = byEmployee.get(g.employee_id);
    const future = g.months.filter((m) => cm.includes(m));
    const back = g.pastMonths.length ? ` Estimated back tax for ${monthSpan(g.pastMonths)}: ${usd(g.backTaxEstimate)}; discuss with the agency.` : '';
    if (future.length) {
      const l = line(emp, g.tax_id, box20(g.tax));
      l.wages = round2(l.wages + emp.employee.monthly_wages * future.length);
      l.cloud = round2(l.cloud + (g.tax.rate / 100) * emp.employee.monthly_wages * future.length);
      emp.notes.push(`${g.tax.name} starts with the first cloud payroll.${back}`);
    } else {
      emp.notes.push(`${g.tax.name} was owed but never withheld, and there are no Online paychecks to start it on.${back}`);
    }
  }
  return [...byEmployee.values()].map((e) => ({
    employee: e.employee,
    lines: [...e.lines.values()].map((l) => ({ ...l, total: round2(l.desktop + l.cloud) })),
    notes: e.notes,
  }));
}

// ---------- Reconciliation after the first payroll and the first quarter ----------

export function reconcile(analysis, decisions) {
  const cm = cloudMonths(analysis.company);
  const autoPlan = ['Premium', 'Elite'].includes(analysis.company.plan);
  const live = liveTaxes(analysis, decisions);
  const rows = new Map();
  for (const t of live) {
    if (!rows.has(t.key)) {
      const qb = autoPlan && t.tax.qb_pays_and_files && !t.tax.custom;
      rows.set(t.key, { key: t.key, name: t.tax.name, agency: t.tax.agency, employees: new Set(), firstPayroll: 0, quarter: 0, payer: qb ? 'QuickBooks pays and files' : t.tax.custom ? 'You pay and file (employer-managed)' : 'You pay and file', qb });
    }
    const r = rows.get(t.key);
    r.employees.add(t.employee.name);
    const monthly = t.tax.flat ? t.tax.flat / 12 : ((t.rate ?? 0) / 100) * t.employee.monthly_wages;
    r.firstPayroll = round2(r.firstPayroll + (t.months.includes(cm[0]) ? monthly : 0));
    r.quarter = round2(r.quarter + monthly * t.months.length);
  }
  const flags = [];
  const liveKeys = new Set(live.map((t) => `${t.employee.employee_id}:${t.key}`));
  for (const e of analysis.employees) {
    for (const x of e.expected.list) {
      const due = x.months.filter((m) => cm.includes(m));
      if (!due.length || liveKeys.has(`${e.employee_id}:${x.tax_id}`)) continue;
      if (x.required) flags.push({ tone: 'fail', text: `${e.name}: ${x.tax.name} is expected from ${monthSpan(due)} but nothing was withheld.` });
      else flags.push({ tone: 'info', text: `${e.name}: optional ${x.tax.name} withholding for the home city is not set up. Allowed, but the employee may owe it directly.` });
    }
  }
  for (const c of effectiveAll(analysis, decisions)) {
    if (c.stage === 'with_expert') flags.push({ tone: 'warn', text: `${c.employee_name}: "${c.item.label}" is still with an expert, so nothing is withheld for it.` });
    if (c.stage === 'stopped' && c.ytd) flags.push({ tone: 'warn', text: `${c.employee_name}: ${usd(c.ytd)} withheld in Desktop under "${c.item.label}" needs a correction with the agency.` });
    if (c.stage === 'employer_managed') flags.push({ tone: 'info', text: `${c.employee_name}: "${c.entry?.name}" is employer-managed. Confirm you paid and filed it.` });
    if (c.stage === 'confirmed') {
      for (const p of c.proposal) if (p.rate.status === 'over' || p.rate.status === 'under') flags.push({ tone: 'warn', text: `${c.employee_name}: past ${p.tax.name} withholding was ${p.rate.status === 'over' ? 'over' : 'under'} by ${usd(Math.abs(p.rate.difference))}. New paychecks use the official ${p.rate.official}.` });
      if (c.unowed?.amount) flags.push({ tone: 'warn', text: `${c.employee_name}: ${usd(c.unowed.amount)} withheld in ${monthSpan(c.unowed.months)} under "${c.item.label}" was not owed and needs a correction with the agency.` });
      for (const p of c.proposal) if (p.optional) flags.push({ tone: 'info', text: `${c.employee_name}: optional ${p.tax.name} courtesy withholding kept at the employer's choice.` });
    }
  }
  return {
    rows: [...rows.values()].map((r) => ({ ...r, employees: [...r.employees] })),
    flags,
    totals: { firstPayroll: sum([...rows.values()].map((r) => r.firstPayroll)), quarter: sum([...rows.values()].map((r) => r.quarter)) },
  };
}

// ---------- Automation: rules the employer approves once ----------
// The BRD says the model suggests and a person decides. Here the person (the employer) decides the
// rules once; the system then applies them to every line they cover and leaves only the exceptions.
// Lines the BRD reserves for people are never decided automatically: a weak or missing label signal,
// conflicting evidence, a missing or unplaceable address, a label naming another state, a state in
// shadow mode, more than one possible tax, or a line someone sent to an expert.

export const AUTOMATION_RULES = [
  { id: 'confirm_matches', label: 'Confirm matches the address supports', help: 'The tax is on the employee\'s expected list. The address decides when the label names another place.' },
  { id: 'official_rate', label: 'Use the official rate when Desktop\'s rate is wrong', help: 'Over- or under-withholding and months withheld after a move are flagged for a correction.' },
  { id: 'deductions', label: 'Move after-tax deductions', help: 'Desktop already treats the line as after-tax, or it is a known non-tax item.' },
  { id: 'add_gaps', label: 'Add expected taxes nobody withheld', help: 'From the first cloud payroll; any back tax is flagged for the agency.' },
  { id: 'stop_not_owed', label: 'Stop taxes the address says are not owed', help: 'Duplicates, and taxes not on the expected list for an address found in the lookup.' },
  { id: 'accept_expert', label: 'Accept expert decisions', help: 'An expert\'s answer takes effect without a second click.' },
  { id: 'go_live', label: 'Go live and reconcile when everything is settled', help: 'Only when no line is left for a person and every go-live check passes.' },
];
export const DEFAULT_POLICY = Object.freeze(Object.fromEntries(AUTOMATION_RULES.map((r) => [r.id, true])));
export const PERSON_REASONS = new Set(['weak_signal', 'conflict', 'no_address', 'address_unresolved', 'state_conflict', 'shadow', 'ambiguous', 'employer_sent']);

const ROUTE_VERB = { local_tax: 'Confirmed', not_a_tax: 'Moved to deductions', custom_entry: 'Accepted as employer-managed', stop: 'Stopped withholding' };

/**
 * Apply the automation rules. The input decisions are not changed: a new copy is returned with the
 * actions taken and the exceptions left for a person. Anything a person undid is on hold and skipped.
 */
export function automate(analysis, decisions, policy = DEFAULT_POLICY, at = new Date().toISOString()) {
  const d = structuredClone(decisions);
  const on = (rule) => policy[rule] !== false;
  const actions = [];
  const stamp = (rule) => ({ auto: true, rule, at });
  if (!d.live) {
    // 1. Not owed at this address (or withheld twice): stop, and flag the Desktop amount for a correction.
    for (const c of effectiveAll(analysis, d)) {
      const rec = d.cases[c.case_id] ?? {};
      if (rec.hold || c.stage !== 'with_expert' || rec.sentToExpert || !on('stop_not_owed')) continue;
      if (c.reason !== 'not_expected' && c.reason !== 'duplicate') continue;
      if (c.employee.expected.unresolvedMonths.length || !c.employee.expected.periods.length) continue;
      const note = c.reason === 'duplicate' ? 'Duplicate: another line already withholds this tax.' : 'No tax of this kind applies at the employee\'s address.';
      d.cases[c.case_id] = { ...rec, expert: { action: 'stop', note, ...stamp('stop_not_owed') } };
      actions.push({ rule: 'stop_not_owed', target: `${c.employee_name}: ${c.item.label}`, action: 'Marked as not owed', detail: note });
    }
    // 2. Employer confirmations covered by a rule.
    for (const c of effectiveAll(analysis, d)) {
      const rec = d.cases[c.case_id] ?? {};
      if (rec.hold || c.stage !== 'awaiting_employer') continue;
      let rule = null;
      if (c.decision.expert) rule = c.decision.expert.auto ? c.decision.expert.rule : 'accept_expert';
      else if (c.route === 'not_a_tax') rule = 'deductions';
      else if (c.route === 'local_tax') {
        const off = c.proposal.some((p) => p.rate.status === 'over' || p.rate.status === 'under') || Boolean(c.unowed?.amount);
        if (!on('confirm_matches')) rule = null;
        else rule = off ? 'official_rate' : 'confirm_matches';
      }
      if (!rule || !on(rule)) continue;
      d.cases[c.case_id] = { ...rec, employer: { action: c.route, ...stamp(rule) } };
      const detail = c.route === 'local_tax' ? `${c.proposal.map((p) => p.tax.name).join(' and ')}${rule === 'official_rate' ? ', at the official rate; the difference is flagged for a correction' : ''}` : '';
      actions.push({ rule, target: `${c.employee_name}: ${c.item.label}`, action: ROUTE_VERB[c.route], detail });
    }
    // 3. Expected taxes nobody withheld.
    if (on('add_gaps')) {
      const cases = effectiveAll(analysis, d);
      for (const g of analysis.gaps) {
        if (d.gaps[g.gap_id] || gapStage(g, d, cases) !== 'awaiting_employer') continue;
        d.gaps[g.gap_id] = { action: 'add', ...stamp('add_gaps') };
        actions.push({ rule: 'add_gaps', target: `${g.employee_name}: ${g.tax.name}`, action: g.cloudMonths.length ? 'Added expected tax' : 'Recorded back tax', detail: `Back tax estimate ${usd(g.backTaxEstimate)}` });
      }
    }
    // 4. Go live and reconcile, only when nothing is left for a person.
    const left = exceptions(analysis, d);
    if (on('go_live') && !d.liveHold && !left.length && readiness(analysis, d).ready) {
      d.live = true;
      d.liveAt = at;
      d.reconciled = true;
      d.liveAuto = true;
      const n = liveTaxes(analysis, d).length;
      actions.push({ rule: 'go_live', target: analysis.company.name, action: 'Went live', detail: `${n} employee tax${n === 1 ? '' : 'es'} switched on` });
      actions.push({ rule: 'go_live', target: analysis.company.name, action: 'Reconciled first payroll and quarter', detail: `${reconcile(analysis, d).flags.length} flags` });
    }
  }
  return { decisions: d, actions, exceptions: exceptions(analysis, d) };
}

/** What is left for a person: lines with an expert, lines and gaps the rules do not cover, missing accounts. */
export function exceptions(analysis, decisions) {
  const out = [];
  const cases = effectiveAll(analysis, decisions);
  for (const c of cases) {
    if (c.stage === 'with_expert') out.push({ kind: 'case', case_id: c.case_id, employee_id: c.employee_id, employee: c.employee_name, item: c.item.label, reason: c.reason, owner: 'expert' });
    else if (c.stage === 'awaiting_employer') out.push({ kind: 'case', case_id: c.case_id, employee_id: c.employee_id, employee: c.employee_name, item: c.item.label, reason: decisions.cases[c.case_id]?.hold ? 'held' : 'rule_off', owner: 'employer' });
  }
  for (const g of analysis.gaps) {
    if (gapStage(g, decisions, cases) === 'awaiting_employer') out.push({ kind: 'gap', gap_id: g.gap_id, employee_id: g.employee_id, employee: g.employee_name, item: g.tax.name, reason: decisions.gaps[g.gap_id] ? 'held' : 'rule_off', owner: 'employer' });
  }
  if (!out.length && !decisions.live) {
    for (const a of agencyAccounts(analysis, decisions)) if (!a.complete) out.push({ kind: 'account', agency: a.agency, item: a.agency, reason: 'account_missing', owner: 'employer' });
  }
  return out;
}

/** How each line and expected tax was settled: automatically, by a person, or not yet. */
export function automationStats(analysis, decisions) {
  const cases = effectiveAll(analysis, decisions);
  let auto = 0;
  let manual = 0;
  let open = 0;
  for (const c of cases) {
    if (c.stage === 'awaiting_employer' || c.stage === 'with_expert') { open += 1; continue; }
    const e = c.decision.employer;
    const x = c.decision.expert;
    if (e?.auto && (!x || x.auto)) auto += 1;
    else manual += 1;
  }
  for (const g of analysis.gaps) {
    const st = gapStage(g, decisions, cases);
    if (st === 'awaiting_employer') open += 1;
    else if (st === 'added' && decisions.gaps[g.gap_id]?.auto) auto += 1;
    else manual += 1;
  }
  const total = cases.length + analysis.gaps.length;
  return { total, auto, manual, open, share: total ? auto / total : 0 };
}
