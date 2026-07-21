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
const { Vault, pairAsCandidate, writeUint64BE, photoKey } = require('../vault.js')
const c = require('compact-encoding')
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperblobs = require('hyperblobs')
const Hyperswarm = require('hyperswarm')
const BlindPairing = require('blind-pairing')
const z32 = require('z32')
const createTestnet = require('hyperdht/testnet')
const idEncoding = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const { resolveStruct } = require('../spec')
const { CMD, commandEncoding, openView, apply, roleOf } = require('../library')
const { primaryKeyFromSeed, saveMembership, loadMembership } = require('../identity')
const { memberBoxKeyFromSeed } = require('../rotation')

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
for (let i = 0; i < 300 && !seen; i++) { await new Promise((res) => setImmediate(res)); await replica.update(); seen = await replica.view.photos.peek({ reverse: true }) }
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
const viewNames = async (base) => { await base.update(); const out = []; for await (const { value } of base.view.photos.createReadStream()) out.push(value.name); return out.sort() }
let dn = [], fn = []
for (let i = 0; i < 400; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update(); dn = await viewNames(devBase); fn = await viewNames(fVault.base); if (dn.length === 2 && fn.length === 2) break }
assert.deepEqual(dn, ['laptop.png', 'phone.png'], 'device view holds BOTH photos')
assert.deepEqual(fn, ['laptop.png', 'phone.png'], 'founder view holds BOTH photos — the laptop import converged')
// Ch6 M1: roles + owner-only membership. The founder self-claimed owner; the
// writer it added is a member; and a member cannot add a writer of its own.
assert.equal(await roleOf(fVault.base.view.roles, fVault.base.local.key), 'owner', 'founder self-claimed owner')
assert.equal(await roleOf(fVault.base.view.roles, devWriterKey), 'member', 'the invited writer is a member')
const stranger = crypto.randomBytes(32)
await devBase.append({ type: CMD.ADD_WRITER, writerKey: stranger })
for (let i = 0; i < 200; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update() }
assert.equal(await roleOf(fVault.base.view.roles, stranger), null, 'a member cannot add a writer — owner-only membership')
// Ch6 M2: revocation. The owner kicks the member; the member loses write access
// (base.writable → false), but its already-shared photo stays (Inv-8: revoke the
// future, not the past).
await fVault.removeMember(b4a.toString(devWriterKey, 'hex'))
for (let i = 0; i < 400 && devBase.writable; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update() }
assert.ok(!devBase.writable, 'a revoked member loses write access')
assert.equal(await roleOf(fVault.base.view.roles, devWriterKey), null, 'the revoked member has no role')
assert.ok((await viewNames(fVault.base)).includes('laptop.png'), 'the revoked member\'s past photo remains (revoke the future, not the past)')
// Audit fix F1: RE-INVITING a revoked writer must restore write access. The gate
// used to skip host.addWriter whenever autobase still "had" the key — but system.has()
// stays true for REMOVED writers, so a re-add left a phantom (role set, never writable).
await fVault.base.append({ type: CMD.ADD_WRITER, writerKey: devWriterKey })
for (let i = 0; i < 600 && !devBase.writable; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update() }
assert.ok(devBase.writable, 'a re-invited (previously revoked) writer becomes writable again — no phantom member')
assert.equal(await roleOf(fVault.base.view.roles, devWriterKey), 'member', 'the re-invited writer is a member again')
// Audit fix F3: a photo key binds to the AUTHORING writer (autobase-attested), so a
// member cannot shadow another writer's record by reusing its blobsCoreKey+byteOffset.
// devBase forges the founder's exact blob coordinates (phone.png @ 8000, offset 0) with
// tampered metadata; the genuine record must survive as a DISTINCT entry, not be overwritten.
await devBase.append({ type: CMD.IMPORT_PHOTO, photo: {
  name: 'phone.png', takenAt: 8000, mime: 'image/png', byteLength: PNG_1PX.byteLength,
  blobsCoreKey: fVault.blobs.core.key, blockOffset: 0, blockLength: 1, byteOffset: 0, blobByteLength: PNG_1PX.byteLength,
  width: 0, height: 0, orientation: 0, thumb: 'FORGED', dhash: '', embedding: null,
} })
for (let i = 0; i < 400; i++) { await new Promise((res) => setImmediate(res)); await fVault.base.update(); await devBase.update() }
const phoneRecs = []
for await (const { value } of fVault.base.view.photos.createReadStream()) if (value.name === 'phone.png') phoneRecs.push(value)
assert.equal(phoneRecs.length, 2, 'author-bound keys: the forged-coreKey import is a separate entry, not a shadow of the genuine record')
assert.ok(phoneRecs.some((r) => r.thumb !== 'FORGED'), 'the genuine record survives intact (not overwritten by the forgery)')
w1.destroy(); w2.destroy()
await devBase.close(); await devStore.close(); await fVault.close()
fs.rmSync(founderDir, { recursive: true, force: true }); fs.rmSync(devDir, { recursive: true, force: true })

