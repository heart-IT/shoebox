// Minimal ambient types for untyped Holepunch-ecosystem modules.

declare module 'framed-stream' {
  import type { Duplex } from 'stream'
  export default class FramedStream {
    constructor(rawStream: unknown)
    write(data: Uint8Array): boolean
    on(event: 'data', listener: (data: Uint8Array) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    end(): void
    destroy(): void
  }
}

declare module 'b4a' {
  const b4a: {
    from(input: string, encoding?: string): Uint8Array
    from(input: ArrayLike<number> | ArrayBuffer): Uint8Array
    toString(buf: Uint8Array, encoding?: string): string
  }
  export default b4a
}
