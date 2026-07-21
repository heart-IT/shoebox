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
const crypto = require('hypercore-crypto')
const { resolveStruct } = require('./spec')

// The photo record is the generated Hyperschema struct (compact-encoding) at the
// CURRENT schema version — v2 adds the optional `epoch` field (Ch7 M3). Older
// records (v1, no epoch) still decode: the flag bit is simply absent → epoch 0.
const photoEncoding = resolveStruct('@shoebox/photo')

// Commands on the log are a tagged union: a uint type, then the payload.
// Types are load-bearing wire ids — append only, never renumber.
const CMD = { IMPORT_PHOTO: 1, ADD_WRITER: 2, SET_ROLE: 3, REMOVE_WRITER: 4, ROTATE_KEY: 5, GRANT_KEYS: 6 }

const EMPTY = b4a.alloc(0)

// Roles are the album's authority model. The founder is the OWNER; invited
// people are MEMBERS. Owners manage membership; members add photos.
const ROLE = { OWNER: 'owner', MEMBER: 'member' }

const commandEncoding = {
  preencode (state, cmd) {
    c.uint.preencode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.preencode(state, cmd.photo)
    // ADD_WRITER carries the joiner's box public key (Ch7 M3) so the owner can
    // seal rotated content keys to it. A length-prefixed buffer — empty when a
    // caller (Ch5/Ch6, unencrypted) adds a writer without one.
    else if (cmd.type === CMD.ADD_WRITER) { c.fixed32.preencode(state, cmd.writerKey); c.buffer.preencode(state, cmd.boxKey || EMPTY) }
    else if (cmd.type === CMD.REMOVE_WRITER) c.fixed32.preencode(state, cmd.writerKey)
    else if (cmd.type === CMD.SET_ROLE) { c.fixed32.preencode(state, cmd.writerKey); c.string.preencode(state, cmd.role) }
    else if (cmd.type === CMD.ROTATE_KEY) { c.uint.preencode(state, cmd.epoch); c.uint.preencode(state, cmd.entries.length); for (const e of cmd.entries) { c.fixed32.preencode(state, e.writerKey); c.buffer.preencode(state, e.sealed) } }
    // GRANT_KEYS (Ch10 M1): sealed copies of EXISTING epochs' content keys for one
    // late-joining member — { writerKey, entries: [{ epoch, sealed }] }.
    else if (cmd.type === CMD.GRANT_KEYS) { c.fixed32.preencode(state, cmd.writerKey); c.uint.preencode(state, cmd.entries.length); for (const e of cmd.entries) { c.uint.preencode(state, e.epoch); c.buffer.preencode(state, e.sealed) } }
  },
  encode (state, cmd) {
    c.uint.encode(state, cmd.type)
    if (cmd.type === CMD.IMPORT_PHOTO) photoEncoding.encode(state, cmd.photo)
    else if (cmd.type === CMD.ADD_WRITER) { c.fixed32.encode(state, cmd.writerKey); c.buffer.encode(state, cmd.boxKey || EMPTY) }
    else if (cmd.type === CMD.REMOVE_WRITER) c.fixed32.encode(state, cmd.writerKey)
    else if (cmd.type === CMD.SET_ROLE) { c.fixed32.encode(state, cmd.writerKey); c.string.encode(state, cmd.role) }
    else if (cmd.type === CMD.ROTATE_KEY) { c.uint.encode(state, cmd.epoch); c.uint.encode(state, cmd.entries.length); for (const e of cmd.entries) { c.fixed32.encode(state, e.writerKey); c.buffer.encode(state, e.sealed) } }
    else if (cmd.type === CMD.GRANT_KEYS) { c.fixed32.encode(state, cmd.writerKey); c.uint.encode(state, cmd.entries.length); for (const e of cmd.entries) { c.uint.encode(state, e.epoch); c.buffer.encode(state, e.sealed) } }
  },
  decode (state) {
    const type = c.uint.decode(state)
    if (type === CMD.IMPORT_PHOTO) return { type, photo: photoEncoding.decode(state) }
    if (type === CMD.ADD_WRITER) { const writerKey = c.fixed32.decode(state); const bk = c.buffer.decode(state); return { type, writerKey, boxKey: bk && bk.byteLength === 32 ? bk : null } }
    if (type === CMD.REMOVE_WRITER) return { type, writerKey: c.fixed32.decode(state) }
    if (type === CMD.SET_ROLE) return { type, writerKey: c.fixed32.decode(state), role: c.string.decode(state) }
    if (type === CMD.ROTATE_KEY) { const epoch = c.uint.decode(state); const n = c.uint.decode(state); const entries = []; for (let i = 0; i < n; i++) entries.push({ writerKey: c.fixed32.decode(state), sealed: c.buffer.decode(state) }); return { type, epoch, entries } }
    if (type === CMD.GRANT_KEYS) { const writerKey = c.fixed32.decode(state); const n = c.uint.decode(state); const entries = []; for (let i = 0; i < n; i++) entries.push({ epoch: c.uint.decode(state), sealed: c.buffer.decode(state) }); return { type, writerKey, entries } }
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
    // Ch7 M3. members: writer-key hex → box public-key hex (so the owner can seal
    // rotated content keys to each member). rotations: epoch → the sealed content
    // keys for that epoch, one per member who held access when it was minted.
    members: new Hyperbee(store.get('members'), { keyEncoding: 'utf-8', valueEncoding: 'utf-8', extension: false }),
    rotations: new Hyperbee(store.get('rotations'), { keyEncoding: 'binary', valueEncoding: 'utf-8', extension: false }),
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
      // Bind the key to the AUTHORING writer (autobase-attested, not record-supplied)
      // so a member can't shadow another member's photo by reusing their
      // blobsCoreKey+byteOffset: a forgery keys under the forger's own identity.
      const key = photoKey(p.takenAt, p.name, disambiguator(p, author))
      if (await view.photos.get(key)) continue // idempotent
      await view.photos.put(key, p)
    } else if (cmd.type === CMD.SET_ROLE) {
      if (!author) continue
      // Audit AF (latent): only ever write a KNOWN role. An owner appending a
      // garbage or second-owner role can't corrupt the authority model — the
      // bootstrap self-claim below is the ONLY path that mints an owner, and it
      // fires just once (guarded by hasOwner). A second owner would enable the
      // concurrent-rotation epoch collision AF-M4's write-once guard defends.
      if (cmd.role === ROLE.OWNER && b4a.equals(cmd.writerKey, author) && !(await hasOwner(view.roles))) {
        // Bootstrap: the FIRST writer claims ownership when no owner exists yet.
        // Deterministic (reads the replicated roles bee); safe because a founding
        // library has exactly one writer at claim time.
        await view.roles.put(roleKey(cmd.writerKey), ROLE.OWNER)
      } else if (cmd.role === ROLE.MEMBER && await roleOf(view.roles, author) === ROLE.OWNER) {
        // An owner may set MEMBER (only) on another writer — never mint a second
        // owner or an unknown role through the normal path.
        await view.roles.put(roleKey(cmd.writerKey), ROLE.MEMBER)
      }
    } else if (cmd.type === CMD.ADD_WRITER) {
      // OWNER-only now (Ch5 let any writer add). Adding a writer also makes them
      // a member — access and role are granted together.
      const key = cmd.writerKey
      if (!key || key.byteLength !== 32) continue
      if (!author || await roleOf(view.roles, author) !== ROLE.OWNER) continue
      const existing = await roleOf(view.roles, key)
      if (existing === ROLE.OWNER) continue // already the owner — never demote to member
      // Gate re-admission on OUR roles view, NOT host.system.has(): system.has()
      // returns true for REMOVED writers, so re-adding a revoked member would skip
      // addWriter and leave a phantom — role set, but never writable again.
      if (!existing) await host.addWriter(key, { indexer: false })
      await view.roles.put(roleKey(key), ROLE.MEMBER)
      // Register the member's box public key so the owner can seal rotated content
      // keys to it (Ch7 M3). Absent for a Ch5/Ch6 (unencrypted) add.
      if (cmd.boxKey) await view.members.put(roleKey(key), b4a.toString(cmd.boxKey, 'hex'))
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
        await view.members.del(roleKey(key)) // drop their box key from the roster
      }
    } else if (cmd.type === CMD.ROTATE_KEY) {
      // Content-key rotation — OWNER-only (Ch7 M3). Records the new epoch's content
      // key, individually SEALED to each remaining member's box key, so a member can
      // find and open its own copy. A removed member simply has no entry here, so the
      // photos encrypted under this epoch stay redacted for them forever.
      if (!author || await roleOf(view.roles, author) !== ROLE.OWNER) continue
      // Write-once (audit AF-M4): a rotations row is never overwritten. Two
      // concurrent kicks (or a partitioned second owner) that both mint the same
      // epoch with different keys must not clobber the first — some member may
      // already hold it, and photos tagged that epoch would become permanently
      // undecryptable. First ROTATE_KEY for an epoch wins; a duplicate is dropped.
      if (await view.rotations.get(epochKey(cmd.epoch))) continue
      const sealed = {}
      for (const e of cmd.entries) sealed[roleKey(e.writerKey)] = b4a.toString(e.sealed, 'hex')
      await view.rotations.put(epochKey(cmd.epoch), JSON.stringify(sealed))
    } else if (cmd.type === CMD.GRANT_KEYS) {
      // Late-joiner unlock — OWNER-only (Ch10 M1). Adds one member's sealed copy of
      // an EXISTING epoch's content key to that epoch's rotation row, so a device
      // admitted after a rotation can still open the album's full history. Gates:
      // the target must already be on the roster (a grant admits nobody), an
      // unknown epoch is skipped (a grant can't invent history), and a copy that
      // exists is never overwritten (first write wins — a kicked-then-reinvited
      // member's grants arrive as NEW writes, never as silent replacements).
      if (!author || await roleOf(view.roles, author) !== ROLE.OWNER) continue
      const key = cmd.writerKey
      if (!key || key.byteLength !== 32) continue
      if (!(await roleOf(view.roles, key))) continue
      for (const e of cmd.entries) {
        const node = await view.rotations.get(epochKey(e.epoch))
        if (!node) continue
        const sealed = JSON.parse(node.value)
        const hex = roleKey(key)
        if (sealed[hex]) continue
        sealed[hex] = b4a.toString(e.sealed, 'hex')
        await view.rotations.put(epochKey(e.epoch), JSON.stringify(sealed))
      }
    }
  }
}

