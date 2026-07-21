# Version pins

Churning dependencies are pinned and validated against installed source before any
chapter prose asserts their API shape (series standing decision). Recorded at scaffold
time, 2026-07-10.

| Package | Version | Churn notes |
|---------|---------|-------------|
| react-native | 0.86.0 | New Architecture required by both bare-kit and Nitro |
| react-native-bare-kit | 0.15.0 | pre-1.0, expect breakage; skill last verified 0.14 — API re-validated against installed source at scaffold |
| react-native-nitro-modules | 0.36.1 | pre-1.0; Nitrogen codegen validated at scaffold |
| nitrogen | 0.36.1 | must match nitro-modules minor |
| corestore | 7.11.0 | |
| hyperblobs | 2.12.1 | |
| hypercore-blob-server | 1.15.0 | `getLink(key, { blob })` shape validated in smoke test |
| hyperswarm | 4.17.0 | `suspend()/resume()` are the mobile lifecycle APIs |
| hypercore-id-encoding | 1.3.0 | |
| framed-stream | 1.0.1 | frames the unframed worklet IPC (rn-bare-kit#10) |
| bare-pack | 2.2.0 | bundle must cover ios, ios-simulator, android, android-arm |
| autobase | 7.28.1 | Ch5+: multi-writer view engine; `apply(nodes, view, host)`, `host.system.has()` is true for REMOVED writers (see audit fix F1) |
| blind-pairing | 2.3.1 | Ch5+: invite/candidate flow. `createInvite` `expires` field is NOT enforced in this version — single-use is the app's job (audit fix P2) |
| hyperbee | 2.27.3 | Ch3+: the `photos` and (Ch6) `roles` view bees |
| hyperschema | 1.21.0 | Ch3+: record codegen; >7 optional fields switch flags to variable-width (no cliff — audit fix F4) |
| hypercore-crypto | 3.7.0 | Ch5+: seed → primaryKey / album key derivation |
| z32 | 1.1.0 | Ch5+: z-base-32 for variable-length invites |
| bare-media | 2.10.0 | Ch3+: worker thumbnail decode/resize (Bare-only) |

## Drift findings (validated against installed source)

- **bare-pack 2.2** dropped the `--target` flags. Use `--preset mobile` — covers all
  seven mobile hosts (android-arm/arm64/ia32/x64, ios-arm64, ios-arm64-simulator,
  ios-x64-simulator) and implies `--linked`.
- **react-native-bare-kit 0.15 auto-wires AppState**: the module registers a listener
  that suspends every worklet on `background` and resumes on `active`
  (`index.js`, last line). Do not add app-side worklet suspend wiring on top.
- **react-native-bare-kit 0.15**: `worklet.IPC` is a streamx `Duplex` (framed-stream
  wraps it directly); `start(filename, source, args)` — filename must end `.bundle`,
  source may be the string default-exported by a bare-pack `.mjs` bundle; string
  `args` become `Bare.argv`.
- **react-native-bare-kit links addons itself** — do NOT hand-wire bare-link. Its pod
  runs `ios/link.mjs` as a `prepare_command` (vendoring `.xcframework`s into its own
  pod), and its Android library runs `link.mjs` as a `preBuild` Gradle task (into its
  own jniLibs source set). Both scan the **app's** dependency tree, so the app must
  depend on the worker package (`"shoebox-worker": "file:../worker"`) for the
  Holepunch natives (sodium, udx, rocksdb) to be discovered. Hand-vendoring a second
  copy produces "frameworks with conflicting names" at pod install.
- **Bundle and addons must resolve from the same tree.** `bare-pack` runs from the
  app root over `node_modules/shoebox-worker/index.js` so the `linked:` addon versions
  in the bundle match the versions rn-bare-kit vendors.
- **bare-link 3.3** (used indirectly): entry is a package *directory*; bails silently
  on a file path.
- **Hyperswarm + Hypercore on the reader side**: `core.update({ wait: true })` alone
  resolves before a peer delivers the length — the correct shape is
  `core.findingPeers()` + `swarm.flush().then(done, done)` + `core.update()`
  (see `desktop/peek.mjs`).

## Validation log

- 2026-07-10 — initial pins. `worker/test/smoke.mjs` green under Node v22.21.0.
- 2026-07-10 — full teaser round trip green on desktop: phone-sim (Vault + share)
  → real DHT → `peek.mjs` replicated the photo byte-identical.
- 2026-07-10 — `nitrogen` 0.36.1 codegen green (21 files) alongside
  react-native-bare-kit in one New-Architecture app.

## Drift findings — first full Android boot (2026-07-18)

The scaffold had only been proven through `worker/` Node tests; the first
on-device Android run surfaced five integration traps, all fixed in-tree:

- **react-native-bare-kit 0.15 requires `minSdkVersion 29`** (manifest merger
  fails against the RN template default of 24).
- **nitrogen's generated gradle/srcDir assume the nitro LIBRARY layout**
  (`android/` at package root). In an app, `android/app/build.gradle` must
  apply from `../../nitrogen/...` and add the kotlin srcDir itself — the
  generated `${projectDir}/../nitrogen` path silently resolves to a
  nonexistent `android/nitrogen/`.
- **Overriding `externalNativeBuild` replaces RN's appmodules build.**
  Bridgeless boot hard-requires `libappmodules.so`; the app CMakeLists must
  be `project(appmodules)` + `include(ReactNative-application.cmake)`, with
  the nitro `Shoebox` target added alongside. Nitro headers also require
  `CMAKE_CXX_STANDARD 20`.
- **`ReactNative-application.cmake` globs `*.cpp` next to the CMakeLists and,
  if any exist, DROPS its default-app-setup sources** — including the OnLoad
  that registers the TurboModule delegate. Symptom: every TurboModule missing
  at boot ("'PlatformConstants' could not be found", "Global was not
  installed"). cpp-adapter.cpp therefore lives in `nitro/`, out of glob range.
- **bare-kit's prebuilt lists `libnativehelper.so` (ART apex) as NEEDED.**
  The system linker resolves it (public library), but SoLoader's manual
  dependency walk only searches app + /system + /vendor and fails to load
  libappmodules. Fix in MainApplication: init SoLoader with RN's merged
  mapping, then `prependSoSource(DirectorySoSource("/apex/com.android.art/
  lib64", ON_LD_LIBRARY_PATH))` before `loadReactNative`. Any RN new-arch
  app embedding bare-kit 0.15 needs this (peerBarter included).

## Drift finding — Nitro init was never wired (found in ch02, latent since ch01)

Nitrogen generates `ShoeboxOnLoad.initializeNative()` (Kotlin, loads libShoebox)
and expects `cpp-adapter.cpp` to define the `JNI_OnLoad` that calls
`registerAllNatives()` — but generates NEITHER call site. The ch01 scaffold left
`cpp-adapter.cpp` empty (wrong comment: "JNI_OnLoad lives in ShoeboxOnLoad.cpp"
— it does not; that file only defines `initialize(vm)`). Net effect: no Nitro
HybridObject was ever registered. `documentsPath()` threw and hit its null
fallback, so the ch01 vault silently stored to `os.tmpdir()` instead of the app
documents dir — it "worked" by luck. Surfaced in ch02 only because `ShoeboxRoll`
has no graceful fallback: `createHybridObject` threw "not registered … []".

Two fixes, both required:
- `android/nitro/cpp-adapter.cpp`: real `JNI_OnLoad` →
  `facebook::jni::initialize(vm, []{ margelo::nitro::shoebox::registerAllNatives(); })`.
- `MainApplication.onCreate`: call `ShoeboxOnLoad.initializeNative()` after
  `loadReactNative`.

Lesson for the blog: a null-guarded native accessor hides a dead native seam.
Nitro modules must be verified by their VALUE on device, never by "the app
didn't crash." peerBarter/any Nitro app needs both wirings.

## Ch02 Movement 2 — bare-rpc + naive-import baseline (measured on device)

- **bare-rpc 1.3.8** is the channel-ladder rung 2, replacing Ch1's framed-stream
  JSON. It self-frames over the raw `BareKit.IPC`, so framed-stream is dropped.
- **Two integration traps:**
  1. bare-rpc pulls `bare-stream` (a Bare builtin) even for request/reply — it's
     only a `streamx` re-export, so the app aliases `bare-stream → streamx` in
     `metro.config.js` (`extraNodeModules`) to run the same RPC on Hermes.
  2. **Commands are uints, not strings.** bare-rpc encodes `command` with
     `c.uint` (lib/messages.js) — passing a string throws
     "uint must be positive". Both ends share an integer `CMD` map.
- Naive read: `ShoeboxRoll.readBase64(path)` (Kotlin `File.readBytes()` →
  `Base64.NO_WRAP`) → JS string → JSON → RPC → worker → Hyperblobs.
- **Baseline (30 photos, 16.3 MB, this device):** 1.84 MB/s, 8.9 s wall,
  **796 ms worst JS-thread stall** (~48 dropped frames), **7.73 MB peak
  in-flight base64**. These are Movement 3's target to beat.

## Ch02 Movement 3 — mmap'd raw bytes (measured on device)

`ShoeboxRoll.readBytes(path): ArrayBuffer` — `FileChannel.map()` (mmap) then one
owning `ArrayBuffer.copy`. No base64, no JSON: the ArrayBuffer rides bare-rpc as
raw bytes via a new IMPORT_RAW command framed `[u16 LE nameLen][name][bytes]`.

- **Bug found:** the worker JSON-parsed `req.data` for ALL commands at the top of
  the handler; IMPORT_RAW's payload is binary, so it threw
  "Unexpected token 'F'" (the u16 length byte). Fix: parse JSON only inside the
  JSON commands.
- **Result vs Movement 2 (same 30 photos / 16.3 MB):**
  | metric | naive base64 | mmap bytes | change |
  |---|---|---|---|
  | throughput | 1.84 MB/s | 2.95 MB/s | 1.6× |
  | wall | 8.9 s | 5.5 s | 1.6× |
  | **JS-thread stall** | **796 ms** | **42 ms** | **19× less** |
  | peak in-flight | 7.73 MB | 5.80 MB | base64's 1.33× gone |
- **The honest finding (better than the spec's "order of magnitude faster"
  guess):** base64's dominant cost was the JS-THREAD STALL (jank), not raw
  throughput. Removing the encode + `JSON.stringify` of a megabyte string drops
  the worst stall from 796 ms (≈48 dropped frames, a visible freeze) to 42 ms
  (≈idle). Throughput rises only 1.6× because past base64 the cost is the IPC
  copy + Hyperblobs write, not encoding. "JS thread idle throughout" — achieved.
- **Zero-copy caveat:** Kotlin copies once (mmap → owning ArrayBuffer) because
  Nitro's zero-copy wrap ctor is `internal`. True no-copy — `ArrayBuffer::wrap`
  over the mmap with an explicit `munmap` release (Inv-3) — is C++-only and is
  the hand-rolled read-along ideal, deferred pending the M3/M4 shape decision.

## Ch02 Movement 3 (C++ zero-copy) — hand-rolled mmap HybridObject

`ShoeboxBytes.mapFile(path): ArrayBuffer` — a C++-base Nitro HybridObject
(nitro.json `"all": { language: "c++" }`). Opens the file, `mmap`s it read-only,
and returns `ArrayBuffer::wrap(pages, size, [](){ munmap })` — the mapped pages
ARE the ArrayBuffer (no copy), unmapped only when JS drops the buffer (Inv-3,
explicit lifetime by hand).

- **Build wiring:** the generated `ShoeboxOnLoad.cpp` `#include`s and constructs
  `HybridShoeboxBytes`, so `app/cpp/HybridShoeboxBytes.cpp` is added to the
  Shoebox CMake target and `app/cpp` to its include dirs (in the app CMakeLists,
  not the generated file). `nitro.json` c++ modules use the `"all"` autolinking
  key, not the deprecated `"cpp"`.
- **Result (same 30 photos / 16.3 MB):**
  | path | throughput | JS stall | note |
  |---|---|---|---|
  | naive base64 | 1.84 MB/s | 796 ms | base64 on JS heap |
  | Kotlin mmap+copy | 2.95 MB/s | 42 ms | one owning copy |
  | **C++ mmap zero-copy** | **2.45 MB/s** | **35 ms** | mapped pages, no heap copy |
- **Honest nuance for the blog:** zero-copy's win here is MEMORY, not
  throughput. The two mmap paths' throughput differ within run-to-run variance
  (mmap faults pages lazily; the IPC copy + Hyperblobs write dominate either
  way). What C++ zero-copy uniquely removes is the heap copy — the bytes never
  land on any JS/native heap, they're the file's own pages. The meter's
  "peak in-flight" reads the same JS-side view length for both; the real native
  RSS difference (mapped pages vs a heap-allocated copy) is below what the
  on-screen meter captures. The stall win (the base64 story) is what both share.

## Ch02 Movement 4 — the Nitro reveal (measured on device)

`ShoeboxRoll.readBytes(path): ArrayBuffer` — a typed Kotlin method returning a
Nitro ArrayBuffer. No hand-written C++, no JNI, no manual `munmap`: Nitrogen
generates the binding and Nitro's ArrayBuffer type states the ownership rule
that Movement 3's C++ wrote by hand.

- **The reveal, all four paths, same 30 photos / 16.3 MB:**
  | path | throughput | JS stall |
  |---|---|---|
  | naive base64 (M2) | 1.84 MB/s | 796 ms |
  | mmap C++ zero-copy (M3, hand-rolled) | 2.45 MB/s | 35 ms |
  | **nitro Kotlin readBytes (M4, typed)** | **2.52 MB/s** | **51 ms** |
- The typed Kotlin method matches the 40-line hand-rolled C++ within variance —
  same ArrayBuffer, same collapse of the stall, none of the C++ to maintain.
  That IS the movement's thesis: what Nitrogen generates is the contract you
  wrote by hand. Nitro is mainline from here.

## Ch03 Movement 1 — Hyperbee index by capture-time + Hyperschema records

- `hyperbee@2.27.3`, `hyperschema@1.21.0`, `compact-encoding` added to the worker
  (and hyperbee to desktop for peek).
- The index is a **Hyperbee** over the core `photo-bee`, keyed by an 8-byte
  BIG-ENDIAN capture-time + name (so bytewise order = chronological, and a time
  window is a range query). Values are the generated `@shoebox/photo`
  Hyperschema struct — compact-encoding, not JSON. `build-schema.mjs` regenerates
  `spec/`.
- **Inv-4** verified in the smoke test: a record written WITHOUT the optional
  `orientation`/`width`/`height`/`thumb` fields still decodes (making them
  required would break every older record — the append-only contract).
- **Three integration traps (all real, on-device):**
  1. **Hyperschema `toDisk` emitted ESM** despite the docs' CJS default →
     worklet SIGABRT `Cannot use import statement outside a module`. Fix:
     `toDisk(schema, { esm: false })` (the worker/peek load it with `require`).
  2. **A count scan in `ready()` hung the worker boot.** `for await
     (…bee.createReadStream())` at startup never resolved on device. Fix: compute
     the count lazily (`ensureCount()`), not on the boot path.
  3. **Incompatible format on an existing core.** Ch2 left a `photo-index`
     Hypercore append-log on the device; opening a Hyperbee over it decoded log
     blocks as B-tree nodes → `DECODING_ERROR: Groups are not supported` (from
     protocol-buffers-encodings). Fix: new core name `photo-bee` — a format
     change gets a new namespace, the old log is abandoned, not migrated in place.
- Verified on device: vault boots over the fresh bee, 30 photos import keyed by
  capture-time, peek.mjs replicates + decodes via the SHARED schema and finds the
  newest by time. RPC gains a `LIST` command (time-ordered window) for the grid.

## Ch03 Movements 2 & 3 — worker thumbnails + the windowed grid

- **M2 thumbnails (worker-only):** `bare-media@2.10.0` (added to the worker). It
  wraps Bare-native image codecs (bare-jpeg/png/webp/heif + bare-ffmpeg for the
  rest, bare-exif for orientation). `worker/thumbnail.js` decodes → resizes to
  ≤256px → encodes webp → `data:` URL, stored in the record's `thumb` field. It
  runs ONLY in Bare (lazy dynamic `import()`, so it stays out of the Node smoke
  test's path). Import fills `thumb`/`width`/`height`/`orientation`; unsupported
  formats import without a thumb (graceful).
  - **Viability notes:** bare-media's codecs load via literal-specifier dynamic
    imports (`import('bare-jpeg')`), which bare-pack bundles statically. All
    runtime native deps ship android-arm64 prebuilds; `bare-lief` (flagged by a
    prebuild audit) is a HOST-side tool pulled by bare-link, never linked into
    the APK — the build confirmed it. Cost: bare-ffmpeg adds ~29 MB to the APK.
- **M3 grid:** `@shopify/flash-list@2.3.2` — a 3-column windowed grid
  (`app/src/Grid.tsx`) driven by the RPC `LIST` (time-ordered window over the
  Hyperbee). Cells paint the `data:` thumbnails from the index alone; the grid
  never touches an original. Tapping a cell is the ONLY time a full-res original
  is fetched — lazily, via the localhost blob-server, in a modal.
- **Wrong-first (described, not shipped — it OOMs):** render full-res originals
  into every cell → a large library OOMs a mid-range phone. The fix is the whole
  movement: eager ≤256px thumbnails, lazy originals.
- Verified on device: 30 real camera-roll photos import with worker-generated
  thumbnails; the grid renders them newest-first (windowed/recycled); tapping a
  cell opens the full-resolution original. peek.mjs regression still passes.

## Ch04 Movement 1 — on-device perceptual hash (dHash) near-duplicates

- **Inv-5 demonstrated:** the image is decoded and reasoned about ON THE DEVICE;
  only a 64-bit result enters the index. `worker/thumbnail.js` (now `analyze`)
  reuses the single bare-media decode to also compute a dHash — shrink to 9×8,
  grayscale, compare each pixel to its right neighbour → 16-hex. Stored as an
  optional index column (Inv-4 holds).
- **Near-duplicate search runs over the INDEX, not pixels:** Hamming distance
  between dHashes, computed app-side in `Grid.tsx` (`hamming()` in vault-client).
  Nothing leaves the phone — the point Part 5 builds on (sync the index, search
  works everywhere without re-running inference).
- **Bug found:** the vault record object never copied `meta.dhash` into the
  stored record (only `thumb`/`orientation` were), so dHash read back as empty.
  Verified on device once fixed: distinct photos hash 16–22 bits apart
  (discriminating), identical images 0; the grid modal shows a photo's
  near-duplicates (threshold ≤12) plus a `dhash · closest N` readout.
- **dHash resize** uses bare-image-resample directly for an exact 9×8 (bare-media's
  `resize` only max-fits); the step is wrapped so a failure can't cost the thumb.

## Ch04 Movements 2 & 3 — on-device embedding model + semantic search

- **M2 embedding model (Nitro + TFLite + NNAPI):** `org.tensorflow:tensorflow-lite:2.14.0`
  (app Gradle dep), `mobilenet_v1_1.0_224_quant.tflite` (~4.3 MB) bundled as an
  asset (`noCompress 'tflite'`). A Kotlin Nitro HybridObject `ShoeboxEmbed.embed(path)`
  decodes with BitmapFactory → 224×224 → runs the TFLite Interpreter with an
  `NnApiDelegate` → dequantizes the 1001-way output as a scene-embedding vector.
  Verified on device: logcat shows "Created TensorFlow Lite delegate for NNAPI"
  and "Replacing 31 of 31 node(s) with delegate" — the WHOLE graph runs on the
  neural HW. Embeddings are packed float32→base64 and stored in the index as an
  optional column (Inv-4), computed during import (the "backfill is expensive"
  cost → carries to the bonus part).
- **M3 semantic search:** cosine similarity over the embedding column, computed
  app-side in `Grid.tsx` (`cosine`/`unpackEmbedding` in `embed.ts`). Tapping a
  photo shows "most similar (on-device model)" — verified: a chat-screenshot
  returns other chat-screenshots, entirely offline. Near-duplicates (M1 dHash)
  sit alongside.
- **Honest notes:** (1) the model is a CLASSIFIER; its 1001-way distribution is
  used as the embedding — a real on-device vector where same-content photos land
  near each other, but not a trained metric-learning embedding. (2) Decode is
  BitmapFactory in Kotlin, not the worker's bare-media via the Part 2 buffer
  contract — simpler and reliable; the spec's buffer-reuse is the cleaner ideal.
  (3) iOS `ShoeboxEmbed` is a stub (Android is the verified platform).

## Post-audit hardening (3-agent audit incl. holepunch-p2p-systems skill)

Fixed the audit's HIGH/MED findings (config-only LOWs — release-signing keystore,
symmetric-NAT relay — deferred as deployment choices, not code bugs):

- **Data loss (HIGH):** the Hyperbee key was `takenAt+name`; two distinct photos
  sharing a ms+filename collided and orphaned a blob. Key now appends the blob's
  unique `byteOffset` — distinct puts get distinct keys. This also removed the
  get-then-put existed-check and its count race. Regression covered in smoke.
- **TFLite leaks + jank (HIGH×3):** `HybridShoeboxEmbed` is now a process
  singleton (Interpreter + retained NnApiDelegate + mapped model built once, not
  per import run); the AssetFd/stream are closed after mapping; BitmapFactory
  downsamples via `inSampleSize` and recycles both bitmaps; and `embed()` is
  **async** (`Promise.async`, off the JS thread). Verified: import+embed stall
  dropped to **32 ms** (was a multi-second synchronous freeze).
- **No teardown (HIGH):** added `Bare.on('teardown')` → `vault.close()` (swarm →
  blob-server → store, reverse order, guarded); dropped the redundant double
  `store.close()` (the blob-server owns it).
- **Offline import failed (HIGH):** `share()` now `.catch()`es the `swarm.flush()`
  rejection so a locally-successful import never fails when the DHT is unreachable.
- **MED:** boot failure now resolves `ready` + sets `bootError` (RPCs reply with an
  error instead of hanging); `IMPORT_RAW` header length widened u16→u32 (embedding
  can't overflow the frame); `withThumb`/dHash failures log and store empty (not
  an `'ERR:'` sentinel that read as a Hamming-0 duplicate); RPC calls have a 20s
  timeout; per-photo error isolation in the import loop; `requestLegacyExternalStorage`
  + a network-security-config scoping cleartext to localhost (was process-wide).
- **LOW:** `Grid` near-dup/cosine `useMemo`ed (was recomputed every render);
  stable `id` (hex key) as the React/list key (was `takenAt:name`, collided);
  removed the leftover `dhash·closest` debug line; degenerate all-zero dHashes
  excluded from near-dup; Float32 unpack guards non-multiple-of-4 length;
  `list()` distinguishes error from empty; negative `takenAt` clamped; stale
  `framed-stream` dep dropped.
- **Verified correct by the audit (unchanged):** the C++ mmap module (all error
  paths), the native build wiring, the P2P replication/discovery/verification
  layer, and the 64-bit/dHash/Hamming arithmetic.

## Ch05–Ch07 (structural) + four-dimension audit fixes (2026-07-20)

Ch05 swapped the single-writer index for an **Autobase** (shared `apply()` in
`worker/library.js`); Ch06 added the **roles** view (owner/member, owner-only
membership, forward-only revocation); Ch07 (in progress, untagged) **encrypts**
the album and delivers the key through pairing. See the README chapter table.

A four-dimension audit (correctness / completeness / P2P / production) followed.
Fixes landed and covered by `worker/test/smoke.mjs` (all Node-verifiable):

- **F1 (HIGH, correctness):** re-inviting a **revoked** writer silently failed —
  the `ADD_WRITER` gate skipped `host.addWriter` whenever `host.system.has(key)`
  was true, but that stays true for *removed* writers, leaving a phantom member
  (role set, never writable). Gate re-admission on our own `roles` view instead.
  Reproduced before/after; smoke: `re-invite-after-revoke`.
- **P1 (HIGH, P2P):** `createInvite` handed back the album key with **no owner
  check** — apply() gates *writes* to owners, but the key travels back *outside*
  apply(), so any device could leak read access. `createInvite`/`removeMember`
  now gate on `isOwner()`. Smoke: `owner-only invite/remove`.
- **P2 / M1 (HIGH/MED, P2P):** invites were permanent, unlimited-use, and never
  torn down (blind-pairing does NOT enforce `expires`, and has no one-shot). Now
  **single-use** (first valid candidate only; the rest denied) and re-issuing an
  invite closes the prior member so invites can rotate. Smoke: `single-use invite`.
- **F2 (MED, correctness):** the photo count went stale after a *remote* import —
  it was invalidated only by local imports. Now invalidated on any `base.on('update')`.
- **F3 (MED, correctness):** a member could shadow another's record by reusing its
  `blobsCoreKey`+`byteOffset`. The photo key now binds to the **authoring writer**
  (`node.from.key`, autobase-attested), so a forgery keys under its own identity.
- **F5/F6/F7 (LOW):** `IMPORT_RAW` header length reads unsigned (`>>> 0`);
  `removeMember` fails loudly from a non-owner instead of reporting a phantom
  success; swarm connections get a noop `error` listener; `maxPeers: 64` bounds fan-out.
- **F4 (doc, was wrong):** the "8th-optional-field flag-byte cliff" does not exist
  — the codegen switches to variable-width flags at field 8 (verified n=8/9
  round-trip). Corrected in `build-schema.mjs` and the README.
- **X1 / peek (HIGH, completeness):** Ch7 encryption silently broke `peek.mjs` —
  it now accepts an album key (`node peek.mjs <library-key> <album-key-hex>`) and
  explains the keyless/blind case; false README/App copy corrected.
- **Docs/tests:** README gained ch06/ch07 rows and the join.mjs Layout entry;
  undeclared direct deps declared (`z32`, `hypercore-crypto`; `hyperdht` devDep;
  desktop `z32`); the jest preset fixed (`@react-native/jest-preset` installed) and
  the assertion-free template test replaced with real `Meter` unit coverage (2 pass).

### Still open (device- or feature-gated — NOT fixed here)

- **C2 (Android store):** 16KB page-size compliance unverified (TFLite 2.14.0,
  targetSdk 36) — needs a release-APK `zipalign -c -P 16` check.
- **R1 (mobile lifecycle):** bare-kit's native AppState listener may suspend the
  worklet before the app's `SUSPEND` RPC runs, so the swarm/blob-server sockets may
  not close on background (see the bare-kit 0.15 auto-suspend drift note above).
  Needs on-device confirmation.
- **X2 (completeness):** a phone still can't join as a second device (the Vault
  `bootstrap` path works under Node, but there's no JOIN RPC, UI, or delivered-key
  persistence). A dedicated milestone.
- **H5 (production):** the 2.76 MB worker bundle is inlined as a Hermes string;
  shipping it as an async-read asset is a device-tested refactor.

## Ch07 M3 — content-key rotation on revocation (2026-07-20)

Closes the audit's P3/H2: a kicked member no longer reads new content. The album
key stays MEMBERSHIP (never rotates — you can't un-replicate a log). A separate
**content key** encrypts each photo's browsable content and rotates on every kick.

- **Two-tier keys.** `worker/rotation.js`: a seed-derived X25519 **box keypair**
  per device (a sibling of primaryKey/album-key derivations); `crypto_box_seal` to
  wrap a content key for one member; `crypto_secretbox` for the content itself.
  Epoch 0's content key IS the album key (every member has it via pairing); each
  later epoch is a fresh random key.
- **Rotation.** `removeMember` on an encrypted album appends `REMOVE_WRITER` then
  `ROTATE_KEY` — a new epoch's content key sealed once per REMAINING member (by
  writer key → box key from the `members` view bee) and carried in the log. The
  removed member has no sealed copy. `rotations` (view bee) holds the sealed keys;
  each device unseals the one addressed to it (`_syncContentKeys`).
- **What's sealed.** The thumbnail (content-encrypted in the record; reads back
  `''` without the key) and the bytes (each epoch's photos live in their own blob
  core keyed at the hypercore layer by that epoch's content key; the blob-server
  `resolve` hook hands back the per-core key). A revoked member decrypts the album
  metadata but not the pixels of post-kick photos.
