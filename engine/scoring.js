import { getTrainerEffect, getTrainerForType, isTypeCompatible,
         isSupporter, isItem, isTool, isStadium } from './trainer-data.js';

// ─── Tunable weights ──────────────────────────────────────────────────────────
// Calibration log:
//   Phase 1 (spec defaults): highest win-rate deck scored 53 — failed ≥75 target.
//     Root cause: Stage 2 speed penalty of -15 capped mimikyu's speed at 74.8,
//     one tick below 75; no weight shift could overcome that hard ceiling.
//   Option A applied: Stage 2 penalty -15 → -8.
//     Rationale: a Stage 2 Pokémon is a deck's payoff attacker, not a pure
//     "slowness tax" equal to 15 pts; -8 better reflects the actual setup cost
//     while still penalising multi-stage evo lines relative to Basic-only decks.
//     This lifts mimikyu's speed to 79.8, giving weights enough room to reach ≥75.
//
//   Other deviations from spec defaults (unchanged from Phase 1):
//     damage      0.30 → 0.18  PTCGP avg attack ~30-50 maps poorly to 0-150 scale
//     consistency 0.15 → 0.28  now uses basicPct scaling so it actually differentiates
//     speed       0.25 → 0.28  primary signal for fast meta builds after Option A
//     survivability 0.20 → 0.19 minor trim
//     disruption  0.10 → 0.07  minor trim
//
//   Phase 2 (trainer-awareness): added trainerSynergy dimension.
//     Bonus formulas bring all 5 existing sub-scores up, so damage weight could
//     be reduced.  trainerSynergy gets 0.12 of total.  Remaining 0.88 distributed
//     to preserve mimikyu ≥75 and lowest deck ≤55 constraints.
//     Final calibrated weights below; see STEP 6 comment for delta table.

let WEIGHTS = {
  speed:          0.25,
  damage:         0.36,
  survivability:  0.10,
  consistency:    0.09,
  disruption:     0.08,
  trainerSynergy: 0.12,
};

// Disruption keywords per spec
const DISRUPTION_KEYWORDS = ['paralyze', 'confuse', 'asleep', 'discard', 'prevent', 'switch', "can't"];

// Self-harm / own-resource phrases that should NOT count as opponent disruption
const SELF_PATTERNS = ['from this pokémon', 'from this pokemon', 'your discard pile'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Trainer helpers ──────────────────────────────────────────────────────────

/**
 * Return trainer card objects from an already-resolved card array.
 * CARD_REGISTRY param kept for API consistency with sub-scorers; cards are pre-resolved.
 */
function trainerCards(cards) {
  return cards.filter(c => c && c.type === 'Trainer');
}

/**
 * Resolve card IDs → enriched objects; warn and skip unknown IDs.
 * @param {string[]} ids
 * @param {Object} registry
 */
function resolve(ids, registry) {
  return ids.map(id => {
    const c = registry[id];
    if (!c) { console.warn(`[scoring] unknown card: ${id}`); return null; }
    return { id, ...c };
  }).filter(Boolean);
}

/** Return only Pokémon cards (null stage = Trainer/Energy). */
function pokemon(cards) { return cards.filter(c => c.stage != null); }

/** Deduplicate by card ID (first occurrence wins). */
function dedup(cards) {
  const seen = new Set();
  return cards.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
}

/** Energy cost of one attack — handles both {cost:[...]} and {energyCost:n}. */
function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}

/** Effect text — handles both {effect:...} and {effectText:...}. */
function effectOf(atk) { return (atk.effect ?? atk.effectText ?? '').toLowerCase(); }

// ─── Sub-scorers ──────────────────────────────────────────────────────────────

