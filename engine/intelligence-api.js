import { buildMatchupMatrix, getCounterDecks, getBestDeckVsField } from './matchup-matrix.js';
import { solveNash, compareToActualMeta }                          from './nash-solver.js';
import { detectBehavioralBias, getTopEVPicks }                     from './behavioral-analysis.js';
import { scoreEvolutionaryStability }                              from './evolutionary-stability.js';
import { computeShapley }                                          from './shapley-engine.js';
import { compareFormatFitAcrossMeta }                              from './mechanism-analyzer.js';
import { buildMetaOptimalDecks }                                   from './deck-builder.js';

// ─── oneLineSummary ───────────────────────────────────────────────────────────

function oneLineSummary(behavioralTag, biasScore, isESS, extinctionRisk) {
  if (isESS && behavioralTag === 'HIDDEN_GEM')
    return 'Stable meta pick flying under the radar';
  if (behavioralTag === 'OVERHYPED_UNDERPERFORMER')
    return 'Popular but underdelivering — avoid on ladder';
  if (behavioralTag === 'HIDDEN_GEM' && biasScore > 5)
    return 'Strong EV pick — underplayed vs true power level';
  if (extinctionRisk === 'HIGH')
    return 'Vulnerable to meta shift — one counter deck ends it';
  if (behavioralTag === 'POPULARITY_TAX')
    return 'Overplayed — expect prepared opponents every game';
  return 'Stable meta presence';
}

// ─── Public: analyzeFullMeta ─────────────────────────────────────────────────

/**
 * Run all six engine modules in dependency order and return a unified report.
 *
 * @param {Array}  META_SNAPSHOT  Array of deck objects with id, name, cards, winRate, popularity
 * @param {Object} ENGINE_REG     Enriched card registry (stage, hp, attacks, abilities, …)
 * @returns {Object} INTELLIGENCE_REPORT
 */
