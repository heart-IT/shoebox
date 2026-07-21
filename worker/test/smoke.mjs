// Vault smoke test under Node — proves the worker core is host-agnostic:
// import photos, serve them over the blob-server, range-query the time-ordered
// index, verify the Inv-4 append-only schema contract, the 64-bit key encoding
// on REAL epoch-ms values, and that same-time/same-name photos never collide.
import { createRequire } from 'module'
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

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
const BlindPeer = require('blind-peer')
const idEncoding = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const { resolveStruct } = require('../spec')
const { CMD, commandEncoding, openView, apply, roleOf, discoveryTopic, currentEpoch, epochKey } = require('../library')
const { primaryKeyFromSeed, saveMembership, loadMembership } = require('../identity')
const { memberBoxKeyFromSeed, sealTo, openSealed } = require('../rotation')
const currentEpochOf = (v) => currentEpoch(v.base.view)
const epochKeyOf = (n) => epochKey(n)
const openSealedOf = (sealed, kp) => openSealed(sealed, kp)

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

// Audit AF-M12: persisted key artifacts fail LOUD on corruption instead of
// silently re-minting an identity / re-founding over a joined store.
const { loadOrCreateSeed } = require('../identity')
const m12dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-m12-'))
const m12seedPath = path.join(m12dir, 'seed')
const m12seed = loadOrCreateSeed(fs, m12seedPath) // first boot mints
assert.equal(m12seed.byteLength, 32, 'first boot mints a 32-byte seed')
assert.ok(b4a.equals(loadOrCreateSeed(fs, m12seedPath), m12seed), 'a second boot returns the SAME persisted seed (atomic round-trip)')
fs.writeFileSync(m12seedPath, b4a.from('deadbeef', 'hex')) // truncate it
assert.throws(() => loadOrCreateSeed(fs, m12seedPath), /corrupt/, 'AF-M12: a corrupt seed throws — never silently overwrites the identity')
const m12memPath = path.join(m12dir, 'membership')
assert.equal(loadMembership(fs, m12memPath), null, 'an ABSENT membership file → founder (null), not an error')
saveMembership(fs, m12memPath, { libraryKey: b4a.alloc(32, 1), albumKey: b4a.alloc(32, 2) })
assert.ok(loadMembership(fs, m12memPath), 'a valid membership round-trips')
fs.writeFileSync(m12memPath, b4a.alloc(10)) // truncate it
assert.throws(() => loadMembership(fs, m12memPath), /corrupt/, 'AF-M12: a corrupt membership throws — never boots as a fresh founder over the joined store')
fs.rmSync(m12dir, { recursive: true, force: true })
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
candSwarm.join(discoveryTopic(jBase, delivered.encryptionKey), { server: true, client: true }) // members-only topic (Ch10 M2)
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
// A new photo, encrypted under the rotated (epoch-1) content key. It carries a
// dHash and an embedding too — audit AF-M8 seals those under the content key,
// so a kicked member can't classify it either.
const AF_EMB = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer)
const { link: bLink } = await rotFounder.importPhoto(PNG_1PX_RED, { name: 'after.png', takenAt: 200, thumb: 'THUMB-AFTER', dhash: 'abcdef0123456789', embedding: AF_EMB })
const fieldOf = async (v, name, field) => { for (const p of await v.list({ limit: 50 })) if (p.name === name) return p[field]; return undefined }
let bAfter = null
for (let i = 0; i < 600 && !bAfter; i++) { await new Promise((res) => setImmediate(res)); await rotFounder.base.update(); await memA.base.update(); await memB.base.update(); bAfter = await thumbOf(memB, 'after.png') }
// The remaining member B unsealed the new key and reads the new photo; the rotFounder does too.
assert.equal(await thumbOf(rotFounder, 'after.png'), 'THUMB-AFTER', 'the rotFounder reads the post-rotation thumbnail')
assert.equal(bAfter, 'THUMB-AFTER', 'remaining member B reads the post-rotation thumbnail (got the sealed epoch-1 key)')
assert.ok(memB.contentKeys.has(1), 'member B holds the rotated content key')
// AF-M8: dHash + embedding are content-encrypted, so a holder reads them and a
// kicked member does not.
assert.equal(await fieldOf(rotFounder, 'after.png', 'dhash'), 'abcdef0123456789', 'the owner reads the post-rotation dHash')
assert.ok(b4a.equals(b4a.from(await fieldOf(memB, 'after.png', 'embedding')), AF_EMB), 'remaining member B decrypts the post-rotation embedding')
// The kicked member A: still sees the album and its OLD photo, but the new one is redacted.
assert.equal(await thumbOf(memA, 'shared.png'), 'THUMB-SHARED', 'kicked member keeps pre-kick content (forward-only, Inv-9)')
assert.equal(await thumbOf(memA, 'after.png'), '', 'kicked member CANNOT read post-rotation content — the thumbnail is redacted')
assert.equal(await fieldOf(memA, 'after.png', 'dhash'), '', 'kicked member CANNOT read the post-rotation dHash (AF-M8)')
assert.equal(await fieldOf(memA, 'after.png', 'embedding'), null, 'kicked member CANNOT read the post-rotation embedding (AF-M8)')
assert.ok(!memA.contentKeys.has(1), 'kicked member never received the rotated content key')
// The full-resolution original of the post-rotation photo serves plaintext for the rotFounder (per-epoch blob core, keyed by the rotated content key).
assert.ok(b4a.from(await (await fetch(bLink)).arrayBuffer()).equals(PNG_1PX_RED), 'the rotFounder serves the post-rotation original (epoch-1 blob core decrypts)')
rA[0].destroy(); rA[1].destroy(); rB[0].destroy(); rB[1].destroy()
await memA.close(); await memB.close(); await rotFounder.close()
for (const d of rotDirs) fs.rmSync(d, { recursive: true, force: true })

