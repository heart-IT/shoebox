// The desktop peer, Ch5 edition: the index is no longer one Hyperbee but an
// AUTOBASE, so peek bootstraps from the LIBRARY key (base.key) and replicates
// the whole library — every writer's log, the linearized view, and the blob
// cores. It runs the SAME apply()/open() as the phone (imported from the worker),
// so its view converges byte for byte. Read-only: it never addWriter's itself.
// Usage: node peek.mjs <library-key> [out.jpg]
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
const { commandEncoding, openView, apply } = require('../worker/library')

const key = decode(process.argv[2]) // the LIBRARY key (base.key), not a core key
const out = process.argv[3] ?? path.join(os.tmpdir(), 'shoebox-peek.jpg')

const store = new Corestore(path.join(os.tmpdir(), 'shoebox-peek-store'))
const swarm = new Hyperswarm()

const base = new Autobase(store, key, { open: openView, apply, valueEncoding: commandEncoding })
await base.ready()

// base.replicate attaches the wakeup protocol (store.replicate alone would never
// learn which writers advanced). Join as a client — we consume, we don't announce.
swarm.on('connection', (conn) => base.replicate(conn))
swarm.join(base.discoveryKey, { client: true, server: false })

console.log('looking for your library on the swarm…')

// Sync the log and rebuild the view. base.update() fetches what's AVAILABLE, so
// we loop — each pass gives replication a real event-loop turn to deliver blocks.
const deadline = Date.now() + 45000
let node = null
while (Date.now() < deadline) {
  await base.update()
  node = await base.view.photos.peek({ reverse: true }) // newest capture-time
  if (node) break
  await new Promise((r) => setTimeout(r, 100))
}

if (!node) {
  console.error('found no photos — is a device online and sharing the library?')
  process.exit(1)
}

const record = node.value
const blobs = new Hyperblobs(store.get({ key: record.blobsCoreKey })) // whichever device authored it
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
