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
const idEncoding = require('hypercore-id-encoding')
const z32 = require('z32') // invites are variable-length, not 32-byte keys
const b4a = require('b4a')
const { CMD, commandEncoding, openView, apply, photoKey, disambiguator, writeUint64BE } = require('./library')

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', gif: 'image/gif' }
function mimeFor (name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

class Vault {
  // `bootstrap` (a library key, z-base-32) joins an EXISTING library as a second
  // device (Ch5 M3); null founds a new one (this device becomes the first writer).
  constructor (storagePath, { bootstrap = null, primaryKey = null } = {}) {
    // A seed-derived primaryKey makes every core — including this device's
    // Autobase writer key — a pure function of the device seed, so it's
    // recoverable. `unsafe: true` acknowledges we manage the key deliberately
    // (one seed per device); without a primaryKey, Corestore mints a random one.
    this.store = primaryKey
      ? new Corestore(storagePath, { primaryKey, unsafe: true })
      : new Corestore(storagePath)
    this.bootstrap = bootstrap ? idEncoding.decode(bootstrap) : null
    // Bytes live in a per-device Hyperblobs core; the index is the Autobase view.
    this.blobsCore = this.store.get({ name: 'photo-blobs' })
    this.base = null
    this.blobs = null
    this.server = null
    this.swarm = null
    this.pairing = null // BlindPairing instance (invite flow), created on demand
    this.member = null // the active invite member
    this._count = null // computed lazily by ensureCount()
    this._counting = null // in-flight count scan, memoized so callers share it
  }

  async ready () {
    // The Autobase whose view is the capture-time Hyperbee. apply/open live in
    // ./library so this device and the desktop peer run identical code.
    this.base = new Autobase(this.store, this.bootstrap, {
      open: openView,
      apply,
      valueEncoding: commandEncoding,
      ackInterval: 1000 // auto-ack so a lone writer's imports get indexed
    })
    await this.base.ready()
    await this.blobsCore.ready()
    this.blobs = new Hyperblobs(this.blobsCore)

    this.server = new BlobServer(this.store)
    await this.server.listen()
  }

  // The linearized index every peer converges to.
  get view () { return this.base.view }

  // The library's durable identity — stable across devices coming and going.
  get libraryKey () { return this.base.key }

  // THIS device's identity — its own Autobase writer key, distinct from the
  // library key. Derived from the device seed, so it's stable and recoverable.
  // In M3 the second device ships this up during pairing to be added as a writer.
  get deviceKey () { return this.base.local.key }

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
    this.swarm = new Hyperswarm()
    // base.replicate = store.replicate (all cores: writer logs, view, blobs) PLUS
    // the wakeup protocol — the hint layer that tells peers which writers advanced.
    // Plain store.replicate omits wakeup, so a joiner never learns to fetch.
    this.swarm.on('connection', (conn) => this.base.replicate(conn))
    this.swarm.join(this.base.discoveryKey, { server: true, client: true })
    await this.swarm.flush().catch(() => {})
  }

  // Create a single invite a second device can pair with. It multiplexes the
  // blind-pairing protocol over our EXISTING swarm — the candidate proves it holds
  // the invite, ships its writer key up as userData, and we authorize it by
  // appending ADD_WRITER (apply() then calls host.addWriter). The library key
  // travels back so the candidate can bootstrap its own Autobase on the same base.
  async createInvite () {
    if (!this.swarm) await this.share()
    if (!this.pairing) this.pairing = new BlindPairing(this.swarm)
    // A fresh invite closes any previous one, so invites can be rotated.
    if (this.member) { await this.member.close().catch(() => {}); this.member = null }
    const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(this.base.key)
    let used = false
    this.member = this.pairing.addMember({
      discoveryKey,
      onadd: async (req) => {
        const writerKey = req.open(publicKey) // the candidate's 32-byte writer key
        // SINGLE-USE: only the first valid candidate is admitted; deny the rest, so a
        // leaked invite is not a standing credential.
        if (used || !writerKey || writerKey.byteLength !== 32) return req.deny()
        used = true
        await this.base.append({ type: CMD.ADD_WRITER, writerKey })
        req.confirm({ key: this.base.key }) // unencrypted library → hand back just the key
      }
    })
    await this.member.flushed() // announce before the code is shared
    return z32.encode(invite) // z-base-32 of the ~66-byte invite (NOT a 32-byte key)
  }

  async importPhoto (buffer, meta = {}) {
    // Reject empty blobs: hyperblobs does not advance byteOffset for a 0-byte
    // put, so the per-blob disambiguator would degenerate and two empty imports
    // with the same time+name could collide onto one key.
    if (!buffer || buffer.byteLength === 0) throw new Error('refusing to import an empty (0-byte) photo')
    const name = meta.name || 'photo'
    const takenAt = meta.takenAt || Date.now()
    // Phase 1: bytes into THIS device's blobs core (never into the command log).
    const id = await this.blobs.put(buffer)
    const record = {
      name,
      takenAt,
      mime: meta.mime || mimeFor(name),
      byteLength: buffer.byteLength,
      blobsCoreKey: this.blobsCore.key,
      blockOffset: id.blockOffset,
      blockLength: id.blockLength,
      byteOffset: id.byteOffset,
      blobByteLength: id.byteLength,
      width: meta.width || 0,
      height: meta.height || 0,
      orientation: meta.orientation || 0,
      thumb: meta.thumb || '',
      dhash: meta.dhash || '',
      embedding: meta.embedding || null,
    }
    // Phase 2: append a pointer command; apply() linearizes it into the view.
    await this.base.append({ type: CMD.IMPORT_PHOTO, photo: record })
    await this.base.update() // materialize our own command into the local view
    this._count = null // invalidate; recompute lazily from the view
    this._counting = null
    const key = photoKey(takenAt, name, disambiguator(record))
    return {
      link: this.link(record),
      indexKey: idEncoding.encode(this.base.key), // the LIBRARY key (bootstrap)
      takenAt,
      id: b4a.toString(key, 'hex'),
    }
  }

  // A time-ordered window over the view. reverse => newest first (the grid).
  async list ({ limit = 100, reverse = true } = {}) {
    await this.base.update()
    const out = []
    for await (const { key, value } of this.view.createReadStream({ reverse, limit })) {
      out.push(this.decorate(value, key))
    }
    return out
  }

  async latest () {
    await this.base.update()
    const node = await this.view.peek({ reverse: true })
    return node ? this.decorate(node.value, node.key) : null
  }

  // Attach the localhost blob-server URL and a stable id (the hex key); the
  // bytes stay out of the record.
  decorate (record, key) {
    return { ...record, id: key ? b4a.toString(key, 'hex') : '', link: this.link(record) }
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

  // Mobile background/foreground. Suspend the blob-server too, not just the
  // swarm — otherwise its localhost TCP socket stays bound the whole time the
  // app is backgrounded.
  async suspend () {
    if (this.pairing) await this.pairing.suspend()
    if (this.swarm) await this.swarm.suspend()
    if (this.server) await this.server.suspend()
  }

  async resume () {
    if (this.server) await this.server.resume()
    if (this.swarm) await this.swarm.resume()
    if (this.pairing) await this.pairing.resume()
  }

  async close () {
    // Reverse dependency order, each guarded so one failure can't strand the
    // rest: pairing → swarm → autobase (releases its core sessions) → blob-server,
    // which owns the store we handed it and closes it in its own _close().
    if (this.pairing) await this.pairing.close().catch(() => {})
    if (this.swarm) await this.swarm.destroy().catch(() => {})
    if (this.base) await this.base.close().catch(() => {})
    if (this.server) await this.server.close().catch(() => {})
    else await this.store.close().catch(() => {})
  }
}

module.exports = { Vault, mimeFor, photoKey, writeUint64BE }
