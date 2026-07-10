// The Part 1 teaser: twenty-some lines you can't read yet.
// Usage: node peek.mjs <index-key> [out.jpg]
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import { decode } from 'hypercore-id-encoding'
import fs from 'fs'
import os from 'os'
import path from 'path'

const key = decode(process.argv[2])
const out = process.argv[3] ?? path.join(os.tmpdir(), 'shoebox-peek.jpg')

const store = new Corestore(path.join(os.tmpdir(), 'shoebox-peek-store'))
const swarm = new Hyperswarm()
swarm.on('connection', (conn) => store.replicate(conn))

const index = store.get({ key, valueEncoding: 'json' })
await index.ready()

const done = index.findingPeers()
swarm.join(index.discoveryKey, { client: true, server: false })
swarm.flush().then(done, done)

console.log('looking for your phone on the swarm…')
await index.update()
if (index.length === 0) {
  console.error('found no photos — is the app running?')
  process.exit(1)
}

const record = await index.get(index.length - 1)
const blobs = new Hyperblobs(store.get({ key: Buffer.from(record.blobsCoreKey, 'hex') }))
const photo = await blobs.get(record.blobId)

fs.writeFileSync(out, photo)
console.log(`"${record.name}" (${photo.byteLength.toLocaleString()} bytes) → ${out}`)
await swarm.destroy()
