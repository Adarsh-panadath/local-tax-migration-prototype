export const FIELDS = ['record_id','company_id','source_item_id','item_name','item_kind','source_tax_code','jurisdiction_reference','tax_category','payer','rate_percent','effective_on'];
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  const cell = () => { row.push(value); value = ''; closed = false; };
  const end = () => { cell(); if (row.some(v => v.trim())) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i+1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; }
    else if (c === '"') { if (value || closed) throw new Error('Unexpected quote in CSV.'); quoted = true; }
    else if (c === ',') cell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; end(); }
    else { if (closed) throw new Error('Unexpected text after a quoted CSV field.'); value += c; }
  }
  if (quoted) throw new Error('A CSV quoted field is not closed.');
  if (value || row.length || closed) end();
  if (rows.length < 2) throw new Error('Add a header and at least one data row.');
  const headers = rows.shift().map(x => x.trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique.');
  if (FIELDS.some(f => !headers.includes(f)) || headers.some(h => !FIELDS.includes(h))) throw new Error('Use the columns in the downloadable CSV template.');
  return validateItems(rows.map((r, i) => { if (r.length !== headers.length) throw new Error(`CSV row ${i+2} has the wrong number of columns.`); return Object.fromEntries(headers.map((h,j) => [h,r[j]])); }));
}
export function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v; }
export function validateItems(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('Use between 1 and 2,000 records.');
  const ids = new Set();
  return rows.map((row, i) => {
    if (!row || typeof row !== 'object') throw new Error(`Row ${i+1} is invalid.`);
    const r = Object.fromEntries(FIELDS.map(k => [k, row[k] == null || row[k] === '' ? null : String(row[k]).trim()]));
    for (const k of ['record_id','company_id','source_item_id','item_name']) if (!r[k]) throw new Error(`Row ${i+1}: ${k} is required.`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(r.record_id) || ['constructor','prototype'].includes(r.record_id)) throw new Error(`Row ${i+1}: record_id must begin with a letter or digit and use only letters, digits, hyphens, or underscores (up to 80 characters).`);
    if (Object.values(r).some(v => v && v.length > 1000)) throw new Error(`Row ${i+1}: a field exceeds 1,000 characters.`);
    if (ids.has(r.record_id)) throw new Error(`Duplicate record_id: ${r.record_id}. Row IDs must be unique.`); ids.add(r.record_id);
    r.item_kind ||= 'unknown';
    if (!['tax','benefit_deduction','unknown'].includes(r.item_kind)) throw new Error(`Row ${i+1}: invalid item_kind.`);
    if (r.tax_category && !['school','municipal'].includes(r.tax_category)) throw new Error(`Row ${i+1}: invalid tax_category.`);
    if (r.payer && !['employee','employer'].includes(r.payer)) throw new Error(`Row ${i+1}: invalid payer.`);
    if (r.rate_percent !== null) { if (!/^\d+(\.\d+)?$/.test(r.rate_percent) || Number(r.rate_percent) > 100) throw new Error(`Row ${i+1}: rate must be a number from 0 to 100, or blank.`); r.rate_percent = Number(r.rate_percent); }
    if (r.effective_on && !validDate(r.effective_on)) throw new Error(`Row ${i+1}: use a valid YYYY-MM-DD date.`);
    return r;
  });
}
export function csvCell(value) { let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }
export function csv(rows, fields) { return [fields.map(csvCell).join(','), ...rows.map(r => fields.map(f => csvCell(r[f])).join(','))].join('\r\n'); }
export function makeReport(state, evaluated) {
  return { version: '0.1.0', exported_at: new Date().toISOString(), dataset: state.name, data_origin: state.origin || 'unknown', synthetic_demo: state.origin === 'bundled' ? true : null, fictional_catalog: true, ai_mode: 'simulated', purpose: 'Mapping preparation review only; not a QuickBooks import or payroll authorization.', counts: evaluated.reduce((a,r) => ({...a,[r.status]:(a[r.status]||0)+1}),{}), items: evaluated.map(r => ({ ...r, review_history: state.audit.filter(a => a.record_id === r.current.record_id) })) };
}
export function reportCSV(report) {
  const fields = [...FIELDS.map(f=>'original_'+f), ...FIELDS.map(f=>'current_'+f), 'status','mapped_target_id','candidate_ids','reason','checks','review_history'];
  const rows = report.items.map(r => ({ ...Object.fromEntries(FIELDS.map(f=>['original_'+f,r.original[f]])), ...Object.fromEntries(FIELDS.map(f=>['current_'+f,r.current[f]])), status:r.status, mapped_target_id:r.target?.target_id||null, candidate_ids:r.candidates.map(t=>t.target_id), reason:r.reason, checks:r.checks, review_history:r.review_history }));
  return csv(rows, fields);
}
