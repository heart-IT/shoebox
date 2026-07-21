// The suspend→resume exception filter (Ch8 M2, Inv-10). When the OS backgrounds
// the app, the kernel closes Bare's sockets behind its back; on resume, Bare
// cleans up sockets that are already dead and throws from callbacks with no JS
// catcher — crashing the worklet every time the user re-focuses. The filter
// swallows exactly that failure class, exactly in that window, and re-throws
// everything else, always: an unrelated bug must crash loudly in every app state.
// Host-agnostic — the emitter is Bare in the worklet, process under Node tests.

// The narrow allowlist. Do NOT widen it: any code beyond kernel-initiated
// socket teardown would paper over real bugs.
const BENIGN_SOCKET_CODES = new Set(['ENOTCONN', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'])

// Teardown errors surface WRAPPED out of hyperswarm/secret-stream internals, so
// checking only err.code misses most of them — walk the cause chain. Bounded,
// so a cyclic or absurdly deep chain can't spin the crash handler.
const MAX_CAUSE_HOPS = 8

function isBenignSocketError (err) {
  for (let e = err, hops = 0; e && hops < MAX_CAUSE_HOPS; e = e.cause, hops++) {
    if (e.code && BENIGN_SOCKET_CODES.has(e.code)) return true
  }
  return false
}

// The window the filter is live in: from the moment a suspend begins until
// settleMs after the resume completes — dead-socket cleanup fires DURING and
// shortly AFTER resume, not neatly inside the suspended state. Clock injected
// for testability; callers omit it.
function createSuspensionWindow ({ settleMs = 5000 } = {}) {
  let suspended = false
  let settleUntil = 0
  return {
    onSuspend () {
      suspended = true
      settleUntil = 0
    },
    onResume (now = Date.now()) {
      suspended = false
      settleUntil = now + settleMs
    },
    isOpen (now = Date.now()) {
      return suspended || now < settleUntil
    },
  }
}

// Installs the filter on the host's uncaught-exception hook. Swallowing is
// LOGGED (a silent crash-eater is worse than a crash); everything outside
// benign-and-in-window re-throws, which is fatal on both Bare and Node —
// exactly the pre-filter behavior.
function installSuspensionFilter (emitter, window, { log = () => {} } = {}) {
  const handler = (err) => {
    if (window.isOpen() && isBenignSocketError(err)) {
      log('suppressed benign socket teardown in suspend/resume window: ' + String((err && (err.code || err.message)) || err))
      return
    }
    throw err
  }
  emitter.on('uncaughtException', handler)
  return () => emitter.off('uncaughtException', handler)
}

module.exports = { isBenignSocketError, createSuspensionWindow, installSuspensionFilter, BENIGN_SOCKET_CODES, MAX_CAUSE_HOPS }
