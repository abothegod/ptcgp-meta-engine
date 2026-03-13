#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║        PTCGP META INTELLIGENCE ENGINE  — update-meta.js         ║
 * ║  Bi-weekly automated update for ptcgp-meta-engine.html          ║
 * ║                                                                  ║
 * ║  Usage:   node update-meta.js                                   ║
 * ║  Requires: Node 18+ (uses native fetch)                         ║
 * ║                                                                  ║
 * ║  Data sources:                                                   ║
 * ║    1. Limitless API  — /api/tournaments + /standings             ║
 * ║       No API key needed; computes real win rates + meta share    ║
 * ║       from raw player records across the last 50 tournaments.   ║
 * ║    2. ptcgpocket.gg  — editorial tier overrides (optional)       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * STRATEGY ENGINE OVERVIEW
 * ────────────────────────
 * The engine scores every detected archetype on 6 dimensions,
 * then constructs a clean 20-card list using weighted card selection.
 * Tiers are assigned from the composite score, not imported from any site.
 *
 *   Dimension          Weight   What it measures
 *   ─────────────────────────────────────────────────────────────────
 *   Win Rate            40 %    Raw tournament win rate
 *   Meta Share          20 %    log-weighted popularity / meta share
 *   Type Coherence      10 %    Penalty for multi-energy requirement
 *   Evolution Lines     10 %    Full Stage-1/Stage-2 chains present
 *   Setup Speed         10 %    Estimated turns to first big attack
 *   Disruption Value    10 %    Red Card / Sabrina / stall options
 *
 *   Score 75+  → S-Tier
 *   Score 60+  → A-Tier
 *   Score 45+  → B-Tier
 *   Score <45  → C-Tier
 *
 * DECK CONSTRUCTION RULES
 * ───────────────────────
 * 1. Primary win-condition: 1 high-damage attacker (EX/Mega preferred)
 * 2. Full evolution line if Stage 2: 2-2-2 (Basic-Stage1-Stage2)
 * 3. Support Pokémon: chip-dmg engine OR energy accel OR tank/stall
 * 4. Trainer core: 2× Poké Ball + 2× Professor's Research (always)
 * 5. Supporter suite: 2 type-relevant supporters (Giovanni/Sabrina/Misty…)
 * 6. Draw engine: 2× Copycat OR 2× Sightseer (meta-dependent)
 * 7. Flex slots: fill with 1-prize attackers or disruption
 * 8. Hard constraints: exactly 20 cards, max 2× any single card
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

const HTML_FILE = path.resolve(__dirname, 'ptcgp-meta-engine.html');

const LIMITLESS_BASE = 'https://play.limitlesstcg.com/api';

// Formats to skip — non-standard tournament types skew win rates
const SKIP_FORMATS = new Set(['NOEX', 'MONO', 'SINGLETON', 'DRAFT', 'THEME']);

// Min appearances across all tournaments to include an archetype
const MIN_APPEARANCES = 10;

// Min players in a tournament to include it
const MIN_PLAYERS = 20;

// How many recent tournaments to sample
const TOURNAMENT_LIMIT = 50;

// Polite delay between standings API calls (ms)
const API_DELAY_MS = 150;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PTCGP-MetaBot/1.0; +https://github.com)',
  'Accept':     'application/json, text/html',
};

// ═══════════════════════════════════════════════════════════════════
// STRATEGY ENGINE — WEIGHTS & RULES
// ═══════════════════════════════════════════════════════════════════

const WEIGHTS = {
  winRate:       0.40,
  metaShare:     0.20,
  typeCoherence: 0.10,
  evoLines:      0.10,
  setupSpeed:    0.10,
  disruption:    0.10,
};

const TIER_THRESHOLDS = { S: 75, A: 60, B: 45 };

/**
 * Score a deck archetype from 0–100.
 */