// Ch7 M1: the album is ENCRYPTED. The founder reads its own album and serves the
// blob plaintext locally (it holds the key); a replica WITH the key reads it over
// replication; a peer with only the LIBRARY key reads nothing — private to members.
const albumKey = crypto.randomBytes(32)
const encDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-enc-'))
const encVault = new Vault(encDir, { encryptionKey: albumKey })
await encVault.ready()
const { link: encLink } = await encVault.importPhoto(PNG_1PX, { name: 'private.png', takenAt: 6000 })
assert.equal((await encVault.latest()).name, 'private.png', 'founder reads its own encrypted album')
const encRes = await fetch(encLink)
assert.ok(b4a.from(await encRes.arrayBuffer()).equals(PNG_1PX), 'the encrypted blob serves plaintext locally (key present)')
const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-mem-'))
const memStore = new Corestore(memDir)
const memBase = new Autobase(memStore, encVault.base.key, { open: openView, apply, valueEncoding: commandEncoding, encryptionKey: albumKey, ackInterval: 1000 })
await memBase.ready()
const e1 = encVault.base.replicate(true); const e2 = memBase.replicate(false); e1.pipe(e2).pipe(e1)
let memSeen = null
for (let i = 0; i < 300 && !memSeen; i++) { await new Promise((res) => setImmediate(res)); await memBase.update(); memSeen = await memBase.view.photos.peek({ reverse: true }) }
assert.ok(memSeen && memSeen.value.name === 'private.png', 'a member with the album key reads the encrypted album')
e1.destroy(); e2.destroy(); await memBase.close(); await memStore.close()
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-out-'))
const outStore = new Corestore(outDir)
const outBase = new Autobase(outStore, encVault.base.key, { open: openView, apply, valueEncoding: commandEncoding, ackInterval: 1000 })
await outBase.ready()
const x1 = encVault.base.replicate(true); const x2 = outBase.replicate(false); x1.pipe(x2).pipe(x1)
for (let i = 0; i < 150; i++) { await new Promise((res) => setImmediate(res)); await outBase.update() }
assert.ok(!(await outBase.view.photos.peek({ reverse: true })), 'a peer without the album key reads nothing (private)')
x1.destroy(); x2.destroy(); await outBase.close(); await outStore.close(); await encVault.close()
fs.rmSync(encDir, { recursive: true, force: true }); fs.rmSync(memDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })

