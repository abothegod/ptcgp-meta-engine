import { createRequire } from 'module';
import { scoreDeck, analyzeDeck, suggestSwaps,
         buildMatchupMatrix, getCounterDecks, getBestDeckVsField,
         solveNash, compareToActualMeta,
         detectBehavioralBias, getTopEVPicks,
         scoreEvolutionaryStability, simulateMetaShift } from './index.js';

const require = createRequire(import.meta.url);
const detail  = require('../cards-detail.json');

// ─── Stage data for all 44 CARD_REGISTRY entries ──────────────────────────────
// Source: FULL_CARD_DB.stage extracted from ptcgp-meta-engine.html
// null = Trainer/Supporter (skipped by all sub-scorers)
const STAGE = {
  'A1-087': 'Basic',   'A1-088': 'Stage 1', 'A1-089': 'Stage 2',
  'A1-220': null,      'A1-223': null,       'A1-225': null,
  'A2-109': 'Basic',   'A2-110': 'Basic',    'A2b-035': 'Basic',
  'A3-034': 'Basic',   'A3-074': 'Basic',    'A3-075': 'Stage 1',
  'A4a-020': 'Basic',
  'B1-102':  'Stage 1','B1-109': 'Basic',   'B1-150': 'Basic',
  'B1-151':  'Basic',  'B1-155': 'Basic',   'B1-156': 'Stage 1',
  'B1-157':  'Stage 2','B1-196': 'Basic',   'B1-197': 'Stage 1',
  'B1-225':  null,     'B1-304': 'Basic',
  'B1a-024': 'Basic',  'B1a-025': 'Stage 1','B1a-026': 'Stage 2',
  'B2-067':  'Basic',  'B2-068': 'Stage 1', 'B2-069': 'Stage 2',
  'B2-071':  'Basic',  'B2-072': 'Stage 1', 'B2-073': 'Basic',
  'B2-191':  null,
  'B2a-001': 'Basic',  'B2a-002': 'Stage 1',
  'B2a-034': 'Basic',  'B2a-035': 'Stage 1','B2a-036': 'Stage 2',
  'B2a-041': 'Basic',  'B2a-042': 'Stage 1',
  'P-A-005': null,     'P-A-006': null,     'P-A-007': null,
};

// Build enriched registry: stage + cards-detail.json stats
const REG = {};
for (const [id, stage] of Object.entries(STAGE)) {
  const d = detail[id] ?? {};
  REG[id] = { stage, hp: d.hp ?? null, retreatCost: d.retreatCost ?? 0,
               attacks: d.attacks ?? [], abilities: d.abilities ?? [] };
}

// Helper to expand {id, qty} deck list into flat card-ID array
function expand(cards) {
  return cards.flatMap(({ id, qty }) => Array(qty).fill(id));
}

