# Shoebox

A peer-to-peer photo library on React Native. No server ever sees a photo, a
thumbnail, or the search index. Companion repo to the
[Shoebox blog series](https://github.com/heart-IT) — one runnable tag per chapter.

## Layout

- `app/` — the React Native app (New Architecture; hosts the Bare worker via
  react-native-bare-kit, native seam via Nitro).
- `worker/` — the host-agnostic vault worker. Runs unchanged under Bare (phone)
  and Node (tests, desktop mirror). `index.js` is the worklet entry (IPC wiring
  only); `vault.js` is the core.
- `desktop/` — desktop peers. `peek.mjs` is a read-only replica (Chapter 1's
  teaser: paste a library key, watch the photo replicate to your laptop with no
  server anywhere — but see the encryption note below). `join.mjs` (Chapter 5) is
  the writer counterpart: it pairs via an invite and joins as a second device.

## Run (Chapter 1)

```sh
# worker core, no phone needed
cd worker && npm install && npm test

# the app (New Architecture is on by default; the app depends on ../worker,
# and react-native-bare-kit links the native addons from that tree itself)
cd ../app && npm install
npm run bundle:worker            # bare-pack → worker.bundle.mjs
# iOS: cd ios && pod install && cd .. && npm run ios
# Android: npm run android

# the teaser — paste the library key the app shows after import
cd ../desktop && npm install
node peek.mjs <library-key>
```

> **Encryption note (Chapters 7 + 10):** the phone's album is encrypted, and since
> Chapter 10 its members swarm on a topic **derived from the album key** — so a bare
> `peek.mjs <library-key>` no longer even finds the members (before Ch10 it
> replicated ciphertext and read EMPTY; now it connects to nobody). The library key
> is a shareable identifier that leaks neither content nor member addresses. To
> actually read the album, pass the album key: `node peek.mjs <library-key>
> <album-key-hex>` — it derives the members' topic AND decrypts. (Surfacing that key
> from the app — an export/QR flow — is a later milestone; see the encryption chapter.)

Nitro codegen (`npx nitrogen`) only needs re-running when `src/specs/*.nitro.ts`
changes; the generated output in `nitrogen/generated/` is committed.

## Chapter tags

