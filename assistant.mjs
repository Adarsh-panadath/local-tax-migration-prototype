// What Ask AI knows about a record: its opinion on one Desktop line, a missing tax or a person, and the
// answers to common questions.
//
// Everything it says comes from one facts brief, built here from the engine's own results. Two answerers
// read the same brief:
//   - a real model (Claude in the hosted app on claude.ai, or one connected with the user's own key);
//   - the built-in assistant, which composes its answers from the brief with fixed rules.
// Neither may invent a rate, an address or a rule: the chat's prompt tells the model to use only the facts,
// and the built-in assistant has nothing else to use. The employer still confirms every line.
import { monthSpan } from './engine/util.mjs?v=78d5a71636';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => usd.format(Number(n) || 0);
const rate = (r) => `${Number(r).toFixed(2)}%`;
const isCustom = (law) => Number(law) === 177 || Number(law) === 0;
const kindOf = (t) => (t.type === 'school_district' ? 'school-district tax' : 'city tax');
const first = (name) => String(name).split(' ')[0];
const span = (months) => monthSpan(months) || 'no months';
const BASIS = { home: 'home address', work: 'work location', home_office: 'home office (works from home)' };

// ---------- facts ----------

/** Who the person is, where they live and work, and the local taxes the engine expects for them. */
export function personFacts(e, company, addressById) {
  const ex = e.expected;
  const site = company.worksites.find((w) => w.site_id === e.site_id);
  const work = site ? addressById(site.address_id) : null;
  const where = (a) => (a ? `${a.line1}, ${a.city}` : 'unknown');
  const homes = (ex.periods ?? []).map((p) => {
    const a = addressById(p.address_id);
    const code = String(a?.school_district ?? '');
    const sd = /^\d+$/.test(code) ? code : !a || code === 'UNRESOLVED' || a.missing ? 'unknown' : 'none';
    return { address: where(a), town: a?.city ?? 'unknown', school_district: sd, months: span(p.months) };
  });
  const employed = ex.employed ?? [];
  return {
    name: e.name,
    monthly_wages: money(e.monthly_wages),
    on_this_payroll: span(employed),
    works_at: site ? `${site.name}, ${where(work)}` : 'unknown',
    works_from_home: Boolean(ex.remote),
    homes: homes.length ? homes : 'no home address on file',
    expected_local_taxes: ex.list.map((x) => ({
      law_id: x.tax.law_id,
      tax: x.tax.name,
      kind: kindOf(x.tax),
      ...(x.required === false ? { optional: 'courtesy withholding for the home town; not required' } : {}),
      rate: rate(x.tax.rate),
      months: span(x.months),
      owed_because_of: x.basis === 'home' ? BASIS.home : ex.remote ? BASIS.home_office : BASIS.work,
      address: where(x.address),
      estimated_for_the_year: money((e.monthly_wages * x.tax.rate * x.months.length) / 100),
    })),
    engine_notes: (ex.notes ?? []).map((n) => n.text),
  };
}

