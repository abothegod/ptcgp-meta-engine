import { scoreDeck, setWeights, getWeights } from './scoring.js';
import { suggestSwaps }                      from './suggestions.js';
import { buildMatchupMatrix }                from './matchup-matrix.js';

// ─── Internal constants ───────────────────────────────────────────────────────

const STAGE_NUMS = { 'Basic': 0, 'Stage 1': 1, 'Stage 2': 2 };

/** PTCGP deck size. */
const DECK_SIZE = 20;

/** Representative meta target HP for TTK calculation. */
const TTK_TARGET_HP = 150;

/**
 * Baseline weights (BALANCED) — restored after every archetype scoring pass
 * so that callers outside deck-builder see the unchanged global weights.
 */
const BALANCED_WEIGHTS = {
  speed: 0.25, damage: 0.36, survivability: 0.10,
  consistency: 0.09, disruption: 0.08, trainerSynergy: 0.12,
};

// ─── Part 1: Card Role Classifier ────────────────────────────────────────────

/**
 * Classify a resolved card object into a strategic role.
 *
 * Priority order (first match wins):
 *   SUPPORT  (Trainer, i.e. stage == null)
 *   WALL     (HP ≥ 160, no variable damage, max numeric damage ≤ 60)
 *   SNIPER   (any attack/ability text mentions "bench")
 *   FINISHER (variable damage or max numeric damage ≥ 70)
 *   ACCELERATOR (any text contains both "attach" and "energy")
 *   ATTACKER (max numeric damage ≥ 40)
 *   SUPPORT  (default fallback)
 *
 * @param {Object|null} card  Resolved card from CARD_REGISTRY (stage/hp/attacks/abilities)
 * @returns {'WALL'|'FINISHER'|'SNIPER'|'ACCELERATOR'|'ATTACKER'|'SUPPORT'}
 */
export function classifyCardRole(card) {
  if (!card || card.stage == null) return 'SUPPORT';

  const attacks   = card.attacks   ?? [];
  const abilities = card.abilities ?? [];
  const hp        = card.hp        ?? 0;

  // Max numeric damage; flag if any attack has variable (null) damage
  const numDmgs   = attacks
    .map(a => typeof a.damage === 'number' ? a.damage : null)
    .filter(v => v !== null);
  const maxNumDmg = numDmgs.length ? Math.max(...numDmgs) : 0;
  const hasVarDmg = attacks.some(a => a.damage === null);

  const allEffects = [
    ...attacks.map(a => (a.effect ?? a.effectText ?? '').toLowerCase()),
    ...abilities.map(a => (a.text ?? '').toLowerCase()),
  ].join(' ');

  // WALL: very high HP, no variable-damage attacks, low fixed damage
  if (hp >= 160 && !hasVarDmg && maxNumDmg <= 60) return 'WALL';

  // SNIPER: attack/ability explicitly references the bench
  if (allEffects.includes('bench')) return 'SNIPER';

  // FINISHER: variable-damage attacks (scale high situationally) or high fixed damage
  if (hasVarDmg || maxNumDmg >= 70) return 'FINISHER';

  // ACCELERATOR: ability/attack that attaches extra energy
  if (allEffects.includes('attach') && allEffects.includes('energy')) return 'ACCELERATOR';

  // ATTACKER: solid direct damage
  if (maxNumDmg >= 40) return 'ATTACKER';

  return 'SUPPORT';
}

// ─── Part 4: Archetypes ───────────────────────────────────────────────────────

/**
 * Archetype definitions with custom scoring weights and build rules.
 *
 * weights: passed to setWeights() during simulation / repair passes
 * rules:
 *   preferBasic        — sort Basic Pokémon to the front of the pool
 *   maxStage           — exclude Pokémon whose stage number exceeds this value
 *   requiresDisruption — (informational) archetype expects disruption tools
 *   preferHighHP       — sort highest-HP Pokémon to the front of the pool
 *   requiresSetup      — (informational) archetype tolerates higher TTK
 */
