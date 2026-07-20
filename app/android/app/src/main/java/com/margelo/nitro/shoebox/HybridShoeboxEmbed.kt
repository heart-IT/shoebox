package com.margelo.nitro.shoebox

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.nnapi.NnApiDelegate
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

// The model: mobilenet_v1_1.0_224_quant — 224×224×3 uint8 in, 1001 uint8 out.
// We treat the 1001-way class distribution as a scene embedding: two photos of
// the same kind of thing land near each other under cosine similarity. Not a
// trained metric-learning embedding, but a real on-device vector that never
// requires the pixels to leave the phone (Inv-5).
private const val SIZE = 224
private const val OUT = 1001

class HybridShoeboxEmbed : HybridShoeboxEmbedSpec() {
  override val dims: Double get() = OUT.toDouble()

  // Async: inference runs on Dispatchers.Default (a background thread), NOT the
  // JS thread — so a 30-photo batch import doesn't freeze the UI.
  override fun embed(path: String): Promise<DoubleArray> = Promise.async { runInference(path) }

  companion object {
    // Process-wide singletons: build the model, delegate, and mapped file ONCE.
    // A fresh HybridObject is created per import run, so a per-instance
    // interpreter leaked a model buffer + NNAPI delegate on every run. These
    // live for the process lifetime; the OS reclaims them on exit.
    private var interpreter: Interpreter? = null
    private var delegate: NnApiDelegate? = null
    private val lock = Any()

    private fun ensureInterpreter(): Interpreter {
      synchronized(lock) {
        interpreter?.let { return it }
        val ctx = NitroModules.applicationContext
          ?: throw Error("NitroModules.applicationContext is not available")
        // Close the fd/stream after mapping — only the MappedByteBuffer must live on.
        val model = ctx.assets.openFd("mobilenet.tflite").use { fd ->
          fd.createInputStream().use { input ->
            input.channel.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength)
          }
        }
        val options = Interpreter.Options()
        // NNAPI runs the model on the device's neural HW where available; the
        // delegate is RETAINED so it isn't finalized out from under the interpreter.
        try {
          val d = NnApiDelegate()
          delegate = d
          options.addDelegate(d)
        } catch (_: Throwable) { /* CPU fallback */ }
        return Interpreter(model, options).also { interpreter = it }
      }
    }

    // Largest power-of-2 sub-sample that keeps both dims ≥ req — so a 12MP photo
    // decodes at a fraction of full resolution instead of ~48 MB of ARGB_8888.
    private fun sampleSize(w: Int, h: Int, req: Int): Int {
      var s = 1
      while (w / (s * 2) >= req && h / (s * 2) >= req) s *= 2
      return s
    }

    private fun runInference(path: String): DoubleArray {
      val itp = ensureInterpreter()

      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      val opts = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, SIZE)
      }
      val bmp = BitmapFactory.decodeFile(path, opts) ?: return DoubleArray(0)
      val scaled = Bitmap.createScaledBitmap(bmp, SIZE, SIZE, true)
      if (scaled !== bmp) bmp.recycle()

      val input = ByteBuffer.allocateDirect(SIZE * SIZE * 3).order(ByteOrder.nativeOrder())
      val px = IntArray(SIZE * SIZE)
      scaled.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE)
      scaled.recycle()
      for (p in px) {
        input.put(((p shr 16) and 0xff).toByte()) // R
        input.put(((p shr 8) and 0xff).toByte())  // G
        input.put((p and 0xff).toByte())          // B
      }
      input.rewind()

      val output = Array(1) { ByteArray(OUT) } // quantized uint8 probabilities
      // Interpreter.run is not safe for concurrent calls; serialize.
      synchronized(lock) { itp.run(input, output) }

      // Dequantize to [0,1]. This vector is the embedding.
      return DoubleArray(OUT) { (output[0][it].toInt() and 0xff) / 255.0 }
    }
  }
}
