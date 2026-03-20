// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_CHART = {
  Fire:       'Grass',
  Water:      'Fire',
  Lightning:  'Water',
  Fighting:   'Lightning',
  Psychic:    'Fighting',
  Darkness:   'Psychic',
  Metal:      'Darkness',
  Grass:      'Water',
};

const DISRUPTION_KEYWORDS = ['paralyze', 'confuse', 'asleep', 'discard', 'prevent', 'switch', "can't"];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}

// ─── Step 1: Deck profile extraction ─────────────────────────────────────────

/**
 * Build a statistical profile for a single deck.
 *
 * @param {{ id, name, tier, winRate, metaShare, cards: Array<{id,qty}> }} deck
 * @param {Object} ENGINE_REG  — enriched card registry with stage/hp/attacks/abilities
 * @returns {{
 *   deckId: string, primaryType: string,
 *   avgEnergyCost: number, avgHp: number, avgDamage: number,
 *   avgRetreatCost: number, hasDisruption: boolean,
 *   winRate: number, metaShare: number
 * }}
 */
export function buildDeckProfile(deck, ENGINE_REG) {
  const flat = deck.cards.flatMap(({ id, qty }) => Array(qty).fill(id));

  const poke = flat
    .map(id => ENGINE_REG[id])
    .filter(c => c && c.stage != null);   // exclude Trainers / nulls

  // Primary type — most frequent Pokémon type (first occurrence wins ties)
  const typeCounts = {};
  for (const c of poke) {
    if (c.type) typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
  }
  const primaryType = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Colorless';

  // Attack aggregates
  let totalEnergy = 0, atkCount = 0, totalDamage = 0, dmgCount = 0;
  for (const c of poke) {
    for (const atk of (c.attacks ?? [])) {
      totalEnergy += energyOf(atk);
      atkCount++;
      if (typeof atk.damage === 'number') { totalDamage += atk.damage; dmgCount++; }
    }
  }
  const avgEnergyCost = atkCount > 0 ? totalEnergy / atkCount : 0;
  const avgDamage     = dmgCount > 0 ? totalDamage / dmgCount : 0;

  // HP and retreat
  const avgHp         = poke.length ? poke.reduce((s, c) => s + (c.hp ?? 0), 0) / poke.length : 0;
  const avgRetreatCost= poke.length ? poke.reduce((s, c) => s + (c.retreatCost ?? 0), 0) / poke.length : 0;

  // Disruption — any attack effect or ability text matches keywords
  const allCards = flat.map(id => ENGINE_REG[id]).filter(Boolean);
  const hasDisruption = allCards.some(c => {
    const texts = [
      ...(c.attacks   ?? []).map(a => (a.effect ?? a.effectText ?? '').toLowerCase()),
      ...(c.abilities ?? []).map(a => (a.text ?? '').toLowerCase()),
    ];
    return DISRUPTION_KEYWORDS.some(kw => texts.some(t => t.includes(kw)));
  });

  return {
    deckId:        deck.id,
    primaryType,
    avgEnergyCost,
    avgHp,
    avgDamage,
    avgRetreatCost,
    hasDisruption,
    winRate:   deck.winRate   ?? 50,
    metaShare: deck.metaShare ?? deck.popularity ?? 0,
  };
}

// ─── Step 2: Pairwise edge score ──────────────────────────────────────────────

/**
 * Compute profileA's edge score against profileB (0–100, 50 = even).
 * Each call gives A's perspective; calling with args swapped gives B's.
 *
 * @param {Object} profileA
 * @param {Object} profileB
 * @returns {number}
 */
export function computeEdge(profileA, profileB) {
  let score = 50;

  // TYPE_ADVANTAGE
  if (TYPE_CHART[profileA.primaryType] === profileB.primaryType) score += 8;
  if (TYPE_CHART[profileB.primaryType] === profileA.primaryType) score -= 8;

  // SPEED_EDGE — positive diff means B is slower → A advantage
  const speedDiff = profileB.avgEnergyCost - profileA.avgEnergyCost;
  if (speedDiff >=  0.5) score += 6;
  if (speedDiff <= -0.5) score -= 6;

  // DAMAGE_EDGE — can A's attacks one-shot B's Pokémon?
  if (profileA.avgDamage >= profileB.avgHp * 0.7) score += 5;
  if (profileB.avgDamage >= profileA.avgHp * 0.7) score -= 5;

  // DISRUPTION_EDGE
  if ( profileA.hasDisruption && !profileB.hasDisruption) score += 4;
  if (!profileA.hasDisruption &&  profileB.hasDisruption) score -= 4;

  // WIN_RATE_ADJUSTMENT — weight by historical win rates
  const delta = clamp((profileA.winRate - profileB.winRate) * 0.15, -7.5, 7.5);
  score += delta;

  return clamp(score, 0, 100);
}

// ─── Step 3: Build full matrix ────────────────────────────────────────────────

/**
 * Build the MATCHUP_MATRIX object for all ordered pairs in metaDecks.
 *
 * @param {Array<{id, cards, winRate, popularity, metaShare}>} metaDecks
 * @param {Object} ENGINE_REG
 * @returns {Object.<string, Object.<string, number>>}  win rates as 0–1 floats
 */
export function buildMatchupMatrix(metaDecks, ENGINE_REG) {
  const profiles = metaDecks.map(deck => buildDeckProfile(deck, ENGINE_REG));
  const profileById = Object.fromEntries(profiles.map(p => [p.deckId, p]));

  const matrix = {};

  for (const pA of profiles) {
    matrix[pA.deckId] = {};
    for (const pB of profiles) {
      if (pA.deckId === pB.deckId) continue;            // no self-matchup
      const edge = computeEdge(profileById[pA.deckId], profileById[pB.deckId]);
      matrix[pA.deckId][pB.deckId] = +(edge / 100).toFixed(4);
    }
  }

  return matrix;
}

// ─── Step 4: Helper functions ─────────────────────────────────────────────────

/**
 * Return top n decks that beat deckId most heavily (worst matchups for deckId).
 *
 * @param {string} deckId
 * @param {Object} matrixData
 * @param {number} [n=3]
 * @returns {Array<{opponentId: string, winRateAgainst: number}>}
 */
export function getCounterDecks(deckId, matrixData, n = 3) {
  const row = matrixData[deckId];
  if (!row) return [];
  return Object.entries(row)
    .map(([opponentId, winRateAgainst]) => ({ opponentId, winRateAgainst }))
    .sort((a, b) => a.winRateAgainst - b.winRateAgainst)
    .slice(0, n);
}

/**
 * For each deck, compute its average win rate across all opponents.
 *
 * @param {Object} matrixData
 * @returns {Array<{deckId: string, avgWinRate: number}>} sorted descending
 */
export function getBestDeckVsField(matrixData) {
  return Object.entries(matrixData)
    .map(([deckId, opponents]) => {
      const vals = Object.values(opponents);
      const avgWinRate = vals.length
        ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4)
        : 0;
      return { deckId, avgWinRate };
    })
    .sort((a, b) => b.avgWinRate - a.avgWinRate);
}
