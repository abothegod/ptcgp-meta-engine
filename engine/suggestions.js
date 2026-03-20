import { scoreDeck }   from './scoring.js';
import { analyzeDeck } from './analysis.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const DISRUPTION_KEYWORDS = ['paralyze', 'confuse', 'asleep', 'discard', 'prevent', 'switch', "can't"];
const STAGE_NUM = { 'Basic': 0, 'Stage 1': 1, 'Stage 2': 2 };

function energyOf(atk) {
  if (Array.isArray(atk.cost)) return atk.cost.length;
  return typeof atk.energyCost === 'number' ? atk.energyCost : 0;
}

function effectOf(atk)  { return (atk.effect ?? atk.effectText ?? '').toLowerCase(); }
function minEnergy(c)   { const cs = (c.attacks ?? []).map(energyOf); return cs.length ? Math.min(...cs) : Infinity; }
function maxDamage(c)   { const ds = (c.attacks ?? []).map(a => typeof a.damage === 'number' ? a.damage : 0); return ds.length ? Math.max(...ds) : 0; }
function avgEnergy(c)   { const cs = (c.attacks ?? []).map(energyOf); return cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : 0; }
function stageNum(c)    { return STAGE_NUM[c.stage] ?? -1; }
function cardName(id, r){ return r[id]?.name ?? id; }

function hasDisruption(c) {
  const texts = [
    ...(c.attacks   ?? []).map(effectOf),
    ...(c.abilities ?? []).map(a => (a.text ?? '').toLowerCase()),
  ];
  return DISRUPTION_KEYWORDS.some(kw => texts.some(t => t.includes(kw)));
}

// ─── Candidate filter ─────────────────────────────────────────────────────────

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

// ─── Weakest-link heuristic (Modification 1) ─────────────────────────────────
// Returns the ID of the Pokémon to remove (one copy) for a given dimension.

function weakestLink(deckCardIds, dimension, registry) {
  // Unique Pokémon IDs in the deck
  const pokeIds = [...new Set(deckCardIds.filter(id => {
    const c = registry[id];
    return c && c.stage != null;
  }))];
  if (pokeIds.length <= 1) return null;

  let scored;
  switch (dimension) {
    case 'speed':
      scored = pokeIds.map(id => ({ id, val: avgEnergy(registry[id]) }));
      scored.sort((a, b) => b.val - a.val);   // highest avg energy = slowest
      break;
    case 'damage':
      scored = pokeIds.map(id => ({ id, val: maxDamage(registry[id]) }));
      scored.sort((a, b) => a.val - b.val);   // lowest max damage = weakest attacker
      break;
    case 'survivability':
      scored = pokeIds.map(id => ({ id, val: registry[id].hp ?? 0 }));
      scored.sort((a, b) => a.val - b.val);   // lowest HP = most fragile
      break;
    case 'consistency':
      scored = pokeIds.map(id => ({ id, val: stageNum(registry[id]) }));
      scored.sort((a, b) => b.val - a.val);   // highest stage = worst consistency
      break;
    case 'disruption':
      // Prefer removing Pokémon that already have no disruption value
      scored = pokeIds.map(id => ({ id, val: hasDisruption(registry[id]) ? 0 : 1 }));
      scored.sort((a, b) => b.val - a.val);   // no-disruption cards first
      break;
    default:
      scored = pokeIds.map(id => ({ id, val: 0 }));
  }
  return scored[0].id;
}

// ─── Reason builder ───────────────────────────────────────────────────────────

