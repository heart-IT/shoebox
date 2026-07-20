// bare-rpc ships no types; it's plain CJS and runs on Hermes with the
// bare-stream→streamx alias in metro.config.js.
// @ts-ignore
import RPC from 'bare-rpc'
import b4a from 'b4a'

export interface ImportResult {
  link: string
  indexKey: string
  takenAt: number
  id: string
}

// bare-rpc encodes the command as a uint — integers, not strings. Mirrors the
// worker's CMD map exactly (worker/index.js). ERROR is a worker→app EVENT (the
// worker emits it if boot fails), not a request.
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6, CREATE_INVITE: 7, LIST_MEMBERS: 8, ERROR: 9, REMOVE_MEMBER: 10 }
// A worklet that never replies (e.g. a boot hang) must not leave a promise
// pending forever — every request is raced against this deadline.
const RPC_TIMEOUT_MS = 20000

export interface PhotoRecord {
  id: string // stable, unique — safe as a React list key
  name: string
  takenAt: number
  mime: string
  width: number
  height: number
  orientation: number
  thumb: string
  dhash: string
  embedding: string // base64 float32, empty until indexed
  link: string
}

// Hamming distance between two 16-hex dHashes (0 = identical). Near-duplicate
// search runs here, over the index column — no pixels, nothing leaves the phone.
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

/**
 * The app's half of the channel-ladder rung-2 contract. One RPC per photo —
 * the naive shape Movement 2 measures. Wraps the worklet's raw IPC duplex.
 */
export class VaultClient {
  private rpc: any

  constructor(ipc: unknown, onError?: (message: string) => void) {
    // The worker emits an ERROR event if boot fails; without a handler it's
    // silently dropped and the UI keeps showing a stale "vault ready". Route it
    // to onError so the app can surface a failed/dead worker instead of a zombie.
    this.rpc = new (RPC as any)(ipc, (req: { command: number; data: Uint8Array }) => {
      if (req.command !== CMD.ERROR || !onError) return
      let message = 'worker reported an error'
      try { message = JSON.parse(b4a.toString(req.data)).message || message } catch { /* keep default */ }
      onError(message)
    })
  }

  // Race a reply against a deadline so a non-replying worklet can't hang forever.
  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} timed out`)), RPC_TIMEOUT_MS)
      p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
    })
  }

  private async call(command: number, payload?: object): Promise<any> {
    const req = this.rpc.request(command)
    req.send(b4a.from(payload ? JSON.stringify(payload) : ''))
    const res: Uint8Array = await this.withTimeout(req.reply(), `command ${command}`)
    const out = JSON.parse(b4a.toString(res))
    if (out.error) throw new Error(out.error)
    return out
  }

  stat(): Promise<{ photos: number }> {
    return this.call(CMD.STAT)
  }

  importPhoto(name: string, dataBase64: string, takenAt = Date.now()): Promise<ImportResult> {
    return this.call(CMD.IMPORT, { name, takenAt, dataBase64 })
  }

  // Movement 3: raw bytes, framed as [u32 LE headerLen][header JSON][bytes]. The
  // header carries {name, takenAt, embedding?}; the bytes ride bare-rpc as-is, no
  // base64. u32 (not u16) so a large embedding in the header can't overflow.
  async importRaw(
    meta: { name: string; takenAt: number; embedding?: string },
    bytes: Uint8Array,
  ): Promise<ImportResult> {
    const header = b4a.from(JSON.stringify(meta))
    const payload = new Uint8Array(4 + header.length + bytes.length)
    payload[0] = header.length & 0xff
    payload[1] = (header.length >> 8) & 0xff
    payload[2] = (header.length >> 16) & 0xff
    payload[3] = (header.length >> 24) & 0xff
    payload.set(header, 4)
    payload.set(bytes, 4 + header.length)
    const req = this.rpc.request(CMD.IMPORT_RAW)
    req.send(payload)
    const out = JSON.parse(b4a.toString(await this.withTimeout(req.reply(), 'import')))
    if (out.error) throw new Error(out.error)
    return out
  }

  async list(limit = 200): Promise<PhotoRecord[]> {
    const out = await this.call(CMD.LIST, { limit })
    return out.photos
  }

  // Mobile lifecycle: the host forwards OS background/foreground here so the
  // worker can drop the swarm connection and the localhost blob-server socket
  // while backgrounded (and reopen them on return). Without this, the worker's
  // suspend/resume path is dead code and the sockets leak across a background.
  suspend(): Promise<{ ok: boolean }> {
    return this.call(CMD.SUSPEND)
  }

  resume(): Promise<{ ok: boolean }> {
    return this.call(CMD.RESUME)
  }

  // Pair a second device — returns a one-time invite code to run `node join.mjs
  // <invite>` with on a laptop. That device joins as a writer, not a read peer.
  createInvite(): Promise<{ invite: string }> {
    return this.call(CMD.CREATE_INVITE)
  }

  // The album roster: who's an owner, who's a member.
  members(): Promise<{ members: Array<{ writerKey: string; role: string }> }> {
    return this.call(CMD.LIST_MEMBERS)
  }

  // Revoke a member by their writer key (owner-only, enforced in the worker).
  removeMember(writerKey: string): Promise<{ ok: boolean }> {
    return this.call(CMD.REMOVE_MEMBER, { writerKey })
  }
}