// Audit AF-H1: an ENCRYPTED album refuses to import into an epoch whose content
// key hasn't arrived — no silent plaintext blob. Stage the partial-sync window:
// a device that sees the rotations row (currentEpoch advances) but holds no
// sealed copy of that epoch. Founder + member A, kick A (→ epoch 1 sealed to the
// founder only), then a fresh device J bootstrapped with the album key + its own
// box key replicates the rotation but was never granted epoch 1.
const h1Album = crypto.randomBytes(32)
const h1Dirs = []
const h1mk = (opts) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-h1-')); h1Dirs.push(d); return new Vault(d, opts) }
const h1F = h1mk({ encryptionKey: h1Album, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)) })
await h1F.ready()
const h1A = h1mk({ bootstrap: idEncoding.encode(h1F.base.key), encryptionKey: h1Album, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)) })
await h1A.ready()
await h1F.base.append({ type: CMD.ADD_WRITER, writerKey: h1A.deviceKey, boxKey: h1A.boxPublicKey })
await h1F.base.update()
const h1p = (x, y) => { const a = x.base.replicate(true); const b = y.base.replicate(false); a.pipe(b).pipe(a); return [a, b] }
const h1rA = h1p(h1F, h1A)
for (let i = 0; i < 600 && !h1A.base.writable; i++) { await new Promise((res) => setImmediate(res)); await h1F.base.update(); await h1A.base.update() }
await h1F.removeMember(b4a.toString(h1A.deviceKey, 'hex')) // → rotate to epoch 1, sealed to founder only
// A stranger-to-the-rotation device J: has the album key, replicates the row, no epoch-1 grant.
const h1J = h1mk({ bootstrap: idEncoding.encode(h1F.base.key), encryptionKey: h1Album, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)) })
await h1J.ready()
const h1rJ = h1p(h1F, h1J)
for (let i = 0; i < 800 && (await currentEpochOf(h1J)) < 1; i++) { await new Promise((res) => setImmediate(res)); await h1F.base.update(); await h1J.base.update() }
assert.equal(await currentEpochOf(h1J), 1, 'J sees the rotation (epoch advanced to 1)')
await h1J._syncContentKeys()
assert.ok(!h1J.contentKeys.has(1), 'J holds NO epoch-1 key (never granted) — the partial-sync window')
await assert.rejects(() => h1J.importPhoto(PNG_1PX, { name: 'racy.png', takenAt: 1, thumb: 'X' }), /epoch key not available/, 'AF-H1: import into an unheld encrypted epoch is refused, not silently written in plaintext')
h1rA[0].destroy(); h1rA[1].destroy(); h1rJ[0].destroy(); h1rJ[1].destroy()
await h1A.close(); await h1J.close(); await h1F.close()
for (const d of h1Dirs) fs.rmSync(d, { recursive: true, force: true })

// Audit AF-M4: the ROTATE_KEY row is write-once in apply(). Append two rotations
// for the SAME epoch with different keys; the first wins and is never clobbered
// (else a member holding the first key would have its photos orphaned).
const m4Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-m4-'))
const m4 = new Vault(m4Dir, { encryptionKey: crypto.randomBytes(32), boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)) })
await m4.ready()
const m4keyA = crypto.randomBytes(32); const m4keyB = crypto.randomBytes(32)
const m4self = { writerKey: b4a.from(m4.base.local.key), sealedA: sealTo(m4.boxKeyPair.publicKey, m4keyA), sealedB: sealTo(m4.boxKeyPair.publicKey, m4keyB) }
await m4.base.append({ type: CMD.ROTATE_KEY, epoch: 1, entries: [{ writerKey: m4self.writerKey, sealed: m4self.sealedA }] })
await m4.base.append({ type: CMD.ROTATE_KEY, epoch: 1, entries: [{ writerKey: m4self.writerKey, sealed: m4self.sealedB }] })
await m4.base.update()
const m4row = JSON.parse((await m4.base.view.rotations.get(epochKeyOf(1))).value)
const m4opened = openSealedOf(b4a.from(m4row[b4a.toString(m4.base.local.key, 'hex')], 'hex'), m4.boxKeyPair)
assert.ok(b4a.equals(m4opened, m4keyA), 'AF-M4: the FIRST rotation for an epoch wins; the duplicate never overwrites it')
await m4.close()
fs.rmSync(m4Dir, { recursive: true, force: true })

// Audit AF-H2: pairAsCandidate is BOUNDED — when nobody answers the invite it
// times out and cleans up, instead of polling forever (which, since the JOIN
// handler tears down the live vault first, used to brick the worker until an
// app restart). Craft an invite for a library key no one is announcing.
const h2net = await createTestnet(3)
const h2inv = z32.encode(BlindPairing.createInvite(crypto.randomBytes(32)).invite)
const h2dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-h2-'))
const h2t0 = Date.now()
await assert.rejects(
  () => pairAsCandidate(h2dir, { primaryKey: primaryKeyFromSeed(crypto.randomBytes(32)), invite: h2inv, boxKeyPair: memberBoxKeyFromSeed(crypto.randomBytes(32)), dhtBootstrap: h2net.bootstrap, timeoutMs: 2000 }),
  /timed out/,
  'AF-H2: pairing bounds itself and rejects when nobody answers (no forever-hang → no bricked worker)',
)
assert.ok(Date.now() - h2t0 < 20000, 'and it returns promptly, near its deadline')
await h2net.destroy()
fs.rmSync(h2dir, { recursive: true, force: true })

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

// Ch8 M1: SUSPENSION IS NOT GRACEFUL SHUTDOWN (Inv-10). The suspend/resume pair
// has been wired since Ch1 and never once executed by a test — the vault-client
// comment even admits it's dead code without the AppState hook. This section
// makes it real: suspension stalls REPLICATION but never the LIBRARY (a
// suspended device still imports locally), transitions are serialized so an
// AppState storm can't interleave them, a suspend racing an import drains it
// first, and the blob-server comes back on its original port so links the UI
// already holds survive the round trip.