// --- discovery (Ch10 M2) ---
// The swarm topic members actually meet on. An ENCRYPTED album derives it from
// the ALBUM key (domain-separated hash) — the library key is the shareable
// identifier, and `discoveryKey(libraryKey)` is a public derivation, so joining
// on it hands every library-key holder the members' IP addresses. Deriving from
// the album key makes finding the members require the same secret as reading
// them. Unencrypted libraries keep the classic core discoveryKey. (Blind
// mirrors are unaffected either way — they're dialed directly by key.)
const NS_TOPIC = b4a.from('shoebox:album-topic:v1')
function discoveryTopic (base, encryptionKey) {
  return encryptionKey ? crypto.hash(b4a.concat([NS_TOPIC, encryptionKey])) : base.discoveryKey
}

// --- roles ---
function roleKey (writerKey) { return b4a.toString(writerKey, 'hex') }
async function roleOf (roles, writerKey) { const n = await roles.get(roleKey(writerKey)); return n ? n.value : null }
async function hasOwner (roles) {
  for await (const { value } of roles.createReadStream()) if (value === ROLE.OWNER) return true
  return false
}

// --- content-key epochs (Ch7 M3) ---
// Epochs key the `rotations` bee big-endian so peek({reverse}) is the latest.
function epochKey (n) { const b = b4a.alloc(4); b[0] = (n >>> 24) & 0xff; b[1] = (n >>> 16) & 0xff; b[2] = (n >>> 8) & 0xff; b[3] = n & 0xff; return b }
function readEpoch (buf) { return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0 }

