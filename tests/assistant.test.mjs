// The AI assistant (facts, built-in opinion and answers, prompts for Claude) and the Use cases screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateBusinesses } from '../web/generate.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { automate, effectiveAll, emptyDecisions, DEFAULT_POLICY } from '../web/engine/workflow.mjs';
import { USE_CASES, useCaseCompany } from '../web/usecases.mjs';
import { lineFacts, gapFacts, personFacts, lineOpinion, gapOpinion, personOpinion, answer, suggestions, opinionPrompt, chatTurns, opinionText } from '../web/assistant.mjs';

const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const [catalog, geocoder, pool] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json'].map(read));
const generated = generateBusinesses(catalog, { count: 1 });
const lookup = [...geocoder.addresses, ...generated.addresses];
const data = { catalog, geocoder: { ...geocoder, addresses: lookup }, pools: pool.pools };
const byId = new Map(lookup.map((a) => [a.address_id, a]));
const addressById = (id) => byId.get(id);
const taxByLaw = (law) => catalog.states.OH.taxes.find((t) => t.law_id === law);

// ---------- use cases ----------

const ucCompany = useCaseCompany(lookup);
const uc = analyseCompany(ucCompany, data);
const ucCases = effectiveAll(uc, automate(uc, emptyDecisions(), DEFAULT_POLICY).decisions);
const expected = (i) => uc.employees[i].expected.list.map((x) => `${x.tax.law_id}:${x.months[0]}-${x.months.at(-1)}`).sort();

test('the six use cases owe the taxes their stories say', () => {
  assert.equal(uc.employees.length, USE_CASES.length);
  assert.deepEqual(expected(0), ['4120:1-12', '5305:1-12']); // lives and works in Lancaster: city + school district
  assert.deepEqual(expected(1), ['4140:1-12', '5307:1-12']); // lives in Pickerington, works in Columbus
  assert.deepEqual(expected(2), ['4140:6-12']); // arrived in June, Columbus: city tax only, from June
  assert.deepEqual(expected(3), ['4120:1-12', '5304:7-12', '5305:1-6']); // moved Lancaster to Bremen in July
  assert.deepEqual(expected(4), ['4140:1-12']); // works from home in Columbus: Columbus, not Lancaster
  assert.deepEqual(expected(5), ['4140:1-12']); // Columbus: no school-district tax
});

test('the migration settles each use case as the screen describes', () => {
  const stages = (i) => ucCases.filter((c) => c.employee_id === uc.employees[i].employee_id).map((c) => `${c.item.label}:${c.stage}`);
  assert.ok(stages(5).includes('Lancaster Schools:stopped'), stages(5).join());
  const moved = ucCases.find((c) => c.employee_id === uc.employees[3].employee_id && c.item.label === 'SD Tax');
  assert.equal(moved.stage, 'confirmed');
  assert.deepEqual(moved.proposal.map((p) => [p.tax.law_id, p.rate.status]), [[5305, 'match'], [5304, 'under']]);
  const remote = ucCases.find((c) => c.employee_id === uc.employees[4].employee_id);
  assert.deepEqual(remote.proposal.map((p) => p.tax.law_id), [4140]);
  assert.equal(remote.proposal[0].rate.status, 'under');
  assert.equal(uc.gaps.length, 0);
});

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

test('a missing tax and a use-case person have their own opinions and answers', () => {
  const g = buckeye.gaps[0];
  const e = buckeye.employees.find((x) => x.employee_id === g.employee_id);
  const gf = gapFacts(g, e, { company: buckeye.company, addressById, view: 'review', stage: 'Waiting for the employer', next: 'Add it.' });
  assert.match(gapOpinion(gf).recommendation, new RegExp(`Law ID ${g.tax.law_id}`));
  for (const q of suggestions(gf)) assert.ok(answer(gf, q), q);

  const pf = { person: personFacts(uc.employees[2], uc.company, addressById) };
  assert.match(personOpinion(pf.person).recommendation, /City of Columbus income tax \(Jun–Dec\)/);
  assert.match(answer(pf, 'Why no school-district tax?'), /no school-district tax/);
  for (const q of suggestions(pf)) assert.ok(answer(pf, q), q);
});

test('the prompts for Claude carry the facts and the rules, and a chat starts and ends with the user', () => {
  const c = find((x) => x.reason === 'weak_signal');
  const f = facts(c, 'expert');
  const prompt = opinionPrompt(f);
  assert.match(prompt, /Use ONLY the facts below/);
  assert.match(prompt, /Recommendation:/);
  assert.ok(prompt.includes(c.employee_name));
  assert.ok(new TextEncoder().encode(prompt).length < 32_000, 'well under the 256 KiB limit');
  const turns = chatTurns(f, 'Recommendation: x', [{ q: 'first?', a: 'one' }], 'second?');
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(turns.at(-1).content, /^second\?/);
  // The built-in opinion has the same shape Claude is asked for.
  assert.match(opinionText(lineOpinion(f, c)), /^Recommendation: .*\nConfidence: (high|medium|low): .*\nWhy:\n- /);
});