// A never-shared vault: transitions are idempotent no-ops, imports still land
// while suspended, and a swarm minted DURING suspension comes up suspended
// (the share-after-import path a backgrounded first import would take).
const loneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-lone-'))
const lone = new Vault(loneDir)
await lone.ready()
await lone.suspend()
await lone.suspend() // double-suspend: second is a no-op, not a re-teardown
assert.ok(lone.suspended, 'a never-shared vault suspends cleanly')
await lone.importPhoto(PNG_1PX, { name: 'bg.png', takenAt: 1000 })
assert.equal(await lone.count(), 1, 'a suspended vault still imports locally (local-first)')
await lone.share()
assert.ok(lone.swarm.suspended, 'a swarm minted while suspended comes up suspended, not live')
await lone.resume()
await lone.resume() // double-resume: no-op
assert.ok(!lone.suspended && !lone.swarm.suspended, 'resume brings the minted swarm up live')
await lone.close()
fs.rmSync(loneDir, { recursive: true, force: true })

// Two devices over the testnet: a founder and a read replica.
const s8net = await createTestnet(3)
const s8fDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-s8F-'))
const s8Founder = new Vault(s8fDir, { dhtBootstrap: s8net.bootstrap })
await s8Founder.ready()
const { link: preLink } = await s8Founder.importPhoto(PNG_1PX, { name: 'pre.png', takenAt: 1000 })
await s8Founder.share()
const s8mDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-s8M-'))
const s8Member = new Vault(s8mDir, { bootstrap: idEncoding.encode(s8Founder.base.key), dhtBootstrap: s8net.bootstrap })
await s8Member.ready()
await s8Member.share()
const s8names = async (v) => (await v.list({ limit: 20 })).map((p) => p.name).sort()
let s8seen = []
for (let i = 0; i < 800 && !s8seen.includes('pre.png'); i++) { await new Promise((res) => setTimeout(res, 25)); s8seen = await s8names(s8Member) }
assert.deepEqual(s8seen, ['pre.png'], 'the member converges before suspension')

// The member backgrounds while the founder stays live — the everyday case: a
// phone in a pocket, a laptop mirror still up. The founder keeps importing;
// nothing reaches the member until it resumes (bounded negative poll, ~2s).
await s8Member.suspend()
assert.ok(s8Member.swarm.suspended, 'suspend() suspends the underlying swarm')
await s8Founder.importPhoto(PNG_1PX_RED, { name: 'while-suspended.png', takenAt: 2000 })
for (let i = 0; i < 80; i++) { await new Promise((res) => setTimeout(res, 25)) }
assert.ok(!(await s8names(s8Member)).includes('while-suspended.png'), 'a suspended member receives NOTHING (replication stalled)')

// The member resumes AGAINST A LIVE PEER and catches up. (Deliberately
// one-sided: on resume, reconnection is driven by the resumer's own
// re-announce + re-query — two peers resuming simultaneously can each miss
// the other's records and idle until the next topic refresh. A phone resumes
// into a world where someone stayed up; the test models that world.)
await s8Member.resume()
let s8caught = []
for (let i = 0; i < 800 && s8caught.length < 2; i++) { await new Promise((res) => setTimeout(res, 25)); s8caught = await s8names(s8Member) }
assert.deepEqual(s8caught, ['pre.png', 'while-suspended.png'], 'the resumed member catches up on what it missed')

// Now the founder backgrounds (member stays live). Its library still works —
// a local import lands — but its localhost blob-server socket is gone.
await s8Founder.suspend()
await s8Founder.importPhoto(PNG_1PX, { name: 'offline.png', takenAt: 3000 })
assert.equal(await s8Founder.count(), 3, 'a suspended founder still imports locally (the library outlives the socket)')
await assert.rejects(() => fetch(preLink), undefined, 'the blob-server socket is released while suspended')

// An AppState storm: four transitions fired in the same tick. Serialization
// runs them in order; the flag checks collapse the redundant ones; the last
// one wins. No interleave, no throw, ends live.
await Promise.all([s8Founder.suspend(), s8Founder.resume(), s8Founder.suspend(), s8Founder.resume()])
assert.ok(!s8Founder.suspended && !s8Founder.swarm.suspended, 'a suspend/resume storm serializes — last transition wins, swarm ends live')

// A suspend racing an in-flight import waits for the append to land before it
// reports quiescent — the SUSPEND reply is the app's freeze signal, and a
// half-appended import must not be what the OS freezes.
let s8ImportDone = false
const s8racing = s8Founder.importPhoto(PNG_1PX_RED, { name: 'racing.png', takenAt: 4000 }).then((r) => { s8ImportDone = true; return r })
const s8drained = s8Founder.suspend().then(() => s8ImportDone)
assert.ok(await s8drained, 'suspend drains the in-flight import before completing')
await s8racing
assert.equal(await s8Founder.count(), 4, 'the drained import landed exactly once (no corruption, no loss)')

// The founder resumes against the live member: everything imported behind the
// member's back converges, and the founder's pre-suspension link still serves —
// the blob-server re-bound its original port.
await s8Founder.resume()
let s8after = []
for (let i = 0; i < 800 && s8after.length < 4; i++) { await new Promise((res) => setTimeout(res, 25)); s8after = await s8names(s8Member) }
assert.deepEqual(s8after, ['offline.png', 'pre.png', 'racing.png', 'while-suspended.png'], 'the member converges to every photo imported while the founder was backgrounded')
const s8res = await fetch(preLink)
assert.equal(s8res.status, 200, 'a pre-suspension blob link still serves after resume (original port re-bound)')
assert.ok(Buffer.from(await s8res.arrayBuffer()).equals(PNG_1PX), 'and the served bytes are intact')
await s8Member.close(); await s8Founder.close(); await s8net.destroy()
fs.rmSync(s8fDir, { recursive: true, force: true }); fs.rmSync(s8mDir, { recursive: true, force: true })

