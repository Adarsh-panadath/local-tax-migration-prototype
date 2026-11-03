// Use cases: six made-up people whose local taxes differ only because of where they live, where they
// work and when. They are not Buckeye's employees; they are run through the same engine as a small
// business of their own, so every tax, month and Desktop outcome on the screen is the engine's answer.

export const USE_CASES = [
  {
    id: 'same-town',
    title: 'Lives and works in the same town',
    name: 'Rahul Mehta',
    story: 'Lives in Lancaster and works at the office in Lancaster.',
    lesson: 'One town, two taxes: the city tax for working there and the school-district tax for living there.',
    site: 'lancaster-office', wages: 4200,
    homes: [{ town: 'Lancaster', from: 1 }],
    items: [['City W/H', 177, 2.3], ['Schl Dist W/H', 177, 1.5]],
  },
  {
    id: 'two-towns',
    title: 'Lives in one town, works in another',
    name: 'Sara Lopez',
    story: 'Lives in Pickerington and works at an office in Columbus.',
    lesson: 'The city tax comes from the work town (Columbus); the school-district tax comes from the home town (Pickerington).',
    site: 'columbus-office', wages: 4500,
    homes: [{ town: 'Pickerington', from: 1 }],
    items: [['Columbus City Tax', 4140, 2.5], ['SD Tax', 177, 1]],
  },
  {
    id: 'new-arrival',
    title: 'Arrived from India in June',
    name: 'Ananya Rao',
    story: 'Moved from Bengaluru in June and started as a barista at a coffee shop in Columbus. Lives in Columbus.',
    lesson: 'Taxes start the month she starts. Columbus has a city tax but no school-district income tax, so she owes one local tax, from June.',
    scope: 'Local taxes follow where she lives and works. Her federal and state tax residency as someone new to the US is outside this prototype.',
    site: 'coffee-shop', wages: 2600, hired: 6,
    homes: [{ town: 'Columbus', from: 6 }],
    items: [['Columbus City Tax', 4140, 2.5]],
  },
  {
    id: 'moved-house',
    title: 'Moved house in the middle of the year',
    name: 'Daniel Kim',
    story: 'Works at the office in Lancaster. Moved from Lancaster to Bremen in July.',
    lesson: 'The city tax stays, because the office did not change. The school-district tax switches in July, and Desktop kept the old 1.5% after the move.',
    site: 'lancaster-office', wages: 4000,
    homes: [{ town: 'Lancaster', from: 1 }, { town: 'Bremen', from: 7 }],
    items: [['City W/H', 177, 2.3], ['SD Tax', 177, 1.5]],
  },
  {
    id: 'works-from-home',
    title: 'Works from home',
    name: 'Grace Okafor',
    story: 'Employed by the office in Lancaster, but works from home in Columbus.',
    lesson: 'The city tax follows where the work is done. Working from home in Columbus, she owes Columbus city tax, not Lancaster\'s, and Desktop withheld Lancaster\'s 2.3%.',
    site: 'lancaster-office', wages: 4800, remote: true,
    homes: [{ town: 'Columbus', from: 1, n: 1 }],
    items: [['City W/H', 177, 2.3]],
  },
  {
    id: 'not-owed',
    title: 'Desktop withheld a tax she does not owe',
    name: 'Meera Iyer',
    story: 'Lives in Columbus and works at the office in Columbus. Desktop also withholds "Lancaster Schools".',
    lesson: 'Columbus has no school-district income tax, so "Lancaster Schools" is not owed: the migration stops it and flags what Desktop withheld for correction.',
    site: 'columbus-office', wages: 3800,
    homes: [{ town: 'Columbus', from: 1, n: 6 }],
    items: [['Columbus City Tax', 4140, 2.5], ['Lancaster Schools', 177, 1.5]],
  },
];

const SITES = {
  'lancaster-office': { name: 'Office in Lancaster', town: 'Lancaster', n: 0 },
  'columbus-office': { name: 'Office in Columbus', town: 'Columbus', n: 3 },
  'coffee-shop': { name: 'Coffee shop in Columbus', town: 'Columbus', n: 4 },
};

/**
 * The use-case business, built from the address lookup: each person's home is a real address the lookup
 * places in the right town; each work site likewise. Returns null when a town is missing from the lookup.
 */
export function useCaseCompany(lookup, migrationMonth = 10) {
  const placed = (town) => lookup.filter((a) => a.state === 'OH' && a.city === town && !a.missing && a.school_district !== 'UNRESOLVED' && !String(a.address_id).startsWith('W-'));
  const pick = (town, n = 0) => { const list = placed(town); return list.length ? list[Math.min(n, list.length - 1)] : null; };
  const worksites = Object.entries(SITES).map(([id, s]) => {
    const a = id === 'lancaster-office' ? lookup.find((x) => x.address_id === 'W-LAN-1') ?? pick(s.town) : pick(s.town, s.n);
    return a ? { site_id: id, name: s.name, address_id: a.address_id } : null;
  });
  if (worksites.some((w) => !w)) return null;
  const items = [];
  const employees = [];
  for (const [i, u] of USE_CASES.entries()) {
    const ids = u.items.map(([label, law, rate], j) => {
      const item_id = `UC${i + 1}-${j + 1}`;
      items.push({ item_id, label, law_id: law, origin: law === 177 || law === 0 ? 'custom' : 'system', item_type: 'Other Tax', tracking_type: 'Local Income Tax', calc: { kind: 'percent', rate }, agency: '' });
      return item_id;
    });
    const homes = u.homes.map((h) => ({ a: pick(h.town, h.n ?? i % 2), from_month: h.from }));
    if (homes.some((h) => !h.a)) return null;
    const emp = { employee_id: `UC${i + 1}`, name: u.name, site_id: u.site, monthly_wages: u.wages, addresses: homes.map((h) => ({ address_id: h.a.address_id, from_month: h.from_month })), items: ids };
    if (u.hired) emp.hired_month = u.hired;
    if (u.remote) emp.remote = true;
    employees.push(emp);
  }
  return { company_id: 'USE-CASES', name: 'Use cases', plan: 'Premium', migration_month: migrationMonth, worksites, items, employees };
}
