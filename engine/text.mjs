// Turns free-text payroll item labels into comparable vectors.
// Place names are removed because they say where a tax applies, not what kind of tax it is.

const PHRASES = [
  [/w\s*\/\s*h/g, ' withholding '],
  [/\bsch\.?\s*dist\b/g, ' school district '],
];

const EXPAND = {
  sd: 'school district', sdit: 'school district income tax', csd: 'school district', lsd: 'school district',
  evsd: 'school district', schl: 'school', sch: 'school', schools: 'school', dist: 'district',
  wh: 'withholding', whd: 'withholding', muni: 'municipal', inc: 'income', twp: 'township municipal',
  rita: 'regional income tax agency municipal', cca: 'central collection agency municipal',
  city: 'city municipal', town: 'town municipal', village: 'village municipal',
  bwc: 'bureau workers compensation', comp: 'compensation', garnish: 'garnishment', garn: 'garnishment',
  eit: 'earned income tax', lst: 'local services tax', ee: 'employee',
};

const STOP = new Set(['the', 'of', 'and', 'for', 'a', 'an', 'to', 'employee', 'local412']);

export function normalize(label, placeNames = []) {
  let text = ` ${String(label).toLowerCase()} `;
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);
  text = text.replace(/[^a-z\s]/g, ' ');
  const places = new Set(placeNames);
  const words = text.split(/\s+/).filter(Boolean).filter((w) => !places.has(w));
  const hasSchool = words.some((w) => ['school', 'schools', 'schl', 'sch', 'sd', 'sdit', 'csd', 'lsd'].includes(w));
  const out = [];
  for (const w of words) {
    // "City" inside a school-district name (Lancaster City Schools) is not a city tax signal.
    if (hasSchool && ['city', 'town', 'village'].includes(w)) continue;
    const expanded = EXPAND[w] ?? w;
    for (const t of expanded.split(' ')) if (t && !STOP.has(t)) out.push(t);
  }
  return out;
}

function trigrams(tokens) {
  const grams = [];
  for (const t of tokens) {
    const s = `_${t}_`;
    for (let i = 0; i + 3 <= s.length; i++) grams.push(`#${s.slice(i, i + 3)}`);
  }
  return grams;
}

// TF-IDF over word tokens plus character trigrams (weighted lower), L2-normalised.
export function buildVectorizer(documents, { trigramWeight = 0.35 } = {}) {
  const features = documents.map((tokens) => [...tokens, ...trigrams(tokens)]);
  const df = new Map();
  for (const f of features) for (const term of new Set(f)) df.set(term, (df.get(term) ?? 0) + 1);
  const n = documents.length;
  const idf = (term) => Math.log((1 + n) / (1 + (df.get(term) ?? 0))) + 1;
  return function vectorize(tokens) {
    const tf = new Map();
    for (const term of [...tokens, ...trigrams(tokens)]) {
      const w = term.startsWith('#') ? trigramWeight : 1;
      tf.set(term, (tf.get(term) ?? 0) + w);
    }
    const vec = new Map();
    let norm = 0;
    for (const [term, count] of tf) {
      const value = count * idf(term);
      vec.set(term, value);
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, value] of vec) vec.set(term, value / norm);
    return vec;
  };
}

export function cosine(a, b) {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other) dot += value * other;
  }
  return dot;
}

export function centroid(vectors) {
  const sum = new Map();
  for (const v of vectors) for (const [term, value] of v) sum.set(term, (sum.get(term) ?? 0) + value);
  let norm = 0;
  for (const value of sum.values()) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (const [term, value] of sum) sum.set(term, value / norm);
  return sum;
}
