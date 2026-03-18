const fs = require('fs');

const PTCGP_TYPE_OVERRIDES = {
  'Lotad':'Water','Lombre':'Water','Ludicolo':'Water',
  'Surskit':'Water','Masquerain':'Water',
  'Panpour':'Water','Simipour':'Water',
  'Ferroseed':'Metal','Ferrothorn':'Metal',
  'Karrablast':'Metal','Escavalier':'Metal',
  'Clefairy':'Psychic','Clefable':'Psychic','Cleffa':'Psychic',
  'Igglybuff':'Psychic','Jigglypuff':'Psychic','Wigglytuff':'Psychic','Wigglytuff ex':'Psychic',
  'Togepi':'Psychic','Togetic':'Psychic','Togekiss':'Psychic','Togekiss ex':'Psychic',
  'Snubbull':'Psychic','Granbull':'Psychic',
  'Azurill':'Psychic','Marill':'Psychic','Azumarill':'Psychic',
  'Cottonee':'Psychic','Whimsicott':'Psychic','Whimsicott ex':'Psychic',
  'Morelull':'Psychic','Shiinotic':'Psychic',
  'Carbink':'Psychic','Fidough':'Psychic','Dachsbun':'Psychic',
  'Froslass':'Psychic',
  'Ekans':'Psychic','Arbok':'Psychic',
  'Koffing':'Psychic','Weezing':'Psychic',
  'Grimer':'Psychic','Muk':'Psychic',
  'Seviper':'Psychic','Trubbish':'Psychic','Garbodor':'Psychic',
  'Zubat':'Psychic','Golbat':'Psychic','Crobat':'Psychic','Crobat ex':'Psychic',
  'Nidoran\u2640':'Psychic','Nidorina':'Psychic','Nidoqueen':'Psychic',
  'Nidoran\u2642':'Psychic','Nidorino':'Psychic','Nidoking':'Psychic',
  'Mareanie':'Psychic','Toxapex':'Psychic','Qwilfish':'Psychic',
  'Toxicroak':'Psychic',
  'Venipede':'Psychic','Whirlipede':'Psychic','Scolipede':'Psychic',
  'Paldean Wooper':'Psychic',
  'Paldean Clodsire':'Psychic','Paldean Clodsire ex':'Psychic',
  'Poipole':'Psychic','Nihilego':'Psychic',
  'Shroodle':'Psychic','Grafaiai':'Psychic',
  'Skrelp':'Psychic','Dragalge':'Psychic','Dragalge ex':'Psychic',
  'Naganadel':'Dragon','Naganadel ex':'Dragon',
};

const html = fs.readFileSync('ptcgp-meta-engine.html', 'utf8');
const m = html.match(/(const FULL_CARD_DB = \[)([\s\S]*?)(\];)/);
if (!m) { console.error('FULL_CARD_DB not found'); process.exit(1); }

const cards = JSON.parse('[' + m[2] + ']');
let changes = 0;
cards.forEach(card => {
  const override = PTCGP_TYPE_OVERRIDES[card.name];
  if (override && card.type !== override) {
    console.log(`  ${card.name}: ${card.type} → ${override}`);
    card.type = override;
    changes++;
  }
});

console.log(`\nTotal changed: ${changes}`);

const newBlock = JSON.stringify(cards, null, 2).slice(1, -1);
const newHtml = html.replace(/(const FULL_CARD_DB = \[)([\s\S]*?)(\];)/, m[1] + newBlock + '\n' + m[3]);
fs.writeFileSync('ptcgp-meta-engine.html', newHtml);
console.log('✓ ptcgp-meta-engine.html patched');
