// Decisions by employers and experts, the go-live checks, W-2 history and reconciliation.
// Nothing here goes live without an employer decision (BRD: never activate without confirmation).
import { cloudMonths, desktopMonths, desktopCountsAsTax, monthSpan, round2, sum } from './util.mjs';

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

function rateCheck(item, tax, months, wages) {
  if (item.calc.kind !== 'percent' || typeof tax.rate !== 'number') {
    return { status: 'not_comparable', desktop: item.calc.kind === 'percent' ? `${item.calc.rate}%` : `$${item.calc.amount} a year`, official: typeof tax.rate === 'number' ? `${tax.rate}%` : '—', difference: 0, months };
  }
  const diff = item.calc.rate - tax.rate;
  return {
    status: Math.abs(diff) < 0.0001 ? 'match' : diff > 0 ? 'over' : 'under',
    desktop: `${item.calc.rate}%`,
    official: `${tax.rate}%`,
    difference: round2((diff / 100) * wages * months.length),
    months,
  };
}

// The case as it stands after any expert and employer decisions.
export function effectiveCase(c, decisions, analysis) {
  const d = decisions.cases[c.case_id] ?? {};
  const employee = analysis.employees.find((e) => e.employee_id === c.employee_id);
  let route = c.route;
  let proposal = c.proposal;
  let entry = null;
  if (c.route === 'not_in_database' && d.expert) {
    const a = d.expert.action;
    if (a === 'map') {
      const tax = analysis.idx.taxes.get(d.expert.tax_id);
      const onList = employee.expected.list.find((e) => e.tax_id === tax.tax_id);
      const months = onList ? onList.months : [...desktopMonths(analysis.company), ...cloudMonths(analysis.company)];
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
      route = 'local_tax';
    } else if (a === 'not_a_tax') route = 'not_a_tax';
    else if (a === 'custom_entry') { route = 'custom_entry'; entry = d.expert.entry; }
    else if (a === 'stop') route = 'stop';
  }
  let stage;
  if (route === 'not_in_database') stage = 'with_expert';
  else if (!d.employer) stage = 'awaiting_employer';
  else stage = { local_tax: 'confirmed', not_a_tax: 'moved_to_deduction', custom_entry: 'employer_managed', stop: 'stopped' }[route];
  const verified = c.route === 'local_tax' && !d.expert && proposal.every((p) => p.rate.status === 'match');
  return { ...c, route, proposal, entry, stage, verified, decision: d, employee };
}

export function effectiveAll(analysis, decisions) {
  return analysis.cases.map((c) => effectiveCase(c, decisions, analysis));
}

export function gapStage(gap, decisions) {
  return decisions.gaps[gap.gap_id]?.action === 'add' ? 'added' : 'awaiting_employer';
}

// ---------- Taxes that will run on cloud paychecks ----------

