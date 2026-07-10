import Foundation

class HybridShoeboxPaths: HybridShoeboxPathsSpec {
  func getDocumentsPath() throws -> String {
    return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
  }
}
