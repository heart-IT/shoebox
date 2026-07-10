import type { HybridObject } from 'react-native-nitro-modules'

/**
 * The first Nitro HybridObject of the series: typed, synchronous access to the
 * platform's documents directory, where the vault's Corestore lives.
 */
export interface ShoeboxPaths
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  getDocumentsPath(): string
}