// Ch8 M2: THE SUSPEND→RESUME EXCEPTION FILTER. The OS closes sockets behind a
// backgrounded app's back; on resume, Bare cleans up the corpses and throws
// from callbacks with no JS catcher. The filter swallows exactly that class
// (narrow allowlist, cause-chain aware, bounded walk), exactly in the
// suspend→resume window, logs every swallow, and re-throws everything else —
// in every app state. Predicate and window are pure logic; the process-level
// contract is proven on a real Node process below.
const { isBenignSocketError, createSuspensionWindow, installSuspensionFilter } = require('../lifecycle.js')
const mkErr = (code) => Object.assign(new Error(code), { code })

// The predicate: a bare code hits; a code WRAPPED in err.cause chains hits
// (that's how hyperswarm/secret-stream teardown errors actually surface).
assert.ok(isBenignSocketError(mkErr('ECONNRESET')), 'a bare benign code is recognized')
const wrapped = new Error('outer'); wrapped.cause = new Error('mid'); wrapped.cause.cause = mkErr('ENOTCONN')
assert.ok(isBenignSocketError(wrapped), 'a benign code wrapped two causes deep is recognized')
assert.ok(!isBenignSocketError(new Error('plain')), 'no code → not benign')
assert.ok(!isBenignSocketError(mkErr('EACCES')), 'a non-socket code → not benign (the allowlist is narrow)')
assert.ok(!isBenignSocketError(null), 'null survives the walk')
const cyclic = mkErr('EWEIRD'); cyclic.cause = cyclic
assert.ok(!isBenignSocketError(cyclic), 'a cyclic cause chain terminates (bounded walk)')
let deepErr = new Error('l0'); let deepCur = deepErr
for (let i = 0; i < 8; i++) { deepCur.cause = new Error('l' + (i + 1)); deepCur = deepCur.cause }
deepCur.code = 'ECONNRESET'
assert.ok(!isBenignSocketError(deepErr), 'a code beyond the hop bound is NOT reached — the walk is truly bounded')

// The window: closed by default, open from suspend, open for settleMs past
// resume (dead-socket cleanup fires during and shortly AFTER resume), then
// closed. Clock injected so the test never sleeps.
const win = createSuspensionWindow({ settleMs: 5000 })
assert.ok(!win.isOpen(0), 'window starts closed')
win.onSuspend()
assert.ok(win.isOpen(999999), 'window is open while suspended, regardless of clock')
win.onResume(10000)
assert.ok(win.isOpen(14999), 'window stays open through the settle period after resume')
assert.ok(!win.isOpen(15000), 'window closes once the settle period ends')

// The handler contract, on a fake emitter: benign-in-window is swallowed AND
// logged (a silent crash-eater is worse than a crash); benign-out-of-window
// and non-benign-in-window re-throw; uninstall detaches.
const swallowLog = []
const fakeEmitter = { handler: null, on (ev, fn) { this.handler = fn }, off () { this.handler = null } }
const win2 = createSuspensionWindow({ settleMs: 5000 })
const uninstall = installSuspensionFilter(fakeEmitter, win2, { log: (m) => swallowLog.push(m) })
win2.onSuspend()
fakeEmitter.handler(mkErr('ECONNRESET')) // must return, not throw
assert.equal(swallowLog.length, 1, 'a swallow is logged, never silent')
assert.throws(() => fakeEmitter.handler(mkErr('EACCES')), /EACCES/, 'a non-benign error re-throws even inside the window')
win2.onResume(0) // settle period ended long before Date.now()
assert.throws(() => fakeEmitter.handler(mkErr('ECONNRESET')), /ECONNRESET/, 'a benign error OUTSIDE the window re-throws — the filter is not a standing crash-eater')
uninstall()
assert.equal(fakeEmitter.handler, null, 'uninstall detaches the handler')

// The real process-level semantics, on child Node processes (the same hook
// shape the worklet installs on Bare): a wrapped benign throw inside the
// window is survived; the identical throw with the window closed is fatal.
const lifecyclePath = require.resolve('../lifecycle.js')
const childSurvives = spawnSync(process.execPath, ['-e', `
  const { createSuspensionWindow, installSuspensionFilter } = require(${JSON.stringify(lifecyclePath)})
  const w = createSuspensionWindow()
  installSuspensionFilter(process, w)
  w.onSuspend()
  setImmediate(() => { const e = new Error('teardown'); e.cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' }); throw e })
  setTimeout(() => console.log('survived'), 50)
`], { encoding: 'utf-8', timeout: 20000 })
assert.equal(childSurvives.status, 0, 'a benign socket throw inside the window does not kill the process')
assert.ok(childSurvives.stdout.includes('survived'), 'the process keeps running after the swallowed throw')
const childDies = spawnSync(process.execPath, ['-e', `
  const { createSuspensionWindow, installSuspensionFilter } = require(${JSON.stringify(lifecyclePath)})
  installSuspensionFilter(process, createSuspensionWindow()) // window never opened
  setImmediate(() => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
  setTimeout(() => console.log('survived'), 50)
`], { encoding: 'utf-8', timeout: 20000 })
assert.notEqual(childDies.status, 0, 'the SAME benign throw with the window closed is fatal — the filter never outlives its window')
assert.ok(!childDies.stdout.includes('survived'), 'the out-of-window process died before its timer')

// Ch9 M1: TIERED RETENTION (Inv-11). The index — records, thumbnails,
// embeddings — is the library and stays local forever; the ORIGINAL is a cache
// entry. Sparse replication means bytes only ever move on demand, so a
// replicated record starts COLD; a tap pages it in from a peer; evict() hands
// the blocks back to the OS; the record (and the whole browsable, searchable
// library) is untouched. Plus the eviction oracle: near-duplicates first (the
// Part 4 dHash column paying rent), then oldest.
const evNet = await createTestnet(3)
const evFDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-evF-'))
const evFounder = new Vault(evFDir, { dhtBootstrap: evNet.bootstrap })
await evFounder.ready()
const BIG = Buffer.from(crypto.randomBytes(65536))
await evFounder.importPhoto(BIG, { name: 'orig.bin', takenAt: 1000, thumb: 'THUMB-ORIG' })
await evFounder.share()
const evMDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-evM-'))
const evMember = new Vault(evMDir, { bootstrap: idEncoding.encode(evFounder.base.key), dhtBootstrap: evNet.bootstrap })
await evMember.ready()
await evMember.share()

