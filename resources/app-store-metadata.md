# Kept — App Store Connect metadata

Everything to paste into App Store Connect for version 1.0.
Build to select: **1.0 (6)**

---

## Name (30 max)

    Kept: Greeting Card Archive

"Kept" alone was taken.

## Subtitle (30 max)

    Scan and keep greeting cards

## Promotional Text (170 max — editable later without review)

    Every birthday card, thank-you note and handwritten message you couldn't bear to throw away — scanned, organized, and safe on your phone.

## Description

    Some cards are too meaningful to throw away — and too bulky to keep forever.

    The birthday card in your mother's handwriting. The note your daughter made in second grade. The letter from someone who isn't here anymore. They end up in a shoebox in the closet, and the shoebox never gets opened.

    Kept turns that box into an archive you'll actually look at.

    SCAN IN SECONDS
    Photograph a card on the kitchen table and Kept finds the edges and crops it clean. A quick snapshot comes out looking like a proper scan — no scanner, no fuss.

    KEEP THE INSIDE, TOO
    The message is the part that matters. Kept stores the front and the inside together, so the handwriting is never lost — only the clutter.

    FIND ANY CARD
    Your whole collection in one place, sorted by date and by who sent it. Twenty years of birthdays, browsable in a few seconds.

    SHARE WITH FAMILY
    Invite the people who'd want to see them. Cards from a grandparent can belong to everyone who loved them, instead of whoever ended up with the box.

    YOURS, PRIVATELY
    No ads. No selling your data. No feed, no followers, no strangers. Your keepsakes stay yours.

    Keep the handwriting. Lose the shoebox.

## Keywords (100 max, comma-separated, no spaces)

    scanner,keepsake,memory,birthday,handwriting,family,sentimental,memento,album,letters,notes,gift

Deliberately omits "greeting", "card" and "archive" — they are already in the
app name, which Apple indexes separately, so repeating them wastes characters.

## URLs

    Support URL          https://kept.cards/support.html
    Marketing URL        https://kept.cards
    Privacy Policy URL   https://kept.cards/privacy.html

## Copyright

    2026 Liha LLC

## Categories

    Primary    Photo & Video
    Secondary  Lifestyle

## Screenshots

    resources/appstore-screenshots/01-welcome-6.5.png   (1284 x 2778, the 6.5" slot)
    resources/appstore-screenshots/01-welcome-6.9.png   (1320 x 2868, if a 6.9" slot appears)

---

## App Review Information

Tick **Sign-in required**, and fill Username / Password with the demo Google
account (not a personal one; 2-step verification must be OFF or the reviewer
cannot get in).

### Notes

    Kept requires a Google account to sign in, because every card is stored
    in the user's own private archive. Demo credentials are provided above.

    To review the app:
    1. Tap "Sign in with Google" on the home screen and use the demo account.
    2. Tap "View" to browse the sample card archive.
    3. Tap any card to open it full screen. Cards with more than one page can
       be paged through with the dots below the image.
    4. Tap "Scan" to add a card. On a physical device the camera detects the
       card edges and crops automatically.
    5. The gear icon opens Settings, where cards can be shared with family by
       email invitation.

    The demo account already has sample cards saved, so the archive is not
    empty on first sign-in.

    Camera access is used only to photograph greeting cards. Photo library
    access is used only to import card photos the user selects. Neither is
    used for any other purpose. The app has no public feed, no messaging and
    no discovery — sharing is private, by email invitation, and approved by
    the archive owner.

### Attachment

A 30–60 second screen recording of sign-in → archive → opening a card, made on
build 6. Optional, but worth it: if Google challenges the reviewer's sign-in,
the video is what saves you a rejection round-trip.

### Contact Information

Your own name, a phone number that actually rings, and hello@lihallc.com.

---

## Age Rating

Answer **None / No** to everything → 4+.

On the newer social-media questions: **No**. Sharing is private, invite-only
viewing between family members — no public feed, no discovery, no messaging
between strangers.

## App Store Version Release

**Manually release this version** — so the app goes live when you are awake and
watching, not the moment a reviewer clicks approve at 3am.

## Fields to skip

Routing App Coverage File, App Previews, Apple TV / Watch screenshots,
Third-Party Content. None apply.

---

## Still to do before Submit

- [ ] Build **1.0 (6)** archived, uploaded, and selected in the Build section
      (builds 1 and 2 are stale — build 1 has the broken camera)
- [ ] Demo Google account: 2-step verification off, signed into Kept, 3–4 cards
      scanned so the archive is not empty
- [ ] App Privacy questionnaire
- [ ] Age rating
- [ ] EU trader status (Business → Trader Status)

## Deferred to 1.1

- Card images load slowly: two getDownloadURL round-trips per page, and nothing
  renders until all of them resolve (cards.html:1272)
- Google OAuth consent screen still shows "project-497477643272" — the App name
  field would not save; branding verification is pending
- Google Cloud OAuth logo (use resources/oauth-logo-120.png — 120x120; uploading
  a logo triggers Google brand verification, so do it after launch)
