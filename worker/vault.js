// Host-agnostic vault core. Runs unchanged under Bare (worklet) and Node (tests,
// desktop mirror). Ch5: the index is an AUTOBASE — each device appends to its own
// log and a deterministic apply() (in ./library) linearizes every writer's
// commands into one shared Hyperbee view. Photo BYTES never enter the log: they
// stay in a per-device Hyperblobs core and the view holds only a pointer (Inv-1).
// The library's durable identity is the Autobase bootstrap key, stable as devices
// come and go — not any one core key.

const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const Autobase = require('autobase')
const BlobServer = require('hypercore-blob-server')
const Hyperswarm = require('hyperswarm')
const BlindPairing = require('blind-pairing')
const BlindPeering = require('blind-peering')
const Wakeup = require('protomux-wakeup')
const idEncoding = require('hypercore-id-encoding')
const z32 = require('z32') // invites are variable-length, not 32-byte keys
const b4a = require('b4a')
const { CMD, ROLE, commandEncoding, openView, apply, photoKey, disambiguator, roleOf, currentEpoch, sealedKeysFor, memberBoxKeys, readEpoch, writeUint64BE } = require('./library')
const { newContentKey, sealTo, openSealed, contentEncrypt, contentDecrypt } = require('./rotation')

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', gif: 'image/gif' }
function mimeFor (name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

// Near-duplicate parameters for the eviction oracle — MIRRORS the grid's
// (app/src/Grid.tsx): same threshold, same degenerate all-zero exclusion, so
// "evict near-duplicates first" evicts exactly what the UI calls a duplicate.
const NEAR_DUP_HAMMING = 12
const DEGENERATE_DHASH = '0000000000000000'
function hammingHex (a, b) {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

class Vault {
  // `bootstrap` (a library key, z-base-32) joins an EXISTING library as a second
  // device (Ch5 M3); null founds a new one (this device becomes the first writer).
  constructor (storagePath, { bootstrap = null, primaryKey = null, encryptionKey = null, boxKeyPair = null, dhtBootstrap = null, blindPeerKeys = null } = {}) {
    // A seed-derived primaryKey makes every core — including this device's
    // Autobase writer key — a pure function of the device seed, so it's
    // recoverable. `unsafe: true` acknowledges we manage the key deliberately
    // (one seed per device); without a primaryKey, Corestore mints a random one.
    this.store = primaryKey
      ? new Corestore(storagePath, { primaryKey, unsafe: true })
      : new Corestore(storagePath)
    this.bootstrap = bootstrap ? idEncoding.decode(bootstrap) : null
    // The album ENCRYPTION key — encrypts the Autobase (log + views), so the library
    // is private on the wire and at rest. It's MEMBERSHIP: a member holds it and can
    // see the album. Members receive it through pairing (Ch7 M2). It never rotates.
    this.encryptionKey = encryptionKey
    // This device's seed-derived box keypair — opens content keys sealed to it on
    // rotation (Ch7 M3). Its public half is shipped up during pairing.
    this.boxKeyPair = boxKeyPair
    // CONTENT keys by epoch — what actually encrypts each photo's thumb + bytes, and
    // what ROTATES on revocation. Epoch 0 IS the album key: every member has it. Each
    // later epoch is a fresh key sealed only to the members who remained.
    this.contentKeys = new Map()
    if (encryptionKey) this.contentKeys.set(0, encryptionKey)
    this._syncedEpoch = -1 // highest rotation epoch already unsealed into contentKeys
    // blobCoreKey hex → the content key it's encrypted under, for the blob-server's
    // resolve hook (per-epoch cores use per-epoch keys).
    this._coreContentKey = new Map()
    this.blobsByEpoch = new Map() // epoch → Hyperblobs (a fresh core per content epoch)
    // DHT bootstrap override — production uses the public DHT (null); the smoke
    // test injects an isolated in-process testnet so pairing never leaves localhost.
    this.dhtBootstrap = dhtBootstrap
    this.base = null
    this.blobs = null // the epoch-0 blobs core (this.blobsByEpoch.get(0))
    this.server = null
    this.swarm = null
    this.pairing = null // BlindPairing instance (invite flow), created on demand
    this.member = null // the active invite member
    this._count = null // computed lazily by ensureCount()
    this._counting = null // in-flight count scan, memoized so callers share it
    // Mobile lifecycle (Ch8). Transitions are SERIALIZED through this queue: the
    // OS can flip background/active faster than a transition completes, and a
    // resume interleaving a half-done suspend leaves the swarm half-alive.
    this.suspended = false
    this._lifecycle = Promise.resolve()
    this._imports = new Set() // in-flight imports, drained (bounded) on suspend
    // Ch9 M2: the always-on cold tier. Keys of blind peers that mirror this
    // library's cores — holding ciphertext they cannot read (the album key
    // never reaches them). No keys → no mirrors contacted, availability stays
    // "works while my other device is awake".
    this.blindPeerKeys = blindPeerKeys
    this.blind = null // BlindPeering client, created with the swarm in share()
    this.wakeup = null
  }

  async ready () {
    // The Autobase whose view is the capture-time Hyperbee. apply/open live in
    // ./library so this device and the desktop peer run identical code.
    this.base = new Autobase(this.store, this.bootstrap, {
      open: openView,
      apply,
      valueEncoding: commandEncoding,
      ackInterval: 1000, // auto-ack so a lone writer's imports get indexed
      ...(this.encryptionKey ? { encryptionKey: this.encryptionKey } : {}) // private album
    })
    await this.base.ready()
    // The cached photo count goes stale on ANY view advance, not just our own
    // imports — a photo replicated in from another writer, or a view rebuild after
    // reordering, must invalidate it too (importPhoto also invalidates eagerly).
    this.base.on('update', () => { this._count = null; this._counting = null })
    // Epoch-0 blobs core — named 'photo-blobs', keyed by the album key (= epoch-0
    // content key), so it's byte-identical to the M1/M2 layout.
    this.blobs = await this._blobsForEpoch(0)

    // Serve blobs by key. A photo's bytes live in the blob core for the epoch it was
    // imported under, encrypted with that epoch's content key — so the resolve hook
    // hands back the PER-CORE key (a member who lacks a rotated epoch's key simply
    // can't serve, or read, its photos). Falls back to the album key for view cores.
    this.server = new BlobServer(this.store, this.encryptionKey
      ? { resolve: (key) => ({ key, encryptionKey: this._coreContentKey.get(b4a.toString(key, 'hex')) || this.encryptionKey }) }
      : {})
    await this.server.listen()

    await this.ensureOwner()
  }

  // The Hyperblobs core for a content epoch. Epoch 0 is 'photo-blobs' under the
  // album key (the M1/M2 layout); each later epoch is its own core encrypted with
  // that epoch's rotated content key, so a member who lacks the key can neither read
  // nor serve its photos. Memoized per epoch.
  async _blobsForEpoch (epoch) {
    if (this.blobsByEpoch.has(epoch)) return this.blobsByEpoch.get(epoch)
    const ck = this.contentKeys.get(epoch) // undefined for unencrypted albums / missing epochs
    const name = epoch === 0 ? 'photo-blobs' : 'photo-blobs-e' + epoch
    const core = this.store.get(ck ? { name, encryptionKey: ck } : { name })
    await core.ready()
    this._coreContentKey.set(b4a.toString(core.key, 'hex'), ck || this.encryptionKey)
    const blobs = new Hyperblobs(core)
    this.blobsByEpoch.set(epoch, blobs)
    // A rotation minted a fresh blob core mid-flight — the mirror must hold it
    // too, or post-rotation originals have no cold tier (Ch9 M2).
    if (this.blind) this.blind.addCoreBackground(core, { referrer: this.base.key })
    return blobs
  }

  // Unseal any rotation epochs we don't hold yet — each device opens the content key
  // sealed to IT (by its writer key) with its box secret key. The founder already
  // holds every key it minted, so this is how JOINED members catch up; a revoked
  // member has no sealed entry for epochs after its kick, so it stays locked out.
  async _syncContentKeys () {
    if (!this.encryptionKey || !this.boxKeyPair) return
    await this.base.update()
    const myHex = b4a.toString(this.base.local.key, 'hex')
    for await (const { key, value } of this.base.view.rotations.createReadStream()) {
      const epoch = readEpoch(key)
      if (this.contentKeys.has(epoch)) continue
      const sealed = JSON.parse(value)[myHex]
      if (!sealed) continue // not sealed to us — a photo of this epoch is redacted for us
      const opened = openSealed(b4a.from(sealed, 'hex'), this.boxKeyPair)
      if (opened) this.contentKeys.set(epoch, opened)
    }
  }

  // The founder claims OWNER of the library on first boot. Idempotent — once the
  // role exists (this boot or a later one) it's a no-op. Joiners (bootstrap set)
  // and non-writers never self-claim.
  async ensureOwner () {
    if (this.bootstrap || !this.base.writable) return
    await this.base.update()
    if (await roleOf(this.base.view.roles, this.base.local.key)) return
    await this.base.append({ type: CMD.SET_ROLE, writerKey: this.base.local.key, role: ROLE.OWNER })
    await this.base.update()
  }

  // The album's roster: [{ writerKey (hex), role }]. Reads the roles bee.
  async members () {
    await this.base.update()
    const out = []
    for await (const { key, value } of this.base.view.roles.createReadStream()) {
      out.push({ writerKey: key, role: value })
    }
    return out
  }

  // Is THIS device the album owner? apply() is the real authority (every peer
  // agrees there); this is the local pre-check so we don't append no-op commands
  // or hand out keys from a non-owner device, and can report an honest failure.
  async isOwner () {
    await this.base.update()
    return this.base.writable && await roleOf(this.base.view.roles, this.base.local.key) === ROLE.OWNER
  }

  // Revoke a member — owner-only. apply() also enforces this, but gating here means
  // a non-owner device fails loudly instead of appending a command that silently
  // no-ops (which used to report success). Their future writes stop; photos stay.
  // On an ENCRYPTED album, revocation ALSO rotates the content key (Ch7 M3): future
  // photos are sealed under a key the removed member never receives.
  async removeMember (writerKeyHex) {
    if (!(await this.isOwner())) throw new Error('only the album owner can remove a member')
    await this.base.append({ type: CMD.REMOVE_WRITER, writerKey: b4a.from(writerKeyHex, 'hex') })
    await this.base.update()
    if (this.encryptionKey) await this.rotateContentKey()
  }

  // Mint a fresh content key for the next epoch and seal it to every REMAINING
  // member's box key (the just-removed member is already gone from the roster, so it
  // gets no copy). The owner keeps the new key directly. Forward-only: photos already
  // imported keep their old-epoch keys, so a removed member's past access is intact —
  // it's the FUTURE that's sealed away (Inv-9).
  async rotateContentKey () {
    await this.base.update()
    const epoch = (await currentEpoch(this.base.view)) + 1
    const key = newContentKey()
    const members = await memberBoxKeys(this.base.view) // roster AFTER the removal
    const entries = members.map((m) => ({ writerKey: b4a.from(m.writerKeyHex, 'hex'), sealed: sealTo(m.boxKey, key) }))
    // The owner seals to ITSELF too (Ch10 M1). contentKeys is memory; without an
    // owner-addressed copy in the log, a REBOOTED founder re-derives everything
    // except the rotated keys — and its own post-rotation photos go dark. The
    // silent failure class this chapter exists for.
    if (this.boxKeyPair) entries.push({ writerKey: b4a.from(this.base.local.key), sealed: sealTo(this.boxKeyPair.publicKey, key) })
    await this.base.append({ type: CMD.ROTATE_KEY, epoch, entries })
    await this.base.update()
    this.contentKeys.set(epoch, key) // the owner holds every key it mints
    return epoch
  }

  // The linearized photo index every peer converges to (roles are the other half
  // of the view — see base.view.roles, the album's authority model).
  get view () { return this.base.view.photos }

  // The library's durable identity — stable across devices coming and going.
  get libraryKey () { return this.base.key }

  // THIS device's identity — its own Autobase writer key, distinct from the
  // library key. Derived from the device seed, so it's stable and recoverable.
  // In M3 the second device ships this up during pairing to be added as a writer.
  get deviceKey () { return this.base.local.key }

  // This device's box PUBLIC key — shipped up during pairing (as writerKey||boxKey)
  // so the owner can seal rotated content keys to it (Ch7 M3).
  get boxPublicKey () { return this.boxKeyPair ? this.boxKeyPair.publicKey : null }

  // Entry count over the view. Computed lazily (a fresh scan can stall a boot),
  // memoized so a boot STAT racing an import shares one snapshot, invalidated on
  // import so the next read reflects the new command.
  async ensureCount () {
    if (this._count !== null) return this._count
    if (!this._counting) {
      this._counting = (async () => {
        await this.base.update()
        let n = 0
        for await (const _ of this.view.createReadStream()) n++ // eslint-disable-line no-unused-vars
        this._count = n
        return n
      })()
    }
    return this._counting
  }

  // Announce the library so other devices (and the desktop peer) can replicate.
  // server+client now: a second device is a peer, not a read-only mirror. The
  // whole Corestore replicates over the connection, so every writer's input core,
  // the view, and every blob core travel together. flush() is best-effort — an
  // offline announce must NEVER fail a locally-successful import (local-first).
  async share () {
    if (this.swarm) return
    // maxPeers bounds the connection fan-out — a cheap DoS ceiling now that an
    // invite is single-use (a leaked/old discoveryKey can still draw connections).
    this.swarm = new Hyperswarm({ maxPeers: 64, ...(this.dhtBootstrap ? { bootstrap: this.dhtBootstrap } : {}) })
    // base.replicate = store.replicate (all cores: writer logs, view, blobs) PLUS
    // the wakeup protocol — the hint layer that tells peers which writers advanced.
    // Plain store.replicate omits wakeup, so a joiner never learns to fetch.
    this.swarm.on('connection', (conn) => {
      // A transport error on one peer must never bubble to an unhandled rejection
      // and take down the worker; secret-stream self-heals the connection.
      conn.on('error', () => {})
      if (this.wakeup) this.wakeup.addStream(conn) // mirror hints ride every connection
      this.base.replicate(conn)
    })
    this.swarm.join(this.base.discoveryKey, { server: true, client: true })
    // Ch9 M2: register with the blind mirrors. The client rides the swarm's
    // DHT and connects to each mirror DIRECTLY by key (no topic involved); the
    // mirror replicates the log, the views, and the blob cores as ciphertext —
    // the album key never leaves the members. Background variants only: mirror
    // registration is best-effort and must never block boot or an import.
    if (this.blindPeerKeys && this.blindPeerKeys.length) {
      this.wakeup = new Wakeup(() => { this.base.update().catch(() => {}) })
      this.blind = new BlindPeering(this.swarm.dht, this.store, {
        wakeup: this.wakeup,
        keys: this.blindPeerKeys,
        pick: 1,
        suspended: this.suspended, // a client minted mid-background starts suspended
      })
      this.blind.addAutobaseBackground(this.base)
      for (const blobs of this.blobsByEpoch.values()) {
        this.blind.addCoreBackground(blobs.core, { referrer: this.base.key })
      }
    }
    // A first import can land WHILE the app is backgrounded (Ch8 M3): the swarm
    // it just minted must come up suspended, not live, or the vault's suspended
    // state and the actual sockets disagree until the next transition.
    if (this.suspended) { await this.swarm.suspend(); return }
    await this.swarm.flush().catch(() => {})
  }

  // Create a SINGLE-USE invite a second device can pair with. It multiplexes the
  // blind-pairing protocol over our EXISTING swarm — the candidate proves it holds
  // the invite, ships its writer key up as userData, and we authorize it by
  // appending ADD_WRITER (apply() then calls host.addWriter). The library key AND
  // the album key travel back so the candidate can open the encrypted library.
  //
  // OWNER-ONLY: apply() gates ADD_WRITER on ownership, but the album key is handed
  // back OUTSIDE apply() — a non-owner's ADD_WRITER would no-op yet still leak the
  // key. So the key-distribution capability is gated here, at its own boundary.
  // SINGLE-USE: blind-pairing invites carry an `expires` field that this version
  // does NOT enforce and have no built-in one-shot, so a multi-use invite is a
  // standing writer+key credential. We admit exactly the first candidate and deny
  // the rest; a fresh invite closes the previous member so invites can rotate.
  async createInvite () {
    if (!(await this.isOwner())) throw new Error('only the album owner can invite a device')
    if (!this.swarm) await this.share()
    if (!this.pairing) this.pairing = new BlindPairing(this.swarm)
    if (this.member) { await this.member.close().catch(() => {}); this.member = null }
    const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(this.base.key)
    let used = false
    this.member = this.pairing.addMember({
      discoveryKey,
      onadd: async (req) => {
        // open() first — it establishes the session deny()/confirm() reply over.
        // userData is writerKey || boxKey (Ch7 M3): the writer key is the candidate's
        // identity; the box key is what the owner seals future content keys to.
        const userData = req.open(publicKey)
        const writerKey = userData && userData.byteLength >= 32 ? userData.subarray(0, 32) : null
        const boxKey = userData && userData.byteLength >= 64 ? userData.subarray(32, 64) : null
        // one-shot: only the FIRST valid candidate is admitted; deny the rest.
        if (used || !writerKey) return req.deny()
        used = true // set before the first await — onadd's sync prefix is atomic
        await this.base.append({ type: CMD.ADD_WRITER, writerKey, boxKey })
        // Late-joiner unlock (Ch10 M1): the album key in the confirm only opens
        // epoch 0. Every rotation that happened BEFORE this member existed sealed
        // its content key to the members of that moment — so grant this member a
        // sealed copy of each epoch the owner holds, or every pre-join rotation
        // stays dark to a legitimate member forever. (A re-invite deliberately
        // restores full history: kick-then-reinvite is re-sharing, not redaction.)
        if (this.encryptionKey && boxKey) {
          await this._syncContentKeys()
          const entries = [...this.contentKeys]
            .filter(([epoch]) => epoch > 0) // epoch 0 IS the album key, in the confirm
            .sort((a, b) => a[0] - b[0])
            .map(([epoch, key]) => ({ epoch, sealed: sealTo(boxKey, key) }))
          if (entries.length) await this.base.append({ type: CMD.GRANT_KEYS, writerKey: b4a.from(writerKey), entries })
        }
        // Hand back the library key AND the album encryption key (= the epoch-0
        // content key). The blind-pairing handshake protects the confirm, so only
        // this admitted member learns it — never over the DHT or plain replication.
        req.confirm({ key: this.base.key, encryptionKey: this.encryptionKey })
      }
    })
    await this.member.flushed() // announce before the code is shared
    return z32.encode(invite) // z-base-32 of the ~66-byte invite (NOT a 32-byte key)
  }

  // A suspend arriving mid-import waits (bounded) for the imports already in
  // flight — this wrapper is what it waits on.
  async importPhoto (buffer, meta = {}) {
    const inflight = this._importPhoto(buffer, meta)
    this._imports.add(inflight)
    try {
      return await inflight
    } finally {
      this._imports.delete(inflight)
    }
  }

  async _importPhoto (buffer, meta = {}) {
    // Reject empty blobs: hyperblobs does not advance byteOffset for a 0-byte
    // put, so the per-blob disambiguator would degenerate and two empty imports
    // with the same time+name could collide onto one key.
    if (!buffer || buffer.byteLength === 0) throw new Error('refusing to import an empty (0-byte) photo')
    const name = meta.name || 'photo'
    const takenAt = meta.takenAt || Date.now()
    // The current content epoch decides which key encrypts this photo's browsable
    // content (thumb + bytes) — and which blob core its bytes land in.
    await this._syncContentKeys()
    const epoch = await currentEpoch(this.base.view)
    const contentKey = this.contentKeys.get(epoch)
    // Phase 1: bytes into THIS device's blobs core for this epoch (encrypted at the
    // hypercore layer with the epoch's content key), never into the command log.
    const blobs = await this._blobsForEpoch(epoch)
    const id = await blobs.put(buffer)
    const record = {
      name,
      takenAt,
      mime: meta.mime || mimeFor(name),
      byteLength: buffer.byteLength,
      blobsCoreKey: blobs.core.key,
      blockOffset: id.blockOffset,
      blockLength: id.blockLength,
      byteOffset: id.byteOffset,
      blobByteLength: id.byteLength,
      width: meta.width || 0,
      height: meta.height || 0,
      orientation: meta.orientation || 0,
      // The thumbnail is browsable content, so it's sealed under the epoch key too:
      // a revoked member decrypts the album (metadata) but this reads back as ''.
      thumb: this._encThumb(meta.thumb, contentKey),
      dhash: meta.dhash || '',
      embedding: meta.embedding || null,
      epoch,
    }
    // Phase 2: append a pointer command; apply() linearizes it into the view.
    await this.base.append({ type: CMD.IMPORT_PHOTO, photo: record })
    await this.base.update() // materialize our own command into the local view
    this._count = null // invalidate; recompute lazily from the view
    this._counting = null
    const key = photoKey(takenAt, name, disambiguator(record, this.base.local.key))
    return {
      link: this.link(record),
      indexKey: idEncoding.encode(this.base.key), // the LIBRARY key (bootstrap)
      takenAt,
      id: b4a.toString(key, 'hex'),
    }
  }

  // A time-ordered window over the view. reverse => newest first (the grid).
  // residency: true additionally marks each record hot/cold (Ch9 M1) — whether
  // its ORIGINAL bytes are locally present or evicted/never-fetched.
  async list ({ limit = 100, reverse = true, residency = false } = {}) {
    await this._syncContentKeys()
    const out = []
    for await (const { key, value } of this.view.createReadStream({ reverse, limit })) {
      out.push(this.decorate(value, key))
    }
    if (residency) await this._markResidency(out)
    return out
  }

  // Ch9 M1: TIERED RETENTION (Inv-11). The INDEX — records, thumbnails,
  // embeddings — is the library and stays local forever. The ORIGINAL is a
  // cache entry: sparse replication means its bytes were only ever fetched on
  // demand, and core.clear() hands them back. The record keeps its blob
  // coordinates, so nothing in the view changes on eviction — a cold original
  // re-fetches from any peer that holds it the next time it's asked for.

  // Mark each record resident (bytes locally present) or cold. Grouped by blob
  // core so a 200-record window opens each core once, not 200 times.
  async _markResidency (records) {
    const byCore = new Map()
    for (const r of records) {
      const hex = b4a.toString(r.blobsCoreKey, 'hex')
      if (!byCore.has(hex)) byCore.set(hex, [])
      byCore.get(hex).push(r)
    }
    for (const [hex, recs] of byCore) {
      const core = this.store.get({ key: b4a.from(hex, 'hex') })
      await core.ready()
      try {
        for (const r of recs) r.resident = await core.has(r.blockOffset, r.blockOffset + r.blockLength)
      } finally {
        await core.close()
      }
    }
  }

  // Evict originals by record id: clear the blob blocks from local storage.
  // The record — thumbnail, metadata, embedding — is untouched; the library
  // stays browsable and searchable, only the full-resolution bytes go cold.
  // Idempotent: already-cold records are skipped, not errors.
  async evict (ids) {
    let evicted = 0
    let freedBytes = 0
    for (const idHex of ids) {
      const node = await this.view.get(b4a.from(idHex, 'hex'))
      if (!node) continue
      const r = node.value
      const core = this.store.get({ key: r.blobsCoreKey })
      await core.ready()
      try {
        if (!(await core.has(r.blockOffset, r.blockOffset + r.blockLength))) continue
        await core.clear(r.blockOffset, r.blockOffset + r.blockLength)
        evicted++
        freedBytes += r.byteLength
      } finally {
        await core.close()
      }
    }
    return { evicted, freedBytes }
  }

  // The two tiers in numbers: how much of the library's original bytes are
  // local (hot) vs evicted/never-fetched (cold). The index itself is small and
  // always local — it's not what fills a 64 GB phone.
  async storageStat () {
    await this.base.update()
    const recs = []
    for await (const { key, value } of this.view.createReadStream()) {
      recs.push({ ...value, id: b4a.toString(key, 'hex') })
    }
    await this._markResidency(recs)
    let totalBytes = 0
    let localBytes = 0
    for (const r of recs) {
      totalBytes += r.byteLength
      if (r.resident) localBytes += r.byteLength
    }
    return { photos: recs.length, totalBytes, localBytes, coldBytes: totalBytes - localBytes }
  }

  // The priority oracle (the Part 4 index paying rent): near-duplicates first —
  // a photo whose dHash sits within the grid's own NEAR_DUP threshold of an
  // earlier photo is the cheapest thing to lose — then oldest-first. Returns
  // resident record ids until `bytes` worth of originals are covered.
  async evictionCandidates ({ bytes = 0 } = {}) {
    if (!bytes) return []
    const recs = (await this.list({ limit: 1000, reverse: false, residency: true })).filter((r) => r.resident)
    const seen = []
    const dupIds = new Set()
    for (const r of recs) {
      if (!r.dhash || r.dhash === DEGENERATE_DHASH) continue
      if (seen.some((s) => hammingHex(s, r.dhash) <= NEAR_DUP_HAMMING)) dupIds.add(r.id)
      else seen.push(r.dhash)
    }
    const ordered = [...recs.filter((r) => dupIds.has(r.id)), ...recs.filter((r) => !dupIds.has(r.id))]
    const out = []
    let covered = 0
    for (const r of ordered) {
      if (covered >= bytes) break
      out.push(r.id)
      covered += r.byteLength
    }
    return out
  }

  async latest () {
    await this._syncContentKeys()
    const node = await this.view.peek({ reverse: true })
    return node ? this.decorate(node.value, node.key) : null
  }

  // Encrypt a thumbnail (a data: URL string) under a content key → base64. Passed
  // through untouched for an unencrypted album (no content key).
  _encThumb (thumb, contentKey) {
    if (!thumb) return ''
    if (!contentKey) return thumb
    return b4a.toString(contentEncrypt(contentKey, b4a.from(thumb, 'utf-8')), 'base64')
  }

  // Decrypt a stored thumbnail with the key for its epoch. Returns '' when we lack
  // that epoch's key — the redaction a revoked member sees for post-rotation photos.
  _decThumb (record) {
    const thumb = record.thumb || ''
    if (!thumb || !this.encryptionKey) return thumb // unencrypted album → plaintext
    const ck = this.contentKeys.get(record.epoch || 0)
    const dec = ck ? contentDecrypt(ck, b4a.from(thumb, 'base64')) : null
    return dec ? b4a.toString(dec, 'utf-8') : ''
  }

  // Attach the localhost blob-server URL, a stable id, and the decrypted thumbnail;
  // the bytes stay out of the record. Registers this photo's blob core → content key
  // so the blob-server can serve it (a member lacking the epoch key registers
  // nothing, so the original stays unreadable to them too).
  decorate (record, key) {
    if (this.encryptionKey) {
      const ck = this.contentKeys.get(record.epoch || 0)
      if (ck) this._coreContentKey.set(b4a.toString(record.blobsCoreKey, 'hex'), ck)
    }
    return { ...record, thumb: this._decThumb(record), id: key ? b4a.toString(key, 'hex') : '', link: this.link(record) }
  }

  link (record) {
    const id = {
      blockOffset: record.blockOffset,
      blockLength: record.blockLength,
      byteOffset: record.byteOffset,
      byteLength: record.blobByteLength,
    }
    // getLink resolves ANY core in the store by key — so a photo authored on
    // another device is served the moment its blob core has replicated in.
    return this.server.getLink(record.blobsCoreKey, { blob: id, type: record.mime })
  }

  async count () {
    return this.ensureCount()
  }

  // Mobile background/foreground (Ch8, Inv-10: suspension is not graceful
  // shutdown). Both transitions run through one queue: the OS can fire
  // background→active→background faster than a transition completes, and an
  // unserialized resume can interleave a half-done suspend — ending foregrounded
  // with a dead swarm, or backgrounded with a live socket. Each transition
  // checks the flag INSIDE the queue, so a storm of flips collapses to no-ops.
  _transition (fn) {
    const run = this._lifecycle.then(fn, fn)
    this._lifecycle = run.then(() => {}, () => {}) // a failed transition must not wedge the queue
    return run
  }

  // Suspend the blob-server too, not just the swarm — otherwise its localhost
  // TCP socket stays bound the whole time the app is backgrounded. Before any
  // socket drops, DRAIN in-flight imports (bounded): the reply to SUSPEND is
  // the app's signal that the worker is quiescent, and the OS may freeze the
  // process right after — a half-appended import must not be what it freezes.
  // Bounded, not open-ended: past the deadline we suspend anyway and let the
  // append finish or not — suspension is not graceful shutdown.
  async suspend () {
    return this._transition(async () => {
      if (this.suspended) return
      if (this._imports.size) {
        await Promise.race([
          Promise.allSettled([...this._imports]),
          new Promise((res) => setTimeout(res, Vault.SUSPEND_DRAIN_MS)),
        ])
      }
      if (this.blind) await this.blind.suspend() // mirror RPC state first, while the DHT is still up
      if (this.pairing) await this.pairing.suspend()
      if (this.swarm) await this.swarm.suspend()
      if (this.server) await this.server.suspend()
      this.suspended = true
    })
  }

  // Mirror order of suspend. The blob-server re-binds its ORIGINAL port (it
  // falls back to a fresh one only if the bind now fails), so links the UI is
  // already holding normally survive a background/foreground round trip.
  async resume () {
    return this._transition(async () => {
      if (!this.suspended) return
      if (this.server) await this.server.resume()
      if (this.swarm) await this.swarm.resume()
      if (this.pairing) await this.pairing.resume()
      if (this.blind) this.blind.resume() // needs the DHT back first
      this.suspended = false
    })
  }

  async close () {
    // Queued behind any in-flight suspend/resume — closing mid-transition would
    // interleave two teardown orders over the same sockets.
    return this._transition(async () => {
      // Reverse dependency order, each guarded so one failure can't strand the
      // rest: mirror client → pairing → swarm → autobase (releases its core
      // sessions) → blob-server, which owns the store we handed it and closes
      // it in its own _close().
      if (this.blind) { try { this.blind.close() } catch { /* best effort */ } }
      if (this.pairing) await this.pairing.close().catch(() => {})
      if (this.swarm) await this.swarm.destroy().catch(() => {})
      if (this.base) await this.base.close().catch(() => {})
      if (this.server) await this.server.close().catch(() => {})
      else await this.store.close().catch(() => {})
    })
  }
}

// How long a suspend waits for in-flight imports before proceeding anyway.
Vault.SUSPEND_DRAIN_MS = 5000

// The CANDIDATE side of blind pairing — how a SECOND DEVICE joins an EXISTING
// library (Ch7 M4). It's the mirror of the owner's createInvite(): open a
// temporary swarm, prove we hold the invite, ship our writer key + box key up as
// userData, and receive {library key, album key} back through the sealed confirm.
// Those two keys are NOT seed-derivable — they're the founder's secret — so the
// caller must persist them; then it boots a joiner Vault on the SAME store, whose
// writer key is already the one the owner just admitted.
//
// Two-phase by necessity: you can't construct the Vault until pairing tells you
// its bootstrap (the library key). So this owns just the handshake — a throwaway
// store handle to read our writer key, a throwaway swarm to pair — and closes
// both so the Vault can reopen the store cleanly.
async function pairAsCandidate (storagePath, { primaryKey = null, invite, boxKeyPair = null, dhtBootstrap = null } = {}) {
  const store = primaryKey
    ? new Corestore(storagePath, { primaryKey, unsafe: true })
    : new Corestore(storagePath)
  // Our writer key BEFORE any Autobase exists — the same 'local' core the Vault's
  // Autobase will adopt. Opened exclusive, so close it before the Vault reopens.
  const local = Autobase.getLocalCore(store)
  await local.ready()
  const writerKey = b4a.from(local.key)
  await local.close()
  // userData = writerKey || boxKey, exactly what the owner's onadd splits back out:
  // the writer key is the identity to admit; the box key is what future content
  // keys get sealed to (Ch7 M3).
  const userData = boxKeyPair ? b4a.concat([writerKey, boxKeyPair.publicKey]) : writerKey

  const swarm = new Hyperswarm(dhtBootstrap ? { bootstrap: dhtBootstrap } : {})
  const pairing = new BlindPairing(swarm, { poll: 500 })
  let libraryKey = null
  let encryptionKey = null
  const candidate = pairing.addCandidate({
    invite: z32.decode(invite), // z-base-32 of the ~66-byte invite (NOT a 32-byte key)
    userData,
    onadd: (result) => { libraryKey = result.key; encryptionKey = result.encryptionKey },
  })
  try {
    await candidate.pairing
  } finally {
    // Release the temp swarm AND the store before the Vault reopens the same path.
    await pairing.close().catch(() => {})
    await swarm.destroy().catch(() => {})
    await store.close().catch(() => {})
  }
  if (!libraryKey) throw new Error('pairing rejected by the library (bad or spent invite)')
  return { libraryKey: b4a.from(libraryKey), encryptionKey: encryptionKey ? b4a.from(encryptionKey) : null }
}

module.exports = { Vault, pairAsCandidate, mimeFor, photoKey, writeUint64BE }
