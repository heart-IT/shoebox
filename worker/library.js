// The deterministic library contract — the ONE piece of code every device runs
// identically. It defines the command wire format and the apply() that turns a
// linearized command log into the shared photo index. The phone (vault.js) and
// the desktop peer (peek.mjs) both import it, so their Autobase views converge
// byte for byte. Nothing here touches the network, the blob store, or the clock:
// apply() MUST be pure and deterministic — Autobase replays it on every peer,
// so a Date.now()/random()/IO on the view-writing path would diverge the peers.

const Hyperbee = require('hyperbee')
const c = require('compact-encoding')
const b4a = require('b4a')
const { resolveStruct } = require('./spec')

// The VIEW record is the generated Hyperschema struct (compact-encoding).
const photoEncoding = resolveStruct('@shoebox/photo', 1)

// Commands on the log are a tagged union: a uint type, then the payload.
// IMPORT_PHOTO carries a full photo record (pointer + metadata); ADD_WRITER
// (Ch5 M3) carries a 32-byte device writer key. Integers, not strings.
const CMD = { IMPORT_PHOTO: 1, ADD_WRITER: 2 }

// Value-encoding for the Autobase log: [uint type][payload]. Reuses the photo
// struct as the IMPORT payload so the wire stays compact-encoded end to end.
const commandEncoding = {
  preencode (state, cmd) {
    c.uint.preencode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.preencode(state, cmd.photo)
    else if (cmd.type === CMD.ADD_WRITER) c.fixed32.preencode(state, cmd.writerKey)
  },
  encode (state, cmd) {
    c.uint.encode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.encode(state, cmd.photo)
    else if (cmd.type === CMD.ADD_WRITER) c.fixed32.encode(state, cmd.writerKey)
  },
  decode (state) {
    const type = c.uint.decode(state)
    if (type === CMD.IMPORT_PHOTO) return { type, photo: photoEncoding.decode(state) }
    if (type === CMD.ADD_WRITER) return { type, writerKey: c.fixed32.decode(state) }
    return { type }
  }
}

// open() builds the linearized VIEW — the capture-time Hyperbee every peer
// converges to. It is written ONLY by apply(). Same key/value encoding as the
// Ch3 single-writer index, so the record format is unchanged (Inv-4 holds).
function openView (store) {
  return new Hyperbee(store.get('view'), { keyEncoding: 'binary', valueEncoding: photoEncoding, extension: false })
}

// apply() is the SOLE writer of the view and must be deterministic — identical
// output on every peer, every replay. Validation failures are no-ops (never
// throw); only genuine corruption should throw, to halt indexing rather than
// let peers diverge. `host` grants addWriter/removeWriter (used in M3).
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const cmd = node.value
    if (cmd.type === CMD.IMPORT_PHOTO) {
      const p = cmd.photo
      if (!p || !p.blobsCoreKey) continue // structural gate, not a throw
      const key = photoKey(p.takenAt, p.name, disambiguator(p))
      if (await view.get(key)) continue // idempotent: a replayed/dup import is a no-op
      await view.put(key, p)
    } else if (cmd.type === CMD.ADD_WRITER) {
      // Authorize a device as a writer. The gate is DETERMINISTIC — it reads the
      // replicated writer registry (host.system) — so every peer reaches the same
      // decision on every replay. Failures are no-ops, never throws.
      const key = cmd.writerKey
      if (!key || key.byteLength !== 32) continue // structural
      if (await host.system.has(key)) continue // idempotent: already a writer / replay
      // Authority: only a block authored by an existing writer may add one. A
      // non-optimistic block is only ever authored by a writer, so the founder's
      // legitimate ADD_WRITER passes and nothing else can.
      if (!node.from || !(await host.system.has(node.from.key))) continue
      await host.addWriter(key, { indexer: false }) // read-write, NOT a consensus indexer
    }
  }
}

// A blob's GLOBALLY-unique address: which device's blobs core, and the byte
// offset within it. byteOffset alone is unique only INSIDE one core, so two
// devices both starting at offset 0 would collide onto one key in the merged
// view and silently overwrite each other — the core key disambiguates writers.
function disambiguator (record) {
  return b4a.toString(record.blobsCoreKey, 'hex') + ':' + record.byteOffset
}

// Keys sort chronologically because the capture time is an 8-byte BIG-ENDIAN
// prefix, so a newest-first read is a bounded reverse scan. The name and the
// cross-writer disambiguator follow, null-separated so the name can't bleed in.
function photoKey (takenAt, name, disambiguator) {
  const tail = name + '\x00' + disambiguator
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

module.exports = { CMD, commandEncoding, openView, apply, photoKey, disambiguator, writeUint64BE }
