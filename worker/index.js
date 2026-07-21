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
const { codedError, codeOf } = require('./errors')
const { createDiagnostics } = require('./diagnostics')
const thumbnail = require('./thumbnail')

// The OS closes our sockets while we're backgrounded; on resume, Bare cleans up
// the corpses and throws from callbacks with no JS catcher. Swallow exactly that
// class (narrow allowlist, cause-chain aware), exactly in the suspend→resume
// window; everything else re-throws and crashes loudly, as before (Ch8 M2).
const suspension = createSuspensionWindow()
installSuspensionFilter(Bare, suspension, { log: (m) => { console.error(m); diag.log('warn', m) } })

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
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6, CREATE_INVITE: 7, LIST_MEMBERS: 8, REMOVE_MEMBER: 10, ERROR: 9, JOIN: 11, EVICT: 12, STORAGE_STAT: 13, SET_MIRROR: 14, EXPORT_MNEMONIC: 15, RESTORE_MNEMONIC: 16 }

let vault = null
// AF-M13: the rolling diagnostics ring. Replaced in main() with a disk-backed
// one once the storage path is known; until then events are simply dropped.
let diag = { log () {}, flush () { return false } }
// Audit AF-M9: RPC input bounds. The app is the only client, but it's still the
// trust boundary — a buggy release must not OOM or wedge the worker.
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024 // caps a pathological frame; a real photo (base64) stays well under
const MAX_INFLIGHT = 32 // concurrent handlers; excess is rejected, not queued unboundedly
let inflight = 0
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
  if (bootError) return req.reply(json({ error: 'worker failed to start: ' + bootError, code: 'EBOOT' }))
  // AF-M9: reject oversized frames and back-pressure a request flood before any
  // work (or memory) is spent on them.
  if (req.data && req.data.byteLength > MAX_PAYLOAD_BYTES) {
    return req.reply(json({ error: 'payload too large', code: 'EPAYLOAD' }))
  }
  if (inflight >= MAX_INFLIGHT) {
    return req.reply(json({ error: 'worker busy — too many in-flight requests', code: 'EBUSY' }))
  }
  // Audit AF-H2: during a JOIN reboot the vault is briefly null. Every command
  // but JOIN needs it — reply with a clean, retryable error instead of throwing
  // a TypeError, and crucially don't let a SUSPEND in this window run
  // `suspension.onSuspend()` and then fail (which used to leave the exception
  // filter's window stuck open in the foreground).
  if (vault === null && req.command !== CMD.JOIN) {
    return req.reply(json({ error: 'worker is busy joining a library — retry shortly', code: 'EBUSY_JOINING' }))
  }
  inflight++
  try {
    switch (req.command) {
      case CMD.STAT:
        // Count plus the sync-health trio (Ch10 M3): peers / suspended /
        // lastUpdateAt — so the UI can say "connected and moving" honestly.
        req.reply(json({ photos: await vault.count(), ...vault.status() }))
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
        // AF-M9: `ids` must be an ARRAY — a bare string would iterate per char
        // in evict() and clear whatever those single-char "ids" happened to hit.
        const { ids, bytes } = req.data && req.data.byteLength ? JSON.parse(b4a.toString(req.data)) : {}
        const targets = Array.isArray(ids) && ids.length ? ids : await vault.evictionCandidates({ bytes: Number(bytes) || 0 })
        req.reply(json(await vault.evict(targets)))
        break
      }
      case CMD.STORAGE_STAT:
        req.reply(json(await vault.storageStat()))
        break
      case CMD.SUSPEND:
        // Window opens BEFORE the teardown starts — the first dead-socket throw
        // can arrive while suspend is still dropping connections. AF-M5: if the
        // suspend itself fails, close the window again so the filter never
        // outlives a real suspend/resume cycle (it used to stay open forever).
        suspension.onSuspend()
        try {
          await vault.suspend()
          diag.log('info', 'suspended')
          diag.flush() // evidence must survive an OS freeze/kill (AF-M13)
          req.reply(json({ ok: true }))
        } catch (err) {
          suspension.onResume() // don't strand the window open on a failed suspend
          req.reply(json({ error: String((err && err.stack) || err) }))
        }
        break
      case CMD.RESUME:
        // AF-M5: close the window in a finally — a resume that throws must still
        // end the filter's window (settleMs from now), not leave it open.
        try {
          await vault.resume()
          diag.log('info', `resumed (peers ${vault.status().peers})`)
          req.reply(json({ ok: true }))
        } catch (err) {
          req.reply(json({ error: String((err && err.stack) || err) }))
        } finally {
          // Closes settleMs from now, not immediately: the socket-corpse cleanup
          // fires during and shortly AFTER resume, not neatly inside suspension.
          suspension.onResume()
        }
        break
      case CMD.CREATE_INVITE:
        // Pair a second device: returns a one-time invite code the candidate runs
        // `node join.mjs <invite>` with (it joins as a WRITER, not a read peer).
        req.reply(json({ invite: await vault.createInvite() }))
        break
      case CMD.LIST_MEMBERS:
        req.reply(json({ members: await vault.members() }))
        break
      case CMD.EXPORT_MNEMONIC:
        // AF-H5: the 24 words that restore this device's identity. This IS the
        // root secret — the app shows it once, for the user to write down.
        req.reply(json({ mnemonic: ctx.mnemonicFromSeed(ctx.seed) }))
        break
      case CMD.RESTORE_MNEMONIC: {
        // Restore a lost device: write the seed the words encode, then reboot.
        // Same seed → same primaryKey → same writer core → the SAME library key,
        // so this device becomes the original founder again and re-syncs from
        // any peer or mirror still holding the content.
        //
        // GUARDED: only on a device with nothing to lose. Overwriting the seed
        // orphans whatever the local store already holds (its cores are derived
        // from the OLD seed), so refuse if this device has photos or has joined
        // someone else's library. Restore belongs on a fresh install.
        const { mnemonic } = JSON.parse(b4a.toString(req.data))
        const restored = ctx.seedFromMnemonic(mnemonic) // throws on bad words/checksum
        if (ctx.loadMembership(ctx.fs, ctx.membershipPath)) throw codedError('ENOTFRESH', 'this device has joined a library — restore only on a fresh install')
        if ((await vault.count()) > 0) throw codedError('ENOTFRESH', 'this device already holds photos — restore only on a fresh install')
        await vault.close()
        vault = null
        try {
          ctx.saveSeed(ctx.fs, ctx.seedPath, restored)
          ctx.reseed(restored) // recompute primaryKey / album key / box keypair
        } finally {
          await bootVault() // never leave the worker vault-less (AF-H2)
        }
        req.reply(json({ ok: true, libraryKey: idEncoding.encode(vault.libraryKey) }))
        break
      }
      case CMD.SET_MIRROR: {
        // AF-M2: configure an always-on blind mirror at runtime (the app's
        // Settings). Validate the z32 key, register it live, and persist it so
        // it's picked up on every later boot.
        const { key } = JSON.parse(b4a.toString(req.data))
        idEncoding.decode(key) // throws on a malformed key → caught below
        await vault.addMirror(key)
        const cur = ctx.loadMirrors(ctx.fs, ctx.mirrorPath)
        if (!cur.includes(key)) ctx.saveMirrors(ctx.fs, ctx.mirrorPath, [...cur, key])
        req.reply(json({ mirrors: vault.mirrorKeys() }))
        break
      }
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
        if (ctx.loadMembership(ctx.fs, ctx.membershipPath)) throw codedError('EJOINED', 'this device has already joined a library')
        const { invite } = JSON.parse(b4a.toString(req.data))
        if (!invite) throw codedError('EBADKEY', 'join requires an invite code')
        if (vault) { await vault.close(); vault = null } // release the store before pairing reopens it
        let delivered
        try {
          delivered = await pairAsCandidate(ctx.vaultPath, { primaryKey: ctx.primaryKey, invite, boxKeyPair: ctx.boxKeyPair, relayThrough: ctx.relayThrough })
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
        req.reply(json({ error: `unknown command: ${req.command}`, code: 'ECOMMAND' }))
    }
  } catch (err) {
    // AF-M13: a stable code alongside the human message, so the app can branch.
    const code = codeOf(err)
    diag.log(code === 'EINTERNAL' ? 'error' : 'warn', `cmd ${req.command} failed [${code}] ${String((err && err.message) || err)}`)
    req.reply(json({ error: String((err && err.stack) || err), code }))
  } finally {
    inflight-- // AF-M9: release the in-flight slot on every path
  }
})