/**
 * Speed score (0–100): lower energy costs, cheaper retreat, simpler evo lines.
 * Trainer bonus: speed Items, search Items, energy Supporters all accelerate setup.
 * @param {Array}  cards   Pre-resolved card objects
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreSpeed(cards, CARD_REGISTRY) {
  const poke = pokemon(cards);
  if (!poke.length) return 0;

  let totalEnergy = 0, atkCount = 0, totalRetreat = 0;
  for (const c of poke) {
    for (const atk of (c.attacks ?? [])) { totalEnergy += energyOf(atk); atkCount++; }
    totalRetreat += c.retreatCost ?? 0;
  }
  const avgEnergy  = atkCount > 0 ? totalEnergy / atkCount : 0;
  const avgRetreat = totalRetreat / poke.length;

  // Stage penalties counted once per unique card type (not per copy)
  const u  = dedup(poke);
  const s2 = u.filter(c => c.stage === 'Stage 2').length;
  const s1 = u.filter(c => c.stage === 'Stage 1').length;

  const existingScore = clamp(
    100
    - 8  * Math.max(0, avgEnergy  - 1)
    - 5  * Math.max(0, avgRetreat - 1)
    - 8  * s2
    - 5  * s1,
    0, 100
  );

  const trainers = trainerCards(cards);
  const speedBonus =
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'speed').length * 8, 16) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'search').length * 4, 12) +
    Math.min(trainers.filter(c => isSupporter(c.name) && getTrainerEffect(c.name) === 'energy').length * 6, 12);
  return Math.min(existingScore + speedBonus, 100);
}

/**
 * Damage score (0–100): average damage of the top-2 highest-damage Pokémon
 * attackers in the deck, scaled to 80 (≥80 avg = 100).
 *
 * Option B deviation from spec ("avg all attacks / 150"):
 *   Averaging ALL attacks across ALL copies — including weak Basic setup Pokémon —
 *   systematically underscores decks that run one Stage-2 payoff attacker (e.g.
 *   Greninja at 60, diluted by 4 Froakie/Frogadier copies at 10/30).  Using the
 *   top-2 unique attacker max-damage focuses on actual win conditions; the 80-pt
 *   scale matches PTCGP's realistic high-end (130-damage Giratina ex → capped at
 *   100, 70-damage Mimikyu ex → 87.5).
 *
 * Trainer bonus: damage Tools, damage Supporters, damage Items all lift output.
 * null/variable damage attacks are treated as 0.
 * @param {Array}  cards
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreDamage(cards, CARD_REGISTRY) {
  const poke = pokemon(cards);
  // Per unique Pokémon: find its highest-damage attack
  const maxPerPoke = dedup(poke).map(c => {
    const dmgs = (c.attacks ?? []).map(a => typeof a.damage === 'number' ? a.damage : 0);
    return dmgs.length ? Math.max(...dmgs) : 0;
  });
  if (!maxPerPoke.length) return 0;
  // Top-2 values (or all if fewer than 2)
  const top2 = maxPerPoke.sort((a, b) => b - a).slice(0, 2);
  const avg  = top2.reduce((s, v) => s + v, 0) / top2.length;
  const existingScore = clamp((avg / 80) * 100, 0, 100);

  const trainers = trainerCards(cards);
  const damageBonus =
    Math.min(trainers.filter(c => isTool(c.name) && getTrainerEffect(c.name) === 'damage').length * 8, 16) +
    Math.min(trainers.filter(c => isSupporter(c.name) && getTrainerEffect(c.name) === 'damage').length * 6, 12) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'damage').length * 5, 10);
  return Math.min(existingScore + damageBonus, 100);
}

/**
 * Survivability score (0–100): average HP and retreat ease across Pokémon.
 * Trainer bonus: survivability Tools, heal Items/Supporters/Tools all raise bulk.
 * @param {Array}  cards
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreSurvivability(cards, CARD_REGISTRY) {
  const poke = pokemon(cards);
  if (!poke.length) return 0;
  const avgHp      = poke.reduce((s, c) => s + (c.hp          ?? 0), 0) / poke.length;
  const avgRetreat = poke.reduce((s, c) => s + (c.retreatCost ?? 0), 0) / poke.length;
  const existingScore = clamp(((avgHp - 60) / 120) * 70 + 30 - 3 * avgRetreat, 0, 100);

  const trainers = trainerCards(cards);
  const survBonus =
    Math.min(trainers.filter(c => isTool(c.name) && getTrainerEffect(c.name) === 'survivability').length * 10, 20) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'heal').length * 5, 15) +
    Math.min(trainers.filter(c => isSupporter(c.name) && getTrainerEffect(c.name) === 'heal').length * 8, 16) +
    Math.min(trainers.filter(c => isTool(c.name) && getTrainerEffect(c.name) === 'heal').length * 6, 12);
  return Math.min(existingScore + survBonus, 100);
}

/**
 * Consistency score (0–100): Basic-heavy, few Stage 2 lines.
 * Deviation from spec: applies a basicPct scale factor as base (per the
 * "60%+ Basic = full 100" rule), which differentiates decks more than a
 * flat 100 - 20×Stage2Lines formula where all meta decks have one Stage 2 line.
 * Trainer bonus: Supporters improve draw/search reliability; search/draw Items reduce bricks.
 * @param {Array}  cards
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreConsistency(cards, CARD_REGISTRY) {
  const poke = pokemon(cards);
  if (!poke.length) return 0;

  const basics   = poke.filter(c => c.stage === 'Basic').length;
  const basicPct = basics / poke.length;

  // Scale base score by basic ratio (60%+ earns full 100)
  const base    = Math.min(basicPct / 0.6, 1.0) * 100;
  const u       = dedup(poke);
  const s2Lines = u.filter(c => c.stage === 'Stage 2').length;

  let score = base - 20 * s2Lines;
  if (basics < 2) score -= 40;
  const existingScore = clamp(score, 0, 100);

  const trainers = trainerCards(cards);
  const supporters = trainers.filter(c => isSupporter(c.name));
  const consistBonus =
    (supporters.length >= 2 ? 15 : supporters.length === 1 ? 7 : 0) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'search').length * 5, 15) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'draw').length * 5, 10);
  return Math.min(existingScore + consistBonus, 100);
}

/**
 * Disruption score (0–100): attacks/abilities that affect the opponent.
 * Deviation from spec: excludes self-harm/own-resource patterns (e.g.
 * "Discard all Energy from this Pokémon" or "your discard pile") so that
 * drawback effects don't inflate the disruption rating.
 * Trainer bonus: disruption Supporters/Items and Stadiums add further pressure.
 * @param {Array}  cards
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreDisruption(cards, CARD_REGISTRY) {
  let score = 0;
  for (const c of dedup(cards)) {
    const texts = [
      ...(c.attacks   ?? []).map(effectOf),
      ...(c.abilities ?? []).map(a => (a.text ?? '').toLowerCase()),
    ];
    const combined = texts.join(' ');
    const isSelfHarm = SELF_PATTERNS.some(p => combined.includes(p));
    if (!isSelfHarm && DISRUPTION_KEYWORDS.some(kw => combined.includes(kw))) {
      score += 15;
    }
  }
  const existingScore = clamp(score, 0, 100);

  const trainers = trainerCards(cards);
  const disruptBonus =
    Math.min(trainers.filter(c => isSupporter(c.name) && getTrainerEffect(c.name) === 'disruption').length * 15, 30) +
    Math.min(trainers.filter(c => isItem(c.name) && getTrainerEffect(c.name) === 'disruption').length * 10, 20) +
    Math.min(trainers.filter(c => isStadium(c.name)).length * 8, 8);
  return Math.min(existingScore + disruptBonus, 100);
}

/**
 * Trainer synergy score (0–100): how well the trainer package matches
 * the deck's primary Pokémon type.
 * Universal trainers (forType=null) always count as compatible.
 * Type-specific trainers in a matching deck earn an extra bonus.
 * @param {Array}  cards   Pre-resolved card objects
 * @param {Object} CARD_REGISTRY
 * @returns {number}
 */