- **Schema.** `photo` gains an optional `epoch` uint — the **7th** optional field,
  still inside the codec's one-byte flag fast path (this is the F4 correction made
  concrete). Old (v1, no-epoch) records decode as epoch 0.
- **Inv-9 (new):** *revocation rotates the future, not the past.* A kicked member
  keeps every content key it legitimately held; it is only sealed OUT of the keys
  minted after its kick. Forward-only, the encryption analogue of Inv-8.
- Smoke: founder + two members; kick one; the remaining member unseals the new key
  and reads the post-rotation photo, the kicked member reads it redacted (`''`) and
  never receives the key, and keeps its pre-kick content. `content-key rotation on
  revoke` in the suite. Stable across repeated runs.
- **Honest boundary:** a still-connected kicked member sees that new photos EXIST
  (name, time — the metadata skeleton in the album-encrypted view); rotation
  redacts the CONTENT (thumbnail + bytes), not the existence. App UI + blob-server
  streaming of originals under rotated keys is device-verified follow-on.

## Ch08 M1 — suspend/resume becomes real (2026-07-21)

The lifecycle pair (`Vault.suspend()/resume()`, CMD 3/4, the AppState hook) had
been wired since Ch1 and **never executed by any test** — the vault-client
comment even called it dead code without the hook. M1 makes it load-bearing:

- **Serialized transitions.** The OS can flip background→active→background
  faster than a transition completes; an unserialized resume interleaving a
  half-done suspend ends foregrounded-with-a-dead-swarm (or the inverse). Both
  transitions and `close()` now run through one queue on the Vault; the
  suspended-flag check lives INSIDE the queue so a storm collapses to no-ops.
  Smoke: four transitions fired in one tick, last one wins.
- **Bounded import drain.** SUSPEND's reply is the app's freeze signal, so it
  must mean *quiescent*: suspend waits (≤5 s, then proceeds anyway — suspension
  is not graceful shutdown, Inv-10) for in-flight imports before dropping
  sockets. Smoke: an import racing suspend lands exactly once, before suspend
  resolves.
- **Share-under-suspension guard.** A first import while backgrounded mints the
  swarm via `share()` — it must come up suspended, not live, or the vault's
  flag and the actual sockets disagree until the next transition.
- **Local-first under suspension.** A suspended vault still imports (Autobase
  local append needs no network); only replication and the localhost
  blob-server stall. Smoke: import-while-suspended, socket released, count
  exact.
- **Blob links survive resume.** blob-server 1.15 `_listen()` re-binds its
  ORIGINAL port on resume and falls back to a fresh one only if that bind now
  fails (`refreshLink()` exists for that case) — so original-photo links held
  by the UI keep working across a background round trip. Smoke: fetching a
  pre-suspension link is refused while suspended, then serves the same bytes
  after resume.