/** One Desktop line: the person, the line, what the engine found, and where the line stands. */
export function lineFacts(c, { company, addressById, taxByLaw, view, stage, next, decided }) {
  const item = c.item;
  const named = isCustom(item.law_id) ? null : taxByLaw(item.law_id);
  const result = {
    local_tax: `becomes ${c.proposal.map((p) => `${p.tax.name} (Law ID ${p.tax.law_id})`).join(' then ')} in Online payroll`,
    not_a_tax: 'is not a tax: it moves to deductions', not_in_database: 'waits for a person: the rules could not settle it',
    custom_entry: 'becomes an employer-managed custom tax', stop: 'stops: withholding ends',
  }[c.route] ?? c.route;
  return {
    viewer: view === 'expert' ? 'payroll tax expert' : 'employer',
    person: personFacts(c.employee, company, addressById),
    desktop_line: {
      label: item.label,
      law_id: item.law_id,
      law_id_means: isCustom(item.law_id) ? 'the employer created this item, so it names no tax' : `it names ${named?.name ?? 'a defined tax'}`,
      desktop_setup: `${item.item_type}, tracking type "${item.tracking_type}"`,
      desktop_rate: item.calc.kind === 'percent' ? rate(item.calc.rate) : `${money(item.calc.amount)} a year`,
      withheld_this_year_in_desktop: money(c.ytd),
    },
    engine: {
      result,
      reason: c.reasonText,
      proposed_online_taxes: c.proposal.map((p) => ({
        law_id: p.tax.law_id,
        tax: p.tax.name,
        rate: rate(p.tax.rate),
        months: span(p.months),
        owed_because_of: p.basis === 'home' ? BASIS.home : c.employee.expected.remote ? BASIS.home_office : BASIS.work,
        rate_check: !p.rate || p.rate.status === 'match' ? 'Desktop rate matches the official rate'
          : p.rate.status === 'over' || p.rate.status === 'under' ? `Desktop withheld ${p.rate.desktop} instead of ${p.rate.official} (${p.rate.status} by ${money(Math.abs(p.rate.difference))} so far)`
            : 'no Desktop months to compare',
      })),
      label_model: c.model ? {
        nearest_cluster: c.model.entry_label ?? 'a cluster with no defined name',
        label_confidence: Number(c.model.item_silhouette ?? 0).toFixed(2),
        confident: c.model.confidence === 'high',
        minimum_for_confident: '0.25',
      } : (isCustom(item.law_id) ? null : 'not needed: the Law ID names the tax'),
      not_owed_amount_to_correct: c.reason === 'not_expected' ? money(c.ytd) : c.unowed?.amount ? money(c.unowed.amount) : null,
      ...(c.reason === 'work_location' ? { work_question: workQuestion(c) } : {}),
      steps: c.evidence.map((x) => `Step ${x.step ?? '-'}: ${x.text}`),
    },
    status: { stage, next_step: next, decisions_so_far: decided || 'none' },
  };
}

// Desktop withholds the home town's city tax, not the work site's: what each answer of the employer means.
function workQuestion(c) {
  const home = c.workProposal?.[0]?.tax;
  const work = c.employee.expected.list.find((x) => x.required && x.basis === 'work' && x.tax.type === 'municipal')?.tax;
  if (!home || !work) return null;
  return {
    desktop_withholds: `${home.name} (Law ID ${home.law_id}, ${rate(home.rate)}), the tax of the town where the person lives`,
    work_site_tax: `${work.name} (Law ID ${work.law_id}, ${rate(work.rate)})`,
    if_works_from_home: `${home.name} is owed, and this line maps to it`,
    if_works_at_the_site: `${work.name} is owed and was not withheld, so it is added; this line becomes optional courtesy withholding for ${home.place}`,
  };
}

/** A tax the addresses say is owed but no Desktop item withholds. */
export function gapFacts(g, e, { company, addressById, view, stage, next }) {
  return {
    viewer: view === 'expert' ? 'payroll tax expert' : 'employer',
    person: personFacts(e, company, addressById),
    missing_tax: {
      law_id: g.tax.law_id,
      tax: g.tax.name,
      rate: rate(g.tax.rate),
      owed_because_of: g.basis === 'home' ? BASIS.home : e.expected.remote ? BASIS.home_office : BASIS.work,
      months_with_nothing_withheld_in_desktop: span(g.pastMonths),
      online_months_to_withhold: span(g.cloudMonths),
      estimated_back_tax: money(g.backTaxEstimate),
    },
    status: { stage, next_step: next },
  };
}