// Ch7 M2: PAIRING DELIVERS THE ALBUM KEY. The real blind-pairing flow, end to
// end, on an isolated in-process DHT testnet (the transport Ch5 M3 deferred to
// hardware): the candidate ships its writer key up, the founder's confirm hands
// back {library key, album key} over the pairing handshake — never the DHT —
// and the joiner opens the ENCRYPTED album with the delivered key alone.
const testnet = await createTestnet(3)
const pairKey = crypto.randomBytes(32)
const pairDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-pairF-'))
const pVault = new Vault(pairDir, { encryptionKey: pairKey, dhtBootstrap: testnet.bootstrap })
await pVault.ready()
await pVault.importPhoto(PNG_1PX, { name: 'secret.png', takenAt: 5000 })
const inviteCode = await pVault.createInvite()
const joinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-joinE-'))
const joinStore = new Corestore(joinDir)
const jLocal = Autobase.getLocalCore(joinStore)
await jLocal.ready()
const jWriterKey = jLocal.key
await jLocal.close()
const candSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
const candPairing = new BlindPairing(candSwarm, { poll: 500 })
let delivered = null
const cand = candPairing.addCandidate({
  invite: z32.decode(inviteCode),
  userData: jWriterKey,
  onadd: (result) => { delivered = result },
})
await cand.pairing
assert.ok(delivered && b4a.equals(delivered.key, pVault.base.key), 'pairing hands back the library key')
assert.ok(delivered.encryptionKey && b4a.equals(delivered.encryptionKey, pairKey), 'pairing delivers the ALBUM key in the confirm')
const jBase = new Autobase(joinStore, delivered.key, { open: openView, apply, valueEncoding: commandEncoding, encryptionKey: delivered.encryptionKey, ackInterval: 1000 })
await jBase.ready()
candSwarm.on('connection', (conn) => jBase.replicate(conn))
for (const conn of candSwarm.connections) jBase.replicate(conn)
candSwarm.join(jBase.discoveryKey, { server: true, client: true })
let jSeen = null
for (let i = 0; i < 400 && !(jSeen && jBase.writable); i++) { await new Promise((res) => setTimeout(res, 25)); await jBase.update(); jSeen = await jBase.view.photos.peek({ reverse: true }) }
assert.ok(jSeen && jSeen.value.name === 'secret.png', 'the joiner reads the encrypted album with the delivered key')
assert.ok(jBase.writable, 'the joiner was admitted as a writer during the same pairing')
// Audit fix P2: the invite is SINGLE-USE. A second candidate presenting the same
// invite is denied — a leaked invite is not a standing writer+key credential.
const cand2Swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
const cand2Pairing = new BlindPairing(cand2Swarm, { poll: 500 })
let delivered2 = 'pending'
const cand2 = cand2Pairing.addCandidate({
  invite: z32.decode(inviteCode),
  userData: crypto.randomBytes(32),
  onadd: (result) => { delivered2 = result },
})
cand2.pairing.catch(() => {}) // may reject on denial; don't await (it can hang)
await new Promise((res) => setTimeout(res, 3000)) // let it reach the member and be denied
assert.ok(delivered2 === 'pending' || !delivered2 || !delivered2.encryptionKey, 'a second candidate on the same invite gets NO album key (single-use)')
await cand2Pairing.close(); await cand2Swarm.destroy()
// Audit fix P1: album-key distribution is OWNER-ONLY. A non-owner vault (bootstrapped
// but never granted ownership) must refuse to invite or remove — the key handoff
// happens outside apply(), so gating it only in apply() would leak the key.
const nonOwnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-nonowner-'))
const nonOwner = new Vault(nonOwnerDir, { bootstrap: idEncoding.encode(pVault.base.key), encryptionKey: pairKey, dhtBootstrap: testnet.bootstrap })
await nonOwner.ready()
assert.equal(await nonOwner.isOwner(), false, 'a bootstrapped non-owner device is not the owner')
await assert.rejects(() => nonOwner.createInvite(), /only the album owner can invite/, 'a non-owner cannot create an invite (no key leak)')
await assert.rejects(() => nonOwner.removeMember(b4a.toString(jWriterKey, 'hex')), /only the album owner can remove/, 'a non-owner cannot remove a member')
await nonOwner.close()
fs.rmSync(nonOwnerDir, { recursive: true, force: true })
await candPairing.close(); await candSwarm.destroy(); await jBase.close(); await joinStore.close(); await pVault.close(); await testnet.destroy()
fs.rmSync(pairDir, { recursive: true, force: true }); fs.rmSync(joinDir, { recursive: true, force: true })

