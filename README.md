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
- `desktop/` — desktop peers. `peek.mjs` is Chapter 1's closing teaser: paste an
  index key, watch the photo replicate to your laptop with no server anywhere.

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

# the teaser — paste the index key the app shows after import
cd ../desktop && npm install
node peek.mjs <index-key>
```

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

Each measured import path is a button in the app; the on-screen meter reports
throughput, worst JS-thread stall, and peak in-flight bytes. See `VERSIONS.md`
for the per-movement drift findings and numbers.

## Known limitations

- **The grid loads the whole library in one shot.** `Grid` issues a single
  `list()` that returns every record — base64 `data:` thumbnail and float32
  embedding inline — and holds it in state. Fine at demo scale (hundreds of
  photos); a real 10k+ library needs a windowed/paginated `LIST` plus thumbnails
  served over the blob-server as URLs (like originals). Serving thumbnails as
  blobs is blocked by the append-only schema — a thumb-blob pointer would push
  past the 7-optional-field flag-byte cliff (see `worker/build-schema.mjs`) — so
  it's deliberately left for a later chapter rather than bolted on here.
