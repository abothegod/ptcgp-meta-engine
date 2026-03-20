function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Detect behavioral biases by comparing actual meta share to Nash equilibrium.
 *
 * @param {Array<{deckId,nashShare,actualShare,delta,signal}>} comparison
 *   Output of compareToActualMeta()
 * @param {Array<{id,name,winRate,popularity,metaShare,tier}>} metaDecks
 *   META_SNAPSHOT array
 * @returns {Array<{
 *   deckId, deckName, behavioralTag, biasScore,
 *   delta, nashShare, actualShare, winRate, ladderAdvice
 * }>} sorted by biasScore descending
 */
export function detectBehavioralBias(comparison, metaDecks) {
  const deckById = Object.fromEntries(metaDecks.map(d => [d.id, d]));

  // Step 1 — enrich with winRate and compute avgWinRate
  const enriched = comparison.map(entry => ({
    ...entry,
    winRate: deckById[entry.deckId]?.winRate ?? 50,
    deckName: deckById[entry.deckId]?.name ?? entry.deckId,
  }));

  const avgWinRate = enriched.reduce((s, e) => s + e.winRate, 0) / enriched.length;

  return enriched
    .map(e => {
      const { deckId, deckName, nashShare, actualShare, delta, winRate } = e;

      // Step 2 — classify (order matters: OVERHYPED before POPULARITY_TAX)
      let behavioralTag;
      if (actualShare > nashShare && winRate < avgWinRate - 3) {
        behavioralTag = 'OVERHYPED_UNDERPERFORMER';
      } else if (actualShare > nashShare && winRate <= avgWinRate) {
        behavioralTag = 'POPULARITY_TAX';
      } else if (delta > 3 && winRate >= avgWinRate) {
        behavioralTag = 'HIDDEN_GEM';
      } else if (delta > 3 && winRate < avgWinRate) {
        behavioralTag = 'OVERRATED_UNDERPLAYED';
      } else {
        behavioralTag = 'CORRECT_ASSESSMENT';
      }

      // Step 3 — biasScore
      const biasScore = +clamp(delta * (winRate / avgWinRate), -100, 100).toFixed(1);

      // Step 4 — ladderAdvice (real numbers, non-generic)
      const ns  = nashShare.toFixed(1);
      const as  = actualShare.toFixed(1);
      const wr  = winRate.toFixed(1);
      let ladderAdvice;
      switch (behavioralTag) {
        case 'OVERHYPED_UNDERPERFORMER':
          ladderAdvice = `${deckName} is a ladder trap — ${as}% play rate but only ${wr}% wins. Opponents are prepared and the deck underdelivers.`;
          break;
        case 'POPULARITY_TAX':
          ladderAdvice = `${deckName} is overrepresented (${as}% vs ${ns}% optimal). Expect tech cards targeting it in every game.`;
          break;
        case 'HIDDEN_GEM':
          ladderAdvice = `${deckName} is underplayed (${as}% actual vs ${ns}% optimal) but posts ${wr}% wins. Strong EV pick right now.`;
          break;
        case 'CORRECT_ASSESSMENT':
          ladderAdvice = `${deckName} is correctly valued by the meta at ${as}% play rate.`;
          break;
        case 'OVERRATED_UNDERPLAYED':
          ladderAdvice = `${deckName} sees low play (${as}%) and low wins (${wr}%) — community assessment appears accurate.`;
          break;
      }

      return { deckId, deckName, behavioralTag, biasScore, delta, nashShare, actualShare, winRate, ladderAdvice };
    })
    .sort((a, b) => b.biasScore - a.biasScore);
}

/**
 * Return top n EV picks (HIDDEN_GEM decks), falling back to CORRECT_ASSESSMENT
 * by win rate if fewer than n gems exist.
 *
 * @param {Array} biasData  Output of detectBehavioralBias()
 * @param {number} [n=3]
 * @returns {Array}
 */
export function getTopEVPicks(biasData, n = 3) {
  const gems = biasData
    .filter(d => d.behavioralTag === 'HIDDEN_GEM' && d.biasScore > 0)
    .sort((a, b) => b.biasScore - a.biasScore);

  if (gems.length >= n) return gems.slice(0, n);

  const fills = biasData
    .filter(d => d.behavioralTag === 'CORRECT_ASSESSMENT' && !gems.some(g => g.deckId === d.deckId))
    .sort((a, b) => b.winRate - a.winRate);

  return [...gems, ...fills].slice(0, n);
}
