/* The build stamp answers one question — "is the page in front of me the
   current one?" — so it must not depend on anyone remembering to edit it. It
   sat unchanged through eight commits before that was noticed, and the two
   copies had drifted apart from each other as well.

   It is rewritten in the sources rather than in www/, because GitHub Pages
   serves kept.cards from the repository root (CNAME + .nojekyll): a
   placeholder left behind here would ship to the live site as a placeholder.
   So every build dirties these two files by one line. That is the point. */
const fs = require('fs');

const FILES = ['cards.html', 'scan.html'];
const RE = /(class="setver">)v[0-9.]+/g;

const d = new Date(), p = n => String(n).padStart(2, '0');
// Minutes, not a hand-kept counter: several builds a day is normal, and a
// date alone can't tell two of them apart — the failure we just had.
const stamp = `v${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;

// Read and check every file before writing any of them, so a markup change
// can't leave half the pages stamped and half of them stale.
const sources = FILES.map(f => [f, fs.readFileSync(f, 'utf8')]);
const found = sources.reduce((n, [, src]) => n + (src.match(RE) || []).length, 0);

// Silence here would recreate exactly the bug this script exists to prevent.
if (found !== FILES.length) {
  console.error(`stamp: expected ${FILES.length} build stamps, found ${found} — has the markup changed?`);
  process.exit(1);
}

for (const [f, src] of sources) {
  const out = src.replace(RE, `$1${stamp}`);
  if (out !== src) fs.writeFileSync(f, out);
}
console.log(`stamped ${stamp}`);