main().then(vaultReady, (err) => {
  // Boot failed: record it and RESOLVE ready anyway, so every pending/future
  // command replies with an error instead of hanging on `await ready` forever.
  bootError = String((err && err.stack) || err)
  diag.log('error', 'boot failed: ' + bootError)
  diag.flush()
  rpc.event(CMD.ERROR).send(json({ message: bootError, code: 'EBOOT' }))
  vaultReady()
})

async function main () {
  // Lazy platform requires: Bare builtins resolve at runtime, and vault.js
  // stays loadable under Node for tests and the desktop mirror.
  const os = require('bare-os')
  const path = require('bare-path')
  const fs = require('bare-fs')
  const { loadOrCreateSeed, primaryKeyFromSeed, encryptionKeyFromSeed, saveSeed, saveMembership, loadMembership, loadMirrors, saveMirrors } = require('./identity')
  const { memberBoxKeyFromSeed } = require('./rotation')
  const { mnemonicFromSeed, seedFromMnemonic } = require('./mnemonic')

  const base = Bare.argv[0] || os.tmpdir()
  // Optional second arg: the z32 key of a self-run blind peer (Ch9 M2) — the
  // always-on box that mirrors this library as ciphertext. No key, no mirror;
  // availability is then only as good as the other devices' uptime. AF-M2: this
  // is merged with any mirrors configured at runtime (persisted in the mirror
  // file), so the app's Settings flow — not just the boot arg — can add one.
  const blindPeerArg = Bare.argv[1] || null
  const mirrorPath = path.join(base, 'shoebox-mirrors')
  const bootMirrorZ = [...new Set([...(blindPeerArg ? [blindPeerArg] : []), ...loadMirrors(fs, mirrorPath)])]
  // AF-H6: an optional relay node key (a `shoebox-relay` file, one z32) — the
  // symmetric-NAT fallback. Absent → no relay (deployment choice; needs a
  // running relay node). A garbled file is ignored, not fatal.
  let relayThrough = null
  try { const r = loadMirrors(fs, path.join(base, 'shoebox-relay'))[0]; if (r) relayThrough = idEncoding.decode(r) } catch { /* invalid relay key — skip */ }
  // The device identity seed — minted once, persisted, the root every core
  // descends from. It seeds both the device's keys (primaryKey) and the album's
  // encryption key. AF-H5: it is now exportable as a 24-word mnemonic (and
  // restorable from one); moving it into the platform keychain remains native
  // work, so here it still lives beside the vault.
  // AF-M13: a bounded on-disk diagnostics ring. Flushed on SUSPEND (the OS can
  // freeze us without warning) and on teardown, so a field failure leaves evidence.
  diag = createDiagnostics(fs, path.join(base, 'shoebox-diagnostics.log'))
  diag.log('info', 'worker booting')
  const seedPath = path.join(base, 'shoebox-seed')
  const seed = loadOrCreateSeed(fs, seedPath)
  // Everything a boot (or a later JOIN reboot) needs, computed once. The founder's
  // album key comes from the seed; a joiner's comes from disk (membership).
  ctx = {
    fs,
    saveMembership,
    loadMembership,
    loadMirrors,
    saveMirrors,
    saveSeed,
    mnemonicFromSeed,
    seedFromMnemonic,
    mirrorPath,
    seedPath,
    seed,
    vaultPath: path.join(base, 'shoebox-vault'),
    membershipPath: path.join(base, 'shoebox-membership'),
    blindPeerKeys: bootMirrorZ.length ? bootMirrorZ.map((z) => idEncoding.decode(z)) : null,
    relayThrough,
    // Recompute every seed-derived key. Called once at boot, and again after a
    // mnemonic restore replaces the seed (AF-H5).
    reseed (s) {
      ctx.seed = s
      ctx.primaryKey = primaryKeyFromSeed(s)
      ctx.founderAlbumKey = encryptionKeyFromSeed(s)
      ctx.boxKeyPair = memberBoxKeyFromSeed(s) // opens content keys sealed to us on rotation (Ch7 M3)
    },
  }
  ctx.reseed(seed)
  await bootVault()
}

