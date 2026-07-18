// Thumbnail generation — runs ONLY inside Bare (bare-media wraps Bare-native
// image codecs / ffmpeg). The renderer never decodes a photo; the worker turns
// each import into a ≤256px preview shipped eagerly as a data: URL, so the grid
// paints from the index alone and never touches an original.
//
// bare-media is ESM and its addons are Bare-only, so it's loaded lazily via
// dynamic import — that also keeps this module out of the Node smoke test's
// path (the test loads vault.js, never this).
const b4a = require('b4a')

let imagePromise = null
function getImage () {
  if (!imagePromise) imagePromise = import('bare-media').then((m) => m.image)
  return imagePromise
}

module.exports = async function thumbnail (buffer) {
  const image = await getImage()
  const rgba = await image.decode(buffer, { maxFrames: 1 })
  const small = await image.resize(rgba, { maxWidth: 256, maxHeight: 256 })
  const encoded = await image.encode(small, { mimetype: 'image/webp' })

  let orientation = 0
  try {
    const meta = await image.metadata(buffer)
    orientation = Number(meta && meta.Orientation) || 0
  } catch { /* no EXIF — leave 0 */ }

  return {
    thumb: 'data:image/webp;base64,' + b4a.toString(b4a.from(encoded), 'base64'),
    width: rgba.width || 0,
    height: rgba.height || 0,
    orientation,
  }
}
