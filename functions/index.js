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
const {onSchedule} = require('firebase-functions/v2/scheduler');
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

// A build that hasn't reported progress for this long is treated as dead, so a new
// request may start over. Heartbeats land every 25 files, seconds apart.
const EXPORT_STALE_MS = 2 * 60 * 1000;
// A finished export is handed out again, instead of rebuilt, for this long —
// provided the archive hasn't changed since. An interrupted download then
// costs a retry, not another two-minute build.
const EXPORT_REUSE_MS = 60 * 60 * 1000;
// A build whose output hasn't grown for this long is stuck — on 2026-09-11 an
// upload to Storage stalled for six minutes of library retries while the app
// watched 75% — so it is abandoned, recorded as failed, and a retry starts clean.
const EXPORT_STALL_MS = 90 * 1000;
// What an export contains, as one string: the card files in order. Any change
// to the archive changes it, so a stored export is only reused for the archive
// it was built from.
function cardsSig(cards) {
  const h = crypto.createHash('sha1');
  for (const c of cards) h.update((c.id || '') + '\n' + (c.paths || []).join('\n') + '\n');
  return h.digest('hex');
}
// What the app may see of an export job: only what it needs to follow or finish it.
function publicJob(d) {
  const o = {};
  for (const k of ['state', 'entries', 'total', 'startedAt', 'builtAt', 'readyAt', 'failedAt', 'url', 'size', 'filename']) {
    if (d[k] !== undefined) o[k] = d[k];
  }
  return o;
}

