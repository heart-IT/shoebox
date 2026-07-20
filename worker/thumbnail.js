// On-import image analysis — runs ONLY inside Bare (bare-media wraps Bare-native
// image codecs). Inv-5: the pixels are decoded and reasoned about ON THE DEVICE.
// One decode feeds two products, both tiny enough to live in the index and
// replicate as results, never as pixels:
//   - a ≤256px webp thumbnail (data: URL) for the grid
//   - a 64-bit dHash (16 hex) for near-duplicate clustering
//
// bare-media is ESM and its addons are Bare-only, so it's loaded lazily via
// dynamic import — which also keeps this module out of the Node smoke test path.
const b4a = require('b4a')

let libs = null
async function getLibs () {
  if (!libs) {
    const [{ image }, { resize }] = await Promise.all([
      import('bare-media'),
      import('bare-image-resample'),
    ])
    libs = { image, resize }
  }
  return libs
}

// dHash: shrink to 9×8, grayscale, compare each pixel to its right neighbour →
// 64 bits. Robust to scaling/compression, so near-identical photos land within a
// few bits of each other (Hamming distance).
function dhash (rgba9x8) {
  const W = 9, H = 8
  const g = new Array(W * H)
  for (let p = 0; p < W * H; p++) {
    const i = p * 4
    g[p] = rgba9x8.data[i] * 0.299 + rgba9x8.data[i + 1] * 0.587 + rgba9x8.data[i + 2] * 0.114
  }
  let bits = ''
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) bits += g[y * W + x] > g[y * W + x + 1] ? '1' : '0'
  }
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

module.exports = async function analyze (buffer) {
  const { image, resize } = await getLibs()
  const rgba = await image.decode(buffer, { maxFrames: 1 })

  const small = await image.resize(rgba, { maxWidth: 256, maxHeight: 256 })
  const encoded = await image.encode(small, { mimetype: 'image/webp' })

  let orientation = 0
  try {
    const meta = await image.metadata(buffer)
    orientation = Number(meta && meta.Orientation) || 0
  } catch { /* no EXIF — leave 0 */ }

  // Isolated so a dHash failure can't cost us the thumbnail. On failure the
  // hash is left EMPTY (not an 'ERR:' sentinel): the near-dup search filters on
  // a truthy dhash, and two equal 'ERR:' strings would otherwise read as a
  // Hamming-0 "duplicate". Empty is correctly excluded from search.
  let dh = ''
  try {
    dh = dhash(resize(rgba, 9, 8))
  } catch (e) {
    console.error('dhash failed -', String((e && e.message) || e))
  }

  return {
    thumb: 'data:image/webp;base64,' + b4a.toString(b4a.from(encoded), 'base64'),
    width: rgba.width || 0,
    height: rgba.height || 0,
    orientation,
    dhash: dh,
  }
}

module.exports.hamming = function hamming (a, b) {
  // Hamming distance between two 16-hex dHashes (0 = identical).
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}
