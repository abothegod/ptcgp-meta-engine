const fs = require('fs');
const html = fs.readFileSync('ptcgp-meta-engine.html','utf8');
const m = html.match(/FULL_CARD_DB\s*=\s*\[([\s\S]*?)\];/);
const cards = JSON.parse('[' + m[1] + ']');

const checks = [
  // Poison → Psychic
  ['Ekans','Psychic'], ['Arbok','Psychic'], ['Grimer','Psychic'], ['Muk','Psychic'],
  ['Koffing','Psychic'], ['Weezing','Psychic'], ['Zubat','Psychic'], ['Crobat','Psychic'],
  ['Nidoran\u2640','Psychic'], ['Nidoking','Psychic'], ['Seviper','Psychic'],
  ['Trubbish','Psychic'], ['Garbodor','Psychic'], ['Mareanie','Psychic'],
  ['Toxicroak','Psychic'], ['Nihilego','Psychic'], ['Poipole','Psychic'],
  ['Paldean Wooper','Psychic'], ['Paldean Clodsire','Psychic'],
  ['Skrelp','Psychic'], ['Dragalge','Psychic'], ['Qwilfish','Psychic'],
  // Fairy → Psychic
  ['Clefairy','Psychic'], ['Cleffa','Psychic'], ['Igglybuff','Psychic'],
  ['Jigglypuff','Psychic'], ['Wigglytuff','Psychic'], ['Azurill','Psychic'],
  ['Marill','Psychic'], ['Azumarill','Psychic'], ['Togepi','Psychic'],
  ['Togekiss','Psychic'], ['Snubbull','Psychic'], ['Carbink','Psychic'],
  ['Fidough','Psychic'], ['Dachsbun','Psychic'],
  // Dragon/Poison → Dragon
  ['Naganadel','Dragon'],
  // Grass/Water → Water
  ['Lotad','Water'], ['Lombre','Water'], ['Ludicolo','Water'],
  ['Surskit','Water'], ['Masquerain','Water'],
  // Bug/Steel → Metal
  ['Ferroseed','Metal'], ['Ferrothorn','Metal'], ['Karrablast','Metal'],
  // Ghost/Ice → Psychic
  ['Froslass','Psychic'],
  // Dark/Fire → Dark
  ['Houndour','Dark'], ['Houndoom','Dark'],
  // Dragon line
  ['Bagon','Dragon'], ['Shelgon','Dragon'], ['Salamence','Dragon'],
  // Normal/Flying → Colorless
  ['Fletchling','Colorless'], ['Swablu','Colorless'],
];

let pass = 0, fail = 0;
checks.forEach(([name, expected]) => {
  const found = cards.find(c => c.name === name);
  if (!found) { console.log('MISSING: ' + name); fail++; return; }
  if (found.type !== expected) {
    console.log('FAIL  ' + name + ': got ' + found.type + ', expected ' + expected);
    fail++;
  } else {
    pass++;
  }
});

console.log('\n--- Type counts ---');
const d = {};
cards.forEach(c => { d[c.type] = (d[c.type]||0)+1; });
Object.entries(d).sort((a,b) => b[1]-a[1]).forEach(([t,n]) => console.log(t + ': ' + n));
console.log('\nPassed: ' + pass + ' / ' + (pass+fail));
if (fail) console.log('Failed: ' + fail);
