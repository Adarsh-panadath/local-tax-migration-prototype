// Shared by the database tests.
export const dropEmpty = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x === null ? undefined : x)));
// How a business looks after a trip through the database: a work site is named by its name, the
// description is not stored, and an empty field (null) reads back as absent. Everything else is exact.
export const asStored = (c) => {
  const site = new Map(c.worksites.map((w) => [w.site_id, w]));
  const sites = new Map();
  for (const e of c.employees) { const w = site.get(e.site_id); if (!sites.has(w.name)) sites.set(w.name, { site_id: w.name, name: w.name, address_id: w.address_id }); }
  return dropEmpty({ ...c, description: undefined, worksites: [...sites.values()], employees: c.employees.map((e) => ({ ...e, site_id: site.get(e.site_id).name })) });
};
