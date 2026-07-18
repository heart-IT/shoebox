// The Part 1 teaser, Part 3 edition: the index is now a Hyperbee keyed by
// capture-time, so "the latest photo" is the last entry in the tree, and the
// record decodes through the SAME Hyperschema the phone wrote it with.
// Usage: node peek.mjs <index-key> [out.jpg]
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import Hyperblobs from 'hyperblobs'
import { decode } from 'hypercore-id-encoding'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Reuse the phone's generated record codec — the schema is the shared contract.
const require = createRequire(import.meta.url)
const { resolveStruct } = require('../worker/spec')
const photoEncoding = resolveStruct('@shoebox/photo', 1)

const key = decode(process.argv[2])
const out = process.argv[3] ?? path.join(os.tmpdir(), 'shoebox-peek.jpg')

const store = new Corestore(path.join(os.tmpdir(), 'shoebox-peek-store'))
const swarm = new Hyperswarm()
swarm.on('connection', (conn) => store.replicate(conn))

const indexCore = store.get({ key, valueEncoding: 'binary' })
await indexCore.ready()
const bee = new Hyperbee(indexCore, { keyEncoding: 'binary', valueEncoding: photoEncoding })

const done = indexCore.findingPeers()
swarm.join(indexCore.discoveryKey, { client: true, server: false })
swarm.flush().then(done, done)

console.log('looking for your phone on the swarm…')
await bee.update({ wait: true })

const node = await bee.peek({ reverse: true }) // newest capture-time
if (!node) {
  console.error('found no photos — is the app running?')
  process.exit(1)
}

const record = node.value
const blobs = new Hyperblobs(store.get({ key: record.blobsCoreKey }))
const photo = await blobs.get({
  blockOffset: record.blockOffset,
  blockLength: record.blockLength,
  byteOffset: record.byteOffset,
  byteLength: record.blobByteLength,
})

fs.writeFileSync(out, photo)
console.log(`"${record.name}" (${photo.byteLength.toLocaleString()} bytes) → ${out}`)
await swarm.destroy()
