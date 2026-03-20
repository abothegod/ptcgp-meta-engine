// ─── Format Constraint Analyzer ───────────────────────────────────────────────
// Mechanism Design: how do PTCGP's fixed rules shape deck viability?

const FORMAT_CONSTRAINTS = {
  deckSize:      20,
  maxCopies:     2,
  prizesPerGame: 3,
  energyPerTurn: 1,
  maxBenchSize:  3,
};

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Binomial coefficient C(n, k) via multiplicative formula. */
function binomCoeff(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

/**
 * P(X = 0) under hypergeometric distribution.
 * N = population, K = successes in population, n = draws.
 */
function hypergeomP0(N, K, n) {
  const denom = binomCoeff(N, n);
  if (denom === 0) return 1;
  return binomCoeff(N - K, n) / denom;
}

function round1(v) { return +v.toFixed(1); }

// ─── Attack stat helpers ───────────────────────────────────────────────────────

function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}

function damageOf(atk) {
  return typeof atk.damage === 'number' ? atk.damage : 0;
}

// ─── Public: analyzeFormatFit ─────────────────────────────────────────────────

/**
 * Scores how well a deck exploits (or is hurt by) PTCGP format constraints.
 *
 * @param {string[]} deckCardIds   Flat array of card IDs (duplicates = copies)
 * @param {Object}   CARD_REGISTRY Enriched ENGINE_REG
 * @returns {{ formatScore, constraints, openingHand, prizePaceEstimate }}
 */