// Ch7 M3: CONTENT-KEY ROTATION on revocation. The album key is membership; a
// separate CONTENT key encrypts each photo's browsable content (its thumbnail),
// and rotates when a member is kicked — sealed to the members who remain. The
// removed member keeps the album key (still sees the album) but never gets the new
// content key, so photos added after the kick read back REDACTED for them, while a
// remaining member reads them fine. Forward-only: the kicked member keeps its
// pre-kick content (Inv-9). Bases are piped directly (no swarm) to keep it hermetic.
const rotAlbumKey = crypto.randomBytes(32)
const rotDirs = []
const mkVault = (opts) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-rot-')); rotDirs.push(dir); return new Vault(dir, opts) }
const rotFounder = mkVault({ encryptionKey: rotAlbumKey, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)) })
await rotFounder.ready()
const bootstrapZ = idEncoding.encode(rotFounder.base.key)
const mkMember = (seed) => mkVault({ bootstrap: bootstrapZ, encryptionKey: rotAlbumKey, boxKeyPair: memberBoxKeyFromSeed(seed) })
const memA = mkMember(crypto.randomBytes(32)); await memA.ready()
const memB = mkMember(crypto.randomBytes(32)); await memB.ready()
// The owner admits both, recording each one's box key (what pairing ships up).
await rotFounder.base.append({ type: CMD.ADD_WRITER, writerKey: memA.deviceKey, boxKey: memA.boxPublicKey })
await rotFounder.base.append({ type: CMD.ADD_WRITER, writerKey: memB.deviceKey, boxKey: memB.boxPublicKey })
await rotFounder.base.update()
const pipeBases = (x, y) => { const a = x.base.replicate(true); const b = y.base.replicate(false); a.pipe(b).pipe(a); return [a, b] }
const rA = pipeBases(rotFounder, memA); const rB = pipeBases(rotFounder, memB)
for (let i = 0; i < 600 && !(memA.base.writable && memB.base.writable); i++) { await new Promise((res) => setImmediate(res)); await rotFounder.base.update(); await memA.base.update(); await memB.base.update() }
assert.ok(memA.base.writable && memB.base.writable, 'both members became writable')
// Epoch 0: a photo everyone can see.
await rotFounder.importPhoto(PNG_1PX, { name: 'shared.png', takenAt: 100, thumb: 'THUMB-SHARED' })
const thumbOf = async (v, name) => { for (const p of await v.list({ limit: 50 })) if (p.name === name) return p.thumb; return undefined }
let ta = null, tb = null
for (let i = 0; i < 600 && !(ta && tb); i++) { await new Promise((res) => setImmediate(res)); await rotFounder.base.update(); await memA.base.update(); await memB.base.update(); ta = await thumbOf(memA, 'shared.png'); tb = await thumbOf(memB, 'shared.png') }
assert.equal(ta, 'THUMB-SHARED', 'member A reads the epoch-0 thumbnail (has the album key)')
assert.equal(tb, 'THUMB-SHARED', 'member B reads the epoch-0 thumbnail')
// Kick A — this rotates the content key to epoch 1, sealed only to B.
await rotFounder.removeMember(b4a.toString(memA.deviceKey, 'hex'))
for (let i = 0; i < 600 && memA.base.writable; i++) { await new Promise((res) => setImmediate(res)); await rotFounder.base.update(); await memA.base.update() }
assert.ok(!memA.base.writable, 'the kicked member A lost write access')
// A new photo, encrypted under the rotated (epoch-1) content key.
const { link: bLink } = await rotFounder.importPhoto(PNG_1PX_RED, { name: 'after.png', takenAt: 200, thumb: 'THUMB-AFTER' })
let bAfter = null
for (let i = 0; i < 600 && !bAfter; i++) { await new Promise((res) => setImmediate(res)); await rotFounder.base.update(); await memA.base.update(); await memB.base.update(); bAfter = await thumbOf(memB, 'after.png') }
// The remaining member B unsealed the new key and reads the new photo; the rotFounder does too.
assert.equal(await thumbOf(rotFounder, 'after.png'), 'THUMB-AFTER', 'the rotFounder reads the post-rotation thumbnail')
assert.equal(bAfter, 'THUMB-AFTER', 'remaining member B reads the post-rotation thumbnail (got the sealed epoch-1 key)')
assert.ok(memB.contentKeys.has(1), 'member B holds the rotated content key')
// The kicked member A: still sees the album and its OLD photo, but the new one is redacted.
assert.equal(await thumbOf(memA, 'shared.png'), 'THUMB-SHARED', 'kicked member keeps pre-kick content (forward-only, Inv-9)')
assert.equal(await thumbOf(memA, 'after.png'), '', 'kicked member CANNOT read post-rotation content — the thumbnail is redacted')
assert.ok(!memA.contentKeys.has(1), 'kicked member never received the rotated content key')
// The full-resolution original of the post-rotation photo serves plaintext for the rotFounder (per-epoch blob core, keyed by the rotated content key).
assert.ok(b4a.from(await (await fetch(bLink)).arrayBuffer()).equals(PNG_1PX_RED), 'the rotFounder serves the post-rotation original (epoch-1 blob core decrypts)')
rA[0].destroy(); rA[1].destroy(); rB[0].destroy(); rB[1].destroy()
await memA.close(); await memB.close(); await rotFounder.close()
for (const d of rotDirs) fs.rmSync(d, { recursive: true, force: true })

