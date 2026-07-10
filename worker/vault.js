// Host-agnostic vault core. Runs unchanged under Bare (worklet) and Node (tests,
// desktop mirror). Platform modules are injected or lazily required — never
// required at top level (Bare.* globals only exist at runtime).

const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const BlobServer = require('hypercore-blob-server')
const Hyperswarm = require('hyperswarm')
const idEncoding = require('hypercore-id-encoding')
const b4a = require('b4a')

class Vault {
  constructor (storagePath) {
    this.store = new Corestore(storagePath)
    // Two cores, per Inv-1: bytes live in the blobs core; the index core
    // persists pointers. A "photo" is an index record, never inline bytes.
    this.index = this.store.get({ name: 'photo-index', valueEncoding: 'json' })
    this.blobsCore = this.store.get({ name: 'photo-blobs' })
    this.blobs = null
    this.server = null
    this.swarm = null
  }

  async ready () {
    await this.index.ready()
    await this.blobsCore.ready()
    this.blobs = new Hyperblobs(this.blobsCore)

    this.server = new BlobServer(this.store)
    await this.server.listen()
  }

  // Announce the index core so a remote peer (the peek script) can replicate.
  async share () {
    if (this.swarm) return
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn) => this.store.replicate(conn))
    this.swarm.join(this.index.discoveryKey, { server: true, client: false })
    await this.swarm.flush()
  }

  async importPhoto (buffer, name) {
    const blobId = await this.blobs.put(buffer)
    await this.index.append({
      name,
      blobId,
      blobsCoreKey: b4a.toString(this.blobsCore.key, 'hex'),
      byteLength: buffer.byteLength,
      importedAt: Date.now()
    })
    return {
      link: this.link(blobId),
      indexKey: idEncoding.encode(this.index.key),
      seq: this.index.length - 1
    }
  }

  link (blobId) {
    return this.server.getLink(this.blobsCore.key, { blob: blobId })
  }

  async count () {
    return this.index.length
  }

  async close () {
    if (this.swarm) await this.swarm.destroy()
    if (this.server) await this.server.close()
    await this.store.close()
  }
}

module.exports = { Vault }
