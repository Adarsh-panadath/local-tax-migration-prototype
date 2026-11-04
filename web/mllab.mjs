// The ML Lab: proof that the label clustering works, on far more labels than the demo pool.
// It uses the engine's own code (clusterLabels and assignLabel), unchanged:
//   1. make a labelled set of Desktop labels (generate.mjs: real patterns, typos, place names, case),
//   2. hold back 20% the model never sees,
//   3. fit the clusters on the other 80% (no expert answers are used to fit; they only grade),
//   4. score every held-back label exactly as the engine scores a new company's label,
//   5. compare with simple keyword rules, and draw the clusters on a 2D map.
import { clusterLabels, assignLabel } from './engine/cluster.mjs';
import { cosine, normalize } from './engine/text.mjs';
import { labelSet, rng, SEED, LAB_MIX } from './generate.mjs';

const keyOf = (entry) => (entry ? (entry.kind === 'tax' ? entry.tax_type : `non_tax:${entry.entry_id}`) : null);

export const KEY_NAMES = {
  school_district: 'School district', municipal: 'City tax', 'non_tax:N-DUES': 'Union dues', 'non_tax:N-GARN': 'Garnishment',
  'non_tax:N-WC': "Workers' comp", 'non_tax:N-PARK': 'Parking', 'non_tax:N-CHAR': 'Charity', ambiguous: 'Ambiguous', expert: 'To an expert',
};
export const KEYS = LAB_MIX.map(([k]) => k);

// The baseline the model has to beat: no clustering, just the same clean-up as the engine and then the
// catalogue entry that shares the most words with the label. A tie, or no shared word, goes to an expert.
// It knows exactly what the model knows about words, so the difference is what clustering adds.
export function makeBaseline(entries, placeNames) {
  const words = entries.map((e) => ({ key: keyOf(e), words: new Set(normalize(e.text, placeNames)) }));
  return (label) => {
    const toks = new Set(normalize(label, placeNames));
    let best = null;
    let bestN = 0;
    let tie = false;
    for (const w of words) {
      const n = [...toks].filter((t) => w.words.has(t)).length;
      if (n > bestN) { best = w.key; bestN = n; tie = false; } else if (n === bestN && n > 0 && w.key !== best) tie = true;
    }
    return bestN > 0 && !tie ? best : null;
  };
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function score(results, field) {
  const suggested = results.filter((r) => r[field] !== 'expert');
  const right = suggested.filter((r) => r[field] === r.truth).length;
  // Sending an ambiguous label to an expert is the right answer; any other deferral costs an expert's time.
  const correct = results.filter((r) => r[field] === r.truth || (r[field] === 'expert' && r.truth === 'ambiguous')).length;
  return {
    n: results.length,
    suggested: suggested.length,
    coverage: results.length ? suggested.length / results.length : 0,
    precision: suggested.length ? right / suggested.length : 0,
    wrong: suggested.length - right,
    accuracy: results.length ? correct / results.length : 0,
  };
}

// Kernel PCA on cosine similarity: a 2D picture of how close the labels are to each other.
function kernelPca(vectors, extra, seed) {
  const n = vectors.length;
  const K = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) { K[i][i] = 1; for (let j = i + 1; j < n; j += 1) { const s = cosine(vectors[i], vectors[j]); K[i][j] = s; K[j][i] = s; } }
  const rowMean = K.map((row) => row.reduce((s, v) => s + v, 0) / n);
  const all = rowMean.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) K[i][j] = K[i][j] - rowMean[i] - rowMean[j] + all;
  const r = rng(seed);
  const comps = [];
  for (let c = 0; c < 2; c += 1) {
    let v = Float64Array.from({ length: n }, () => r() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 80; it += 1) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i += 1) { let s = 0; const row = K[i]; for (let j = 0; j < n; j += 1) s += row[j] * v[j]; w[i] = s; }
      for (const p of comps) { const dot = p.u.reduce((s, x, i) => s + x * v[i], 0); for (let i = 0; i < n; i += 1) w[i] -= p.lambda * p.u[i] * dot; }
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
      lambda = norm;
      v = w.map((x) => x / norm);
    }
    comps.push({ u: v, lambda });
  }
  const at = (i) => comps.map((p) => p.u[i] * Math.sqrt(p.lambda));
  const project = (vec) => {
    const k = vectors.map((x) => cosine(vec, x));
    const mean = k.reduce((s, v) => s + v, 0) / n;
    return comps.map((p) => { let s = 0; for (let j = 0; j < n; j += 1) s += (k[j] - mean - rowMean[j] + all) * p.u[j]; return s / Math.sqrt(p.lambda); });
  };
  return { train: vectors.map((_, i) => at(i)), extra: extra.map(project), explained: comps.map((p) => p.lambda) };
}