export function analyzeFormatFit(deckCardIds, CARD_REGISTRY) {
  const N = FORMAT_CONSTRAINTS.deckSize;
  const n = 5; // opening hand size in PTCGP

  // ── Step 1: Classify cards ────────────────────────────────────────────────

  const uniqueIds = [...new Set(deckCardIds)];
  const qtys = {};
  for (const id of deckCardIds) qtys[id] = (qtys[id] ?? 0) + 1;

  // pokemon: stage not null; energy: type='Energy' or name includes 'Energy'; rest: trainer
  const pokemon  = [];
  const energy   = [];
  const trainers = [];

  for (const id of uniqueIds) {
    const card = CARD_REGISTRY[id] ?? {};
    const isEnergy  = card.type === 'Energy' || (card.name ?? '').toLowerCase().includes('energy');
    const isPokemon = card.stage != null && !isEnergy;
    if (isPokemon)     pokemon.push(id);
    else if (isEnergy) energy.push(id);
    else               trainers.push(id);
  }

  // ── Step 2: Five constraint scores ────────────────────────────────────────

  // DECK_DENSITY — key card = most frequent card ID
  const keyCardId = uniqueIds.reduce(
    (best, id) => qtys[id] > qtys[best] ? id : best, uniqueIds[0] ?? ''
  );
  const K = qtys[keyCardId] ?? 1;
  const deckDensityPct = round1((1 - hypergeomP0(N, K, n)) * 100);
  const deckDensityScore = deckDensityPct; // already 0–100

  // ENERGY_EFFICIENCY — average energy cost across all attacks in deck
  const allAttacks = deckCardIds.flatMap(id => CARD_REGISTRY[id]?.attacks ?? []);
  const costs = allAttacks.map(energyOf);
  const avgEnergyCost = costs.length
    ? costs.reduce((s, v) => s + v, 0) / costs.length
    : 0;
  const turnsToAttack = avgEnergyCost / FORMAT_CONSTRAINTS.energyPerTurn;

  let energyEfficiencyScore;
  if      (turnsToAttack <= 1) energyEfficiencyScore = 100;
  else if (turnsToAttack <= 2) energyEfficiencyScore = 80;
  else if (turnsToAttack <= 3) energyEfficiencyScore = 55;
  else if (turnsToAttack <= 4) energyEfficiencyScore = 30;
  else                          energyEfficiencyScore = 10;

  // BENCH_UTILIZATION — count unique Basic Pokémon IDs as proxy for lines needed
  const basicLines = new Set(
    uniqueIds.filter(id => (CARD_REGISTRY[id]?.stage ?? null) === 'Basic')
  );
  const linesNeeded = basicLines.size;
  const maxBench = FORMAT_CONSTRAINTS.maxBenchSize;

  let benchUtilizationScore;
  if      (linesNeeded <= maxBench)     benchUtilizationScore = 100;
  else if (linesNeeded === maxBench + 1) benchUtilizationScore = 65;
  else if (linesNeeded === maxBench + 2) benchUtilizationScore = 35;
  else                                   benchUtilizationScore = 10;

  // COPY_EFFICIENCY — fraction of unique cards running at maxCopies
  const atMax = uniqueIds.filter(id => (qtys[id] ?? 0) >= FORMAT_CONSTRAINTS.maxCopies).length;
  const copyEfficiencyScore = uniqueIds.length
    ? round1((atMax / uniqueIds.length) * 100)
    : 0;

  // PRIZE_PACE — estimated turns to take all 3 prizes
  const damages = allAttacks.map(damageOf);
  const avgDamage = damages.length
    ? damages.reduce((s, v) => s + v, 0) / damages.length
    : 0;
  const avgOpponentHP = 120;
  const hitsToKO = Math.ceil(avgOpponentHP / Math.max(avgDamage, 1));
  const turnsPerKO = hitsToKO * Math.max(turnsToAttack, 1);
  const turnsToWin = turnsPerKO * FORMAT_CONSTRAINTS.prizesPerGame;

  let prizePaceScore;
  if      (turnsToWin <= 6)  prizePaceScore = 100;
  else if (turnsToWin <= 9)  prizePaceScore = 75;
  else if (turnsToWin <= 12) prizePaceScore = 50;
  else if (turnsToWin <= 15) prizePaceScore = 25;
  else                        prizePaceScore = 10;

  // ── Step 3: Opening hand probabilities ────────────────────────────────────

  // Count total Basic Pokémon cards in deck (including copies)
  const basicCount = deckCardIds.filter(
    id => (CARD_REGISTRY[id]?.stage ?? null) === 'Basic'
  ).length;

  const p0Basic       = hypergeomP0(N, basicCount, n);
  const idealSetupPct = round1((1 - p0Basic) * 100);
  const brickedPct    = round1(p0Basic * 100);

  // ── Step 4: Weighted format score ─────────────────────────────────────────

  const formatScore = round1(
    deckDensityScore      * 0.20 +
    energyEfficiencyScore * 0.30 +
    benchUtilizationScore * 0.15 +
    copyEfficiencyScore   * 0.15 +
    prizePaceScore        * 0.20
  );

  // ── Insight strings ────────────────────────────────────────────────────────

  const constraints = {
    deckDensity: {
      score:   deckDensityScore,
      insight: `Key card appears in ${deckDensityPct}% of opening hands`,
    },
    energyEfficiency: {
      score:   energyEfficiencyScore,
      insight: `Average ${round1(turnsToAttack)} turns to first attack`,
    },
    benchUtilization: {
      score:   benchUtilizationScore,
      insight: `${linesNeeded} Basic lines vs ${maxBench} bench slots`,
    },
    copyEfficiency: {
      score:   copyEfficiencyScore,
      insight: `${copyEfficiencyScore}% of cards run at maximum copies`,
    },
    prizePace: {
      score:   prizePaceScore,
      insight: `Estimated ${round1(turnsToWin)} turns to take 3 prizes`,
    },
  };

  return {
    formatScore,
    constraints,
    openingHand:       { idealSetupPct, brickedPct },
    prizePaceEstimate: round1(turnsToWin),
  };
}

// ─── Public: compareFormatFitAcrossMeta ───────────────────────────────────────

/**
 * Run analyzeFormatFit() on every deck in metaDecks, sorted by formatScore desc.
 *
 * @param {Array<{id, name?, cards: string[]}>} metaDecks
 * @param {Object}                              CARD_REGISTRY
 * @returns {Array<{ deckId, deckName, formatScore, prizePaceEstimate, openingHand }>}
 */
export function compareFormatFitAcrossMeta(metaDecks, CARD_REGISTRY) {
  return metaDecks
    .map(deck => {
      const result = analyzeFormatFit(deck.cards ?? [], CARD_REGISTRY);
      return {
        deckId:            deck.id,
        deckName:          deck.name ?? deck.id,
        formatScore:       result.formatScore,
        prizePaceEstimate: result.prizePaceEstimate,
        openingHand:       result.openingHand,
      };
    })
    .sort((a, b) => b.formatScore - a.formatScore);
}
