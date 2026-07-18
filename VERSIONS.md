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
