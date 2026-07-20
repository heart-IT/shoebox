import { PermissionsAndroid, Platform } from 'react-native'
import { NitroModules } from 'react-native-nitro-modules'
import type { RollAsset, ShoeboxRoll } from './specs/shoebox-roll.nitro'

export type { RollAsset }

/**
 * The roll behind its typed seam. Same visible-failure philosophy as paths.ts:
 * null means "native module missing", not a crash.
 */
export function rollModule(): ShoeboxRoll | null {
  try {
    return NitroModules.createHybridObject<ShoeboxRoll>('ShoeboxRoll')
  } catch {
    return null
  }
}

/** Ask the platform for read access to the photo library. */
export async function requestRollPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true // iOS: PhotoKit prompts on first fetch
  const version = Number(Platform.Version)
  const granted = PermissionsAndroid.RESULTS.GRANTED
  if (version >= 34) {
    // Android 14+: the picker offers "Select photos" (partial), which grants
    // READ_MEDIA_VISUAL_USER_SELECTED — NOT READ_MEDIA_IMAGES. Request both and
    // accept either, so a partial grant still lets the roll show the chosen photos
    // instead of reading as an outright denial.
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED,
    ])
    return res[PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES] === granted ||
      res[PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED] === granted
  }
  const permission =
    version >= 33
      ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
      : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE
  const result = await PermissionsAndroid.request(permission)
  return result === granted
}
