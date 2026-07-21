import { NitroModules } from 'react-native-nitro-modules'
import type { ShoeboxPaths } from './specs/shoebox-paths.nitro'

/**
 * Storage base for the vault, or null if the native HybridObject isn't
 * registered (JS running before the native build step, or a registration
 * regression). Audit AF-H3: a null here means the worker would fall back to a
 * PURGEABLE tmpdir — losing the seed, membership, and library on the next OS
 * storage sweep. The caller MUST surface null as a visible warning rather than
 * silently starting on ephemeral storage; this function no longer pretends the
 * failure is harmless.
 */
export function documentsPath(): string | null {
  try {
    const paths = NitroModules.createHybridObject<ShoeboxPaths>('ShoeboxPaths')
    return paths.getDocumentsPath()
  } catch {
    return null
  }
}
