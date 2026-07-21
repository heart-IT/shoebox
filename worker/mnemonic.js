// The 24 words that ARE your library (audit AF-H5, CONSTRAINT-KEY-BACKUP).
//
// A device's whole identity is one 32-byte seed (identity.js): primaryKey →
// every core key → the Autobase writer key → the library key itself, plus the
// album key and the member box keypair. Until now that seed existed in exactly
// one place — a file on one phone — so losing the phone lost the library with
// no recovery path of any kind. This encodes the seed as a standard BIP39
// 24-word mnemonic a human can write on paper, and decodes it back.
//
// Restoring the seed on a fresh device reproduces the SAME primaryKey → the
// same local writer core → the same Autobase (library) key, so the recovered
// device IS the original founder and re-syncs its content from any peer or
// blind mirror that still holds it.
//
// Implemented directly on sodium's SHA-256 + the official English wordlist
// rather than pulling the `bip39` package: this module must load inside the
// Bare worklet, and sodium-universal is already a Bare-safe dependency. The
// smoke test cross-checks every vector against the real `bip39` (a devDep), so
// this is standards-conformant, not merely self-consistent.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const WORDLIST = require('./wordlist.json')
const { codedError } = require('./errors')

const INDEX = new Map(WORDLIST.map((w, i) => [w, i]))
const ENTROPY_BYTES = 32 // 256 bits → 8 checksum bits → 24 words

function sha256 (buf) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, buf)
  return out
}

// 32-byte seed → 24 space-separated words.
function mnemonicFromSeed (seed) {
  if (!seed || seed.byteLength !== ENTROPY_BYTES) throw codedError('EMNEMONIC', `mnemonic: expected a ${ENTROPY_BYTES}-byte seed`)
  let bits = ''
  for (const byte of seed) bits += byte.toString(2).padStart(8, '0')
  bits += sha256(seed)[0].toString(2).padStart(8, '0') // checksum: first 8 bits of SHA-256
  const words = []
  for (let i = 0; i < bits.length; i += 11) words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)])
  return words.join(' ')
}

// 24 words → the 32-byte seed. Throws (loudly, specifically) on anything that
// isn't a valid mnemonic — a typo must never silently yield a DIFFERENT but
// well-formed identity, which would look like "restored" and be a new, empty
// library. The checksum is what makes that impossible.
function seedFromMnemonic (mnemonic) {
  const words = String(mnemonic || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length !== 24) throw codedError('EMNEMONIC', `mnemonic: expected 24 words, got ${words.length}`)
  let bits = ''
  for (const w of words) {
    const idx = INDEX.get(w)
    if (idx === undefined) throw codedError('EMNEMONIC', `mnemonic: "${w}" is not a BIP39 word`)
    bits += idx.toString(2).padStart(11, '0')
  }
  const seed = b4a.alloc(ENTROPY_BYTES)
  for (let i = 0; i < ENTROPY_BYTES; i++) seed[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  const expected = sha256(seed)[0].toString(2).padStart(8, '0')
  if (bits.slice(ENTROPY_BYTES * 8) !== expected) throw codedError('EMNEMONIC', 'mnemonic: checksum failed — check the words and their order')
  return seed
}

module.exports = { mnemonicFromSeed, seedFromMnemonic }
