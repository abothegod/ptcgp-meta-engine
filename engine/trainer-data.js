/**
 * engine/trainer-data.js
 *
 * Static classification of every trainer card name in PTCGP across 4 classes,
 * 8 effect categories, and an optional forType field.
 *
 * Classes:
 *   Supporter — one per turn; powerful draw / search / disruption / energy effects
 *   Item      — unlimited per turn; immediate one-shot utility
 *   Tool      — attach to a Pokémon; passive ongoing effect
 *   Stadium   — field effect; replaced when opponent plays one
 *
 * Effects:
 *   draw         — increase hand size
 *   search       — fetch specific card(s) from deck / discard
 *   energy       — attach, move, or accelerate Energy
 *   damage       — boost, add, or deal direct damage
 *   heal         — restore HP or remove status conditions
 *   disruption   — discard, shuffle, or restrict opponent
 *   speed        — reduce setup time (retreat, evolution, etc.)
 *   survivability— raise effective HP or prevent KOs
 *   switch       — move Pokémon between Active / Bench
 *   ability      — gate or unlock Pokémon abilities
 *
 * forType:
 *   null  — universal; useful in any deck
 *   "Fire" | "Water" | "Grass" | "Lightning" | "Psychic" |
 *   "Fighting" | "Darkness" | "Metal" | "Dragon" | "Colorless"
 *         — only useful (or primarily useful) in decks of that type
 *
 * Coverage: all 120 unique trainer names found in FULL_CARD_DB (confirmed),
 * plus forward-looking entries for likely future/alternate-set names.
 */

