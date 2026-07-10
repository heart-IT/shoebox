package com.margelo.nitro.shoebox

import com.margelo.nitro.NitroModules

class HybridShoeboxPaths : HybridShoeboxPathsSpec() {
  override fun getDocumentsPath(): String {
    return NitroModules.applicationContext?.filesDir?.absolutePath
      ?: throw Error("NitroModules.applicationContext is not available")
  }
}