exports.exportAll = onRequest({
  // 1GiB while the new path proves itself. The version that streamed the ZIP to
  // the phone was killed at 512MiB having delivered 87 bytes, and why was never
  // pinned down; 'export progress' and 'export built' log RSS so the limit can
  // come back down once real exports show where it peaks.
  memory: '1GiB',
  timeoutSeconds: 3600,
  // One build per instance. A build sits around 330-350 MB; the 1,294 MiB kill on
  // 2026-09-11 was, most likely, retries stacking builds on one shared instance.
  concurrency: 1,
  // The app fetches this cross-origin — from https://kept.cards on the web and
  // from capacitor://localhost inside the iOS webview — so without an
  // Access-Control-Allow-Origin the browser discards the response before the
  // client can read it and the export fails instantly with "Failed to fetch".
  // An allowlist rather than `true`: the id token rides in the query string, so
  // there is no reason for arbitrary origins to be able to read the reply.
  cors: [
    'https://kept.cards',
    'capacitor://localhost',        // iOS native webview
    'ionic://localhost',            // older Capacitor scheme
    'http://localhost',             // local development
    'https://tiny-wins25.web.app',
    'https://tiny-wins25.firebaseapp.com',
  ],
}, async (req, res) => {
  // --- auth: verified owner only ---
  const token = req.query.token || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).send('Sign in required.'); return; }
  let user;
  try { user = await admin.auth().verifyIdToken(String(token)); }
  catch (e) { res.status(401).send('Session expired — reopen the app and try again.'); return; }
  if (!user.email_verified) {
    res.status(403).send('Sign in with a verified account to export.'); return;
  }

  /* Export runs as a job the app follows, not one long request it waits on. A
     532 MB archive takes about two minutes to build, and a phone won't hold a
     silent request open that long: on 2026-09-11 two builds finished here while
     the app had already given up and said it couldn't save. So ?status=1 answers
     at once from exportJobs/{uid}, which only this Admin SDK code writes. */
  const jobRef = admin.firestore().collection('exportJobs').doc(user.uid);
  const bucket = admin.storage().bucket();
  if (req.query.status) {
    const j = await jobRef.get();
    if (!j.exists) { res.json({state: 'none'}); return; }
    const d = j.data();
    // A build that stopped heartbeating died without reaching its catch (an
    // out-of-memory kill can't be caught), so report it as failed rather than
    // let the app wait out its deadline on a job that will never finish.
    if (d.state === 'building' && Date.now() - (d.heartbeatAt || 0) >= EXPORT_STALE_MS) {
      res.json(publicJob({state: 'failed', total: d.total, startedAt: d.startedAt, failedAt: d.heartbeatAt || d.startedAt}));
      return;
    }
    res.json(publicJob(d));
    return;
  }

  const snap = await admin.firestore().collection('tinyCards').doc(user.uid).get();
  const cards = (snap.exists && snap.data().cards) || [];
  const total = cards.reduce((n, c) => n + (c.paths || []).length, 0) + 2;   // + metadata.csv, README.txt

  // Claim the job atomically. If a live build already holds it, report that one
  // rather than starting another: a retry joins the build, it doesn't stack one.
  // If a recent finished export of this same archive is on record, hand that
  // out instead — readyAt is bumped so the app sees it as this export's result.
  const startedAt = Date.now();
  const sig = cardsSig(cards);
  const claim = (allowReuse) => admin.firestore().runTransaction(async (t) => {
    const s = await t.get(jobRef);
    const d = s.exists ? s.data() : null;
    if (d && d.state === 'building' && startedAt - (d.heartbeatAt || 0) < EXPORT_STALE_MS) return {running: d};
    if (allowReuse && d && d.state === 'ready' && d.sig === sig && d.objectName &&
        startedAt - (d.builtAt || 0) < EXPORT_REUSE_MS) return {reuse: d};
    t.set(jobRef, {state: 'building', startedAt, heartbeatAt: startedAt, entries: 0, total});
    return {};
  });
  let claimed = await claim(true);
  if (claimed.running) { res.json(publicJob(claimed.running)); return; }
  if (claimed.reuse) {
    const [stillThere] = await bucket.file(claimed.reuse.objectName).exists();
    if (stillThere) {
      const served = Object.assign({}, claimed.reuse, {readyAt: startedAt});
      await jobRef.set(served);
      logger.info('export reused', {uid: user.uid, objectName: served.objectName});
      res.json(publicJob(served));
      return;
    }
    claimed = await claim(false);                 // the object is gone: build it again
    if (claimed.running) { res.json(publicJob(claimed.running)); return; }
  }

  /* Build the ZIP into Cloud Storage and answer with a link, instead of streaming
     it to the caller. Streaming put the phone's connection inside the build: a
     536 MB export ran out of memory 88 seconds in, the client took the early end
     of the response for a finished download, and 87 bytes were saved as a backup.
     Now the build is Storage to Storage in one region, the upload stream applies
     backpressure, and the client downloads a finished object whose size it checks. */
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `kept-backup-${stamp}.zip`;
  const dest = bucket.file(`exports/${user.uid}/${Date.now()}-${filename}`);
  // A Firebase download token rather than a signed URL: signing needs signBlob on
  // the runtime service account, which this project doesn't grant. The link lives
  // only as long as the object — until the next export, cleanupExports, or
  // deleteAccount removes it.
  const downloadToken = crypto.randomUUID();
  let entries = 0, archive = null, out = null, fail = null;
  // Heartbeat only while bytes are actually moving, so a stalled build goes
  // quiet and the status check can call it dead; and past EXPORT_STALL_MS with
  // no growth, end it here rather than wait for the library to give up.
  let lastBytes = -1, lastGrowth = Date.now();
  const beat = setInterval(() => {
    const bytes = archive ? archive.pointer() : 0;
    if (bytes !== lastBytes) {
      lastBytes = bytes; lastGrowth = Date.now();
      jobRef.update({entries, heartbeatAt: lastGrowth}).catch(() => {});
    } else if (Date.now() - lastGrowth > EXPORT_STALL_MS && fail) {
      fail(new Error(`stalled: no progress for ${Math.round((Date.now() - lastGrowth) / 1000)}s at ${bytes} bytes`));
      try { archive.abort(); } catch (_) {}
      try { out.destroy(); } catch (_) {}
    }
  }, 15000);

  try {
    out = dest.createWriteStream({
      resumable: true,
      metadata: {
        contentType: 'application/zip',
        // Makes a browser save it as a file instead of trying to display it.
        contentDisposition: `attachment; filename="${filename}"`,
        metadata: {firebaseStorageDownloadTokens: downloadToken},
      },
    });
    archive = archiver('zip', {store: true});   // images are already compressed
    const written = new Promise((resolve, reject) => {
      fail = reject;
      out.on('finish', resolve);
      out.on('error', reject);
      archive.on('error', reject);
    });
    archive.on('warning', (err) => logger.warn('archive warning: ' + err.message));
    archive.on('entry', () => {
      entries++;
      if (entries % 100 === 0) {
        logger.info('export progress', {uid: user.uid, entries, bytes: archive.pointer(),
          rssMB: Math.round(process.memoryUsage().rss / 1048576)});
      }
    });
    archive.pipe(out);

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
        // Every source stream gets its own error handler. Without one, a card file
        // that can't be read emits an unhandled 'error' that crashes the process —
        // no 500, no failed job, a job left 'building' — as the emulator test
        // showed with a missing file. With it, the build fails through the catch.
        const src = bucket.file(p).createReadStream();
        src.on('error', (e) => { fail(e); archive.abort(); out.destroy(e); });
        archive.append(src, {name: `cards/${name}`});
      }
      rows.push([
        csvCell(card.id), csvCell(card.sender), csvCell(card.recipient), csvCell(card.occasion),
        csvCell(card.date), csvCell(paths.length), csvCell(names.join(' | ')),
        csvCell(paths.join(' | ')), csvCell(card.totalBytes || ''), csvCell(card.savedAt || '')
      ].join(','));
    }

    archive.append(rows.join('\n') + '\n', {name: 'metadata.csv'});
    archive.append(README, {name: 'README.txt'});
    // Awaited together, so a failure mid-build ends the wait: an aborted
    // archive's finalize() need not settle on its own.
    await Promise.all([archive.finalize(), written]);

    // The object has to be the whole archive, not most of it.
    const size = archive.pointer();
    const [meta] = await dest.getMetadata();
    if (Number(meta.size) !== size) throw new Error(`stored ${meta.size} bytes, expected ${size}`);
    logger.info('export built', {uid: user.uid, entries, bytes: size,
      rssMB: Math.round(process.memoryUsage().rss / 1048576)});

    // One export per person: drop the earlier ones now that this one is complete.
    const [existing] = await bucket.getFiles({prefix: `exports/${user.uid}/`});
    await Promise.all(existing.filter((x) => x.name !== dest.name).map((x) => x.delete().catch(() => {})));

    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(dest.name)}?alt=media&token=${downloadToken}`;
    const now = Date.now();
    const ready = {state: 'ready', url, size, filename, entries, total, startedAt, builtAt: now, readyAt: now,
      sig, objectName: dest.name};            // sig + objectName stay private: publicJob drops them
    await jobRef.set(ready);
    res.json(publicJob(ready));
  } catch (err) {
    // Not `message`: the logger treats that key as its own and swallows the text.
    logger.error('export failed', {uid: user.uid, error: err.message});
    await dest.delete().catch(() => {});        // never leave a partial ZIP behind
    await jobRef.set({state: 'failed', total, startedAt, failedAt: Date.now()}).catch(() => {});
    if (!res.headersSent) res.status(500).send('Could not build the backup. Please try again.');
  } finally {
    clearInterval(beat);
  }
});

/**
 * Export ZIPs are complete copies of someone's archive behind a link that needs
 * no sign-in, so they shouldn't outlive the download. Each export already
 * replaces the previous one; this removes the last one a day later.
 */
exports.cleanupExports = onSchedule({schedule: 'every 24 hours', timeoutSeconds: 300}, async () => {
  const bucket = admin.storage().bucket();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const [files] = await bucket.getFiles({prefix: 'exports/'});
  let deleted = 0;
  for (const file of files) {
    const created = Date.parse((file.metadata && file.metadata.timeCreated) || '');
    if (created && created < cutoff) {
      await file.delete().catch(() => {});
      deleted++;
    }
  }
  // Job records carry the download link, so they go on the same schedule.
  const jobs = await admin.firestore().collection('exportJobs').get();
  let jobsDeleted = 0;
  for (const j of jobs.docs) {
    const d = j.data() || {};
    const last = Math.max(d.builtAt || 0, d.failedAt || 0, d.heartbeatAt || 0, d.startedAt || 0);
    if (last && last < cutoff) { await j.ref.delete().catch(() => {}); jobsDeleted++; }
  }
  logger.info('export cleanup', {deleted, kept: files.length - deleted, jobsDeleted});
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

/**
 * Account deletion (App Store guideline 5.1.1(v): an app that creates accounts
 * must let people delete them from inside the app).
 *
 * Owner-only and self-only: the uid comes from the verified callable context,
 * never from the request body, so this can only ever delete the caller — the
 * same guarantee the export and transcribe functions rely on.
 *
 * Order matters. Storage and Firestore go first and Auth goes last, because
 * every step needs admin.auth() lookups and a surviving user record; deleting
 * the account first would strand the rest. Each step is best-effort so one
 * failure cannot leave the account half-deleted with no way to retry — a
 * re-run is idempotent.
 *
 * Cross-account cleanup is deliberate, not incidental. Viewers this person
 * invited hold a `viewOf` claim naming their uid; leaving it would keep a
 * pointer to an archive that no longer exists.
 */
exports.deleteAccount = onCall(async (req) => {
  const auth = req.auth;
  requireVerified(auth);
  const uid = auth.uid;
  const myKey = normEmail(auth.token.email || '');
  const db = admin.firestore();
  const failures = [];
  const step = async (label, fn) => {
    try { await fn(); }
    catch (e) { failures.push(label); logger.error(`deleteAccount:${label}`, {uid, err: e.message}); }
  };

  // 1) Storage — every master and _thumb under this user's prefix, and any
  //    export ZIP still waiting to be downloaded: that is a full copy of the
  //    archive, so it goes with the account rather than lingering until cleanup.
  await step('storage', async () => {
    await admin.storage().bucket().deleteFiles({prefix: `cards/${uid}/`, force: true});
    await admin.storage().bucket().deleteFiles({prefix: `exports/${uid}/`, force: true});
  });

  // 2a) Viewers this person invited: strip the claim that points at them, drop
  //     the viewer's roster entry, and remove the pending grant. Mirrors
  //     revokeViewer, run for every outstanding invite.
  await step('revoke-viewers', async () => {
    const invites = await db.collection('viewerInvites').doc(uid).collection('emails').get();
    for (const d of invites.docs) {
      const viewerUid = (d.data() || {}).viewerUid || null;
      if (viewerUid) {
        await setViewOf(viewerUid, (s) => s.delete(uid)).catch(() => {});
        await db.doc(`sharedWithMe/${viewerUid}/spaces/${uid}`).delete().catch(() => {});
      }
      // d.id is the normalized email key used by inviteViewer.
      await db.doc(`emailGrants/${d.id}/owners/${uid}`).delete().catch(() => {});
    }
  });

  // 2b) Archives shared WITH this person: disconnect them from every one.
  //
  //     The pending grant goes too, not just the active claim. emailGrants is
  //     keyed by normalized email rather than uid, so leaving it meant signing
  //     up again with the same address silently restored access to every archive
  //     they had ever been invited to — a new uid inheriting the old one's
  //     reach, without the owner acting. Deleting an account has to mean losing
  //     that access; getting it back needs a fresh invite.
  //
  //     The owner's invite is reset rather than deleted. They invited an email
  //     address, and that record is theirs: it stays visible in their Shared
  //     with list as invited, so they can see it and revoke it deliberately.
  await step('leave-shared', async () => {
    const spaces = await db.collection('sharedWithMe').doc(uid).collection('spaces').get();
    for (const d of spaces.docs) {
      const ownerUid = d.id;
      if (myKey) {
        await db.doc(`viewerInvites/${ownerUid}/emails/${myKey}`)
          .set({status: 'invited', viewerUid: null}, {merge: true}).catch(() => {});
        await db.doc(`emailGrants/${myKey}/owners/${ownerUid}`).delete().catch(() => {});
      }
    }
  });

  // 2c) The caller's own documents. recursiveDelete clears subcollections,
  //     which a plain doc delete would orphan.
  await step('own-docs', async () => {
    await db.recursiveDelete(db.collection('viewerInvites').doc(uid));
    await db.recursiveDelete(db.collection('sharedWithMe').doc(uid));
    await db.recursiveDelete(db.collection('cardViewers').doc(uid));   // legacy, read-only in the client
    await db.doc(`exportJobs/${uid}`).delete().catch(() => {});        // holds the export's download link
    await db.collection('transcriptions').doc(uid).delete().catch(() => {});
    await db.collection('tinyCards').doc(uid).delete().catch(() => {});
  });

  // 3) Auth last: once this succeeds the caller's token is void, so nothing
  //    above can run afterwards.
  let authDeleted = false;
  await step('auth', async () => {
    await admin.auth().deleteUser(uid);
    authDeleted = true;
  });

  if (!authDeleted) {
    // The account still exists, so the person can retry. Say so rather than
    // reporting a success that would leave them signed in to a hollow account.
    throw new HttpsError('internal', 'Could not finish deleting your account. Please try again.');
  }
  if (failures.length) logger.warn('deleteAccount: partial', {uid, failures});
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