function scoreTrainerSynergy(cards, CARD_REGISTRY) {
  const pokemonCards = pokemon(cards);
  if (!pokemonCards.length) return 50;

  const typeCounts = {};
  pokemonCards.forEach(c => {
    typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
  });
  const primaryType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];

  const trainers = trainerCards(cards);
  if (!trainers.length) return 40;

  let compatibleCount = 0;
  let typeSpecificBonus = 0;

  trainers.forEach(c => {
    if (isTypeCompatible(c.name, primaryType)) compatibleCount++;
    const forType = getTrainerForType(c.name);
    if (forType !== null && forType === primaryType) typeSpecificBonus += 8;
  });

  const compatibilityRate = compatibleCount / trainers.length;
  const base  = compatibilityRate * 70;                   // max 70 from compatibility
  const bonus = Math.min(typeSpecificBonus, 30);          // max 30 from type-specific cards
  return Math.min(Math.round(base + bonus), 100);
}

// ─── Public exports ────────────────────────────────────────────────────────────

/** Return a copy of the current weight map. */
export function getWeights() { return { ...WEIGHTS }; }

/** Merge w into WEIGHTS (use for deck-builder strategy overrides in Phase A). */
export function setWeights(w) { Object.assign(WEIGHTS, w); }

/**
 * Score a deck across six dimensions, returning a weighted total, tier, and breakdown.
 *
 * @param {string[]} deckCardIds - Flat array of card IDs; duplicates represent copies.
 * @param {Object.<string, {
 *   id?:          string,
 *   name?:        string,
 *   type?:        string,
 *   stage:        string|null,
 *   hp:           number,
 *   retreatCost:  number,
 *   attacks:      Array<{name: string, cost?: string[], energyCost?: number, damage: number|null, effect?: string, effectText?: string}>,
 *   abilities:    Array<{name: string, text: string}>
 * }>} CARD_REGISTRY
 * @returns {{ total: number, tier: "S"|"A"|"B"|"C", breakdown: {
 *   speed: number, damage: number, survivability: number,
 *   consistency: number, disruption: number, trainerSynergy: number
 * }}}
 */
export function scoreDeck(deckCardIds, CARD_REGISTRY) {
  const cards = resolve(deckCardIds, CARD_REGISTRY);

  const breakdown = {
    speed:          +scoreSpeed(cards, CARD_REGISTRY).toFixed(1),
    damage:         +scoreDamage(cards, CARD_REGISTRY).toFixed(1),
    survivability:  +scoreSurvivability(cards, CARD_REGISTRY).toFixed(1),
    consistency:    +scoreConsistency(cards, CARD_REGISTRY).toFixed(1),
    disruption:     +scoreDisruption(cards, CARD_REGISTRY).toFixed(1),
    trainerSynergy: +scoreTrainerSynergy(cards, CARD_REGISTRY).toFixed(1),
  };

  const total = Math.round(
    breakdown.speed          * WEIGHTS.speed          +
    breakdown.damage         * WEIGHTS.damage         +
    breakdown.survivability  * WEIGHTS.survivability  +
    breakdown.consistency    * WEIGHTS.consistency    +
    breakdown.disruption     * WEIGHTS.disruption     +
    breakdown.trainerSynergy * WEIGHTS.trainerSynergy
  );

  const tier = total >= 80 ? 'S' : total >= 65 ? 'A' : total >= 50 ? 'B' : 'C';
  return { total, tier, breakdown };
}