// Ch7 M4: A PHONE JOINS AS A SECOND DEVICE. The full joiner path the app runs.
// pairAsCandidate() does the handshake (ships writerKey||boxKey, receives
// {libraryKey, albumKey}); the delivered keys — which a joiner CANNOT derive from
// its seed — persist to disk; a joiner Vault boots on that bootstrap + album key,
// becomes writable, and syncs both ways. Then a simulated RESTART reopens the vault
// from the persisted keys ALONE, proving a joined phone survives a reboot without
// re-pairing (the gap X2 closed: no delivered-key persistence, no boot-as-joiner).
const x2net = await createTestnet(3)
const x2albumKey = crypto.randomBytes(32)
const x2fDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-x2F-'))
const x2Founder = new Vault(x2fDir, { encryptionKey: x2albumKey, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)), dhtBootstrap: x2net.bootstrap })
await x2Founder.ready()
await x2Founder.importPhoto(PNG_1PX, { name: 'founder.png', takenAt: 7000, thumb: 'THUMB-F' })
const x2Invite = await x2Founder.createInvite()

// The joiner device identity: one seed → primaryKey (writer identity) + box keypair.
// The SAME primaryKey feeds pairAsCandidate AND the Vault, so the writer key the
// owner admits during pairing is exactly the one the Vault later adopts.
const x2seed = crypto.randomBytes(32)
const x2primaryKey = primaryKeyFromSeed(x2seed)
const x2box = memberBoxKeyFromSeed(x2seed)
const x2jDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-x2J-'))
const x2delivered = await pairAsCandidate(x2jDir, { primaryKey: x2primaryKey, invite: x2Invite, boxKeyPair: x2box, dhtBootstrap: x2net.bootstrap })
assert.ok(b4a.equals(x2delivered.libraryKey, x2Founder.base.key), 'pairAsCandidate returns the library (bootstrap) key')
assert.ok(b4a.equals(x2delivered.encryptionKey, x2albumKey), 'pairAsCandidate returns the album key through the sealed confirm')

