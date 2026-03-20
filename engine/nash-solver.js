const MAX_ITERATIONS     = 500;
const CONVERGENCE_DELTA  = 0.0001;

/**
 * Find the Nash Equilibrium meta distribution via replicator dynamics.
 *
 * @param {Object.<string, Object.<string, number>>} matrixData
 *   Output of buildMatchupMatrix() — win rates as 0–1 floats.
 * @param {Array<{id: string, metaShare: number}>} metaDecks
 *   META_SNAPSHOT array; metaShare is a percentage (e.g. 12.5).
 * @returns {{
 *   equilibriumShares: Object.<string, number>,
 *   iterations: number,
 *   converged: boolean,
 *   dominantStrategy: string|null
 * }}
 */
export function solveNash(matrixData, metaDecks) {
  const deckIds = Object.keys(matrixData);

  // ── Step 1: Initialise shares ───────────────────────────────────────────
  const shareMap = {};
  for (const id of deckIds) {
    const deck = metaDecks.find(d => d.id === id);
    shareMap[id] = deck?.metaShare ?? deck?.popularity ?? null;  // null = missing
  }

  // Decks present in matrixData but absent from metaDecks get equal fallback share
  const knownTotal = Object.values(shareMap).reduce((s, v) => s + (v ?? 0), 0);
  const missingIds = deckIds.filter(id => shareMap[id] == null);
  const fallback   = missingIds.length
    ? (100 - knownTotal) / missingIds.length   // spread remaining share equally
    : 0;
  for (const id of missingIds) shareMap[id] = Math.max(fallback, 0);

  // Convert to fractions summing to 1.0
  const rawTotal = Object.values(shareMap).reduce((s, v) => s + v, 0);
  let shares = {};
  for (const id of deckIds) {
    shares[id] = rawTotal > 0 ? shareMap[id] / rawTotal : 1 / deckIds.length;
  }

  // ── Step 2: Replicator dynamics ─────────────────────────────────────────
  let iterations = 0;
  let converged  = false;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations++;

    // Fitness: expected win rate vs current field
    const fitness = {};
    for (const id of deckIds) {
      let f = 0;
      for (const oppId of deckIds) {
        if (oppId === id) continue;
        f += shares[oppId] * (matrixData[id][oppId] ?? 0.5);
      }
      fitness[id] = f;
    }

    // Average fitness
    let avgFitness = 0;
    for (const id of deckIds) avgFitness += shares[id] * fitness[id];

    // Guard: if avgFitness collapses to 0 (degenerate matrix), stop
    if (avgFitness === 0) break;

    // Replicator update
    const newShares = {};
    for (const id of deckIds) {
      newShares[id] = shares[id] * (fitness[id] / avgFitness);
    }

    // Normalise
    const total = Object.values(newShares).reduce((s, v) => s + v, 0);
    for (const id of deckIds) newShares[id] /= total;

    // Convergence check
    let maxDelta = 0;
    for (const id of deckIds) {
      maxDelta = Math.max(maxDelta, Math.abs(newShares[id] - shares[id]));
    }

    shares = newShares;

    if (maxDelta < CONVERGENCE_DELTA) {
      converged = true;
      break;
    }
  }

  // Round shares to 6 decimal places for clean output
  const equilibriumShares = {};
  for (const id of deckIds) equilibriumShares[id] = +shares[id].toFixed(6);

  // ── Step 3: Dominant strategy ────────────────────────────────────────────
  let dominantStrategy = null;
  for (const [id, share] of Object.entries(equilibriumShares)) {
    if (share > 0.40) { dominantStrategy = id; break; }
  }

  return { equilibriumShares, iterations, converged, dominantStrategy };
}

/**
 * Compare Nash equilibrium shares to actual meta popularity.
 *
 * @param {{ equilibriumShares: Object.<string, number> }} nashResult
 * @param {Array<{id: string, metaShare: number}>} metaDecks
 * @returns {Array<{
 *   deckId: string,
 *   nashShare: number,
 *   actualShare: number,
 *   delta: number,
 *   signal: "UNDERPICKED"|"OVERPICKED"|"BALANCED"
 * }>} sorted by delta descending (most underpicked first)
 */
export function compareToActualMeta(nashResult, metaDecks) {
  const metaById = Object.fromEntries(metaDecks.map(d => [d.id, d]));

  return Object.entries(nashResult.equilibriumShares)
    .map(([deckId, equilibriumFraction]) => {
      const nashShare   = +(equilibriumFraction * 100).toFixed(2);
      const actualShare = metaById[deckId]?.metaShare ?? metaById[deckId]?.popularity ?? 0;
      const delta       = +(nashShare - actualShare).toFixed(2);
      const signal      = delta > 3 ? 'UNDERPICKED'
                        : delta < -3 ? 'OVERPICKED'
                        : 'BALANCED';
      return { deckId, nashShare, actualShare, delta, signal };
    })
    .sort((a, b) => b.delta - a.delta);
}