export function liveTaxes(analysis, decisions) {
  const cloud = cloudMonths(analysis.company);
  const out = [];
  for (const c of effectiveAll(analysis, decisions)) {
    if (c.stage === 'confirmed') {
      for (const p of c.proposal) {
        const months = p.months.filter((m) => cloud.includes(m));
        if (months.length) out.push({ key: p.tax_id, tax: p.tax, employee: c.employee, months, rate: p.tax.rate, source: 'confirmed', case_id: c.case_id, item: c.item });
      }
    }
    if (c.stage === 'employer_managed' && c.entry) {
      out.push({ key: `CUSTOM:${c.case_id}`, tax: { tax_id: `CUSTOM:${c.case_id}`, name: c.entry.name, agency: c.entry.agency, type: c.entry.type, rate: c.entry.rate, flat: c.entry.flat, qb_pays_and_files: false, custom: true, basis: c.entry.basis }, employee: c.employee, months: cloud, rate: c.entry.rate, source: 'custom_entry', case_id: c.case_id, item: c.item });
    }
  }
  for (const g of analysis.gaps) {
    if (gapStage(g, decisions) !== 'added') continue;
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

export function dollarTieOut(analysis, decisions) {
  const rows = new Map(Object.entries(DESTINATION).map(([stage, label]) => [stage, { stage, label, amount: 0, count: 0 }]));
  let total = 0;
  for (const c of effectiveAll(analysis, decisions)) {
    if (!desktopCountsAsTax(c.item)) continue;
    total += c.ytd;
    const row = rows.get(c.stage);
    row.amount = round2(row.amount + c.ytd);
    row.count += 1;
  }
  const list = [...rows.values()].filter((r) => r.count);
  const waiting = rows.get('awaiting_employer').amount;
  return { total: round2(total), rows: list, waiting, accounted: round2(total - waiting) };
}

export function readiness(analysis, decisions) {
  const cases = effectiveAll(analysis, decisions);
  const waiting = cases.filter((c) => c.stage === 'awaiting_employer');
  const expert = cases.filter((c) => c.stage === 'with_expert');
  const openGaps = analysis.gaps.filter((g) => gapStage(g, decisions) !== 'added');
  const accounts = agencyAccounts(analysis, decisions);
  const tie = dollarTieOut(analysis, decisions);
  const checks = [
    { id: 'employer', label: 'Every item has the employer\'s decision', pass: waiting.length === 0, detail: waiting.length ? `${waiting.length} item${waiting.length === 1 ? '' : 's'} still waiting on the review screen.` : 'All decided.' },
    { id: 'gaps', label: 'Every expected tax with no Desktop item is handled', pass: openGaps.length === 0, detail: openGaps.length ? `${openGaps.length} expected tax${openGaps.length === 1 ? '' : 'es'} not yet added.` : 'None open.' },
    { id: 'dollars', label: 'Every Desktop local-tax dollar has a destination', pass: tie.waiting === 0, detail: `${usd(tie.accounted)} of ${usd(tie.total)} accounted for.` },
    { id: 'accounts', label: 'Account number and deposit frequency for every agency', pass: accounts.every((a) => a.complete), detail: !accounts.length ? 'No taxes confirmed yet.' : accounts.filter((a) => !a.complete).map((a) => `Missing for ${a.agency}`).join('; ') || 'All agencies complete.' },
  ];
  return { checks, ready: checks.every((c) => c.pass), expert, waiting, openGaps, accounts, tie };
}

// ---------- W-2 history (projected for the full year) ----------

export function w2Preview(analysis, decisions) {
  const dm = desktopMonths(analysis.company);
  const cm = cloudMonths(analysis.company);
  const byEmployee = new Map(analysis.employees.map((e) => [e.employee_id, { employee: e, lines: new Map(), notes: [] }]));
  const line = (emp, key, box20) => {
    if (!emp.lines.has(key)) emp.lines.set(key, { key, box20, wages: 0, desktop: 0, cloud: 0, months: [] });
    return emp.lines.get(key);
  };
  for (const c of effectiveAll(analysis, decisions)) {
    const emp = byEmployee.get(c.employee_id);
    const wages = c.employee.monthly_wages;
    if (c.stage === 'confirmed') {
      for (const p of c.proposal) {
        const past = p.months.filter((m) => dm.includes(m));
        const future = p.months.filter((m) => cm.includes(m));
        const l = line(emp, p.tax_id, p.tax.type === 'school_district' ? `SD ${p.tax.code} ${p.tax.name.replace(/ (City|Local) School District$/, '')}` : p.tax.name.replace(/^City of /, '').replace(/ income tax$/, ''));
        l.wages = round2(l.wages + wages * (past.length + future.length));
        l.desktop = round2(l.desktop + sum(c.ytdByMonth.filter((x) => past.includes(x.month)).map((x) => x.amount)));
        l.cloud = round2(l.cloud + (p.tax.rate / 100) * wages * future.length);
        l.months.push(...p.months);
        if (p.rate.status === 'over' || p.rate.status === 'under') emp.notes.push(`${p.tax.name}: Desktop withheld at ${p.rate.desktop} instead of ${p.rate.official} in ${monthSpan(p.rate.months)} (${p.rate.status === 'over' ? 'over' : 'under'} by ${usd(Math.abs(p.rate.difference))}). The W-2 shows what was actually withheld.`);
      }
    } else if (c.stage === 'employer_managed' && c.entry) {
      const l = line(emp, `CUSTOM:${c.case_id}`, c.entry.name);
      l.wages = round2(l.wages + wages * (dm.length + cm.length));
      l.desktop = round2(l.desktop + c.ytd);
      l.cloud = round2(l.cloud + (c.entry.flat ? (c.entry.flat / 12) * cm.length : ((c.entry.rate ?? 0) / 100) * wages * cm.length));
      l.employerManaged = true;
    } else if (c.stage === 'with_expert' || c.stage === 'awaiting_employer') {
      if (desktopCountsAsTax(c.item)) emp.notes.push(`"${c.item.label}" (${usd(c.ytd)} so far) is not on the W-2 yet: ${STAGE_LABEL[c.stage].toLowerCase()}.`);
    } else if (c.stage === 'stopped') {
      emp.notes.push(`"${c.item.label}": ${usd(c.ytd)} was withheld but is not owed. It stays off the W-2 until corrected with the agency.`);
    }
  }
  for (const g of analysis.gaps) {
    if (gapStage(g, decisions) !== 'added') continue;
    const emp = byEmployee.get(g.employee_id);
    const future = g.months.filter((m) => cm.includes(m));
    const l = line(emp, g.tax_id, g.tax.type === 'school_district' ? `SD ${g.tax.code} ${g.tax.name.replace(/ (City|Local) School District$/, '')}` : g.tax.name);
    l.wages = round2(l.wages + emp.employee.monthly_wages * future.length);
    l.cloud = round2(l.cloud + (g.tax.rate / 100) * emp.employee.monthly_wages * future.length);
    emp.notes.push(`${g.tax.name} starts with the first cloud payroll. Estimated back tax for ${monthSpan(g.pastMonths)}: ${usd(g.backTaxEstimate)}; discuss with the agency.`);
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
    if (c.stage === 'stopped') flags.push({ tone: 'warn', text: `${c.employee_name}: ${usd(c.ytd)} withheld in Desktop under "${c.item.label}" needs a correction with the agency.` });
    if (c.stage === 'employer_managed') flags.push({ tone: 'info', text: `${c.employee_name}: "${c.entry?.name}" is employer-managed. Confirm you paid and filed it.` });
    if (c.stage === 'confirmed') for (const p of c.proposal) if (p.rate.status === 'over' || p.rate.status === 'under') flags.push({ tone: 'warn', text: `${c.employee_name}: past ${p.tax.name} withholding was ${p.rate.status === 'over' ? 'over' : 'under'} by ${usd(Math.abs(p.rate.difference))}. New paychecks use the official ${p.rate.official}.` });
  }
  return {
    rows: [...rows.values()].map((r) => ({ ...r, employees: [...r.employees] })),
    flags,
    totals: { firstPayroll: sum([...rows.values()].map((r) => r.firstPayroll)), quarter: sum([...rows.values()].map((r) => r.quarter)) },
  };
}
