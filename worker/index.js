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
const thumbnail = require('./thumbnail')

// Eager ≤256px preview per import, generated in the worker (never the renderer).
// Unsupported/corrupt images import without a thumb rather than failing.
async function withThumb (bytes, meta) {
  try {
    return { ...meta, ...(await thumbnail(bytes)) }
  } catch {
    return meta
  }
}

// bare-rpc encodes the command as a uint on the wire — commands are integers,
// not strings. This map is the wire contract; the app mirrors it exactly.
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6, ERROR: 9 }

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
        const bytes = b4a.from(data.dataBase64, 'base64')
        const result = await vault.importPhoto(bytes, await withThumb(bytes, data))
        await vault.share() // announce so peek.mjs can find us
        req.reply(json(result))
        break
      }
      case CMD.IMPORT_RAW: {
        // Movement 3 wire: [u16 LE headerLen][header JSON][photo bytes]. The
        // header carries {name, takenAt}; the bytes are the payload, no base64.
        const buf = req.data
        const headerLen = buf[0] | (buf[1] << 8)
        const meta = JSON.parse(b4a.toString(buf.subarray(2, 2 + headerLen)))
        const bytes = buf.subarray(2 + headerLen)
        const result = await vault.importPhoto(bytes, await withThumb(bytes, meta))
        await vault.share()
        req.reply(json(result))
        break
      }
      case CMD.LIST: {
        // A time-ordered window for the grid — records only, no bytes. Map to
        // an app-clean shape (the blobs-core key is a Buffer; the URL already
        // encodes it, so it never crosses to the UI).
        const { limit } = req.data && req.data.byteLength ? JSON.parse(b4a.toString(req.data)) : {}
        const records = await vault.list({ limit: limit || 200, reverse: true })
        const photos = records.map((r) => ({
          name: r.name, takenAt: r.takenAt, mime: r.mime,
          width: r.width, height: r.height, orientation: r.orientation,
          thumb: r.thumb, link: r.link,
        }))
        req.reply(json({ photos }))
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
