import React, { useEffect, useState } from 'react'
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
import type { PhotoRecord, VaultClient } from './vault-client'

const COLS = 3
const GAP = 2
const CELL = (Dimensions.get('window').width - GAP * (COLS + 1)) / COLS

/**
 * The library grid (Movement 3). It renders from the INDEX — each cell is a
 * ≤256px thumbnail the worker generated at import time and shipped as a data:
 * URL, so scrolling never touches an original. FlashList recycles cells, so
 * thousands of photos stay windowed. Tapping a cell is the only time a
 * full-resolution original is fetched — lazily, over the localhost blob-server.
 */
export function Grid({ client }: { client: VaultClient }) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([])
  const [open, setOpen] = useState<PhotoRecord | null>(null)

  useEffect(() => {
    client.list(1000).then(setPhotos).catch(() => setPhotos([]))
  }, [client])

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
          <Pressable onPress={() => setOpen(item)} style={styles.cell}>
            {item.thumb ? (
              <Image source={{ uri: item.thumb }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.noThumb]}>
                <Text style={styles.noThumbText}>{item.mime.split('/')[1] || '?'}</Text>
              </View>
            )}
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
  noThumb: { alignItems: 'center', justifyContent: 'center' },
  noThumbText: { color: '#777', fontSize: 11, fontFamily: 'Menlo' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#888' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  fullCaption: { color: '#ccc', fontSize: 12, fontFamily: 'Menlo', paddingTop: 12 },
})
