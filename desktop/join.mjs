// The SECOND DEVICE, Ch5: a laptop that JOINS the library as a WRITER — not a
// read-only mirror like peek.mjs. It pairs with a one-time invite the phone
// shows, ships its own writer key up during the blind-pairing handshake, and
// once the phone authorizes it (ADD_WRITER), its own Autobase flips to writable.
// "Your second device is an identity, not a copy": it has its OWN keypair and
// its OWN place in the writer set. Usage: node join.mjs <invite>
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Autobase from 'autobase'
import Hyperblobs from 'hyperblobs'
import BlindPairing from 'blind-pairing'
import { encode } from 'hypercore-id-encoding'
import z32 from 'z32'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const { CMD, commandEncoding, openView, apply } = require('../worker/library')

const invite = z32.decode(process.argv[2]) // z-base-32 of the variable-length invite
const store = new Corestore(path.join(os.tmpdir(), 'shoebox-join-store'))
const swarm = new Hyperswarm()

// (a) Our writer key BEFORE any Autobase exists — the same 'local' core the
// Autobase will adopt. It's opened exclusive, so close it before the base reopens
// it. This is the identity we ask the library to admit.
const local = Autobase.getLocalCore(store)
await local.ready()
const writerKey = local.key
await local.close()
console.log('this device →', encode(writerKey).slice(0, 14) + '…')

// (b) Pair: ship our writer key up as userData; the library key comes back.
const pairing = new BlindPairing(swarm, { poll: 5000 })
let libraryKey = null
const candidate = pairing.addCandidate({
  invite,
  userData: writerKey,
  onadd: (result) => { libraryKey = result.key }, // === the library's base.key
})
candidate.on('announce', () => console.log('announced to the library…'))
console.log('pairing…')
await candidate.pairing
if (!libraryKey) throw new Error('pairing rejected by the library')
console.log('paired — library', encode(libraryKey).slice(0, 14) + '…')

// (c) Boot our OWN Autobase from the library key, on the SAME store.
const base = new Autobase(store, libraryKey, {
  open: openView, apply, valueEncoding: commandEncoding, ackInterval: 1000,
})
await base.ready()

// Replicate: attach the handler AND replicate connections that already formed
// during pairing (they would otherwise be missed).
swarm.on('connection', (conn) => base.replicate(conn))
for (const conn of swarm.connections) base.replicate(conn)
swarm.join(base.discoveryKey, { server: true, client: true })

// (d) Wait for write access — react to events, never poll. writable flips when
// the library's ADD_WRITER (naming our key) replicates in and applies.
if (!base.writable) {
  console.log('waiting for the library to grant write access…')
  await new Promise((resolve) => {
    const onwritable = () => resolve()
    const onupdate = () => { if (base.writable) { base.off('update', onupdate); resolve() } }
    base.on('writable', onwritable)
    base.on('update', onupdate)
  })
}
await pairing.close() // pairing done; keep the swarm + base alive to stay in sync

console.log('✓ writable — this device is now a writer in the library')

// ---- Ch5 M4: the payoff. Import a photo authored HERE; it converges to the
// phone. And read the merged view — it already holds the phone's photos too.
async function libraryNames () {
  await base.update()
  const out = []
  for await (const { value } of base.view.createReadStream({ reverse: true })) out.push(value.name)
  return out
}

console.log('this device sees from the phone:', (await libraryNames()).join(', ') || '(nothing yet)')

// Bytes → this device's OWN blobs core; a pointer command → the shared log.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAdSm3AAAAAABJRU5ErkJggg==', 'base64')
const blobsCore = store.get({ name: 'photo-blobs' })
await blobsCore.ready()
const blobs = new Hyperblobs(blobsCore)
const id = await blobs.put(PNG)
await base.append({
  type: CMD.IMPORT_PHOTO,
  photo: {
    name: 'from-laptop.png', takenAt: Date.now(), mime: 'image/png', byteLength: PNG.byteLength,
    blobsCoreKey: blobsCore.key, blockOffset: id.blockOffset, blockLength: id.blockLength,
    byteOffset: id.byteOffset, blobByteLength: id.byteLength,
    width: 0, height: 0, orientation: 0, thumb: '', dhash: '', embedding: null,
  },
})
await base.update()
console.log('imported "from-laptop.png" — the library now holds:', (await libraryNames()).join(', '))
console.log('→ on the phone: tap Show grid — from-laptop.png should appear (both devices, one library)')
// Stay alive so this import replicates to the phone (the process is kept open by
// the swarm + base handles). Ctrl-C when the phone shows the photo.