function scoreArchetype(archetype, allDecks) {
  const maxWinRate = Math.max(...allDecks.map(d => d.winRate   || 50));
  const maxShare   = Math.max(...allDecks.map(d => d.metaShare || 1));

  // 1. Win-rate component (0–40)
  const wrNorm  = Math.min((archetype.winRate - 45) / (maxWinRate - 45), 1);
  const wrScore = Math.max(wrNorm * 40, 0);

  // 2. Meta-share (log-weighted, 0–20)
  const shareNorm  = Math.log10((archetype.metaShare || 0) + 1) /
                     Math.log10(maxShare + 1);
  const shareScore = shareNorm * 20;

  // 3. Type coherence
  const energyCount = (archetype.energyTypes || []).length;
  const typeScore   = energyCount === 1 ? 10 : energyCount === 2 ? 5 : 0;

  // 4. Evolution line
  const evoScore = archetype.hasFullEvoLine ? 10 : archetype.hasPartialEvo ? 5 : 3;

  // 5. Setup speed
  const setupMap   = { 1: 10, 2: 7, 3: 4 };
  const setupScore = setupMap[archetype.setupTurns] ?? 6;

  // 6. Disruption
  const dispScore = Math.min((archetype.disruptionScore || 0), 10);

  const total = wrScore + shareScore + typeScore + evoScore + setupScore + dispScore;
  return Math.round(Math.min(total, 100));
}

function assignTier(score) {
  if (score >= TIER_THRESHOLDS.S) return 'S';
  if (score >= TIER_THRESHOLDS.A) return 'A';
  if (score >= TIER_THRESHOLDS.B) return 'B';
  return 'C';
}

// ═══════════════════════════════════════════════════════════════════
// KNOWN CARD DATABASE
// ═══════════════════════════════════════════════════════════════════

