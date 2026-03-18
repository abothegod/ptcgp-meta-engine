const fs = require('fs');
const html = fs.readFileSync('ptcgp-meta-engine.html','utf8');
const m = html.match(/const FULL_CARD_DB = \[([\s\S]*?)\];/);
const cards = JSON.parse('[' + m[1] + ']');

function showType(type) {
  const list = cards.filter(c => c.type === type);
  const names = {};
  list.forEach(c => { names[c.name] = (names[c.name]||0)+1; });
  console.log(`\n=== ${type.toUpperCase()} (${list.length}) ===`);
  Object.keys(names).sort().forEach(n => process.stdout.write(`${n}(${names[n]}) `));
  console.log();
}

['Water','Lightning','Psychic','Fighting','Metal'].forEach(showType);
