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

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execFile }   = require('child_process');

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

// Full card database source (flibustier/pokemon-tcg-pocket-database)
const CARDS_DB_URL = 'https://raw.githubusercontent.com/flibustier/pokemon-tcg-pocket-database/main/dist/cards.json';
const SETS_DB_URL  = 'https://raw.githubusercontent.com/flibustier/pokemon-tcg-pocket-database/main/dist/sets.json';

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
 *
 * Improvements over v1:
 *  - Win-rate normalised against real dataset min/max (no hardcoded floor)
 *  - Confidence penalty (-15%) for archetypes with fewer than 30 appearances
 *  - Recency boost applied to meta-share component when an archetype has
 *    disproportionate representation in the last-14-days window
 */
function scoreArchetype(archetype, allDecks) {
  // Real dataset bounds — avoids the hardcoded 45% floor bias
  const winRates = allDecks.map(d => d.winRate || 50).filter(Number.isFinite);
  const minWR    = Math.min(...winRates);
  const maxWR    = Math.max(...winRates);
  const maxShare = Math.max(...allDecks.map(d => d.metaShare || 0), 0.001);

  // 1. Win-rate component (0–40) — normalised against real range
  const wrRange = maxWR - minWR;
  const wrNorm  = wrRange > 0
    ? Math.min((archetype.winRate - minWR) / wrRange, 1)
    : 0.5;
  const wrScore = Math.max(wrNorm * 40, 0);

  // 2. Meta-share (log-weighted, 0–20) + optional recency boost
  //    recencyBoost = weightedAppearances / appearances (>1 if deck is hotter lately)
  const shareNorm   = Math.log10((archetype.metaShare || 0) + 1) /
                      Math.log10(maxShare + 1);
  const recencyMul  = Math.min(archetype.recencyBoost || 1.0, 1.5); // cap at 1.5
  const shareScore  = Math.min(shareNorm * recencyMul * 20, 20);

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

  let total = wrScore + shareScore + typeScore + evoScore + setupScore + dispScore;

  // 7. Confidence multiplier — penalise thin sample sizes
  if ((archetype.count || 0) < 30) total *= 0.85;

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
  // A3 Celestial Guardians
  "A3-074":  { name: "Shuppet",             type: "Psychic",   pack: "Celestial Guardians", rarity: "C"  },
  "A3-075":  { name: "Banette",             type: "Psychic",   pack: "Celestial Guardians", rarity: "U"  },
  // A4a Secluded Springs
  "A4a-020": { name: "Suicune ex",          type: "Water",     pack: "Secluded Springs",    rarity: "EX" },
  // B1 Mega Rising (additional)
  "B1-092":  { name: "Joltik",              type: "Lightning", pack: "Mega Rising",         rarity: "C"  },
  "B1-093":  { name: "Galvantula",          type: "Lightning", pack: "Mega Rising",         rarity: "U"  },
  "B1-304":  { name: "Zeraora",             type: "Lightning", pack: "Mega Rising",         rarity: "EX" },
  // B1a Crimson Blaze (additional)
  "B1a-096": { name: "Type: Null",          type: "Colorless", pack: "Crimson Blaze",       rarity: "EX" },
  // B2a Paldean Wonders
  "B2a-034": { name: "Frigibax",            type: "Water",     pack: "Paldean Wonders",     rarity: "C"  },
  "B2a-035": { name: "Arctibax",            type: "Water",     pack: "Paldean Wonders",     rarity: "U"  },
  "B2a-036": { name: "Baxcalibur",          type: "Water",     pack: "Paldean Wonders",     rarity: "R"  },
  "B2a-041": { name: "Tadbulb",             type: "Lightning", pack: "Paldean Wonders",     rarity: "C"  },
  "B2a-042": { name: "Bellibolt ex",        type: "Lightning", pack: "Paldean Wonders",     rarity: "EX" },
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

  // Generic filler pool — add in order until deck reaches 20
  // These are universally playable cards with no type restriction
  const FILLER_POOL = [
    "P-A-006",  // Red Card  — disruptive in any deck
    "A1-223",   // Giovanni  — +10 damage
    "A1-220",   // Misty     — energy acceleration
    "B1-109",   // Chingling — bench disruption
    "A3-034",   // Oricorio  — damage chip
    "A1-225",   // Sabrina   — retreat / switch
    "B2-191",   // Sightseer — draw
    "B1-225",   // Copycat   — draw
  ];
  for (const fillId of FILLER_POOL) {
    if (totalQty() >= 20) break;
    const have = deck[fillId] || 0;
    if (have < 2) addCard(fillId, Math.min(2 - have, 20 - totalQty()));
  }

  const result = Object.entries(deck)
    .filter(([id]) => KNOWN_CARDS[id])
    .map(([id, qty]) => ({ id, qty }));

  const total = result.reduce((s, c) => s + c.qty, 0);
  if (total !== 20) {
    log(`WARN: Deck for type ${type} has ${total} cards, not 20.`, 'yellow');
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// LIMITLESS API FETCHER
// Aggregates win rates + meta share from real player records
// No API key required for /tournaments and /standings endpoints
// ═══════════════════════════════════════════════════════════════════

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
// FULL CARD DATABASE FETCHER
// Fetches flibustier/pokemon-tcg-pocket-database and normalises to
// our internal shape.  Falls back to KNOWN_CARDS if fetch fails.
// ═══════════════════════════════════════════════════════════════════

function _normalizeRarity(raw) {
  if (!raw) return 'C';
  const r = String(raw).toLowerCase().replace(/\s+/g, '');
  if (r === 'c' || r === 'common')                       return 'C';
  if (r === 'u' || r === 'uncommon')                     return 'U';
  if (r === 'r' || r === 'rare')                         return 'R';
  if (r === 'rr' || r === 'doublerare')                  return 'R';
  // EX-tier bucket: EX, ex, SR, AR, SAR, IM, UR, Crown, Immersive
  if (/^(ex|sr|ar|sar|im|ur|crown|immersive)$/.test(r)) return 'EX';
  if (r === 'pr' || r === 'promo')                       return 'PR';
  return raw; // passthrough for anything not recognised
}

function _normalizeType(raw) {
  if (!raw) return 'Colorless';
  const map = {
    fire:'Fire', water:'Water', grass:'Grass',
    lightning:'Lightning', electric:'Lightning',
    psychic:'Psychic', fighting:'Fighting',
    darkness:'Dark', dark:'Dark',
    metal:'Metal', steel:'Metal',
    dragon:'Dragon', fairy:'Fairy',
    colorless:'Colorless', normal:'Colorless',
    trainer:'Trainer', supporter:'Trainer',
    item:'Trainer', tool:'Trainer', stadium:'Trainer',
  };
  return map[(Array.isArray(raw) ? raw[0] : raw).toLowerCase()] || (Array.isArray(raw) ? raw[0] : raw);
}

// Name-based energy type lookup for databases (like flibustier) that don't include type info.
// Keys are exact English card names as they appear in PTCG Pocket.
const POKEMON_NAME_TYPE_MAP = {
  // ── Grass ──────────────────────────────────────────────────────
  'Bulbasaur':'Grass','Ivysaur':'Grass','Venusaur':'Grass','Venusaur ex':'Grass',
  'Caterpie':'Grass','Metapod':'Grass','Butterfree':'Grass',
  'Weedle':'Grass','Kakuna':'Grass','Beedrill':'Grass','Beedrill ex':'Grass',
  'Oddish':'Grass','Gloom':'Grass','Vileplume':'Grass',
  'Paras':'Grass','Parasect':'Grass',
  'Exeggcute':'Grass','Exeggutor':'Grass','Exeggutor ex':'Grass',
  'Tangela':'Grass','Scyther':'Grass','Pinsir':'Grass',
  'Sunkern':'Grass','Sunflora':'Grass',
  'Chikorita':'Grass','Bayleef':'Grass','Meganium':'Grass',
  'Treecko':'Grass','Grovyle':'Grass','Sceptile':'Grass','Sceptile ex':'Grass',
  'Roselia':'Grass','Roserade':'Grass','Budew':'Grass',
  'Cacnea':'Grass','Cacturne':'Grass',
  'Tropius':'Grass',
  'Turtwig':'Grass','Grotle':'Grass','Torterra':'Grass','Torterra ex':'Grass',
  'Cherubi':'Grass','Cherrim':'Grass',
  'Snover':'Grass','Abomasnow':'Grass','Abomasnow ex':'Grass',
  'Sewaddle':'Grass','Swadloon':'Grass','Leavanny':'Grass',
  'Petilil':'Grass','Lilligant':'Grass',
  'Maractus':'Grass',
  'Foongus':'Grass','Amoonguss':'Grass',
  'Ferroseed':'Metal','Ferrothorn':'Metal',
  'Chespin':'Grass','Quilladin':'Grass','Chesnaught':'Grass','Chesnaught ex':'Grass',
  'Skiddo':'Grass','Gogoat':'Grass',
  'Rowlet':'Grass','Dartrix':'Grass','Decidueye':'Grass','Decidueye ex':'Grass',
  'Bounsweet':'Grass','Steenee':'Grass','Tsareena':'Grass',
  'Fomantis':'Grass','Lurantis':'Grass',
  'Kartana':'Grass',
  'Grookey':'Grass','Thwackey':'Grass','Rillaboom':'Grass','Rillaboom ex':'Grass',
  'Gossifleur':'Grass','Eldegoss':'Grass',
  'Zarude':'Grass',
  'Sprigatito':'Grass','Floragato':'Grass','Meowscarada':'Grass','Meowscarada ex':'Grass',
  'Smoliv':'Grass','Dolliv':'Grass','Arboliva':'Grass',
  'Capsakid':'Grass','Scovillain':'Grass',
  'Tarountula':'Grass','Spidops':'Grass',
  'Toedscool':'Grass','Toedscruel':'Grass',
  'Bramblin':'Grass','Brambleghast':'Grass',
  'Nymble':'Grass',
  // ── Fire ───────────────────────────────────────────────────────
  'Charmander':'Fire','Charmeleon':'Fire','Charizard':'Fire','Charizard ex':'Fire',
  'Vulpix':'Fire','Ninetales':'Fire',
  'Growlithe':'Fire','Arcanine':'Fire','Arcanine ex':'Fire',
  'Ponyta':'Fire','Rapidash':'Fire',
  'Magmar':'Fire','Magby':'Fire','Magmortar':'Fire',
  'Flareon':'Fire',
  'Moltres':'Fire','Moltres ex':'Fire',
  'Cyndaquil':'Fire','Quilava':'Fire','Typhlosion':'Fire','Typhlosion ex':'Fire',
  'Slugma':'Fire','Magcargo':'Fire',
  'Houndour':'Fire','Houndoom':'Fire','Houndoom ex':'Fire',
  'Entei':'Fire',
  'Torchic':'Fire','Combusken':'Fire','Blaziken':'Fire','Blaziken ex':'Fire',
  'Numel':'Fire','Camerupt':'Fire',
  'Torkoal':'Fire',
  'Chimchar':'Fire','Monferno':'Fire','Infernape':'Fire','Infernape ex':'Fire',
  'Tepig':'Fire','Pignite':'Fire','Emboar':'Fire','Emboar ex':'Fire',
  'Pansear':'Fire','Simisear':'Fire',
  'Darumaka':'Fire','Darmanitan':'Fire',
  'Litwick':'Fire','Lampent':'Fire','Chandelure':'Fire',
  'Fennekin':'Fire','Braixen':'Fire','Delphox':'Fire','Delphox ex':'Fire',
  'Fletchinder':'Fire','Talonflame':'Fire','Fletchling':'Fire',
  'Litleo':'Fire','Pyroar':'Fire',
  'Volcanion':'Fire',
  'Litten':'Fire','Torracat':'Fire','Incineroar':'Fire','Incineroar ex':'Fire',
  'Salandit':'Fire','Salazzle':'Fire','Salazzle ex':'Fire',
  'Turtonator':'Fire',
  'Scorbunny':'Fire','Raboot':'Fire','Cinderace':'Fire','Cinderace ex':'Fire',
  'Sizzlipede':'Fire','Centiskorch':'Fire',
  'Fuecoco':'Fire','Crocalor':'Fire','Skeledirge':'Fire','Skeledirge ex':'Fire',
  'Charcadet':'Fire','Armarouge':'Fire','Ceruledge':'Fire',
  'Mega Blaziken ex':'Fire',
  // ── Water ──────────────────────────────────────────────────────
  'Squirtle':'Water','Wartortle':'Water','Blastoise':'Water','Blastoise ex':'Water',
  'Psyduck':'Water','Golduck':'Water',
  'Poliwag':'Water','Poliwhirl':'Water','Poliwrath':'Water',
  'Tentacool':'Water','Tentacruel':'Water',
  'Slowpoke':'Water','Slowbro':'Water','Slowbro ex':'Water','Slowking':'Water',
  'Seel':'Water','Dewgong':'Water',
  'Shellder':'Water','Cloyster':'Water',
  'Krabby':'Water','Kingler':'Water',
  'Horsea':'Water','Seadra':'Water','Kingdra':'Water','Kingdra ex':'Water',
  'Staryu':'Water','Starmie':'Water',
  'Magikarp':'Water','Gyarados':'Water','Gyarados ex':'Water',
  'Lapras':'Water',
  'Vaporeon':'Water',
  'Omanyte':'Water','Omastar':'Water',
  'Kabuto':'Water','Kabutops':'Water',
  'Articuno':'Water','Articuno ex':'Water',
  'Totodile':'Water','Croconaw':'Water','Feraligatr':'Water',
  'Marill':'Psychic','Azumarill':'Psychic',
  'Wooper':'Water','Quagsire':'Water',
  'Corsola':'Water',
  'Remoraid':'Water','Octillery':'Water',
  'Mantine':'Water','Mantyke':'Water',
  'Suicune':'Water',
  'Mudkip':'Water','Marshtomp':'Water','Swampert':'Water','Swampert ex':'Water',
  'Lotad':'Water','Lombre':'Water','Ludicolo':'Water',
  'Surskit':'Water','Masquerain':'Water',
  'Corphish':'Water','Crawdaunt':'Water',
  'Feebas':'Water','Milotic':'Water',
  'Spheal':'Water','Sealeo':'Water','Walrein':'Water',
  'Clamperl':'Water','Huntail':'Water','Gorebyss':'Water',
  'Luvdisc':'Water',
  'Kyogre':'Water','Kyogre ex':'Water',
  'Piplup':'Water','Prinplup':'Water','Empoleon':'Water','Empoleon ex':'Water',
  'Buizel':'Water','Floatzel':'Water',
  'Shellos':'Water','Gastrodon':'Water',
  'Finneon':'Water','Lumineon':'Water',
  'Froakie':'Water','Frogadier':'Water','Greninja':'Water','Greninja ex':'Water',
  'Clauncher':'Water','Clawitzer':'Water',
  'Bergmite':'Water','Avalugg':'Water',
  'Popplio':'Water','Brionne':'Water','Primarina':'Water','Primarina ex':'Water',
  'Dewpider':'Water','Araquanid':'Water',
  'Wishiwashi':'Water',
  'Bruxish':'Water',
  'Sobble':'Water','Drizzile':'Water','Inteleon':'Water','Inteleon ex':'Water',
  'Chewtle':'Water','Drednaw':'Water',
  'Cramorant':'Water',
  'Arrokuda':'Water','Barraskewda':'Water',
  'Wailmer':'Water','Wailord':'Water',
  'Quaxly':'Water','Quaxwell':'Water','Quaquaval':'Water','Quaquaval ex':'Water',
  'Veluza':'Water','Dondozo':'Water',
  'Cetoddle':'Water','Cetitan':'Water',
  'Mega Greninja ex':'Water',
  // ── Lightning ──────────────────────────────────────────────────
  'Pikachu':'Lightning','Raichu':'Lightning','Raichu ex':'Lightning',
  'Pichu':'Lightning',
  'Magnemite':'Lightning','Magneton':'Lightning','Magnezone':'Lightning','Magnezone ex':'Lightning',
  'Voltorb':'Lightning','Electrode':'Lightning',
  'Electabuzz':'Lightning','Elekid':'Lightning','Electivire':'Lightning',
  'Jolteon':'Lightning',
  'Zapdos':'Lightning','Zapdos ex':'Lightning',
  'Mareep':'Lightning','Flaaffy':'Lightning','Ampharos':'Lightning','Ampharos ex':'Lightning',
  'Raikou':'Lightning',
  'Plusle':'Lightning','Minun':'Lightning',
  'Electrike':'Lightning','Manectric':'Lightning','Mega Manectric ex':'Lightning',
  'Shinx':'Lightning','Luxio':'Lightning','Luxray':'Lightning','Luxray ex':'Lightning',
  'Pachirisu':'Lightning',
  'Rotom':'Lightning',
  'Joltik':'Lightning','Galvantula':'Lightning',
  'Emolga':'Lightning',
  'Tynamo':'Lightning','Eelektrik':'Lightning','Eelektross':'Lightning',
  'Helioptile':'Lightning','Heliolisk':'Lightning',
  'Dedenne':'Lightning',
  'Charjabug':'Lightning','Vikavolt':'Lightning','Grubbin':'Lightning',
  'Togedemaru':'Lightning',
  'Xurkitree':'Lightning',
  'Morpeko':'Lightning',
  'Yamper':'Lightning','Boltund':'Lightning',
  'Toxel':'Lightning','Toxtricity':'Lightning','Toxtricity ex':'Lightning',
  'Regieleki':'Lightning',
  'Pawmi':'Lightning','Pawmo':'Lightning','Pawmot':'Lightning',
  'Tadbulb':'Lightning','Bellibolt':'Lightning',
  'Wattrel':'Lightning','Kilowattrel':'Lightning',
  // ── Psychic ────────────────────────────────────────────────────
  'Abra':'Psychic','Kadabra':'Psychic','Alakazam':'Psychic','Alakazam ex':'Psychic',
  'Gastly':'Psychic','Haunter':'Psychic','Gengar':'Psychic','Gengar ex':'Psychic',
  'Drowzee':'Psychic','Hypno':'Psychic',
  'Mr. Mime':'Psychic','Mr. Mime ex':'Psychic',
  'Jynx':'Psychic',
  'Mewtwo':'Psychic','Mewtwo ex':'Psychic',
  'Mew':'Psychic','Mew ex':'Psychic',
  'Espeon':'Psychic',
  'Wobbuffet':'Psychic','Wynaut':'Psychic',
  'Natu':'Psychic','Xatu':'Psychic',
  'Misdreavus':'Psychic','Mismagius':'Psychic',
  'Ralts':'Psychic','Kirlia':'Psychic','Gardevoir':'Psychic','Gardevoir ex':'Psychic','Gallade':'Psychic',
  'Mega Gardevoir ex':'Psychic',
  'Spoink':'Psychic','Grumpig':'Psychic',
  'Lunatone':'Psychic',
  'Baltoy':'Psychic','Claydol':'Psychic',
  'Duskull':'Psychic','Dusclops':'Psychic','Dusknoir':'Psychic',
  'Chimecho':'Psychic',
  'Latias':'Psychic','Latios':'Psychic',
  'Jirachi':'Psychic',
  'Deoxys':'Psychic',
  'Mime Jr.':'Psychic',
  'Drifloon':'Psychic','Drifblim':'Psychic',
  'Spiritomb':'Psychic',
  'Munna':'Psychic','Musharna':'Psychic',
  'Gothita':'Psychic','Gothorita':'Psychic','Gothitelle':'Psychic',
  'Solosis':'Psychic','Duosion':'Psychic','Reuniclus':'Psychic',
  'Elgyem':'Psychic','Beheeyem':'Psychic',
  'Frillish':'Psychic','Jellicent':'Psychic',
  'Sigilyph':'Psychic',
  'Yamask':'Psychic','Cofagrigus':'Psychic',
  'Inkay':'Psychic','Malamar':'Psychic',
  'Espurr':'Psychic','Meowstic':'Psychic',
  'Phantump':'Psychic','Trevenant':'Psychic',
  'Pumpkaboo':'Psychic','Gourgeist':'Psychic',
  'Hoopa':'Psychic',
  'Oricorio':'Psychic',
  'Mimikyu':'Psychic','Mimikyu ex':'Psychic',
  'Oranguru':'Psychic',
  'Dhelmise':'Psychic',
  'Tapu Lele':'Psychic',
  'Necrozma':'Psychic',
  'Galarian Corsola':'Psychic','Cursola':'Psychic',
  'Hatenna':'Psychic','Hattrem':'Psychic','Hatterene':'Psychic','Hatterene ex':'Psychic',
  'Sinistea':'Psychic','Polteageist':'Psychic',
  'Indeedee':'Psychic',
  'Blacephalon':'Psychic',
  'Eternatus':'Psychic',
  'Flittle':'Psychic','Espathra':'Psychic',
  'Rabsca':'Psychic',
  'Greavard':'Psychic','Houndstone':'Psychic',
  'Meloetta':'Psychic',
  'Shuppet':'Psychic','Banette':'Psychic',
  // ── Fighting ───────────────────────────────────────────────────
  'Sandshrew':'Fighting','Sandslash':'Fighting',
  'Diglett':'Fighting','Dugtrio':'Fighting',
  'Mankey':'Fighting','Primeape':'Fighting','Annihilape':'Fighting',
  'Machop':'Fighting','Machoke':'Fighting','Machamp':'Fighting','Machamp ex':'Fighting',
  'Geodude':'Fighting','Graveler':'Fighting','Golem':'Fighting',
  'Onix':'Fighting','Steelix':'Metal',
  'Hitmonlee':'Fighting','Hitmonchan':'Fighting','Hitmontop':'Fighting',
  'Cubone':'Fighting','Marowak':'Fighting','Marowak ex':'Fighting',
  'Rhyhorn':'Fighting','Rhydon':'Fighting','Rhyperior':'Fighting',
  'Heracross':'Fighting','Heracross ex':'Fighting',
  'Larvitar':'Fighting','Pupitar':'Fighting','Tyranitar':'Fighting','Tyranitar ex':'Fighting',
  'Makuhita':'Fighting','Hariyama':'Fighting',
  'Nosepass':'Fighting','Probopass':'Metal',
  'Meditite':'Fighting','Medicham':'Fighting',
  'Trapinch':'Fighting',
  'Regirock':'Fighting',
  'Lucario':'Fighting','Lucario ex':'Fighting','Riolu':'Fighting',
  'Croagunk':'Fighting','Toxicroak':'Fighting',
  'Hippopotas':'Fighting','Hippowdon':'Fighting',
  'Bonsly':'Fighting',
  'Drilbur':'Fighting','Excadrill':'Fighting',
  'Timburr':'Fighting','Gurdurr':'Fighting','Conkeldurr':'Fighting',
  'Roggenrola':'Fighting','Boldore':'Fighting','Gigalith':'Fighting',
  'Archen':'Fighting','Archeops':'Fighting',
  'Throh':'Fighting','Sawk':'Fighting',
  'Mienfoo':'Fighting','Mienshao':'Fighting',
  'Golett':'Fighting','Golurk':'Fighting',
  'Landorus':'Fighting',
  'Pancham':'Fighting',
  'Rockruff':'Fighting','Lycanroc':'Fighting','Lycanroc ex':'Fighting',
  'Passimian':'Fighting',
  'Stufful':'Fighting','Bewear':'Fighting',
  'Crabrawler':'Fighting','Crabominable':'Fighting',
  'Mudbray':'Fighting','Mudsdale':'Fighting',
  'Marshadow':'Fighting',
  'Clobbopus':'Fighting','Grapploct':'Fighting',
  'Falinks':'Fighting',
  'Stonjourner':'Fighting',
  'Kubfu':'Fighting','Urshifu':'Fighting','Urshifu ex':'Fighting',
  'Flamigo':'Fighting',
  'Nacli':'Fighting','Naclstack':'Fighting','Garganacl':'Fighting',
  'Klawf':'Fighting',
  'Koraidon':'Fighting',
  'Regigigas':'Colorless',
  // ── Dark ───────────────────────────────────────────────────────
  'Umbreon':'Dark',
  'Murkrow':'Dark','Honchkrow':'Dark',
  'Sneasel':'Dark','Weavile':'Dark','Weavile ex':'Dark',
  'Houndour':'Dark','Houndoom':'Dark',
  'Poochyena':'Dark','Mightyena':'Dark',
  'Nuzleaf':'Dark','Shiftry':'Dark',
  'Sableye':'Dark',
  'Carvanha':'Dark','Sharpedo':'Dark',
  'Absol':'Dark',
  'Stunky':'Dark','Skuntank':'Dark',
  'Drapion':'Dark',
  'Purrloin':'Dark','Liepard':'Dark',
  'Sandile':'Dark','Krokorok':'Dark','Krookodile':'Dark',
  'Scraggy':'Dark','Scrafty':'Dark',
  'Zorua':'Dark','Zoroark':'Dark',
  'Vullaby':'Dark','Mandibuzz':'Dark',
  'Pawniard':'Dark','Bisharp':'Dark','Kingambit':'Dark',
  'Galarian Zigzagoon':'Dark','Galarian Linoone':'Dark','Galarian Obstagoon':'Dark',
  'Obstagoon':'Dark',
  'Impidimp':'Dark','Morgrem':'Dark','Grimmsnarl':'Dark','Grimmsnarl ex':'Dark',
  'Nickit':'Dark','Thievul':'Dark',
  'Pangoro':'Dark',
  'Lokix':'Dark',
  'Maschiff':'Dark','Mabosstiff':'Dark',
  'Shroodle':'Psychic','Grafaiai':'Psychic',
  // ── Metal ──────────────────────────────────────────────────────
  'Scizor':'Metal','Scizor ex':'Metal','Mega Scizor ex':'Metal',
  'Forretress':'Metal',
  'Skarmory':'Metal','Skarmory ex':'Metal',
  'Aron':'Metal','Lairon':'Metal','Aggron':'Metal','Mega Aggron ex':'Metal',
  'Mawile':'Metal',
  'Beldum':'Metal','Metang':'Metal','Metagross':'Metal','Metagross ex':'Metal',
  'Registeel':'Metal',
  'Bronzor':'Metal','Bronzong':'Metal',
  'Bastiodon':'Metal',
  'Dialga':'Metal','Dialga ex':'Metal',
  'Klink':'Metal','Klang':'Metal','Klinklang':'Metal',
  'Cobalion':'Metal',
  'Durant':'Metal',
  'Escavalier':'Metal',
  'Honedge':'Metal','Doublade':'Metal','Aegislash':'Metal',
  'Klefki':'Metal',
  'Genesect':'Metal',
  'Celesteela':'Metal',
  'Meltan':'Metal','Melmetal':'Metal',
  'Rookidee':'Metal','Corvisquire':'Metal','Corviknight':'Metal',
  'Perrserker':'Metal',
  'Copperajah':'Metal',
  'Duraludon':'Metal','Duraludon ex':'Metal','Archaludon':'Metal',
  'Orthworm':'Metal',
  'Varoom':'Metal','Revavroom':'Metal',
  'Gimmighoul':'Metal','Gholdengo':'Metal','Gholdengo ex':'Metal',
  'Tinkatink':'Metal','Tinkatuff':'Metal','Tinkaton':'Metal',
  // ── Dragon ─────────────────────────────────────────────────────
  'Dratini':'Dragon','Dragonair':'Dragon','Dragonite':'Dragon','Dragonite ex':'Dragon',
  'Vibrava':'Dragon','Flygon':'Dragon',
  'Swablu':'Dragon','Altaria':'Dragon','Mega Altaria ex':'Dragon',
  'Bagon':'Dragon','Shelgon':'Dragon','Salamence':'Dragon','Salamence ex':'Dragon',
  'Latias ex':'Dragon','Latios ex':'Dragon',
  'Rayquaza':'Dragon','Rayquaza ex':'Dragon',
  'Gible':'Dragon','Gabite':'Dragon','Garchomp':'Dragon','Garchomp ex':'Dragon',
  'Axew':'Dragon','Fraxure':'Dragon','Haxorus':'Dragon',
  'Druddigon':'Dragon',
  'Deino':'Dragon','Zweilous':'Dragon','Hydreigon':'Dragon','Hydreigon ex':'Dragon',
  'Reshiram':'Dragon','Reshiram ex':'Dragon',
  'Zekrom':'Dragon','Zekrom ex':'Dragon',
  'Kyurem':'Dragon','Kyurem ex':'Dragon',
  'Goomy':'Dragon','Sliggoo':'Dragon','Goodra':'Dragon','Goodra ex':'Dragon',
  'Noibat':'Dragon','Noivern':'Dragon','Noivern ex':'Dragon',
  'Tyrunt':'Dragon','Tyrantrum':'Dragon',
  'Jangmo-o':'Dragon','Hakamo-o':'Dragon','Kommo-o':'Dragon','Kommo-o ex':'Dragon',
  'Applin':'Dragon','Flapple':'Dragon','Appletun':'Dragon','Dipplin':'Dragon','Hydrapple':'Dragon',
  'Drampa':'Dragon',
  'Dreepy':'Dragon','Drakloak':'Dragon','Dragapult':'Dragon','Dragapult ex':'Dragon',
  'Regidrago':'Dragon',
  'Frigibax':'Dragon','Arctibax':'Dragon','Baxcalibur':'Dragon',
  'Cyclizar':'Dragon',
  'Tatsugiri':'Dragon',
  'Miraidon':'Dragon','Miraidon ex':'Dragon',
  'Roaring Moon':'Dragon',
  'Skrelp':'Dragon','Dragalge':'Dragon',
  // ── Colorless ──────────────────────────────────────────────────
  'Pidgey':'Colorless','Pidgeotto':'Colorless','Pidgeot':'Colorless','Pidgeot ex':'Colorless',
  'Rattata':'Colorless','Raticate':'Colorless',
  'Spearow':'Colorless','Fearow':'Colorless',
  'Clefairy':'Psychic','Clefable':'Psychic','Cleffa':'Psychic',
  'Jigglypuff':'Psychic','Wigglytuff':'Psychic','Wigglytuff ex':'Psychic',
  'Meowth':'Colorless','Persian':'Colorless',
  "Farfetch'd":'Colorless',
  'Doduo':'Colorless','Dodrio':'Colorless',
  'Chansey':'Colorless','Blissey':'Colorless','Happiny':'Colorless',
  'Kangaskhan':'Colorless',
  'Lickitung':'Colorless','Lickilicky':'Colorless',
  'Porygon':'Colorless','Porygon2':'Colorless','Porygon-Z':'Colorless',
  'Eevee':'Colorless',
  'Snorlax':'Colorless','Snorlax ex':'Colorless',
  'Ditto':'Colorless',
  'Togepi':'Psychic','Togetic':'Psychic','Togekiss':'Psychic','Togekiss ex':'Psychic',
  'Aipom':'Colorless','Ambipom':'Colorless',
  'Girafarig':'Colorless',
  'Stantler':'Colorless',
  'Smeargle':'Colorless',
  'Miltank':'Colorless',
  'Teddiursa':'Colorless','Ursaring':'Colorless',
  'Hoothoot':'Colorless','Noctowl':'Colorless',
  'Sentret':'Colorless','Furret':'Colorless',
  'Zigzagoon':'Colorless','Linoone':'Colorless',
  'Taillow':'Colorless','Swellow':'Colorless',
  'Skitty':'Colorless','Delcatty':'Colorless',
  'Zangoose':'Colorless',
  'Chatot':'Colorless',
  'Buneary':'Colorless','Lopunny':'Colorless',
  'Glameow':'Colorless','Purugly':'Colorless',
  'Starly':'Colorless','Staravia':'Colorless','Staraptor':'Colorless',
  'Type: Null':'Colorless','Silvally':'Colorless',
  'Braviary':'Colorless','Rufflet':'Colorless',
  'Bouffalant':'Colorless',
  'Audino':'Colorless',
  'Patrat':'Colorless','Watchog':'Colorless',
  'Bunnelby':'Colorless','Diggersby':'Colorless',
  'Komala':'Colorless',
  'Drampa':'Dragon',
  'Skwovet':'Colorless','Greedent':'Colorless',
  'Wooloo':'Colorless','Dubwool':'Colorless',
  'Tandemaus':'Colorless','Maushold':'Colorless',
  'Lechonk':'Colorless','Oinkologne':'Colorless',
  'Dudunsparce':'Colorless','Dunsparce':'Colorless',
  'Regigigas':'Colorless',
  // ── Legendaries / misc ─────────────────────────────────────────
  'Lugia':'Colorless','Lugia ex':'Colorless',
  'Ho-Oh':'Fire','Ho-Oh ex':'Fire',
  'Celebi':'Grass','Celebi ex':'Grass',
  'Shaymin':'Grass',
  'Arceus':'Colorless','Arceus ex':'Colorless',
  'Victini':'Fire',
  'Keldeo':'Water',
  'Genesect ex':'Metal',
  'Zygarde':'Fighting',
  'Diancie':'Fighting',
  'Volcanion ex':'Fire',
  'Marshadow ex':'Fighting',
  'Zeraora':'Lightning','Zeraora ex':'Lightning',
  'Magearna':'Metal',
  'Necrozma ex':'Psychic',
  'Poipole':'Psychic','Naganadel':'Dragon','Naganadel ex':'Dragon',
  'Buzzwole':'Fighting',
  'Kartana ex':'Grass',
  'Nihilego':'Psychic',
  'Pheromosa':'Fighting',
  'Cosmog':'Psychic','Cosmoem':'Psychic','Solgaleo':'Metal','Lunala':'Psychic',
  'Tapu Koko':'Lightning','Tapu Bulu':'Grass','Tapu Fini':'Water','Tapu Lele ex':'Psychic',
  'Zacian':'Metal','Zamazenta':'Fighting',
  'Calyrex':'Psychic',
  'Glastrier':'Water','Spectrier':'Psychic',
  'Urshifu Single Strike':'Dark','Urshifu Rapid Strike':'Fighting',
  'Enamorus':'Psychic',
  'Ting-Lu':'Fighting','Chien-Pao':'Water','Wo-Chien':'Grass','Chi-Yu':'Fire',
  'Koraidon ex':'Fighting','Miraidon ex':'Dragon',
  'Ogerpon':'Grass','Ogerpon ex':'Grass',
  'Terapagos':'Colorless',
  'Pecharunt':'Psychic',
  'Munkidori':'Psychic',
  'Fezandipiti':'Psychic',
  // ── Comprehensive corrections (Alolan/Galarian/Paldean forms & regional variants) ──
  // → Grass
  'Bellossom':'Grass','Breloom':'Grass','Carnivine':'Grass',
  'Hoppip':'Grass','Jumpluff':'Grass','Jumpluff ex':'Grass',
  'Karrablast':'Metal','Leafeon':'Grass','Leafeon ex':'Grass',
  'Morelull':'Psychic','Mothim':'Grass','Mow Rotom':'Grass',
  'Pansage':'Grass','Scatterbug':'Grass','Seedot':'Grass',
  'Serperior':'Grass','Servine':'Grass','Shiinotic':'Psychic',
  'Shroomish':'Grass','Simisage':'Grass','Skiploom':'Grass',
  'Snivy':'Grass','Spewpa':'Grass','Tangrowth':'Grass',
  'Teal Mask Ogerpon ex':'Grass','Virizion':'Grass','Vivillon':'Grass',
  'Mega Pinsir ex':'Grass','Mega Venusaur ex':'Grass',
  // Fairy-type Pokémon not listed above -> Psychic in PTCGP
  'Cottonee':'Psychic','Whimsicott':'Psychic','Whimsicott ex':'Psychic',
  'Snubbull':'Psychic','Granbull':'Psychic',
  'Froslass':'Psychic',
  // → Fire
  'Alolan Marowak':'Fire','Carkol':'Fire','Coalossal':'Fire',
  'Heat Rotom':'Fire','Hearthflame Mask Ogerpon':'Fire',
  'Larvesta':'Fire','Mega Charizard Y ex':'Fire',
  'Rolycoly':'Fire','Volcarona':'Fire',
  // → Water
  'Alolan Ninetales':'Water','Alolan Ninetales ex':'Water','Alolan Vulpix':'Water',
  'Alomomola':'Water','Amaura':'Water','Aurorus':'Water',
  'Barboach':'Water','Basculin':'Water','Bibarel':'Water','Bibarel ex':'Water',
  'Binacle':'Water','Barbaracle':'Water','Chinchou':'Water',
  'Eiscue':'Water','Finizen':'Water','Frost Rotom':'Water',
  'Glaceon':'Water','Glaceon ex':'Water','Golisopod':'Water',
  'Lanturn ex':'Water','Manaphy':'Water',
  'Mega Blastoise ex':'Water','Mega Gyarados ex':'Dark',
  'Mega Swampert ex':'Water','Palafin':'Water','Panpour':'Water',
  'Phione':'Water','Politoed':'Water','Palpitoad':'Water',
  'Qwilfish':'Water','Relicanth':'Water','Seismitoad':'Water',
  'Simipour':'Water','Tympole':'Water','Tirtouga':'Water',
  'Wash Rotom':'Water','Wellspring Mask Ogerpon':'Water',
  'Whiscash':'Water','Wiglett':'Water','Wimpod':'Water',
  'Wugtrio':'Water','Wugtrio ex':'Water',
  // → Lightning
  'Alolan Geodude':'Lightning','Alolan Golem':'Lightning','Alolan Graveler':'Lightning',
  'Alolan Raichu':'Lightning','Alolan Raichu ex':'Lightning',
  'Fan Rotom':'Lightning','Mega Ampharos ex':'Lightning','Stunfisk':'Lightning',
  // → Psychic
  'Alcremie':'Psychic','Aromatisse':'Psychic','Azelf':'Psychic',
  'Chingling':'Psychic','Comfey':'Psychic',
  'Cresselia':'Psychic','Cresselia ex':'Psychic','Cutiefly':'Psychic',
  'Dawn Wings Necrozma':'Psychic',
  'Flabébé':'Psychic','Floette':'Psychic','Florges':'Psychic',
  'Galarian Cursola':'Psychic','Galarian Mr. Mime':'Psychic','Galarian Mr. Rime':'Psychic',
  'Galarian Ponyta':'Psychic','Galarian Rapidash':'Psychic',
  'Giratina':'Psychic','Giratina ex':'Psychic',
  'Lunala ex':'Psychic','Mesprit':'Psychic','Milcery':'Psychic',
  'Paldean Clodsire':'Psychic','Paldean Clodsire ex':'Psychic','Paldean Wooper':'Psychic',
  'Palossand':'Psychic','Rellor':'Psychic','Ribombee':'Psychic',
  'Sandygast':'Psychic','Scolipede':'Psychic','Seviper':'Psychic',
  'Slurpuff':'Psychic','Solrock':'Psychic','Spritzee':'Psychic',
  'Swirlix':'Psychic','Sylveon':'Psychic','Sylveon ex':'Psychic',
  'Unown':'Psychic','Uxie':'Psychic',
  'Venipede':'Psychic','Whirlipede':'Psychic','Xerneas':'Psychic',
  // → Fighting
  'Aerodactyl':'Fighting','Aerodactyl ex':'Fighting',
  'Carbink':'Psychic','Cornerstone Mask Ogerpon':'Fighting',
  'Cranidos':'Fighting','Crustle':'Fighting',
  'Donphan':'Fighting','Donphan ex':'Fighting','Dwebble':'Fighting',
  'Gligar':'Fighting','Gliscor':'Fighting','Hawlucha':'Fighting',
  'Mega Medicham ex':'Fighting','Minior':'Fighting',
  'Paldean Tauros':'Fighting','Phanpy':'Fighting',
  'Rampardos':'Fighting','Shuckle':'Fighting','Shuckle ex':'Fighting',
  'Sudowoodo':'Fighting','Terrakion':'Fighting','Tyrogue':'Fighting',
  // → Dark
  'Alolan Grimer':'Dark','Alolan Meowth':'Dark','Alolan Muk':'Dark',
  'Alolan Muk ex':'Dark','Alolan Persian':'Dark','Alolan Raticate':'Dark',
  'Alolan Rattata':'Dark','Bombirdier':'Dark',
  'Darkrai':'Dark','Darkrai ex':'Dark',
  'Guzzlord':'Dark','Guzzlord ex':'Dark',
  'Mega Absol ex':'Dark','Yveltal':'Dark',
  // → Metal
  'Alolan Diglett':'Metal','Alolan Dugtrio':'Metal','Alolan Dugtrio ex':'Metal',
  'Alolan Sandshrew':'Metal','Alolan Sandslash':'Metal',
  'Dusk Mane Necrozma':'Metal','Galarian Meowth':'Metal','Galarian Perrserker':'Metal',
  'Galarian Stunfisk':'Metal','Heatran':'Metal',
  'Mega Mawile ex':'Metal','Mega Steelix ex':'Metal',
  'Shieldon':'Metal','Stakataka':'Metal',
  // → Dragon
  'Alolan Exeggutor':'Dragon','Mega Latios ex':'Dragon',
  'Palkia':'Dragon','Palkia ex':'Dragon','Ultra Necrozma ex':'Dragon',
};

function _buildImageUrl(setCode, num) {
  const numStr = String(parseInt(num, 10) || 0).padStart(3, '0');
  return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/pocket/${setCode}/${setCode}_${numStr}_EN_SM.webp`;
}

function _buildFallbackCardDb() {
  return Object.entries(KNOWN_CARDS).map(([id, card]) => {
    const dash    = id.lastIndexOf('-');
    const setCode = id.substring(0, dash);
    const numStr  = id.substring(dash + 1).padStart(3, '0');
    return {
      id, name: card.name, type: card.type, pack: card.pack,
      setCode, number: numStr, rarity: card.rarity,
      hp: null, retreatCost: null, attacks: [], abilities: [],
      deckgymName: card.name, imageUrl: _buildImageUrl(setCode, numStr),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// LIMITLESS TYPE OVERRIDES — authoritative web scrape
// ════════════════════════════════════════════════════════════════════════════
// Fetches card types from pocket.limitlesstcg.com (the list view), which is
// the most authoritative source for PTCGP energy types.  Returns a lookup
// { "A1-001": "Grass", ... } covering all known sets.
//
// ptcg-symbol letter → type name mapping used by Limitless:
//   G=Grass  R=Fire  W=Water  L=Lightning  P=Psychic  F=Fighting
//   D=Dark   M=Metal  N=Dragon  C=Colorless
// Trainers (Supporter / Item / Stadium / Fossil / Tool) have no symbol.
// ════════════════════════════════════════════════════════════════════════════

const _LIMITLESS_SETS = [
  { limitless: 'A1',  db: 'A1'      },
  { limitless: 'A1a', db: 'A1a'     },
  { limitless: 'A2',  db: 'A2'      },
  { limitless: 'A2a', db: 'A2a'     },
  { limitless: 'A2b', db: 'A2b'     },
  { limitless: 'A3',  db: 'A3'      },
  { limitless: 'A3a', db: 'A3a'     },
  { limitless: 'A3b', db: 'A3b'     },
  { limitless: 'A4',  db: 'A4'      },
  { limitless: 'A4a', db: 'A4a'     },
  { limitless: 'A4b', db: 'A4b'     },
  { limitless: 'B1',  db: 'B1'      },
  { limitless: 'B1a', db: 'B1a'     },
  { limitless: 'B2',  db: 'B2'      },
  { limitless: 'B2a', db: 'B2a'     },
  { limitless: 'P-A', db: 'PROMO-A' },
  { limitless: 'P-B', db: 'PROMO-B' },
];

const _LIMITLESS_SYMBOL_MAP = {
  G: 'Grass', R: 'Fire', W: 'Water', L: 'Lightning',
  P: 'Psychic', F: 'Fighting', D: 'Dark', M: 'Metal',
  N: 'Dragon', C: 'Colorless',
};

async function fetchLimitlessTypeOverrides() {
  const lookup = {};

  for (const { limitless, db } of _LIMITLESS_SETS) {
    const url = `https://pocket.limitlesstcg.com/cards/${limitless}?display=list&show=all`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
      });
      if (!res.ok) {
        log(`  Limitless ${limitless}: HTTP ${res.status}`, 'yellow');
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      const html = await res.text();

      // Each card lives in a <tr data-hover="..."> row.
      // The 4th <td> holds either <span class="ptcg-symbol">G</span> Stage/Basic
      // or plain text like "Supporter" / "Item" for Trainers.
      const rowRe = /<tr[^>]*data-hover[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      let count = 0;
      while ((rowMatch = rowRe.exec(html)) !== null) {
        const rowHtml = rowMatch[1];

        // Card number from href="/cards/SETCODE/NUMBER"
        const hrefMatch = rowHtml.match(/href="\/cards\/[A-Za-z0-9-]+\/(\d+)"/);
        if (!hrefMatch) continue;

        const num    = String(parseInt(hrefMatch[1], 10)).padStart(3, '0');
        const cardId = `${db}-${num}`;

        // Extract 4th <td>
        const tds = [];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdm;
        while ((tdm = tdRe.exec(rowHtml)) !== null) tds.push(tdm[1]);
        const typeCell = tds[3] || '';

        const symMatch = typeCell.match(/class="ptcg-symbol">([A-Z]+)</);
        if (symMatch) {
          const type = _LIMITLESS_SYMBOL_MAP[symMatch[1]];
          if (type) { lookup[cardId] = type; count++; }
        } else if (/Supporter|Item|Stadium|Fossil|Tool/i.test(typeCell)) {
          lookup[cardId] = 'Trainer';
          count++;
        }
      }

      log(`  Limitless ${limitless}: ${count} cards`);
    } catch (e) {
      log(`  Limitless ${limitless}: fetch error — ${e.message}`, 'yellow');
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return lookup;
}

// ════════════════════════════════════════════════════════════════════════════
// PTCGP TYPE CORRECTION ENGINE
// ════════════════════════════════════════════════════════════════════════════
// Applies PTCGP-specific energy type corrections to a normalised card array
// in-place. Called once after source-field resolution in fetchCardDatabase().
//
// Strategy:
//   Pass 1 — ALWAYS_* name overrides: authoritative for Pokémon whose every
//             form uses the same PTCGP energy type (Fairy→Psychic, Poison→Psychic,
//             dual-typed lines, etc.). Pins these cards so position inference
//             cannot override them.
//   Pass 2 — Position inference for multi-form Pokémon (DO_NOT_OVERRIDE):
//             Pokémon like Oricorio/Wormadam have different types per form;
//             position within the set's card-number sequence determines type.
//   Pass 3 — Position inference for all remaining non-Trainer cards not
//             already pinned by Pass 1.
//   Pass 4 — Self-healing validator: any card with an unrecognised type
//             falls back to Colorless and is logged.
// ════════════════════════════════════════════════════════════════════════════
function applyPtcgpTypeCorrections(cards) {
  // ── Valid PTCGP energy types ─────────────────────────────────────────────
  const VALID_TYPES = new Set([
    'Grass','Fire','Water','Lightning','Psychic','Fighting',
    'Dark','Metal','Dragon','Colorless','Trainer',
  ]);

  // ── Name-based overrides ─────────────────────────────────────────────────
  // Rule: Poison-type Pokémon → Dark energy (NOT Psychic)
  const ALWAYS_DARK = new Set([
    'Umbreon','Murkrow','Honchkrow','Sneasel','Weavile','Weavile ex',
    'Houndour','Houndoom','Houndoom ex',
    'Poochyena','Mightyena','Sableye','Carvanha','Sharpedo',
    'Absol','Mega Absol ex','Stunky','Skuntank','Purrloin','Liepard',
    'Sandile','Krokorok','Krookodile','Scraggy','Scrafty',
    'Zorua','Zoroark','Vullaby','Mandibuzz','Pawniard','Bisharp','Kingambit',
    'Nickit','Thievul','Maschiff','Mabosstiff','Bombirdier',
    'Impidimp','Morgrem','Grimmsnarl','Grimmsnarl ex',
    'Pangoro','Lokix','Yveltal','Darkrai','Darkrai ex',
    'Galarian Zigzagoon','Galarian Linoone','Galarian Obstagoon',
    'Alolan Rattata','Alolan Raticate','Alolan Meowth','Alolan Persian',
    'Alolan Grimer','Alolan Muk','Alolan Muk ex',
    'Mega Gyarados ex','Guzzlord','Guzzlord ex',
    'Deino','Zweilous','Hydreigon','Hydreigon ex',
    'Ting-Lu','Drapion','Skorupi',
    // Poison → Dark
    'Ekans','Arbok',
    'Koffing','Weezing',
    'Grimer','Muk',
    'Zubat','Golbat','Crobat','Crobat ex',
    'Nidoran\u2640','Nidorina','Nidoqueen',
    'Nidoran\u2642','Nidorino','Nidoking',
    'Seviper','Trubbish','Garbodor',
    'Venipede','Whirlipede','Scolipede',
    'Croagunk','Toxicroak',
    'Mareanie','Toxapex',
    'Paldean Wooper','Paldean Clodsire','Paldean Clodsire ex',
    'Poipole','Nihilego',
    'Shroodle','Grafaiai',
    'Skrelp','Dragalge','Dragalge ex',
    'Qwilfish',
    'Spinarak','Ariados',
  ]);

  const ALWAYS_PSYCHIC = new Set([
    'Abra','Kadabra','Alakazam','Alakazam ex',
    'Gastly','Haunter','Gengar','Gengar ex',
    'Drowzee','Hypno','Mr. Mime','Mr. Mime ex',
    'Jynx','Smoochum',
    'Espeon','Espeon ex',
    'Misdreavus','Mismagius','Mismagius ex',
    'Wobbuffet','Wynaut',
    'Ralts','Kirlia','Gardevoir','Gardevoir ex','Mega Gardevoir ex','Gallade','Gallade ex',
    'Spoink','Grumpig','Lunatone','Solrock',
    'Baltoy','Claydol','Duskull','Dusclops','Dusknoir',
    'Chimecho','Chingling',
    'Drifloon','Drifblim','Spiritomb',
    'Munna','Musharna','Gothita','Gothorita','Gothitelle',
    'Solosis','Duosion','Reuniclus','Elgyem','Beheeyem',
    'Frillish','Jellicent','Sigilyph','Yamask','Cofagrigus',
    'Inkay','Malamar','Espurr','Meowstic',
    'Phantump','Trevenant','Pumpkaboo','Gourgeist',
    'Hoopa','Oranguru','Dhelmise','Dhelmise ex',
    'Mimikyu','Mimikyu ex',
    'Greavard','Houndstone','Shuppet','Banette',
    'Hatenna','Hattrem','Hatterene','Hatterene ex',
    'Sinistea','Polteageist','Blacephalon','Blacephalon ex',
    'Rabsca','Rellor','Flittle','Espathra',
    'Giratina','Giratina ex',
    'Mewtwo','Mewtwo ex','Mew','Mew ex',
    'Necrozma','Necrozma ex',
    'Cosmog','Cosmoem','Lunala','Lunala ex',
    'Tapu Lele','Tapu Lele ex',
    'Unown','Natu','Xatu','Jirachi',
    'Latias','Latios','Latias ex','Latios ex',
    'Deoxys',
    'Calyrex','Spectrier','Enamorus','Pecharunt','Munkidori','Fezandipiti',
    'Swoobat','Woobat',
    'Galarian Corsola','Galarian Cursola','Galarian Ponyta','Galarian Rapidash',
    'Galarian Mr. Mime','Galarian Mr. Rime',
    'Palossand','Sandygast',
    // Fairy → Psychic
    'Clefairy','Clefable','Cleffa','Igglybuff',
    'Jigglypuff','Wigglytuff','Wigglytuff ex',
    'Togepi','Togetic','Togekiss','Togekiss ex',
    'Snubbull','Granbull',
    'Azurill','Marill','Azumarill',
    'Cottonee','Whimsicott','Whimsicott ex',
    'Morelull','Shiinotic',
    'Carbink',
    'Fidough','Dachsbun',
    'Sylveon','Sylveon ex',
    'Ribombee','Cutiefly',
    'Comfey',
    'Alcremie','Milcery',
    'Aromatisse','Spritzee',
    'Swirlix','Slurpuff',
    'Flabébé','Floette','Florges',
    'Xerneas',
    'Mawile',
    'Indeedee','Indeedee ex',
    'Froslass',
  ]);

  const ALWAYS_WATER = new Set([
    'Lotad','Lombre','Ludicolo',
    'Surskit','Masquerain',
    'Snorunt','Glalie',
    'Swinub','Piloswine','Mamoswine',
    'Delibird',
    'Snover','Abomasnow','Abomasnow ex',
    'Vanillite','Vanillish','Vanilluxe',
    'Cubchoo','Beartic',
    'Cryogonal',
    'Bergmite','Avalugg',
    'Alolan Vulpix','Alolan Ninetales','Alolan Ninetales ex',
    'Eiscue',
    'Cetoddle','Cetitan',
    'Snom','Frosmoth',
  ]);

  const ALWAYS_METAL = new Set([
    'Ferroseed','Ferrothorn',
    'Karrablast','Escavalier',
    'Shelmet','Accelgor',
  ]);

  const ALWAYS_FIRE      = new Set(['Fletchling','Fletchinder','Talonflame']);
  const ALWAYS_COLORLESS = new Set(['Swablu','Mega Altaria ex']);

  const ALWAYS_DRAGON = new Set([
    'Dratini','Dragonair','Dragonite','Dragonite ex',
    'Bagon','Shelgon','Salamence','Salamence ex',
    'Altaria',
    'Axew','Fraxure','Haxorus',
    'Gible','Gabite','Garchomp','Garchomp ex',
    'Goomy','Sliggoo','Goodra','Goodra ex',
    'Noibat','Noivern','Noivern ex',
    'Jangmo-o','Hakamo-o','Kommo-o','Kommo-o ex',
    'Applin','Flapple','Appletun','Dipplin','Hydrapple',
    'Dreepy','Drakloak','Dragapult','Dragapult ex',
    'Druddigon',
    'Tyrunt','Tyrantrum',
    'Cyclizar',
    'Rayquaza','Rayquaza ex',
    'Reshiram','Reshiram ex',
    'Zekrom','Zekrom ex',
    'Kyurem','Kyurem ex',
    'Naganadel','Naganadel ex',
    'Roaring Moon',
  ]);

  // ── Per-ID overrides for multi-form Pokémon ──────────────────────────────
  const ID_FIXES = {
    // Oricorio forms
    'A3-034':'Fire',
    'A3-066':'Lightning',
    'A3-165':'Fire',
    'A4b-146':'Fire',
    'A4b-147':'Lightning',
    'B1-303':'Fire',
    'B2-022':'Fire',
    'B2-161':'Fire',
    // Wormadam forms
    'A2-090':'Fighting',
    'A2-115':'Metal',
    // Rotom ghost forms
    'A2-164':'Psychic',
    'A2a-035':'Psychic',
  };

  // ── Apply overrides ──────────────────────────────────────────────────────
  const nameOverrides = [
    [ALWAYS_DARK,      'Dark'],
    [ALWAYS_PSYCHIC,   'Psychic'],
    [ALWAYS_WATER,     'Water'],
    [ALWAYS_METAL,     'Metal'],
    [ALWAYS_FIRE,      'Fire'],
    [ALWAYS_DRAGON,    'Dragon'],
    [ALWAYS_COLORLESS, 'Colorless'],
  ];

  let nameCount = 0, idCount = 0, invalidCount = 0;

  // Pass 1: Name-based overrides
  for (const card of cards) {
    if (card.type === 'Trainer') continue;
    for (const [nameSet, targetType] of nameOverrides) {
      if (nameSet.has(card.name) && card.type !== targetType) {
        card.type = targetType;
        nameCount++;
        break;
      }
    }
  }

  // Pass 2: Per-ID overrides
  for (const card of cards) {
    const fix = ID_FIXES[card.id];
    if (fix && card.type !== fix) {
      card.type = fix;
      idCount++;
    }
  }

  // Pass 3: Self-healing validator
  for (const card of cards) {
    if (!VALID_TYPES.has(card.type)) {
      log(`  WARN: Card "${card.name}" (${card.id}) has invalid type "${card.type}" — setting Colorless`, 'yellow');
      card.type = 'Colorless';
      invalidCount++;
    }
  }

  const total = nameCount + idCount + invalidCount;
  if (total > 0) {
    log(`  Applied ${total} PTCGP type corrections` +
        ` (${nameCount} name overrides, ${idCount} per-ID fixes, ${invalidCount} invalid→Colorless)`);
  }
  if (invalidCount > 0) log(`  Fixed ${invalidCount} invalid type values`, 'yellow');

  // Print type distribution for CI log visibility
  const _typeDist = {};
  for (const c of cards) _typeDist[c.type] = (_typeDist[c.type] || 0) + 1;
  log('  Type distribution: ' + Object.entries(_typeDist)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => t + ':' + n)
    .join('  '));
}

async function fetchCardDatabase() {
  log('\n► Phase 0: Fetching full card database from flibustier/pokemon-tcg-pocket-database…');

  const [rawCards, rawSets] = await Promise.all([
    fetchJson(CARDS_DB_URL),
    fetchJson(SETS_DB_URL),
  ]);

  if (!rawCards || !Array.isArray(rawCards)) {
    log('  WARN: Card DB fetch failed — falling back to KNOWN_CARDS', 'yellow');
    return _buildFallbackCardDb();
  }

  // Build set-name lookup
  const setNames = {};
  if (rawSets && Array.isArray(rawSets)) {
    for (const s of rawSets) {
      const code = s.id || s.code || s.setId;
      const name = s.name;
      if (code && name) setNames[code] = name;
    }
  }

  log(`  Fetched ${rawCards.length} cards, ${Object.keys(setNames).length} sets`);

  const normalized = [];
  for (const raw of rawCards) {
    try {
      // Derive setCode + zero-padded number
      let setCode, numStr;
      if (raw.id && raw.id.includes('-')) {
        // Combined id field present (e.g. "A1-087")
        const dash = raw.id.lastIndexOf('-');
        setCode = raw.id.substring(0, dash);
        numStr  = String(parseInt(raw.id.substring(dash + 1), 10)).padStart(3, '0');
      } else if ((raw.set || raw.setId) && raw.number !== undefined) {
        setCode = raw.set || raw.setId;
        numStr  = String(parseInt(String(raw.number), 10) || 0).padStart(3, '0');
      } else {
        continue; // cannot derive id
      }

      const id       = `${setCode}-${numStr}`;
      const packName = setNames[setCode] || raw.setName || raw.pack || setCode;

      // Type — try source fields first, then image prefix (Trainer detection),
      // then name-based lookup (for databases like flibustier that omit the field).
      let type = 'Colorless';
      if (raw.type)    type = _normalizeType(raw.type);
      else if (raw.element) type = _normalizeType(raw.element);
      else if (raw.category === 'Trainer' || raw.supertype === 'Trainer') type = 'Trainer';
      else if (Array.isArray(raw.subtypes) &&
               (raw.subtypes.includes('Supporter') || raw.subtypes.includes('Item') ||
                raw.subtypes.includes('Tool') || raw.subtypes.includes('Stadium'))) {
        type = 'Trainer';
      } else if (typeof raw.image === 'string' && raw.image.startsWith('cTR')) {
        type = 'Trainer'; // flibustier: Trainer cards use cTR_ image prefix
      } else if (raw.name) {
        // Name-based fallback: exact name, then strip " ex" suffix
        const t = POKEMON_NAME_TYPE_MAP[raw.name];
        if (t) { type = t; }
        else {
          const base = raw.name.replace(/\s+ex$/i,'').trim();
          if (base !== raw.name && POKEMON_NAME_TYPE_MAP[base]) type = POKEMON_NAME_TYPE_MAP[base];
        }
      }

      const hp          = raw.hp ? (parseInt(raw.hp, 10) || null) : null;
      const retreatCost = raw.retreat !== undefined   ? (parseInt(raw.retreat, 10) || 0)
                        : raw.retreatCost !== undefined ? (parseInt(raw.retreatCost, 10) || 0)
                        : null;

      const attacks = (Array.isArray(raw.attacks) ? raw.attacks : []).map(a => ({
        name:   a.name   || '',
        damage: a.damage || a.dmg || '',
        cost:   Array.isArray(a.cost) ? a.cost : (Array.isArray(a.energy) ? a.energy : []),
        text:   a.text   || a.effect || '',
      }));

      const abilities = (Array.isArray(raw.abilities) ? raw.abilities :
                         raw.ability ? [raw.ability] : []).map(a => ({
        name: a.name || '',
        text: a.text || a.effect || '',
      }));

      normalized.push({
        id, name: raw.name || id, type, pack: packName,
        setCode, number: numStr,
        rarity:      _normalizeRarity(raw.rarity),
        hp, retreatCost, attacks, abilities,
        deckgymName: raw.name || id,
        imageUrl:    _buildImageUrl(setCode, numStr),
      });
    } catch (_) { /* skip malformed entries */ }
  }

  // ── Apply type corrections: try Limitless (authoritative), fall back to
  //    name-based rules if the web fetch fails. ─────────────────────────────
  try {
    log('  Fetching authoritative types from pocket.limitlesstcg.com…');
    const limitlessTypes = await fetchLimitlessTypeOverrides();
    const fetched = Object.keys(limitlessTypes).length;
    if (fetched < 100) throw new Error(`too few cards fetched (${fetched})`);
    let overrideCount = 0;
    for (const card of normalized) {
      const t = limitlessTypes[card.id];
      if (t && t !== card.type) { card.type = t; overrideCount++; }
    }
    if (overrideCount > 0) log(`  Applied ${overrideCount} Limitless type overrides`);
  } catch (e) {
    log(`  Limitless type fetch failed (${e.message}) — using name-based rules`, 'yellow');
    applyPtcgpTypeCorrections(normalized);
  }

  // ── Stable set order, then card number within each set
  normalized.sort((a, b) => {
    if (a.setCode < b.setCode) return -1;
    if (a.setCode > b.setCode) return  1;
    return parseInt(a.number, 10) - parseInt(b.number, 10);
  });

  log(`  ✓ Normalised ${normalized.length} cards`);
  return normalized;
}

function buildFullCardDbJs(cards) {
  const lines = cards.map(c => {
    // Compact single-line serialisation — no indented pretty-print to keep file size down
    return '  ' + JSON.stringify(c);
  });
  return `const FULL_CARD_DB = [\n${lines.join(',\n')}\n];`;
}

async function fetchJson(url, _retries = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS });
    clearTimeout(timer);
    // Retry once on rate-limit or temporary server error
    if ((res.status === 429 || res.status === 503) && _retries > 0) {
      log(`  WARN: ${url} — HTTP ${res.status}, retrying in 2s…`, 'yellow');
      await sleep(2000);
      return fetchJson(url, 0);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    log(`  WARN: ${url} — ${err.message}`, 'yellow');
    return null;
  }
}