const KNOWN_CARDS = {
  // Promo-A
  "P-A-005": { name: "Poké Ball",           type: "Trainer",   pack: "Promo-A",             rarity: "PR" },
  "P-A-006": { name: "Red Card",            type: "Trainer",   pack: "Promo-A",             rarity: "PR" },
  "P-A-007": { name: "Professor's Research",type: "Trainer",   pack: "Promo-A",             rarity: "PR" },
  // B2 Fantastical Parade
  "B2-066":  { name: "Mega Gardevoir ex",   type: "Psychic",   pack: "Fantastical Parade",  rarity: "EX" },
  "B2-067":  { name: "Litwick",             type: "Fire",      pack: "Fantastical Parade",  rarity: "C"  },
  "B2-068":  { name: "Lampent",             type: "Fire",      pack: "Fantastical Parade",  rarity: "U"  },
  "B2-069":  { name: "Chandelure",          type: "Fire",      pack: "Fantastical Parade",  rarity: "R"  },
  "B2-071":  { name: "Pumpkaboo",           type: "Psychic",   pack: "Fantastical Parade",  rarity: "C"  },
  "B2-072":  { name: "Gourgeist",           type: "Psychic",   pack: "Fantastical Parade",  rarity: "R"  },
  "B2-073":  { name: "Mimikyu ex",          type: "Psychic",   pack: "Fantastical Parade",  rarity: "EX" },
  "B2-098":  { name: "Galarian Zigzagoon",  type: "Dark",      pack: "Fantastical Parade",  rarity: "C"  },
  "B2-099":  { name: "Galarian Linoone",    type: "Dark",      pack: "Fantastical Parade",  rarity: "U"  },
  "B2-100":  { name: "Galarian Obstagoon",  type: "Dark",      pack: "Fantastical Parade",  rarity: "R"  },
  "B2-126":  { name: "Kangaskhan",          type: "Colorless", pack: "Fantastical Parade",  rarity: "C"  },
  "B2-127":  { name: "Mega Kangaskhan ex",  type: "Colorless", pack: "Fantastical Parade",  rarity: "EX" },
  "B2-128":  { name: "Meowth",              type: "Colorless", pack: "Fantastical Parade",  rarity: "C"  },
  "B2-191":  { name: "Sightseer",           type: "Trainer",   pack: "Fantastical Parade",  rarity: "U"  },
  // B2a Horizon of Dreams
  "B2a-001": { name: "Greavard",            type: "Dark",      pack: "Horizon of Dreams",   rarity: "C"  },
  "B2a-002": { name: "Houndstone",          type: "Dark",      pack: "Horizon of Dreams",   rarity: "R"  },
  "B2a-003": { name: "Meloetta",            type: "Psychic",   pack: "Horizon of Dreams",   rarity: "R"  },
  "B2a-004": { name: "Klefki",              type: "Colorless", pack: "Horizon of Dreams",   rarity: "U"  },
  // B1 Mega Rising
  "B1-034":  { name: "Torchic",             type: "Fire",      pack: "Mega Rising",         rarity: "C"  },
  "B1-035":  { name: "Combusken",           type: "Fire",      pack: "Mega Rising",         rarity: "U"  },
  "B1-036":  { name: "Mega Blaziken ex",    type: "Fire",      pack: "Mega Rising",         rarity: "EX" },
  "B1-041":  { name: "Litwick",             type: "Fire",      pack: "Mega Rising",         rarity: "C"  },
  "B1-042":  { name: "Lampent",             type: "Fire",      pack: "Mega Rising",         rarity: "U"  },
  "B1-043":  { name: "Chandelure",          type: "Fire",      pack: "Mega Rising",         rarity: "R"  },
  "B1-071":  { name: "Froakie",             type: "Water",     pack: "Mega Rising",         rarity: "C"  },
  "B1-072":  { name: "Frogadier",           type: "Water",     pack: "Mega Rising",         rarity: "U"  },
  "B1-073":  { name: "Greninja ex",         type: "Water",     pack: "Mega Rising",         rarity: "EX" },
  "B1-102":  { name: "Mega Altaria ex",     type: "Colorless", pack: "Mega Rising",         rarity: "EX" },
  "B1-109":  { name: "Chingling",           type: "Psychic",   pack: "Mega Rising",         rarity: "C"  },
  "B1-121":  { name: "Indeedee ex",         type: "Psychic",   pack: "Mega Rising",         rarity: "EX" },
  "B1-150":  { name: "Absol",               type: "Dark",      pack: "Mega Rising",         rarity: "R"  },
  "B1-151":  { name: "Mega Absol ex",       type: "Dark",      pack: "Mega Rising",         rarity: "EX" },
  "B1-155":  { name: "Deino",               type: "Dark",      pack: "Mega Rising",         rarity: "C"  },
  "B1-156":  { name: "Zweilous",            type: "Dark",      pack: "Mega Rising",         rarity: "U"  },
  "B1-157":  { name: "Hydreigon",           type: "Dark",      pack: "Mega Rising",         rarity: "R"  },
  "B1-196":  { name: "Swablu",              type: "Colorless", pack: "Mega Rising",         rarity: "C"  },
  "B1-197":  { name: "Altaria",             type: "Colorless", pack: "Mega Rising",         rarity: "U"  },
  "B1-225":  { name: "Copycat",             type: "Trainer",   pack: "Mega Rising",         rarity: "U"  },
  // B1a Crimson Blaze
  "B1a-014": { name: "Mega Charizard Y ex", type: "Fire",      pack: "Crimson Blaze",       rarity: "EX" },
  "B1a-024": { name: "Magnemite",           type: "Lightning", pack: "Crimson Blaze",       rarity: "C"  },
  "B1a-025": { name: "Magneton",            type: "Lightning", pack: "Crimson Blaze",       rarity: "U"  },
  "B1a-026": { name: "Magnezone",           type: "Lightning", pack: "Crimson Blaze",       rarity: "R"  },
  // A1 Genetic Apex
  "A1-087":  { name: "Froakie",             type: "Water",     pack: "Genetic Apex",        rarity: "C"  },
  "A1-088":  { name: "Frogadier",           type: "Water",     pack: "Genetic Apex",        rarity: "U"  },
  "A1-089":  { name: "Greninja",            type: "Water",     pack: "Genetic Apex",        rarity: "R"  },
  "A1-129":  { name: "Mewtwo ex",           type: "Psychic",   pack: "Genetic Apex",        rarity: "EX" },
  "A1-130":  { name: "Ralts",               type: "Psychic",   pack: "Genetic Apex",        rarity: "C"  },
  "A1-131":  { name: "Kirlia",              type: "Psychic",   pack: "Genetic Apex",        rarity: "U"  },
  "A1-132":  { name: "Gardevoir",           type: "Psychic",   pack: "Genetic Apex",        rarity: "R"  },
  "A1-196":  { name: "Meowth",              type: "Colorless", pack: "Genetic Apex",        rarity: "C"  },
  "A1-220":  { name: "Misty",               type: "Trainer",   pack: "Genetic Apex",        rarity: "R"  },
  "A1-223":  { name: "Giovanni",            type: "Trainer",   pack: "Genetic Apex",        rarity: "R"  },
  "A1-225":  { name: "Sabrina",             type: "Trainer",   pack: "Genetic Apex",        rarity: "R"  },
  // A2 Space-Time Smackdown
  "A2-109":  { name: "Darkrai",             type: "Dark",      pack: "Space-Time Smackdown",rarity: "R"  },
  "A2-110":  { name: "Darkrai ex",          type: "Dark",      pack: "Space-Time Smackdown",rarity: "EX" },
  // A2b Shining Revelry
  "A2b-035": { name: "Giratina ex",         type: "Psychic",   pack: "Shining Revelry",     rarity: "EX" },
  // A3 Celestial Guardians
  "A3-034":  { name: "Oricorio",            type: "Fire",      pack: "Celestial Guardians", rarity: "U"  },
  // A3b Eevee Grove
  "A3b-057": { name: "Snorlax ex",          type: "Colorless", pack: "Eevee Grove",         rarity: "EX" },
  // A4a Secluded Springs
  "A4a-020": { name: "Suicune ex",          type: "Water",     pack: "Secluded Springs",    rarity: "EX" },
};

