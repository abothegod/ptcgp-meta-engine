import { scoreDeck } from './scoring.js';

// ─── Tunable thresholds ───────────────────────────────────────────────────────
const THRESHOLDS = {
  speed:         { warn: 45, critical: 30 },
  damage:        { warn: 50, critical: 35 },
  survivability: { warn: 45, critical: 30 },
  consistency:   { warn: 50, critical: 35 },
  disruption:    { warn: 30, critical: 0 },
};

/** Energy cost of one attack — handles both {cost:[...]} and {energyCost:n}. */
function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}

/**
 * Compute raw deck stats needed for message interpolation.
 * Works directly from card IDs + registry so we don't re-export scoring internals.
 */
function deckStats(deckCardIds, registry) {
  const poke = deckCardIds
    .map(id => registry[id])
    .filter(c => c && c.stage != null);

  if (!poke.length) return { avgEnergy: 0, avgHp: 0, basicPct: 0 };

  let totalEnergy = 0, atkCount = 0, totalHp = 0, basics = 0;
  for (const c of poke) {
    for (const atk of (c.attacks ?? [])) { totalEnergy += energyOf(atk); atkCount++; }
    totalHp += c.hp ?? 0;
    if (c.stage === 'Basic') basics++;
  }

  return {
    avgEnergy: atkCount > 0 ? totalEnergy / atkCount : 0,
    avgHp:     totalHp / poke.length,
    basicPct:  basics  / poke.length,
  };
}

/**
 * Analyse a deck across five dimensions and return weaknesses with severity.
 *
 * @param {string[]} deckCardIds
 * @param {Object}   CARD_REGISTRY
 * @returns {{
 *   scoreBreakdown: Object,
 *   weaknesses: Array<{dimension: string, score: number, severity: string, message: string}>,
 *   overallSeverity: number,
 *   healthLabel: "SOLID"|"NEEDS WORK"|"PROBLEMATIC"
 * }}
 */
export function analyzeDeck(deckCardIds, CARD_REGISTRY) {
  const { breakdown } = scoreDeck(deckCardIds, CARD_REGISTRY);
  const stats = deckStats(deckCardIds, CARD_REGISTRY);

  // Values interpolated into messages
  const turns    = Math.ceil(stats.avgEnergy);
  const avgDmg   = Math.round(breakdown.damage * 80 / 100);
  const avgHp    = Math.round(stats.avgHp);
  const basicPct = Math.round(stats.basicPct * 100);

  const weaknesses = [];

  function check(dim, score, warnMsg, critMsg) {
    const t = THRESHOLDS[dim];
    if      (score < t.critical) weaknesses.push({ dimension: dim, score, severity: 'CRITICAL', message: critMsg });
    else if (score < t.warn)     weaknesses.push({ dimension: dim, score, severity: 'WARNING',  message: warnMsg });
  }

  check('speed',
    breakdown.speed,
    `Slow setup — estimated ${turns} turns to first attack`,
    `Severely slow — likely loses the prize race against fast meta decks`
  );
  check('damage',
    breakdown.damage,
    `Damage output (avg ${avgDmg}) may not one-shot 130+ HP meta threats`,
    `Cannot reliably KO meta Pokémon — will be out-traded`
  );
  check('survivability',
    breakdown.survivability,
    `Fragile — average ${avgHp} HP vulnerable to spread damage`,
    `Very low bulk — will be OHKOed by most meta attackers`
  );
  check('consistency',
    breakdown.consistency,
    `Evolution lines increase brick risk — ${basicPct}% Basic coverage`,
    `High brick risk — fewer than 2 Basic Pokémon detected`
  );
  check('disruption',
    breakdown.disruption,
    `No disruption tools — opponent sets up without interference`,
    `Completely passive — no disruption or status effects`
  );

  let overallSeverity = 0;
  for (const w of weaknesses) overallSeverity += w.severity === 'CRITICAL' ? 25 : 10;
  overallSeverity = Math.min(overallSeverity, 100);

  const healthLabel = overallSeverity < 20 ? 'SOLID'
                    : overallSeverity < 50 ? 'NEEDS WORK'
                    :                        'PROBLEMATIC';

  return { scoreBreakdown: breakdown, weaknesses, overallSeverity, healthLabel };
}
