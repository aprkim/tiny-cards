/* The build stamp answers one question — "is the page in front of me the
   current one?" — so it must not depend on anyone remembering to edit it. It
   sat unchanged through eight commits before that was noticed, and the two
   copies had drifted apart from each other as well.

   It is rewritten in the sources rather than in www/, because GitHub Pages
   serves kept.cards from the repository root (CNAME + .nojekyll): a
   placeholder left behind here would ship to the live site as a placeholder.
   So every build dirties these two files by one line. That is the point.

   Two markers on the Settings legal line: the user-facing version (.setmv,
   e.g. 1.0.1) and the build stamp (.setver, e.g. v2026.09.16.2208). The
   version is read from the Xcode project so it can't drift from what ships to
   the App Store; the stamp is the wall-clock minute, which is what tells two
   builds of the same version apart during testing. */
const fs = require('fs');

const FILES = ['cards.html', 'scan.html'];
const RE_VER = /(class="setver">)v[0-9.]+/g;
const RE_MV = /(class="setmv">)[0-9][A-Za-z0-9.\-]*/g;

// Marketing version, straight from the Xcode project — the same string that
// becomes the App Store version, so Settings can never disagree with the store.
const PBX = 'ios/App/App.xcodeproj/project.pbxproj';
const mvMatch = fs.readFileSync(PBX, 'utf8').match(/MARKETING_VERSION = ([0-9][A-Za-z0-9.\-]*);/);
if (!mvMatch) {
  console.error(`stamp: MARKETING_VERSION not found in ${PBX}`);
  process.exit(1);
}
const mv = mvMatch[1];

const d = new Date(), p = n => String(n).padStart(2, '0');
// Minutes, not a hand-kept counter: several builds a day is normal, and a
// date alone can't tell two of them apart — the failure we just had.
const stamp = `v${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;

// Read and check every file before writing any of them, so a markup change
// can't leave half the pages stamped and half of them stale.
const sources = FILES.map(f => [f, fs.readFileSync(f, 'utf8')]);
const foundVer = sources.reduce((n, [, src]) => n + (src.match(RE_VER) || []).length, 0);
const foundMv = sources.reduce((n, [, src]) => n + (src.match(RE_MV) || []).length, 0);

// Silence here would recreate exactly the bug this script exists to prevent.
if (foundVer !== FILES.length || foundMv !== FILES.length) {
  console.error(`stamp: expected ${FILES.length} of each marker, found setver=${foundVer} setmv=${foundMv} — has the markup changed?`);
  process.exit(1);
}

for (const [f, src] of sources) {
  const out = src.replace(RE_VER, `$1${stamp}`).replace(RE_MV, `$1${mv}`);
  if (out !== src) fs.writeFileSync(f, out);
}
console.log(`stamped ${stamp} (v${mv})`);
