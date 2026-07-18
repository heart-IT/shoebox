package com.margelo.nitro.shoebox

import android.provider.MediaStore
import android.util.Base64
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.ArrayBuffer
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel

class HybridShoeboxRoll : HybridShoeboxRollSpec() {
  private val resolver
    get() = (NitroModules.applicationContext
      ?: throw Error("NitroModules.applicationContext is not available")).contentResolver

  override fun count(): Double {
    resolver.query(
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
      arrayOf(MediaStore.Images.Media._ID),
      null, null, null
    ).use { c -> return (c?.count ?: 0).toDouble() }
  }

  override fun assets(offset: Double, limit: Double): Array<RollAsset> {
    val projection = arrayOf(
      MediaStore.Images.Media._ID,
      MediaStore.Images.Media.DISPLAY_NAME,
      MediaStore.Images.Media.SIZE,
      MediaStore.Images.Media.DATE_TAKEN,
      MediaStore.Images.Media.DATE_ADDED,
      // Deprecated but still populated for images; the worker (same process,
      // same permission) streams bytes from this path in later movements.
      MediaStore.Images.Media.DATA
    )
    val out = ArrayList<RollAsset>(limit.toInt())
    resolver.query(
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
      projection,
      null, null,
      "${MediaStore.Images.Media.DATE_TAKEN} DESC"
    ).use { c ->
      if (c == null || !c.moveToPosition(offset.toInt())) return out.toTypedArray()
      val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
      val sizeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
      val takenCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
      val addedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
      val dataCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
      do {
        val taken = c.getLong(takenCol)
        out.add(
          RollAsset(
            id = c.getLong(idCol).toString(),
            name = c.getString(nameCol) ?: "unnamed",
            byteLength = c.getLong(sizeCol).toDouble(),
            // DATE_TAKEN is ms but often 0; DATE_ADDED is seconds and always set
            takenAt = (if (taken > 0) taken else c.getLong(addedCol) * 1000).toDouble(),
            path = c.getString(dataCol) ?: ""
          )
        )
      } while (out.size < limit.toInt() && c.moveToNext())
    }
    return out.toTypedArray()
  }

  // The naive path (Movement 2): whole file → bytes → base64 String, handed to
  // JS. Every byte is copied at least twice (read buffer, then base64), and the
  // result lands on the JS heap. Movement 3 hands over an mmap'd region instead.
  override fun readBase64(path: String): String {
    val bytes = File(path).readBytes()
    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  // Movement 3: mmap the file and copy it once into an owning direct ArrayBuffer.
  // No base64 (no 1.33x inflation, no encode pass) and no JS string — the bytes
  // cross to JS as binary and ride bare-rpc raw. The mmap makes the read a page
  // fault, not a heap read. (True zero-copy — wrapping the MappedByteBuffer with
  // no copy — needs C++ ArrayBuffer::wrap + an explicit munmap; that's the
  // hand-rolled read-along ideal. Kotlin's wrapping ctor is internal, so the
  // owning copy is the honest Kotlin-side version.)
  override fun readBytes(path: String): ArrayBuffer {
    RandomAccessFile(path, "r").use { raf ->
      val channel = raf.channel
      val mapped = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size())
      return ArrayBuffer.copy(mapped)
    }
  }
}
