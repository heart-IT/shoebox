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

// Read the device seed, or mint one on first boot. `fs` is injected (bare-fs on
// the phone, node:fs in tests) so this stays host-agnostic like the rest of the
// worker core.
function loadOrCreateSeed (fs, seedPath) {
  try {
    const seed = fs.readFileSync(seedPath)
    if (seed && seed.byteLength === 32) return seed
  } catch { /* first boot — mint one below */ }
  const seed = crypto.randomBytes(32)
  fs.writeFileSync(seedPath, seed)
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
  fs.writeFileSync(membershipPath, b4a.concat([libraryKey, albumKey]))
}

function loadMembership (fs, membershipPath) {
  try {
    const buf = fs.readFileSync(membershipPath)
    if (buf && buf.byteLength === 64) {
      return { libraryKey: buf.subarray(0, 32), albumKey: buf.subarray(32, 64) }
    }
  } catch { /* no membership file — this device is a founder */ }
  return null
}

module.exports = { primaryKeyFromSeed, encryptionKeyFromSeed, loadOrCreateSeed, saveMembership, loadMembership }