// Replication brought the INDEX, not the bytes: the record is here, the
// thumbnail reads, and the original is cold — nobody asked for it yet.
let evRec = null
for (let i = 0; i < 800 && !evRec; i++) { await new Promise((res) => setTimeout(res, 25)); evRec = (await evMember.list({ limit: 10, residency: true })).find((p) => p.name === 'orig.bin') }
assert.ok(evRec, 'the record replicated to the member')
assert.equal(evRec.thumb, 'THUMB-ORIG', 'the thumbnail is in the index tier — always local')
assert.equal(evRec.resident, false, 'the original starts COLD — sparse replication moves bytes only on demand')

// A tap pages the original in from the founder.
const evRes = await fetch(evRec.link)
assert.equal(evRes.status, 200, 'a cold original serves — the blob-server demand-fetches from a peer')
assert.ok(Buffer.from(await evRes.arrayBuffer()).equals(BIG), 'and the paged-in bytes are intact')
evRec = (await evMember.list({ limit: 10, residency: true })).find((p) => p.name === 'orig.bin')
assert.equal(evRec.resident, true, 'after the tap the original is hot')
assert.equal((await evMember.storageStat()).localBytes, BIG.byteLength, 'storageStat counts the hot original')

// Evict: the bytes go back to the OS; the library does not shrink.
const evOut = await evMember.evict([evRec.id])
assert.deepEqual(evOut, { evicted: 1, freedBytes: BIG.byteLength }, 'evict() clears the blob blocks and reports the freed bytes')
const evStat = await evMember.storageStat()
assert.equal(evStat.photos, 1, 'the library did not shrink — eviction touches bytes, not records')
assert.equal(evStat.localBytes, 0, 'no hot originals remain')
assert.equal(evStat.coldBytes, BIG.byteLength, 'the original is accounted cold')
evRec = (await evMember.list({ limit: 10, residency: true })).find((p) => p.name === 'orig.bin')
assert.equal(evRec.resident, false, 'the record marks itself cold')
assert.equal(evRec.thumb, 'THUMB-ORIG', 'the thumbnail survives eviction — the index tier is never evicted')
assert.deepEqual(await evMember.evict([evRec.id]), { evicted: 0, freedBytes: 0 }, 'evicting a cold record is an idempotent no-op')

// Cold is not gone: the same link pages the original back in on demand.
const evRes2 = await fetch(evRec.link)
assert.equal(evRes2.status, 200, 'an evicted original re-fetches on demand while a peer holds it')
assert.ok(Buffer.from(await evRes2.arrayBuffer()).equals(BIG), 'round-trip bytes intact after evict + re-fetch')

// Evict again and take the peer away: the index still reads — the original is
// simply unreachable until SOME peer holds it. That gap is what the blind
// mirror (M2) exists to close.
await evMember.evict([evRec.id])
await evFounder.close()
evRec = (await evMember.list({ limit: 10, residency: true })).find((p) => p.name === 'orig.bin')
assert.equal(evRec.thumb, 'THUMB-ORIG', 'with the only peer gone, the library still browses (index tier)')
assert.equal(evRec.resident, false, 'and the original is honestly cold, not silently missing')
await evMember.close()
await evNet.destroy()
fs.rmSync(evFDir, { recursive: true, force: true }); fs.rmSync(evMDir, { recursive: true, force: true })

// Ch9 M2: THE BLIND PEER — an always-on mirror that keeps the library
// available while every phone sleeps, holding ONLY ciphertext it cannot read.
// The founder registers its autobase + blob cores with the mirror, goes
// offline, and a member converges — index AND original bytes — from the
// mirror alone. This closes M1's honest boundary ("an evicted original is
// unreachable until SOME peer holds it") and Part 8's simultaneous-resume
// dead zone (somebody is always home).

// Recursive plaintext grep over a storage dir.
const dirContains = (dir, marker) => {
  const needle = Buffer.from(marker)
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (walk(p)) return true }
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) return true
    }
    return false
  }
  return walk(dir)
}

// Control: an UNENCRYPTED vault's storage DOES contain its thumbnail marker in
// plaintext — proving the negative grep below can actually detect leakage.
const ctlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-ctl-'))
const ctlVault = new Vault(ctlDir)
await ctlVault.ready()
await ctlVault.importPhoto(PNG_1PX, { name: 'plain.png', takenAt: 500, thumb: 'THUMB-MARKER-PLAIN' })
await ctlVault.close()
assert.ok(dirContains(ctlDir, 'THUMB-MARKER-PLAIN'), 'control: plaintext IS greppable in an unencrypted store')
fs.rmSync(ctlDir, { recursive: true, force: true })

const bpNet = await createTestnet(3)
const bpSrvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-bpS-'))
const bpServer = new BlindPeer(path.join(bpSrvDir, 'rocks'), { bootstrap: bpNet.bootstrap })
await bpServer.ready()
await bpServer.listen()

const bpAlbum = crypto.randomBytes(32)
const bpFDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-bpF-'))
const bpFounder = new Vault(bpFDir, { encryptionKey: bpAlbum, dhtBootstrap: bpNet.bootstrap, blindPeerKeys: [bpServer.publicKey] })
await bpFounder.ready()
const BIG2 = Buffer.from(crypto.randomBytes(48000))
await bpFounder.importPhoto(BIG2, { name: 'cold.png', takenAt: 1000, thumb: 'THUMB-COLD-MARKER' })
const bpLibKey = idEncoding.encode(bpFounder.base.key)
await bpFounder.share()

