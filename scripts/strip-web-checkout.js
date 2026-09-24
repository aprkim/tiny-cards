/* Blanks the Web Billing links in www/purchases.js.

   purchases.js is shared by kept.cards and the iOS bundle, and its web
   checkout path is already unreachable on native — canBuyWeb() returns false
   the moment Capacitor is present. This removes the link anyway.

   The reason is App Store guideline 3.1.1: an app may not steer users to buy
   outside the App Store. Unreachable code is not steering, but a reviewer who
   greps the bundle and finds a payment URL is an argument worth not having,
   and the argument costs a week of review each time it happens.

   A link that survives fails the build. Shipping the stripped file is the
   whole point, so "it didn't work but we carried on" is not an outcome. */
const fs = require('fs');

const path = 'www/purchases.js';
let src = fs.readFileSync(path, 'utf8');

let hits = 0;
src = src.replace(/^(\s*var WEB_(?:CHECKOUT|PORTAL)=)'[^']*';/gm, (m, head) => {
  hits++;
  return head + "'';";
});

if (hits !== 2) {
  console.error('strip-web-checkout: expected 2 link constants in ' + path + ', found ' + hits +
                '. purchases.js changed shape — fix this script before shipping.');
  process.exit(1);
}

fs.writeFileSync(path, src);

// Belt and braces: whatever the constants were called, no payment host may
// remain anywhere in the native copy.
const leak = /pay\.rev\.cat|checkout\.stripe\.com|buy\.stripe\.com/i.exec(src);
if (leak) {
  console.error('strip-web-checkout: ' + path + ' still contains "' + leak[0] + '" after stripping.');
  process.exit(1);
}
console.log('strip-web-checkout: web billing links removed from the native bundle');
