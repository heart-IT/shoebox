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
