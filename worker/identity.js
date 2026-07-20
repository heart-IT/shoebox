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

module.exports = { primaryKeyFromSeed, loadOrCreateSeed }
