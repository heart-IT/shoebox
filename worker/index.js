/* global Bare, BareKit */
// Worklet entry. Synchronous by contract — no top-level await (rn-bare-kit#1);
// async work lives in main(). Channel ladder rung 2: bare-rpc replaces Ch1's
// hand-framed JSON. bare-rpc self-frames over the raw IPC (rn-bare-kit#10), so
// framed-stream is gone — the command set (stat/import/suspend/resume) is the
// wire contract. Import is one round-trip per photo: the naive shape Movement 2
// measures, kept deliberately so the numbers are honest.

const RPC = require('bare-rpc')
const b4a = require('b4a')
const idEncoding = require('hypercore-id-encoding')
const { Vault, pairAsCandidate } = require('./vault')
const { createSuspensionWindow, installSuspensionFilter } = require('./lifecycle')
const thumbnail = require('./thumbnail')

// The OS closes our sockets while we're backgrounded; on resume, Bare cleans up
// the corpses and throws from callbacks with no JS catcher. Swallow exactly that
// class (narrow allowlist, cause-chain aware), exactly in the suspend→resume
// window; everything else re-throws and crashes loudly, as before (Ch8 M2).
const suspension = createSuspensionWindow()
installSuspensionFilter(Bare, suspension, { log: console.error })

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
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6, CREATE_INVITE: 7, LIST_MEMBERS: 8, REMOVE_MEMBER: 10, ERROR: 9, JOIN: 11, EVICT: 12, STORAGE_STAT: 13 }

let vault = null
// The device's boot context — seed-derived identity + paths — computed once in
// main() and reused when a JOIN reboots the vault as a member (Ch7 M4).
let ctx = null
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
        // `>>> 0` forces an unsigned read: without it `<< 24` makes the top bit
        // sign-extend, so a large header length would decode negative.
        const headerLen = (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0
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
        const { limit, residency } = req.data && req.data.byteLength ? JSON.parse(b4a.toString(req.data)) : {}
        const records = await vault.list({ limit: limit || 200, reverse: true, residency: !!residency })
        const photos = records.map((r) => ({
          id: r.id, // stable, unique — the app's list key
          name: r.name, takenAt: r.takenAt, mime: r.mime,
          width: r.width, height: r.height, orientation: r.orientation,
          thumb: r.thumb || '', dhash: r.dhash || '', link: r.link,
          // float32 embedding as base64 (empty if not indexed yet).
          embedding: r.embedding ? b4a.toString(r.embedding, 'base64') : '',
          // hot (bytes local) or cold (evicted / never fetched) — Ch9 M1.
          ...(residency ? { resident: !!r.resident } : {}),
        }))
        req.reply(json({ photos }))
        break
      }
      case CMD.EVICT: {
        // Evict originals (Ch9 M1): explicit ids, or let the oracle pick
        // near-duplicates-then-oldest until `bytes` worth are covered.
        const { ids, bytes } = req.data && req.data.byteLength ? JSON.parse(b4a.toString(req.data)) : {}
        const targets = ids && ids.length ? ids : await vault.evictionCandidates({ bytes: bytes || 0 })
        req.reply(json(await vault.evict(targets)))
        break
      }
      case CMD.STORAGE_STAT:
        req.reply(json(await vault.storageStat()))
        break
      case CMD.SUSPEND:
        // Window opens BEFORE the teardown starts — the first dead-socket throw
        // can arrive while suspend is still dropping connections.
        suspension.onSuspend()
        await vault.suspend()
        req.reply(json({ ok: true }))
        break
      case CMD.RESUME:
        await vault.resume()
        // Closes settleMs from now, not immediately: the socket-corpse cleanup
        // fires during and shortly AFTER resume, not neatly inside suspension.
        suspension.onResume()
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
      case CMD.JOIN: {
        // This device JOINS an existing library with an invite (the phone side of
        // Ch7 M4 — the candidate half of createInvite). We tear down our own
        // (empty, just-founded) vault, run the blind-pairing handshake to receive
        // {libraryKey, albumKey}, persist them, and reboot as a member. The keys
        // are the founder's secret — not seed-derivable — so persistence is what
        // lets us reopen the album on later boots without re-pairing.
        if (ctx.loadMembership(ctx.fs, ctx.membershipPath)) throw new Error('this device has already joined a library')
        const { invite } = JSON.parse(b4a.toString(req.data))
        if (!invite) throw new Error('join requires an invite code')
        if (vault) { await vault.close(); vault = null } // release the store before pairing reopens it
        let delivered
        try {
          delivered = await pairAsCandidate(ctx.vaultPath, { primaryKey: ctx.primaryKey, invite, boxKeyPair: ctx.boxKeyPair })
          ctx.saveMembership(ctx.fs, ctx.membershipPath, { libraryKey: delivered.libraryKey, albumKey: delivered.encryptionKey })
        } finally {
          // Reboot into a LIVE vault no matter what: on success membership now
          // exists so it comes up a MEMBER; on a pairing failure none was written
          // so it comes back the FOUNDER — the worker is never left vault-less.
          await bootVault()
        }
        req.reply(json({ ok: true, libraryKey: idEncoding.encode(delivered.libraryKey) }))
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
  const { loadOrCreateSeed, primaryKeyFromSeed, encryptionKeyFromSeed, saveMembership, loadMembership } = require('./identity')
  const { memberBoxKeyFromSeed } = require('./rotation')

  const base = Bare.argv[0] || os.tmpdir()
  // The device identity seed — minted once, persisted, the root every core
  // descends from. It seeds both the device's keys (primaryKey) and the album's
  // encryption key. (A later chapter backs it up as a mnemonic and moves it into
  // the platform keychain; here it lives beside the vault.)
  const seed = loadOrCreateSeed(fs, path.join(base, 'shoebox-seed'))
  // Everything a boot (or a later JOIN reboot) needs, computed once. The founder's
  // album key comes from the seed; a joiner's comes from disk (membership).
  ctx = {
    fs,
    saveMembership,
    loadMembership,
    vaultPath: path.join(base, 'shoebox-vault'),
    membershipPath: path.join(base, 'shoebox-membership'),
    primaryKey: primaryKeyFromSeed(seed),
    founderAlbumKey: encryptionKeyFromSeed(seed),
    boxKeyPair: memberBoxKeyFromSeed(seed), // opens content keys sealed to us on rotation (Ch7 M3)
  }
  await bootVault()
}

// Open the vault in the right ROLE. A membership file (written when this device
// joined someone else's library) means boot as a MEMBER — bootstrap onto that
// library key and decrypt with the delivered album key. No membership means
// FOUNDER — this device's own library, both keys derived from its seed. A member
// shares immediately so it replicates in and its granted write access takes hold;
// a founder shares lazily on its first import (unchanged).
async function bootVault () {
  const membership = ctx.loadMembership(ctx.fs, ctx.membershipPath)
  if (membership) {
    vault = new Vault(ctx.vaultPath, {
      primaryKey: ctx.primaryKey,
      bootstrap: idEncoding.encode(membership.libraryKey),
      encryptionKey: b4a.from(membership.albumKey),
      boxKeyPair: ctx.boxKeyPair,
    })
    await vault.ready()
    await vault.share()
  } else {
    vault = new Vault(ctx.vaultPath, {
      primaryKey: ctx.primaryKey,
      encryptionKey: ctx.founderAlbumKey,
      boxKeyPair: ctx.boxKeyPair,
    })
    await vault.ready()
  }
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
