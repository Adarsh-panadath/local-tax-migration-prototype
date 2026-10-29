export const LABELS = {
  ready_for_demo_mapping: 'Ready', reviewed_mapping: 'Reviewed', suggestion_only: 'Suggestion',
  needs_information: 'Missing information', conflict: 'Conflict', unsupported: 'Unsupported',
  duplicate_review: 'Duplicate review', excluded_non_tax: 'Non-tax item', excluded_duplicate: 'Duplicate excluded'
};
export const READY = new Set(['ready_for_demo_mapping', 'reviewed_mapping']);
export const EXCLUDED = new Set(['excluded_non_tax', 'excluded_duplicate']);
export const CORE = ['jurisdiction_reference', 'payer', 'rate_percent', 'effective_on'];
export const FIELD_LABELS = {
  jurisdiction_reference: 'Jurisdiction', payer: 'Payer', rate_percent: 'Rate', effective_on: 'Effective date',
  tax_category: 'Category', source_tax_code: 'Source tax code', item_kind: 'Item type'
};
const absent = x => x === null || x === undefined || x === '';
const identity = r => JSON.stringify([r.company_id, r.source_item_id, r.effective_on]);
export function currentRows(state) { return state.originals.map(r => ({ ...r, ...state.overrides[r.record_id] })); }
export function compatible(r, t) {
  return ['jurisdiction_reference', 'payer', 'rate_percent', 'tax_category'].every(k => absent(r[k]) || r[k] === t[k])
    && (absent(r.effective_on) || (r.effective_on >= t.effective_from && r.effective_on <= t.effective_to));
}
export function evaluate(r, rows, catalog, decisions = {}) {
  const checks = [];
  const add = (label, state, detail) => checks.push({ label, state, detail });
  let candidates = catalog.filter(t => compatible(r, t));
  let target = null;
  const finish = (status, reason) => ({ status, reason, candidates, target, checks, ai_mode: 'simulated' });
  const decision = decisions[r.record_id];
  if (decision?.excludedDuplicate) {
    if (!rows.some(x => x.record_id === decision.duplicateOf && identity(x) === identity(r) && !decisions[x.record_id]?.excludedDuplicate)) {
      add('Duplicate disposition', 'fail', 'The retained occurrence changed or is no longer available. Reopen the review.');
      return finish('conflict', 'The recorded duplicate exclusion no longer has a matching retained occurrence. Restore the original review state and verify both records.');
    }
    add('Duplicate disposition', 'pass', 'Excluded after recorded review; the source row remains in the report.');
    return finish('excluded_duplicate', 'A reviewer marked this occurrence as a duplicate. The original is preserved.');
  }
  const duplicates = rows.filter(x => identity(x) === identity(r) && !decisions[x.record_id]?.excludedDuplicate);
  const duplicate = duplicates.length > 1;
  add('Source identity', duplicate ? 'fail' : 'pass', duplicate ? `Shared with ${duplicates.filter(x => x.record_id !== r.record_id).map(x => x.record_id).join(', ')}.` : 'One active occurrence of this company, item, and date.');
  if (r.item_kind === 'benefit_deduction') {
    candidates = [];
    add('Item type', 'pass', 'Declared benefit deduction; retained outside tax mapping.');
    return finish(duplicate ? 'duplicate_review' : 'excluded_non_tax', 'This declared benefit deduction is outside the tax-mapping workflow.');
  }
  const known = catalog.find(t => t.source_code_aliases.includes(r.source_tax_code));
  const unknownCode = !absent(r.source_tax_code) && !known;
  add('Source code', known ? 'pass' : 'missing', known ? `Catalog identifies ${known.target_id}.` : unknownCode ? 'The supplied code is not in the demo crosswalk.' : 'No source identifier supplied. Any match remains a proposal.');
  const missing = CORE.filter(k => absent(r[k]));
  if (r.item_kind !== 'tax') missing.push('item_kind');
  let conflict = false;
  if (known) {
    const plausible = candidates;
    candidates = [known, ...plausible.filter(t => t.target_id !== known.target_id)];
    for (const field of [...CORE, 'tax_category']) {
      const missingValue = absent(r[field]);
      const agrees = field === 'effective_on' ? r[field] >= known.effective_from && r[field] <= known.effective_to : r[field] === known[field];
      if (!missingValue && !agrees) conflict = true;
      add(FIELD_LABELS[field], missingValue ? 'missing' : agrees ? 'pass' : 'fail', missingValue ? 'Not supplied.' : agrees ? 'Agrees with the identified catalog entry.' : `Source ${r[field]} conflicts with ${field === 'effective_on' ? known.effective_from + ' to ' + known.effective_to : known[field]}.`);
    }
    add('Destination support', known.supported ? 'pass' : 'fail', known.supported ? 'Supported by this fictional catalog.' : 'Unavailable in this demo destination.');
  } else {
    for (const field of CORE) add(FIELD_LABELS[field], absent(r[field]) ? 'missing' : 'pass', absent(r[field]) ? 'Required evidence is missing.' : 'Supplied; used to narrow the demo catalog.');
  }
  if (duplicate) return finish('duplicate_review', 'Multiple rows share one source identity. Review both occurrences before mapping.');
  if (unknownCode) return finish('needs_information', 'The source tax code is unknown. Resolve the identifier before selecting a destination.');
  if (conflict) return finish('conflict', 'The source fields disagree with the identified catalog entry. Correct the evidence before continuing.');
  if (missing.length || (known && absent(r.tax_category))) return finish('needs_information', `Supply ${[...missing, ...(known && absent(r.tax_category) ? ['tax_category'] : [])].map(k => FIELD_LABELS[k]).join(', ').toLowerCase()} to continue.`);
  if (known) {
    candidates = [known];
    if (!known.supported) return finish('unsupported', 'The item is identified, but this demo destination does not support it.');
    target = known;
    return finish('ready_for_demo_mapping', 'The identifier and required fields agree with one supported demo destination.');
  }
  if (!candidates.length) return finish('needs_information', 'No catalog entry agrees with the available evidence. More information or a different reference is needed.');
  const supported = candidates.filter(t => t.supported);
  if (!supported.length) return finish('unsupported', 'The compatible demo destinations are unsupported.');
  if (decision?.acceptedTarget && !absent(r.tax_category)) {
    const approved = supported.find(t => t.target_id === decision.acceptedTarget);
    if (approved && supported.length === 1) {
      target = approved;
      add('Recorded review', 'pass', decision.evidence);
      return finish('reviewed_mapping', 'A reviewer accepted this proposal after supplying complete compatible evidence.');
    }
  }
  // Demonstration ranking only. This is not an AI model, calibrated confidence,
  // authoritative interpretation, or a source of facts for the validation rules.
  const name = r.item_name.toLowerCase();
  const inferred = /school|\bsd\b/.test(name) ? 'school' : /city|town|municipal/.test(name) ? 'municipal' : null;
  candidates.sort((a, b) => Number(b.tax_category === inferred) - Number(a.tax_category === inferred));
  if (supported.length > 1 && !inferred) return finish('needs_information', 'Several destinations remain possible. Supply the distinguishing category or jurisdiction evidence.');
  return finish('suggestion_only', inferred && absent(r.tax_category) ? `Simulated label interpretation suggests ${inferred}. Verify the category and review the evidence.` : 'The available evidence suggests a destination, but no recognized source identifier establishes an automatic match.');
}
export function evaluateAll(state, catalog) {
  const rows = currentRows(state);
  return rows.map(r => ({ original: state.originals.find(o => o.record_id === r.record_id), current: r, ...evaluate(r, rows, catalog, state.decisions) }));
}
export function recordChange(state, id, action, evidence, patch = {}, targetId = null, catalog = []) {
  if (!evidence?.trim()) throw new Error('Add the evidence or reason for this review action.');
  const original = state.originals.find(r => r.record_id === id);
  if (!original) throw new Error('Record not found.');
  const next = structuredClone(state);
  const before = { fields: { ...original, ...next.overrides[id] }, decision: next.decisions[id] || null };
  if (action === 'edit') { next.overrides[id] = { ...next.overrides[id], ...patch }; delete next.decisions[id]; }
  else if (action === 'restore') { delete next.overrides[id]; delete next.decisions[id]; }
  else if (action === 'accept') {
    const rows = currentRows(next), r = rows.find(x => x.record_id === id);
    const result = evaluate(r, rows, catalog, next.decisions);
    const candidates = result.candidates.filter(t => t.supported && compatible(r, t));
    if (result.status !== 'suggestion_only' || absent(r.tax_category) || candidates.length !== 1 || candidates[0].target_id !== targetId) throw new Error('Verify the category and resolve all missing or conflicting facts before accepting one supported proposal.');
    next.decisions[id] = { acceptedTarget: targetId, evidence: evidence.trim() };
  } else if (action === 'exclude_duplicate') {
    const rows = currentRows(next), r = rows.find(x => x.record_id === id);
    if (evaluate(r, rows, catalog, next.decisions).status !== 'duplicate_review') throw new Error('This item is not an unresolved duplicate.');
    const counterpart = rows.find(x => x.record_id !== id && identity(x) === identity(r) && !next.decisions[x.record_id]?.excludedDuplicate);
    next.decisions[id] = { excludedDuplicate: true, duplicateOf: counterpart.record_id, evidence: evidence.trim() };
  } else throw new Error('Unknown action.');
  next.audit.push({ id: next.audit.length + 1, record_id: id, action, evidence: evidence.trim(), at: new Date().toISOString(), before, after: { fields: { ...original, ...next.overrides[id] }, decision: next.decisions[id] || null } });
  return next;
}
