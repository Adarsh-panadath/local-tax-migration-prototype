export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export const sum = (values) => round2(values.reduce((s, v) => s + v, 0));

export function range(from, to) {
  const out = [];
  for (let m = from; m <= to; m++) out.push(m);
  return out;
}

export function monthSpan(months) {
  if (!months.length) return '';
  const sorted = [...months].sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const m of sorted.slice(1).concat([null])) {
    if (m !== prev + 1) {
      parts.push(start === prev ? MONTHS[start - 1] : `${MONTHS[start - 1]}–${MONTHS[prev - 1]}`);
      start = m;
    }
    prev = m;
  }
  return parts.join(', ');
}

export const desktopMonths = (company) => range(1, company.migration_month - 1);
export const cloudMonths = (company) => range(company.migration_month, 12);

export function itemAmount(item, wages) {
  if (item.calc.kind === 'percent') return round2((wages * item.calc.rate) / 100);
  if (item.calc.kind === 'flat_annual') return round2(item.calc.amount / 12);
  return 0;
}

export function rateText(item) {
  if (item.calc.kind === 'percent') return `${item.calc.rate}%`;
  if (item.calc.kind === 'flat_annual') return `$${item.calc.amount} a year`;
  return '—';
}

// Desktop treats an item as a local tax unless its tracking type says it is an after-tax deduction.
export const desktopCountsAsTax = (item) => item.tracking_type !== 'None';
