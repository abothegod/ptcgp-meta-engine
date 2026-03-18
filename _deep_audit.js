const fs = require('fs');
const html = fs.readFileSync('ptcgp-meta-engine.html','utf8');
const m = html.match(/const FULL_CARD_DB = \[([\s\S]*?)\];/);
const cards = JSON.parse('[' + m[1] + ']');

// Show all cards per type sorted by name for manual review
function showType(type) {
  const list = cards.filter(c => c.type === type);
  const counts = {};
  list.forEach(c => { counts[c.name] = (counts[c.name]||0)+1; });
  console.log(`\n=== ${type.toUpperCase()} (${list.length}) ===`);
  Object.keys(counts).sort().forEach(n => console.log(`  ${n}: ${counts[n]}`));
}

showType('Fire');
showType('Dark');
showType('Grass');
showType('Colorless');
