/**
 * Pure-logic coverage for the import Meter (Movement 2's instrumentation). No
 * native worklet, no Nitro — this runs in plain jest. It replaces the template
 * `renders <App/>` smoke, which asserted nothing and needed the Bare thread.
 */
import { Meter } from '../src/meter'

test('Meter accumulates totals, tracks peak in-flight, and computes throughput', () => {
  const m = new Meter()
  m.start(0)
  m.recordInFlight(1000)
  m.recordInFlight(500) // smaller — peak must stay 1000
  m.recordPhoto(2_000_000)
  m.recordPhoto(1_000_000)
  const r = m.stop(3000) // 3 seconds elapsed

  expect(r.photos).toBe(2)
  expect(r.bytes).toBe(3_000_000)
  expect(r.seconds).toBe(3)
  expect(r.throughputMBs).toBeCloseTo(1.0, 6) // 3 MB / 3 s
  expect(r.peakInFlightBytes).toBe(1000)
})

test('Meter guards against a zero-duration run (no divide-by-zero)', () => {
  const m = new Meter()
  m.start(1000)
  m.recordPhoto(500)
  const r = m.stop(1000) // same instant → 0 seconds

  expect(r.seconds).toBe(0)
  expect(r.throughputMBs).toBe(0)
})