export const ARCHETYPES = {
  AGGRO: {
    weights: {
      speed: 0.35, damage: 0.40, survivability: 0.05,
      consistency: 0.10, disruption: 0.02, trainerSynergy: 0.08,
    },
    rules: { preferBasic: true, maxStage: 1 },
    description: 'Fast, high-damage builds that win the prize race',
  },
  CONTROL: {
    weights: {
      speed: 0.10, damage: 0.15, survivability: 0.20,
      consistency: 0.25, disruption: 0.25, trainerSynergy: 0.05,
    },
    rules: { requiresDisruption: true },
    description: 'Disruption-heavy builds that control opponent setup',
  },
  TANK: {
    weights: {
      speed: 0.10, damage: 0.15, survivability: 0.40,
      consistency: 0.20, disruption: 0.05, trainerSynergy: 0.10,
    },
    rules: { preferHighHP: true },
    description: 'High-bulk builds that outlast the opponent',
  },
  TRIGGER: {
    weights: {
      speed: 0.20, damage: 0.30, survivability: 0.15,
      consistency: 0.15, disruption: 0.10, trainerSynergy: 0.10,
    },
    rules: { requiresSetup: true },
    description: 'Condition-based damage builds with high-turn payoffs',
  },
  BALANCED: {
    weights: { ...BALANCED_WEIGHTS },
    rules: {},
    description: 'Standard balanced builds optimised for the current meta',
  },
};

// ─── Part 2: Evolution Speed Modifier ────────────────────────────────────────

/**
 * Compute how many extra turns an evolution line adds to setup.
 * Stage 2 lines = 2 turns; Stage 1 lines = 1 turn; Basic-only = 0 turns.
 *
 * @param {Object[]} resolvedCards  Pre-resolved card objects (may include Trainers)
 * @param {Object}   CARD_REGISTRY  Kept for API consistency; not used internally
 * @returns {{ modifier: number, reason: string }}
 */
export function getEvolutionSpeedModifier(resolvedCards, CARD_REGISTRY) {
  const poke = resolvedCards.filter(c => c && c.stage != null);
  if (!poke.length) return { modifier: 0, reason: 'No Pokémon in deck' };

  const hasStage2 = poke.some(c => c.stage === 'Stage 2');
  const hasStage1 = poke.some(c => c.stage === 'Stage 1');

  if (hasStage2) return { modifier: 2, reason: 'Stage 2 evolution line requires 2 extra setup turns' };
  if (hasStage1) return { modifier: 1, reason: 'Stage 1 evolution line requires 1 extra setup turn' };
  return { modifier: 0, reason: 'Basic-only deck — no evolution delay' };
}

// ─── Part 3: TTK Calculator ───────────────────────────────────────────────────

/**
 * Estimate turns-to-kill (TTK) the typical meta target (TTK_TARGET_HP).
 *
 *   TTK = ceil(TARGET_HP / effectiveDamage) + evoModifier + energySetup
 *
 * Main attacker is the highest-priority role in the deck (FINISHER > SNIPER >
 * ATTACKER > SUPPORT > WALL > ACCELERATOR).
 * Variable-damage attacks are estimated at 60 for TTK purposes.
 * ACCELERATOR cards boost effectiveDamage by 10% each.
 *
 * @param {string[]} deckCardIds
 * @param {Object}   CARD_REGISTRY
 * @returns {{
 *   ttk: number,
 *   effectiveDamage: number,
 *   mainAttacker: string|null,
 *   ttkGrade: 'S'|'A'|'B'|'C',
 *   evoModReason: string,
 * }}
 */
