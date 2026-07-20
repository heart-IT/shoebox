import Foundation
import NitroModules

// iOS stub — unverified. The Core ML path (Vision feature print or a converted
// MobileNet) would live here; Android is this chapter's verified platform.
class HybridShoeboxEmbed: HybridShoeboxEmbedSpec {
  var dims: Double { 0 }
  func embed(path: String) throws -> Promise<[Double]> { Promise.resolved(withResult: []) }
}