/** The built-in opinion for a missing tax. */
export function gapOpinion(f) {
  const t = f.missing_tax;
  const who = first(f.person.name);
  const back = Number(String(t.estimated_back_tax).replace(/[$,]/g, '')) > 0;
  if (f.status.stage !== 'Waiting for the employer') {
    return {
      recommendation: `Nothing left to decide: ${f.status.stage.toLowerCase()}.`, confidence: 'high', because: 'a decision is recorded',
      why: [`${t.tax} is owed because of the ${t.owed_because_of}, but no Desktop item withheld it.`, back ? `About ${t.estimated_back_tax} was not withheld in ${t.months_with_nothing_withheld_in_desktop}.` : 'No past months were missed.'],
      check: back ? `Agree with the agency how to settle the ${t.estimated_back_tax} back tax.` : 'Nothing, unless an address changes.',
    };
  }
  return {
    recommendation: t.online_months_to_withhold !== 'no months' ? `Add ${t.tax} (Law ID ${t.law_id}, ${t.rate}) from the first Online payroll.` : `Record the back tax for ${t.tax}; there are no Online paychecks left this year.`,
    confidence: 'high', because: `the ${t.owed_because_of} puts ${who} in this tax`,
    why: [`${t.tax} is owed because of the ${t.owed_because_of}, but no Desktop item withholds it.`, back ? `Nothing was withheld in ${t.months_with_nothing_withheld_in_desktop}: about ${t.estimated_back_tax}.` : 'No past months were missed.'],
    check: back ? `Agree with the agency how to settle the ${t.estimated_back_tax} back tax.` : `Confirm ${who}'s address before adding it.`,
  };
}

// ---------- built-in opinion ----------

const taxList = (ps) => ps.map((p) => `${p.tax} (Law ID ${p.law_id}, ${p.rate})`).join(' then ');

