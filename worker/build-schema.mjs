// Build-time codegen for the vault's on-disk record format (run: node
// build-schema.mjs). Hyperschema emits compact-encoding codecs into spec/.
// Inv-4: this schema is an append-only contract — you may add OPTIONAL fields
// forever*, but never remove one or make an old one required, or records written
// by past versions stop decoding. `orientation`, `width`, `height`, and `thumb`
// are all optional precisely so a photo imported before those fields existed
// still decodes today.
//
// * NOT literally forever: the generated encoder reserves ONE byte for the
//   optional-field presence flags (compact uint, 1 byte holds ≤252). With 7
//   optional fields the flag bitmask maxes at 127 (still 1 byte); the 8th
//   optional field pushes it past 252 and needs 3 bytes the codegen doesn't
//   reserve → corruption. We have 4. If you approach 7-8, split into a nested
//   struct rather than adding a flat 8th optional field.
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
  ],
})

// Emit CommonJS — the worker (and desktop peek) load spec/ with require().
Hyperschema.toDisk(schema, { esm: false })
console.log('wrote spec/ — @shoebox/photo (cjs)')
