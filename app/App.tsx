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
import { VaultClient } from './src/vault-client'
import { Meter, type Reading } from './src/meter'

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

  // Movement 2 — the measured wrong way. Read each asset into a base64 string
  // and ship it over the RPC, one round-trip per photo. The meter records what
  // that costs; the numbers are the argument for Movement 3.
  const importRollNaive = async () => {
    const granted = await requestRollPermission()
    if (!granted) return setStatus('photo permission denied')
    const roll = rollModule()
    const client = clientRef.current
    if (!roll || !client) return setStatus('roll or vault unavailable')

    const n = Math.min(BATCH, roll.count())
    const assets = roll.assets(0, n)
    setReading(null)
    setStatus(`importing ${n} (naive base64)…`)

    const meter = new Meter()
    meter.start(Date.now())
    let last: RollAsset | null = null
    try {
      for (const a of assets) {
        if (!a.path) continue // skip assets with no readable path (iOS)
        const base64 = roll.readBase64(a.path) // whole file → JS string
        meter.recordInFlight(base64.length)
        await client.importPhoto(a.name, base64)
        meter.recordPhoto(a.byteLength)
        last = a
      }
      const r = meter.stop(Date.now())
      setReading(r)
      setStatus(`imported ${r.photos} photos, naive`)
      if (last) {
        const s = await client.stat()
        setStatus(`imported ${r.photos} · vault now ${s.photos}`)
      }
    } catch (e) {
      meter.stop(Date.now())
      setStatus(`roll import failed: ${String(e)}`)
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Shoebox</Text>
        <Text style={styles.status}>{status}</Text>

        <Button title="Import one photo" onPress={importOne} />
        <Button title="Open the roll" onPress={openRoll} />
        <Button title={`Import ${BATCH} (naive base64)`} onPress={importRollNaive} />

        {reading && (
          <View style={styles.meterBox}>
            <Text style={styles.meterTitle}>naive import</Text>
            <Text style={styles.meterLine}>
              {reading.throughputMBs.toFixed(2)} MB/s ·{' '}
              {(reading.bytes / 1e6).toFixed(1)} MB in {reading.seconds.toFixed(1)}s
            </Text>
            <Text style={styles.meterLine}>JS-thread stall: {reading.jsStallMs} ms worst</Text>
            <Text style={styles.meterLine}>
              peak in-flight: {(reading.peakInFlightBytes / 1e6).toFixed(2)} MB (base64)
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
