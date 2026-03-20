function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return +v.toFixed(1); }

/**
 * Score Evolutionarily Stable Strategy (ESS) properties for each deck.
 *
 * @param {Array<{id,winRate}>}                            metaDecks
 * @param {Object.<string,Object.<string,number>>}         matrixData
 * @param {{ equilibriumShares: Object.<string,number> }}  nashResult
 * @returns {Array<{
 *   deckId, essScore, isESS, mirrorScore,
 *   invasionVulnerability, fieldFitness,
 *   extinctionRisk, hardCounter
 * }>} sorted by essScore descending
 */
export function scoreEvolutionaryStability(metaDecks, matrixData, nashResult) {
  const shares = nashResult.equilibriumShares;

  // Index metaDecks by id for quick lookup
  const deckById = Object.fromEntries(metaDecks.map(d => [d.id, d]));

  // Only score decks present in matrixData
  const deckIds = Object.keys(matrixData);

  return deckIds
    .map(deckId => {
      const opponents = matrixData[deckId];           // { opponentId: wr }

      // ── MIRROR_SCORE ─────────────────────────────────────────────────────
      // Proxy: average win rate vs the 3 decks with closest win rate in META_SNAPSHOT
      const myWR = deckById[deckId]?.winRate ?? 50;
      const similar = deckIds
        .filter(id => id !== deckId)
        .map(id => ({ id, dist: Math.abs((deckById[id]?.winRate ?? 50) - myWR) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      const mirrorScore = similar.length
        ? round1(similar.reduce((s, { id }) => s + (opponents[id] ?? 0.5), 0) / similar.length * 100)
        : 50;

      // ── INVASION_VULNERABILITY ────────────────────────────────────────────
      const opponentEntries = Object.entries(opponents);
      const worstWR = opponentEntries.length
        ? Math.min(...opponentEntries.map(([, wr]) => wr))
        : 0.5;
      const invasionVulnerability = round1((1 - worstWR) * 100);

      const hardCounter = opponentEntries.length
        ? opponentEntries.reduce((worst, [id, wr]) => wr < worst.wr ? { id, wr } : worst,
            { id: opponentEntries[0][0], wr: opponentEntries[0][1] }).id
        : null;

      // ── FIELD_FITNESS ─────────────────────────────────────────────────────
      let fieldFitness = 0;
      for (const [oppId, wr] of opponentEntries) {
        fieldFitness += (shares[oppId] ?? 0) * wr * 100;
      }
      fieldFitness = round1(fieldFitness);

      // ── ESS_SCORE ─────────────────────────────────────────────────────────
      const essScore = round1(
        mirrorScore            * 0.30 +
        (100 - invasionVulnerability) * 0.40 +
        fieldFitness           * 0.30
      );

      const isESS = essScore >= 65;

      const extinctionRisk = invasionVulnerability < 35 ? 'LOW'
                           : invasionVulnerability < 60 ? 'MEDIUM'
                           :                             'HIGH';

      return { deckId, essScore, isESS, mirrorScore, invasionVulnerability, fieldFitness, extinctionRisk, hardCounter };
    })
    .sort((a, b) => b.essScore - a.essScore);
}

/**
 * Simulate a meta shift where one deck gains +15% Nash share.
 *
 * @param {Array}  essData       Output of scoreEvolutionaryStability()
 * @param {Object} matrixData
 * @param {{ equilibriumShares: Object.<string,number> }} nashResult
 * @param {string} boostedDeckId
 * @returns {{ boostedDeck: string, results: Array }}
 */
export function simulateMetaShift(essData, matrixData, nashResult, boostedDeckId) {
  const baseShares = nashResult.equilibriumShares;

  // Step 1 — modified shares: boost by +0.15, renormalise
  const modifiedShares = { ...baseShares };
  modifiedShares[boostedDeckId] = (modifiedShares[boostedDeckId] ?? 0) + 0.15;
  const total = Object.values(modifiedShares).reduce((s, v) => s + v, 0);
  for (const id of Object.keys(modifiedShares)) modifiedShares[id] /= total;

  // Build quick lookup of before-scores
  const before = Object.fromEntries(essData.map(d => [d.deckId, d]));

  // Step 2+3 — recompute fieldFitness and essScore with modified shares
  const results = Object.keys(matrixData).map(deckId => {
    const b = before[deckId];
    if (!b) return null;

    // New fieldFitness
    let newFieldFitness = 0;
    for (const [oppId, wr] of Object.entries(matrixData[deckId])) {
      newFieldFitness += (modifiedShares[oppId] ?? 0) * wr * 100;
    }
    newFieldFitness = round1(newFieldFitness);

    const newEssScore = round1(
      b.mirrorScore                       * 0.30 +
      (100 - b.invasionVulnerability)     * 0.40 +
      newFieldFitness                     * 0.30
    );

    const wasESS = b.isESS;
    const nowESS = newEssScore >= 65;
    const essStatusChange = (!wasESS && nowESS) ? 'GAINED'
                          : (wasESS && !nowESS) ? 'LOST'
                          :                       'UNCHANGED';

    return {
      deckId,
      essScoreBefore: b.essScore,
      essScoreAfter:  newEssScore,
      delta:          round1(newEssScore - b.essScore),
      essStatusChange,
    };
  }).filter(Boolean);

  results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { boostedDeck: boostedDeckId, results };
}
