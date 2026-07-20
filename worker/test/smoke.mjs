// Vault smoke test under Node — proves the worker core is host-agnostic:
// import photos, serve them over the blob-server, range-query the time-ordered
// index, verify the Inv-4 append-only schema contract, the 64-bit key encoding
// on REAL epoch-ms values, and that same-time/same-name photos never collide.
import { createRequire } from 'module'
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const { Vault, writeUint64BE, photoKey } = require('../vault.js')
const c = require('compact-encoding')
const { resolveStruct } = require('../spec')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
// A second, distinct 1×1 (red) so a same-time/same-name pair has different bytes.
const PNG_1PX_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAdSm3AAAAAABJRU5ErkJggg==',
  'base64'
)

// --- Unit: 64-bit big-endian key encoding on a REAL epoch-ms value (> 2^32,
// which the high-word split exists for and which the vault path actually uses).
const nowMs = 1_752_900_000_000 // ~2025, well above 2^32
const buf = Buffer.alloc(8)
writeUint64BE(buf, nowMs, 0)
const back = buf.readBigUInt64BE(0)
assert.equal(Number(back), nowMs, '64-bit BE round-trips a real epoch-ms value')
// Chronological bytewise order: an earlier time sorts before a later one.
const kA = photoKey(1000, 'a.jpg', 0)
const kB = photoKey(2000, 'a.jpg', 0)
assert.ok(Buffer.compare(kA, kB) < 0, 'earlier capture time sorts first (bytewise)')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-smoke-'))
const vault = new Vault(dir)
await vault.ready()

// Import three photos with distinct capture times, out of order.
await vault.importPhoto(PNG_1PX, { name: 'b.png', takenAt: 2000 })
await vault.importPhoto(PNG_1PX, { name: 'a.png', takenAt: 1000 })
const { link } = await vault.importPhoto(PNG_1PX, { name: 'c.png', takenAt: 3000 })
assert.equal(await vault.count(), 3, 'three photos indexed')

// blob-server round-trip (the bytes never entered the record).
const res = await fetch(link)
assert.equal(res.status, 200, `blob-server responds 200 (got ${res.status})`)
assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG_1PX), 'bytes served match bytes stored')

// The index is a time-ordered window, not a folder walk: newest first.
const newest = await vault.list({ limit: 2, reverse: true })
assert.deepEqual(newest.map((p) => p.name), ['c.png', 'b.png'], 'range query returns newest-first window')
const latest = await vault.latest()
assert.equal(latest.name, 'c.png', 'latest() is the max capture-time')
assert.ok(latest.id && latest.id.length > 0, 'records carry a stable id')

// Regression for the fixed data-loss bug: two DISTINCT photos with the SAME
// capture-ms and SAME name must both survive (no key collision, no overwrite).
await vault.importPhoto(PNG_1PX, { name: 'dup.png', takenAt: 5000 })
await vault.importPhoto(PNG_1PX_RED, { name: 'dup.png', takenAt: 5000 })
assert.equal(await vault.count(), 5, 'same time+name photos do NOT collide')
const dups = (await vault.list({ limit: 100 })).filter((p) => p.name === 'dup.png')
assert.equal(dups.length, 2, 'both same-time/same-name photos are retrievable')
assert.notEqual(dups[0].id, dups[1].id, 'they get distinct ids')

// Inv-4: the schema is an append-only contract. A record written WITHOUT the
// optional fields still decodes; making them required would break it.
const enc = resolveStruct('@shoebox/photo', 1)
const oldShape = {
  name: 'legacy.png', takenAt: 500, mime: 'image/png', byteLength: 68,
  blobsCoreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, blobByteLength: 68,
} // no width/height/orientation/thumb/dhash/embedding — as an earlier version wrote
const decoded = c.decode(enc, c.encode(enc, oldShape))
assert.equal(decoded.name, 'legacy.png', 'a record missing the optional fields still decodes')
assert.equal(decoded.embedding, null, 'absent optional buffer reads as null')

// A 0-byte import is refused: hyperblobs does not advance byteOffset for an
// empty put, so the key disambiguator would degenerate and two empties could
// collide. The rejection must not touch the count.
await assert.rejects(
  () => vault.importPhoto(Buffer.alloc(0), { name: 'empty.png', takenAt: 6000 }),
  /empty/,
  'a 0-byte photo is rejected',
)
assert.equal(await vault.count(), 5, 'a rejected empty import leaves the count unchanged')

await vault.close()
fs.rmSync(dir, { recursive: true, force: true })

// A STAT racing the very first tree scan must not drift the count. On a fresh
// vault (count uncached), fire count() and the first import concurrently; the
// memoized scan plus importPhoto's pre-put ensureCount() must land the final
// count exactly, with no lost increment.
const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-race-'))
const raceVault = new Vault(raceDir)
await raceVault.ready()
const [racedCount] = await Promise.all([
  raceVault.count(),
  raceVault.importPhoto(PNG_1PX, { name: 'raced.png', takenAt: 3000 }),
])
assert.ok(racedCount === 0 || racedCount === 1, `raced STAT sees a consistent snapshot (got ${racedCount})`)
assert.equal(await raceVault.count(), 1, 'count is exact after a STAT raced the first import (no drift)')
await raceVault.close()
fs.rmSync(raceDir, { recursive: true, force: true })

console.log('smoke: ok — 5 photos indexed; time-ordered range query, 64-bit key, no same-key collision, Inv-4, 0-byte guard, count-race all verified')
