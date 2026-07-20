// Build-time codegen for the vault's on-disk record format (run: node
// build-schema.mjs). Hyperschema emits compact-encoding codecs into spec/.
// Inv-4: this schema is an append-only contract — you may add OPTIONAL fields,
// but never remove one or make an old one required, or records written by past
// versions stop decoding. `orientation`, `width`, `height`, `thumb`, `dhash`,
// and `embedding` are all optional precisely so a photo imported before those
// fields existed still decodes today.
//
// Field-count note: the codegen packs the optional-field presence flags into a
// compact-uint. Through 7 optional fields the max flag value is 127, so it takes
// the fast path and reserves exactly ONE byte (state.end++). At the 8th optional
// field the max flag reaches 128 and the generator switches to a SYMMETRIC
// c.uint.preencode/encode(flags) — variable-width on both sides — so there is NO
// silent-corruption cliff (verified: n=8 and n=9 round-trip cleanly). Splitting
// into a nested struct past ~7 fields is still tidier, but it isn't a correctness
// requirement — Inv-4 (never remove/reorder/require an existing field) is.
import Hyperschema from 'hyperschema'

const schema = Hyperschema.from('./spec')
const shoebox = schema.namespace('shoebox')

shoebox.register({
  name: 'photo',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'takenAt', type: 'uint', required: true }, // epoch ms
    { name: 'mime', type: 'string', required: true },
    { name: 'byteLength', type: 'uint', required: true },
    // The blob's address inside the Hyperblobs core (Hyperblobs id fields).
    { name: 'blobsCoreKey', type: 'fixed32', required: true },
    { name: 'blockOffset', type: 'uint', required: true },
    { name: 'blockLength', type: 'uint', required: true },
    { name: 'byteOffset', type: 'uint', required: true },
    { name: 'blobByteLength', type: 'uint', required: true },
    // Added later (M2 / EXIF). Optional forever — the append-only contract.
    { name: 'width', type: 'uint' },
    { name: 'height', type: 'uint' },
    { name: 'orientation', type: 'uint' },
    { name: 'thumb', type: 'string' }, // ≤256px data: URL
    { name: 'dhash', type: 'string' }, // 16-hex dHash for near-duplicate clustering (Ch4)
    { name: 'embedding', type: 'buffer' }, // float32 scene embedding for semantic search (Ch4)
    // Ch7 M3: the content-key epoch this photo's thumb/bytes were encrypted under.
    // 0 = genesis; each revocation-rotation increments it. The 7th optional field —
    // still inside the codec's one-byte fast path (see the field-count note above).
    { name: 'epoch', type: 'uint' },
  ],
})

// Emit CommonJS — the worker (and desktop peek) load spec/ with require().
Hyperschema.toDisk(schema, { esm: false })
console.log('wrote spec/ — @shoebox/photo (cjs)')
