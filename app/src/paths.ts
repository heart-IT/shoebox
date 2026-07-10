import { NitroModules } from 'react-native-nitro-modules'
import type { ShoeboxPaths } from './specs/shoebox-paths.nitro'

/**
 * Storage base for the vault. Falls back to null (worker uses its tmpdir) if
 * the native HybridObject isn't registered — lets the JS run before the native
 * build step, and the failure is visible instead of fatal.
 */
export function documentsPath(): string | null {
  try {
    const paths = NitroModules.createHybridObject<ShoeboxPaths>('ShoeboxPaths')
    return paths.getDocumentsPath()
  } catch {
    return null
  }
}
