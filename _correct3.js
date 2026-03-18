const fs = require('fs');
const html = fs.readFileSync('ptcgp-meta-engine.html', 'utf8');
const m = html.match(/(const FULL_CARD_DB = \[)([\s\S]*?)(\];)/);
if (!m) { console.error('FULL_CARD_DB not found'); process.exit(1); }

const cards = JSON.parse('[' + m[2] + ']');

// All corrections based on PTCGP energy types:
// - Dragon/Flying, Dragon → Dragon energy
// - Ice/Dragon, Ice → Water energy
// - Normal/Flying → Colorless energy
// - Dark/Fire → Dark energy (Dark primary)
// - Poison → Dark energy
const FIXES = {
  // Fire → Colorless (Normal/Flying)
  'Fletchling': 'Colorless',
  // Fire → Dark (Dark/Fire, Dark primary)
  'Houndour': 'Dark',
  'Houndoom': 'Dark',
  // Fire → Dragon (Dragon/Flying)
  'Bagon': 'Dragon',
  // Grass → Colorless (Normal/Flying)
  'Swablu': 'Colorless',
  // Grass → Dragon (Dragon line)
  'Altaria': 'Dragon',
  'Shelgon': 'Dragon',
  'Goodra': 'Dragon',   // Goomy/Sliggoo are Dragon, Goodra must match
  // Grass → Water (Ice/Dragon, Ice uses Water energy)
  'Frigibax': 'Water',
  // Fighting → Dragon (pure Dragon)
  'Druddigon': 'Dragon',
  // Fighting → Water (Ice/Dragon)
  'Arctibax': 'Water',
  // Colorless → Water
  'Baxcalibur': 'Water',
  'Carracosta': 'Water',
  // Colorless → Dragon (Dragon/Flying)
  'Salamence': 'Dragon',
  // Water → Lightning (Water/Electric, uses Lightning energy)
  'Lanturn ex': 'Lightning',
  // Psychic → Dark (Poison type uses Dark energy)
  'Seviper': 'Dark',
};

let changes = 0;
cards.forEach(card => {
  if (FIXES[card.name] && card.type !== FIXES[card.name]) {
    console.log(`  ${card.name}: ${card.type} → ${FIXES[card.name]}`);
    card.type = FIXES[card.name];
    changes++;
  }
});

console.log(`\nTotal cards changed: ${changes}`);

// Verify counts
const counts = {};
cards.forEach(c => { counts[c.type] = (counts[c.type]||0)+1; });
console.log('\nFinal counts:');
['Grass','Trainer','Fire','Water','Lightning','Psychic','Fighting','Dark','Metal','Colorless','Dragon'].forEach(t => {
  console.log(`  ${t}: ${counts[t]||0}`);
});

// Patch HTML
const newBlock = JSON.stringify(cards, null, 2).slice(1, -1);
const newHtml = html.replace(/(const FULL_CARD_DB = \[)([\s\S]*?)(\];)/, m[1] + newBlock + '\n' + m[3]);
fs.writeFileSync('ptcgp-meta-engine.html', newHtml);
console.log('\n✓ ptcgp-meta-engine.html patched');
