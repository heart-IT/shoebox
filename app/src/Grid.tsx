import React, { useEffect, useMemo, useState } from 'react'
import {
  Dimensions,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { hamming, type PhotoRecord, type VaultClient } from './vault-client'
import { cosine, unpackEmbedding } from './embed'

const COLS = 3
const GAP = 2
const CELL = (Dimensions.get('window').width - GAP * (COLS + 1)) / COLS
// dHash Hamming distance below this = near-duplicate (bursts, re-saves, crops).
const NEAR_DUP = 12
// A solid/blank image dHashes to all zeros; that would falsely match every other
// blank image, so it's excluded from near-dup matching.
const DEGENERATE = '0000000000000000'

/**
 * The library grid (Movement 3–4). It renders from the INDEX — each cell is a
 * ≤256px thumbnail the worker generated at import time. Tapping a cell shows the
 * original (fetched lazily) plus near-duplicates (dHash Hamming) and most-similar
 * (embedding cosine), both computed offline over the index columns — never over
 * pixels, nothing leaving the phone.
 */
export function Grid({ client }: { client: VaultClient }) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<PhotoRecord | null>(null)

  useEffect(() => {
    // Known scaling limit (v1.0): this pulls the WHOLE index in one LIST — every
    // record's base64 data: thumbnail and float32 embedding inline — and holds it
    // in state. Fine at demo scale (hundreds of photos); a real 10k+ library needs
    // a windowed/paginated LIST plus thumbnails served over the blob-server as
    // URLs (like originals). Moving thumbnails to blob pointers just means adding
    // optional schema fields — safe under the append-only contract (Inv-4); the
    // codegen handles >7 optional fields via variable-width flags (there is no
    // "flag-byte cliff" — that earlier claim was wrong, see VERSIONS.md F4). It's
    // deferred for RAM/pagination reasons, not a schema blocker.
    // residency: true → each record says whether its original is hot (local)
    // or cold (evicted; re-fetches from a peer on tap) — Ch9.
    client.list(1000, true).then(
      (p) => { setPhotos(p); setError(null) },
      (e) => setError(String(e)),
    )
  }, [client])

  // Near-duplicates over the dHash column — memoized so it isn't recomputed on
  // every render (only when the open photo or the library changes).
  const nearDups = useMemo(() => {
    if (!open || !open.dhash || open.dhash === DEGENERATE) return []
    return photos.filter(
      (p) => p.id !== open.id && p.dhash && p.dhash !== DEGENERATE && hamming(p.dhash, open.dhash) <= NEAR_DUP,
    )
  }, [open, photos])

  // Most-similar over the embedding column (cosine), memoized likewise.
  const similar = useMemo(() => {
    if (!open || !open.embedding) return []
    const q = unpackEmbedding(open.embedding)
    return photos
      .filter((p) => p.id !== open.id && p.embedding)
      .map((p) => ({ p, s: cosine(q, unpackEmbedding(p.embedding)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
  }, [open, photos])

  if (error) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Couldn't load the library: {error}</Text>
      </View>
    )
  }
  if (photos.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No photos yet — import the roll first.</Text>
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <Text style={styles.count}>{photos.length} photos · newest first</Text>
      <FlashList
        data={photos}
        numColumns={COLS}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              // Opening fetches the original via the blob-server, so it's hot
              // now — clear the ❄ badge optimistically (Ch9/AF-L).
              if (item.resident === false) {
                setPhotos(ps => ps.map(p => (p.id === item.id ? { ...p, resident: true } : p)))
              }
              setOpen(item)
            }}
            style={styles.cell}
          >
            {item.thumb ? (
              <Image source={{ uri: item.thumb }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.noThumb]}>
                <Text style={styles.noThumbText}>{item.mime.split('/')[1] || '?'}</Text>
              </View>
            )}
            {item.resident === false && <Text style={styles.coldBadge}>❄</Text>}
          </Pressable>
        )}
      />

      <Modal visible={open !== null} transparent onRequestClose={() => setOpen(null)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(null)}>
          {open && (
            // Only NOW is an original fetched — lazily, on tap, via blob-server.
            <Image source={{ uri: open.link }} style={styles.full} resizeMode="contain" />
          )}
          {open && <Text style={styles.fullCaption}>{open.name}</Text>}

          {open && (
            <View style={styles.dupBar}>
              <Text style={styles.dupLabel}>
                {nearDups.length
                  ? `${nearDups.length} near-duplicate${nearDups.length > 1 ? 's' : ''}`
                  : 'no near-duplicates'}
              </Text>
              <View style={styles.dupRow}>
                {nearDups.slice(0, 6).map((d) => (
                  <Pressable key={d.id} onPress={() => setOpen(d)}>
                    <Image source={{ uri: d.thumb }} style={styles.dupThumb} />
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {open && similar.length > 0 && (
            <View style={styles.dupBar}>
              <Text style={styles.dupLabel}>most similar (on-device model)</Text>
              <View style={styles.dupRow}>
                {similar.map(({ p, s }) => (
                  <Pressable key={p.id} onPress={() => setOpen(p)}>
                    <Image source={{ uri: p.thumb }} style={styles.dupThumb} />
                    <Text style={styles.simScore}>{s.toFixed(2)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </Pressable>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 8 },
  count: { color: '#aaa', fontSize: 12, textAlign: 'center', paddingBottom: 6 },
  cell: { width: CELL, height: CELL, margin: GAP / 2 },
  thumb: { width: '100%', height: '100%', borderRadius: 3, backgroundColor: '#222' },
  // Cold original (evicted): the thumbnail renders as always; the badge says
  // the full-resolution bytes live on a peer until tapped.
  coldBadge: { position: 'absolute', top: 3, right: 5, fontSize: 11, color: '#8ab4f8' },
  noThumb: { alignItems: 'center', justifyContent: 'center' },
  noThumbText: { color: '#777', fontSize: 11, fontFamily: 'Menlo' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyText: { color: '#888', textAlign: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '70%' },
  fullCaption: { color: '#ccc', fontSize: 12, fontFamily: 'Menlo', paddingTop: 12 },
  dupBar: { alignItems: 'center', paddingTop: 16 },
  dupLabel: { color: '#8ab4f8', fontSize: 13, fontWeight: '600', paddingBottom: 8 },
  dupRow: { flexDirection: 'row', gap: 4 },
  dupThumb: { width: 52, height: 52, borderRadius: 4, backgroundColor: '#222' },
  simScore: { color: '#777', fontSize: 9, textAlign: 'center', fontFamily: 'Menlo' },
})