function reasonFor(dimension, removeCard, addCard, scoreDelta) {
  const delta = `(+${scoreDelta.toFixed(1)} pts)`;
  switch (dimension) {
    case 'speed': {
      const cost = minEnergy(addCard);
      return `Replaces slow ${removeCard.stage ?? 'card'} with Basic attacker costing ${cost} energ${cost === 1 ? 'y' : 'ies'} ${delta}`;
    }
    case 'damage': {
      const dmg = maxDamage(addCard);
      return `Adds high-damage attacker (${dmg} max damage) to improve KO potential ${delta}`;
    }
    case 'survivability': {
      const hp = addCard.hp ?? '?';
      return `Replaces low-bulk Pokémon with ${hp}-HP wall to survive meta hits ${delta}`;
    }
    case 'consistency':
      return `Replaces ${removeCard.stage ?? 'card'} with Basic Pokémon to reduce brick risk ${delta}`;
    case 'disruption':
      return `Adds disruption effect to slow opponent setup ${delta}`;
    default:
      return `Improves deck performance ${delta}`;
  }
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Suggest card swaps that improve the deck's scored total.
 *
 * @param {string[]} deckCardIds
 * @param {Object}   CARD_REGISTRY
 * @returns {{
 *   baseScore:   number,
 *   suggestions: Array<{remove,removeName,add,addName,targetWeakness,scoreDelta,reason}>,
 *   note:        string|null
 * }}
 */
export function suggestSwaps(deckCardIds, CARD_REGISTRY) {
  const { weaknesses }    = analyzeDeck(deckCardIds, CARD_REGISTRY);
  const { total: baseScore } = scoreDeck(deckCardIds, CARD_REGISTRY);

  if (!weaknesses.length) {
    return { baseScore, suggestions: [], note: 'Deck is already locally optimal.' };
  }

  // ── STEP 1: Candidate generation ──────────────────────────────────────────
  const deckSet = new Set(deckCardIds);
  // candidateId → { card, dimension } — first weakness to match wins (dedup)
  const candidateMap = new Map();

  for (const { dimension } of weaknesses) {
    for (const [id, card] of Object.entries(CARD_REGISTRY)) {
      if (deckSet.has(id))         continue;
      if (candidateMap.has(id))    continue;
      if (qualifiesFor(dimension, card)) candidateMap.set(id, { card, dimension });
    }
  }

  // ── STEP 2: Swap simulation ────────────────────────────────────────────────
  const valid = [];

  for (const [candidateId, { card: addCard, dimension }] of candidateMap) {
    const removeId = weakestLink(deckCardIds, dimension, CARD_REGISTRY);
    if (!removeId) continue;

    // Remove exactly one copy of removeId
    const testDeck = [...deckCardIds];
    testDeck.splice(testDeck.indexOf(removeId), 1);
    testDeck.push(candidateId);

    const newScore  = scoreDeck(testDeck, CARD_REGISTRY).total;
    const scoreDelta = newScore - baseScore;
    if (scoreDelta <= 0) continue;

    valid.push({
      remove:         removeId,
      removeName:     cardName(removeId, CARD_REGISTRY),
      add:            candidateId,
      addName:        cardName(candidateId, CARD_REGISTRY),
      targetWeakness: dimension,
      scoreDelta:     +scoreDelta.toFixed(1),
      reason:         reasonFor(dimension, CARD_REGISTRY[removeId] ?? {}, addCard, scoreDelta),
    });
  }

  valid.sort((a, b) => b.scoreDelta - a.scoreDelta);

  // ── Modification 2: Diversity filter (apply before top-5 slice) ───────────
  const usedRemove     = new Set();
  const usedDimensions = new Set();
  const diverse        = [];
  const remainder      = [];

  for (const s of valid) {
    if (!usedRemove.has(s.remove) && !usedDimensions.has(s.targetWeakness)) {
      usedRemove.add(s.remove);
      usedDimensions.add(s.targetWeakness);
      diverse.push(s);
    } else {
      remainder.push(s);
    }
  }

  // Fill remaining slots respecting the remove-once constraint
  for (const s of remainder) {
    if (diverse.length >= 5) break;
    if (!usedRemove.has(s.remove)) {
      usedRemove.add(s.remove);
      diverse.push(s);
    }
  }

  return { baseScore, suggestions: diverse.slice(0, 5), note: null };
}
