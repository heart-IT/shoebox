package com.shoebox

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.DirectorySoSource
import com.facebook.soloader.SoLoader
import com.margelo.nitro.shoebox.ShoeboxOnLoad
import java.io.File

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    /* bare-kit's prebuilt lists libnativehelper.so (an ART apex library) as
     * NEEDED. The system linker resolves it — it is a public library — but
     * SoLoader's manual dependency walk only searches the app, /system and
     * /vendor, so loading libappmodules (which links libbare-kit) dies with
     * SoLoaderDSONotFoundError. Init SoLoader ourselves (same mapping
     * loadReactNative would use — its own init becomes a no-op), then teach
     * it the apex path BEFORE appmodules loads; ON_LD_LIBRARY_PATH makes it
     * delegate to System.loadLibrary. */
    SoLoader.init(this, OpenSourceMergedSoMapping)
    val abiDir = if (android.os.Process.is64Bit()) "lib64" else "lib"
    SoLoader.prependSoSource(
      DirectorySoSource(File("/apex/com.android.art/$abiDir"), DirectorySoSource.ON_LD_LIBRARY_PATH)
    )
    loadReactNative(this)
    // Loads libShoebox and registers all four Nitro HybridObjects (ShoeboxPaths,
    // ShoeboxRoll, ShoeboxBytes, ShoeboxEmbed). Nitrogen generates this entry
    // point but never calls it — without it createHybridObject throws
    // "not registered … []".
    ShoeboxOnLoad.initializeNative()
  }
}
