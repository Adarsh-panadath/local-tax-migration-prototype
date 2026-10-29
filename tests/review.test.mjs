import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAll, recordChange } from '../web/engine.mjs';
import { validateItems, parseCSV, csv, FIELDS, makeReport, reportCSV, csvCell } from '../web/io.mjs';
const read = async p => JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
const {items}=await read('../data/sample-items.json');
const {targets}=await read('../data/demo-catalog.json');
const {cases}=await read('../evaluation/expected-results.json');
const fresh=()=>({originals:validateItems(structuredClone(items)),overrides:{},decisions:{},audit:[],name:'Test sample',origin:'bundled'});
const result=(s,id)=>evaluateAll(s,targets).find(r=>r.current.record_id===id);
for(const c of cases) test(`${c.record_id}: ${c.scenario}`,()=>{
 const r=result(fresh(),c.record_id);
 assert.equal(r.status,c.expected_status);
 assert.equal(r.target?.target_id||null,c.expected_target_id);
 assert.ok(c.acceptable_candidate_ids.every(id=>r.candidates.some(t=>t.target_id===id)));
});
test('Missing jurisdiction resolves to a proposal, then a reviewed mapping with preserved originals',()=>{
 const original=fresh();let s=recordChange(original,'R006','edit','Fictional district certificate identifies Alpha.',{jurisdiction_reference:'DEMO-ALPHA'},null,targets);
 assert.equal(result(s,'R006').status,'suggestion_only');
 assert.equal(s.originals.find(r=>r.record_id==='R006').jurisdiction_reference,null);
 assert.equal(original.audit.length,0);
 s=recordChange(s,'R006','accept','Verified the fictional Alpha school category and context.',{},'DEMO-TAX-001',targets);
 assert.equal(result(s,'R006').status,'reviewed_mapping');assert.equal(s.audit.length,2);
 assert.equal(result(s,'R006').current.source_tax_code,null);
});
test('A click cannot bypass contradictions, unknown identifiers, unsupported entries, or inferred categories',()=>{
 for(const id of ['R004','R008','R009','R010','R012','R013','R016']) assert.throws(()=>recordChange(fresh(),id,'accept','Checked',{},'DEMO-TAX-001',targets));
});
test('Empty evidence is rejected',()=>assert.throws(()=>recordChange(fresh(),'R006','edit',' ',{jurisdiction_reference:'DEMO-ALPHA'},null,targets)));
test('Duplicate review retains both rows and invalidates a stale exclusion',()=>{
 let s=recordChange(fresh(),'R015','exclude_duplicate','Confirmed a repeated source export.',{},null,targets);
 assert.equal(result(s,'R014').status,'ready_for_demo_mapping');assert.equal(result(s,'R015').status,'excluded_duplicate');
 assert.equal(makeReport(s,evaluateAll(s,targets)).items.length,20);
 s=recordChange(s,'R014','edit','Correcting the fictional source effective date.',{effective_on:'2026-11-01'},null,targets);
 assert.equal(result(s,'R015').status,'conflict');
});
test('Restoring originals retains the review history and reopens unresolved evidence',()=>{
 let s=recordChange(fresh(),'R006','edit','District evidence',{jurisdiction_reference:'DEMO-ALPHA'},null,targets);
 s=recordChange(s,'R006','restore','Retracting the unverified correction.',{},null,targets);
 assert.equal(result(s,'R006').status,'needs_information');assert.equal(s.audit.length,2);
});
test('CSV round-trip supports commas, quotes, and embedded newlines; zero stays zero',()=>{
 const rows=structuredClone(items);rows[0].item_name='School, "special"\nwithholding';
 const parsed=parseCSV(csv(rows,FIELDS));assert.equal(parsed[0].item_name,rows[0].item_name);assert.equal(parsed[19].rate_percent,0);
});
test('CSV rejects malformed rows, duplicate row IDs, dangerous keys, bad rates and dates',()=>{
 assert.throws(()=>parseCSV('a,b\n"not closed'));
 assert.throws(()=>parseCSV('a,a\n1,2'));
 assert.throws(()=>validateItems([{...items[0],rate_percent:'oops'}]));
 assert.throws(()=>validateItems([{...items[0],effective_on:'2026-02-30'}]));
 assert.throws(()=>validateItems([{...items[0],record_id:'__proto__'}]));
 assert.throws(()=>validateItems([items[0],items[0]]));
});
test('Spreadsheet formula prefixes are neutralized, while JSON preserves original text',()=>{
 for(const x of ['=HYPERLINK("x")','+SUM(1)','-1+2','@cmd',' \t=cmd'])assert.ok(csvCell(x).startsWith('"\''));
 const s=fresh();s.originals[0].item_name='=bad';const report=makeReport(s,evaluateAll(s,targets));
 assert.equal(report.items[0].original.item_name,'=bad');assert.ok(reportCSV(report).includes("'=bad"));
});
test('Reports contain all records, original and current fields, review evidence, and explicit simulation metadata',()=>{
 const s=fresh();const r=makeReport(s,evaluateAll(s,targets));
 assert.equal(r.items.length,20);assert.equal(new Set(r.items.map(x=>x.original.record_id)).size,20);
 assert.equal(r.ai_mode,'simulated');assert.equal(r.synthetic_demo,true);assert.equal(r.items.find(x=>x.original.record_id==='R011').status,'excluded_non_tax');
 assert.equal(makeReport({...s,origin:'uploaded'},evaluateAll(s,targets)).synthetic_demo,null);
 assert.equal(reportCSV(r).split('\r\n').length,21);
 assert.ok(reportCSV(r).split('\r\n')[0].includes('"ai_mode"'));
 assert.ok(reportCSV(r).split('\r\n').slice(1).every(line=>line.includes('"simulated"')));
});
