import { NitroModules } from 'react-native-nitro-modules'
import type { ShoeboxBytes } from './specs/shoebox-bytes.nitro'

/**
 * The hand-rolled C++ mmap module (Movement 3). Same visible-failure contract
 * as the other accessors: null if the native side isn't registered.
 */
export function bytesModule(): ShoeboxBytes | null {
  try {
    return NitroModules.createHybridObject<ShoeboxBytes>('ShoeboxBytes')
  } catch {
    return null
  }
}
