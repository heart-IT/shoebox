import React, { useEffect, useRef, useState } from 'react'
import {
  Button,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Worklet } from 'react-native-bare-kit'

// Bundle output by bare-pack (worker/: npm run bundle)
// @ts-ignore — .mjs module, resolved via metro.config.js sourceExts
import bundle from './worker.bundle.mjs'
import { SAMPLE_PHOTO_BASE64 } from './src/sample-photo'
import { documentsPath } from './src/paths'
import { requestRollPermission, rollModule, type RollAsset } from './src/roll'
import { bytesModule } from './src/bytes'
import { VaultClient } from './src/vault-client'
import { Meter, type Reading } from './src/meter'
import { Grid } from './src/Grid'

// How many photos the naive import stresses. Fixed so Movements 2/3/4 compare
// on the same workload.
const BATCH = 30

export default function App() {
  const [status, setStatus] = useState('starting worker…')
  const [link, setLink] = useState<string | null>(null)
  const [indexKey, setIndexKey] = useState<string | null>(null)
  const [rollCount, setRollCount] = useState<number | null>(null)
  const [rollPreview, setRollPreview] = useState<RollAsset[]>([])
  const [reading, setReading] = useState<Reading | null>(null)
  const [readingLabel, setReadingLabel] = useState('')
  const [showGrid, setShowGrid] = useState(false)
  const clientRef = useRef<VaultClient | null>(null)

  useEffect(() => {
    const worklet = new Worklet()
    // Filename must end in .bundle; argv[0] is the storage base.
    worklet.start('/worker.bundle', bundle, [documentsPath() ?? ''])

    const client = new VaultClient(worklet.IPC)
    clientRef.current = client

    client
      .stat()
      .then(s => setStatus(`vault ready — ${s.photos} photo(s)`))
      .catch(e => setStatus(`worker error: ${String(e)}`))

    return () => worklet.terminate()
  }, [])

  const openRoll = async () => {
    // Movement 1: metadata only. The count and page come back synchronously
    // through the typed seam — no bytes have moved yet.
    const granted = await requestRollPermission()
    if (!granted) return setStatus('photo permission denied')
    const roll = rollModule()
    if (!roll) return setStatus('ShoeboxRoll native module missing')
    setRollCount(roll.count())
    setRollPreview(roll.assets(0, 3))
  }

  const importOne = async () => {
    setStatus('importing…')
    try {
      const res = await clientRef.current!.importPhoto('hallway.png', SAMPLE_PHOTO_BASE64)
      setLink(res.link)
      setIndexKey(res.indexKey)
      setStatus('stored — no server involved')
    } catch (e) {
      setStatus(`import failed: ${String(e)}`)
    }
  }

  // Run a measured import over the same BATCH with a supplied per-asset step.
  // Movements 2 and 3 differ only in that step, so they compare on one workload.
  const measuredImport = async (
    label: string,
    step: (roll: any, a: RollAsset, meter: Meter) => Promise<void>,
  ) => {
    const granted = await requestRollPermission()
    if (!granted) return setStatus('photo permission denied')
    const roll = rollModule()
    const client = clientRef.current
    if (!roll || !client) return setStatus('roll or vault unavailable')

    const n = Math.min(BATCH, roll.count())
    const assets = roll.assets(0, n)
    setReading(null)
    setStatus(`importing ${n} (${label})…`)

    const meter = new Meter()
    meter.start(Date.now())
    try {
      for (const a of assets) {
        if (!a.path) continue // skip assets with no readable path (iOS)
        await step(roll, a, meter)
        meter.recordPhoto(a.byteLength)
      }
      const r = meter.stop(Date.now())
      setReading(r)
      setReadingLabel(label)
      const s = await client.stat()
      setStatus(`imported ${r.photos} (${label}) · vault now ${s.photos}`)
    } catch (e) {
      meter.stop(Date.now())
      setStatus(`import failed: ${String(e)}`)
    }
  }

  // Movement 2 — the measured wrong way: base64 string per photo over the RPC.
  const importRollNaive = () =>
    measuredImport('naive base64', async (roll, a, meter) => {
      const base64 = roll.readBase64(a.path) // whole file → JS string
      meter.recordInFlight(base64.length)
      await clientRef.current!.importPhoto(a.name, base64, a.takenAt)
    })

  // Movement 3 — hand-rolled C++ mmap: mapFile returns an ArrayBuffer that
  // points straight at the file's mapped pages (zero copy), released on GC. No
  // base64, no JSON. Same workload as naive; the meter tells the difference.
  const importRollZeroCopy = () => {
    const bytes = bytesModule()
    if (!bytes) return setStatus('ShoeboxBytes native module missing')
    return measuredImport('mmap bytes (C++)', async (_roll, a, meter) => {
      const buf: ArrayBuffer = bytes.mapFile(a.path)
      const view = new Uint8Array(buf)
      meter.recordInFlight(view.length)
      await clientRef.current!.importRaw({ name: a.name, takenAt: a.takenAt }, view)
    })
  }

  // Movement 4 — the reveal. Same ArrayBuffer result, but readBytes is a typed
  // Kotlin method: no hand-written C++, no JNI, no manual munmap. Nitro
  // generates the binding and its ArrayBuffer type states the ownership rule
  // that Movement 3 wrote by hand. The measurement lands next to the C++ one.
  const importRollNitro = () =>
    measuredImport('nitro bytes (Kotlin)', async (roll, a, meter) => {
      const buf: ArrayBuffer = roll.readBytes(a.path)
      const view = new Uint8Array(buf)
      meter.recordInFlight(view.length)
      await clientRef.current!.importRaw({ name: a.name, takenAt: a.takenAt }, view)
    })

  if (showGrid && clientRef.current) {
    return (
      <SafeAreaView style={styles.root}>
        <Button title="← back" onPress={() => setShowGrid(false)} />
        <Grid client={clientRef.current} />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Shoebox</Text>
        <Text style={styles.status}>{status}</Text>

        <Button title="Show grid" onPress={() => setShowGrid(true)} />
        <Button title="Import one photo" onPress={importOne} />
        <Button title="Open the roll" onPress={openRoll} />
        <Button title={`Import ${BATCH} (naive base64)`} onPress={importRollNaive} />
        <Button title={`Import ${BATCH} (mmap C++)`} onPress={importRollZeroCopy} />
        <Button title={`Import ${BATCH} (nitro Kotlin)`} onPress={importRollNitro} />

        {reading && (
          <View style={styles.meterBox}>
            <Text style={styles.meterTitle}>{readingLabel}</Text>
            <Text style={styles.meterLine}>
              {reading.throughputMBs.toFixed(2)} MB/s ·{' '}
              {(reading.bytes / 1e6).toFixed(1)} MB in {reading.seconds.toFixed(1)}s
            </Text>
            <Text style={styles.meterLine}>JS-thread stall: {reading.jsStallMs} ms worst</Text>
            <Text style={styles.meterLine}>
              peak in-flight: {(reading.peakInFlightBytes / 1e6).toFixed(2)} MB
            </Text>
          </View>
        )}

        {rollCount !== null && (
          <View style={styles.rollBox}>
            <Text style={styles.rollCount}>roll: {rollCount} photos</Text>
            {rollPreview.map(a => (
              <Text key={a.id} style={styles.rollLine}>
                {a.name} · {(a.byteLength / 1024).toFixed(0)} KB
              </Text>
            ))}
          </View>
        )}

        {link && (
          // The photo renders through a localhost HTTP URL served by the worker's
          // blob-server — the bytes never cross the IPC channel back to RN.
          <Image source={{ uri: link }} style={styles.photo} />
        )}

        {indexKey && (
          <View style={styles.keyBox}>
            <Text style={styles.keyLabel}>On a laptop: node peek.mjs {'↓'}</Text>
            <Text style={styles.key} selectable>
              {indexKey}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { alignItems: 'center', gap: 12, paddingTop: 48, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '700' },
  // Colors chosen to read on the OS dark theme (the default here); RN applies
  // no theme of its own, so light-gray text on the dark surface is deliberate.
  status: { fontSize: 14, color: '#aaa', textAlign: 'center', paddingHorizontal: 24 },
  photo: { width: 192, height: 192, borderRadius: 8 },
  keyBox: { paddingHorizontal: 24, alignItems: 'center', gap: 4 },
  meterBox: { alignItems: 'center', gap: 2, paddingVertical: 4 },
  meterTitle: { fontSize: 13, fontWeight: '700', color: '#ff6b6b' },
  meterLine: { fontSize: 13, color: '#e6e6e6', fontFamily: 'Menlo' },
  rollBox: { alignItems: 'center', gap: 2 },
  rollCount: { fontSize: 14, fontWeight: '600', color: '#ddd' },
  rollLine: { fontSize: 12, color: '#999', fontFamily: 'Menlo' },
  keyLabel: { fontSize: 12, color: '#aaa' },
  key: { fontSize: 12, fontFamily: 'Menlo', textAlign: 'center', color: '#8ab4f8' },
})