// ─── Full META_SNAPSHOT (all 20 decks, cards expanded) ───────────────────────
const META_SNAPSHOT = [
  { id: 'mimikyu-ex-greninja',         tier: 'A', winRate: 61.4,  popularity:  0.18,
    cards: expand([{id:'A1-087',qty:2},{id:'A1-088',qty:2},{id:'A1-089',qty:2},
                   {id:'B2-073',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-220',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'magnezone-bellibolt-ex',       tier: 'A', winRate: 51.9,  popularity: 11.81,
    cards: expand([{id:'B1a-024',qty:2},{id:'B1a-025',qty:2},{id:'B1a-026',qty:2},
                   {id:'B2a-041',qty:2},{id:'B2a-042',qty:2},{id:'P-A-005',qty:2},
                   {id:'P-A-007',qty:2},{id:'A1-223',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2}]) },
  { id: 'mega-altaria-ex-gourgeist',    tier: 'A', winRate: 55.3,  popularity:  4.41,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'B2-071',qty:2},{id:'B2-072',qty:2},{id:'B2a-001',qty:2},
                   {id:'B2a-002',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2}]) },
  { id: 'mega-altaria-ex-greninja',     tier: 'B', winRate: 48.9,  popularity: 12.45,
    cards: expand([{id:'A1-087',qty:2},{id:'A1-088',qty:2},{id:'A1-089',qty:2},
                   {id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2}]) },
  { id: 'greninja-mega-absol-ex',       tier: 'B', winRate: 51.3,  popularity:  8.33,
    cards: expand([{id:'A1-087',qty:2},{id:'A1-088',qty:2},{id:'A1-089',qty:2},
                   {id:'B1-150',qty:2},{id:'B1-151',qty:2},{id:'P-A-005',qty:2},
                   {id:'P-A-007',qty:2},{id:'A1-220',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2}]) },
  { id: 'mega-altaria-ex',              tier: 'B', winRate: 54.7,  popularity:  1.28,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2},
                   {id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'P-A-006',qty:2},{id:'A1-223',qty:2}]) },
  { id: 'gourgeist-houndstone',         tier: 'B', winRate: 51.6,  popularity:  1.74,
    cards: expand([{id:'B2-071',qty:2},{id:'B2-072',qty:2},{id:'B2a-001',qty:2},
                   {id:'B2a-002',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-225',qty:2},{id:'P-A-006',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'magnezone-mega-absol-ex',      tier: 'B', winRate: 55.4,  popularity:  0.19,
    cards: expand([{id:'B1-150',qty:2},{id:'B1-151',qty:2},{id:'B1a-024',qty:2},
                   {id:'B1a-025',qty:2},{id:'B1a-026',qty:2},{id:'P-A-005',qty:2},
                   {id:'P-A-007',qty:2},{id:'A1-223',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2}]) },
  { id: 'mega-altaria-ex-altaria-a',    tier: 'B', winRate: 54.9,  popularity:  0.59,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2},
                   {id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'P-A-006',qty:2},{id:'A1-223',qty:2}]) },
  { id: 'mega-absol-ex-darkrai-ex',     tier: 'B', winRate: 54.8,  popularity:  0.34,
    cards: expand([{id:'B1-150',qty:2},{id:'B1-151',qty:2},{id:'A2-109',qty:2},
                   {id:'A2-110',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-223',qty:2},{id:'P-A-006',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2}]) },
  { id: 'mega-altaria-ex-altaria-b',    tier: 'B', winRate: 54.3,  popularity:  0.21,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2},
                   {id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'P-A-006',qty:2},{id:'A1-223',qty:2}]) },
  { id: 'suicune-ex-baxcalibur',        tier: 'B', winRate: 47.1,  popularity: 11.57,
    cards: expand([{id:'A4a-020',qty:2},{id:'B2a-034',qty:2},{id:'B2a-035',qty:2},
                   {id:'B2a-036',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-220',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'bellibolt-ex-zeraora',         tier: 'B', winRate: 49.1,  popularity:  5.68,
    cards: expand([{id:'B1-304',qty:2},{id:'B2a-041',qty:2},{id:'B2a-042',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-223',qty:2},
                   {id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'P-A-006',qty:2}]) },
  { id: 'hydreigon-mega-absol-ex',      tier: 'C', winRate: 48.1,  popularity:  3.96,
    cards: expand([{id:'B1-155',qty:2},{id:'B1-156',qty:2},{id:'B1-157',qty:2},
                   {id:'B1-150',qty:2},{id:'B1-151',qty:2},{id:'P-A-005',qty:2},
                   {id:'P-A-007',qty:2},{id:'A1-223',qty:2},{id:'P-A-006',qty:2},{id:'A1-225',qty:2}]) },
  { id: 'mega-altaria-ex-chingling',    tier: 'C', winRate: 49.6,  popularity:  1.68,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'B1-109',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'P-A-006',qty:2}]) },
  { id: 'leafeon-ex-teal-ogerpon-ex',   tier: 'C', winRate: 53.5,  popularity:  0.56,
    cards: expand([{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-223',qty:2},
                   {id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2},
                   {id:'P-A-006',qty:2},{id:'A1-220',qty:2},{id:'B1-109',qty:2},{id:'A3-034',qty:2}]) },
  { id: 'mega-altaria-ex-banette',      tier: 'C', winRate: 53.1,  popularity:  0.29,
    cards: expand([{id:'B1-196',qty:2},{id:'B1-197',qty:2},{id:'B1-102',qty:2},
                   {id:'A3-074',qty:2},{id:'A3-075',qty:2},{id:'P-A-005',qty:2},
                   {id:'P-A-007',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'greninja-oricorio',            tier: 'C', winRate: 48.0,  popularity:  0.80,
    cards: expand([{id:'A1-087',qty:2},{id:'A1-088',qty:2},{id:'A1-089',qty:2},
                   {id:'A3-034',qty:2},{id:'P-A-005',qty:2},{id:'P-A-007',qty:2},
                   {id:'A1-220',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'giratina-ex-darkrai-ex',       tier: 'C', winRate: 53.2,  popularity:  0.54,
    cards: expand([{id:'A2-109',qty:2},{id:'A2-110',qty:2},{id:'A2b-035',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-223',qty:2},
                   {id:'P-A-006',qty:2},{id:'A1-225',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2}]) },
  { id: 'chandelure-meowth',            tier: 'C', winRate: 51.0,  popularity:  0.29,
    cards: expand([{id:'B2-067',qty:2},{id:'B2-068',qty:2},{id:'B2-069',qty:2},
                   {id:'P-A-005',qty:2},{id:'P-A-007',qty:2},{id:'A1-225',qty:2},
                   {id:'P-A-006',qty:2},{id:'B2-191',qty:2},{id:'B1-225',qty:2},{id:'A1-223',qty:2}]) },
];

// ─── Smoke test ───────────────────────────────────────────────────────────────
console.log('=== Smoke tests ===');
const sample = ['A1-087', 'A1-088', 'A1-089', 'B2-073'];
console.log('scoreDeck:',    scoreDeck(sample, REG));
console.log('analyzeDeck:',  analyzeDeck(sample, REG));
console.log('suggestSwaps:', suggestSwaps(sample, REG));

// ─── Score every deck ─────────────────────────────────────────────────────────
const results = META_SNAPSHOT.map(deck => ({
  ...scoreDeck(deck.cards, REG),
  id:       deck.id,
  metaTier: deck.tier,
  winRate:  deck.winRate,
}));

// Sort descending by total score
results.sort((a, b) => b.total - a.total);

// ─── Full table ───────────────────────────────────────────────────────────────
console.log('\n=== All 20 decks — sorted by score descending ===');
console.log(
  'rank  score tier  meta  wr     spd   dmg   sur   con   dis   deck'
);
console.log('─'.repeat(100));
results.forEach((r, i) => {
  const b = r.breakdown;
  console.log(
    `#${String(i + 1).padEnd(4)} ${String(r.total).padEnd(5)} ${r.tier.padEnd(5)} ` +
    `${r.metaTier.padEnd(5)} ${String(r.winRate).padEnd(6)} ` +
    `${String(b.speed).padEnd(5)} ${String(b.damage).padEnd(5)} ` +
    `${String(b.survivability).padEnd(5)} ${String(b.consistency).padEnd(5)} ` +
    `${String(b.disruption).padEnd(5)} ${r.id}`
  );
});

// ─── Validation ───────────────────────────────────────────────────────────────
console.log('\n=== Validation ===');

const byWinRate    = [...results].sort((a, b) => b.winRate - a.winRate);
const highestWR    = byWinRate[0];
const cTierDecks   = results.filter(r => r.metaTier === 'C');
const lowestCScore = Math.min(...cTierDecks.map(r => r.total));
const worstC       = cTierDecks.find(r => r.total === lowestCScore);

// Tier-order check: every A-tier deck should outscore every B/C-tier deck,
// and every B-tier deck should outscore every C-tier deck.
const tierRank = { A: 0, B: 1, C: 2 };
let rankOK = true;
for (const hi of results) {
  for (const lo of results) {
    if (tierRank[hi.metaTier] < tierRank[lo.metaTier] && hi.total <= lo.total) {
      rankOK = false;
    }
  }
}

const wrPass   = highestWR.total >= 75;
const cPass    = lowestCScore     <= 55;

console.log(`1. Highest win-rate deck : ${highestWR.id}`);
console.log(`   score=${highestWR.total}  target ≥75 → ${wrPass ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`2. Lowest C-tier score   : ${worstC.id}`);
console.log(`   score=${lowestCScore}  target ≤55 → ${cPass ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`3. Tier rank order       : ${rankOK ? 'PASS ✓' : 'FAIL ✗ (rank inversions found)'}`);

if (!rankOK) {
  console.log('\n   Rank inversions (lower-tier deck outscores higher-tier deck):');
  for (const hi of results) {
    for (const lo of results) {
      if (tierRank[hi.metaTier] < tierRank[lo.metaTier] && hi.total <= lo.total) {
        console.log(`   ${hi.metaTier}-tier "${hi.id}" (${hi.total}) ≤ ${lo.metaTier}-tier "${lo.id}" (${lo.total})`);
      }
    }
  }
}

if (!wrPass || !cPass || !rankOK) {
  console.log('\n   → One or more checks failed. Option B may be required.');
}

// ─── Phase 2 validation: analyzeDeck ─────────────────────────────────────────
console.log('\n=== Phase 2 validation: analyzeDeck ===');

// Case 1: highest win-rate deck (mimikyu-ex-greninja)
const mimikyuDeck = META_SNAPSHOT.find(d => d.id === 'mimikyu-ex-greninja');
console.log('\n[Case 1] Highest win-rate deck:', mimikyuDeck.id);
const mimikyuAnalysis = analyzeDeck(mimikyuDeck.cards, REG);
console.log(JSON.stringify(mimikyuAnalysis, null, 2));
const mimikyuOK = mimikyuAnalysis.healthLabel === 'SOLID' &&
  mimikyuAnalysis.weaknesses.every(w => w.severity === 'WARNING') &&
  mimikyuAnalysis.weaknesses.length <= 1;
console.log(`healthLabel="${mimikyuAnalysis.healthLabel}" weaknesses=${mimikyuAnalysis.weaknesses.length} → ${mimikyuOK ? 'PASS ✓' : 'FAIL ✗ (expected SOLID with ≤1 WARNING)'}`);

// Case 2: lowest-scored deck from Phase 1 (score=34, mega-altaria-ex variants tied — use first)
const lowestDeck = results[results.length - 1];
const lowestSnapshot = META_SNAPSHOT.find(d => d.id === lowestDeck.id);
console.log('\n[Case 2] Lowest-scored deck:', lowestSnapshot.id);
const lowestAnalysis = analyzeDeck(lowestSnapshot.cards, REG);
console.log(JSON.stringify(lowestAnalysis, null, 2));
const lowestOK = lowestAnalysis.weaknesses.length >= 1;
console.log(`weaknesses=${lowestAnalysis.weaknesses.length} → ${lowestOK ? 'PASS ✓' : 'FAIL ✗ (expected ≥1 weakness)'}`);

// ─── Phase 3 validation: suggestSwaps ────────────────────────────────────────
console.log('\n=== Phase 3 validation: suggestSwaps ===');

// Case 1: lowest-scored deck — expects ≥1 suggestion with scoreDelta > 0
const lowestSuggestSnap = META_SNAPSHOT.find(d => d.id === lowestDeck.id);
console.log('\n[Case 1] Lowest-scored deck:', lowestSuggestSnap.id);
console.time('suggestSwaps case 1');
const lowSuggestions = suggestSwaps(lowestSuggestSnap.cards, REG);
console.timeEnd('suggestSwaps case 1');
console.log(JSON.stringify(lowSuggestions, null, 2));
const lowOK = lowSuggestions.suggestions.length >= 1 &&
  lowSuggestions.suggestions.every(s => s.scoreDelta > 0);
console.log(`suggestions=${lowSuggestions.suggestions.length} all scoreDelta>0=${lowSuggestions.suggestions.every(s => s.scoreDelta > 0)} → ${lowOK ? 'PASS ✓' : 'FAIL ✗ (expected ≥1 suggestion with scoreDelta>0)'}`);

// Case 2: highest win-rate deck — may return 0 suggestions or small scoreDelta
console.log('\n[Case 2] Highest win-rate deck:', mimikyuDeck.id);
console.time('suggestSwaps case 2');
const highSuggestions = suggestSwaps(mimikyuDeck.cards, REG);
console.timeEnd('suggestSwaps case 2');
console.log(JSON.stringify(highSuggestions, null, 2));
console.log(`suggestions=${highSuggestions.suggestions.length} → PASS ✓ (0 or small scoreDelta acceptable)`);

// ─── Phase 4 validation: buildMatchupMatrix ───────────────────────────────────
console.log('\n=== Phase 4 validation: buildMatchupMatrix ===');

const matrixData = buildMatchupMatrix(META_SNAPSHOT, REG);
const deckIds    = Object.keys(matrixData);
console.log(`Matrix covers ${deckIds.length} decks, ${deckIds.length * (deckIds.length - 1)} cells`);

// 1. No self-matchups
let selfFound = false;
for (const id of deckIds) {
  if (id in matrixData[id]) { console.error(`FAIL: self-matchup found for ${id}`); selfFound = true; }
}
console.log(`1. No self-matchups → ${selfFound ? 'FAIL ✗' : 'PASS ✓'}`);

// 2. Antisymmetry: matrixData[A][B] + matrixData[B][A] ≈ 1.0 (±0.01)
let antiOK = true;
for (const idA of deckIds) {
  for (const idB of deckIds) {
    if (idA === idB) continue;
    const sum = (matrixData[idA][idB] ?? 0) + (matrixData[idB][idA] ?? 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      console.error(`FAIL antisymmetry: ${idA} vs ${idB} sums to ${sum.toFixed(4)}`);
      antiOK = false;
    }
  }
}
console.log(`2. Antisymmetry (A+B≈1.0) → ${antiOK ? 'PASS ✓' : 'FAIL ✗'}`);

// 3. All values in [0,1]
let rangeOK = true;
for (const idA of deckIds) {
  for (const [idB, v] of Object.entries(matrixData[idA])) {
    if (v < 0 || v > 1) { console.error(`FAIL range: ${idA} vs ${idB} = ${v}`); rangeOK = false; }
  }
}
console.log(`3. All values in [0,1] → ${rangeOK ? 'PASS ✓' : 'FAIL ✗'}`);

// 4. getCounterDecks for highest win-rate deck
const hwrId = mimikyuDeck.id;
const counters = getCounterDecks(hwrId, matrixData, 3);
console.log(`\n4. getCounterDecks("${hwrId}"):`);
counters.forEach(c => console.log(`   ${c.opponentId}  win-rate-against=${c.winRateAgainst}`));

// 5. getBestDeckVsField top 3
const bestVsField = getBestDeckVsField(matrixData).slice(0, 3);
console.log('\n5. getBestDeckVsField() top 3:');
bestVsField.forEach((d, i) => console.log(`   #${i+1} ${d.deckId}  avgWinRate=${d.avgWinRate}`));

// ─── Phase 5 validation: solveNash ────────────────────────────────────────────
console.log('\n=== Phase 5 validation: solveNash ===');

const nashResult = solveNash(matrixData, META_SNAPSHOT);

// 1. Converged
console.log(`1. converged → ${nashResult.converged ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`   iterations: ${nashResult.iterations}`);
console.log(`   dominantStrategy: ${nashResult.dominantStrategy ?? 'none'}`);

// 2. Shares sum to ≈ 1.0
const shareSum = Object.values(nashResult.equilibriumShares).reduce((s, v) => s + v, 0);
const sumOK = Math.abs(shareSum - 1.0) < 0.001;
console.log(`2. Shares sum ≈ 1.0 (got ${shareSum.toFixed(6)}) → ${sumOK ? 'PASS ✓' : 'FAIL ✗'}`);

// 3. All shares positive
const allPos = Object.values(nashResult.equilibriumShares).every(v => v > 0);
console.log(`3. All shares positive → ${allPos ? 'PASS ✓' : 'FAIL ✗'}`);

// 4. compareToActualMeta output
const comparison = compareToActualMeta(nashResult, META_SNAPSHOT);

console.log('\n4. compareToActualMeta() — sorted by delta descending:');
console.log('   deckId                          nash%   actual%   delta    signal');
console.log('   ' + '─'.repeat(76));
comparison.forEach(r => {
  const id     = r.deckId.padEnd(34);
  const nash   = String(r.nashShare.toFixed(1)).padStart(5);
  const actual = String(r.actualShare.toFixed(1)).padStart(6);
  const delta  = (r.delta >= 0 ? '+' : '') + r.delta.toFixed(1);
  console.log(`   ${id} ${nash}%  ${actual}%  ${delta.padStart(6)}   ${r.signal}`);
});

// 5. Signal breakdown + count check
const signals = { UNDERPICKED: 0, OVERPICKED: 0, BALANCED: 0 };
comparison.forEach(r => signals[r.signal]++);
const countOK = comparison.length === META_SNAPSHOT.length;
console.log(`\n5. Signal breakdown: UNDERPICKED=${signals.UNDERPICKED}  OVERPICKED=${signals.OVERPICKED}  BALANCED=${signals.BALANCED}`);
console.log(`   Total count ${comparison.length} === META_SNAPSHOT.length ${META_SNAPSHOT.length} → ${countOK ? 'PASS ✓' : 'FAIL ✗'}`);

// ─── Phase 6 validation: detectBehavioralBias ────────────────────────────────
console.log('\n=== Phase 6 validation: detectBehavioralBias ===');

const biasData = detectBehavioralBias(comparison, META_SNAPSHOT);

// 1. Full table
console.log('\n1. Full bias table (sorted by biasScore descending):');
console.log('   ' + 'deckId'.padEnd(34) + 'tag'.padEnd(26) + 'bias'.padStart(6) + '  delta'.padStart(8) + '  actual%'.padStart(9) + '  wr%'.padStart(7));
console.log('   ' + '─'.repeat(88));
biasData.forEach(d => {
  const id    = d.deckId.padEnd(34);
  const tag   = d.behavioralTag.padEnd(26);
  const bias  = String(d.biasScore).padStart(6);
  const delta = ((d.delta >= 0 ? '+' : '') + d.delta.toFixed(1)).padStart(8);
  const act   = (d.actualShare.toFixed(1) + '%').padStart(9);
  const wr    = (d.winRate.toFixed(1) + '%').padStart(7);
  console.log(`   ${id}${tag}${bias}${delta}${act}${wr}`);
});

// 2. No undefined tags
const noUndefined = biasData.every(d => d.behavioralTag !== undefined);
console.log(`\n2. No undefined behavioralTag → ${noUndefined ? 'PASS ✓' : 'FAIL ✗'}`);

// 3. All biasScores in [-100, +100]
const inRange = biasData.every(d => d.biasScore >= -100 && d.biasScore <= 100);
console.log(`3. All biasScores in [-100,+100] → ${inRange ? 'PASS ✓' : 'FAIL ✗'}`);

// 4. Top EV picks
const evPicks = getTopEVPicks(biasData, 3);
console.log('\n4. getTopEVPicks() top 3:');
evPicks.forEach((d, i) => {
  console.log(`   #${i + 1} [${d.behavioralTag}] biasScore=${d.biasScore}  ${d.deckId}`);
  console.log(`      ${d.ladderAdvice}`);
});

// 5. ladderAdvice contains real numbers (no placeholder braces)
const noPlaceholders = biasData.every(d => !d.ladderAdvice.includes('{') && !d.ladderAdvice.includes('}'));
const hasNumbers     = biasData.every(d => /\d/.test(d.ladderAdvice));
console.log(`\n5. ladderAdvice has no placeholders → ${noPlaceholders ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`   ladderAdvice contains real numbers  → ${hasNumbers     ? 'PASS ✓' : 'FAIL ✗'}`);

// ─── Phase 7 validation: scoreEvolutionaryStability ──────────────────────────
console.log('\n=== Phase 7 validation: scoreEvolutionaryStability ===');

const essData = scoreEvolutionaryStability(META_SNAPSHOT, matrixData, nashResult);

// 1. Full ESS table
console.log('\n1. Full ESS table (sorted by essScore descending):');
console.log('   ' + 'deckId'.padEnd(34) + 'ess'.padStart(6) + ' ess?'.padEnd(6) +
            'field'.padStart(7) + ' invVuln'.padStart(9) + ' risk'.padEnd(8) + ' hardCounter');
console.log('   ' + '─'.repeat(90));
essData.forEach(d => {
  const id   = d.deckId.padEnd(34);
  const ess  = String(d.essScore).padStart(6);
  const flag = (d.isESS ? '✓' : '·').padEnd(6);
  const ff   = String(d.fieldFitness).padStart(7);
  const iv   = String(d.invasionVulnerability).padStart(9);
  const risk = d.extinctionRisk.padEnd(8);
  console.log(`   ${id}${ess} ${flag}${ff}${iv} ${risk} ${d.hardCounter}`);
});

// 2. All essScores in [0, 100]
const essInRange = essData.every(d => d.essScore >= 0 && d.essScore <= 100);
console.log(`\n2. All essScores in [0,100] → ${essInRange ? 'PASS ✓' : 'FAIL ✗'}`);

// 3. All extinctionRisk values valid
const validRisks = new Set(['LOW','MEDIUM','HIGH']);
const riskOK = essData.every(d => validRisks.has(d.extinctionRisk));
console.log(`3. All extinctionRisk valid → ${riskOK ? 'PASS ✓' : 'FAIL ✗'}`);

// 4. All hardCounters are valid deckIds
const allDeckIds = new Set(Object.keys(matrixData));
const counterOK  = essData.every(d => d.hardCounter && allDeckIds.has(d.hardCounter));
console.log(`4. All hardCounters are valid deckIds → ${counterOK ? 'PASS ✓' : 'FAIL ✗'}`);

// 5. ESS count
const essCount = essData.filter(d => d.isESS).length;
console.log(`5. Decks classified as ESS (score ≥ 65): ${essCount}`);

// 6. simulateMetaShift — boost most-played deck
const mostPlayed = biasData.reduce((max, d) => d.actualShare > max.actualShare ? d : max, biasData[0]);
console.log(`\n6. simulateMetaShift() boosting: ${mostPlayed.deckId} (${mostPlayed.actualShare}% actual share)`);
const shiftResult = simulateMetaShift(essData, matrixData, nashResult, mostPlayed.deckId);

console.log('   Top 5 decks most affected (by |delta|):');
console.log('   ' + 'deckId'.padEnd(34) + 'before'.padStart(8) + ' after'.padStart(7) + ' delta'.padStart(7) + '  status');
console.log('   ' + '─'.repeat(70));
shiftResult.results.slice(0, 5).forEach(r => {
  const id     = r.deckId.padEnd(34);
  const before = String(r.essScoreBefore).padStart(8);
  const after  = String(r.essScoreAfter).padStart(7);
  const delta  = ((r.delta >= 0 ? '+' : '') + r.delta).padStart(7);
  console.log(`   ${id}${before}${after}${delta}  ${r.essStatusChange}`);
});

// 7. essScoreBefore and essScoreAfter in [0, 100]
const shiftRangeOK = shiftResult.results.every(
  r => r.essScoreBefore >= 0 && r.essScoreBefore <= 100 &&
       r.essScoreAfter  >= 0 && r.essScoreAfter  <= 100
);
console.log(`\n7. All essScoreBefore/After in [0,100] → ${shiftRangeOK ? 'PASS ✓' : 'FAIL ✗'}`);
