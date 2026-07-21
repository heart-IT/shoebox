// A device's identity is a 32-byte SEED. From it we derive the Corestore primary
// key, and from THAT every core the device owns — including its Autobase writer
// key. So one backed-up seed restores the whole device's identity: same seed →
// same primary key → same writer key. Here the seed is generated once and
// persisted beside the vault; the mnemonic that would back it up (24 words a
// human can write down) and the platform keychain that would guard it are a
// later chapter. Deriving the primary key from a seed NOW — even a random one —
// is the "day one" move that keeps that later chapter a non-breaking upgrade.

const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const NS = b4a.from('shoebox:corestore:v1') // domain-separate this derivation

// primaryKey = H(namespace || seed). Deterministic, so the device's keys are a
// pure function of its seed — the property recovery stands on.
function primaryKeyFromSeed (seed) {
  return crypto.hash(b4a.concat([NS, seed]))
}

const NS_ENC = b4a.from('shoebox:album-enc:v1')

// The album's 32-byte ENCRYPTION key, derived from the founder's seed. The log,
// the views, and the photo bytes are all encrypted with it; only peers who hold
// it can read. Members receive it through pairing — they can't derive it, it's
// the founder's secret. Re-deriving from the seed reopens the vault. A DIFFERENT
// namespace than the primary key so the two never coincide.
function encryptionKeyFromSeed (seed) {
  return crypto.hash(b4a.concat([NS_ENC, seed]))
}

// Read a file if it EXISTS; return null only for a genuinely-missing file.
// Audit AF-M12: a real read error (permissions, IO) must NOT be mistaken for
// "first boot" — that path mints a new identity and would overwrite/abandon the
// real one. A missing file surfaces as ENOENT (or a code-less error on hosts
// that don't set one); anything else re-throws.
function readIfExists (fs, p) {
  try {
    return fs.readFileSync(p)
  } catch (err) {
    if (err && err.code && err.code !== 'ENOENT') throw err
    return null
  }
}

// Atomic write (AF-M12): write a temp file then rename, so a crash or disk-full
// mid-write can never leave a truncated seed/membership that the next boot
// silently treats as first-boot. Owner-only perms best-effort (AF-H5 partial —
// the platform keychain + mnemonic backup remain the real at-rest story).
function writeFileAtomic (fs, filePath, data) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data)
  try { if (fs.chmodSync) fs.chmodSync(tmp, 0o600) } catch { /* host may not support mode; keychain is the real fix */ }
  fs.renameSync(tmp, filePath)
}

// Read the device seed, or mint one on first boot. `fs` is injected (bare-fs on
// the phone, node:fs in tests) so this stays host-agnostic like the rest of the
// worker core. A present-but-wrong-length seed is CORRUPT and fatal (AF-M12):
// silently re-minting would abandon the whole store under a new identity.
function loadOrCreateSeed (fs, seedPath) {
  const buf = readIfExists(fs, seedPath)
  if (buf) {
    if (buf.byteLength !== 32) throw new Error(`seed file is corrupt (${buf.byteLength} bytes, expected 32) — refusing to overwrite the device identity. Restore from backup, or delete ${seedPath} to start fresh.`)
    return buf
  }
  const seed = crypto.randomBytes(32)
  writeFileAtomic(fs, seedPath, seed)
  return seed
}

// A JOINED device persists the two keys it received through pairing — the library
// key (which library to open) and the album key (how to decrypt it). Unlike the
// founder, a joiner can't derive either from its seed: they're the founder's
// secret, handed over once in the sealed pairing confirm. So a joiner writes them
// beside its seed and reopens the vault as a member on every later boot instead of
// re-founding an empty one. The device's writer identity (primaryKey → writer key)
// still comes from the seed; only these two delivered keys need saving.
//
// 64 bytes on disk: libraryKey (32) || albumKey (32). Its mere presence is the
// device's role — file exists → joiner, absent → founder.
function saveMembership (fs, membershipPath, { libraryKey, albumKey }) {
  writeFileAtomic(fs, membershipPath, b4a.concat([libraryKey, albumKey]))
}

function loadMembership (fs, membershipPath) {
  const buf = readIfExists(fs, membershipPath)
  if (!buf) return null // genuinely absent → this device is a founder
  // Present-but-wrong-length is CORRUPT and fatal (AF-M12): the delivered keys
  // are the founder's secret and NOT re-derivable, so silently booting as a
  // fresh founder over the joiner's store would strand the joined library.
  if (buf.byteLength !== 64) throw new Error(`membership file is corrupt (${buf.byteLength} bytes, expected 64) — the delivered album keys are unrecoverable. Restore from backup, or delete ${membershipPath} to re-pair this device.`)
  return { libraryKey: buf.subarray(0, 32), albumKey: buf.subarray(32, 64) }
}

// Overwrite the device seed (AF-H5 restore-from-mnemonic). Atomic + owner-only
// like every other artifact. Callers must have established there's nothing to
// lose — the local store's cores derive from the OLD seed.
function saveSeed (fs, seedPath, seed) {
  if (!seed || seed.byteLength !== 32) throw new Error('saveSeed: expected a 32-byte seed')
  writeFileAtomic(fs, seedPath, seed)
}

// Blind-mirror keys (AF-M2), one z32 per line, atomic + owner-only like the
// rest. A corrupt/garbled mirror file is NON-fatal — mirrors are re-addable, so
// unreadable lines are simply skipped (the caller validates each z32).
function loadMirrors (fs, mirrorPath) {
  const buf = readIfExists(fs, mirrorPath)
  if (!buf) return []
  return b4a.toString(buf, 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean)
}

function saveMirrors (fs, mirrorPath, z32keys) {
  writeFileAtomic(fs, mirrorPath, b4a.from(z32keys.join('\n'), 'utf-8'))
}

module.exports = { primaryKeyFromSeed, encryptionKeyFromSeed, loadOrCreateSeed, saveSeed, saveMembership, loadMembership, loadMirrors, saveMirrors }