// The album's current content epoch: the highest rotation recorded, or 0 (genesis,
// no rotation yet). Every import tags its photo with this so reads know which key.
async function currentEpoch (view) {
  const node = await view.rotations.peek({ reverse: true })
  return node ? readEpoch(node.key) : 0
}

// The sealed content keys for an epoch: { writerKeyHex: sealedHex }. A device finds
// its own entry by its writer key and opens it with its box secret key.
async function sealedKeysFor (view, epoch) {
  const node = await view.rotations.get(epochKey(epoch))
  return node ? JSON.parse(node.value) : null
}

// Every current member's box public key: [{ writerKeyHex, boxKey }]. What the owner
// seals a fresh content key to on rotation.
async function memberBoxKeys (view) {
  const out = []
  for await (const { key, value } of view.members.createReadStream()) out.push({ writerKeyHex: key, boxKey: b4a.from(value, 'hex') })
  return out
}

// A blob's GLOBALLY-unique, forgery-resistant address: the AUTHORING writer +
// which device's core + the byte offset in it. The author is attested by autobase
// (node.from.key), not taken from the record, so a member can't mint a key that
// collides with another member's genuine photo.
function disambiguator (record, author) {
  const who = author ? b4a.toString(author, 'hex') : ''
  return who + ':' + b4a.toString(record.blobsCoreKey, 'hex') + ':' + record.byteOffset
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

module.exports = { CMD, ROLE, commandEncoding, openView, apply, photoKey, disambiguator, roleKey, roleOf, epochKey, readEpoch, currentEpoch, sealedKeysFor, memberBoxKeys, discoveryTopic, writeUint64BE }