- **Finding — simultaneous resume is a dead zone.** Reconnection after resume
  is driven by the resumer's own re-announce + re-query. Two peers resuming at
  the same moment can each miss the other's records and idle until the next
  topic refresh: measured on `hyperdht/testnet`, one-sided resume against a
  live peer reconnects in ~26 ms; simultaneous resume showed no reconnect
  after 60+ s. The smoke deliberately models the one-sided case (a phone
  resumes into a world where some peer stayed up); the chapter's deep-dive
  owns the simultaneous case (it is also why an always-on mirror — Part 9 —
  earns its keep).

## Ch08 M2 — the suspend→resume exception filter (2026-07-21)

The OS closes a backgrounded app's sockets behind its back; on resume, Bare
cleans up the corpses and throws from callbacks with no JS catcher — crashing
the worklet on every re-focus. `worker/lifecycle.js` + the install in
`worker/index.js`:

- **Narrow allowlist, cause-chain aware.** `ENOTCONN / ECONNRESET / EPIPE /
  ETIMEDOUT / ECONNABORTED` only — teardown errors surface WRAPPED out of
  hyperswarm/secret-stream internals, so the predicate walks `err.cause`
  (bounded at 8 hops; a cyclic chain terminates). Nothing else is ever
  swallowed: the allowlist stays narrow so real bugs crash loudly.
