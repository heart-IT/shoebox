import type { HybridObject } from 'react-native-nitro-modules'
// Nitro maps the global `ArrayBuffer` type to a native ArrayBuffer.

/**
 * Movement 3, the hand-rolled version (read-along). One C++ base implementation
 * for both platforms — no Swift/Kotlin bridge, because the lesson IS the C++:
 * mmap the file and hand JS an ArrayBuffer that points straight at the mapped
 * pages, with NO copy. The mapping is released (munmap) only when JS drops the
 * buffer — explicit lifetime ownership across the boundary (Inv-3), written by
 * hand so you can see the contract Nitro's typed ArrayBuffer (Movement 4)
 * states for you.
 */
export interface ShoeboxBytes
  extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** mmap `path` and wrap the mapped pages as an ArrayBuffer — zero copy. */
  mapFile(path: string): ArrayBuffer
}
