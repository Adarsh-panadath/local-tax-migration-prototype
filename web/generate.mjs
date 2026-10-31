// Generated businesses for scale. Every one has at least 100 employees. They are made in the browser
// (and in the tests) from a fixed seed, so every visitor gets exactly the same data. The people,
// streets and businesses are fictional; the towns, ZIP codes, school districts and city taxes are the
// real Ohio ones in the catalogue. Nothing here decides an outcome: the generator only writes Desktop
// files the way employers really set them up (loose labels, a wrong rate, a missing address, a move),
// and the engine does the rest exactly as for the hand-made clients.

export const SEED = 2026;
export const GENERATED_COUNT = 60;

// ---------- deterministic randomness ----------

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, list) => list[Math.floor(r() * list.length)];
const chance = (r, p) => r() < p;
const weighted = (r, items) => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) { x -= w; if (x < 0) return v; }
  return items.at(-1)[0];
};
export function shuffle(r, list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- the label vocabulary employers actually type ----------
// Keys follow the engine's model keys: a tax type, or non_tax:<entry>. "ambiguous" means no defined
// entry is right and an expert has to look.

export const LABELS = {
  school_district: ['School Tax', 'SD Tax', 'School District Tax', 'SD WH', 'Schl Dist W/H', 'School Dist Tax', 'SD Income Tax', 'School District WH', 'SDIT', 'Sch Dist Tax', 'School Dist. Withholding', 'OH SD Tax', 'Ohio School Tax', 'Schools Tax', 'School District Income Tax', 'SD W/H', 'Schl Tax', 'School Dist Inc Tax'],
  municipal: ['City Tax', 'Muni Tax', 'Municipal Tax', 'City Income Tax', 'City W/H', 'Municipal Inc Tax', 'RITA', 'RITA Withholding', 'CCA Tax', 'Work City Tax', 'City Inc Tax', 'Muni Income Tax', 'Village Tax', 'Town Tax', 'Municipal Income Tax', 'City WH'],
  'non_tax:N-DUES': ['Union Dues', 'Dues', 'Union Dues - Local 412', 'Local 89 Union Dues', 'Union Fee', 'Membership Dues', 'Union Membership'],
  'non_tax:N-GARN': ['Garnishment', 'Wage Garnish', 'Child Support', 'Garnish', 'Wage Garnishment', 'Child Support Order', 'Court Ordered Garnishment'],
  'non_tax:N-WC': ['Workers Comp', 'BWC', 'Work Comp', 'Workers Compensation', 'BWC Premium'],
  'non_tax:N-PARK': ['Parking', 'Parking Permit', 'Parking Fee', 'Garage Parking'],
  'non_tax:N-CHAR': ['United Way', 'Charity', 'Charitable Gift', 'Donation', 'United Way Pledge'],
  ambiguous: ['Local Tax', 'Other Tax', 'Misc Tax', 'Tax 2', 'Local W/H', 'Misc Deduction', 'Other'],
};
const PLACES = ['Lancaster', 'Pickerington', 'Bremen', 'Carroll', 'OH', 'Ohio', 'Columbus'];
const SUFFIXES = [' - EE', ' Employee', ' 2026', ' (old)', ' Deduction'];

function typo(r, word) {
  if (word.length < 4) return word;
  const i = int(r, 1, word.length - 2);
  const kind = int(r, 0, 2);
  if (kind === 0) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // swap
  if (kind === 1) return word.slice(0, i) + word.slice(i + 1); // drop
  return word.slice(0, i) + word[i] + word.slice(i); // double
}

// One label as an employer might type it. `noise` scales how messy it gets.
export function variant(r, key, noise = 1) {
  let label = pick(r, LABELS[key]);
  const taxLike = key === 'school_district' || key === 'municipal';
  if (taxLike && chance(r, 0.22 * noise)) label = chance(r, 0.5) ? `${pick(r, PLACES)} ${label}` : `${label} ${pick(r, PLACES)}`;
  if (chance(r, 0.12 * noise)) {
    const words = label.split(' ');
    const at = int(r, 0, words.length - 1);
    words[at] = typo(r, words[at]);
    label = words.join(' ');
  }
  if (chance(r, 0.08 * noise)) label += pick(r, SUFFIXES);
  if (chance(r, 0.12 * noise)) label = label.toLowerCase();
  else if (chance(r, 0.1 * noise)) label = label.toUpperCase();
  if (chance(r, 0.04 * noise)) label = label.replace(/ /g, pick(r, ['-', '_', '.']));
  return label;
}

// ---------- towns, streets and names ----------

const TOWNS = {
  Lancaster: { zip: '43130', sd: '2305', muni: 'Lancaster' },
  Pickerington: { zip: '43147', sd: '2307', muni: 'Pickerington' },
  Columbus: { zip: '43205', sd: 'NO-TAX-COLUMBUS', muni: 'Columbus' },
  Carroll: { zip: '43112', sd: '2303', muni: 'Carroll' },
  Bremen: { zip: '43107', sd: '2304', muni: 'Bremen' },
  Baltimore: { zip: '43105', sd: '2306', muni: 'Baltimore' },
  Millersport: { zip: '43046', sd: '2308', muni: 'Millersport' },
  Ashville: { zip: '43103', sd: '6503', muni: 'Ashville' },
};
// Where people live, by where they work (a commuting pattern, not a census).
const COMMUTE = {
  Lancaster: [['Lancaster', 46], ['Carroll', 10], ['Bremen', 9], ['Baltimore', 9], ['Pickerington', 8], ['Millersport', 5], ['Columbus', 8], ['Ashville', 5]],
  Columbus: [['Columbus', 52], ['Pickerington', 18], ['Ashville', 9], ['Carroll', 7], ['Lancaster', 8], ['Baltimore', 6]],
  Pickerington: [['Pickerington', 40], ['Columbus', 22], ['Carroll', 12], ['Lancaster', 12], ['Baltimore', 8], ['Ashville', 6]],
};
const STREETS = ['Maple', 'Oak', 'Cedar', 'Elm', 'Walnut', 'Hickory', 'Sycamore', 'Willow', 'Chestnut', 'Locust', 'Mulberry', 'Hill', 'Lake', 'River', 'Mill', 'Church', 'Market', 'High', 'Broad', 'Main', 'Park', 'Spring', 'Pleasant', 'Meadow', 'Orchard', 'Valley', 'Ridge', 'Forest', 'Union', 'Fair'];
const KINDS = ['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Ct', 'Way', 'Pl'];
const FIRST = ['Aaliyah', 'Aaron', 'Abigail', 'Adam', 'Aisha', 'Alan', 'Alejandro', 'Alicia', 'Amara', 'Amir', 'Ana', 'Andre', 'Angela', 'Anil', 'Ben', 'Bianca', 'Brandon', 'Carla', 'Carlos', 'Chen', 'Chloe', 'Daniel', 'Deepa', 'Derek', 'Diego', 'Elena', 'Eli', 'Emily', 'Eric', 'Fatima', 'Felix', 'Gabriel', 'Grace', 'Hannah', 'Hassan', 'Ian', 'Imani', 'Isabel', 'Jack', 'Jada', 'James', 'Jasmine', 'Jin', 'Jordan', 'Jose', 'Julia', 'Kai', 'Karen', 'Kenji', 'Laila', 'Leah', 'Leo', 'Lucia', 'Luis', 'Maya', 'Mei', 'Michael', 'Mohammed', 'Nadia', 'Naomi', 'Nathan', 'Nina', 'Noah', 'Olivia', 'Omar', 'Owen', 'Priya', 'Rachel', 'Rahul', 'Rosa', 'Ryan', 'Samuel', 'Sara', 'Sofia', 'Tariq', 'Tom', 'Uma', 'Victor', 'Wei', 'Yusuf', 'Zoe'];
const LAST = ['Adams', 'Ali', 'Anderson', 'Baker', 'Bell', 'Brooks', 'Brown', 'Chen', 'Clark', 'Cohen', 'Cruz', 'Davis', 'Diaz', 'Edwards', 'Evans', 'Fischer', 'Garcia', 'Gomez', 'Green', 'Gupta', 'Hall', 'Harris', 'Hughes', 'Ito', 'Jackson', 'Johnson', 'Kaur', 'Kim', 'King', 'Kowalski', 'Lee', 'Lewis', 'Lopez', 'Martin', 'Meyer', 'Miller', 'Moore', 'Morales', 'Murphy', 'Nguyen', 'Novak', 'Okafor', 'Ortiz', 'Park', 'Patel', 'Perez', 'Price', 'Reed', 'Reyes', 'Rivera', 'Roberts', 'Rossi', 'Sanchez', 'Schmidt', 'Shah', 'Singh', 'Smith', 'Stewart', 'Tanaka', 'Taylor', 'Thomas', 'Torres', 'Turner', 'Walker', 'Wang', 'Ward', 'White', 'Williams', 'Wilson', 'Wright', 'Young', 'Zhang'];
const PREFIX = ['Buckeye', 'Scioto', 'Licking', 'Olentangy', 'Muskingum', 'Darby', 'Big Walnut', 'Alum Creek', 'Clear Creek', 'Rush Creek', 'Pickaway', 'Mill Park', 'Oak Ridge', 'Cedar Hill', 'Maple Grove', 'Stone Bridge', 'Red Barn', 'Lakeside', 'Riverbend', 'Northgate', 'Granite', 'Ironwood', 'Blue Heron', 'Copper Kettle', 'Prairie', 'Harvest', 'Twin Oaks', 'High Street', 'Canal', 'Founders'];
const TRADE = ['Supply Co.', 'Logistics', 'Dental Group', 'Fabrication', 'Bakery', 'Print Works', 'Auto Repair', 'Builders', 'Home Care', 'Grocers', 'Machine Works', 'Veterinary Clinic', 'Landscaping', 'Plumbing', 'Electric', 'Furniture', 'Packaging', 'Brewing', 'Restaurant Group', 'Insurance Agency', 'Pharmacy', 'Staffing', 'Hotel', 'Distribution', 'Clinic'];

const SITE_ADDRESS = { Lancaster: ['Commerce Dr', 'Industrial Pkwy', 'Columbus St'], Columbus: ['Broad St', 'High St', 'Morse Rd'], Pickerington: ['Hill Rd', 'Diley Rd', 'Refugee Rd'] };

// The first business is the demo's flagship: a typical Desktop file with a few of each problem.
const FLAGSHIP = {
  name: 'Buckeye Supply Co.', employees: 152, plan: 'Premium', month: 10, sites: ['Lancaster', 'Columbus'],
  missingAddress: 2, unplaced: 1, movers: 5, wrongRate: true, columbusSd: 4, gaps: 6, ambiguous: 2, union: 0.18, garnish: 2, conflict: 0, accountMissing: false, noise: 0.5,
};

function plan(r, i) {
  if (i === 0) return FLAGSHIP;
  return {
    name: null,
    employees: int(r, 100, 280),
    plan: weighted(r, [['Premium', 55], ['Core', 25], ['Elite', 20]]),
    month: weighted(r, [[10, 75], [1, 15], [7, 10]]),
    sites: weighted(r, [[['Lancaster'], 40], [['Columbus'], 25], [['Pickerington'], 10], [['Lancaster', 'Columbus'], 15], [['Columbus', 'Pickerington'], 10]]),
    missingAddress: int(r, 0, 3),
    unplaced: chance(r, 0.4) ? int(r, 1, 2) : 0,
    movers: int(r, 0, 8),
    wrongRate: chance(r, 0.3),
    columbusSd: chance(r, 0.35) ? int(r, 1, 6) : 0,
    gaps: int(r, 0, 10),
    ambiguous: chance(r, 0.3) ? int(r, 1, 3) : 0,
    union: chance(r, 0.4) ? 0.1 + r() * 0.3 : 0,
    garnish: chance(r, 0.5) ? int(r, 1, 4) : 0,
    conflict: chance(r, 0.12) ? 1 : 0,
    accountMissing: chance(r, 0.12),
    noise: 0.6 + r() * 0.6,
  };
}

// ---------- the generator ----------

export function generateBusinesses(catalog, { seed = SEED, count = GENERATED_COUNT } = {}) {
  const r = rng(seed);
  const ohTaxes = catalog.states.OH.taxes;
  const sdTax = new Map(ohTaxes.filter((t) => t.type === 'school_district').map((t) => [t.code, t]));
  const cityTax = new Map(ohTaxes.filter((t) => t.type === 'municipal').map((t) => [t.place, t]));
  const addresses = [];
  let addressN = 0;
  const newAddress = (town, line1, overrides = {}) => {
    const t = TOWNS[town];
    const a = { address_id: `G-A${String(++addressN).padStart(5, '0')}`, line1, city: town, state: 'OH', zip: t.zip, school_district: t.sd, municipality: t.muni, ...overrides };
    addresses.push(a);
    return a;
  };
  const street = () => `${int(r, 10, 9890)} ${pick(r, STREETS)} ${pick(r, KINDS)}`;
  const usedNames = new Set();
  const companies = [];
  for (let i = 0; i < count; i += 1) {
    const p = plan(r, i);
    let name = p.name;
    while (!name || usedNames.has(name)) name = `${pick(r, PREFIX)} ${pick(r, TRADE)}`;
    usedNames.add(name);
    const id = `G-${String(i + 1).padStart(3, '0')}`;
    const code = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    const worksites = p.sites.map((town, s) => ({ site_id: `S${s + 1}`, name: `${town} ${s === 0 ? 'main site' : 'branch'}`, address_id: newAddress(town, `${int(r, 100, 2400)} ${pick(r, SITE_ADDRESS[town])}`).address_id }));
    const siteTown = Object.fromEntries(p.sites.map((t, s) => [`S${s + 1}`, t]));
    const items = [];
    const account = (prefix) => (p.accountMissing && items.length === 0 ? null : `${prefix}-${int(r, 100000, 999999)}`);
    const item = (props) => { const it = { item_id: `I${items.length + 1}`, law_id: 177, origin: 'custom', item_type: 'Other Tax', tracking_type: 'Local Income Tax', agency: 'Ohio Dept of Taxation', ...props }; items.push(it); return it; };
    // City tax items, one per work city that has a city tax: a system item half the time, else a typed label.
    const cityItems = {};
    for (const town of new Set(p.sites)) {
      const tax = cityTax.get(town);
      if (!tax) continue;
      const rate = p.wrongRate && chance(r, 0.3) ? Number((tax.rate + pick(r, [-0.25, 0.25])).toFixed(2)) : tax.rate;
      cityItems[town] = chance(r, 0.5)
        ? item({ label: `${town} City Tax`, law_id: town === 'Lancaster' ? 4120 : 4140, origin: 'system', system_tax_id: tax.tax_id, calc: { kind: 'percent', rate }, agency: `City of ${town}`, agency_account: account(town.slice(0, 3).toUpperCase()), deposit_frequency: 'Monthly' })
        : item({ label: chance(r, 0.6) ? `${town} ${pick(r, LABELS.municipal)}` : variant(r, 'municipal', p.noise), calc: { kind: 'percent', rate }, agency: `City of ${town}`, agency_account: account(town.slice(0, 3).toUpperCase()), deposit_frequency: 'Monthly' });
    }
    // School-district items are made as employees need them: one per district rate, as employers usually do.
    const sdItems = {};
    const sdItemFor = (code2) => {
      if (sdItems[code2]) return sdItems[code2];
      const tax = sdTax.get(code2);
      const rate = p.wrongRate && Object.keys(sdItems).length === 0 ? Number((tax.rate + 0.25).toFixed(2)) : tax.rate;
      const label = chance(r, 0.35) ? `${tax.place} ${pick(r, ['SD', 'School Tax', 'Schools', 'SD WH'])}` : variant(r, 'school_district', p.noise);
      sdItems[code2] = item({ label, calc: { kind: 'percent', rate }, agency: chance(r, 0.7) ? 'Ohio Dept of Taxation' : 'State of Ohio', agency_account: account('SD'), deposit_frequency: pick(r, ['Monthly', 'Quarterly']) });
      return sdItems[code2];
    };
    const unionItem = p.union ? item({ label: variant(r, 'non_tax:N-DUES', p.noise * 0.5), item_type: 'Deduction', tracking_type: 'None', calc: { kind: 'flat_annual', amount: pick(r, [240, 360, 480]) }, agency: `Local ${int(r, 10, 990)}` }) : null;
    const garnItem = p.garnish ? item({ label: variant(r, 'non_tax:N-GARN', p.noise * 0.5), item_type: 'Deduction', tracking_type: 'None', calc: { kind: 'flat_annual', amount: pick(r, [1200, 2400, 3600]) }, agency: 'County Court' }) : null;
    const conflictItem = p.conflict ? item({ label: pick(r, ['Wage Garnishment', 'Child Support']), calc: { kind: 'percent', rate: 1.5 } }) : null;
    const ambiguousItem = p.ambiguous ? item({ label: pick(r, ['Local Tax', 'Other Tax', 'Local W/H']), calc: { kind: 'percent', rate: pick(r, [1, 1.5, 2]) } }) : null;

    const employees = [];
    for (let e = 0; e < p.employees; e += 1) {
      const site = weighted(r, p.sites.map((t, s) => [`S${s + 1}`, s === 0 ? 3 : 1]));
      const town = siteTown[site];
      const homeTown = weighted(r, COMMUTE[town]);
      const emp = { employee_id: `E${String(e + 1).padStart(3, '0')}`, name: '', site_id: site, monthly_wages: int(r, 52, 156) * 50, addresses: [], items: [] };
      do emp.name = `${pick(r, FIRST)} ${pick(r, LAST)}`; while (employees.some((x) => x.name === emp.name));
      const home = newAddress(homeTown, street());
      emp.addresses.push({ address_id: home.address_id, from_month: 1 });
      employees.push({ emp, home, town, homeTown });
    }
    const list = shuffle(r, employees.map((_, k) => k));
    let at = 0;
    const take = (n) => list.slice(at, (at += n));
    // A few Desktop problems, each on different people.
    const noAddress = new Set(take(p.missingAddress));
    const unplaced = new Set(take(p.unplaced));
    const movers = new Set(take(p.movers));
    const gaps = new Set(take(p.gaps));
    const ambiguous = new Set(take(p.ambiguous));
    const garnish = new Set(take(p.garnish));
    const conflict = new Set(take(p.conflict));
    const columbusSd = new Set(employees.map((x, k) => (x.homeTown === 'Columbus' ? k : -1)).filter((k) => k >= 0).slice(0, p.columbusSd));
    employees.forEach(({ emp, home, town, homeTown }, k) => {
      if (noAddress.has(k)) emp.addresses = [];
      if (unplaced.has(k)) {
        const a = newAddress(homeTown, `${street()} (new build)`, { school_district: 'UNRESOLVED', municipality: null });
        emp.addresses = [{ address_id: a.address_id, from_month: 1 }];
      }
      if (movers.has(k)) {
        const to = pick(r, Object.keys(TOWNS).filter((t) => t !== homeTown && t !== 'Columbus'));
        emp.addresses.push({ address_id: newAddress(to, street()).address_id, from_month: int(r, 3, 9) });
      }
      // Desktop items: the school district of the (first) home address, and the work city's tax.
      const sd = home.school_district;
      if (sdTax.has(sd) && !gaps.has(k)) emp.items.push(sdItemFor(sd).item_id);
      if (homeTown === 'Columbus' && columbusSd.has(k)) emp.items.push(sdItemFor(pick(r, ['2305', '2307'])).item_id); // withheld but not owed
      if (cityItems[town]) emp.items.push(cityItems[town].item_id);
      if (unionItem && chance(r, p.union)) emp.items.push(unionItem.item_id);
      if (garnItem && garnish.has(k)) emp.items.push(garnItem.item_id);
      if (conflictItem && conflict.has(k)) emp.items.push(conflictItem.item_id);
      if (ambiguousItem && ambiguous.has(k)) emp.items.push(ambiguousItem.item_id);
      if (chance(r, 0.03)) emp.remote = true;
      if (chance(r, 0.04)) emp.hired_month = int(r, 2, Math.max(2, p.month - 1));
      else if (chance(r, 0.03)) emp.left_month = int(r, 3, 9);
    });
    companies.push({
      company_id: id,
      name,
      plan: p.plan,
      migration_month: p.month,
      worksites,
      items,
      employees: employees.map((x) => x.emp),
      description: `Generated business (${code}): ${employees.length} employees across ${p.sites.join(' and ')}.`,
    });
  }
  return { companies, addresses };
}

// ---------- a labelled set for the ML Lab ----------
// Labels with the answer an expert would record, in proportions like a real Ohio pool.

export const LAB_MIX = [['school_district', 0.3], ['municipal', 0.26], ['non_tax:N-DUES', 0.09], ['non_tax:N-GARN', 0.09], ['non_tax:N-WC', 0.06], ['non_tax:N-PARK', 0.06], ['non_tax:N-CHAR', 0.06], ['ambiguous', 0.08]];

export function labelSet({ seed = SEED, total = 1200 } = {}) {
  const r = rng(seed + 7);
  const out = [];
  for (const [key, share] of LAB_MIX) {
    const n = Math.round(total * share);
    for (let i = 0; i < n; i += 1) out.push({ label: variant(r, key, 1), key });
  }
  return shuffle(r, out);
}
