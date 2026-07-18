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
