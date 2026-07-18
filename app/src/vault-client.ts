// bare-rpc ships no types; it's plain CJS and runs on Hermes with the
// bare-stream→streamx alias in metro.config.js.
// @ts-ignore
import RPC from 'bare-rpc'
import b4a from 'b4a'

export interface ImportResult {
  link: string
  indexKey: string
  takenAt: number
  id: string // the record's hex key — stable and unique
}

// bare-rpc encodes the command as a uint — integers, not strings. Mirrors the
// worker's CMD map exactly (worker/index.js).
const CMD = { STAT: 1, IMPORT: 2, SUSPEND: 3, RESUME: 4, IMPORT_RAW: 5, LIST: 6 }

export interface PhotoRecord {
  id: string // stable, unique — safe as a React list key
  name: string
  takenAt: number
  mime: string
  width: number
  height: number
  orientation: number
  thumb: string
  link: string
}

/**
 * The app's half of the channel-ladder rung-2 contract. One RPC per photo —
 * the naive shape Movement 2 measures. Wraps the worklet's raw IPC duplex.
 */
export class VaultClient {
  private rpc: any

  constructor(ipc: unknown) {
    // onrequest is optional at runtime (defaults to noop); cast around the
    // untyped CJS default-export's inferred arity.
    this.rpc = new (RPC as any)(ipc)
  }

  private async call(command: number, payload?: object): Promise<any> {
    const req = this.rpc.request(command)
    req.send(b4a.from(payload ? JSON.stringify(payload) : ''))
    const res: Uint8Array = await req.reply()
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

  // Movement 3: raw bytes, framed as [u16 LE headerLen][header JSON][bytes]. The
  // header carries {name, takenAt}; the bytes ride bare-rpc as-is, no base64.
  async importRaw(meta: { name: string; takenAt: number }, bytes: Uint8Array): Promise<ImportResult> {
    const header = b4a.from(JSON.stringify(meta))
    const payload = new Uint8Array(2 + header.length + bytes.length)
    payload[0] = header.length & 0xff
    payload[1] = (header.length >> 8) & 0xff
    payload.set(header, 2)
    payload.set(bytes, 2 + header.length)
    const req = this.rpc.request(CMD.IMPORT_RAW)
    req.send(payload)
    const out = JSON.parse(b4a.toString(await req.reply()))
    if (out.error) throw new Error(out.error)
    return out
  }

  async list(limit = 200): Promise<PhotoRecord[]> {
    const out = await this.call(CMD.LIST, { limit })
    return out.photos
  }
}