// Persist the delivered keys the way the worker does, then reload — the round-trip
// the reboot stands on.
const x2memPath = path.join(x2jDir, 'membership')
saveMembership(fs, x2memPath, { libraryKey: x2delivered.libraryKey, albumKey: x2delivered.encryptionKey })
const x2loaded = loadMembership(fs, x2memPath)
assert.ok(x2loaded && b4a.equals(x2loaded.libraryKey, x2Founder.base.key) && b4a.equals(x2loaded.albumKey, x2albumKey), 'membership persists and reloads (library + album key)')

// Boot the joiner Vault on the persisted keys — its writer key is already admitted.
let x2Joiner = new Vault(x2jDir, { primaryKey: x2primaryKey, bootstrap: idEncoding.encode(x2loaded.libraryKey), encryptionKey: b4a.from(x2loaded.albumKey), boxKeyPair: x2box, dhtBootstrap: x2net.bootstrap })
await x2Joiner.ready()
await x2Joiner.share()
assert.equal(await x2Joiner.isOwner(), false, 'the joined phone is a member, not the owner')
let x2seen = null
for (let i = 0; i < 800 && !(x2Joiner.base.writable && x2seen); i++) { await new Promise((res) => setTimeout(res, 25)); await x2Joiner.base.update(); x2seen = (await x2Joiner.list({ limit: 10 })).find((p) => p.name === 'founder.png') }
assert.ok(x2Joiner.base.writable, 'the joined phone becomes a writer (ADD_WRITER replicated in)')
assert.ok(x2seen && x2seen.thumb === 'THUMB-F', 'the joined phone reads the founder\'s ENCRYPTED photo with the delivered key')

// The phone imports its own photo — the founder converges to it (two-way sync).
await x2Joiner.importPhoto(PNG_1PX_RED, { name: 'phone.png', takenAt: 8000, thumb: 'THUMB-P' })
let x2fSees = null
for (let i = 0; i < 800 && !x2fSees; i++) { await new Promise((res) => setTimeout(res, 25)); await x2Founder.base.update(); await x2Joiner.base.update(); x2fSees = (await x2Founder.list({ limit: 10 })).find((p) => p.name === 'phone.png') }
assert.equal(x2fSees && x2fSees.thumb, 'THUMB-P', 'the founder converges to the phone\'s photo')

// RESTART: close the phone's vault, reopen from the persisted membership ALONE — no
// invite, no re-pairing. It comes back a writer and still sees both photos.
await x2Joiner.close()
const x2reloaded = loadMembership(fs, x2memPath)
x2Joiner = new Vault(x2jDir, { primaryKey: x2primaryKey, bootstrap: idEncoding.encode(x2reloaded.libraryKey), encryptionKey: b4a.from(x2reloaded.albumKey), boxKeyPair: x2box, dhtBootstrap: x2net.bootstrap })
await x2Joiner.ready()
await x2Joiner.share()
let x2reboot = null
for (let i = 0; i < 800 && !(x2Joiner.base.writable && x2reboot); i++) { await new Promise((res) => setTimeout(res, 25)); await x2Joiner.base.update(); x2reboot = (await x2Joiner.list({ limit: 10 })).find((p) => p.name === 'founder.png') }
assert.ok(x2Joiner.base.writable, 'the phone is still a writer after a restart (identity from the seed, keys from disk)')
const x2AfterReboot = (await x2Joiner.list({ limit: 10 })).map((p) => p.name).sort()
assert.deepEqual(x2AfterReboot, ['founder.png', 'phone.png'], 'the phone reopens the album from persisted keys alone — both photos present, no re-pairing')
await x2Joiner.close(); await x2Founder.close(); await x2net.destroy()
fs.rmSync(x2fDir, { recursive: true, force: true }); fs.rmSync(x2jDir, { recursive: true, force: true })

console.log('smoke: ok — indexed, range query, 64-bit key, no collision, Inv-4, 0-byte, count-race, read-replica, seed-identity, pairing→writable, two-writer convergence, roles, revocation, re-invite-after-revoke, author-bound keys, encryption, key-delivery-via-pairing, single-use invite, owner-only invite/remove, content-key rotation on revoke, phone-join+persist+restart all verified')