- **A window, not a mode.** The filter is live from the moment SUSPEND begins
  until 5 s after RESUME completes — dead-socket cleanup fires during and
  shortly *after* resume, not neatly inside the suspended state. Outside the
  window the identical benign error is fatal, same as before the filter
  existed.
- **Every swallow is logged.** A silent crash-eater is worse than a crash.
- **Host-agnostic install.** The emitter is a parameter: `Bare` in the worklet
  (consistent with the existing `Bare.on('teardown')`), `process` under Node —
  which is how the smoke proves the real semantics: a child process survives a
  wrapped `ECONNRESET` thrown inside the window (exit 0), and dies on the
  identical throw with the window closed (non-zero) — the filter never
  outlives its window.
- On-device verification (a real backgrounded worklet throwing on re-focus) is
  the chapter's device-soak territory, with the rest of Ch8.

## Ch08 M3 — the import pump parks at the photo boundary (2026-07-21)

The Part 2 deferral, closed at the app seam. A batch import backgrounded
mid-run used to keep pumping: each iteration mmaps a file into an ArrayBuffer
(the hand-rolled C++ HybridObject or the Nitro Kotlin `readBytes`) whose native
region the OS can reclaim under background memory pressure while the JS side
still holds views — the ownership rule from Ch2, now exercised by the
lifecycle instead of the happy path.