export const TRAINER_CLASSES = {

  // ══════════════════════════════════════════════════════════════════
  // SUPPORTERS  (once per turn)
  // ══════════════════════════════════════════════════════════════════

  'Acerola':              { class: 'Supporter', effect: 'heal',        forType: null          }, // return damaged Pokémon to hand
  'Adaman':               { class: 'Supporter', effect: 'energy',      forType: null          }, // attach extra Energy from discard (any type)
  'Arven':                { class: 'Supporter', effect: 'search',      forType: null          }, // search for an Item
  'Barry':                { class: 'Supporter', effect: 'speed',       forType: null          }, // free retreat this turn
  'Blaine':               { class: 'Supporter', effect: 'damage',      forType: 'Fire'        }, // +30 damage to Fire Pokémon attacks
  'Blue':                 { class: 'Supporter', effect: 'defense',     forType: null          }, // reduce damage taken
  'Brock':                { class: 'Supporter', effect: 'search',      forType: 'Fighting'    }, // search for Fighting Pokémon
  'Celestic Town Elder':  { class: 'Supporter', effect: 'draw',        forType: null          }, // draw cards
  'Clemont':              { class: 'Supporter', effect: 'energy',      forType: 'Lightning'   }, // attach Lightning Energy
  'Copycat':              { class: 'Supporter', effect: 'draw',        forType: null          }, // draw to match opponent's hand size
  'Cynthia':              { class: 'Supporter', effect: 'draw',        forType: null          }, // draw 3 cards
  'Cyrus':                { class: 'Supporter', effect: 'disruption',  forType: null          }, // move opponent's Basic to bench
  'Dawn':                 { class: 'Supporter', effect: 'energy',      forType: null          }, // attach Energy from discard (any type)
  'Diantha':              { class: 'Supporter', effect: 'heal',        forType: null          }, // heal Pokémon
  'Erika':                { class: 'Supporter', effect: 'heal',        forType: 'Grass'       }, // heal 50 HP from Grass Pokémon
  'Fantina':              { class: 'Supporter', effect: 'disruption',  forType: null          }, // shuffle opponent's Active
  'Fisher':               { class: 'Supporter', effect: 'search',      forType: 'Water'       }, // search for Water Pokémon
  'Giovanni':             { class: 'Supporter', effect: 'damage',      forType: null          }, // +10 damage this turn
  'Gladion':              { class: 'Supporter', effect: 'search',      forType: null          }, // search Prize cards
  'Guzma':                { class: 'Supporter', effect: 'disruption',  forType: null          }, // switch opponent's Active
  'Hala':                 { class: 'Supporter', effect: 'disruption',  forType: null          }, // discard opponent's tools / energy
  'Hau':                  { class: 'Supporter', effect: 'heal',        forType: null          }, // heal 30 HP
  'Hiker':                { class: 'Supporter', effect: 'energy',      forType: 'Fighting'    }, // attach Fighting Energy
  'Ilima':                { class: 'Supporter', effect: 'search',      forType: null          }, // look at top 5, keep 1
  'Iono':                 { class: 'Supporter', effect: 'disruption',  forType: null          }, // both players shuffle hand into deck
  'Irida':                { class: 'Supporter', effect: 'search',      forType: 'Water'       }, // search for Water Pokémon or Item
  'Jasmine':              { class: 'Supporter', effect: 'energy',      forType: 'Metal'       }, // attach Metal Energy
  'Juggler':              { class: 'Supporter', effect: 'energy',      forType: null          }, // attach multiple Energy (any type)
  'Kiawe':                { class: 'Supporter', effect: 'energy',      forType: 'Fire'        }, // attach 4 Fire Energy
  'Koga':                 { class: 'Supporter', effect: 'disruption',  forType: null          }, // poison / switch opponent
  'Lana':                 { class: 'Supporter', effect: 'heal',        forType: 'Water'       }, // heal Water Pokémon
  'Leaf':                 { class: 'Supporter', effect: 'search',      forType: 'Grass'       }, // search for Grass Pokémon
  'Lillie':               { class: 'Supporter', effect: 'draw',        forType: null          }, // draw until 6 cards in hand
  'Lisia':                { class: 'Supporter', effect: 'draw',        forType: null          }, // draw 3 cards
  'Looker':               { class: 'Supporter', effect: 'disruption',  forType: null          }, // look at opponent's hand
  'Lt. Surge':            { class: 'Supporter', effect: 'speed',       forType: 'Lightning'   }, // evolve Lightning Pokémon immediately
  'Lusamine':             { class: 'Supporter', effect: 'search',      forType: null          }, // recover Supporter from discard
  'Lyra':                 { class: 'Supporter', effect: 'search',      forType: null          }, // search for Basic Pokémon (any type)
  'Mallow':               { class: 'Supporter', effect: 'search',      forType: null          }, // put 2 cards on top of deck
  'Marlon':               { class: 'Supporter', effect: 'heal',        forType: 'Water'       }, // heal Water Pokémon
  'Mars':                 { class: 'Supporter', effect: 'disruption',  forType: null          }, // discard card from opponent's hand
  'May':                  { class: 'Supporter', effect: 'draw',        forType: null          }, // draw 3 cards
  'Misty':                { class: 'Supporter', effect: 'energy',      forType: 'Water'       }, // flip-based Water Energy attach
  'Morty':                { class: 'Supporter', effect: 'search',      forType: 'Psychic'     }, // search for Psychic Pokémon
  'Nemona':               { class: 'Supporter', effect: 'draw',        forType: null          }, // draw 3 cards
  'Penny':                { class: 'Supporter', effect: 'search',      forType: null          }, // return Pokémon and Energy to hand
  'Piers':                { class: 'Supporter', effect: 'search',      forType: 'Darkness'    }, // search discard for Darkness Pokémon
  'Pokémon Center Lady':  { class: 'Supporter', effect: 'heal',        forType: null          }, // heal 60 HP, remove status
  "Professor\u2019s Research": { class: 'Supporter', effect: 'draw',   forType: null          }, // discard hand, draw 7 (curly quote)
  "Professor's Research":      { class: 'Supporter', effect: 'draw',   forType: null          }, // straight-quote alias
  'Red':                  { class: 'Supporter', effect: 'damage',      forType: null          }, // +20 damage if opponent has more Prizes
  'Sabrina':              { class: 'Supporter', effect: 'switch',      forType: null          }, // switch opponent's Active Pokémon
  'Serena':               { class: 'Supporter', effect: 'draw',        forType: null          }, // discard up to 3, draw same amount
  'Sightseer':            { class: 'Supporter', effect: 'draw',        forType: null          }, // discard up to 3, draw same amount
  'Silver':               { class: 'Supporter', effect: 'disruption',  forType: null          }, // look at opponent's hand, discard Item
  'Sophocles':            { class: 'Supporter', effect: 'energy',      forType: 'Lightning'   }, // attach 2 Lightning Energy
  'Team Galactic Grunt':  { class: 'Supporter', effect: 'disruption',  forType: null          }, // discard opponent's Energy
  'Team Rocket Grunt':    { class: 'Supporter', effect: 'disruption',  forType: null          }, // discard opponent's Energy
  'Team Star Grunt':      { class: 'Supporter', effect: 'disruption',  forType: null          }, // discard opponent's Energy
  'Volkner':              { class: 'Supporter', effect: 'search',      forType: 'Lightning'   }, // search for Lightning card
  'Whitney':              { class: 'Supporter', effect: 'disruption',  forType: null          }, // flip-based paralysis
  'Will':                 { class: 'Supporter', effect: 'draw',        forType: null          }, // draw 3 cards
  // Forward-looking (not yet in DB but confirmed PTCGP Supporters)
  'Nessa':                { class: 'Supporter', effect: 'search',      forType: 'Water'       },
  'Olivia':               { class: 'Supporter', effect: 'energy',      forType: null          },
  'Palmer':               { class: 'Supporter', effect: 'draw',        forType: null          },
  'Skyla':                { class: 'Supporter', effect: 'search',      forType: null          },
  'Wikstrom':             { class: 'Supporter', effect: 'defense',     forType: 'Metal'       },
  'Winona':               { class: 'Supporter', effect: 'search',      forType: null          },
  'Zisu':                 { class: 'Supporter', effect: 'energy',      forType: null          },

  // ══════════════════════════════════════════════════════════════════
  // ITEMS  (unlimited per turn)
  // ══════════════════════════════════════════════════════════════════

  'Armor Fossil':           { class: 'Item', effect: 'search',        forType: null          }, // plays Shieldon / Cranidos from deck
  'Beast Wall':             { class: 'Item', effect: 'survivability',  forType: null          }, // reduce damage to benched Ultra Beasts
  'Big Malasada':           { class: 'Item', effect: 'heal',          forType: null          }, // heal 20 HP, remove status
  'Budding Expeditioner':   { class: 'Item', effect: 'search',        forType: null          }, // return Hisuian Pokémon to hand
  "Clemont\u2019s Backpack":{ class: 'Item', effect: 'search',        forType: 'Lightning'   }, // search for Lightning cards (curly quote)
  "Clemont's Backpack":     { class: 'Item', effect: 'search',        forType: 'Lightning'   }, // straight-quote alias
  'Cover Fossil':           { class: 'Item', effect: 'search',        forType: null          }, // plays Tirtouga from deck
  'Dome Fossil':            { class: 'Item', effect: 'search',        forType: null          }, // plays Kabuto from deck
  'Eevee Bag':              { class: 'Item', effect: 'search',        forType: null          }, // search for an Eevee evolution
  'Electric Generator':     { class: 'Item', effect: 'energy',        forType: 'Lightning'   }, // attach up to 2 Lightning Energy
  'Electrical Cord':        { class: 'Item', effect: 'energy',        forType: 'Lightning'   }, // move Lightning Energy between Pokémon
  'Elemental Switch':       { class: 'Item', effect: 'energy',        forType: null          }, // move any Energy to Benched Pokémon
  'Fishing Net':            { class: 'Item', effect: 'search',        forType: null          }, // look at top 6, take up to 2 Pokémon
  'Flame Patch':            { class: 'Item', effect: 'energy',        forType: 'Fire'        }, // attach Fire Energy to Benched Pokémon
  'Hand Scope':             { class: 'Item', effect: 'disruption',    forType: null          }, // look at opponent's hand
  'Helix Fossil':           { class: 'Item', effect: 'search',        forType: null          }, // plays Omanyte from deck
  'Hitting Hammer':         { class: 'Item', effect: 'disruption',    forType: null          }, // discard 1 Energy from opponent's Pokémon
  'Inflatable Boat':        { class: 'Item', effect: 'speed',         forType: null          }, // switch out Active, reduce retreat cost
  'Jaw Fossil':             { class: 'Item', effect: 'search',        forType: null          }, // plays Tyrunt from deck
  'Lum Berry':              { class: 'Item', effect: 'heal',          forType: null          }, // remove all status conditions
  'Mythical Slab':          { class: 'Item', effect: 'search',        forType: 'Psychic'     }, // flip-based Psychic Pokémon search
  'Old Amber':              { class: 'Item', effect: 'search',        forType: null          }, // plays Aerodactyl from deck
  'Plume Fossil':           { class: 'Item', effect: 'search',        forType: null          }, // plays Archen from deck
  'Poké Ball':              { class: 'Item', effect: 'search',        forType: null          }, // flip-based Basic Pokémon search
  'Pokédex':                { class: 'Item', effect: 'draw',          forType: null          }, // look at top 3 cards
  'Pokémon Communication':  { class: 'Item', effect: 'search',        forType: null          }, // swap Pokémon in hand with deck
  'Pokémon Flute':          { class: 'Item', effect: 'search',        forType: null          }, // play Basic from opponent's discard
  'Potion':                 { class: 'Item', effect: 'heal',          forType: null          }, // heal 20 HP
  'Prank Spinner':          { class: 'Item', effect: 'disruption',    forType: null          }, // flip-based confusion on opponent
  'Rare Candy':             { class: 'Item', effect: 'speed',         forType: null          }, // evolve Basic directly to Stage 2
  'Red Card':               { class: 'Item', effect: 'disruption',    forType: null          }, // force opponent to shuffle hand into deck
  'Repel':                  { class: 'Item', effect: 'disruption',    forType: null          }, // opponent cannot retreat next turn
  'Rotom Dex':              { class: 'Item', effect: 'draw',          forType: null          }, // look at top 5, rearrange / keep
  'Sail Fossil':            { class: 'Item', effect: 'search',        forType: null          }, // plays Amaura from deck
  'Sitrus Berry':           { class: 'Item', effect: 'heal',          forType: null          }, // heal 30 HP
  'Skull Fossil':           { class: 'Item', effect: 'search',        forType: null          }, // plays Cranidos from deck
  'Squirt Bottle':          { class: 'Item', effect: 'energy',        forType: 'Water'       }, // move Water Energy between Pokémon
  'Traveling Merchant':     { class: 'Item', effect: 'search',        forType: null          }, // look at top 3, take an Item
  'X Speed':                { class: 'Item', effect: 'speed',         forType: null          }, // -1 Retreat Cost this turn
  // Forward-looking
  'Antidote':               { class: 'Item', effect: 'heal',          forType: null          },
  'Awakening':              { class: 'Item', effect: 'heal',          forType: null          },
  'Ball Guy':               { class: 'Item', effect: 'search',        forType: null          },
  'Berry':                  { class: 'Item', effect: 'heal',          forType: null          },
  'Capture Aroma':          { class: 'Item', effect: 'search',        forType: null          },
  'Egg Incubator':          { class: 'Item', effect: 'search',        forType: null          },
  'Ether':                  { class: 'Item', effect: 'energy',        forType: null          },
  'Full Heal':              { class: 'Item', effect: 'heal',          forType: null          },
  'Great Ball':             { class: 'Item', effect: 'search',        forType: null          },
  'Hyper Potion':           { class: 'Item', effect: 'heal',          forType: null          },
  'Moo Moo Milk':           { class: 'Item', effect: 'heal',          forType: null          },
  'Night Stretcher':        { class: 'Item', effect: 'energy',        forType: null          },
  'Poke Ball':              { class: 'Item', effect: 'search',        forType: null          }, // alternate romanisation
  'Revive':                 { class: 'Item', effect: 'search',        forType: null          },
  'Super Potion':           { class: 'Item', effect: 'heal',          forType: null          },
  'Survival Brace':         { class: 'Item', effect: 'survivability', forType: null          },
  'Switch':                 { class: 'Item', effect: 'speed',         forType: null          },
  'Switch Cart':            { class: 'Item', effect: 'speed',         forType: null          },
  'Ultra Ball':             { class: 'Item', effect: 'search',        forType: null          },
  'Unown N':                { class: 'Item', effect: 'draw',          forType: null          },
  'Unown V':                { class: 'Item', effect: 'damage',        forType: null          },
  'Venture Spell':          { class: 'Item', effect: 'search',        forType: null          },
  'X Attack':               { class: 'Item', effect: 'damage',        forType: null          },
  'Zinc':                   { class: 'Item', effect: 'damage',        forType: null          },

  // ══════════════════════════════════════════════════════════════════
  // POKÉMON TOOLS  (attach to Pokémon, passive)
  // ══════════════════════════════════════════════════════════════════

  'Beastite':              { class: 'Tool', effect: 'ability',       forType: null          }, // grants Beast Power (Ultra Beasts only)
  'Big Air Balloon':       { class: 'Tool', effect: 'speed',         forType: null          }, // -2 Retreat Cost
  'Dark Pendant':          { class: 'Tool', effect: 'damage',        forType: 'Darkness'    }, // +10 damage for Darkness attacks
  'Giant Cape':            { class: 'Tool', effect: 'survivability', forType: null          }, // +20 max HP
  'Heavy Helmet':          { class: 'Tool', effect: 'damage',        forType: null          }, // 30 damage to attacker each turn
  'Leaf Cape':             { class: 'Tool', effect: 'survivability', forType: 'Grass'       }, // +20 max HP to Grass Pokémon
  'Leftovers':             { class: 'Tool', effect: 'heal',          forType: null          }, // heal 10 HP between turns
  'Lucky Ice Pop':         { class: 'Tool', effect: 'heal',          forType: null          }, // once per turn heal 20, then discard
  'Lucky Mittens':         { class: 'Tool', effect: 'survivability', forType: null          }, // survive at 10 HP once
  'Memory Light':          { class: 'Tool', effect: 'ability',       forType: null          }, // copy attacks from discard
  'Metal Core Barrier':    { class: 'Tool', effect: 'survivability', forType: 'Metal'       }, // -20 damage taken by Metal Pokémon
  'Poison Barb':           { class: 'Tool', effect: 'disruption',    forType: null          }, // poisons attacker
  'Protective Poncho':     { class: 'Tool', effect: 'survivability', forType: null          }, // prevents status conditions
  'Quick-Grow Extract':    { class: 'Tool', effect: 'speed',         forType: null          }, // skip evolution requirement
  'Rescue Scarf':          { class: 'Tool', effect: 'survivability', forType: null          }, // return to hand when KO'd
  'Rocky Helmet':          { class: 'Tool', effect: 'damage',        forType: null          }, // 20 damage to attacker on contact
  'Steel Apron':           { class: 'Tool', effect: 'survivability', forType: null          }, // -30 damage from EX attacks (universal)
  // Forward-looking
  'Black Belt':            { class: 'Tool', effect: 'damage',        forType: null          },
  'Bone Helmet':           { class: 'Tool', effect: 'damage',        forType: null          },
  'Bravery Charm':         { class: 'Tool', effect: 'survivability', forType: null          },
  'Choice Band':           { class: 'Tool', effect: 'damage',        forType: null          },
  'Counter Catcher':       { class: 'Tool', effect: 'switch',        forType: null          },
  'Exp. Share':            { class: 'Tool', effect: 'energy',        forType: null          },
  'Float Stone':           { class: 'Tool', effect: 'speed',         forType: null          },
  'Forest Seal Stone':     { class: 'Tool', effect: 'ability',       forType: null          },
  'Healing Scarf':         { class: 'Tool', effect: 'heal',          forType: null          },
  "Hero's Cape":           { class: 'Tool', effect: 'survivability', forType: null          },
  'Metronome':             { class: 'Tool', effect: 'damage',        forType: null          },
  'Mirror Herb':           { class: 'Tool', effect: 'draw',          forType: null          },
  'Scope Lens':            { class: 'Tool', effect: 'damage',        forType: null          },
  'Shell Bell':            { class: 'Tool', effect: 'heal',          forType: null          },

  // ══════════════════════════════════════════════════════════════════
  // STADIUMS  (field effect, replaced by opponent's)
  // ══════════════════════════════════════════════════════════════════

  'Mesagoza':              { class: 'Stadium', effect: 'damage',     forType: null          }, // +10 damage for EX Pokémon
  'Peculiar Plaza':        { class: 'Stadium', effect: 'heal',       forType: null          }, // heal 10 HP each turn
  'Starting Plains':       { class: 'Stadium', effect: 'speed',      forType: null          }, // -1 Retreat Cost for Basic Pokémon
  'Training Area':         { class: 'Stadium', effect: 'energy',     forType: null          }, // attach extra Energy once per turn

};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string} cardName @returns {'Supporter'|'Item'|'Tool'|'Stadium'|null} */
export function getTrainerClass(cardName) {
  return TRAINER_CLASSES[cardName]?.class ?? null;
}

/** @param {string} cardName @returns {string|null} */
export function getTrainerEffect(cardName) {
  return TRAINER_CLASSES[cardName]?.effect ?? null;
}

/**
 * Returns the type this trainer is optimised for, or null if universal.
 * @param {string} cardName
 * @returns {string|null}
 */
export function getTrainerForType(cardName) {
  return TRAINER_CLASSES[cardName]?.forType ?? null;
}

/**
 * Returns true when a trainer card is compatible with a given deck type.
 * Universal cards (forType === null) are compatible with every deck type.
 * @param {string} cardName
 * @param {string} deckType  e.g. "Fire", "Water", "Lightning" …
 * @returns {boolean}
 */
export function isTypeCompatible(cardName, deckType) {
  const ft = TRAINER_CLASSES[cardName]?.forType ?? null;
  return ft === null || ft === deckType;
}

/** @param {string} cardName @returns {boolean} */
export function isSupporter(cardName) { return getTrainerClass(cardName) === 'Supporter'; }
export function isItem(cardName)      { return getTrainerClass(cardName) === 'Item';      }
export function isTool(cardName)      { return getTrainerClass(cardName) === 'Tool';      }
export function isStadium(cardName)   { return getTrainerClass(cardName) === 'Stadium';   }