export function calculateTTK(deckCardIds, CARD_REGISTRY) {
  const cards = deckCardIds.map(id => CARD_REGISTRY[id]).filter(Boolean);
  const poke  = cards.filter(c => c.stage != null);

  if (!poke.length) {
    return {
      ttk: 99, effectiveDamage: 0, mainAttacker: null,
      ttkGrade: 'C', evoModReason: 'No Pokémon',
    };
  }

  // Select main attacker by role priority
  const ROLE_PRIORITY = ['FINISHER', 'SNIPER', 'ATTACKER', 'SUPPORT', 'WALL', 'ACCELERATOR'];
  let mainAttacker = null;
  for (const role of ROLE_PRIORITY) {
    mainAttacker = poke.find(c => classifyCardRole(c) === role);
    if (mainAttacker) break;
  }
  if (!mainAttacker) mainAttacker = poke[0];

  const attacks = mainAttacker.attacks ?? [];

  // Best attack damage (null = variable → estimate as 60)
  const maxDmg = attacks.reduce((best, a) => {
    const d = typeof a.damage === 'number' ? a.damage : 60;
    return Math.max(best, d);
  }, 0);

  // Each ACCELERATOR in the deck adds a 10% damage boost
  const accelCount    = poke.filter(c => classifyCardRole(c) === 'ACCELERATOR').length;
  const effectiveDmg  = Math.max(1, Math.round(maxDmg * (1 + accelCount * 0.1)));

  // Evolution delay
  const { modifier: evoMod, reason: evoModReason } = getEvolutionSpeedModifier(poke, CARD_REGISTRY);

  // Energy setup: turns needed beyond the first to fuel the main attacker
  const minCost = attacks.reduce((min, a) => {
    const c = Array.isArray(a.cost) ? a.cost.length
            : typeof a.energyCost === 'number' ? a.energyCost : 0;
    return Math.min(min, c);
  }, Infinity);
  const energySetup = isFinite(minCost) ? Math.max(0, minCost - 1) : 1;

  const baseAttacks = Math.ceil(TTK_TARGET_HP / effectiveDmg);
  const ttk         = baseAttacks + evoMod + energySetup;
  const ttkGrade    = ttk <= 3 ? 'S' : ttk <= 5 ? 'A' : ttk <= 7 ? 'B' : 'C';

  return {
    ttk,
    effectiveDamage: effectiveDmg,
    mainAttacker:    mainAttacker.name ?? null,
    ttkGrade,
    evoModReason,
  };
}

// ─── Deterministic PRNG ───────────────────────────────────────────────────────

/**
 * Mulberry32 — fast 32-bit seeded RNG.
 * Using a fixed seed ensures simulation results are reproducible across runs.
 */
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Part 5: Deck Variant Simulator ──────────────────────────────────────────

/**
 * Simulate up to `simCount` deck variants and return the one with the
 * highest composite score.
 *
 *   composite = deckScore × 0.7 + max(0, 100 − ttk × 10) × 0.3
 *
 * Uses a fixed RNG seed (42) so results are deterministic.
 * archetype weights are applied during scoring and restored afterwards.
 *
 * @param {Object}      CARD_REGISTRY
 * @param {string}      archetype      Key of ARCHETYPES
 * @param {string|null} primaryType    Filter Pokémon pool by type; null = all types
 * @param {string[]}    excludeCards   Card IDs to exclude from consideration
 * @param {number}      simCount       Number of variants to evaluate
 * @returns {{ bestDeck: string[], simLog: Array<{variant,score,ttk,composite}> }}
 */
