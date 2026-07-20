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
// Unsupported/corrupt images import without a thumb rather than failing — but we
// log it, because "silently thumbless forever" (the index is append-only, never
// re-analyzed) should not be invisible.
async function withThumb (bytes, meta) {
  try {
    return { ...meta, ...(await thumbnail(bytes)) }
  } catch (err) {
    console.error('analyze failed for', meta.name, '-', String((err && err.message) || err))
    return meta
  }
}

// bare-rpc encodes the command as a uint on the wire — commands are integers,
// not strings. This map is the wire contract; the app mirrors it exactly.
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6, CREATE_INVITE: 7, LIST_MEMBERS: 8, REMOVE_MEMBER: 10, ERROR: 9 }

let vault = null
// Requests can arrive before the vault finishes opening; gate every command on
// this instead of racing readiness. If boot FAILS, `ready` still resolves and
// `bootError` is set, so handlers reply with an error instead of hanging forever.
let vaultReady
let bootError = null
const ready = new Promise((resolve) => { vaultReady = resolve })

const rpc = new RPC(BareKit.IPC, async (req) => {
  await ready
  if (bootError) return req.reply(json({ error: 'worker failed to start: ' + bootError }))
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
        // Movement 3 wire: [u32 LE headerLen][header JSON][photo bytes]. The
        // header carries {name, takenAt, embedding?}; the bytes are the payload,
        // no base64. u32 (not u16) so a large embedding can't overflow the frame.
        const buf = req.data
        const headerLen = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)
        const meta = JSON.parse(b4a.toString(buf.subarray(4, 4 + headerLen)))
        // The app may attach a base64 embedding (computed on-device via TFLite);
        // store it as raw float32 bytes.
        if (meta.embedding) meta.embedding = b4a.from(meta.embedding, 'base64')
        const bytes = buf.subarray(4 + headerLen)
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
          id: r.id, // stable, unique — the app's list key
          name: r.name, takenAt: r.takenAt, mime: r.mime,
          width: r.width, height: r.height, orientation: r.orientation,
          thumb: r.thumb || '', dhash: r.dhash || '', link: r.link,
          // float32 embedding as base64 (empty if not indexed yet).
          embedding: r.embedding ? b4a.toString(r.embedding, 'base64') : '',
        }))
        req.reply(json({ photos }))
        break
      }
      case CMD.SUSPEND:
        await vault.suspend()
        req.reply(json({ ok: true }))
        break
      case CMD.RESUME:
        await vault.resume()
        req.reply(json({ ok: true }))
        break
      case CMD.CREATE_INVITE:
        // Pair a second device: returns a one-time invite code the candidate runs
        // `node join.mjs <invite>` with (it joins as a WRITER, not a read peer).
        req.reply(json({ invite: await vault.createInvite() }))
        break
      case CMD.LIST_MEMBERS:
        req.reply(json({ members: await vault.members() }))
        break
      case CMD.REMOVE_MEMBER: {
        const { writerKey } = JSON.parse(b4a.toString(req.data))
        await vault.removeMember(writerKey)
        req.reply(json({ ok: true }))
        break
      }
      default:
        req.reply(json({ error: `unknown command: ${req.command}` }))
    }
  } catch (err) {
    req.reply(json({ error: String((err && err.stack) || err) }))
  }
})

main().then(vaultReady, (err) => {
  // Boot failed: record it and RESOLVE ready anyway, so every pending/future
  // command replies with an error instead of hanging on `await ready` forever.
  bootError = String((err && err.stack) || err)
  rpc.event(CMD.ERROR).send(json({ message: bootError }))
  vaultReady()
})

async function main () {
  // Lazy platform requires: Bare builtins resolve at runtime, and vault.js
  // stays loadable under Node for tests and the desktop mirror.
  const os = require('bare-os')
  const path = require('bare-path')
  const fs = require('bare-fs')
  const { loadOrCreateSeed, primaryKeyFromSeed } = require('./identity')

  const base = Bare.argv[0] || os.tmpdir()
  // The device identity seed — minted once, persisted, the root every core
  // descends from. (A later chapter backs it up as a mnemonic and moves it into
  // the platform keychain; here it lives beside the vault.)
  const seed = loadOrCreateSeed(fs, path.join(base, 'shoebox-seed'))
  vault = new Vault(path.join(base, 'shoebox-vault'), { primaryKey: primaryKeyFromSeed(seed) })
  await vault.ready()
}

// Close the vault on worklet teardown so the swarm, the blob-server socket, and
// Corestore shut down cleanly (otherwise every teardown leaks sockets and leaves
// the store closed uncleanly — a stuck-lock risk on the next boot).
Bare.on('teardown', async () => {
  try { if (vault) await vault.close() } catch { /* best effort on the way out */ }
})

function json (obj) {
  return b4a.from(JSON.stringify(obj))
}
