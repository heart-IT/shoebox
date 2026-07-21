import React, { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  Button,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { embedModule, packEmbedding } from './src/embed'
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
  const [invite, setInvite] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [showMembers, setShowMembers] = useState(false)
  const [members, setMembers] = useState<{ writerKey: string; role: string }[]>([])
  const clientRef = useRef<VaultClient | null>(null)
  // Reentrancy guard: import buttons don't disable themselves, so a double-tap
  // (or tapping a second import mid-run) would interleave two batches into the
  // vault and stomp the meter/status. One import at a time.
  const busyRef = useRef(false)

  useEffect(() => {
    const worklet = new Worklet()
    // Filename must end in .bundle; argv[0] is the storage base.
    worklet.start('/worker.bundle', bundle, [documentsPath() ?? ''])

    // Surface a failed/dead worker instead of a stale "vault ready".
    const client = new VaultClient(worklet.IPC, msg => setStatus(`worker error: ${msg}`))
    clientRef.current = client

    client
      .stat()
      .then(s => setStatus(`vault ready — ${s.photos} photo(s)`))
      .catch(e => setStatus(`worker error: ${String(e)}`))

    // Forward the OS lifecycle to the worklet. On background, suspend the swarm
    // and the localhost blob-server socket — otherwise they stay open, iOS kills
    // the process and the battery drains. Resume on return to foreground.
    // Best-effort: a suspend/resume rejection must never crash the app. We only
    // act on 'background' (not the transient iOS 'inactive'), and 'active'.
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background') client.suspend().catch(() => {})
      else if (next === 'active') client.resume().catch(() => {})
    })

    return () => {
      sub.remove()
      worklet.terminate()
    }
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
    if (busyRef.current) return
    busyRef.current = true
    setStatus('importing…')
    try {
      const res = await clientRef.current!.importPhoto('hallway.png', SAMPLE_PHOTO_BASE64)
      setLink(res.link)
      setIndexKey(res.indexKey)
      setStatus('stored — no server involved')
    } catch (e) {
      setStatus(`import failed: ${String(e)}`)
    } finally {
      busyRef.current = false
    }
  }

  // Invite a second device to join as a WRITER. The code is one-time; the laptop
  // runs `node join.mjs <invite>` and, once added, can import into this library.
  const inviteDevice = async () => {
    setStatus('creating invite…')
    try {
      const res = await clientRef.current!.createInvite()
      setInvite(res.invite)
      setStatus('invite ready — pair a laptop with join.mjs')
    } catch (e) {
      setStatus(`invite failed: ${String(e)}`)
    }
  }

  // The OTHER side of "Invite a device": THIS phone joins an existing library with
  // a pasted invite (Ch7 M4). The worker pairs over the DHT, receives the library +
  // album keys, persists them, and reboots as a member — so this device now reads
  // and writes the shared album. One-way: a device joins one library.
  const joinLibrary = async () => {
    const code = joinCode.trim()
    if (!code) return setStatus('paste an invite code first')
    setStatus('joining… (pairing over the DHT — up to a minute)')
    try {
      const res = await clientRef.current!.join(code)
      setJoinCode('')
      const s = await clientRef.current!.stat().catch(() => null)
      setStatus(`joined ${res.libraryKey.slice(0, 12)}… — a member now${s ? `, ${s.photos} photo(s)` : ''}`)
    } catch (e) {
      setStatus(`join failed: ${String(e)}`)
    }
  }

  // The album roster + revocation. The owner sees every member and can kick one;
  // a kicked member's FUTURE writes are blocked (their existing photos remain).
  const openMembers = async () => {
    try {
      const res = await clientRef.current!.members()
      setMembers(res.members)
      setShowMembers(true)
    } catch (e) {
      setStatus(`members failed: ${String(e)}`)
    }
  }

  // Revocation is forward-irreversible (the member can't be un-revoked into their
  // old identity), so confirm before kicking.
  const confirmKick = (writerKey: string) => {
    Alert.alert('Remove member?', `Revoke ${writerKey.slice(0, 12)}…? Their future writes stop; photos they already shared remain.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => kick(writerKey) },
    ])
  }

  const kick = async (writerKey: string) => {
    setStatus('revoking…')
    try {
      await clientRef.current!.removeMember(writerKey)
      const res = await clientRef.current!.members()
      setMembers(res.members)
      setStatus('member revoked — their future writes are blocked')
    } catch (e) {
      setStatus(`revoke failed: ${String(e)}`)
    }
  }

  // Run a measured import over the same BATCH with a supplied per-asset step.
  // Movements 2 and 3 differ only in that step, so they compare on one workload.
  const measuredImport = async (
    label: string,
    step: (roll: any, a: RollAsset, meter: Meter) => Promise<void>,
  ) => {
    if (busyRef.current) return
    const granted = await requestRollPermission()
    if (!granted) return setStatus('photo permission denied')
    const roll = rollModule()
    const client = clientRef.current
    if (!roll || !client) return setStatus('roll or vault unavailable')

    busyRef.current = true
    const n = Math.min(BATCH, roll.count())
    const assets = roll.assets(0, n)
    setReading(null)
    setStatus(`importing ${n} (${label})…`)

    const meter = new Meter()
    meter.start(Date.now())
    let failures = 0
    try {
      for (const a of assets) {
        if (!a.path) continue // skip assets with no readable path (iOS)
        try {
          // Per-photo isolation: one unreadable/corrupt file must not abort the
          // whole batch.
          await step(roll, a, meter)
          meter.recordPhoto(a.byteLength)
        } catch {
          failures++
        }
      }
      const r = meter.stop(Date.now())
      setReading(r)
      setReadingLabel(label)
      const s = await client.stat().catch(() => null)
      const skipped = failures ? ` (${failures} skipped)` : ''
      setStatus(`imported ${r.photos} (${label})${skipped}${s ? ` · vault now ${s.photos}` : ''}`)
    } finally {
      busyRef.current = false
    }
  }

  // Movement 2 — the measured wrong way: base64 string per photo over the RPC.
  const importRollNaive = () =>
    measuredImport('naive base64', async (roll, a, meter) => {
      const base64 = roll.readBase64(a.path) // whole file → JS string
      meter.recordInFlight(base64.length)
      await clientRef.current!.importPhoto(a.name, base64, a.takenAt)
    })

  // Import + index: mmap the bytes AND run the on-device embedding model over
  // each photo (Ch4). The vector is computed on the phone and stored in the
  // index next to the photo — pixels never leave (Inv-5). Slower than a plain
  // import because inference runs per photo (the "backfill is expensive" cost).
  const importRollZeroCopy = () => {
    const bytes = bytesModule()
    const embed = embedModule()
    if (!bytes) return setStatus('ShoeboxBytes native module missing')
    return measuredImport('import + embed', async (_roll, a, meter) => {
      const buf: ArrayBuffer = bytes.mapFile(a.path)
      const view = new Uint8Array(buf)
      meter.recordInFlight(view.length)
      let embedding: string | undefined
      if (embed) {
        // await: embed() is async now (inference runs off the JS thread).
        try { embedding = packEmbedding(await embed.embed(a.path)) } catch { /* skip */ }
      }
      await clientRef.current!.importRaw({ name: a.name, takenAt: a.takenAt, embedding }, view)
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

  if (showMembers && clientRef.current) {
    return (
      <SafeAreaView style={styles.root}>
        <Button title="← back" onPress={() => setShowMembers(false)} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Members</Text>
          {members.map(m => (
            <View
              key={m.writerKey}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 }}
            >
              <Text style={{ color: '#ccc', fontFamily: 'Menlo', fontSize: 13 }}>
                {m.role} · {m.writerKey.slice(0, 12)}…
              </Text>
              {m.role !== 'owner' && <Button title="Kick" onPress={() => confirmKick(m.writerKey)} />}
            </View>
          ))}
          {members.length === 0 && <Text style={styles.status}>No members yet.</Text>}
        </ScrollView>
      </SafeAreaView>
    )
  }

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
        <Button title="Invite a device" onPress={inviteDevice} />
        <View style={styles.joinBox}>
          <TextInput
            style={styles.input}
            value={joinCode}
            onChangeText={setJoinCode}
            placeholder="paste an invite to join a library"
            placeholderTextColor="#777"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title="Join a library" onPress={joinLibrary} />
        </View>
        <Button title="Members" onPress={openMembers} />
        <Button title="Open the roll" onPress={openRoll} />
        <Button title={`Import ${BATCH} (naive base64)`} onPress={importRollNaive} />
        <Button title={`Import + embed ${BATCH}`} onPress={importRollZeroCopy} />
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
            <Text style={styles.keyLabel}>Library key (encrypted — peek needs the album key too) {'↓'}</Text>
            <Text style={styles.key} selectable>
              {indexKey}
            </Text>
          </View>
        )}

        {invite && (
          <View style={styles.keyBox}>
            <Text style={styles.keyLabel}>Pair a device: node join.mjs {'↓'}</Text>
            <Text style={styles.key} selectable>
              {invite}
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
  joinBox: { alignItems: 'center', gap: 6, paddingHorizontal: 24, alignSelf: 'stretch' },
  input: { alignSelf: 'stretch', borderWidth: 1, borderColor: '#444', borderRadius: 6, color: '#eee', paddingHorizontal: 12, paddingVertical: 8, fontFamily: 'Menlo', fontSize: 12 },
})
