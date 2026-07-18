import Foundation
import Photos

// NOTE: written to spec, not yet verified on an iOS build (Android is the
// chapter's verified platform; see VERSIONS.md). PHAsset exposes no stable
// filesystem path — `path` stays empty here and iOS byte access arrives with
// the import movements via PHAssetResource.
class HybridShoeboxRoll: HybridShoeboxRollSpec {
  private func fetchAll() -> PHFetchResult<PHAsset> {
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    return PHAsset.fetchAssets(with: .image, options: options)
  }

  func count() throws -> Double {
    return Double(fetchAll().count)
  }

  func assets(offset: Double, limit: Double) throws -> [RollAsset] {
    let all = fetchAll()
    var out: [RollAsset] = []
    let start = Int(offset)
    let end = min(start + Int(limit), all.count)
    guard start < end else { return out }
    for i in start..<end {
      let asset = all.object(at: i)
      let resource = PHAssetResource.assetResources(for: asset).first
      out.append(RollAsset(
        id: asset.localIdentifier,
        name: resource?.originalFilename ?? "unnamed",
        byteLength: Double((resource?.value(forKey: "fileSize") as? CLong) ?? 0),
        takenAt: (asset.creationDate ?? Date()).timeIntervalSince1970 * 1000,
        path: ""
      ))
    }
    return out
  }
}