export function simulateDeckVariants(
  CARD_REGISTRY,
  archetype    = 'BALANCED',
  primaryType  = null,
  excludeCards = [],
  simCount     = 30,
) {
  const exclude       = new Set(excludeCards);
  const archetypeConf = ARCHETYPES[archetype] ?? ARCHETYPES.BALANCED;
  const { rules = {} } = archetypeConf;

  // ── Partition available cards ────────────────────────────────────────────────
  const allEntries     = Object.entries(CARD_REGISTRY).filter(([id]) => !exclude.has(id));
  const pokeEntries    = allEntries.filter(([, c]) => c && c.stage != null);
  const trainerEntries = allEntries.filter(([, c]) => c && c.stage == null);

  // ── Pokémon pool: type filter then archetype rules ───────────────────────────
  let pool = primaryType
    ? pokeEntries.filter(([, c]) => c.type === primaryType)
    : pokeEntries;

  if (pool.length < 3) pool = pokeEntries;   // fallback to all types

  if (typeof rules.maxStage === 'number') {
    const filtered = pool.filter(([, c]) => (STAGE_NUMS[c.stage] ?? 0) <= rules.maxStage);
    if (filtered.length >= 2) pool = filtered;
  }

  // Sort pool according to archetype preference
  if (rules.preferBasic) {
    pool = [...pool].sort(([, a]) => (a.stage === 'Basic' ? -1 : 1));
  } else if (rules.preferHighHP) {
    pool = [...pool].sort(([, a], [, b]) => (b.hp ?? 0) - (a.hp ?? 0));
  }

  const rng          = mulberry32(42);   // fixed seed → deterministic
  const savedWeights = getWeights();
  setWeights(archetypeConf.weights);

  const simLog        = [];
  let bestDeck        = null;
  let bestComposite   = -Infinity;

  for (let i = 0; i < simCount; i++) {
    // ── Select Pokémon ────────────────────────────────────────────────────────
    const shuffledPoke = [...pool].sort(() => rng() - 0.5);
    const pokeCount    = 3 + (i % 5);                         // 3–7 unique cards
    const uniquePoke   = shuffledPoke.slice(0, Math.min(pokeCount, shuffledPoke.length));
    const pokeDeck     = uniquePoke.flatMap(([id]) => [id, id]);  // 2 copies each

    // ── Fill remaining slots with trainers ────────────────────────────────────
    const remaining        = DECK_SIZE - pokeDeck.length;
    const shuffledTrainers = [...trainerEntries].sort(() => rng() - 0.5);
    const trainerDeck      = [];

    for (const [id] of shuffledTrainers) {
      if (trainerDeck.length >= remaining) break;
      const copies = (remaining - trainerDeck.length) >= 2 ? 2 : 1;
      for (let c = 0; c < copies; c++) trainerDeck.push(id);
    }

    const deck = [...pokeDeck, ...trainerDeck].slice(0, DECK_SIZE);
    if (deck.length < 4) continue;

    // ── Score ─────────────────────────────────────────────────────────────────
    const { total: deckScore } = scoreDeck(deck, CARD_REGISTRY);
    const { ttk }              = calculateTTK(deck, CARD_REGISTRY);
    const composite            = deckScore * 0.7 + Math.max(0, 100 - ttk * 10) * 0.3;

    simLog.push({ variant: i + 1, score: deckScore, ttk, composite: +composite.toFixed(1) });

    if (composite > bestComposite) {
      bestComposite = composite;
      bestDeck      = deck;
    }
  }

  setWeights(savedWeights);

  // Fallback: use the first few pool entries if no valid variant was produced
  if (!bestDeck) {
    bestDeck = pool.slice(0, Math.min(5, pool.length)).flatMap(([id]) => [id, id]);
  }

  return { bestDeck, simLog };
}

// ─── Part 6: Optimal Deck Builder ────────────────────────────────────────────

/**
 * Build an optimised deck for a given archetype:
 *   1. Simulate `simCount` variants → pick best composite score
 *   2. Apply up to 5 repair passes (suggestSwaps) to fix remaining weaknesses
 *   3. Return final deck with score, TTK, deckList, logs
 *
 * @param {Object} CARD_REGISTRY
 * @param {{
 *   archetype?:    string,
 *   primaryType?:  string|null,
 *   excludeCards?: string[],
 *   simCount?:     number,
 * }} options
 * @returns {{
 *   archetype: string, deck: string[], score: number, breakdown: Object,
 *   ttk: number, ttkGrade: string, mainAttacker: string|null,
 *   deckList: Array<{id: string, qty: number, name: string}>,
 *   simLog: Object[], buildLog: string[]
 * }}
 */
