// Ask AI's facts, its built-in opinions and answers, and the format a real model is asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateBusinesses } from '../web/generate.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { effectiveAll, emptyDecisions } from '../web/engine/workflow.mjs';
import { lineFacts, gapFacts, lineOpinion, gapOpinion, answer, suggestions, opinionFormat, opinionText, RULES } from '../web/assistant.mjs';

const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const [catalog, geocoder, pool] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json'].map(read));
const generated = generateBusinesses(catalog, { count: 1 });
const lookup = [...geocoder.addresses, ...generated.addresses];
const data = { catalog, geocoder: { ...geocoder, addresses: lookup }, pools: pool.pools };
const byId = new Map(lookup.map((a) => [a.address_id, a]));
const addressById = (id) => byId.get(id);
const taxByLaw = (law) => catalog.states.OH.taxes.find((t) => t.law_id === law);

// ---------- the assistant on Buckeye's lines ----------

const buckeye = analyseCompany(generated.companies[0], data);
const cases = effectiveAll(buckeye, emptyDecisions());
const facts = (c, view = 'review') => lineFacts(c, { company: buckeye.company, addressById, taxByLaw, view, stage: c.stage, next: 'Next step text.', decided: '' });
const find = (pred) => { const c = cases.find(pred); assert.ok(c); return c; };

test('the built-in opinion follows the engine: confirm, add the address, stop, or ask the employer', () => {
  const ok = find((c) => c.route === 'local_tax' && c.verified);
  const op1 = lineOpinion(facts(ok), ok);
  assert.match(op1.recommendation, /^Confirm: /);
  assert.equal(op1.confidence, 'high');
  assert.ok(op1.recommendation.includes(String(ok.proposal[0].tax.law_id)));

  const noAddr = find((c) => c.reason === 'no_address');
  assert.match(lineOpinion(facts(noAddr), noAddr).recommendation, /home address first/);
  // Without an address the assistant must not claim there is no school-district tax.
  assert.match(answer(facts(noAddr), 'Why is the address needed?'), /cannot be chosen yet/);

  const notOwed = find((c) => c.reason === 'not_expected');
  const op3 = lineOpinion(facts(notOwed), notOwed);
  assert.match(op3.recommendation, /^Stop withholding/);
  assert.ok(op3.check.includes(facts(notOwed).desktop_line.withheld_this_year_in_desktop));

  const weak = find((c) => c.reason === 'weak_signal');
  assert.equal(lineOpinion(facts(weak, 'expert'), weak).confidence, 'low');
});

test('built-in answers come from the facts, and an unknown question gets no made-up answer', () => {
  const c = find((x) => x.route === 'local_tax' && x.proposal.some((p) => p.rate.status === 'over' || p.rate.status === 'under'));
  const f = facts(c);
  assert.match(answer(f, 'Is the rate right?'), /instead of/);
  assert.match(answer(f, 'What does Law ID 177 mean?'), /unique number of each tax/);
  assert.match(answer(f, 'What if they move?'), /school-district tax follows the new home/);
  assert.match(answer(f, 'Does a visa change it?'), /nationality or visa does not change/);
  assert.equal(answer(f, 'zzz qqq'), null);
  for (const q of suggestions(f, c)) assert.ok(answer(f, q), q);
});

test('a missing tax has its own opinion and answers', () => {
  const g = buckeye.gaps[0];
  const e = buckeye.employees.find((x) => x.employee_id === g.employee_id);
  const gf = gapFacts(g, e, { company: buckeye.company, addressById, view: 'review', stage: 'Waiting for the employer', next: 'Add it.' });
  assert.match(gapOpinion(gf).recommendation, new RegExp(`Law ID ${g.tax.law_id}`));
  for (const q of suggestions(gf)) assert.ok(answer(gf, q), q);
  assert.match(opinionFormat(gf), /missing tax/);
});

test('a work-location question explains both answers, and a real model is asked for the same shape', () => {
  const c = find((x) => x.reason === 'work_location');
  const f = facts(c);
  const w = f.engine.work_question;
  assert.ok(w, 'the facts say what each answer means');
  assert.match(w.desktop_withholds, /City of Columbus income tax/);
  assert.match(w.work_site_tax, /City of Lancaster income tax/);
  const op = lineOpinion(f, c);
  assert.match(op.recommendation, /^Tell us where .* works/);
  assert.equal(op.confidence, 'low');
  assert.match(answer(f, 'What if they work from home?'), /From home: City of Columbus income tax is owed/);
  for (const q of suggestions(f, c)) assert.ok(answer(f, q), q);
  // The facts are small enough to send with every chat question.
  assert.ok(new TextEncoder().encode(JSON.stringify(f)).length < 32_000);
  assert.match(opinionFormat(f), /Recommendation:/);
  assert.match(RULES, /where the work is DONE/);
  // The built-in opinion has the same shape a real model is asked for.
  assert.match(opinionText(lineOpinion(f, c)), /^Recommendation: .*\nConfidence: (high|medium|low): .*\nWhy:\n- /);
});
