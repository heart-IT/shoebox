// Host-agnostic vault core. Runs unchanged under Bare (worklet) and Node (tests,
// desktop mirror). Platform modules are injected or lazily required — never
// required at top level (Bare.* globals only exist at runtime).

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperblobs = require('hyperblobs')
const BlobServer = require('hypercore-blob-server')
const Hyperswarm = require('hyperswarm')
const idEncoding = require('hypercore-id-encoding')
const b4a = require('b4a')
const { resolveStruct } = require('./spec')

// The record wire format is the generated Hyperschema struct (compact-encoding).
const photoEncoding = resolveStruct('@shoebox/photo', 1)

// Keys sort chronologically because the capture time is an 8-byte BIG-ENDIAN
// prefix. A time window is therefore a Hyperbee range query, not a scan (Inv:
// the grid is a windowed query against an index, not a walk of a folder).
//
// The tail must make the key UNIQUE: a bee key is an identity, so a key two
// photos can share means the second put OVERWRITES the first and orphans its
// blob. takenAt+name is not unique (a burst can stamp several frames with one
// filename at one millisecond), so the tail ends with the blob's byteOffset,
// which no two non-empty blobs in a core share.
function photoKey (takenAt, name, disambiguator) {
  const tail = name + '\x00' + disambiguator // null-separated so name can't bleed into it
  const key = b4a.alloc(8 + b4a.byteLength(tail))
  writeUint64BE(key, Math.max(0, takenAt), 0) // clamp: a pre-1970 date must not sort as newest
  b4a.write(key, tail, 8)
  return key
}

function writeUint64BE (buf, value, offset) {
  // JS numbers are safe to 2^53; split into two 32-bit halves.
  const high = Math.floor(value / 0x100000000)
  const low = value >>> 0
  buf[offset] = (high >>> 24) & 0xff
  buf[offset + 1] = (high >>> 16) & 0xff
  buf[offset + 2] = (high >>> 8) & 0xff
  buf[offset + 3] = high & 0xff
  buf[offset + 4] = (low >>> 24) & 0xff
  buf[offset + 5] = (low >>> 16) & 0xff
  buf[offset + 6] = (low >>> 8) & 0xff
  buf[offset + 7] = low & 0xff
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', gif: 'image/gif' }
function mimeFor (name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

class Vault {
  constructor (storagePath) {
    this.store = new Corestore(storagePath)
    // Two cores, per Inv-1: bytes live in the blobs core; the index is a
    // Hyperbee (B-tree over a core) keyed by capture-time. New core name
    // ('photo-bee') because Ch3 changes the index format incompatibly — the old
    // 'photo-index' Hypercore append-log is abandoned, not migrated in place
    // (opening a Hyperbee over log blocks decodes them as garbage).
    this.indexCore = this.store.get({ name: 'photo-bee' })
    this.blobsCore = this.store.get({ name: 'photo-blobs' })
    this.bee = null
    this.blobs = null
    this.server = null
    this.swarm = null
    this._count = null // computed lazily by ensureCount()
  }

  async ready () {
    await this.indexCore.ready()
    await this.blobsCore.ready()
    this.bee = new Hyperbee(this.indexCore, { keyEncoding: 'binary', valueEncoding: photoEncoding })
    this.blobs = new Hyperblobs(this.blobsCore)

    this.server = new BlobServer(this.store)
    await this.server.listen()
  }

  // Entry count. Computed lazily from the tree on first use (a fresh scan can
  // stall a boot), then kept in sync on import.
  async ensureCount () {
    if (this._count !== null) return this._count
    // Memoize the scan: a boot-time STAT racing an import must share ONE snapshot
    // rather than each starting its own. importPhoto awaits this before its put,
    // so no import can slip into the snapshot window and lose its increment.
    if (!this._counting) {
      this._counting = (async () => {
        let n = 0
        for await (const _ of this.bee.createReadStream()) n++ // eslint-disable-line no-unused-vars
        this._count = n
        return n
      })()
    }
    return this._counting
  }

  // Announce the index core so a remote peer (the peek script) can replicate.
  async share () {
    if (this.swarm) return
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn) => this.store.replicate(conn))
    this.swarm.join(this.indexCore.discoveryKey, { server: true, client: false })
    await this.swarm.flush()
  }

  async importPhoto (buffer, meta = {}) {
    // Reject empty blobs: hyperblobs does not advance byteOffset for a 0-byte
    // put, so the per-blob disambiguator would degenerate and two empty imports
    // with the same time+name could collide onto one key.
    if (!buffer || buffer.byteLength === 0) throw new Error('refusing to import an empty (0-byte) photo')
    // Materialize the count before writing so the one-time scan can't race this
    // put into its snapshot and drop the increment.
    await this.ensureCount()
    const name = meta.name || 'photo'
    const takenAt = meta.takenAt || Date.now()
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
    }
    // byteOffset is unique per non-empty put, so the key is unique — no
    // get-then-put, no overwrite, no orphaned blob. The count was materialized
    // above, so the bump is always live (JS handlers are single-threaded, so it
    // can't interleave).
    const key = photoKey(takenAt, name, id.byteOffset)
    await this.bee.put(key, record)
    this._count++
    return {
      link: this.link(record),
      indexKey: idEncoding.encode(this.indexCore.key),
      takenAt,
      id: b4a.toString(key, 'hex'),
    }
  }

  // A time-ordered window over the index. reverse => newest first (the grid).
  async list ({ limit = 100, reverse = true } = {}) {
    const out = []
    for await (const { key, value } of this.bee.createReadStream({ reverse, limit })) {
      out.push(this.decorate(value, key))
    }
    return out
  }

  async latest () {
    const node = await this.bee.peek({ reverse: true })
    return node ? this.decorate(node.value, node.key) : null
  }

  // Attach the localhost blob-server URL; the bytes stay out of the record.
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
    return this.server.getLink(record.blobsCoreKey, { blob: id })
  }

  async count () {
    return this.ensureCount()
  }

  async close () {
    if (this.swarm) await this.swarm.destroy()
    if (this.server) await this.server.close()
    await this.store.close()
  }
}

module.exports = { Vault, mimeFor, photoKey, writeUint64BE }
