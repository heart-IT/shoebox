// Content-key rotation — the second, sharper meaning of "revoke" (Ch7 M3).
//
// The ALBUM key (identity.js) is MEMBERSHIP: it decrypts the replicated Autobase
// so you can see the library and take part. It never rotates — you can't un-admit
// someone from a log that's already on their disk. The CONTENT key is a separate,
// ROTATING secret that encrypts the browsable content of each photo (its thumbnail
// and its bytes). New photos use the current content key; on revocation the owner
// mints a fresh one and hands it only to the members who remain. A kicked member
// keeps the album key — they still see that the album exists — but never learns the
// new content key, so every photo added after the kick is redacted for them.
//
// Distribution is serverless: the new content key is SEALED (libsodium anonymous
// box) to each remaining member's X25519 public key and carried in the log. Only
// the holder of the matching secret key can open it; the removed member's copy is
// simply never written. Each device's box keypair is derived from its seed, a
// sibling of the primaryKey and album-key derivations, so it's recovery-ready.

const sodium = require('sodium-universal')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const NS_BOX = b4a.from('shoebox:member-box:v1') // domain-separate this derivation

// A device's X25519 "member box" keypair, derived from its 32-byte seed. The
// PUBLIC half is registered when the device joins (so an owner can seal to it);
// the SECRET half never leaves the device and opens keys sealed to it.
function memberBoxKeyFromSeed (seed) {
  const boxSeed = crypto.hash(b4a.concat([NS_BOX, seed])) // 32 bytes
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, boxSeed)
  return { publicKey, secretKey }
}

// A fresh 32-byte content key. Random (not seed-derived): a rotation must be
// unpredictable to a member who knows the seed-derived history.
function newContentKey () {
  return crypto.randomBytes(sodium.crypto_secretbox_KEYBYTES)
}

// Seal `message` to a member's box public key — anonymous (no sender identity),
// openable only by the matching secret key. Used to hand a content key to exactly
// one remaining member.
function sealTo (boxPublicKey, message) {
  const out = b4a.alloc(message.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, message, boxPublicKey)
  return out
}

// Open a sealed message with our own box keypair. Returns null if it wasn't sealed
// to us (so a device can try every sealed copy in a rotation and keep the one that
// opens).
function openSealed (sealed, boxKeyPair) {
  const out = b4a.alloc(sealed.byteLength - sodium.crypto_box_SEALBYTES)
  const ok = sodium.crypto_box_seal_open(out, sealed, boxKeyPair.publicKey, boxKeyPair.secretKey)
  return ok ? out : null
}

// Symmetric content encryption: nonce || secretbox. Encrypts a thumbnail or photo
// bytes under a content key. Returns null input → null (an un-thumbnailed photo).
function contentEncrypt (contentKey, plaintext) {
  if (plaintext == null) return null
  const nonce = crypto.randomBytes(sodium.crypto_secretbox_NONCEBYTES)
  const cipher = b4a.alloc(plaintext.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, plaintext, nonce, contentKey)
  return b4a.concat([nonce, cipher])
}

// Reverse of contentEncrypt. Returns null if the key is wrong or the box is
// corrupt — which is exactly what a removed member sees for post-rotation content.
function contentDecrypt (contentKey, box) {
  if (box == null || !contentKey) return null
  if (box.byteLength < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) return null
  const nonce = box.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
  const cipher = box.subarray(sodium.crypto_secretbox_NONCEBYTES)
  const out = b4a.alloc(cipher.byteLength - sodium.crypto_secretbox_MACBYTES)
  const ok = sodium.crypto_secretbox_open_easy(out, cipher, nonce, contentKey)
  return ok ? out : null
}

module.exports = { memberBoxKeyFromSeed, newContentKey, sealTo, openSealed, contentEncrypt, contentDecrypt }