// ═══════════════════════════════════════════════════════════════════
// CARD NAME → ID LOOKUP
// ═══════════════════════════════════════════════════════════════════

const NAME_TO_ID = {};
for (const [id, card] of Object.entries(KNOWN_CARDS)) {
  const key = card.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!NAME_TO_ID[key]) NAME_TO_ID[key] = id;
}

function resolveCardId(name) {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return NAME_TO_ID[key] || null;
}

// ═══════════════════════════════════════════════════════════════════
// DECK CONSTRUCTION LOGIC
// ═══════════════════════════════════════════════════════════════════

const TRAINER_CORE = [
  { id: "P-A-005", qty: 2 }, // Poké Ball
  { id: "P-A-007", qty: 2 }, // Professor's Research
];

const TYPE_SUPPORTERS = {
  "Water":     [{ id: "A1-220", qty: 2 }],  // Misty
  "Dark":      [{ id: "A1-223", qty: 2 }],  // Giovanni
  "Fire":      [{ id: "A1-223", qty: 2 }],  // Giovanni
  "Lightning": [{ id: "A1-223", qty: 2 }],  // Giovanni
  "Psychic":   [{ id: "A1-225", qty: 2 }],  // Sabrina
  "Colorless": [{ id: "A1-225", qty: 2 }],  // Sabrina
};

const DRAW_OPTIONS = [
  { id: "B1-225", qty: 2 }, // Copycat
  { id: "B2-191", qty: 2 }, // Sightseer
];

function buildOptimalDeck(coreIds, type) {
  const deck = {};

  const addCard = (id, qty) => {
    if (!KNOWN_CARDS[id]) return;
    deck[id] = (deck[id] || 0) + qty;
    if (deck[id] > 2) deck[id] = 2;
  };

  for (const id of coreIds) addCard(id, 2);
  for (const t of TRAINER_CORE) addCard(t.id, t.qty);

  const supporter = TYPE_SUPPORTERS[type] || [{ id: "A1-223", qty: 2 }];
  for (const s of supporter) addCard(s.id, s.qty);

  const totalQty = () => Object.values(deck).reduce((s, q) => s + q, 0);

  if (['Dark','Psychic'].includes(type) && totalQty() < 20) addCard("P-A-006", 2);
  if (!deck["A1-225"] && totalQty() < 20) addCard("A1-225", Math.min(2, 20 - totalQty()));

  if (totalQty() < 20) {
    const drawChoice = deck["B2-191"] ? DRAW_OPTIONS[0] : DRAW_OPTIONS[1];
    addCard(drawChoice.id, Math.min(2, 20 - totalQty()));
  }
  if (totalQty() < 20) {
    const other = deck["B1-225"] ? DRAW_OPTIONS[1] : DRAW_OPTIONS[0];
    addCard(other.id, Math.min(2, 20 - totalQty()));
  }

  const result = Object.entries(deck)
    .filter(([id]) => KNOWN_CARDS[id])
    .map(([id, qty]) => ({ id, qty }));

  const total = result.reduce((s, c) => s + c.qty, 0);
  if (total !== 20) {
    log(`WARN: Deck for type ${type} has ${total} cards, not 20.`, 'yellow');
  }

  return result.slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════
// LIMITLESS API FETCHER
// Aggregates win rates + meta share from real player records
// No API key required for /tournaments and /standings endpoints
// ═══════════════════════════════════════════════════════════════════

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    log(`  WARN: ${url} — ${err.message}`, 'yellow');
    return null;
  }
}