- **Park between photos, not mid-photo.** When AppState leaves `active`, the
  pump finishes the photo in flight and parks at the boundary — the previous
  region is dead, the next is unborn, and the worker has drained its own
  in-flight tail (M1's SUSPEND contract). It resumes where it left off on
  re-focus. The check→park sequence is atomic w.r.t. the AppState callback
  (run-to-completion JS thread), so a waiter can't be stranded by a
  background→active flip racing the park.
- **The meter parks too.** Backgrounded timers get throttled, so the 16 ms
  heartbeat gap would read back as a fake multi-second "stall", and parked
  wall-clock would dilute throughput. `Meter.pause/resume` stops the heartbeat
  and excludes parked time: the reading measures the import, not the pocket.
- Device verification (background a 30-photo batch mid-run, re-focus, reading
  sane, no reclaim crash) is the chapter's device-soak territory.

## Ch09 M1 — tiered retention: evict originals, keep the index (2026-07-21)

Inv-11: append-only storage grows monotonically until forced otherwise. The
forcing is `core.clear(start, end)` on BLOB cores only — the plan's scary
version (hypercore-11 mark-and-sweep against a live Hyperbee, atoms for
evict+pointer atomicity) dissolves in this architecture:

- **The bee is never evicted.** Records, thumbnails, and embeddings are the
  index tier — small, always local. Eviction touches only original bytes in
  blob cores, and the record keeps its blob coordinates, so nothing in the
  view changes: no pointer update, no atomicity problem, no node-cache/sweep
  interaction. Pure local storage reclaim.
- **Cold is the natural state.** Sparse replication already moves blob bytes
  on demand only — a freshly replicated record starts cold (smoke asserts
  this), a tap pages it in through the blob-server, `evict()` just returns a
  record to that state. `resident` (range `core.has`) surfaces hot/cold to the
  UI; `storageStat()` totals the tiers.
- **The oracle.** `evictionCandidates({ bytes })`: near-duplicates first —
  same dHash threshold (12) and degenerate-hash exclusion as the grid, so the
  worker evicts exactly what the UI calls a duplicate — then oldest-first.
  No byte target → no candidates: eviction is never implicit.
- **Honest boundary:** an evicted original is unreachable until SOME peer
  holds it (smoke: index still browses with the only peer gone; the record is
  cold, not silently missing). The policy answer — evict only what an
  always-on mirror holds — is M2's job.
- Wire contract: `EVICT: 12`, `STORAGE_STAT: 13` appended (ids are
  load-bearing, never renumbered); `LIST` gains an opt-in `residency` flag.

## Ch09 M2 — the blind peer: an always-on cold tier that reads nothing (2026-07-21)

New pins (constructor shapes validated against installed source per the
standing decision — the two packages' READMEs have historically disagreed):

| Package | Version | Validated surface |
|---------|---------|-------------------|
| blind-peering | 2.4.1 | client is `new BlindPeering(dht, store, { wakeup, keys, pick, suspended })` — DHT not swarm; `keys` REQUIRED or it silently contacts nothing; `addAutobaseBackground(base)` / `addCoreBackground(core, { referrer })`; `suspend()/resume()/close()` |
| blind-peer (devDep, smoke only) | 3.12.2 | server is `new BlindPeer(rocksPath, { bootstrap })` (ReadyResource) + `listen()`; `publicKey` = its swarm key (what clients list in `keys`); `digest` = `{ referrers, cores, bytesAllocated }` |
| protomux-wakeup | 2.9.0 | `new Wakeup(onwakeup = noop)` — handler optional in this version; every swarm connection must be fed via `wakeup.addStream(conn)` |

Wiring: `Vault` takes `blindPeerKeys`; the client is created with the swarm in
`share()` (`suspended: this.suspended` so a swarm minted mid-background gets a
suspended mirror client too), registers the autobase + every blob core
(background variants — mirror registration never blocks boot or an import),
re-registers each new per-epoch blob core on rotation, and follows the Ch8
lifecycle queue (suspend first — mirror RPC state rides the DHT, which
swarm.suspend takes down; resume last, after the DHT is back). Worker takes the
mirror key as `Bare.argv[1]` (z32).

Smoke (all hermetic, testnet): mirror absorbs (digest moves) → **founder
closes** → a fresh member converges from the mirror alone and pages the
ORIGINAL in from it (M1's honest boundary, closed) → the mirror's storage
greps clean of the plaintext thumbnail marker, with a positive control proving
the grep detects plaintext in an unencrypted store → mirror client follows
vault suspend/resume.

Not wired: `blind-push` (push-style wakeups are mobile push infrastructure —
infra follow-on, not code this repo can prove); deeper protomux-wakeup
semantics (backgrounded phone learns what the mirror absorbed) are
device-verified territory.

## Ch10 M1 — key continuity: the silent failures found by writing the test (2026-07-21)

Part 10's "multi-device unlock distribution" turned out to be TWO real bugs in
this codebase, both silent (nothing crashed; photos just rendered redacted for
devices that deserved them):

- **The rebooted owner.** `rotateContentKey` sealed the new epoch's key to every
  remaining MEMBER — and kept the owner's copy only in `contentKeys` (memory).
  A founder restart re-derived everything from its seed except the rotated
  keys: the owner's own post-rotation photos went dark. Fix: every rotation
  now also seals to the owner's own box key; the rebooted founder re-learns
  its epochs from the same rotations rows as everyone else. The smoke fails on
  exactly this assertion with the fix reverted (verified via stash).
- **The late joiner.** A member paired AFTER a rotation received the album key
  (epoch 0) in the pairing confirm but no sealed copies of epochs ≥ 1 — every
  pre-join rotation stayed redacted for a legitimate member forever. Fix: new
  command `GRANT_KEYS: 6` (wire ids are append-only) — `createInvite` follows
  ADD_WRITER with sealed copies of every epoch the owner holds. `apply()`
  gates it owner-only + roster-only, skips unknown epochs (a grant can't
  invent history), and never overwrites an existing sealed copy (first write
  wins). The joiner's existing `_syncContentKeys` picks grants up unchanged.
- **Semantics note:** a kicked-then-reinvited member gets full history back by
  construction — re-inviting IS re-sharing, not a redaction tool. The kicked
  state is where Inv-9 lives, and the smoke re-asserts the kicked member gains
  nothing from either fix.

## Ch10 M2 — a private discovery topic (2026-07-21)

`discoveryKey(libraryKey)` is a PUBLIC derivation. An encrypted album swarming
on it protected the content but not the people: any library-key holder could
join the topic and harvest members' IP addresses. Members now meet on
`hash('shoebox:album-topic:v1' || albumKey)` — finding the members requires
the same secret as reading them; the library key stays a shareable identifier
that leaks neither. Implemented once in `worker/library.js` (`discoveryTopic`)
and shared by the vault, `peek.mjs`, `join.mjs`, and the smoke — one derivation,
no drift. Unencrypted libraries keep the classic topic; blind mirrors are
unaffected (dialed directly by key, no topic involved).

Smoke: derived ≠ public + deterministic; a library-key-only stranger camping
on the legacy topic gets ZERO connections (bounded negative); an album-key
holder connects on the derived topic. The Ch7 pairing section and README peek
note updated: a bare `peek.mjs <library-key>` now finds nobody instead of
replicating ciphertext — strictly less signal to strangers.

Boundary: the pairing INVITE still announces on its own blind-pairing topic
(that's its job — a candidate must find the owner before it holds any key),
and DHT-level traffic analysis is out of scope for a topic derivation.

## Ch10 M3 — loud metrics for silent failures (2026-07-21)

The failure class that kills trust in a no-server app is the one that makes no
sound: a resume that reconnects nobody, a view that quietly stops advancing.
`Vault.status()` now rides every STAT — `peers` (the pipe exists),
`lastUpdateAt` (the library actually moved; stamped on every view advance,
local or replicated), `suspended` (why it might not be moving) — and the app
shows a permanent sync line ("N peer(s) · library moved Xs ago", 10 s poll).

Honesty note baked into the smoke: even a "fresh" founder has already moved —
ensureOwner()'s role claim advances the view during boot, and lastUpdateAt
reports that too. After suspend, peers reads 0 (connections are genuinely
destroyed) and suspended: true says why — the two numbers together distinguish
"backgrounded" from "broken".

## Post-audit hardening (4-dimension audit, 2026-07-21)

A correctness / completeness / P2P-readiness / production-readiness audit
(four parallel auditors + adversarial re-verification against the code) found
the following. Fixes land in severity batches, each counterfactual-verified
(revert the fix → the new smoke assertion fails).

### Batch 1 — encryption correctness

- **AF-H1 (HIGH, correctness):** on an ENCRYPTED album, importing into an epoch
  whose content key hadn't replicated in yet silently opened an UNENCRYPTED blob
  core and stored a PLAINTEXT thumbnail — plaintext bytes then replicated to the
  blind mirror, and the photo later "decrypted" into garbage for everyone. Real
  trigger: a late joiner in the window between applying `ROTATE_KEY` (epoch
  advances) and its `GRANT_KEYS` (its sealed copy). `_importPhoto` now refuses
  the import when `encryptionKey` is set but the epoch's content key is absent.
  Smoke: `AF-H1` (counterfactual-verified).
- **AF-M4 (MEDIUM, correctness/P2P):** concurrent `removeMember` calls could each
  read the same `currentEpoch` and mint the SAME epoch with different keys — the
  second `ROTATE_KEY` clobbering the first and orphaning photos encrypted under
  the losing key. Two-part fix: membership mutations are serialized
  (`_withMembershipLock`), and `apply()` makes a rotations row **write-once**
  (first `ROTATE_KEY` for an epoch wins, duplicate dropped) as a
  partition/second-owner backstop. Smoke: `AF-M4`.
- **AF-M8 (MEDIUM, completeness):** revocation redacted the thumbnail + bytes but
  left the `dhash` and the MobileNet `embedding` (a 1001-way "what this depicts"
  distribution) in the album-key view in cleartext — a kicked member could still
  classify post-kick photos, contradicting the "name and time only" boundary.
  Both fields are now content-encrypted under the epoch key alongside the
  thumbnail (`_encStr`/`_encBuf`, decrypted in `decorate`). Smoke: `AF-M8`.

### Batch 2 — JOIN robustness

- **AF-H2 (HIGH, correctness/P2P/production):** JOIN closes the live vault, then
  `await candidate.pairing` — which polls FOREVER when the inviting device is
  offline or the invite is spent-but-not-denied. The `finally { bootVault() }`
  never ran, leaving the worker with `vault === null` and every later RPC
  erroring until an app restart. `pairAsCandidate` now bounds pairing with a
  75 s timeout (races the pending pairing, cleans up, throws → the caller's
  `bootVault()` recovers as founder). A terminal `.catch` on the aborted
  candidate prevents a late unhandled rejection (crashes Bare). Every RPC but
  JOIN now short-circuits with a clean "busy joining" reply while the vault is
  briefly null. The candidate swarm also gets a per-socket error handler (a
  pairing-window ECONNRESET used to crash the foreground worklet). Smoke:
  `AF-H2` (bounded reject, prompt return).
- **AF-M5 (MEDIUM, production):** the suspend→resume exception-filter window
  could stick OPEN — `onResume` ran only after a successful `vault.resume()`, so
  a throwing resume (or a SUSPEND during the null-vault JOIN window) left the
  filter swallowing FOREGROUND socket errors indefinitely. SUSPEND now closes
  the window if the suspend fails, RESUME closes it in a `finally`, and the
  null-vault guard means a mid-JOIN SUSPEND never opens it in the first place.

### Batch 3 — founder announce + lifecycle loose ends

- **AF-H7 (HIGH, completeness):** a rebooted FOUNDER never re-announced —
  `bootVault` called `share()` only in the member branch — so it sat at peers:0
  with no replication and no blind-mirror registration until its next import,
  which the Ch10 sync line then misread as failure and which stranded members
  trying to sync from it. Both roles now `share()` on boot (idempotent; the
  swarm suspends on background, so announcing on launch is the right default).
- **AF-L (lifecycle):** `share()`'s "suspend the freshly-minted swarm" step now
  runs INSIDE the transition queue, so a concurrent `resume()` can't race it to
  a half-live state; `blind.resume()` and `blind.close()` are now awaited inside
  the transition (an unawaited mirror-teardown rejection could crash Bare).

### Batch 4 — storage bounds, session leaks, count race, RPC hardening

- **AF-H8 (HIGH, production):** `storageStat()` materialized every record
  (`{ ...value }` with its ~20-30 KB thumbnail + embedding) into one array, and
  the eviction oracle loaded 1000 fully-decorated records with an O(n²) Hamming
  pass — spiking the worklet and blowing the RPC timeout on a large library.
  `storageStat` now streams a minimal projection (blob coordinates + byteLength);
  `evictionCandidates` streams oldest-first, decrypts only the one dHash field,
  compares against a bounded 256-hash window (O(n·window)), caches shared blob
  cores across the scan, and is capped at `maxScan` (logs when hit). EVICT and
  STORAGE_STAT get a 60 s client deadline.
- **AF-M6 (MEDIUM, correctness):** a count scan finishing AFTER a mid-scan
  invalidation used to re-poison `_count` with a stale snapshot; `ensureCount`
  now publishes only if its scan is still current (`this._counting === scan`).
- **AF-M9 (MEDIUM, production):** RPC input bounds — a 32 MB payload cap and a
  32-deep in-flight cap (excess rejected, not queued), `EVICT` ids must be an
  ARRAY (a bare string used to iterate per character), and `evict()` skips
  non-hex ids. `removeMember` already length-checks its hex (AF-M4). Smoke:
  `AF-M9`.
- **AF-M11 (MEDIUM, production):** `core.ready()` moved INSIDE the try in
  `_markResidency`/`evict` (and the oracle scan), so a ready/has failure on a
  corrupt or forged core closes the session instead of leaking one per scan.

### Batch 5 — identity / persistence robustness

- **AF-H3 (HIGH→CRITICAL, production):** a null `documentsPath()` (native paths
  module not registered) silently sent the seed, membership, and all cores to a
  PURGEABLE tmpdir. The app now surfaces a loud "storage is TEMPORARY" warning
  and no longer pretends the fallback is harmless; `paths.ts` documents that the
  caller must react to null.
- **AF-M12 (MEDIUM→HIGH, correctness/production):** `loadOrCreateSeed` treated
  ANY read failure (and any wrong length) as "first boot" and overwrote the
  seed; `loadMembership` treated a truncated file as "founder". Both are now
  distinguished: a genuinely-absent file behaves as before, but a
  present-but-wrong-length artifact throws LOUD (never silently re-mints an
  identity or re-founds over a joined store). Writes are atomic (temp + rename),
  so a crash/disk-full mid-write can't create the truncated file in the first
  place. Smoke: `AF-M12`.
- **AF-H5 (partial):** artifacts are written with owner-only perms (0o600) where
  the host supports `chmodSync`. The full at-rest story — platform keychain
  (iOS Keychain / Android Keystore) for the seed and a 24-word mnemonic backup
  — remains native work (a documented future chapter), and stays a ship-blocker
  for the "data collected: none" claim until done.

### Batch 6 — app reachability + observability

- **AF-M2 (HIGH, completeness):** the blind mirror — the Ch9 centerpiece and
  flow 3 of Part 10's privacy narrative — was unreachable from the phone: the
  worker only read a mirror key from `Bare.argv[1]`, which `App.tsx` never
  supplied. Now `Vault.addMirror()` registers a mirror at RUNTIME (creates the
  client if `share()` already ran, feeds it existing connections, registers the
  autobase + blob cores); a `SET_MIRROR` RPC persists the key (merged with the
  boot arg on every launch); the app has a "Set mirror" input; and STAT reports
  the configured count. Smoke: `AF-M2` (runtime-added mirror absorbs, idempotent).
- **AF-M1 (HIGH, completeness):** "Evict originals" was a data-loss button in
  the app's only reachable config — with no mirror and no peer, it cleared the
  sole copy while the caption promised "re-fetch on tap". Eviction now REFUSES
  when no holder exists (mirrors 0 AND peers 0) and always confirms.
- **AF-M13 (MEDIUM, production):** the sync line froze at a stale value when the
  worker died/hung; a failed STAT poll now flags "⚠ worker not responding".
- **AF-L:** `joinLibrary`/`inviteDevice` now honor the `busyRef` reentrancy
  guard (a Join mid-import used to close the vault under the running pump).

### Batch 7 — desktop tools + doc nits

- **AF-M7 (MEDIUM, completeness/correctness):** both desktop tools were
  epoch-blind. `join.mjs` was rewritten to run the SAME `pairAsCandidate()` +
  `Vault` path the phone uses — fixing three things at once: the box keypair now
  comes from a persisted RANDOM seed (the old hardcoded `'shoebox-desktop-demo-
  seed-000000'` let any repo reader unseal every rotated content key sealed to a
  desktop member), imports are epoch-aware (no more epoch-0 Inv-9 bypass), and
  GRANT_KEYS/rotation are handled by the Vault. `peek.mjs` now reads the newest
  EPOCH-0 photo it can actually decrypt and reports skipped post-rotation photos,
  instead of writing garbage the album key "decrypts" into noise.
- **AF-L:** peek uses a unique per-run store dir (was a fixed tmpdir → lock
  contention); the Grid ❄ badge clears when a tap pages a photo in; the Grid's
  stale "7-field flag-byte cliff" comment is corrected to match F4; and the
  privacy-narrative assertions the Part 10 draft references are now marked
  `// REVIEWER:` in the smoke, making that claim literally true.

### Batch 8 — relay fallback, bundle-freshness gate, role hardening

- **AF-H6 (HIGH, P2P):** `relayThrough` is now wired into every swarm (vault,
  pairing candidate) and the mirror client, from an optional `shoebox-relay`
  file (one z32 key). null → no relay (as before); a deployment supplies a
  running relay node's key for symmetric-NAT/CGNAT coverage. Smoke: `AF-H6`
  (the key threads through; connectivity via a real relay node is a deployment
  concern, not asserted). **Remaining:** operating a relay node is a deployment
  step, not code — and until one is configured, two both-symmetric-NAT peers
  with no mirror between them still can't connect.
- **AF-H9 (HIGH, production):** `app/check-bundle.mjs` + `npm run check:bundle`
  hash the worker source and compare to `worker.bundle.hash` (recorded by
  `bundle:worker`), so a stale committed bundle fails the check. Verified: a
  one-line worker edit makes the gate report STALE. **Remaining:** wire
  `check:bundle` into a precommit hook / CI (the repo has neither yet).
- **AF (latent SET_ROLE):** `apply()` now writes only KNOWN roles — an owner
  can set MEMBER, and only the one-time bootstrap self-claim mints an OWNER; a
  second-owner or garbage-role SET_ROLE is a no-op. Smoke: exactly-one-owner
  invariant holds after a promote attempt.

### Documented as remaining (native / deployment work, not in-repo code)

- **AF-H5 (full):** platform keychain (iOS Keychain / Android Keystore) for the
  seed + a 24-word mnemonic backup. Partial done (atomic writes, 0o600). This
  is the standing ship-blocker for the "data collected: none" claim.
- **AF-M10:** thumbnails live in both the append-only log block and the view,
  are never evictable, and every new device replays full history — ~1-2 GB at
  50k photos. The real fix (thumbnails as blob pointers + snapshot/prune) is a
  future chapter; the RAM half is already noted in the Grid limitation.
- **AF-M13 (full):** the sync line now flags a non-responding worker (Batch 6),
  but structured error codes (vs stringified stacks) and an on-disk rolling
  diagnostics buffer remain for a production observability pass.
- **AF-L (refreshLink):** the blob-server's fresh-port fallback is unwired; held
  links break only if the original-port re-bind fails on resume (rare), and the
  grid re-mints links on reopen. Left as a known minor.