/** The built-in opinion for one line: what to do, how sure, why, and what to check. */
export function lineOpinion(f, c) {
  const p = f.person;
  const who = first(p.name);
  const props = f.engine.proposed_online_taxes;
  const exp = p.expected_local_taxes;
  const why = [];
  const expectedText = exp.length ? exp.map((t) => `${t.tax} (${t.months}, because of the ${t.owed_because_of})`).join('; ') : 'no local taxes';
  if (!['awaiting_employer', 'with_expert'].includes(c.stage)) {
    return { recommendation: `Nothing left to decide: ${f.status.stage.toLowerCase()}.`, confidence: 'high', because: 'a decision is recorded', why: [f.status.decisions_so_far === 'none' ? f.engine.reason : `Decided: ${f.status.decisions_so_far}.`], check: 'Nothing, unless an address or rate changes.' };
  }
  if (c.reason === 'no_address' || c.reason === 'address_unresolved') {
    return {
      recommendation: `Add ${who}'s home address first; the engine then picks the school district by itself.`,
      confidence: 'low', because: 'the home address is missing or could not be placed',
      why: ['A school-district tax is owed where the person lives, so it cannot be chosen without the home address.', `What is known: ${expectedText}.`],
      check: `Ask ${who} for the current home address.`,
    };
  }
  if (c.reason === 'work_location' && f.engine.work_question) {
    const w = f.engine.work_question;
    return {
      recommendation: `Tell us where ${who} works: from home, or at ${p.works_at.split(',')[0]}. The engine settles the line from the answer.`,
      confidence: 'low', because: 'only the employer knows where the work is done',
      why: [`Desktop withholds ${w.desktop_withholds}, but not ${w.work_site_tax}, the tax of the work site.`, 'A city tax is owed where the work is done: the work site, or the home for someone who works from home.', `From home: ${w.if_works_from_home}. At the site: ${w.if_works_at_the_site}.`],
      check: `Ask ${who}'s manager where ${who} works most days.`,
    };
  }
  if (c.route === 'local_tax') {
    const off = props.filter((x) => /instead of/.test(x.rate_check));
    props.forEach((x) => why.push(`${x.tax} is owed for ${x.months} because of the ${x.owed_because_of}.`));
    why.push(isCustom(f.desktop_line.law_id) ? `Law ID ${f.desktop_line.law_id} becomes ${props.map((x) => x.law_id).join(' then ')}.` : `Law ID ${f.desktop_line.law_id} already names this tax, so no label reading was needed.`);
    if (f.engine.label_model && typeof f.engine.label_model === 'object') why.push(`The label "${f.desktop_line.label}" reads as ${f.engine.label_model.nearest_cluster} (confidence ${f.engine.label_model.label_confidence}).`);
    return {
      recommendation: `Confirm: ${taxList(props)}${off.length ? ', at the official rate' : ''}.`,
      confidence: c.verified ? 'high' : 'medium',
      because: c.verified ? 'the address, the label and the rate all agree' : off.length ? 'the tax is right but Desktop used another rate' : 'the tax fits, with one thing to check',
      why,
      check: off.length ? `${off[0].rate_check}. The difference is settled with the agency.` : c.flags.includes('label_place_mismatch') ? 'The label names another place; the address decides, so make sure the address is current.' : 'Nothing unusual: the rate matches the official rate.',
    };
  }
  if (c.route === 'not_a_tax') {
    return {
      recommendation: 'Move it to deductions: it is not a tax.', confidence: 'high', because: 'Desktop and the label agree',
      why: [f.engine.reason, `${who}'s local taxes are covered by other lines: ${expectedText}.`],
      check: 'Make sure it should keep coming out of pay after tax.',
    };
  }
  // With an expert.
  const m = f.engine.label_model && typeof f.engine.label_model === 'object' ? f.engine.label_model : null;
  if (c.reason === 'not_expected') {
    return {
      recommendation: `Stop withholding it: ${who}'s addresses do not lead to this tax.`,
      confidence: 'medium', because: 'the addresses are clear, but Desktop withheld it all year',
      why: [`Owed instead: ${expectedText}.`, ...(p.works_from_home ? [`${who} works from home, so the office city's tax does not apply.`] : []), f.engine.reason],
      check: `Confirm ${who}'s address, then correct the ${f.desktop_line.withheld_this_year_in_desktop} Desktop withheld with the agency.`,
    };
  }
  if (c.reason === 'weak_signal' || c.reason === 'shadow' || c.reason === 'ambiguous') {
    const guess = m?.nearest_cluster && !/no defined name/.test(m.nearest_cluster) ? m.nearest_cluster : null;
    return {
      recommendation: guess ? `Probably a ${guess.toLowerCase()}, but the label is too vague to be sure: check with the employer, then map it.` : `The label "${f.desktop_line.label}" does not say what it pays for: ask the employer.`,
      confidence: 'low', because: m ? `label confidence ${m.label_confidence}, below ${m.minimum_for_confident}` : 'the label does not match a known kind of item',
      why: [f.engine.reason, `If it is a local tax, ${who}'s addresses give: ${expectedText}.`],
      check: `Ask the employer what "${f.desktop_line.label}" pays for.`,
    };
  }
  if (c.reason === 'conflict') {
    return {
      recommendation: 'Check which is right: Desktop says it is a tax, but the label looks like something else.', confidence: 'low', because: 'two sources disagree',
      why: [f.engine.reason, `Expected for ${who}: ${expectedText}.`], check: 'Look at the Desktop item set-up and ask the employer.',
    };
  }
  if (c.reason === 'duplicate') {
    return { recommendation: 'Stop one of the two lines: the same tax is withheld twice.', confidence: 'medium', because: 'another line already covers this tax', why: [f.engine.reason], check: 'Make sure the remaining line has the right rate.' };
  }
  return { recommendation: `An expert decides: ${f.engine.reason}`, confidence: 'low', because: 'the rules could not settle it', why: [`Expected for ${who}: ${expectedText}.`], check: 'Read the steps below before deciding.' };
}

// ---------- built-in answers ----------

const has = (q, re) => re.test(q);

