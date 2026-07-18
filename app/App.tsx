import React, { useEffect, useRef, useState } from 'react'
import {
  Button,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Worklet } from 'react-native-bare-kit'
import FramedStream from 'framed-stream'
import b4a from 'b4a'

// Bundle output by bare-pack (worker/: npm run bundle)
// @ts-ignore — .mjs module, resolved via metro.config.js sourceExts
import bundle from './worker.bundle.mjs'
import { SAMPLE_PHOTO_BASE64 } from './src/sample-photo'
import { documentsPath } from './src/paths'
import { requestRollPermission, rollModule, type RollAsset } from './src/roll'

type WorkerMessage =
  | { type: 'ready'; photos: number }
  | { type: 'imported'; link: string; indexKey: string; seq: number }
  | { type: 'error'; message: string }

export default function App() {
  const [status, setStatus] = useState('starting worker…')
  const [link, setLink] = useState<string | null>(null)
  const [indexKey, setIndexKey] = useState<string | null>(null)
  const [rollCount, setRollCount] = useState<number | null>(null)
  const [rollPreview, setRollPreview] = useState<RollAsset[]>([])
  const streamRef = useRef<InstanceType<typeof FramedStream> | null>(null)

  useEffect(() => {
    const worklet = new Worklet()
    // Filename must end in .bundle; argv[0] is the storage base.
    worklet.start('/worker.bundle', bundle, [documentsPath() ?? ''])

    const stream = new FramedStream(worklet.IPC)
    stream.on('data', (data: Uint8Array) => {
      const msg: WorkerMessage = JSON.parse(b4a.toString(data))
      if (msg.type === 'ready') {
        setStatus(`vault ready — ${msg.photos} photo(s)`)
      } else if (msg.type === 'imported') {
        setLink(msg.link)
        setIndexKey(msg.indexKey)
        setStatus('stored — no server involved')
      } else {
        setStatus(`worker error: ${msg.message}`)
      }
    })
    streamRef.current = stream

    return () => worklet.terminate()
  }, [])

  const openRoll = async () => {
    // Movement 1: metadata only. The count and page come back synchronously
    // through the typed seam — no bytes have moved yet.
    const granted = await requestRollPermission()
    if (!granted) {
      setStatus('photo permission denied')
      return
    }
    const roll = rollModule()
    if (!roll) {
      setStatus('ShoeboxRoll native module missing')
      return
    }
    setRollCount(roll.count())
    setRollPreview(roll.assets(0, 3))
  }

  const importPhoto = () => {
    setStatus('importing…')
    streamRef.current?.write(
      b4a.from(
        JSON.stringify({
          type: 'import',
          name: 'hallway.png',
          dataBase64: SAMPLE_PHOTO_BASE64,
        }),
      ),
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Shoebox</Text>
      <Text style={styles.status}>{status}</Text>

      <Button title="Import one photo" onPress={importPhoto} />
      <Button title="Open the roll" onPress={openRoll} />

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
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', gap: 16, paddingTop: 64 },
  title: { fontSize: 28, fontWeight: '700' },
  status: { fontSize: 14, color: '#666' },
  photo: { width: 192, height: 192, borderRadius: 8 },
  keyBox: { paddingHorizontal: 24, alignItems: 'center', gap: 4 },
  rollBox: { alignItems: 'center', gap: 2 },
  rollCount: { fontSize: 14, fontWeight: '600' },
  rollLine: { fontSize: 12, color: '#666', fontFamily: 'Menlo' },
  keyLabel: { fontSize: 12, color: '#666' },
  key: { fontSize: 12, fontFamily: 'Menlo', textAlign: 'center' },
})
