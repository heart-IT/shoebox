// Typed errors across the worker boundary (audit AF-M13).
//
// Errors used to cross the RPC as stringified stack traces, so the app could
// only ever show a wall of text — it could not tell "you aren't the owner" from
// "the worker is mid-join, retry" from a genuine internal fault, and could not
// branch on any of them. Every error the app is expected to handle now carries
// a stable `code`; the human message stays alongside it for display.
//
// Codes are a wire contract like the command ids: append, never repurpose.
const CODES = {
  EBOOT: 'the worker failed to start',
  EBUSY_JOINING: 'a JOIN is in flight; the vault is briefly unavailable',
  EBUSY: 'too many in-flight requests',
  EPAYLOAD: 'request payload too large',
  ECOMMAND: 'unknown command id',
  ENOTOWNER: 'this device is not the album owner',
  EBADKEY: 'a key argument was malformed',
  EEMPTY: 'refused an empty photo',
  EEPOCHKEY: "this album epoch's content key has not arrived yet",
  EPAIRTIMEOUT: 'pairing timed out',
  EPAIRDENIED: 'pairing was rejected (bad or spent invite)',
  EJOINED: 'this device has already joined a library',
  ENOTFRESH: 'refused: this device already holds data',
  EMNEMONIC: 'the recovery words are not valid',
  ECORRUPT: 'a persisted key artifact is corrupt',
  EINTERNAL: 'unexpected internal error',
}

function codedError (code, message) {
  return Object.assign(new Error(message), { code })
}

// The code to report for a thrown value — its own, or EINTERNAL for anything
// that escaped without one.
function codeOf (err) {
  return (err && err.code && CODES[err.code]) ? err.code : 'EINTERNAL'
}

module.exports = { CODES, codedError, codeOf }
