/**
 * Tiny Cards — Cloud Functions (2nd gen).
 *
 * v2 throughout: it runs on Cloud Run, supports response streaming and a
 * 60-minute timeout, which the streaming ZIP export needs. There is no v1
 * here to migrate from — this codebase starts on v2.
 *
 * Thumbnails are ADDITIVE. Masters are never rewritten, resized or replaced;
 * a `_thumb` sibling is written next to each one. Storage is cheap, egress is
 * not, so the archive grid loads thumbnails while the full image is fetched
 * only when a card is actually opened.
 */

const {onObjectFinalized} = require('firebase-functions/v2/storage');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {setGlobalOptions} = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const sharp = require('sharp');

admin.initializeApp();

// us-east1 matches the Storage bucket, so reads are same-region
setGlobalOptions({region: 'us-east1', maxInstances: 10});

// Access model: one shared space, owner decided by email — mirrors the rules
const SPACE = 'family';
const OWNER_EMAIL = 'aprkim@gmail.com';

const THUMB_MAX = 400;          // long edge; covers a 2x retina grid tile
const THUMB_QUALITY = 78;
const THUMB_SUFFIX = '_thumb.jpg';

const isThumb = (p) => p.endsWith(THUMB_SUFFIX);
const thumbPathFor = (p) => p.replace(/\.[^.]+$/, '') + THUMB_SUFFIX;

/** cards/{space}/{cardId}/{label}.jpg — anything else is ignored. */
function parseCardPath(p) {
  const m = /^cards\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
  return m ? {space: m[1], cardId: m[2], name: m[3]} : null;
}

async function makeThumb(bucket, srcPath) {
  const dstPath = thumbPathFor(srcPath);
  const src = bucket.file(srcPath);
  const dst = bucket.file(dstPath);

  // Idempotent: the backfill and the trigger can both reach the same object,
  // and a redeploy can replay events.
  const [exists] = await dst.exists();
  if (exists) return {skipped: true, dstPath};

  const [buf] = await src.download();
  const out = await sharp(buf)
    .rotate()                                  // honour EXIF orientation
    .resize({width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true})
    .jpeg({quality: THUMB_QUALITY, mozjpeg: true})
    .toBuffer();

  await dst.save(out, {
    contentType: 'image/jpeg',
    metadata: {cacheControl: 'public, max-age=31536000, immutable'},
    resumable: false,
  });

  return {skipped: false, dstPath, srcBytes: buf.length, thumbBytes: out.length};
}

/** New upload → write a thumbnail beside it. The master is left alone. */
exports.makeThumbnail = onObjectFinalized({memory: '1GiB', timeoutSeconds: 120}, async (event) => {
  const p = event.data.name || '';
  if (isThumb(p)) return;                       // don't thumbnail a thumbnail
  if (!parseCardPath(p)) return;                // not a card page
  if (!(event.data.contentType || '').startsWith('image/')) return;

  try {
    const r = await makeThumb(admin.storage().bucket(event.data.bucket), p);
    logger.info(r.skipped ? `thumb exists, skipped: ${p}` : `thumb written: ${r.dstPath}`);
  } catch (err) {
    // Never throw: a failed thumbnail must not affect the master or the upload
    logger.error(`thumb failed for ${p}: ${err.message}`);
  }
});

/**
 * Backfill for cards uploaded before thumbnails existed, and for byte sizes
 * that were never recorded. Owner-only, resumable, and safe to run repeatedly
 * — it skips anything already done.
 */
exports.backfill = onCall({memory: '2GiB', timeoutSeconds: 540}, async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!auth.token.email_verified) throw new HttpsError('permission-denied', 'Verified email required.');
  // Owner-only, judged by email like the rules — viewers cannot trigger work
  if (auth.token.email !== OWNER_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the archive owner can run the backfill.');
  }

  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const ref = db.collection('tinyCards').doc(SPACE);
  const snap = await ref.get();
  if (!snap.exists) return {cards: 0, thumbs: 0, sized: 0};

  const cards = (snap.data().cards || []).slice();
  let thumbs = 0, sized = 0, failed = 0;

  for (const card of cards) {
    const paths = card.paths || [];
    const bytes = [];
    for (const p of paths) {
      try {
        const r = await makeThumb(bucket, p);
        if (!r.skipped) thumbs++;
        if (typeof r.srcBytes === 'number') bytes.push(r.srcBytes);
        else {
          const [md] = await bucket.file(p).getMetadata();
          bytes.push(Number(md.size) || 0);
        }
      } catch (err) {
        logger.error(`backfill failed for ${p}: ${err.message}`);
        failed++;
        bytes.push(0);
      }
    }
    // Only fill in sizes that are missing; never overwrite what the client recorded
    if (!Array.isArray(card.bytes) || card.bytes.length !== paths.length) {
      card.bytes = bytes;
      card.totalBytes = bytes.reduce((a, b) => a + b, 0);
      sized++;
    }
  }

  await ref.set({cards, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  return {cards: cards.length, thumbs, sized, failed};
});