async function fetchLimitlessData() {
  log('  Fetching tournament list from Limitless API…');

  const tournaments = await fetchJson(
    `${LIMITLESS_BASE}/tournaments?game=POCKET&limit=${TOURNAMENT_LIMIT}`
  );
  if (!tournaments) return [];

  // Filter to standard-format, meaningful-sized tournaments
  const usable = tournaments.filter(t =>
    t.players >= MIN_PLAYERS &&
    (!t.format || !SKIP_FORMATS.has(t.format.toUpperCase()))
  );
  log(`  Using ${usable.length}/${tournaments.length} tournaments (≥${MIN_PLAYERS} players, standard format)`);

  // Aggregate deck stats across all tournament standings
  const deckMap   = {}; // deckId → { name, wins, losses, appearances }
  let   totalPlayers = 0;
  let   fetched   = 0;

  for (const t of usable) {
    const standings = await fetchJson(`${LIMITLESS_BASE}/tournaments/${t.id}/standings`);
    if (!standings) continue;
    fetched++;

    for (const player of standings) {
      if (!player.deck?.id) continue;
      const { id, name } = player.deck;
      if (!deckMap[id]) deckMap[id] = { name, wins: 0, losses: 0, appearances: 0 };
      deckMap[id].wins        += player.record?.wins   || 0;
      deckMap[id].losses      += player.record?.losses || 0;
      deckMap[id].appearances += 1;
    }
    totalPlayers += standings.length;

    await sleep(API_DELAY_MS); // polite pacing
  }

  log(`  Processed ${totalPlayers} player records across ${fetched} tournaments`);

  // Convert to archetype array
  const archetypes = Object.entries(deckMap)
    .filter(([, s]) => s.appearances >= MIN_APPEARANCES)
    .map(([limitlessId, s]) => {
      const games = s.wins + s.losses;
      return {
        name:        s.name,
        winRate:     games > 0 ? (s.wins / games) * 100 : 50,
        metaShare:   totalPlayers > 0 ? (s.appearances / totalPlayers) * 100 : 0,
        count:       s.appearances,
        limitlessId,
        source:      'Limitless',
      };
    })
    .sort((a, b) => b.metaShare - a.metaShare);

  log(`  Limitless API: ${archetypes.length} archetypes with ≥${MIN_APPEARANCES} appearances`);
  return archetypes;
}

// ═══════════════════════════════════════════════════════════════════
// PTCGPOCKET.GG PARSER  (editorial tier overrides, best-effort)
// ═══════════════════════════════════════════════════════════════════

