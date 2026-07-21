// The desktop peer, Ch5 edition: the index is no longer one Hyperbee but an
// AUTOBASE, so peek bootstraps from the LIBRARY key (base.key) and replicates
// the whole library — every writer's log, the linearized view, and the blob
// cores. It runs the SAME apply()/open() as the phone (imported from the worker),
// so its view converges byte for byte. Read-only: it never addWriter's itself.
//
// Ch7 note: the album is ENCRYPTED. Without the album key this peer still
// replicates every block — but as ciphertext, so its view stays EMPTY. That is
// the point of the chapter: the album is private to key-holders. Pass the album
// key (64-hex) to actually read it.
//
// Audit AF-M7: peek holds ONLY the album key (= the epoch-0 content key). After
// a revocation the album rotates, and post-rotation photos are sealed under a
// CONTENT key peek never receives (that needs a paired member's box keypair).
// So peek reads the newest EPOCH-0 photo it can actually decrypt, and says so
// if it had to skip rotated ones — instead of writing garbage bytes that the
// album key "decrypts" into noise.
// Usage: node peek.mjs <library-key> [album-key-hex] [out.jpg]
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Autobase from 'autobase'
import Hyperblobs from 'hyperblobs'
import { decode } from 'hypercore-id-encoding'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The library contract — the deterministic apply()/open()/wire the phone wrote
// its commands with. Sharing this module is what makes the views identical.
const require = createRequire(import.meta.url)
const { commandEncoding, openView, apply, discoveryTopic } = require('../worker/library')

const key = decode(process.argv[2]) // the LIBRARY key (base.key), not a core key
// A 64-hex album key decrypts the view + blobs; anything else is treated as the
// output path (so `peek <key> out.jpg` still works for an UNENCRYPTED library).
const maybeKey = process.argv[3]
const isAlbumKey = maybeKey && /^[0-9a-fA-F]{64}$/.test(maybeKey)
const encryptionKey = isAlbumKey ? Buffer.from(maybeKey, 'hex') : null
const out = (isAlbumKey ? process.argv[4] : process.argv[3]) ?? path.join(os.tmpdir(), 'shoebox-peek.jpg')

// A UNIQUE store dir per run (AF-L): a fixed tmpdir path let two concurrent
// peeks contend on one RocksDB lock.
const store = new Corestore(fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-peek-')))
const swarm = new Hyperswarm()

const base = new Autobase(store, key, {
  open: openView, apply, valueEncoding: commandEncoding,
  ...(encryptionKey ? { encryptionKey } : {}), // decrypt the album (Ch7)
})
await base.ready()

// base.replicate attaches the wakeup protocol (store.replicate alone would never
// learn which writers advanced). Join as a client — we consume, we don't announce.
swarm.on('connection', (conn) => { conn.on('error', () => {}); base.replicate(conn) })
// Ch10: an encrypted album's members meet on a topic derived from the ALBUM
// key. Without it we fall back to the classic discoveryKey — where, since Ch10,
// nobody announces an encrypted library anymore.
swarm.join(discoveryTopic(base, encryptionKey), { client: true, server: false })

console.log(encryptionKey
  ? 'looking for your library on the swarm (with the album key)…'
  : 'looking for your library on the swarm (no album key — an encrypted album is not even FINDABLE on this topic since Ch10)…')

// Sync the log and rebuild the view. base.update() fetches what's AVAILABLE, so
// we loop — each pass gives replication a real event-loop turn to deliver blocks.
// We want the newest DECRYPTABLE photo: with only the album key that means
// epoch 0 (or any epoch for an unencrypted library). Rotated photos are counted
// but skipped — peek can't unseal their content key.
const deadline = Date.now() + 45000
let node = null
let skippedRotated = 0
while (Date.now() < deadline) {
  await base.update()
  skippedRotated = 0
  for await (const item of base.view.photos.createReadStream({ reverse: true })) {
    if (encryptionKey && (item.value.epoch || 0) > 0) { skippedRotated++; continue } // post-rotation → not decryptable here
    node = item
    break
  }
  if (node) break
  await new Promise((r) => setTimeout(r, 100))
}

if (!node) {
  if (encryptionKey && skippedRotated > 0) {
    console.error(`this album has ROTATED: ${skippedRotated} photo(s) are sealed under a content key peek doesn't hold (that needs a paired member device). No epoch-0 photo to display.`)
  } else {
    console.error(encryptionKey
      ? 'found no photos — is a device online and sharing the library?'
      : 'found no photos — the album is likely ENCRYPTED. Re-run with the album key: node peek.mjs <library-key> <album-key-hex>. (Or no device is online.)')
  }
  process.exit(1)
}
if (skippedRotated > 0) console.log(`(skipped ${skippedRotated} post-rotation photo(s) peek can't decrypt — showing the newest epoch-0 photo)`)

const record = node.value
const blobs = new Hyperblobs(store.get(encryptionKey
  ? { key: record.blobsCoreKey, encryptionKey }
  : { key: record.blobsCoreKey })) // whichever device authored it
const photo = await blobs.get({
  blockOffset: record.blockOffset,
  blockLength: record.blockLength,
  byteOffset: record.byteOffset,
  byteLength: record.blobByteLength,
})

fs.writeFileSync(out, photo)
console.log(`"${record.name}" (${photo.byteLength.toLocaleString()} bytes) → ${out}`)
await swarm.destroy()
await base.close()
