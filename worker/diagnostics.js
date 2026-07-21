// A bounded, flushable diagnostics ring (audit AF-M13).
//
// A no-server app has no server logs. When a user says "it stopped syncing" or
// "it won't open", `console.error` went to logcat on a device nobody has — there
// was no evidence at all. This keeps a small in-memory ring of recent events and
// writes it to disk on demand.
//
// Two deliberate properties:
//   * BOUNDED — a fixed number of entries and a byte cap on the file, so a
//     crash-loop can't fill the user's storage with its own complaints.
//   * FLUSHED ON SUSPEND, not only on crash — the OS can freeze or kill a
//     backgrounded app without warning (Inv-10), so waiting for a crash handler
//     to write the evidence means usually losing it.
//
// It records operational events, never secrets: no seeds, no keys, no
// mnemonics, no photo contents.

const DEFAULTS = { maxEntries: 200, maxBytes: 256 * 1024 }

function createDiagnostics (fs, filePath, opts = {}) {
  const { maxEntries, maxBytes } = { ...DEFAULTS, ...opts }
  const entries = []
  let dropped = 0

  return {
    // level: 'info' | 'warn' | 'error'. `at` is injectable so tests are
    // deterministic; production passes nothing and gets the wall clock.
    log (level, message, at = Date.now()) {
      entries.push(`${new Date(at).toISOString()} ${level} ${message}`)
      while (entries.length > maxEntries) { entries.shift(); dropped++ }
    },

    get size () { return entries.length },
    get dropped () { return dropped },
    lines () { return entries.slice() },

    // Write the ring to disk, newest-truncated to maxBytes. Best-effort by
    // contract: diagnostics must NEVER be the reason a suspend or teardown
    // fails, so every error here is swallowed.
    flush () {
      try {
        const header = dropped > 0 ? [`(${dropped} earlier entries dropped)`] : []
        let text = header.concat(entries).join('\n') + '\n'
        if (text.length > maxBytes) text = text.slice(text.length - maxBytes)
        const tmp = filePath + '.tmp'
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, filePath)
        return true
      } catch {
        return false
      }
    },
  }
}

module.exports = { createDiagnostics, DEFAULTS }