export function analyzeFullMeta(META_SNAPSHOT, ENGINE_REG) {
  console.time('[Intelligence API] analyzeFullMeta');

  function expand(cards) {
    return cards.flatMap(({ id, qty }) => Array(qty).fill(id));
  }

  // ── Step 1: Matchup matrix ─────────────────────────────────────────────────
  let matrixData = {};
  try {
    matrixData = buildMatchupMatrix(META_SNAPSHOT, ENGINE_REG);
  } catch (e) {
    console.error('[Intelligence API] buildMatchupMatrix failed:', e);
  }

  // ── Step 2: Nash equilibrium ───────────────────────────────────────────────
  let nashResult = { equilibriumShares: {}, iterations: 0, converged: false, dominantStrategy: null };
  try {
    nashResult = solveNash(matrixData, META_SNAPSHOT);
  } catch (e) {
    console.error('[Intelligence API] solveNash failed:', e);
  }

  // ── Step 3: Meta comparison ────────────────────────────────────────────────
  let comparison = [];
  try {
    comparison = compareToActualMeta(nashResult, META_SNAPSHOT);
  } catch (e) {
    console.error('[Intelligence API] compareToActualMeta failed:', e);
  }

  // ── Step 4: Behavioral bias ────────────────────────────────────────────────
  let biasData = [];
  try {
    biasData = detectBehavioralBias(comparison, META_SNAPSHOT);
  } catch (e) {
    console.error('[Intelligence API] detectBehavioralBias failed:', e);
  }

  // ── Step 5: Evolutionary stability ────────────────────────────────────────
  let essData = [];
  try {
    essData = scoreEvolutionaryStability(META_SNAPSHOT, matrixData, nashResult);
  } catch (e) {
    console.error('[Intelligence API] scoreEvolutionaryStability failed:', e);
  }

  // ── Step 6: Format fit ────────────────────────────────────────────────────
  let formatRanking = [];
  try {
    formatRanking = compareFormatFitAcrossMeta(META_SNAPSHOT, ENGINE_REG);
  } catch (e) {
    console.error('[Intelligence API] compareFormatFitAcrossMeta failed:', e);
  }

  // ── Step 7: Shapley per deck (sampleSize=100 for speed) ───────────────────
  const shapleyMap = {};
  for (const deck of META_SNAPSHOT) {
    try {
      const cards = expand(deck.cards);
      shapleyMap[deck.id] = computeShapley(cards, ENGINE_REG, 100, deck.id);
    } catch (e) {
      console.error(`[Intelligence API] computeShapley failed for ${deck.id}:`, e);
    }
  }

  // ── Build lookup maps ──────────────────────────────────────────────────────
  const biasById   = Object.fromEntries(biasData.map(d => [d.deckId, d]));
  const essById    = Object.fromEntries(essData.map(d => [d.deckId, d]));
  const formatById = Object.fromEntries(formatRanking.map(d => [d.deckId, d]));
  const fieldRanking = getBestDeckVsField(matrixData);
  const fieldById  = Object.fromEntries(fieldRanking.map(d => [d.deckId, d]));

  // Rank decks by winRate descending
  const sorted = [...META_SNAPSHOT].sort((a, b) => b.winRate - a.winRate);
  const rankById = Object.fromEntries(sorted.map((d, i) => [d.id, i + 1]));

  // ── Build perDeck ──────────────────────────────────────────────────────────
  const perDeck = {};
  for (const deck of META_SNAPSHOT) {
    const id    = deck.id;
    const bias  = biasById[id]   ?? {};
    const ess   = essById[id]    ?? {};
    const fmt   = formatById[id] ?? {};
    const shap  = shapleyMap[id] ?? {};

    // matchupProfile
    const opponents = matrixData[id] ?? {};
    const countersThese = Object.entries(opponents)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([oppId]) => oppId);

    const matchupProfile = {
      avgWinRate:   fieldById[id]?.avgWinRate ?? null,
      hardCounter:  ess.hardCounter ?? null,
      countersThese,
    };

    // oneLineSummary
    const summary = oneLineSummary(
      bias.behavioralTag, bias.biasScore, ess.isESS, ess.extinctionRisk
    );

    perDeck[id] = {
      matchupProfile,
      behavioralTag:     bias.behavioralTag     ?? 'CORRECT_ASSESSMENT',
      biasScore:         bias.biasScore         ?? 0,
      ladderAdvice:      bias.ladderAdvice       ?? '',
      essScore:          ess.essScore            ?? 0,
      isESS:             ess.isESS               ?? false,
      extinctionRisk:    ess.extinctionRisk       ?? 'MEDIUM',
      formatScore:       fmt.formatScore          ?? 0,
      prizePaceEstimate: fmt.prizePaceEstimate    ?? null,
      openingHand:       fmt.openingHand          ?? { idealSetupPct: 0, brickedPct: 100 },
      shapley: {
        mostValuableCard: shap.mostValuableCard ?? null,
        weakestLink:      shap.weakestLink      ?? null,
        cardValues:       shap.cardValues       ?? [],
      },
      overallRank:    rankById[id] ?? 0,
      oneLineSummary: summary,
    };
  }

  // ── Step 8: Autonomous deck builder (all 5 archetypes) ───────────────────
  const report = {
    generatedAt:   new Date().toISOString(),
    nash:          nashResult,
    behavioral:    biasData,
    evolutionary:  essData,
    formatRanking,
    topEVPicks:    getTopEVPicks(biasData, 3),
    perDeck,
    builtDecks:    [],
  };

  try {
    report.builtDecks = buildMetaOptimalDecks(
      ENGINE_REG, META_SNAPSHOT, ENGINE_REG,
      ['AGGRO', 'CONTROL', 'TANK', 'TRIGGER', 'BALANCED'],
    );
  } catch (e) {
    console.error('[Intelligence API] buildMetaOptimalDecks failed:', e);
  }

  console.timeEnd('[Intelligence API] analyzeFullMeta');

  return report;
}
