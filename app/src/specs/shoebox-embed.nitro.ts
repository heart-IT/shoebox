import type { HybridObject } from 'react-native-nitro-modules'

/**
 * On-device scene embedding (Ch4, Inv-5). A quantized MobileNet runs through
 * the TFLite Interpreter — with the NNAPI delegate, on the device's neural
 * hardware — turning a photo into a vector WITHOUT any pixel leaving the phone.
 * The vector (not the pixels) is what the index stores and replication carries.
 */
export interface ShoeboxEmbed
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Length of the embedding vector this model produces. */
  readonly dims: number
  /**
   * Decode `path`, run the model, return the embedding vector. ASYNC: inference
   * runs off the JS thread so a batch import doesn't freeze the UI.
   */
  embed(path: string): Promise<number[]>
}
