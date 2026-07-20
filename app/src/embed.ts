import { NitroModules } from 'react-native-nitro-modules'
import b4a from 'b4a'
import type { ShoeboxEmbed } from './specs/shoebox-embed.nitro'

/** The on-device embedding model (TFLite). null if the native side is absent. */
export function embedModule(): ShoeboxEmbed | null {
  try {
    return NitroModules.createHybridObject<ShoeboxEmbed>('ShoeboxEmbed')
  } catch {
    return null
  }
}

/** Nitro embedding (number[]) → base64 float32 for the index/wire. */
export function packEmbedding(vec: number[]): string {
  const f32 = new Float32Array(vec)
  return b4a.toString(new Uint8Array(f32.buffer), 'base64')
}

/** base64 float32 → Float32Array (copied so it's 4-byte aligned). */
export function unpackEmbedding(b64: string): Float32Array {
  if (!b64) return new Float32Array(0)
  const bytes = b4a.from(b64, 'base64')
  // A corrupt/truncated entry whose length isn't a multiple of 4 must not throw
  // a RangeError mid-render — treat it as no embedding.
  if (bytes.length % 4 !== 0) return new Float32Array(0)
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/** Cosine similarity in [-1, 1]; -1 for missing/mismatched vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return -1
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}
