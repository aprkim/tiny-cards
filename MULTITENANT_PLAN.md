# Tiny Cards → Multi-tenant service (Phase 1 plan)

Goal: turn the single shared "family" archive into a service where **anyone who
signs in gets their own private archive**. Google Sign-In (web + iOS) already
works, so signing in *is* account creation.

**v1 scope (decided):** private per-user archives only. **Sharing/invites deferred
to Phase 2.** Migrate the existing `family` data into the owner's (aprkim@gmail.com)
own account.

---

## 1. Data model change

| | Now (single-tenant) | v1 (multi-tenant) |
|---|---|---|
| Firestore | `tinyCards/family` (one doc, `cards[]`) | `tinyCards/{uid}` (one doc per user, same shape) |
| Storage | `cards/family/{cardId}/pN.jpg` (+ `_thumb.jpg`) | `cards/{uid}/{cardId}/pN.jpg` (+ `_thumb.jpg`) |
| Owner | hardcoded email `aprkim@gmail.com` | every user owns their own `{uid}` space |
| Viewers | global `cardsViewer` claim → sees the one family space | (removed in v1; redesigned in Phase 2) |

The per-card document shape (`id, sender, recipient, occasion, date, paths[],
labels[], …`) **stays the same** — only the space key changes from `family` to `uid`.

---

## 2. Security rules (the critical, highest-risk piece)

A mistake here can expose everyone's data. Rules must key strictly on `request.auth.uid`.

**Firestore** (lives in the `tiny-do` repo — project-wide):
```
match /tinyCards/{uid} {
  allow get, write: if request.auth != null
    && request.auth.token.email_verified == true
    && request.auth.uid == uid;
}
```
- Remove the old email-based `cardsOwner()` / `cardsViewer()` rules.
- `invites` / `cardViewers` collections: keep denied (unused in v1; redesigned in Phase 2).
- `get` not `read` (no `list`, so nobody can enumerate spaces).

**Storage** (`tiny-cards` repo, `storage.rules`):
```
match /cards/{uid}/{allPaths=**} {
  allow get:    if request.auth != null && request.auth.uid == uid;
  allow write:  if request.auth != null && request.auth.uid == uid
                && request.resource.size < 15 * 1024 * 1024
                && request.resource.contentType.matches('image/.*');
  allow delete: if request.auth != null && request.auth.uid == uid;
}
```
- Thumbnails are written by the Cloud Function (Admin SDK) → bypasses rules, no change.

**Rules unit tests** (emulator or manual): user A cannot read/write user B's space.

---

## 3. Client changes (index / cards / scan / viewer)

- Replace `SPACE = 'family'` with the signed-in user's `authUser.uid`.
- Remove `OWNER_EMAIL`. `isOwner()` → always true for your own space, so scan / edit /
  delete / export / settings are available to **every** signed-in user (in their own space).
- `scan.html`: remove the "not the owner → redirect to cards.html" gate.
- `cards.html`: remove the read-only viewer path + invite-redeem logic (deferred to Phase 2).
- Storage path builder: `cards/${uid}/${cardId}/pN.${ext}`.
- `exportAll` link: unchanged call, but the function derives the space from the token's uid.
- Empty-state onboarding: when a new user has 0 cards, show "Scan your first card"
  (already exists; tweak copy/CTA).

---

## 4. Cloud Functions

- **makeThumbnail** (onObjectFinalized): path-agnostic — works for any `cards/*/…`. Verify
  no `family` assumption. Likely no change.
- **exportAll**: verify token → `uid` → export `tinyCards/{uid}` + `cards/{uid}/…`. Remove
  the OWNER_EMAIL check.
- **backfill**: operate on a given uid.
- **createInvite / redeemInvite / revokeViewer**: unused in v1 — leave deployed but inert,
  or remove; redesign in Phase 2.
- **setCors**: already done (bucket CORS). Keep.

---

## 5. Migration (existing `family` → your uid)

One-off Admin-SDK function/script:
1. Look up your uid: `admin.auth().getUserByEmail('aprkim@gmail.com').uid`.
2. Copy Storage files: for each `cards/family/**` → `bucket.file(src).copy('cards/{uid}/…')`
   (keep the same `{cardId}/pN.ext` tail). Copy `_thumb.jpg` too (or regenerate via backfill).
3. Copy Firestore doc: `tinyCards/family` → `tinyCards/{uid}`, rewriting each card's `paths`
   from `cards/family/…` to `cards/{uid}/…`.
4. Verify: card count + image count match; open the app and confirm all cards render.
5. Keep `family` as a backup until verified, then delete.

Dry-run first (log what would copy, counts) before writing.

---

## 6. Rollout order (avoid lockout / downtime)

1. Deploy the migration function; copy your data to `{uid}` (leave `family` intact).
2. Deploy new rules (uid-based).
3. Deploy client (uid paths).  ← rules + client must match on keys/paths, so migrating first
   keeps you accessible during the switch.
4. Verify: your account shows all cards; a fresh Google account gets a new empty archive and
   cannot see yours.
5. Clean up old `family` data + legacy rules.

---

## 7. Test plan

- puppeteer + mock: two different uids → each sees only their own cards; scan→save writes to
  `cards/{uid}/…`; export uses the caller's uid.
- Rules tests: uidA denied read/write on uidB's Firestore doc and Storage paths.
- Migration dry-run assertions: copied counts equal source counts.

---

## 8. Ops / cost / security checklist (it's a real service now)

- Firebase free (Spark) limits; heavier use needs Blaze (pay-as-you-go). Watch Storage egress
  + Firestore reads as users grow.
- Restrict the iOS API key by bundle id (Google Cloud Console).
- Per-user isolation enforced solely by rules → treat rules as production-critical.
- Consider a basic privacy note / terms if opening to the public.
- Abuse: upload size cap (already 15MB); add rate limiting later if needed.

---

## 9. Open decisions (later)

- **Phase 2 sharing** design: invite link → per-space viewer (viewers subcollection under the
  space, or per-space custom claims). Needs its own plan.
- **Landing page**: signed-out visitors currently see a login-first home. A real service wants
  a short "what is this" + Sign in. (Phase 3.)
- Branding / domain: keep `cards.tinywins.space`?

---

## Phase 1 implementation order (once approved)

1. Rules (Firestore + Storage) — uid-based, with rules tests.
2. Migration function — dry-run, then copy your data to your uid.
3. Client — swap `family`/OWNER_EMAIL for `uid`, remove viewer/invite/owner-gate.
4. Functions — exportAll/backfill per-uid.
5. End-to-end verify (two accounts) → clean up `family`.
