// The deterministic library contract — the ONE piece of code every device runs
// identically. It defines the command wire format and the apply() that turns a
// linearized command log into the shared view. Ch6 splits the view in two: a
// `photos` bee (the capture-time index) and a `roles` bee (who may do what), so
// authority is DATA in the replicated view, gated deterministically. apply()
// MUST stay pure — Autobase replays it on every peer, so a Date.now()/random()/IO
// on the view-writing path would diverge the peers.

const Hyperbee = require('hyperbee')
const c = require('compact-encoding')
const b4a = require('b4a')
const { resolveStruct } = require('./spec')

// The photo record is the generated Hyperschema struct (compact-encoding).
const photoEncoding = resolveStruct('@shoebox/photo', 1)

// Commands on the log are a tagged union: a uint type, then the payload.
const CMD = { IMPORT_PHOTO: 1, ADD_WRITER: 2, SET_ROLE: 3, REMOVE_WRITER: 4 }

// Roles are the album's authority model. The founder is the OWNER; invited
// people are MEMBERS. Owners manage membership; members add photos.
const ROLE = { OWNER: 'owner', MEMBER: 'member' }

const commandEncoding = {
  preencode (state, cmd) {
    c.uint.preencode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.preencode(state, cmd.photo)
    else if (cmd.type === CMD.ADD_WRITER) c.fixed32.preencode(state, cmd.writerKey)
    else if (cmd.type === CMD.REMOVE_WRITER) c.fixed32.preencode(state, cmd.writerKey)
    else if (cmd.type === CMD.SET_ROLE) { c.fixed32.preencode(state, cmd.writerKey); c.string.preencode(state, cmd.role) }
  },
  encode (state, cmd) {
    c.uint.encode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.encode(state, cmd.photo)
    else if (cmd.type === CMD.ADD_WRITER) c.fixed32.encode(state, cmd.writerKey)
    else if (cmd.type === CMD.REMOVE_WRITER) c.fixed32.encode(state, cmd.writerKey)
    else if (cmd.type === CMD.SET_ROLE) { c.fixed32.encode(state, cmd.writerKey); c.string.encode(state, cmd.role) }
  },
  decode (state) {
    const type = c.uint.decode(state)
    if (type === CMD.IMPORT_PHOTO) return { type, photo: photoEncoding.decode(state) }
    if (type === CMD.ADD_WRITER) return { type, writerKey: c.fixed32.decode(state) }
    if (type === CMD.REMOVE_WRITER) return { type, writerKey: c.fixed32.decode(state) }
    if (type === CMD.SET_ROLE) return { type, writerKey: c.fixed32.decode(state), role: c.string.decode(state) }
    return { type }
  }
}

// open() builds the VIEW every peer converges to — two bees written ONLY by
// apply(): `photos` (the capture-time index, unchanged since Ch3) and `roles`
// (writer-key hex → 'owner' | 'member').
function openView (store) {
  return {
    photos: new Hyperbee(store.get('view'), { keyEncoding: 'binary', valueEncoding: photoEncoding, extension: false }),
    roles: new Hyperbee(store.get('roles'), { keyEncoding: 'utf-8', valueEncoding: 'utf-8', extension: false }),
  }
}

// apply() is the SOLE writer of the view and must be deterministic. Validation /
// authority failures are no-ops (never throw); only genuine corruption throws.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const cmd = node.value
    const author = node.from && node.from.key // the writer that authored this block

    if (cmd.type === CMD.IMPORT_PHOTO) {
      // Any writer may import; a removed writer simply can't append new blocks.
      const p = cmd.photo
      if (!p || !p.blobsCoreKey) continue
      const key = photoKey(p.takenAt, p.name, disambiguator(p))
      if (await view.photos.get(key)) continue // idempotent
      await view.photos.put(key, p)
    } else if (cmd.type === CMD.SET_ROLE) {
      if (!author) continue
      if (cmd.role === ROLE.OWNER && b4a.equals(cmd.writerKey, author) && !(await hasOwner(view.roles))) {
        // Bootstrap: the FIRST writer claims ownership when no owner exists yet.
        // Deterministic (reads the replicated roles bee); safe because a founding
        // library has exactly one writer at claim time.
        await view.roles.put(roleKey(cmd.writerKey), ROLE.OWNER)
      } else if (await roleOf(view.roles, author) === ROLE.OWNER) {
        await view.roles.put(roleKey(cmd.writerKey), cmd.role)
      }
    } else if (cmd.type === CMD.ADD_WRITER) {
      // OWNER-only now (Ch5 let any writer add). Adding a writer also makes them
      // a member — access and role are granted together.
      const key = cmd.writerKey
      if (!key || key.byteLength !== 32) continue
      if (!author || await roleOf(view.roles, author) !== ROLE.OWNER) continue
      // Gate re-admission on OUR roles view, not host.system.has(): system.has() stays
      // true for REMOVED writers, so re-adding a revoked member would skip addWriter
      // and leave a phantom (role set, never writable again).
      if (!(await roleOf(view.roles, key))) await host.addWriter(key, { indexer: false })
      await view.roles.put(roleKey(key), ROLE.MEMBER)
    } else if (cmd.type === CMD.REMOVE_WRITER) {
      // Revocation — OWNER-only. Stops the member's FUTURE writes; their already-
      // shared photos remain, because the log is append-only (Inv-8: you can
      // revoke the future, never un-share the past). An owner can't be removed.
      const key = cmd.writerKey
      if (!key || key.byteLength !== 32) continue
      if (!author || await roleOf(view.roles, author) !== ROLE.OWNER) continue
      if (await roleOf(view.roles, key) === ROLE.OWNER) continue
      if (host.removeable(key)) {
        await host.removeWriter(key)
        await view.roles.del(roleKey(key))
      }
    }
  }
}

// --- roles ---
function roleKey (writerKey) { return b4a.toString(writerKey, 'hex') }
async function roleOf (roles, writerKey) { const n = await roles.get(roleKey(writerKey)); return n ? n.value : null }
async function hasOwner (roles) {
  for await (const { value } of roles.createReadStream()) if (value === ROLE.OWNER) return true
  return false
}

// A blob's GLOBALLY-unique address: which device's core + the byte offset in it.
function disambiguator (record) {
  return b4a.toString(record.blobsCoreKey, 'hex') + ':' + record.byteOffset
}

// Keys sort chronologically: an 8-byte BIG-ENDIAN capture-time prefix, then the
// name and the cross-writer disambiguator, null-separated.
function photoKey (takenAt, name, disambiguator) {
  const tail = name + '\x00' + disambiguator
  const key = b4a.alloc(8 + b4a.byteLength(tail))
  writeUint64BE(key, Math.max(0, takenAt), 0)
  b4a.write(key, tail, 8)
  return key
}

function writeUint64BE (buf, value, offset) {
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

module.exports = { CMD, ROLE, commandEncoding, openView, apply, photoKey, disambiguator, roleKey, roleOf, writeUint64BE }
