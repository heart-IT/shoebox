// Audit AF-H9: the worker bundle (app/worker.bundle.mjs) is git-committed, so
// nothing but discipline keeps it in sync with worker/ source — one forgotten
// `npm run bundle:worker` silently ships a stale (or security-fix-missing)
// kernel. This is the minimum-bar freshness gate (HP-MOBILE-WORKER-FRESHNESS):
// hash the worker source and compare to the hash recorded at bundle time.
//
//   node check-bundle.mjs           → verify (exit 1 if stale)
//   node check-bundle.mjs --write   → record the current source hash (run by bundle:worker)
//
// Wire `npm run check:bundle` into precommit/CI so a stale bundle fails the build.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.resolve(here, '../worker')
const hashFile = path.join(here, 'worker.bundle.hash')

// Every runtime source file the bundle is built from — all .js under worker/,
// excluding node_modules, the test suite, and codegen tooling.
function sourceFiles (dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, acc)
    else if (e.name.endsWith('.js')) acc.push(p)
  }
  return acc
}

function sourceHash () {
  const files = sourceFiles(workerDir).map((p) => path.relative(workerDir, p)).sort()
  const h = crypto.createHash('sha256')
  for (const rel of files) { h.update(rel); h.update(fs.readFileSync(path.join(workerDir, rel))) }
  return h.digest('hex')
}

const current = sourceHash()

if (process.argv[2] === '--write') {
  fs.writeFileSync(hashFile, current + '\n')
  console.log('worker.bundle.hash ←', current.slice(0, 12))
} else {
  const recorded = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf-8').trim() : null
  if (current !== recorded) {
    console.error(`✗ worker.bundle.mjs is STALE: worker source ${current.slice(0, 12)} ≠ recorded ${String(recorded).slice(0, 12)}. Run: npm run bundle:worker`)
    process.exit(1)
  }
  console.log('✓ worker bundle is fresh (' + current.slice(0, 12) + ')')
}
