/**
 * The instrumentation Movement 2 needs — the numbers ARE the argument. Three
 * readings, all measurable honestly on-device without a profiler:
 *
 *  - throughput: bytes imported per wall-second.
 *  - jsStallMs: the worst gap between ticks of a 16ms heartbeat on the JS
 *    thread during the run. Every millisecond over 16 is a frame the UI could
 *    not paint — this is the "grid stalls" symptom as a number.
 *  - peakInFlightBytes: the largest single base64 payload held in JS at once.
 *    A direct proxy for the RSS climb: the naive path inflates each file ~1.33×
 *    into a string on the JS heap before it crosses the IPC.
 */
export interface Reading {
  photos: number
  bytes: number
  seconds: number
  throughputMBs: number
  jsStallMs: number
  peakInFlightBytes: number
}

export class Meter {
  private t0 = 0
  private lastTick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  bytes = 0
  photos = 0
  jsStallMs = 0
  peakInFlightBytes = 0

  start(nowMs: number): void {
    this.t0 = nowMs
    this.lastTick = nowMs
    // A heartbeat on the JS thread. When a synchronous chunk (base64 read,
    // JSON serialize) blocks the thread, this interval fires late; the lateness
    // is the stall.
    this.timer = setInterval(() => {
      const now = Date.now()
      const gap = now - this.lastTick
      if (gap > this.jsStallMs) this.jsStallMs = gap
      this.lastTick = now
    }, 16)
  }

  recordInFlight(byteLen: number): void {
    if (byteLen > this.peakInFlightBytes) this.peakInFlightBytes = byteLen
  }

  recordPhoto(byteLen: number): void {
    this.photos++
    this.bytes += byteLen
  }

  stop(nowMs: number): Reading {
    if (this.timer) clearInterval(this.timer)
    const seconds = (nowMs - this.t0) / 1000
    return {
      photos: this.photos,
      bytes: this.bytes,
      seconds,
      throughputMBs: seconds > 0 ? this.bytes / 1e6 / seconds : 0,
      jsStallMs: this.jsStallMs,
      peakInFlightBytes: this.peakInFlightBytes,
    }
  }
}
