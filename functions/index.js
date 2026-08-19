/**
 * Kept — Cloud Functions (2nd gen).
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
const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {setGlobalOptions} = require('firebase-functions/v2');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const sharp = require('sharp');
const archiver = require('archiver');
const crypto = require('crypto');

admin.initializeApp();

// us-east1 matches the Storage bucket, so reads are same-region
setGlobalOptions({region: 'us-east1', maxInstances: 10});

// Anthropic API key for handwriting transcription (see transcribeCard).
// Set with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Access model: each user owns tinyCards/{uid}. Read access to another user's
// space is granted by a `viewOf` custom claim (see redeemInvite). Mirrors rules.

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
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const ref = db.collection('tinyCards').doc(auth.uid);   // caller's own space
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

/**
 * Export the whole archive as a single streaming ZIP: every card's images at
 * full quality, a metadata.csv, and a README. Owner-only. Streamed with
 * archiver in "store" mode (images are already compressed) so memory stays flat
 * regardless of how big the archive grows.
 *
 * onRequest (not onCall) so the browser can download the response directly. Auth
 * is a Firebase ID token, accepted either as `?token=` (so a plain navigation
 * can stream the file straight to disk) or as a Bearer header. The token is
 * short-lived; only the owner's verified email is allowed through.
 */
const clean = (s) => String(s == null ? '' : s).replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function cardBase(card) {
  return (card.date || 'Date') + ' ' + (clean(card.occasion) || 'Occasion') +
    (card.recipient ? ' - ' + clean(card.recipient) : '') +
    ' from ' + (clean(card.sender) || 'Sender');
}
const README = [
  'Kept — backup export',
  '',
  'A complete backup of your cards.',
  '',
  "WHAT'S HERE",
  '  cards/         Every card image at full quality. Each filename describes the',
  '                 card: "<date> <occasion> - <recipient> from <sender> - <page>".',
  '  metadata.csv   Every card\'s details (sender, recipient, occasion, date, pages,',
  '                 filenames). Opens in any spreadsheet app.',
  '',
  'BROWSE IT OFFLINE',
  '  Open  https://kept.cards/viewer.html  and choose this folder. It',
  '  reads the filenames and shows your cards with their details — the images',
  '  themselves need no account or connection.',
  '',
  'Keep this folder somewhere safe (an external drive, another cloud). Re-export',
  'any time to capture newly scanned cards.',
  ''
].join('\n');