// The mirror absorbs — its digest counts cores/bytes it now hosts.
let bpAbsorbed = false
for (let i = 0; i < 1600 && !bpAbsorbed; i++) {
  await new Promise((res) => setTimeout(res, 25))
  bpAbsorbed = !!(bpServer.digest && (bpServer.digest.bytesAllocated > 0 || bpServer.digest.cores > 0))
}
assert.ok(bpAbsorbed, 'the blind peer absorbed the library (digest moved)')

// The phone goes dark. The library must not.
await bpFounder.close()
const bpMDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-bpM-'))
const bpMember = new Vault(bpMDir, { bootstrap: bpLibKey, encryptionKey: bpAlbum, dhtBootstrap: bpNet.bootstrap, blindPeerKeys: [bpServer.publicKey] })
await bpMember.ready()
await bpMember.share()
let bpRec = null
for (let i = 0; i < 1600 && !bpRec; i++) { await new Promise((res) => setTimeout(res, 25)); bpRec = (await bpMember.list({ limit: 10, residency: true })).find((p) => p.name === 'cold.png') }
assert.ok(bpRec, 'a member converges from the mirror ALONE — the founder is offline')
assert.equal(bpRec.thumb, 'THUMB-COLD-MARKER', 'and decrypts it (the member holds the album key; the mirror never did)')
const bpRes = await fetch(bpRec.link)
assert.equal(bpRes.status, 200, 'the ORIGINAL pages in from the mirror — the cold tier serves bytes, not just index')
assert.ok(Buffer.from(await bpRes.arrayBuffer()).equals(BIG2), 'paged-in bytes intact (M1\'s honest boundary, closed)')

// The mirror held it all and could read none of it.
assert.ok(!dirContains(bpSrvDir, 'THUMB-COLD-MARKER'), 'the mirror\'s storage contains NO plaintext — blind means blind')

// Mirrors follow the Ch8 lifecycle like everything else with sockets.
await bpMember.suspend()
assert.ok(bpMember.blind.suspended, 'the mirror client suspends with the vault')
await bpMember.resume()
assert.ok(!bpMember.blind.suspended, 'and resumes with it')

await bpMember.close()
await bpServer.close()
await bpNet.destroy()
fs.rmSync(bpSrvDir, { recursive: true, force: true }); fs.rmSync(bpFDir, { recursive: true, force: true }); fs.rmSync(bpMDir, { recursive: true, force: true })

// Audit AF-M2: a mirror can be configured at RUNTIME (the app's Settings flow),
// not only via the boot argument. A founder shares with NO mirror, then
// addMirror() registers one live; the mirror then absorbs via the same path a
// boot-configured one uses. (Fixes the completeness gap: the blind-peer
// centerpiece of Ch9 was unreachable from the phone app.)
const m2net = await createTestnet(3)
const m2srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-m2S-'))
const m2server = new BlindPeer(path.join(m2srvDir, 'rocks'), { bootstrap: m2net.bootstrap })
await m2server.ready(); await m2server.listen()
const m2fDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-m2F-'))
const m2f = new Vault(m2fDir, { encryptionKey: crypto.randomBytes(32), dhtBootstrap: m2net.bootstrap }) // NO blindPeerKeys at construction
await m2f.ready()
await m2f.importPhoto(PNG_1PX, { name: 'runtime.png', takenAt: 1, thumb: 'T' })
await m2f.share()
assert.equal(m2f.status().mirrors, 0, 'no mirror configured at boot')
assert.equal(m2f.blind, null, 'and no mirror client exists yet')
await m2f.addMirror(idEncoding.encode(m2server.publicKey)) // the runtime Settings flow
assert.equal(m2f.status().mirrors, 1, 'addMirror registers the key live')
assert.ok(m2f.blind, 'and creates the mirror client')
assert.deepEqual(m2f.mirrorKeys(), [idEncoding.encode(m2server.publicKey)], 'mirrorKeys reports it (what the app shows)')
let m2absorbed = false
for (let i = 0; i < 1600 && !m2absorbed; i++) { await new Promise((res) => setTimeout(res, 25)); m2absorbed = !!(m2server.digest && (m2server.digest.bytesAllocated > 0 || m2server.digest.cores > 0)) }
assert.ok(m2absorbed, 'AF-M2: the RUNTIME-added mirror absorbs the library (same path as a boot-configured one)')
await m2f.addMirror(idEncoding.encode(m2server.publicKey))
assert.equal(m2f.status().mirrors, 1, 'addMirror is idempotent on an already-configured key')
await m2f.close(); await m2server.close(); await m2net.destroy()
fs.rmSync(m2srvDir, { recursive: true, force: true }); fs.rmSync(m2fDir, { recursive: true, force: true })

// Ch10 M1: THE SILENT KEY FAILURES. Two devices that deserved the album's full
// history quietly didn't get it: (a) a REBOOTED owner — rotated content keys
// lived only in memory, so the founder's own post-rotation photos went dark
// after a restart; (b) a LATE JOINER — paired after a rotation, it got the
// album key (epoch 0) in the confirm but no sealed copies of later epochs, so
// every pre-join rotation stayed redacted for a legitimate member. Fixes: the
// owner seals each rotation to itself too, and createInvite appends GRANT_KEYS
// (sealed copies of every held epoch) for the member it just admitted. The
// kicked member must gain nothing from either.
const g10net = await createTestnet(3)
const g10album = crypto.randomBytes(32)
const g10fSeed = crypto.randomBytes(32)
const g10fDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-g10F-'))
const g10fOpts = { primaryKey: primaryKeyFromSeed(g10fSeed), encryptionKey: g10album, boxKeyPair: memberBoxKeyFromSeed(g10fSeed), dhtBootstrap: g10net.bootstrap }
let g10Founder = new Vault(g10fDir, g10fOpts)
await g10Founder.ready()
const g10aSeed = crypto.randomBytes(32)
const g10aDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-g10A-'))
const g10A = new Vault(g10aDir, { primaryKey: primaryKeyFromSeed(g10aSeed), bootstrap: idEncoding.encode(g10Founder.base.key), encryptionKey: g10album, boxKeyPair: memberBoxKeyFromSeed(g10aSeed), dhtBootstrap: g10net.bootstrap })
await g10A.ready()
await g10Founder.share()
await g10A.share()
await g10Founder.base.append({ type: CMD.ADD_WRITER, writerKey: g10A.deviceKey, boxKey: g10A.boxPublicKey })
for (let i = 0; i < 800 && !g10A.base.writable; i++) { await new Promise((res) => setTimeout(res, 25)); await g10Founder.base.update(); await g10A.base.update() }
assert.ok(g10A.base.writable, 'member A is admitted')
await g10Founder.importPhoto(PNG_1PX, { name: 'before.png', takenAt: 100, thumb: 'THUMB-B4' })
await g10Founder.removeMember(b4a.toString(g10A.deviceKey, 'hex')) // kick → rotation to epoch 1
await g10Founder.importPhoto(PNG_1PX_RED, { name: 'late.png', takenAt: 200, thumb: 'THUMB-LATE' })
assert.equal(await thumbOf(g10Founder, 'late.png'), 'THUMB-LATE', 'the live owner reads its post-rotation photo')