| Tag | Ships |
|-----|-------|
| `ch01-one-photo` | One photo stored in Hyperblobs, rendered through a localhost blob-server URL, replicated to a laptop via the sealed teaser |
| `ch02-importing-the-roll` | The whole camera roll imported four ways, measured on-screen: naive base64 (796 ms JS-thread stall) → mmap'd bytes over bare-rpc → a hand-rolled C++ zero-copy `ArrayBuffer` → the typed Nitro reveal (35–51 ms stall). Enumeration via a Nitro `ShoeboxRoll` module |
| `ch03-the-library` | A time-ordered photo grid over the vault: the index is a **Hyperbee** keyed by capture-time (range queries), records are **Hyperschema**/compact-encoding (append-only, Inv-4). The worker generates ≤256px **bare-media** thumbnails shipped as `data:` URLs; a windowed **FlashList** grid paints from the index, and originals load lazily on tap via the blob-server |
| `ch04-search` | Search that never leaves the phone: a **dHash** near-duplicate column computed in the worker, and a MobileNet **embedding** run on the device's neural HW (**TFLite + NNAPI** behind a Nitro module) written into the index. "Find similar" and "near-duplicates" run offline as Hamming/cosine over the index columns — nothing leaves the device (Inv-5) |
| `ch05-second-device` | The index becomes an **Autobase**: each device has its own writer keypair (a seed-derived identity) and appends to its own log; a deterministic `apply()` in `worker/library.js` linearizes every writer into one shared view. A second device pairs via a one-time **blind-pairing** invite → `addWriter` (gated in `apply`), then imports converge both ways. `desktop/join.mjs` joins as a *writer* (vs `peek.mjs`, a read-only replica). Photo bytes stay in per-device Hyperblobs cores the view points at — your second device is an identity, not a copy |
| `ch06-many-hands` | Authority becomes **data in the view**: a second `roles` bee (writer-key → `owner`/`member`) alongside the photos index. The founder self-claims **owner** on first boot; `apply()` tightens `ADD_WRITER` to owner-only and grants the added writer `member`. `REMOVE_WRITER` (owner-only) **revokes forward** — a kicked member loses future writes but keeps already-shared photos (Inv-8). A Members screen with a Kick action; `join.mjs` logs `unwritable` on revocation |
| `ch07-private-album` | The album is **encrypted**: a 32-byte album key (seed-derived) encrypts the Autobase log, views, and blob cores, so photos are private on the wire and at rest — a peer with only the library key replicates ciphertext and reads nothing. The key reaches a new device **through pairing** (inside the blind-pairing confirm, never over the DHT). **Revocation rotates the content key** (Inv-9): the album key is *membership*, but each photo's browsable content (thumbnail + bytes) is sealed under a separate **content key** that rotates when a member is kicked — the new key is sealed per remaining member (libsodium anonymous box) and carried in the log, so a kicked member keeps the album key and sees the album, but every photo added after the kick is redacted for them. Forward-only: their pre-kick content stays readable |
| `ch08-outlives-the-foreground` | **Suspension is not graceful shutdown (Inv-10).** The AppState hook's suspend/resume path — dead code since Ch1 — becomes real and hardened: transitions run **serialized** through one queue (an OS background/active storm collapses to no-ops), SUSPEND **drains in-flight imports** (bounded, ≤5 s) before dropping sockets so its reply truthfully means *quiescent*, and a swarm minted while backgrounded comes up suspended. The blob-server re-binds its **original port** on resume, so links the grid already holds survive the round trip. A **narrow, cause-chain-aware `uncaughtException` filter** (`ENOTCONN`/`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`ECONNABORTED`, ≤8 `err.cause` hops) swallows the kernel's socket-teardown corpses only inside the suspend→resume window — logged, everything else fatal, in every app state. Batch imports **park at the photo boundary** while backgrounded (no mmap'd region borrowed under background memory pressure — the Ch2 ownership deferral, closed) and the meter excludes parked time. Finding: two peers resuming *simultaneously* can miss each other until the next topic refresh — resume is reliable against a peer that stayed up (why Part 9's always-on mirror earns its keep) |
| `ch09-bigger-than-the-phone` | **Retention is a feature (Inv-11).** The index tier — records, thumbnails, embeddings — is the library and stays local forever; ORIGINALS are a cache. Sparse replication means a replicated photo already starts **cold** (bytes move on demand only); `evict()` is `core.clear()` returning it to that state — no view mutation, no atomics (the bee is never evicted). A `resident` flag + ❄ grid badge + Storage panel surface the tiers; the **eviction oracle** picks near-duplicates first (the grid's own dHash threshold) then oldest, never implicitly. The **blind peer** closes the loop: an always-on mirror (`blind-peering` client in the vault, stock `blind-peer` daemon on your box) that absorbs the autobase + blob cores as **ciphertext it cannot read** — smoke proves a member converges and pages originals in from the mirror alone with the founder offline, and greps the mirror's storage clean of plaintext (with a positive control) |
| `ch10-shipping` | **The privacy claim is only as strong as the bytes that leave (Inv-12).** Two silent key bugs found by writing the shipping test: rotations now **seal to the owner itself** (a rebooted founder kept losing its own post-rotation photos) and `GRANT_KEYS` hands every held epoch to a **late joiner** at invite time (owner-only, roster-only, first-write-wins in `apply()`; the kicked member gains nothing). Members meet on a **topic derived from the album key** — a library-key-only stranger no longer even finds the members' addresses (`discoveryTopic()` shared by vault/peek/join). A `status()` trio (peers / lastUpdateAt / suspended) rides every STAT plus a permanent sync line in the app, so a resume-that-syncs-nothing is visible. The Part 10 draft carries the verbatim App Store privacy narrative the architecture earns |

Each measured import path is a button in the app; the on-screen meter reports
throughput, worst JS-thread stall, and peak in-flight bytes. See `VERSIONS.md`
for the per-movement drift findings and numbers.

## Known limitations

- **The grid loads the whole library in one shot.** `Grid` issues a single
  `list()` that returns every record — base64 `data:` thumbnail and float32
  embedding inline — and holds it in state. Fine at demo scale (hundreds of
  photos); a real 10k+ library needs a windowed/paginated `LIST` plus thumbnails
  served over the blob-server as URLs (like originals). Moving thumbnails out of
  the record to blob pointers means adding more optional schema fields — safe
  under the append-only contract (Inv-4) — so it's deliberately left for a later
  chapter rather than bolted on here. (An earlier note here claimed a
  "flag-byte cliff" blocked this; that was wrong — the codegen handles >7 optional
  fields via variable-width flags. See `worker/build-schema.mjs`.)
