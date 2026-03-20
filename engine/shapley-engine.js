import { scoreDeck }   from './scoring.js';
import { analyzeDeck } from './analysis.js';

// ─── Seeded PRNG ──────────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function deckSeed(deckCardIds) {
  return deckCardIds.join(',').split('').reduce(
    (h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0
  );
}

/** Fisher-Yates shuffle using a provided seeded random function. */
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Role classification ──────────────────────────────────────────────────────

function assignRoles(sortedCards) {
  const n = sortedCards.length;
  const coreCutoff    = Math.ceil(n * 0.25);
  const supportCutoff = coreCutoff    + Math.ceil(n * 0.40);
  const flexCutoff    = supportCutoff + Math.ceil(n * 0.25);

  return sortedCards.map((card, i) => {
    if (card.shapleyValue <= 0) return { ...card, role: 'DEADWEIGHT' };
    if (i < coreCutoff)         return { ...card, role: 'CORE' };
    if (i < supportCutoff)      return { ...card, role: 'SUPPORT' };
    if (i < flexCutoff)         return { ...card, role: 'FLEX' };
    return { ...card, role: 'DEADWEIGHT' };
  });
}

// ─── Candidate filter (mirrors suggestions.js qualifiesFor) ──────────────────

const DISRUPTION_KW = ['paralyze', 'confuse', 'asleep', 'discard', 'prevent', 'switch', "can't"];

function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}
function effectOf(atk)  { return (atk.effect ?? atk.effectText ?? '').toLowerCase(); }
function maxDamage(c)   { const d = (c.attacks ?? []).map(a => typeof a.damage === 'number' ? a.damage : 0); return d.length ? Math.max(...d) : 0; }
function minEnergy(c)   { const e = (c.attacks ?? []).map(energyOf); return e.length ? Math.min(...e) : Infinity; }
function hasDisruption(c) {
  const texts = [...(c.attacks ?? []).map(effectOf), ...(c.abilities ?? []).map(a => (a.text ?? '').toLowerCase())];
  return DISRUPTION_KW.some(kw => texts.some(t => t.includes(kw)));
}

function qualifiesFor(dimension, card) {
  switch (dimension) {
    case 'speed':         return card.stage === 'Basic' && minEnergy(card) <= 1;
    case 'damage':        return maxDamage(card) >= 80;
    case 'survivability': return (card.hp ?? 0) >= 120;
    case 'consistency':   return card.stage === 'Basic';
    case 'disruption':    return hasDisruption(card);
    default:              return false;
  }
}

// ─── Public: computeShapley ───────────────────────────────────────────────────

/**
 * Monte Carlo Shapley value approximation for each unique card in a deck.
 *
 * @param {string[]} deckCardIds    Flat array (duplicates represent copies)
 * @param {Object}   CARD_REGISTRY  Enriched ENGINE_REG
 * @param {number}   [sampleSize=200]
 * @param {string}   [deckId=null]  Pass-through identifier
 * @returns {{
 *   deckId: string|null, baseScore: number,
 *   cardValues: Array, mostValuableCard: string, weakestLink: string
 * }}
 */
