import type { HybridObject } from 'react-native-nitro-modules'
// Nitro maps the global `ArrayBuffer` type to a native ArrayBuffer.

/**
 * One camera-roll asset, as the platform photo library describes it. No bytes
 * here — enumeration is metadata only (Inv-1 applies before any import: a
 * pointer to a photo and the photo are different objects).
 */
export interface RollAsset {
  /** Platform asset id (MediaStore _ID / PHAsset localIdentifier). */
  id: string
  name: string
  byteLength: number
  /** Epoch milliseconds the photo was taken (falls back to file date). */
  takenAt: number
  /**
   * Filesystem path the app's process can read while it holds the photo
   * permission. The worker (same process) streams bytes from here in later
   * movements — the path crosses the boundary, never the bytes.
   */
  path: string
}

/**
 * Movement 1: enumerate the roll behind a typed Nitro spec. Sync methods,
 * typed returns — the gentle introduction to the native seam, before any
 * bytes move.
 */
export interface ShoeboxRoll
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** How many photos the platform library reports. */
  count(): number
  /** A stable page of the roll, newest first. */
  assets(offset: number, limit: number): RollAsset[]
  /**
   * Movement 2's naive read: the whole asset as a base64 string. This is the
   * per-byte cost the chapter measures — the file is copied into a JS string
   * ~1.33× its size, then that string crosses the IPC. Movement 3 replaces it.
   */
  readBase64(path: string): string
  /**
   * Movement 3: the asset as raw bytes in an ArrayBuffer — no base64, no JSON.
   * The file is mmap'd and handed over as binary; bare-rpc sends the buffer
   * as-is. Removes the base64 inflation, the encode CPU, and the megabyte-long
   * string on the JS heap that stalled Movement 2.
   */
  readBytes(path: string): ArrayBuffer
}
