// Vault smoke test under Node — proves the worker core is host-agnostic:
// import a photo, serve it over the blob-server, fetch it back byte-for-byte.
import { createRequire } from 'module'
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const { Vault } = require('../vault.js')

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-smoke-'))
const vault = new Vault(dir)
await vault.ready()

const { link, indexKey, seq } = await vault.importPhoto(PNG_1PX, 'test.png')
assert.equal(seq, 0, 'first photo lands at seq 0')
assert.ok(indexKey.length > 0, 'index key is z-base-32 encoded')

const res = await fetch(link)
assert.equal(res.status, 200, `blob-server responds 200 (got ${res.status})`)
const body = Buffer.from(await res.arrayBuffer())
assert.ok(body.equals(PNG_1PX), 'bytes served match bytes stored')

assert.equal(await vault.count(), 1)

await vault.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`smoke: ok — stored ${PNG_1PX.byteLength} bytes, served back identical via ${new URL(link).origin}`)
