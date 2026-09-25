/* Writes www/rc-config.js — the RevenueCat public SDK keys — from the
   REVENUECAT_IOS_KEY and REVENUECAT_ANDROID_KEY environment variables at
   build time. purchases.js picks the one for the platform it wakes up on.

   The pages have no bundler and no runtime env, and the sources are served
   as-is on kept.cards, so the keys must not live in a source file. www/ is the
   native bundle only (gitignored), and purchases.js requests rc-config.js only
   inside Capacitor, so the web site never asks for it.

   A missing key fails the build on purpose: a bundle without it would ship
   with purchases silently disabled on that platform, which is worse than a
   red build. Both are public keys (appl_… / goog_…), never secret ones. */
const fs = require('fs');

const ios = (process.env.REVENUECAT_IOS_KEY || '').trim();
const android = (process.env.REVENUECAT_ANDROID_KEY || '').trim();
const bad = [];
if (!/^appl_[A-Za-z0-9]+$/.test(ios)) bad.push('REVENUECAT_IOS_KEY (expected the public key, appl_...)');
if (!/^goog_[A-Za-z0-9]+$/.test(android)) bad.push('REVENUECAT_ANDROID_KEY (expected the public key, goog_...)');
if (bad.length) {
  console.error('rc-config: not set: ' + bad.join('; ') + '. Export in your shell profile and rebuild.');
  process.exit(1);
}
fs.writeFileSync('www/rc-config.js',
  'window.RC_IOS_KEY=' + JSON.stringify(ios) + ';\n' +
  'window.RC_ANDROID_KEY=' + JSON.stringify(android) + ';\n');
console.log('rc-config: wrote www/rc-config.js (iOS + Android keys)');
