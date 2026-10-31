// A complete migration report: every Desktop line, its route, its outcome, and the evidence behind it.
import { MODEL_VERSION } from './engine/cluster.mjs?v=9d0383a0d7';
import { effectiveAll, gapStage, readiness, w2Preview, reconcile, STAGE_LABEL } from './engine/workflow.mjs?v=9d0383a0d7';
import { monthSpan } from './engine/util.mjs?v=9d0383a0d7';

export function buildReport(analysis, decisions, audit) {
  const cases = effectiveAll(analysis, decisions);
  const ready = readiness(analysis, decisions);
  return {
    generated_at: new Date().toISOString(),
    prototype: 'BRD v3 local-tax migration prototype (academic demo; fictional people and companies)',
    model_version: MODEL_VERSION,
    company: { id: analysis.company.company_id, name: analysis.company.name, plan: analysis.company.plan },
    data_issues: (analysis.dataIssues ?? []).map((i) => i.text),
    models: Object.values(analysis.models).map((m) => ({
      state: m.state, mode: m.mode, forced_shadow: m.forced, silhouette: Number(m.silhouette.toFixed(3)),
      precision: Number(m.precision.toFixed(3)), coverage: Number(m.coverage.toFixed(3)), labelled_sample: m.poolSize, gates: m.gates,
    })),
    cases: cases.map((c) => ({
      case_id: c.case_id,
      employee: c.employee_name,
      desktop_item: { label: c.item.label, law_id: c.item.law_id, origin: c.item.origin, tracking_type: c.item.tracking_type, rate: c.item.calc, ytd: c.ytd },
      state: c.state,
      initial_route: analysis.cases.find((x) => x.case_id === c.case_id).route,
      route: c.route,
      stage: c.stage,
      stage_label: STAGE_LABEL[c.stage],
      proposal: c.proposal.map((p) => ({ tax_id: p.tax_id, name: p.tax.name, months: monthSpan(p.months), rate_check: p.rate })),
      custom_entry: c.entry ?? null,
      model_suggestion: c.model ? { entry: c.model.entry_label, confidence: c.model.confidence, item_silhouette: Number(c.model.item_silhouette.toFixed(3)), shown_to_employer: c.model.shown } : null,
      evidence: c.evidence.map((e) => e.text),
      decision: c.decision,
    })),
    gaps: analysis.gaps.map((g) => ({ employee: g.employee_name, tax: g.tax.name, months: monthSpan(g.months), back_tax_estimate: g.backTaxEstimate, stage: gapStage(g, decisions, cases) })),
    readiness: ready.checks,
    dollar_tie_out: ready.tie,
    live: decisions.live,
    w2_preview: w2Preview(analysis, decisions).map((w) => ({ employee: w.employee.name, lines: w.lines.map((l) => ({ box18_local_wages: l.wages, box19_local_tax: l.total, box20_locality: l.box20, desktop_part: l.desktop, online_part: l.cloud })), notes: w.notes })),
    reconciliation: decisions.reconciled ? reconcile(analysis, decisions) : null,
    audit: audit.filter((a) => a.company_id === analysis.company.company_id),
  };
}

const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheet formulas from running
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function casesCSV(report) {
  const header = ['employee', 'desktop_label', 'law_id', 'ytd', 'state', 'initial_route', 'route', 'stage', 'proposed_tax', 'rate_check', 'model_suggestion'];
  const rows = report.cases.map((c) => [
    c.employee, c.desktop_item.label, c.desktop_item.law_id, c.desktop_item.ytd, c.state, c.initial_route, c.route, c.stage_label,
    c.proposal.map((p) => `${p.name} (${p.months})`).join('; ') || c.custom_entry?.name || '',
    c.proposal.map((p) => p.rate_check.status).join('; '),
    c.model_suggestion ? `${c.model_suggestion.entry ?? 'none'} (${c.model_suggestion.confidence})` : '',
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}
