/* global Bare, BareKit */
// Worklet entry. Synchronous by contract — no top-level await (rn-bare-kit#1);
// async work lives in main(). Channel ladder rung 2: bare-rpc replaces Ch1's
// hand-framed JSON. bare-rpc self-frames over the raw IPC (rn-bare-kit#10), so
// framed-stream is gone — the command set (stat/import/suspend/resume) is the
// wire contract. Import is one round-trip per photo: the naive shape Movement 2
// measures, kept deliberately so the numbers are honest.

const RPC = require('bare-rpc')
const b4a = require('b4a')
const { Vault } = require('./vault')

// bare-rpc encodes the command as a uint on the wire — commands are integers,
// not strings. This map is the wire contract; the app mirrors it exactly.
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, ERROR: 9 }

let vault = null
// Requests can arrive before the vault finishes opening; gate every command on
// this instead of racing readiness.
let resolveReady
const ready = new Promise((resolve) => { resolveReady = resolve })

const rpc = new RPC(BareKit.IPC, async (req) => {
  await ready
  try {
    switch (req.command) {
      case CMD.STAT:
        req.reply(json({ photos: await vault.count() }))
        break
      case CMD.IMPORT: {
        // JSON payload — Movement 2's naive base64 path.
        const data = JSON.parse(b4a.toString(req.data))
        const result = await vault.importPhoto(b4a.from(data.dataBase64, 'base64'), data.name)
        await vault.share() // announce so peek.mjs can find us
        req.reply(json(result))
        break
      }
      case CMD.IMPORT_RAW: {
        // Movement 3 wire: [u16 LE nameLen][name utf8][photo bytes]. No base64,
        // no JSON around the payload — the bytes are the payload.
        const buf = req.data
        const nameLen = buf[0] | (buf[1] << 8)
        const name = b4a.toString(buf.subarray(2, 2 + nameLen))
        const bytes = buf.subarray(2 + nameLen)
        const result = await vault.importPhoto(bytes, name)
        await vault.share()
        req.reply(json(result))
        break
      }
      case CMD.SUSPEND:
        if (vault.swarm) await vault.swarm.suspend()
        req.reply(json({ ok: true }))
        break
      case CMD.RESUME:
        if (vault.swarm) await vault.swarm.resume()
        req.reply(json({ ok: true }))
        break
      default:
        req.reply(json({ error: `unknown command: ${req.command}` }))
    }
  } catch (err) {
    req.reply(json({ error: String((err && err.stack) || err) }))
  }
})

main().catch((err) => {
  // No request to answer yet — surface boot failures as an unsolicited event.
  rpc.event(CMD.ERROR).send(json({ message: String((err && err.stack) || err) }))
})

async function main () {
  // Lazy platform requires: Bare builtins resolve at runtime, and vault.js
  // stays loadable under Node for tests and the desktop mirror.
  const os = require('bare-os')
  const path = require('bare-path')

  const base = Bare.argv[0] || os.tmpdir()
  vault = new Vault(path.join(base, 'shoebox-vault'))
  await vault.ready()
  resolveReady()
}

function json (obj) {
  return b4a.from(JSON.stringify(obj))
}