exports.exportAll = onRequest({memory: '512MiB', timeoutSeconds: 3600}, async (req, res) => {
  // --- auth: verified owner only ---
  const token = req.query.token || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).send('Sign in required.'); return; }
  let user;
  try { user = await admin.auth().verifyIdToken(String(token)); }
  catch (e) { res.status(401).send('Session expired — reopen the app and try again.'); return; }
  if (!user.email_verified) {
    res.status(403).send('Sign in with a verified account to export.'); return;
  }

  const snap = await admin.firestore().collection('tinyCards').doc(user.uid).get();
  const cards = (snap.exists && snap.data().cards) || [];

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="kept-backup-${stamp}.zip"`);

  const archive = archiver('zip', {store: true});   // images are already compressed
  archive.on('warning', (err) => logger.warn('archive warning: ' + err.message));
  archive.on('error', (err) => { logger.error('archive error', err); try { res.destroy(err); } catch (_) {} });
  archive.pipe(res);

  const bucket = admin.storage().bucket();
  const rows = [['id', 'sender', 'recipient', 'occasion', 'date', 'pages', 'files', 'storagePaths', 'totalBytes', 'savedAt'].join(',')];

  for (const card of cards) {
    const paths = card.paths || [];
    const labels = card.labels || [];
    const base = cardBase(card);
    const names = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const ext = /\.png$/i.test(p) ? 'png' : 'jpg';
      const label = labels[i] || ('p' + (i + 1));
      const name = paths.length > 1 ? `${base} - ${label}.${ext}` : `${base}.${ext}`;
      names.push(name);
      archive.append(bucket.file(p).createReadStream(), {name: `cards/${name}`});
    }
    rows.push([
      csvCell(card.id), csvCell(card.sender), csvCell(card.recipient), csvCell(card.occasion),
      csvCell(card.date), csvCell(paths.length), csvCell(names.join(' | ')),
      csvCell(paths.join(' | ')), csvCell(card.totalBytes || ''), csvCell(card.savedAt || '')
    ].join(','));
  }

  archive.append(rows.join('\n') + '\n', {name: 'metadata.csv'});
  archive.append(README, {name: 'README.txt'});
  await archive.finalize();
});

/**
 * Sharing by email (no links, no approval). The owner names an email to share
 * with; access is a `viewOf` custom claim, granted the moment that Google-verified
 * email signs in (syncSharedAccess) — or immediately, if the account already
 * exists. The rules check the claim, so access is per-Google-account and revocable.
 * All run with the Admin SDK, so they bypass rules and are the only writers of
 * viewerInvites / emailGrants / sharedWithMe.
 */
// Per-space sharing: a viewer's `viewOf` custom claim lists the owner uids whose
// archives they may read. Both the Firestore and Storage rules check it. This
// helper mutates that array while preserving the user's other custom claims.
async function setViewOf(uid, mutate) {
  const u = await admin.auth().getUser(uid);
  const claims = u.customClaims || {};
  const set = new Set(claims.viewOf || []);
  mutate(set);
  await admin.auth().setCustomUserClaims(uid, Object.assign({}, claims, {viewOf: Array.from(set)}));
}
function requireVerified(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!auth.token.email_verified) throw new HttpsError('permission-denied', 'Verified email required.');
}
// Normalize an email for matching: lowercase + trim; for gmail/googlemail also
// strip dots and +tags in the local part so address variants map to one key.
function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return '';
  let local = e.slice(0, at), domain = e.slice(at + 1);
  if (!local || domain.indexOf('.') < 0) return '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

// Owner grants view access to an email. If a verified account already exists for
// it, the claim is set immediately (the viewer picks it up on their next open);
// otherwise it's stored and granted when that email first signs in (syncSharedAccess).
exports.inviteViewer = onCall(async (req) => {
  const auth = req.auth;
  requireVerified(auth);
  const ownerUid = auth.uid;
  const rawEmail = String((req.data && req.data.email) || '').trim();
  const key = normEmail(rawEmail);
  if (!key) throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  if (key === normEmail(auth.token.email || '')) {
    throw new HttpsError('failed-precondition', 'That is your own account.');
  }
  const db = admin.firestore();
  let status = 'invited', viewerUid = null;
  // Grant now if the person already has a verified account.
  let existing = null;
  try { existing = await admin.auth().getUserByEmail(rawEmail); } catch (e) { existing = null; }
  if (existing && existing.emailVerified && existing.uid !== ownerUid) {
    viewerUid = existing.uid; status = 'active';
    await setViewOf(viewerUid, (s) => s.add(ownerUid));
    const owner = await admin.auth().getUser(ownerUid).catch(() => null);
    await db.doc('sharedWithMe/' + viewerUid + '/spaces/' + ownerUid).set({
      ownerEmail: (owner && owner.email) || '', at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }
  await db.doc('viewerInvites/' + ownerUid + '/emails/' + key).set({
    email: rawEmail, invitedAt: admin.firestore.FieldValue.serverTimestamp(), status, viewerUid,
  });
  await db.doc('emailGrants/' + key + '/owners/' + ownerUid).set({
    invitedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {status};
});

// Called by the client right after sign-in / on app open: turns any email-invites
// for the caller's verified email into a real `viewOf` claim + rosters. Idempotent.
exports.syncSharedAccess = onCall(async (req) => {
  const auth = req.auth;
  requireVerified(auth);
  const uid = auth.uid;
  const key = normEmail(auth.token.email || '');
  if (!key) return {granted: []};
  const db = admin.firestore();
  const owners = await db.collection('emailGrants').doc(key).collection('owners').get();
  if (owners.empty) return {granted: []};

  const u = await admin.auth().getUser(uid);
  const claims = u.customClaims || {};
  const have = new Set(claims.viewOf || []);
  const granted = [];
  for (const d of owners.docs) {
    const ownerUid = d.id;
    if (ownerUid === uid) continue;
    if (!have.has(ownerUid)) { have.add(ownerUid); granted.push(ownerUid); }
    // Idempotent rosters + status, so a re-run also repairs any gaps.
    const owner = await admin.auth().getUser(ownerUid).catch(() => null);
    await db.doc('sharedWithMe/' + uid + '/spaces/' + ownerUid).set({
      ownerEmail: (owner && owner.email) || '', at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    await db.doc('viewerInvites/' + ownerUid + '/emails/' + key).set({
      status: 'active', viewerUid: uid,
    }, {merge: true});
  }
  if (granted.length) {
    await admin.auth().setCustomUserClaims(uid, Object.assign({}, claims, {viewOf: Array.from(have)}));
  }
  return {granted};
});

// Owner removes an email's access: strips the claim + rosters if it was active,
// and clears the invite either way (covers "cancel invite" and "remove viewer").
exports.revokeViewer = onCall(async (req) => {
  const auth = req.auth;
  requireVerified(auth);
  const ownerUid = auth.uid;
  const key = normEmail(String((req.data && req.data.email) || ''));
  if (!key) throw new HttpsError('invalid-argument', 'Missing email.');
  const db = admin.firestore();
  const inviteRef = db.doc('viewerInvites/' + ownerUid + '/emails/' + key);
  const snap = await inviteRef.get();
  const viewerUid = snap.exists ? (snap.data().viewerUid || null) : null;
  if (viewerUid) {
    await setViewOf(viewerUid, (s) => s.delete(ownerUid));
    await db.doc('sharedWithMe/' + viewerUid + '/spaces/' + ownerUid).delete().catch(() => {});
  }
  await inviteRef.delete().catch(() => {});
  await db.doc('emailGrants/' + key + '/owners/' + ownerUid).delete().catch(() => {});
  return {ok: true};
});

// (The one-off `migrateFamily` function was removed after the family → per-uid
// migration completed; the original `family` data is kept as a backup.)

/**
 * On-demand handwriting transcription. Owner-only: the callable wrapper verifies
 * the Firebase ID token (same guarantee as the export function) and we only ever
 * read/write the caller's own tinyCards/{uid}. Fetches the card's inside image
 * from Storage, sends it to Claude, and auto-saves the text onto the card before
 * any edit. A silent lifetime cap guards against runaway API cost.
 */
const TRANSCRIBE_CAP = 300;          // lifetime transcriptions per user
const TRANSCRIBE_MAX_PX = 1.5e6;     // downscale bigger images to control token cost
const TRANSCRIBE_PROMPT =
  'Transcribe this handwritten card message exactly as written. Preserve line ' +
  'breaks. Output only the transcription, no commentary.';

exports.transcribeCard = onCall(
  {secrets: [ANTHROPIC_API_KEY], memory: '1GiB', timeoutSeconds: 120},
  async (req) => {
    const auth = req.auth;
    requireVerified(auth);                                   // verified owner only
    const uid = auth.uid;
    const cardId = String((req.data && req.data.cardId) || '').trim();
    const path = String((req.data && req.data.path) || '').trim();
    if (!cardId || !path) throw new HttpsError('invalid-argument', 'Missing cardId or path.');

    const db = admin.firestore();
    const usageRef = db.collection('transcriptions').doc(uid);
    const cardsRef = db.collection('tinyCards').doc(uid);

    // 1) Usage cap — read the counter (missing doc = 0). Enforced before any API call.
    const usageSnap = await usageRef.get();
    const count = (usageSnap.exists && Number(usageSnap.data().count)) || 0;
    if (count >= TRANSCRIBE_CAP) throw new HttpsError('resource-exhausted', 'limit-reached');

    // 2) Load the card from the caller's own space and verify the supplied path
    //    actually belongs to it — never trust a client Storage path on its own.
    const cardsSnap = await cardsRef.get();
    const rows = (cardsSnap.exists && cardsSnap.data().cards) || [];
    const card = rows.find((c) => c && c.id === cardId);
    if (!card) throw new HttpsError('not-found', 'Card not found.');
    if (!Array.isArray(card.paths) || card.paths.indexOf(path) === -1) {
      throw new HttpsError('permission-denied', 'That image is not part of this card.');
    }

    // 3) Fetch + downscale the image (EXIF-rotated, JPEG, <=~1.5 MP).
    let b64;
    try {
      const [buf] = await admin.storage().bucket().file(path).download();
      let img = sharp(buf).rotate();
      const meta = await img.metadata();
      const px = (meta.width || 0) * (meta.height || 0);
      if (px > TRANSCRIBE_MAX_PX && meta.width) {
        img = img.resize({width: Math.round(meta.width * Math.sqrt(TRANSCRIBE_MAX_PX / px))});
      }
      b64 = (await img.jpeg({quality: 82}).toBuffer()).toString('base64');
    } catch (e) {
      logger.error('transcribe: image load failed', e);
      throw new HttpsError('unavailable', 'transcription-failed');
    }

    // 4) Claude — transcribe exactly. Any failure here must NOT touch the counter.
    let text;
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY.value(),
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: b64}},
              {type: 'text', text: TRANSCRIBE_PROMPT},
            ],
          }],
        }),
      });
      if (!resp.ok) {
        logger.error('transcribe: API ' + resp.status + ' ' + (await resp.text().catch(() => '')));
        throw new Error('api ' + resp.status);
      }
      const data = await resp.json();
      text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw new Error('empty transcription');
    } catch (e) {
      logger.error('transcribe: API failed', e);
      throw new HttpsError('unavailable', 'transcription-failed');
    }

    // 5) Success — atomically save the text onto the card AND bump the counter, so
    //    a concurrent client edit can't be clobbered and usage only rises on success.
    await db.runTransaction(async (tx) => {
      const s = await tx.get(cardsRef);
      const cur = (s.exists && s.data().cards) || [];
      const i = cur.findIndex((c) => c && c.id === cardId);
      if (i < 0) throw new HttpsError('not-found', 'Card not found.');
      cur[i] = Object.assign({}, cur[i], {transcription: text});
      tx.set(cardsRef, {cards: cur, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      tx.set(usageRef, {count: admin.firestore.FieldValue.increment(1),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    });

    return {text};
  }
);