export function runLab(catalog, { seed = SEED, total = 1200, testShare = 0.2, itemFloor = 0.25, maxK = 30, map = true } = {}) {
  const set = labelSet({ seed, total });
  const cut = Math.round(set.length * (1 - testShare));
  const train = set.slice(0, cut);
  const test = set.slice(cut);
  const entries = catalog.defined_entries.filter((e) => e.states.includes('OH'));
  const placeNames = catalog.states.OH.place_names;
  const trainLabels = [...new Set(train.map((x) => x.label))];
  const truthOf = new Map(train.map((x) => [x.label, x.key]));

  const t0 = now();
  // k is chosen by silhouette from 2 to maxK. The engine's demo pool (53 labels) uses 2 to 12; a pool this size needs room for more.
  const fitted = clusterLabels(trainLabels, entries, placeNames, { maxK });
  const keywordGuess = makeBaseline(entries, placeNames);
  const fitMs = now() - t0;

  const clusters = fitted.clusters.map((c) => {
    const tally = {};
    for (const i of c.members) tally[truthOf.get(trainLabels[i])] = (tally[truthOf.get(trainLabels[i])] ?? 0) + 1;
    const [majority, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    return {
      index: c.index, name: c.entry?.label ?? 'Unnamed cluster', key: keyOf(c.entry), size: c.size, meanSilhouette: c.meanSilhouette,
      purity: count / c.size, majority, examples: c.members.slice(0, 8).map((i) => trainLabels[i]),
    };
  });

  const t1 = now();
  // Person in the loop: an expert looks at each cluster once and names it by what its labels are
  // (simulated with the majority answer; "ambiguous" means the expert keeps it for review).
  const expertName = clusters.map((c) => (c.majority === 'ambiguous' ? null : c.majority));
  const results = test.map((x) => {
    const a = assignLabel(fitted, x.label);
    const key = a.cluster >= 0 ? keyOf(fitted.clusters[a.cluster].entry) : null;
    const confident = Boolean(key) && a.silhouette >= itemFloor;
    const named = a.cluster >= 0 ? expertName[a.cluster] : null;
    return {
      label: x.label, truth: x.key, model: confident ? key : 'expert', modelGuess: key, silhouette: a.silhouette, cluster: a.cluster,
      named: named && a.silhouette >= itemFloor ? named : 'expert',
      keyword: keywordGuess(x.label) ?? 'expert', seen: truthOf.has(x.label),
    };
  });
  const scoreMs = now() - t1;

  const cols = [...KEYS.filter((k) => k !== 'ambiguous'), 'expert'];
  const confusion = KEYS.map((truth) => ({ truth, cells: cols.map((p) => results.filter((r) => r.truth === truth && r.model === p).length) }));
  const unseen = results.filter((r) => !r.seen);
  const model = score(results, 'model');
  const named = score(results, 'named');
  const keyword = score(results, 'keyword');
  const modelUnseen = score(unseen, 'model');
  const keywordUnseen = score(unseen, 'keyword');
  const wins = results.filter((r) => r.model === r.truth && r.keyword !== r.truth).slice(0, 8);
  const misses = results.filter((r) => r.model !== 'expert' && r.model !== r.truth).slice(0, 8);
  const deferred = results.filter((r) => r.model === 'expert' && r.truth !== 'ambiguous').slice(0, 8);

  const projection = map ? kernelPca(fitted.vectors, results.map((r) => fitted.vectorize(fitted.tokens.length ? (r.tokens ?? normalizeFor(fitted, r.label)) : [])), seed) : null;

  return {
    seed, total: set.length, trainSize: train.length, testSize: test.length, distinctTrain: trainLabels.length,
    mix: KEYS.map((k) => ({ key: k, n: set.filter((x) => x.key === k).length })),
    k: fitted.k, silhouette: fitted.silhouette, curve: fitted.curve, fitMs, scoreMs, itemFloor,
    maxK, clusters, assignment: fitted.assignment, trainLabels, trainTruth: trainLabels.map((l) => truthOf.get(l)),
    results, confusion, cols, model, named, keyword, namedUnseen: score(unseen, 'named'), clustersNamedByExpert: expertName.filter(Boolean).length, modelUnseen, keywordUnseen, unseen: unseen.length, wins, misses, deferred, projection,
  };
}

// The engine's own clean-up, so held-back labels are mapped the same way as the training labels.
function normalizeFor(fitted, label) { return normalize(label, fitted.placeNames); }