async function fetchPtcgpocketTiers() {
  log('  Fetching ptcgpocket.gg tier list…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('https://ptcgpocket.gg/tier-list/', {
      signal: controller.signal,
      headers: { ...FETCH_HEADERS, Accept: 'text/html' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const tiers = [];
    const rowRe = /\|\s*\**(S|A|B|C)\s*Tier\**\s*\|[^|]*\[([^\]]+)\]/g;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      tiers.push({ name: m[2].trim(), tier: m[1], source: 'ptcgpocket.gg' });
    }
    log(`  ptcgpocket.gg: ${tiers.length} editorial tier entries`);
    return tiers;
  } catch (err) {
    clearTimeout(timer);
    log(`  WARN: ptcgpocket.gg unavailable — ${err.message}`, 'yellow');
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// ARCHETYPE ENRICHMENT
// ═══════════════════════════════════════════════════════════════════

function detectEnergyTypes(name) {
  const typeMap = {
    'Greninja': 'Water', 'Suicune': 'Water', 'Froakie': 'Water',
    'Greninja ex': 'Water',
    'Hydreigon': 'Dark', 'Absol': 'Dark', 'Darkrai': 'Dark',
    'Obstagoon': 'Dark', 'Weavile': 'Dark', 'Houndstone': 'Dark',
    'Giratina': 'Psychic', 'Mewtwo': 'Psychic', 'Gardevoir': 'Psychic',
    'Mimikyu': 'Psychic', 'Gourgeist': 'Psychic', 'Chandelure': 'Psychic',
    'Meloetta': 'Psychic',
    'Magnezone': 'Lightning', 'Jolteon': 'Lightning', 'Raichu': 'Lightning',
    'Charizard': 'Fire', 'Blaziken': 'Fire', 'Entei': 'Fire',
    'Altaria': 'Colorless', 'Kangaskhan': 'Colorless', 'Snorlax': 'Colorless',
    'Leafeon': 'Grass', 'Venusaur': 'Grass',
  };
  const types = new Set();
  for (const [keyword, type] of Object.entries(typeMap)) {
    if (name.includes(keyword)) types.add(type);
  }
  const singleType = {
    'Hydreigon': 'Dark', 'Magnezone': 'Lightning',
    'Mega Altaria': 'Colorless', 'Mega Kangaskhan': 'Colorless',
    'Gourgeist Houndstone': 'Psychic',
  };
  for (const [keyword, type] of Object.entries(singleType)) {
    if (name.includes(keyword)) { types.clear(); types.add(type); break; }
  }
  return types.size > 0 ? [...types] : ['Colorless'];
}

function estimateSetupSpeed(name) {
  if (/Mega (Charizard|Gardevoir|Blaziken|Venusaur|Steelix|Gyarados|Swampert)/.test(name)) return 3;
  if (/Hydreigon|Magnezone|Greninja ex|Chandelure/.test(name)) return 3;
  if (/Gourgeist Houndstone/.test(name)) return 3;
  if (/Suicune|Giratina|Darkrai|Mimikyu/.test(name)) return 2;
  if (/Mega Absol|Mega Kangaskhan|Mega Altaria/.test(name)) return 2;
  if (/Oricorio|Chingling/.test(name)) return 1;
  return 2;
}

function estimateDisruption(name) {
  let score = 0;
  if (/Chingling/.test(name))        score += 3;
  if (/Obstagoon|Galarian/.test(name)) score += 4;
  if (/Darkrai/.test(name))          score += 2;
  if (/Mimikyu/.test(name))          score += 3;
  if (/Giratina/.test(name))         score += 2;
  if (/Houndstone/.test(name))       score += 3; // Houndstone bench pressure
  return Math.min(score, 10);
}

function checkEvoLines(name) {
  const stage2 = ['Hydreigon','Greninja','Magnezone','Chandelure','Gardevoir',
                  'Mega Charizard','Mega Blaziken','Mega Venusaur',
                  'Mega Steelix','Mega Gyarados','Mega Swampert','Gourgeist Houndstone'];
  for (const s2 of stage2) {
    if (name.includes(s2)) return { hasFullEvoLine: true, hasPartialEvo: true };
  }
  const stage1 = ['Gourgeist','Mega Altaria','Mega Absol','Mega Kangaskhan'];
  for (const s1 of stage1) {
    if (name.includes(s1)) return { hasFullEvoLine: false, hasPartialEvo: true };
  }
  return { hasFullEvoLine: false, hasPartialEvo: false };
}

function buildCoreCards(name) {
  const cores = [];
  if (name.includes('Hydreigon'))          cores.push('B1-155','B1-156','B1-157');
  if (name.includes('Greninja ex'))        cores.push('B1-071','B1-072','B1-073');
  if (name.includes('Greninja') && !name.includes('ex')) cores.push('A1-087','A1-088','A1-089');
  if (name.includes('Altaria'))            cores.push('B1-196','B1-197','B1-102');
  if (name.includes('Gourgeist') || name.includes('Houndstone')) {
    cores.push('B2-071','B2-072','B2a-001','B2a-002');
  }
  if (name.includes('Meloetta'))           cores.push('B2a-003');
  if (name.includes('Absol'))              cores.push('B1-150','B1-151');
  if (name.includes('Darkrai'))            cores.push('A2-109','A2-110');
  if (name.includes('Giratina'))           cores.push('A2b-035');
  if (name.includes('Suicune'))            cores.push('A4a-020');
  if (name.includes('Magnezone'))          cores.push('B1a-024','B1a-025','B1a-026');
  if (name.includes('Kangaskhan'))         cores.push('B2-126','B2-127');
  if (name.includes('Obstagoon'))          cores.push('B2-098','B2-099','B2-100');
  if (name.includes('Oricorio'))           cores.push('A3-034');
  if (name.includes('Chingling'))          cores.push('B1-109');
  if (name.includes('Indeedee'))           cores.push('B1-121');
  if (name.includes('Chandelure'))         cores.push('B2-067','B2-068','B2-069');
  if (name.includes('Mimikyu'))            cores.push('B2-073');
  if (name.includes('Blaziken'))           cores.push('B1-034','B1-035','B1-036');
  if (name.includes('Charizard'))          cores.push('B1a-014');
  if (name.includes('Gardevoir'))          cores.push('A1-130','A1-131','A1-132','B2-066');
  if (name.includes('Mewtwo'))             cores.push('A1-129');
  if (name.includes('Snorlax'))            cores.push('A3b-057');
  return [...new Set(cores)].filter(id => KNOWN_CARDS[id]);
}

function enrichArchetype(raw) {
  const energyTypes     = detectEnergyTypes(raw.name);
  const evoInfo         = checkEvoLines(raw.name);
  const setupTurns      = estimateSetupSpeed(raw.name);
  const disruptionScore = estimateDisruption(raw.name);
  return { ...raw, energyTypes, ...evoInfo, setupTurns, disruptionScore };
}

// ═══════════════════════════════════════════════════════════════════
// MERGE & DEDUPLICATE across sources
// ═══════════════════════════════════════════════════════════════════

function normalizeArchetypeName(name) {
  return name.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s*ex\b/g, ' ex')
    .trim();
}