// Recency window for the 1.5× appearance weight
const RECENCY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

async function fetchLimitlessData() {
  log('  Fetching tournament list from Limitless API…');

  // Use format=standard to get only Standard-format POCKET tournaments
  const tournaments = await fetchJson(
    `${LIMITLESS_BASE}/tournaments?game=POCKET&format=standard&limit=${TOURNAMENT_LIMIT}`
  );
  if (!tournaments) {
    log('  WARN: Limitless API unreachable — returning empty dataset', 'yellow');
    return { archetypes: [], stats: { tournaments: 0, players: 0 } };
  }

  const now = Date.now();

  // Filter to meaningful-sized, standard-format tournaments
  // SKIP_FORMATS guards against non-standard variants returned despite the query param
  const usable = tournaments.filter(t =>
    t.players >= MIN_PLAYERS &&
    (!t.format || !SKIP_FORMATS.has(t.format.toUpperCase()))
  );
  log(`  Using ${usable.length}/${tournaments.length} tournaments (≥${MIN_PLAYERS} players, standard format)`);

  // deckId → aggregated stats
  const deckMap = {};
  let totalPlayers = 0;
  let fetched      = 0;

  for (const t of usable) {
    const standings = await fetchJson(`${LIMITLESS_BASE}/tournaments/${t.id}/standings`);
    if (!standings) continue;
    fetched++;

    // Recency: last 14 days count 1.5× toward appearance weight
    const tDate       = t.date ? new Date(t.date).getTime() : 0;
    const isRecent    = tDate > 0 && (now - tDate) <= RECENCY_WINDOW_MS;
    const recencyMult = isRecent ? 1.5 : 1.0;

    for (const player of standings) {
      if (!player.deck?.id) continue;
      const { id, name } = player.deck;
      if (!deckMap[id]) {
        deckMap[id] = { name, wins: 0, losses: 0, appearances: 0, weightedAppearances: 0 };
      }
      deckMap[id].wins                += player.record?.wins   || 0;
      deckMap[id].losses              += player.record?.losses || 0;
      deckMap[id].appearances         += 1;
      deckMap[id].weightedAppearances += recencyMult;
    }
    totalPlayers += standings.length;

    await sleep(API_DELAY_MS);
  }

  log(`  Processed ${totalPlayers} player records across ${fetched} tournaments`);

  // Convert to archetype array — no top-N cap
  const archetypes = Object.entries(deckMap)
    .filter(([, s]) => s.appearances >= MIN_APPEARANCES)
    .map(([limitlessId, s]) => {
      const games = s.wins + s.losses;
      // recencyBoost > 1.0 means the deck is proportionally hotter in recent events
      const recencyBoost = s.appearances > 0
        ? s.weightedAppearances / s.appearances
        : 1.0;
      return {
        name:         s.name,
        winRate:      games > 0 ? (s.wins / games) * 100 : 50,
        metaShare:    totalPlayers > 0 ? (s.appearances / totalPlayers) * 100 : 0,
        count:        s.appearances,
        recencyBoost,
        limitlessId,
        source:       'Limitless',
      };
    })
    .sort((a, b) => b.metaShare - a.metaShare);

  log(`  Limitless API: ${archetypes.length} archetypes with ≥${MIN_APPEARANCES} appearances`);
  return {
    archetypes,
    stats: { tournaments: fetched, players: totalPlayers },
  };
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
    'Galvantula': 'Lightning', 'Zeraora': 'Lightning', 'Bellibolt': 'Lightning',
    'Charizard': 'Fire', 'Blaziken': 'Fire', 'Entei': 'Fire',
    'Altaria': 'Colorless', 'Kangaskhan': 'Colorless', 'Snorlax': 'Colorless', 'Silvally': 'Colorless',
    'Baxcalibur': 'Water',
    'Banette': 'Psychic',
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
  if (name.includes('Greninja') && !name.includes('Greninja ex')) cores.push('A1-087','A1-088','A1-089');
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
  if (name.includes('Galvantula'))         cores.push('B1-092','B1-093');
  if (name.includes('Zeraora'))            cores.push('B1-304');
  if (name.includes('Bellibolt'))          cores.push('B2a-041','B2a-042');
  if (name.includes('Baxcalibur'))         cores.push('B2a-034','B2a-035','B2a-036');
  if (name.includes('Banette'))            cores.push('A3-074','A3-075');
  if (name.includes('Silvally'))           cores.push('B1a-096','B1a-097');
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

function buildRegistryJs(decks, fullCardDb) {
  // fullCardDb entries take priority over the hardcoded KNOWN_CARDS fallback
  const dbLookup = {};
  for (const c of (fullCardDb || [])) dbLookup[c.id] = c;

  const usedIds = new Set();
  for (const deck of decks) for (const card of deck.cards) usedIds.add(card.id);

  const entries = [...usedIds].sort().map(id => {
    const c = dbLookup[id] || KNOWN_CARDS[id];
    if (!c) return null;
    return `  ${JSON.stringify(id)}: { name: ${JSON.stringify(c.name)}, type: ${JSON.stringify(c.type)}, pack: ${JSON.stringify(c.pack)}, rarity: ${JSON.stringify(c.rarity)} }`;
  }).filter(Boolean);

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

// ═══════════════════════════════════════════════════════════════════
// SIMULATION PHASE — deckgym-core matchup matrix
// ═══════════════════════════════════════════════════════════════════

/** Locate the deckgym binary. Returns path string or null. */
function findDeckgym() {
  const envPath = process.env.DECKGYM_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const localPath = path.resolve(__dirname, 'deckgym-core', 'target', 'release', 'deckgym');
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

/** Wrap execFile in a Promise. */
function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Convert a finalDeck object to DeckGym text format.
 * Returns the file content string, or null if the deck has no resolvable cards.
 */
function deckToText(deck, fullCardDb) {
  const dbLookup = {};
  for (const c of (fullCardDb || [])) dbLookup[c.id] = c;

  const lines = [];
  for (const { id, qty } of deck.cards) {
    const entry = dbLookup[id] || KNOWN_CARDS[id];
    if (!entry) {
      log(`  WARN: no card entry for ${id} in deck "${deck.name}" — skipping`, 'yellow');
      continue;
    }
    const nm = entry.deckgymName || entry.name;
    if (!nm) {
      log(`  WARN: no deckgymName for ${id} in deck "${deck.name}" — skipping`, 'yellow');
      continue;
    }
    lines.push(`${nm} ${qty}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Parse deckgym stdout for the win rate of deck A.
 * Expected output contains a line like: "Deck A wins: 54.2%"
 */
function parseDeckgymOutput(stdout) {
  const match = stdout.match(/Deck\s+A\s+wins?[:\s]+([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (match) return parseFloat(match[1]) / 100;
  // Fallback: try "Win rate: 54.2%" style
  const alt = stdout.match(/Win\s+rate[:\s]+([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (alt) return parseFloat(alt[1]) / 100;
  return null;
}

/**
 * Run pairwise simulations for all decks.
 * Returns matchupMatrix or null if deckgym is unavailable.
 * Mutates deck.winRate with simulation averages when matrix is populated.
 */
async function runSimulations(decks, fullCardDb) {
  const deckgym = findDeckgym();
  if (!deckgym) {
    log('\n► Phase 5b: deckgym-core not found — skipping simulations', 'yellow');
    return null;
  }

  const SIM_COUNT  = 2000;
  const BATCH_SIZE = 8;
  const tmpDir     = path.join(os.tmpdir(), 'deckgym-sims');
  const writtenFiles = [];

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write deck text files
    const deckFiles = {};
    for (const deck of decks) {
      const text = deckToText(deck, fullCardDb);
      if (!text) { log(`  WARN: skipping simulation for empty deck "${deck.name}"`, 'yellow'); continue; }
      const file = path.join(tmpDir, `${deck.id}.txt`);
      fs.writeFileSync(file, text, 'utf-8');
      writtenFiles.push(file);
      deckFiles[deck.id] = file;
    }

    const validDecks = decks.filter(d => deckFiles[d.id]);
    if (validDecks.length < 2) {
      log('  WARN: fewer than 2 valid decks — cannot run simulations', 'yellow');
      return null;
    }

    log(`\n► Phase 5b: Running simulations (${validDecks.length} decks, ${validDecks.length * (validDecks.length - 1) / 2} matchups)…`);

    // Build all unique pairs
    const pairs = [];
    for (let i = 0; i < validDecks.length; i++) {
      for (let j = i + 1; j < validDecks.length; j++) {
        pairs.push([validDecks[i], validDecks[j]]);
      }
    }

    const matchupMatrix = {};
    for (const d of validDecks) matchupMatrix[d.id] = {};

    let done = 0;
    for (let b = 0; b < pairs.length; b += BATCH_SIZE) {
      const batch = pairs.slice(b, b + BATCH_SIZE);
      await Promise.all(batch.map(async ([deckA, deckB]) => {
        try {
          const stdout = await runProcess(deckgym, [
            'simulate',
            deckFiles[deckA.id],
            deckFiles[deckB.id],
            '--num', String(SIM_COUNT),
          ]);
          const winRateA = parseDeckgymOutput(stdout);
          if (winRateA === null) {
            log(`  WARN: could not parse output for ${deckA.name} vs ${deckB.name}`, 'yellow');
            return;
          }
          matchupMatrix[deckA.id][deckB.id] = winRateA;
          matchupMatrix[deckB.id][deckA.id] = parseFloat((1 - winRateA).toFixed(4));
          done++;
        } catch (err) {
          log(`  WARN: simulation failed for ${deckA.name} vs ${deckB.name}: ${err.message}`, 'yellow');
        }
      }));
    }

    log(`  ✓ ${done} / ${pairs.length} matchups simulated`);

    // Update deck winRates from simulation averages
    for (const deck of validDecks) {
      const results = Object.values(matchupMatrix[deck.id]);
      if (results.length) {
        const avg = results.reduce((s, v) => s + v, 0) / results.length;
        deck.winRate = parseFloat((avg * 100).toFixed(1));
      }
    }
    log('  ✓ Deck win rates updated from simulation data');

    return matchupMatrix;

  } finally {
    for (const f of writtenFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(tmpDir); } catch (_) {}
  }
}

function buildMatchupMatrixJs(matrix) {
  if (!matrix || !Object.keys(matrix).length) {
    return 'const MATCHUP_MATRIX = {};';
  }
  return `const MATCHUP_MATRIX = ${JSON.stringify(matrix, null, 2)};`;
}

function patchHtml(decks, fullCardDb, metaStats = {}, matchupMatrix = null) {
  if (!fs.existsSync(HTML_FILE)) {
    log(`ERROR: HTML file not found at ${HTML_FILE}`, 'red');
    process.exit(1);
  }

  let html = fs.readFileSync(HTML_FILE, 'utf-8');

  // ── FULL_CARD_DB ──────────────────────────────────────────────
  const fullDbRe = /const FULL_CARD_DB = \[[\s\S]*?\];/;
  if (fullDbRe.test(html)) {
    html = html.replace(fullDbRe, buildFullCardDbJs(fullCardDb));
    log('  ✓ FULL_CARD_DB patched');
  } else {
    log('  WARN: FULL_CARD_DB block not found in HTML — skipping', 'yellow');
  }

  // ── CARD_REGISTRY ─────────────────────────────────────────────
  const registryRe = /const CARD_REGISTRY = \{[\s\S]*?\};/;
  if (!registryRe.test(html)) {
    log('ERROR: CARD_REGISTRY block not found in HTML.', 'red');
    process.exit(1);
  }
  html = html.replace(registryRe, buildRegistryJs(decks, fullCardDb));
  log('  ✓ CARD_REGISTRY patched');

  // ── META_SNAPSHOT ─────────────────────────────────────────────
  const snapshotRe = /const META_SNAPSHOT = \[[\s\S]*?\];/;
  if (!snapshotRe.test(html)) {
    log('ERROR: META_SNAPSHOT block not found in HTML.', 'red');
    process.exit(1);
  }
  html = html.replace(snapshotRe, buildSnapshotJs(decks));
  log('  ✓ META_SNAPSHOT patched');

  // ── MATCHUP_MATRIX ────────────────────────────────────────────
  const matrixRe = /const MATCHUP_MATRIX = \{[\s\S]*?\};/;
  if (matrixRe.test(html)) {
    html = html.replace(matrixRe, buildMatchupMatrixJs(matchupMatrix));
    log('  ✓ MATCHUP_MATRIX patched');
  } else {
    log('  WARN: MATCHUP_MATRIX block not found in HTML — skipping', 'yellow');
  }

  // ── Freshness badge ───────────────────────────────────────────
  const now   = new Date();
  const label = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  html = html.replace(
    /(<strong id="meta-updated-date">)[^<]*(< *\/strong>)/,
    `$1${label}$2`
  );
  if (metaStats.tournaments) {
    html = html.replace(
      /(<strong id="meta-tourney-count">)[^<]*(< *\/strong>)/,
      `$1${metaStats.tournaments}$2`
    );
  }
  if (metaStats.players) {
    html = html.replace(
      /(<strong id="meta-player-count">)[^<]*(< *\/strong>)/,
      `$1${metaStats.players.toLocaleString()}$2`
    );
  }
  // Update nav-bar date pill
  html = html.replace(
    /(<span id="nav-meta-date">)[^<]*(< *\/span>)/,
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

  // ── 0. FULL CARD DB ────────────────────────────────────────────
  const fullCardDb = await fetchCardDatabase();

  // ── 1. FETCH ──────────────────────────────────────────────────
  log('\n► Phase 1: Fetching tournament data…');
  const [limitlessResult, editorialTiers] = await Promise.all([
    fetchLimitlessData(),
    fetchPtcgpocketTiers(),
  ]);

  const limitlessData = limitlessResult.archetypes;
  const metaStats     = limitlessResult.stats;

  if (limitlessData.length === 0) {
    log('ERROR: No archetype data from Limitless API. Aborting.', 'red');
    process.exit(1);
  }
  log(`  Fetched ${limitlessData.length} archetypes from ${metaStats.tournaments} tournaments (${metaStats.players.toLocaleString()} players)`);

  // ── 2. MERGE ──────────────────────────────────────────────────
  log('\n► Phase 2: Merging sources…');
  const merged = mergeArchetypes(limitlessData, editorialTiers);
  log(`  ${merged.length} archetypes after merge`);

  // ── 3. ENRICH ─────────────────────────────────────────────────
  log('\n► Phase 3: Enriching with strategy engine…');
  const enriched = merged.map(enrichArchetype);

  // ── 4. SCORE & FILTER ─────────────────────────────────────────
  // All archetypes meeting the sample threshold are included (no top-N cap)
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
    .sort((a, b) => b.score - a.score);
  // ↑ No .slice() — all qualifying archetypes are tracked

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

  // ── 5b. SIMULATE MATCHUPS ──────────────────────────────────────
  const matchupMatrix = await runSimulations(finalDecks, fullCardDb);

  // ── 6. PATCH HTML ─────────────────────────────────────────────
  log('\n► Phase 6: Patching HTML file…');
  patchHtml(finalDecks, fullCardDb, metaStats, matchupMatrix);

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