// Open the vault in the right ROLE. A membership file (written when this device
// joined someone else's library) means boot as a MEMBER — bootstrap onto that
// library key and decrypt with the delivered album key. No membership means
// FOUNDER — this device's own library, both keys derived from its seed.
//
// Audit AF-H7: BOTH roles share on boot. The founder used to share lazily (only
// on its first import), so a rebooted founder sat at peers:0 with no replication
// and no blind-mirror registration until it next imported — which the Ch10 sync
// line then read as the very failure it exists to expose, and which stranded
// other devices/members unable to sync from the founder. Sharing is idempotent
// and the swarm suspends on background, so announcing on launch is the right
// default. (share() is a no-op when there's nothing to announce to yet.)
async function bootVault () {
  const membership = ctx.loadMembership(ctx.fs, ctx.membershipPath)
  if (membership) {
    vault = new Vault(ctx.vaultPath, {
      primaryKey: ctx.primaryKey,
      bootstrap: idEncoding.encode(membership.libraryKey),
      encryptionKey: b4a.from(membership.albumKey),
      boxKeyPair: ctx.boxKeyPair,
      blindPeerKeys: ctx.blindPeerKeys,
      relayThrough: ctx.relayThrough,
    })
  } else {
    vault = new Vault(ctx.vaultPath, {
      primaryKey: ctx.primaryKey,
      encryptionKey: ctx.founderAlbumKey,
      boxKeyPair: ctx.boxKeyPair,
      blindPeerKeys: ctx.blindPeerKeys,
      relayThrough: ctx.relayThrough,
    })
  }
  await vault.ready()
  await vault.share()
}

// Close the vault on worklet teardown so the swarm, the blob-server socket, and
// Corestore shut down cleanly (otherwise every teardown leaks sockets and leaves
// the store closed uncleanly — a stuck-lock risk on the next boot).
Bare.on('teardown', async () => {
  diag.log('info', 'teardown')
  diag.flush()
  try { if (vault) await vault.close() } catch { /* best effort on the way out */ }
})

function json (obj) {
  return b4a.from(JSON.stringify(obj))
}
