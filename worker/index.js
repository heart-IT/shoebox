/* global Bare, BareKit */
// Worklet entry. Synchronous by contract — no top-level await (rn-bare-kit#1);
// async work lives in main(). IPC is an unframed byte stream by design
// (rn-bare-kit#10), so both ends speak framed-stream.

const FramedStream = require('framed-stream')
const b4a = require('b4a')
const { Vault } = require('./vault')

const stream = new FramedStream(BareKit.IPC)

let vault = null

main().catch((err) => send({ type: 'error', message: String((err && err.stack) || err) }))

async function main () {
  // Lazy platform requires: Bare builtins resolve at runtime, and vault.js
  // stays loadable under Node for tests and the desktop mirror.
  const os = require('bare-os')
  const path = require('bare-path')

  const base = Bare.argv[0] || os.tmpdir()
  vault = new Vault(path.join(base, 'shoebox-vault'))
  await vault.ready()

  stream.on('data', (data) => {
    handle(JSON.parse(b4a.toString(data))).catch((err) =>
      send({ type: 'error', message: String((err && err.stack) || err) })
    )
  })

  send({ type: 'ready', photos: await vault.count() })
}

async function handle (msg) {
  switch (msg.type) {
    case 'import': {
      const result = await vault.importPhoto(b4a.from(msg.dataBase64, 'base64'), msg.name)
      await vault.share() // announce on the swarm so peek.mjs can find us
      send({ type: 'imported', ...result })
      break
    }
    case 'suspend': {
      if (vault.swarm) await vault.swarm.suspend()
      break
    }
    case 'resume': {
      if (vault.swarm) await vault.swarm.resume()
      break
    }
    default:
      send({ type: 'error', message: `unknown command: ${msg.type}` })
  }
}

function send (msg) {
  stream.write(b4a.from(JSON.stringify(msg)))
}
