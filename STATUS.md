# Shoebox — repo state

_Snapshot: 2026-07-22. A P2P photo library on React Native (Holepunch stack). Companion to the [Shoebox blog series](https://heartit.tech/category/local-first/) (source: heart-IT/heartit-blogs, `local-first/`)._

## Branches & tags

- **`main`** — the working tip; the full, audited codebase (all 10 chapters + post-ship hardening).
- **`ch01-one-photo` … `ch10-shipping`** — the ten per-chapter checkout points. Each blog post pins one (`git checkout ch0X-…`); all ten are pushed and in sync with `origin`.
- No other tags. (Earlier `v1.x-audited` version tags were removed — they only aliased chapter commits and nothing referenced them.)

## Verification

- **Worker smoke: 11/11 green** — `worker/test/smoke.mjs` run under Node on `main` and every chapter tag. Assertion groups grow monotonically with the series (ch01: 2 → ch10: 28 → `main`: full set), confirming each tag is its own chapter and `git checkout ch0X && npm test` works with no dependency drift.
- **CI-gated** — the worker smoke is the CI check (`.github/workflows/ci.yml`); the committed worker bundle has a freshness gate (`app/check-bundle.mjs`, pre-commit hook).

## Known verification gap

The smoke covers the **host-agnostic worker only**. The app/native/on-device half — `npm run android`/`ios`, the Nitro modules across the JSI seam, the RN UI + blob-server render path, on-device ML, and two-device DHT replication — is **not exercised in CI or the audit** (no emulator/device available). See `VERSIONS.md` § _Verification scope — worker smoke vs. on-device (2026-07-22)_ and the device-gated items (C2 / R1 / H5).