// (a) The owner reboots. The rotated key must come back from the LOG — the
// owner-addressed sealed copy — because memory didn't survive.
await g10Founder.close()
g10Founder = new Vault(g10fDir, g10fOpts)
await g10Founder.ready()
assert.equal(await thumbOf(g10Founder, 'late.png'), 'THUMB-LATE', 'a REBOOTED owner still reads post-rotation photos (rotation sealed to itself)')
assert.ok(g10Founder.contentKeys.has(1), 'the rebooted owner re-learned the epoch-1 key from the rotations row')
await g10Founder.share()

// (b) A late joiner pairs AFTER the rotation, through the real invite path.
const g10invite = await g10Founder.createInvite()
const g10jSeed = crypto.randomBytes(32)
const g10jBox = memberBoxKeyFromSeed(g10jSeed)
const g10jDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-g10J-'))
const g10del = await pairAsCandidate(g10jDir, { primaryKey: primaryKeyFromSeed(g10jSeed), invite: g10invite, boxKeyPair: g10jBox, dhtBootstrap: g10net.bootstrap })
const g10J = new Vault(g10jDir, { primaryKey: primaryKeyFromSeed(g10jSeed), bootstrap: idEncoding.encode(g10del.libraryKey), encryptionKey: b4a.from(g10del.encryptionKey), boxKeyPair: g10jBox, dhtBootstrap: g10net.bootstrap })
await g10J.ready()
await g10J.share()
let g10jLate = null
for (let i = 0; i < 800 && !g10jLate; i++) { await new Promise((res) => setTimeout(res, 25)); await g10J.base.update(); g10jLate = await thumbOf(g10J, 'late.png') || null }
assert.equal(await thumbOf(g10J, 'before.png'), 'THUMB-B4', 'the late joiner reads epoch-0 history (album key from the confirm)')
assert.equal(g10jLate, 'THUMB-LATE', 'the late joiner reads POST-ROTATION photos — GRANT_KEYS sealed the held epochs to it')
assert.ok(g10J.contentKeys.has(1), 'the late joiner unsealed the granted epoch-1 key')

// The kicked member gained nothing from either fix.
for (let i = 0; i < 200; i++) { await new Promise((res) => setTimeout(res, 10)); await g10A.base.update() }
assert.equal(await thumbOf(g10A, 'late.png'), '', 'the kicked member still reads post-rotation content as redacted')
assert.equal(await thumbOf(g10A, 'before.png'), 'THUMB-B4', 'and keeps its pre-kick content (Inv-9 intact)')
assert.ok(!g10A.contentKeys.has(1), 'no grant ever addressed the kicked member')
await g10J.close(); await g10A.close(); await g10Founder.close(); await g10net.destroy()
fs.rmSync(g10fDir, { recursive: true, force: true }); fs.rmSync(g10aDir, { recursive: true, force: true }); fs.rmSync(g10jDir, { recursive: true, force: true })

// Ch10 M2: A PRIVATE DISCOVERY TOPIC. `discoveryKey(libraryKey)` is a public
// derivation — so an encrypted album that swarms on it hands every library-key
// holder the members' IP addresses, even though the CONTENT is safe. Members
// now meet on a topic derived from the ALBUM key: finding the members requires
// the same secret as reading them. The library key stays what it always was —
// a shareable identifier — and leaks nothing about where the members are.
const dtAlbum = crypto.randomBytes(32)
const dtBase = { discoveryKey: crypto.randomBytes(32) } // shape-only stand-in for the pure-function checks
assert.ok(!b4a.equals(discoveryTopic(dtBase, dtAlbum), dtBase.discoveryKey), 'an encrypted album\'s topic is NOT the public discoveryKey')
assert.ok(b4a.equals(discoveryTopic(dtBase, dtAlbum), discoveryTopic(dtBase, dtAlbum)), 'the derived topic is deterministic (members independently compute the same one)')
assert.ok(b4a.equals(discoveryTopic(dtBase, null), dtBase.discoveryKey), 'an unencrypted library keeps the classic topic')

const dtNet = await createTestnet(3)
const dtFDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-dtF-'))
const dtFounder = new Vault(dtFDir, { encryptionKey: dtAlbum, dhtBootstrap: dtNet.bootstrap })
await dtFounder.ready()
await dtFounder.importPhoto(PNG_1PX, { name: 'hidden.png', takenAt: 1000 })
await dtFounder.share()

// A stranger holding ONLY the library key camps on the legacy topic: nobody
// announces there anymore, so it gets no connection — no members' addresses,
// no ciphertext stream, nothing (bounded negative, ~3s).
const dtStranger = new Hyperswarm({ bootstrap: dtNet.bootstrap })
dtStranger.on('connection', (conn) => conn.on('error', () => {}))
dtStranger.join(dtFounder.base.discoveryKey, { client: true, server: false })
await dtStranger.flush().catch(() => {})
for (let i = 0; i < 120; i++) { await new Promise((res) => setTimeout(res, 25)) }
assert.equal(dtStranger.connections.size, 0, 'a library-key-only stranger finds NOBODY on the legacy topic')
await dtStranger.destroy()