export function buildOptimalDeck(CARD_REGISTRY, options = {}) {
  const {
    archetype    = 'BALANCED',
    primaryType  = null,
    excludeCards = [],
    simCount     = 30,
  } = options;

  // ── Step 1: simulate variants ────────────────────────────────────────────────
  const { bestDeck, simLog } = simulateDeckVariants(
    CARD_REGISTRY, archetype, primaryType, excludeCards, simCount,
  );

  // ── Step 2: repair passes with archetype weights ─────────────────────────────
  const archetypeConf = ARCHETYPES[archetype] ?? ARCHETYPES.BALANCED;
  setWeights(archetypeConf.weights);

  const buildLog  = [];
  let currentDeck = bestDeck;

  for (let pass = 0; pass < 5; pass++) {
    const { suggestions } = suggestSwaps(currentDeck, CARD_REGISTRY);
    if (!suggestions.length) break;

    const top       = suggestions[0];
    const newDeck   = [...currentDeck];
    const removeIdx = newDeck.indexOf(top.remove);
    if (removeIdx < 0) break;

    newDeck.splice(removeIdx, 1);
    newDeck.push(top.add);
    buildLog.push(`Pass ${pass + 1}: ${top.removeName} → ${top.addName} (+${top.scoreDelta})`);
    currentDeck = newDeck;
  }

  setWeights(BALANCED_WEIGHTS);

  // ── Step 3: final scoring and TTK ────────────────────────────────────────────
  const { total: score, breakdown }                    = scoreDeck(currentDeck, CARD_REGISTRY);
  const { ttk, ttkGrade, mainAttacker, evoModReason }  = calculateTTK(currentDeck, CARD_REGISTRY);

  // Build deckList: deduplicate and count copies
  const countMap = {};
  for (const id of currentDeck) countMap[id] = (countMap[id] ?? 0) + 1;
  const deckList = Object.entries(countMap).map(([id, qty]) => ({
    id, qty, name: CARD_REGISTRY[id]?.name ?? id,
  }));

  return {
    archetype,
    deck: currentDeck,
    score,
    breakdown,
    ttk,
    ttkGrade,
    mainAttacker,
    deckList,
    simLog,
    buildLog,
  };
}

// ─── Part 7: Meta-Optimal Deck Builder ───────────────────────────────────────

/**
 * Build the optimal deck for each requested strategy and measure its
 * meta win rate by inserting it as a synthetic entrant into the matchup
 * matrix alongside the current META_SNAPSHOT.
 *
 * metaWinRate is the average win rate of the built deck against all
 * META_SNAPSHOT decks (0–100 scale).
 *
 * @param {Object}   CARD_REGISTRY
 * @param {Object[]} META_SNAPSHOT   Current meta decks (id/cards/winRate/…)
 * @param {Object}   ENGINE_REG      Enriched card registry for matchup scoring
 * @param {string[]} strategies      Archetypes to build (default: all 5)
 * @returns {Array<{
 *   strategy, deck, score, breakdown, ttk, ttkGrade, mainAttacker,
 *   deckList, simLog, buildLog, metaWinRate: number, metaGrade: 'S'|'A'|'B'|'C'
 * }>} sorted by metaWinRate descending
 */
export function buildMetaOptimalDecks(
  CARD_REGISTRY,
  META_SNAPSHOT,
  ENGINE_REG,
  strategies = ['AGGRO', 'CONTROL', 'TANK', 'TRIGGER', 'BALANCED'],
) {
  const results = [];

  for (const strategy of strategies) {
    const built = buildOptimalDeck(CARD_REGISTRY, { archetype: strategy });

    // ── Insert synthetic deck into matchup matrix ────────────────────────────
    const syntheticId   = `built-${strategy.toLowerCase()}`;
    const syntheticDeck = {
      id:      syntheticId,
      tier:    'B',
      winRate: built.score >= 65 ? 55 : 50,
      cards:   built.deck,
    };

    let metaWinRate = 50;
    try {
      const allDecks = [...META_SNAPSHOT, syntheticDeck];
      const matrix   = buildMatchupMatrix(allDecks, ENGINE_REG);
      const row      = matrix[syntheticId] ?? {};
      const rates    = Object.values(row);
      if (rates.length) {
        metaWinRate = +(rates.reduce((s, v) => s + v, 0) / rates.length * 100).toFixed(1);
      }
    } catch (e) {
      console.warn(`[deck-builder] matchup matrix failed for ${strategy}:`, e.message);
    }

    const metaGrade = metaWinRate >= 55 ? 'S'
                    : metaWinRate >= 50 ? 'A'
                    : metaWinRate >= 45 ? 'B'
                    :                    'C';

    results.push({ strategy, ...built, metaWinRate, metaGrade });
  }

  // Sort by metaWinRate descending
  results.sort((a, b) => b.metaWinRate - a.metaWinRate);

  return results;
}
