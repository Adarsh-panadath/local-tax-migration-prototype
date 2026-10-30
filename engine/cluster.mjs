// Clustering of custom labels within one state, scored with the silhouette coefficient,
// and naming of each cluster by its closest defined catalogue entry.
import { normalize, buildVectorizer, cosine, centroid } from './text.mjs?v=9493856212';

export const MODEL_VERSION = 'label-clusters v1.1 (fitted per state on the labelled pool; TF-IDF + trigrams, average linkage)';

function distanceMatrix(vectors) {
  const n = vectors.length;
  const d = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = 1 - cosine(vectors[i], vectors[j]);
      d[i][j] = value;
      d[j][i] = value;
    }
  }
  return d;
}

// Average-linkage agglomerative clustering. Returns the cluster assignment for every k from n down to 1.
function agglomerate(d) {
  const n = d.length;
  let clusters = Array.from({ length: n }, (_, i) => [i]);
  const byK = new Map([[n, clusters.map((c) => [...c])]]);
  const avg = (a, b) => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += d[i][j];
    return sum / (a.length * b.length);
  };
  while (clusters.length > 1) {
    let best = [0, 1];
    let bestValue = Infinity;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const value = avg(clusters[a], clusters[b]);
        if (value < bestValue) { bestValue = value; best = [a, b]; }
      }
    }
    const [a, b] = best;
    const merged = [...clusters[a], ...clusters[b]];
    clusters = clusters.filter((_, i) => i !== a && i !== b);
    clusters.push(merged);
    byK.set(clusters.length, clusters.map((c) => [...c]));
  }
  return byK;
}

// Silhouette per item: (b - a) / max(a, b). Items alone in a cluster score 0, as in the usual definition.
export function silhouette(d, clusters) {
  const assignment = new Array(d.length);
  clusters.forEach((members, c) => members.forEach((i) => { assignment[i] = c; }));
  const scores = new Array(d.length).fill(0);
  for (let i = 0; i < d.length; i++) {
    const own = clusters[assignment[i]];
    if (own.length < 2) continue;
    const a = own.reduce((s, j) => (j === i ? s : s + d[i][j]), 0) / (own.length - 1);
    let b = Infinity;
    clusters.forEach((members, c) => {
      if (c === assignment[i]) return;
      const mean = members.reduce((s, j) => s + d[i][j], 0) / members.length;
      if (mean < b) b = mean;
    });
    const denom = Math.max(a, b);
    scores[i] = denom === 0 ? 0 : (b - a) / denom;
  }
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  return { scores, mean };
}

/**
 * Cluster a state's labels and name each cluster.
 * @param {string[]} labels      all labels to cluster (pool + this company's custom items)
 * @param {object[]} entries     defined catalogue entries usable in this state
 * @param {string[]} placeNames  place names to strip
 */
export function clusterLabels(labels, entries, placeNames, options = {}) {
  const { minK = 2, maxK = 12, nameFloor = 0.2 } = options;
  const tokens = labels.map((l) => normalize(l, placeNames));
  const entryTokens = entries.map((e) => normalize(e.text, placeNames));
  const vectorize = buildVectorizer([...tokens, ...entryTokens]);
  const vectors = tokens.map(vectorize);
  const entryVectors = entryTokens.map(vectorize);

  if (labels.length < 3) {
    return { labels, tokens, clusters: [], assignment: labels.map(() => -1), itemScores: labels.map(() => 0), silhouette: 0, k: 0, vectors, vectorize, placeNames };
  }

  const d = distanceMatrix(vectors);
  const byK = agglomerate(d);
  let best = null;
  const upper = Math.min(maxK, labels.length - 1);
  for (let k = Math.max(2, minK); k <= upper; k++) {
    const clusters = byK.get(k);
    const { scores, mean } = silhouette(d, clusters);
    if (!best || mean > best.mean) best = { k, clusters, scores, mean };
  }

  const assignment = new Array(labels.length);
  const named = best.clusters.map((members, index) => {
    members.forEach((i) => { assignment[i] = index; });
    const c = centroid(members.map((i) => vectors[i]));
    let entry = null;
    let similarity = 0;
    entries.forEach((e, j) => {
      const s = cosine(c, entryVectors[j]);
      if (s > similarity) { similarity = s; entry = e; }
    });
    const meanSilhouette = members.reduce((s, i) => s + best.scores[i], 0) / members.length;
    return {
      index,
      members,
      size: members.length,
      entry: similarity >= nameFloor ? entry : null,
      nameSimilarity: similarity,
      meanSilhouette,
    };
  });

  return {
    labels,
    tokens,
    clusters: named,
    assignment,
    itemScores: best.scores,
    silhouette: best.mean,
    k: best.k,
    vectors,
    vectorize,
    placeNames,
  };
}

/**
 * Score a new label against clusters that were fitted without it (the state model is fitted once,
 * on the expert-labelled pool). The label joins the cluster with the smallest average distance
 * (average linkage), and its own silhouette is (b - a) / max(a, b) against the fitted clusters.
 * A label with no words left after clean-up joins no cluster.
 */
export function assignLabel(fitted, label) {
  const tokens = normalize(label, fitted.placeNames);
  if (!tokens.length || !fitted.clusters.length) return { cluster: -1, silhouette: 0, tokens, empty: !tokens.length };
  const v = fitted.vectorize(tokens);
  const means = fitted.clusters.map((c) => c.members.reduce((s, i) => s + (1 - cosine(v, fitted.vectors[i])), 0) / c.members.length);
  let best = 0;
  means.forEach((m, i) => { if (m < means[best]) best = i; });
  const a = means[best];
  const others = means.filter((_, i) => i !== best);
  const b = others.length ? Math.min(...others) : a;
  const denom = Math.max(a, b);
  return { cluster: best, silhouette: denom === 0 ? 0 : (b - a) / denom, tokens, empty: false };
}