export function computeShapley(deckCardIds, CARD_REGISTRY, sampleSize = 200, deckId = null) {
  const uniqueCards = [...new Set(deckCardIds)];
  const qtys = Object.fromEntries(uniqueCards.map(id => [id, deckCardIds.filter(x => x === id).length]));
  const baseScore = scoreDeck(deckCardIds, CARD_REGISTRY).total;

  const rand = mulberry32(deckSeed(deckCardIds));

  // Accumulate marginal contributions
  const totals = Object.fromEntries(uniqueCards.map(id => [id, 0]));
  const counts = Object.fromEntries(uniqueCards.map(id => [id, 0]));

  for (let i = 0; i < sampleSize; i++) {
    const perm = shuffle(uniqueCards, rand);
    let prevScore = 0;
    const coalition = [];

    for (const card of perm) {
      coalition.push(card);
      // Expand coalition to full deck with original copy counts
      const coalitionDeck = coalition.flatMap(id => Array(qtys[id]).fill(id));
      const newScore = scoreDeck(coalitionDeck, CARD_REGISTRY).total;
      totals[card] += newScore - prevScore;
      counts[card]++;
      prevScore = newScore;
    }
  }

  // Average marginal contributions
  const rawValues = Object.fromEntries(
    uniqueCards.map(id => [id, +(totals[id] / counts[id]).toFixed(2)])
  );

  // Sort descending for role assignment
  const sorted = uniqueCards
    .map(id => ({ cardId: id, shapleyValue: rawValues[id] }))
    .sort((a, b) => b.shapleyValue - a.shapleyValue);

  const withRoles = assignRoles(sorted).map(c => ({
    ...c,
    cardName:    CARD_REGISTRY[c.cardId]?.name ?? c.cardId,
    replaceable: c.role === 'FLEX' || c.role === 'DEADWEIGHT',
  }));

  const mostValuableCard = withRoles[0].cardId;
  const weakestLink      = withRoles[withRoles.length - 1].cardId;

  return { deckId, baseScore, cardValues: withRoles, mostValuableCard, weakestLink };
}

// ─── Public: suggestShapleySwaps ─────────────────────────────────────────────

/**
 * Suggest swaps for the lowest-Shapley-value cards in the deck.
 *
 * @param {string[]} deckCardIds
 * @param {Object}   CARD_REGISTRY
 * @param {number}   [sampleSize=200]
 * @returns {{ shapleySwaps: Array }}
 */
export function suggestShapleySwaps(deckCardIds, CARD_REGISTRY, sampleSize = 200) {
  const result  = computeShapley(deckCardIds, CARD_REGISTRY, sampleSize);
  const deckSet = new Set(deckCardIds);

  // Replaceable cards ordered by ascending Shapley value (weakest first)
  const replaceable = result.cardValues
    .filter(c => c.replaceable)
    .sort((a, b) => a.shapleyValue - b.shapleyValue);

  if (!replaceable.length) return { shapleySwaps: [] };

  // Get deck weaknesses to guide candidate filtering
  const { weaknesses } = analyzeDeck(deckCardIds, CARD_REGISTRY);
  const weakDimensions = weaknesses.map(w => w.dimension);
  // Fall back to all dimensions if no weaknesses
  const dimensions = weakDimensions.length
    ? weakDimensions
    : ['speed', 'damage', 'survivability', 'consistency', 'disruption'];

  const swaps = [];

  // Only test the top 3 most-replaceable cards
  for (const target of replaceable.slice(0, 3)) {
    // Build candidate set: not in deck, qualifies for at least one weak dimension
    const candidates = Object.entries(CARD_REGISTRY)
      .filter(([id, card]) => !deckSet.has(id) && dimensions.some(dim => qualifiesFor(dim, card)))
      .map(([id]) => id);

    if (!candidates.length) continue;

    // Test each candidate with a cheap Shapley run (sampleSize=50)
    let bestCandidate = null;
    let bestScore     = result.baseScore;

    for (const candidateId of candidates) {
      const testDeck = deckCardIds.filter(id => id !== target.cardId);
      testDeck.push(candidateId);
      const newScore = scoreDeck(testDeck, CARD_REGISTRY).total;
      if (newScore > bestScore) {
        bestScore     = newScore;
        bestCandidate = candidateId;
      }
    }

    if (!bestCandidate) continue;

    const addCard = CARD_REGISTRY[bestCandidate];
    swaps.push({
      remove:               target.cardId,
      removeName:           target.cardName,
      removeShapleyValue:   target.shapleyValue,
      add:                  bestCandidate,
      addName:              addCard?.name ?? bestCandidate,
      reason:               `${target.cardName} contributes only ${target.shapleyValue} pts on average. ` +
                            `${addCard?.name ?? bestCandidate} improves deck score by ${bestScore - result.baseScore} pts.`,
    });
  }

  return { shapleySwaps: swaps };
}