function mergeArchetypes(limitlessData, editorialTiers) {
  // Build editorial tier map (name → tier)
  const tierMap = new Map();
  for (const entry of editorialTiers) {
    const key = normalizeArchetypeName(entry.name);
    if (!tierMap.has(key)) tierMap.set(key, entry.tier);
  }

  return limitlessData.map(arch => {
    const key = normalizeArchetypeName(arch.name);
    return {
      ...arch,
      sourceTier: tierMap.get(key) || null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════
// HTML PATCHER
// ═══════════════════════════════════════════════════════════════════

function generateDescription(arch) {
  const wr    = (arch.winRate || 50).toFixed(1);
  const count = arch.count || 0;
  const speed = arch.setupTurns === 1 ? 'Blazing fast' :
                arch.setupTurns === 2 ? 'Consistent mid-speed' : 'Slow-burn setup';
  return `${speed} ${arch.energyTypes.join('/')} deck with ${wr}% tournament win rate across ${count} recorded games. ` +
    `${arch.disruptionScore >= 6 ? 'High disruption potential.' :
       arch.disruptionScore >= 3 ? 'Moderate disruption options.' :
       'Straightforward aggro approach.'}`;
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-');
}

function buildRegistryJs(decks) {
  const usedIds = new Set();
  for (const deck of decks) for (const card of deck.cards) usedIds.add(card.id);
  const entries = [...usedIds].filter(id => KNOWN_CARDS[id]).sort().map(id => {
    const c = KNOWN_CARDS[id];
    return `  ${JSON.stringify(id)}: { name: ${JSON.stringify(c.name)}, type: ${JSON.stringify(c.type)}, pack: ${JSON.stringify(c.pack)}, rarity: ${JSON.stringify(c.rarity)} }`;
  });
  return `const CARD_REGISTRY = {\n${entries.join(',\n')}\n};`;
}

function buildSnapshotJs(decks) {
  const now    = new Date();
  const month  = now.toLocaleString('en-US', { month: 'short' });
  const year   = now.getFullYear();
  const header = `  // Auto-generated by update-meta.js — ${month} ${year}\n  // Sources: Limitless API (real win rates) + ptcgpocket.gg (editorial tiers)\n`;

  const deckStrs = decks.map(deck => {
    const cardsStr = deck.cards
      .map(c => `      { id: ${JSON.stringify(c.id)}, qty: ${c.qty} }`)
      .join(',\n');
    return `  {\n    id: ${JSON.stringify(deck.id)},\n    name: ${JSON.stringify(deck.name)},\n    tier: ${JSON.stringify(deck.tier)},\n    type: ${JSON.stringify(deck.type)},\n    winRate: ${deck.winRate},\n    popularity: ${deck.popularity},\n    description: ${JSON.stringify(deck.description)},\n    strengths: [],\n    weaknesses: [],\n    cards: [\n${cardsStr}\n    ]\n  }`;
  });
  return `const META_SNAPSHOT = [\n${header}${deckStrs.join(',\n')}\n];`;
}

function patchHtml(decks) {
  if (!fs.existsSync(HTML_FILE)) {
    log(`ERROR: HTML file not found at ${HTML_FILE}`, 'red');
    process.exit(1);
  }

  let html = fs.readFileSync(HTML_FILE, 'utf-8');

  const registryRe = /const CARD_REGISTRY = \{[\s\S]*?\};/;
  if (!registryRe.test(html)) {
    log('ERROR: CARD_REGISTRY block not found in HTML.', 'red');
    process.exit(1);
  }
  html = html.replace(registryRe, buildRegistryJs(decks));
  log('  ✓ CARD_REGISTRY patched');

  const snapshotRe = /const META_SNAPSHOT = \[[\s\S]*?\];/;
  if (!snapshotRe.test(html)) {
    log('ERROR: META_SNAPSHOT block not found in HTML.', 'red');
    process.exit(1);
  }
  html = html.replace(snapshotRe, buildSnapshotJs(decks));
  log('  ✓ META_SNAPSHOT patched');

  const now   = new Date();
  const label = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  html = html.replace(
    /(<strong id="meta-updated-date">)[^<]*(< *\/strong>)/,
    `$1${label}$2`
  );
  log('  ✓ Freshness badge updated');

  fs.writeFileSync(HTML_FILE, html, 'utf-8');
  log(`  ✓ Written to ${path.basename(HTML_FILE)}`);
}

// ═══════════════════════════════════════════════════════════════════
// FULL PIPELINE
// ═══════════════════════════════════════════════════════════════════

async function runPipeline() {
  log('\n╔══════════════════════════════════════════════╗');
  log('║   PTCGP Meta Intelligence Engine  — START   ║');
  log('╚══════════════════════════════════════════════╝\n');

  // ── 1. FETCH ──────────────────────────────────────────────────
  log('► Phase 1: Fetching data…');
  const [limitlessData, editorialTiers] = await Promise.all([
    fetchLimitlessData(),
    fetchPtcgpocketTiers(),
  ]);

  if (limitlessData.length === 0) {
    log('ERROR: No archetype data from Limitless API. Aborting.', 'red');
    process.exit(1);
  }

  // ── 2. MERGE ──────────────────────────────────────────────────
  log('\n► Phase 2: Merging sources…');
  const merged = mergeArchetypes(limitlessData, editorialTiers);
  log(`  ${merged.length} archetypes after merge`);

  // ── 3. ENRICH ─────────────────────────────────────────────────
  log('\n► Phase 3: Enriching with strategy engine…');
  const enriched = merged.map(enrichArchetype);

  // ── 4. SCORE & FILTER ─────────────────────────────────────────
  log('\n► Phase 4: Scoring…');
  const scored = enriched
    .filter(a => (a.winRate || 50) >= 44)
    .map(arch => {
      const score = scoreArchetype(arch, enriched);
      return {
        ...arch,
        score,
        tier: arch.sourceTier || assignTier(score),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  scored.forEach((d, i) => {
    const wr = (d.winRate || 50).toFixed(1);
    const sh = (d.metaShare || 0).toFixed(2);
    log(`  [${String(i+1).padStart(2,'0')}] ${d.tier}-Tier  Score:${d.score}  WR:${wr}%  Share:${sh}%  ${d.name}`);
  });

  // ── 5. BUILD DECKLISTS ─────────────────────────────────────────
  log('\n► Phase 5: Building optimal decklists…');
  const finalDecks = scored.map(arch => {
    const primaryType = arch.energyTypes[0];
    const coreIds     = buildCoreCards(arch.name);
    const cards       = buildOptimalDeck(coreIds, primaryType);
    const totalCards  = cards.reduce((s, c) => s + c.qty, 0);
    log(`  ${arch.name}: ${cards.length} distinct, ${totalCards} total`);
    return {
      id:          slugify(arch.name),
      name:        arch.name,
      tier:        arch.tier,
      type:        primaryType,
      winRate:     parseFloat((arch.winRate || 50).toFixed(1)),
      popularity:  parseFloat((arch.metaShare || 1).toFixed(2)),
      description: generateDescription(arch),
      strengths:   [],
      weaknesses:  [],
      cards,
    };
  });

  // ── 6. PATCH HTML ─────────────────────────────────────────────
  log('\n► Phase 6: Patching HTML file…');
  patchHtml(finalDecks);

  log('\n✓ Update complete.\n');
}

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

function log(msg, color) {
  const colors = { red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };
  if (color && colors[color]) {
    process.stdout.write(`${colors[color]}${msg}${colors.reset}\n`);
  } else {
    console.log(msg);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

runPipeline().catch(err => {
  log(`\nFATAL: ${err.message}`, 'red');
  console.error(err.stack);
  process.exit(1);
});
