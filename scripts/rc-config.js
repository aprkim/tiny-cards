/* Writes www/rc-config.js — the RevenueCat public iOS SDK key — from the
   REVENUECAT_IOS_KEY environment variable at build time.

   The pages have no bundler and no runtime env, and the sources are served
   as-is on kept.cards, so the key must not live in a source file. www/ is the
   native bundle only (gitignored), and purchases.js requests rc-config.js only
   inside Capacitor, so the web site never asks for it.

   A missing key fails the build on purpose: a bundle without it would ship
   with purchases silently disabled, which is worse than a red build. */
const fs = require('fs');

const key = (process.env.REVENUECAT_IOS_KEY || '').trim();
if (!/^appl_[A-Za-z0-9]+$/.test(key)) {
  console.error('rc-config: REVENUECAT_IOS_KEY is not set (expected the public key, appl_...). Export it in your shell profile and rebuild.');
  process.exit(1);
}
fs.writeFileSync('www/rc-config.js', 'window.RC_IOS_KEY=' + JSON.stringify(key) + ';\n');
console.log('rc-config: wrote www/rc-config.js');
