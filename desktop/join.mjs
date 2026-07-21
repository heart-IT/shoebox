// The SECOND DEVICE, Ch5+: a laptop that JOINS the library as a WRITER — not a
// read-only mirror like peek.mjs. It pairs with a one-time invite the phone
// shows, ships its own writer key + box key up during the blind-pairing
// handshake, and once the phone authorizes it (ADD_WRITER) its own Autobase
// flips to writable. "Your second device is an identity, not a copy."
//
// Audit AF-M7: this now runs the SAME pairAsCandidate() + Vault path the phone's
// JOIN uses, instead of a hand-rolled Ch5-era Autobase. Three fixes fall out of
// that: (1) the box keypair comes from a PERSISTED RANDOM seed, not a public
// repo constant (the old hardcoded seed let any reader unseal every rotated
// content key ever sealed to a desktop member); (2) imports are epoch-aware
// (the old demo wrote every photo at epoch 0, readable by kicked members —
// an Inv-9 bypass); (3) GRANT_KEYS and rotation are handled by the Vault, so a
// desktop member reads the album's full history correctly.
//
// Usage: node join.mjs <invite>   (identity persists in ~/.shoebox-desktop)
import { encode } from 'hypercore-id-encoding'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const { Vault, pairAsCandidate } = require('../worker/vault')
const { loadOrCreateSeed, primaryKeyFromSeed } = require('../worker/identity')
const { memberBoxKeyFromSeed } = require('../worker/rotation')

const invite = process.argv[2]
if (!invite) { console.error('usage: node join.mjs <invite>'); process.exit(1) }

// A STABLE desktop identity: one persisted random seed → primaryKey (writer
// identity) + box keypair (what rotated content keys get sealed to). Persisted
// so re-running join.mjs is the SAME device, and random so it's a real secret.
const storeDir = path.join(os.homedir(), '.shoebox-desktop')
fs.mkdirSync(storeDir, { recursive: true })
const seed = loadOrCreateSeed(fs, path.join(storeDir, 'seed'))
const primaryKey = primaryKeyFromSeed(seed)
const boxKeyPair = memberBoxKeyFromSeed(seed)
const vaultPath = path.join(storeDir, 'vault')

// (a) Pair: ship writerKey || boxKey up as userData; receive {library, album} keys.
console.log('pairing…')
const { libraryKey, encryptionKey } = await pairAsCandidate(vaultPath, { primaryKey, invite, boxKeyPair })
console.log('paired — library', encode(libraryKey).slice(0, 14) + '…')

// (b) Boot our OWN Vault on the delivered keys, on the SAME store — its writer
// key is already the one the owner admitted, and it decrypts the album, tracks
// rotations, and unseals any GRANT_KEYS the owner addressed to us.
const vault = new Vault(vaultPath, { primaryKey, bootstrap: encode(libraryKey), encryptionKey, boxKeyPair })
await vault.ready()
await vault.share()

// (c) Wait for write access — react to events, never poll. base.writable flips
// when the library's ADD_WRITER (naming our key) replicates in and applies.
if (!vault.base.writable) {
  console.log('waiting for the library to grant write access…')
  await new Promise((resolve) => {
    const onwritable = () => resolve()
    const onupdate = () => { if (vault.base.writable) { vault.base.off('update', onupdate); resolve() } }
    vault.base.on('writable', onwritable)
    vault.base.on('update', onupdate)
  })
}
console.log('✓ writable — this device is now a writer in the library')
vault.base.on('unwritable', () => console.log('✗ write access REVOKED by the owner — this device can no longer add photos'))

// (d) The payoff: read the merged view (already holds the phone's photos), then
// import a photo authored HERE — epoch-aware, so on a rotated album it lands
// under the CURRENT content key and a kicked member cannot read it.
const names = async () => (await vault.list({ limit: 100 })).map((p) => p.name)
console.log('this device sees from the phone:', (await names()).join(', ') || '(nothing yet)')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAdSm3AAAAAABJRU5ErkJggg==', 'base64')
await vault.importPhoto(PNG, { name: 'from-laptop.png', takenAt: Date.now(), thumb: '' })
console.log('imported "from-laptop.png" — the library now holds:', (await names()).join(', '))
console.log('→ on the phone: tap Show grid — from-laptop.png should appear (both devices, one library)')
// Stay alive so this import replicates to the phone. Ctrl-C when it appears.