// A key-holder derives the members' topic and connects.
const dtPeer = new Hyperswarm({ bootstrap: dtNet.bootstrap })
dtPeer.on('connection', (conn) => conn.on('error', () => {}))
dtPeer.join(discoveryTopic(dtFounder.base, dtAlbum), { client: true, server: false })
let dtConnected = false
for (let i = 0; i < 400 && !dtConnected; i++) { await new Promise((res) => setTimeout(res, 25)); dtConnected = dtPeer.connections.size > 0 }
assert.ok(dtConnected, 'an album-key holder finds the members on the derived topic')
await dtPeer.destroy()
await dtFounder.close()
await dtNet.destroy()
fs.rmSync(dtFDir, { recursive: true, force: true })

// Ch10 M3: LOUD METRICS. The failures that kill trust in a no-server app are
// the silent ones — a resume that reconnects nobody, a view that quietly stops
// advancing. status() rides every STAT: peers (the pipe exists), lastUpdateAt
// (the library actually moved), suspended (why it might not be moving).
const stNet = await createTestnet(3)
const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-stat-'))
const stVault = new Vault(stDir, { dhtBootstrap: stNet.bootstrap })
await stVault.ready()
const stFresh = stVault.status()
assert.equal(stFresh.peers, 0, 'a fresh vault has no peers')
assert.equal(stFresh.suspended, false, 'and reports itself live')
// Even a "fresh" founder has already moved: ensureOwner()'s role claim
// advanced the view during boot. lastUpdateAt reports THAT honestly too.
assert.ok(stFresh.lastUpdateAt > 0, 'the founder\'s own role claim already stamped lastUpdateAt')
await stVault.importPhoto(PNG_1PX, { name: 'tick.png', takenAt: 1000 })
assert.ok(stVault.status().lastUpdateAt >= stFresh.lastUpdateAt, 'a view advance re-stamps lastUpdateAt — "moving" is a number, not a feeling')
await stVault.share()
const stPeer = new Hyperswarm({ bootstrap: stNet.bootstrap })
stPeer.on('connection', (conn) => conn.on('error', () => {}))
stPeer.join(stVault.base.discoveryKey, { client: true, server: false })
for (let i = 0; i < 400 && stVault.status().peers === 0; i++) { await new Promise((res) => setTimeout(res, 25)) }
assert.equal(stVault.status().peers, 1, 'a real connection shows up as peers: 1')
await stVault.suspend()
const stSuspended = stVault.status()
assert.equal(stSuspended.suspended, true, 'suspension is reported, not hidden')
assert.equal(stSuspended.peers, 0, 'and the destroyed connections read as peers: 0 — the honest number')
await stVault.resume()
assert.equal(stVault.status().suspended, false, 'resume flips the flag back')
await stPeer.destroy()
await stVault.close()
await stNet.destroy()
fs.rmSync(stDir, { recursive: true, force: true })

// The oracle: near-duplicates first (grid-identical threshold), then oldest.
const orDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-oracle-'))
const orVault = new Vault(orDir)
await orVault.ready()
await orVault.importPhoto(PNG_1PX, { name: 'keeper.png', takenAt: 1000, dhash: '00ff00ff00ff00ff' })
await orVault.importPhoto(PNG_1PX, { name: 'dupA.png', takenAt: 2000, dhash: 'ffffffffffffffff' })
await orVault.importPhoto(PNG_1PX_RED, { name: 'dupB.png', takenAt: 3000, dhash: 'fffffffffffffffe' }) // hamming 1 from dupA
const orRecs = await orVault.list({ limit: 10, reverse: false })
const orId = (name) => orRecs.find((r) => r.name === name).id
const orOne = await orVault.evictionCandidates({ bytes: 1 })
assert.deepEqual(orOne, [orId('dupB.png')], 'the oracle evicts the near-duplicate first — never the only copy of a scene')
const orAll = await orVault.evictionCandidates({ bytes: 1e9 })
assert.deepEqual(orAll, [orId('dupB.png'), orId('keeper.png'), orId('dupA.png')], 'then oldest-first for the rest')
assert.deepEqual(await orVault.evictionCandidates({}), [], 'no byte target → no candidates (eviction is never implicit)')
// Audit AF-M9: evict() ignores non-hex ids (a stray/garbage id can't clear a
// wrong blob), and only evicts the valid ones.
const orValid = orId('dupA.png')
const orEv = await orVault.evict(['not-a-hex-id', '', orValid])
assert.equal(orEv.evicted, 1, 'AF-M9: evict skips non-hex ids and clears only the one valid record')
assert.equal(orEv.freedBytes, PNG_1PX.byteLength, 'and reports the freed bytes of that record')
await orVault.close()
fs.rmSync(orDir, { recursive: true, force: true })

console.log('smoke: ok — indexed, range query, 64-bit key, no collision, Inv-4, 0-byte, count-race, read-replica, seed-identity, pairing→writable, two-writer convergence, roles, revocation, re-invite-after-revoke, author-bound keys, encryption, key-delivery-via-pairing, single-use invite, owner-only invite/remove, content-key rotation on revoke, phone-join+persist+restart, suspend/resume (stall+local-first+storm+drain+link-survival), exception filter (allowlist+cause-chain+window+process-level), tiered eviction (cold-start+demand-fetch+evict+re-fetch+oracle), blind mirror (absorb+founder-offline-converge+original-from-mirror+ciphertext-only+lifecycle), key continuity (owner-reboot+late-joiner-grants+kicked-gains-nothing), private topic (derived≠public+stranger-finds-nobody+keyholder-connects), loud metrics (peers+lastUpdateAt+suspended honest across lifecycle) all verified')