/** Answer a question from the facts alone. `f` is lineFacts or gapFacts. */
export function answer(f, question) {
  const q = ` ${String(question).toLowerCase()} `;
  const p = f.person;
  const who = first(p.name);
  const line = f.desktop_line;
  const taxes = p.expected_local_taxes;
  const taxesText = taxes.length ? taxes.map((t) => `${t.tax} (Law ID ${t.law_id}, ${t.rate}) for ${t.months}, because of the ${t.owed_because_of}: ${t.address}`).join('. ') : 'none';
  const sdText = (h) => (h.school_district === 'none' ? 'no school-district income tax there' : h.school_district === 'unknown' ? 'the address lookup cannot place it, so the school district is unknown' : `school district ${h.school_district}`);
  const homesText = Array.isArray(p.homes) ? p.homes.map((h) => `${h.address} (${h.months}): ${sdText(h)}`).join('; then ') : 'no home address on file';

  const w = f.engine?.work_question;
  if (w && has(q, /work|home|remote|office|matter|answer|next|happen|why|where/)) {
    return `Desktop withholds ${w.desktop_withholds}, but not ${w.work_site_tax}. A city tax is owed where the work is done, so it depends on where ${who} works. From home: ${w.if_works_from_home}. At the site: ${w.if_works_at_the_site}. The employer answers under Missing information, and the engine checks the line again.`;
  }
  if (has(q, /india|visa|immigra|citizen|nationalit|foreign|abroad|country|green card|h-?1b/)) {
    return `Here local taxes follow only where ${who} lives and works in Ohio, and the months ${who} is on this payroll (${p.on_this_payroll}); nationality or visa does not change them. Federal and state tax residency for someone new to the US is outside this prototype.`;
  }
  if (line && has(q, /not owed|isn'?t owed|not due|why stop/)) {
    const m = f.engine.label_model && typeof f.engine.label_model === 'object' ? f.engine.label_model.nearest_cluster : null;
    return `${who} lives at ${homesText} and ${p.works_from_home ? `works from home (employer: ${p.works_at}), so the city tax follows the home, not the office` : `works at ${p.works_at}`}. From those addresses ${who} owes: ${taxes.map((t) => t.tax).join(', ') || 'no local tax'}. "${line.label}"${m ? ` reads as ${m.toLowerCase()}, which` : ''} is not on that list, so it is not owed. ${f.engine.reason}`;
  }
  if (has(q, /law ?id|\b177\b|\blaw\b/)) {
    if (!line) return 'A Law ID is the unique number of each tax. Law ID 177 (or 0) marks an item the employer created, which names no tax.';
    const after = f.engine.proposed_online_taxes.map((t) => t.law_id).join(' then ');
    return `A Law ID is the unique number of each tax. This line has Law ID ${line.law_id}: ${line.law_id_means}.${after ? ` After the migration it is Law ID ${after}.` : ''}`;
  }
  if (has(q, /\brates?\b|percent|%|too much|too little|\bover\b|\bunder\b/)) {
    if (!line) return taxes.map((t) => `${t.tax}: ${t.rate}.`).join(' ') || 'No local tax applies.';
    if (f.engine.not_owed_amount_to_correct) return `This tax is not owed at all, so its rate does not matter: the ${f.engine.not_owed_amount_to_correct} Desktop withheld is corrected with the agency.`;
    if (f.engine.result.startsWith('is not a tax')) return `It is not a tax, so there is no tax rate to check. Desktop takes ${line.desktop_rate} after tax.`;
    const checks = f.engine.proposed_online_taxes.map((t) => `${t.tax}: ${t.rate_check}.`);
    return checks.length ? `Desktop rate ${line.desktop_rate}. ${checks.join(' ')}` : `Desktop rate ${line.desktop_rate}. There is no proposed tax to compare it with yet.`;
  }
  if (has(q, /move|moving|moved|relocat|new address|split/)) {
    if (Array.isArray(p.homes) && p.homes.length > 1) return `${who} moved: ${homesText}. The school-district tax follows the home month by month, so the year is split; the city tax changes only if the work location changes.`;
    return `If ${who} moves, the school-district tax follows the new home from the month of the move, so the year is split. The city tax changes only if the work location changes. The employer adds the new address and the engine checks the line again.`;
  }
  if (has(q, /home|live|lives|living|address|district|school/)) {
    if (!Array.isArray(p.homes)) return `There is no home address on file for ${who}, so the school-district tax cannot be chosen yet: it is owed where the person lives. Once the employer adds the address, the engine picks the district and checks the line again.`;
    if (p.homes.some((h) => h.school_district === 'unknown')) return `${who}'s home: ${homesText}. The school-district tax cannot be chosen until the address is placed: it is owed where the person lives. A corrected address lets the engine pick the district.`;
    const none = p.homes.every((h) => h.school_district === 'none');
    return `${who}'s home: ${homesText}.${none ? ` So there is no school-district tax for ${who}.` : ''} A school-district tax is owed where the person lives.`;
  }
  if (has(q, /work|office|remote|from home|job|city tax|city/)) {
    const city = taxes.filter((t) => t.kind === 'city tax');
    return `${who} works at ${p.works_at}${p.works_from_home ? ', but works from home, so the city tax follows the home office' : ''}. ${city.length ? `City tax: ${city.map((t) => `${t.tax}, ${t.rate}, ${t.months}`).join('; ')}.` : 'No city tax on the list applies.'}`;
  }
  if (has(q, /model|cluster|confiden|sure|silhouette|label|mean|what is it|what could/)) {
    if (!line) return 'This person has no Desktop label to read.';
    const m = f.engine.label_model;
    if (!m) return `The label "${line.label}" was not read: ${line.law_id_means}.`;
    if (typeof m === 'string') return `The label "${line.label}" was not read by the model: ${m}.`;
    return `The model read "${line.label}" as ${m.nearest_cluster}, with label confidence ${m.label_confidence} (it needs at least ${m.minimum_for_confident} to be sure). ${m.confident ? 'That counts as confident.' : 'That is too low, so a person decides.'}`;
  }
  if (f.missing_tax && has(q, /past|back tax|money|owe|how much|withheld|why|which|tax/)) {
    const t = f.missing_tax;
    return `${t.tax} (Law ID ${t.law_id}, ${t.rate}) is owed because of the ${t.owed_because_of}, but no Desktop item withholds it. Nothing was withheld in ${t.months_with_nothing_withheld_in_desktop} (about ${t.estimated_back_tax}); Online payroll withholds it for ${t.online_months_to_withhold}.`;
  }
  if (has(q, /past|history|year.to.date|ytd|w-?2|refund|correct|back tax|already withheld|money/)) {
    if (!line) return `Estimated for the year: ${taxes.map((t) => `${t.tax} ${t.estimated_for_the_year}`).join(', ') || 'nothing'}.`;
    const fix = f.engine.not_owed_amount_to_correct;
    return `Desktop withheld ${line.withheld_this_year_in_desktop} on this line this year. ${fix ? `${fix} of it was not owed: the employer corrects it with the agency.` : 'The W-2 shows what was actually withheld; Online payroll takes over from the first Online payroll.'}`;
  }
  if (has(q, /how much|total|amount|cost|owe for the year|per year|annual/)) {
    return taxes.length ? `Estimated for the year on ${p.monthly_wages} a month: ${taxes.map((t) => `${t.tax} ${t.estimated_for_the_year}`).join(', ')}.` : 'No local tax applies.';
  }
  if (has(q, /expert|automatic|manual|can'?t the system|why.*person|why not/)) {
    if (!line) return 'The engine settles a person\'s taxes from the addresses alone.';
    if (f.engine.result.startsWith('waits')) return `The rules stopped here: ${f.engine.reason.charAt(0).toLowerCase()}${f.engine.reason.slice(1)} So a person decides, and the employer confirms.`;
    return `The system did decide: this line ${f.engine.result}. ${f.engine.reason}`;
  }
  if (has(q, /confirm|what happens|next|should i|what do i|do now|decide/)) {
    if (!line) return taxesText;
    return `${f.status.next_step} Now: ${f.status.stage.toLowerCase()}.`;
  }
  if (has(q, /\bstart|\bjoin|hired|\bleave|\bleft\b|which months|what months|when did|when does|on the payroll/)) {
    return `${who} is on this payroll for ${p.on_this_payroll}. Taxes apply only in those months: ${taxesText}.`;
  }
  if (has(q, /why|which|what tax|owe|tax/)) {
    return `${who} owes: ${taxesText}.${line ? ` This line ${f.engine.result}.` : ''}`;
  }
  return null;
}

/** Questions worth asking, for the chips under the opinion. */
export function suggestions(f, c) {
  if (f.missing_tax) return ['Why is this tax owed?', 'What about the back tax?', 'What if they move?'];
  if (c?.stage === 'with_expert' && (c.reason === 'not_expected' || c.reason === 'duplicate')) {
    return ['Why is this not owed?', 'Which taxes does this person owe?', 'What about the money already withheld?', 'What could this label be?'];
  }
  if (c?.stage === 'with_expert' && !['no_address', 'address_unresolved', 'work_location'].includes(c.reason)) {
    return ['What could this label be?', 'Which taxes does this person owe?', 'Why can\'t the system decide?', 'What about the money already withheld?'];
  }
  if (c?.reason === 'no_address' || c?.reason === 'address_unresolved') return ['Why is the address needed?', 'What does Law ID 177 mean?', 'What happens next?'];
  if (c?.reason === 'work_location') return ['Why does it matter where they work?', 'What if they work from home?', 'What happens after I answer?'];
  return ['Why this tax?', 'Is the rate right?', `What does Law ID ${f.desktop_line.law_id} mean?`, 'What if they move?', 'What happens when I confirm?'];
}

// ---------- a real model ----------

export const RULES = `Rules the prototype uses (Ohio local income taxes):
- A school-district income tax is owed where the person LIVES (home address), month by month. Some places, such as Columbus, have no school-district income tax.
- A city income tax is owed where the work is DONE: the work site, or the home for someone who works from home.
- Taxes apply only in the months the person is on the payroll; a move splits the year.
- Law ID is the unique number of each tax. 177 or 0 means the employer created the item, so it names no tax; the address then picks the exact tax.
- A clustering model reads free-text labels; a label confidence below 0.25 means it is not sure, and a person decides.
- Nothing switches on until the employer confirms it.`;

const LINE_FORMAT = `Give your opinion on this one Desktop line, in plain text (no Markdown headings), under 120 words, in exactly this shape:
Recommendation: <one sentence: what the viewer should do with this line>
Confidence: <high, medium or low>: <a few words why>
Why:
- <reason taken from the facts>
- <reason taken from the facts>
Check: <one thing a person should verify before deciding>`;

const GAP_FORMAT = `Give your opinion on this missing tax (owed, but no Desktop item withholds it), in plain text (no Markdown headings), under 120 words, in exactly this shape:
Recommendation: <one sentence: what the viewer should do>
Confidence: <high, medium or low>: <a few words why>
Why:
- <reason taken from the facts>
- <reason taken from the facts>
Check: <one thing a person should verify before deciding>`;

/** What to ask a real model for its own opinion on the record on screen (its facts are already in the chat). */
export const opinionFormat = (f) => (f.missing_tax ? GAP_FORMAT : LINE_FORMAT);

/** The built-in opinion as text in the same shape Claude is asked for, so both read alike. */
export function opinionText(op) {
  return [`Recommendation: ${op.recommendation}`, `Confidence: ${op.confidence}: ${op.because}`, 'Why:', ...op.why.map((w) => `- ${w}`), `Check: ${op.check}`].join('\n');
}
