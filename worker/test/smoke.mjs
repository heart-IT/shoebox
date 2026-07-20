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
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperblobs = require('hyperblobs')
const idEncoding = require('hypercore-id-encoding')
const { resolveStruct } = require('../spec')
const { CMD, commandEncoding, openView, apply } = require('../library')
const { primaryKeyFromSeed } = require('../identity')

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

// Ch5: a read replica bootstrapped from the LIBRARY key (base.key) converges to
// the same view — and fetches the blob BYTES — over replication, with no network.
// This is the desktop peer's exact path (open/apply shared via ../library). The
// loop yields with setImmediate so replication gets real event-loop turns.
const fDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-founder-'))
const founder = new Vault(fDir)
await founder.ready()
const { indexKey: libKey } = await founder.importPhoto(PNG_1PX, { name: 'shared.png', takenAt: 7000 })
const rDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-replica-'))
const replicaStore = new Corestore(rDir)
const replica = new Autobase(replicaStore, idEncoding.decode(libKey), { open: openView, apply, valueEncoding: commandEncoding })
await replica.ready()
const r1 = founder.base.replicate(true)
const r2 = replica.replicate(false)
r1.pipe(r2).pipe(r1)
let seen = null
for (let i = 0; i < 300 && !seen; i++) { await new Promise((res) => setImmediate(res)); await replica.update(); seen = await replica.view.peek({ reverse: true }) }
assert.ok(seen && seen.value.name === 'shared.png', 'a read replica converges to the founder photo over replication')
const rblobs = new Hyperblobs(replicaStore.get({ key: seen.value.blobsCoreKey }))
let bytes = null
for (let i = 0; i < 300 && !bytes; i++) { await new Promise((res) => setImmediate(res)); bytes = await rblobs.get({ blockOffset: seen.value.blockOffset, blockLength: seen.value.blockLength, byteOffset: seen.value.byteOffset, byteLength: seen.value.blobByteLength }).catch(() => null) }
assert.ok(bytes && b4a.from(bytes).equals(PNG_1PX), 'replica fetches the blob bytes over replication (view + blob path)')
r1.destroy(); r2.destroy()
await founder.close(); await replicaStore.close()
fs.rmSync(fDir, { recursive: true, force: true }); fs.rmSync(rDir, { recursive: true, force: true })

// Ch5 M2: a device's identity is its seed. The Corestore primary key derives
// from it deterministically, so the SAME seed → the SAME device writer key — the
// property a future 'restore from mnemonic' stands on. Two fresh stores seeded
// identically must yield the identical device key.
const idSeed = b4a.from('22'.repeat(32), 'hex')
assert.ok(b4a.equals(primaryKeyFromSeed(idSeed), primaryKeyFromSeed(idSeed)), 'primaryKeyFromSeed is deterministic')
assert.equal(primaryKeyFromSeed(idSeed).byteLength, 32, 'primary key is 32 bytes')
const idA = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-idA-'))
const va = new Vault(idA, { primaryKey: primaryKeyFromSeed(idSeed) })
await va.ready()
const deviceKeyA = b4a.toString(va.deviceKey, 'hex')
await va.close()
fs.rmSync(idA, { recursive: true, force: true })
const idB = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-idB-'))
const vb = new Vault(idB, { primaryKey: primaryKeyFromSeed(idSeed) })
await vb.ready()
const deviceKeyB = b4a.toString(vb.deviceKey, 'hex')
await vb.close()
fs.rmSync(idB, { recursive: true, force: true })
assert.equal(deviceKeyA, deviceKeyB, 'same seed → same device writer key (recovery-ready)')

// Ch5 M3+M4: pairing makes a SECOND device a writer, and imports converge BOTH
// ways. The founder imports 'phone.png'; the device is added via ADD_WRITER and
// becomes writable; it imports 'laptop.png' into its OWN blobs core; both views
// linearize to hold both photos. (The blind-pairing transport is verified on
// device; here we prove the apply() gate + the multi-writer merge under Node.)
const founderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-founderW-'))
const fVault = new Vault(founderDir)
await fVault.ready()
await fVault.importPhoto(PNG_1PX, { name: 'phone.png', takenAt: 8000 })
const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-devW-'))
const devStore = new Corestore(devDir)
const localCore = Autobase.getLocalCore(devStore)
await localCore.ready()
const devWriterKey = localCore.key
await localCore.close() // release the exclusive lock before the base reopens it
await fVault.base.append({ type: CMD.ADD_WRITER, writerKey: devWriterKey })
await fVault.base.update()
const devBase = new Autobase(devStore, fVault.base.key, { open: openView, apply, valueEncoding: commandEncoding, ackInterval: 1000 })
await devBase.ready()
const w1 = fVault.base.replicate(true)
const w2 = devBase.replicate(false)
w1.pipe(w2).pipe(w1)
for (let i = 0; i < 400 && !devBase.writable; i++) { await new Promise((res) => setImmediate(res)); await devBase.update() }
assert.ok(devBase.writable, 'a second device becomes writable after ADD_WRITER')
// the device imports into its OWN blobs core; a pointer command hits the log
const devBlobs = new Hyperblobs(devStore.get({ name: 'photo-blobs' }))
const devId = await devBlobs.put(PNG_1PX_RED)
await devBase.append({ type: CMD.IMPORT_PHOTO, photo: {
  name: 'laptop.png', takenAt: 9000, mime: 'image/png', byteLength: PNG_1PX_RED.byteLength,
  blobsCoreKey: devBlobs.core.key, blockOffset: devId.blockOffset, blockLength: devId.blockLength,
  byteOffset: devId.byteOffset, blobByteLength: devId.byteLength,
  width: 0, height: 0, orientation: 0, thumb: '', dhash: '', embedding: null,
} })
await devBase.update()
const viewNames = async (base) => { await base.update(); const out = []; for await (const { value } of base.view.createReadStream()) out.push(value.name); return out.sort() }
let dn = [], fn = []
for (let i = 0; i < 400; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update(); dn = await viewNames(devBase); fn = await viewNames(fVault.base); if (dn.length === 2 && fn.length === 2) break }
assert.deepEqual(dn, ['laptop.png', 'phone.png'], 'device view holds BOTH photos')
assert.deepEqual(fn, ['laptop.png', 'phone.png'], 'founder view holds BOTH photos — the laptop import converged')
w1.destroy(); w2.destroy()
await devBase.close(); await devStore.close(); await fVault.close()
fs.rmSync(founderDir, { recursive: true, force: true }); fs.rmSync(devDir, { recursive: true, force: true })

console.log('smoke: ok — indexed, range query, 64-bit key, no collision, Inv-4, 0-byte, count-race, read-replica, seed-identity, pairing→writable, two-writer convergence all verified')
