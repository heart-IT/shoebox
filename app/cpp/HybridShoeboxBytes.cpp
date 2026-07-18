#include "HybridShoeboxBytes.hpp"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <stdexcept>
#include <string>

namespace margelo::nitro::shoebox {

// The acquire → release contract, by hand:
//
//   acquire: open the file, read its size, mmap it read-only. The kernel maps
//            the file's pages into our address space; nothing is copied and
//            nothing is read until a page is touched (a fault pages it in).
//   hand-off: ArrayBuffer::wrap points JS at those exact pages. JS reads the
//            file by faulting pages, never by copying bytes onto the JS heap.
//   release: the DeleteFn runs when JS drops the ArrayBuffer (GC). ONLY then do
//            we munmap. This is the explicit lifetime ownership Inv-3 is about —
//            the native mapping outlives the C++ call and is owned by the JS
//            object's lifetime, not this function's stack frame.
//
// The fd is closed immediately after mmap: the mapping keeps its own reference
// to the file, so the descriptor is no longer needed.
std::shared_ptr<ArrayBuffer> HybridShoeboxBytes::mapFile(const std::string& path) {
  int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    throw std::runtime_error("mapFile: open failed for " + path);
  }

  struct stat st {};
  if (::fstat(fd, &st) != 0) {
    ::close(fd);
    throw std::runtime_error("mapFile: fstat failed for " + path);
  }
  size_t size = static_cast<size_t>(st.st_size);

  // mmap rejects a zero length; hand back an empty owning buffer instead.
  if (size == 0) {
    ::close(fd);
    return ArrayBuffer::allocate(0);
  }

  void* mapped = ::mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
  ::close(fd);
  if (mapped == MAP_FAILED) {
    throw std::runtime_error("mapFile: mmap failed for " + path);
  }

  return ArrayBuffer::wrap(static_cast<uint8_t*>(mapped), size, [mapped, size]() {
    ::munmap(mapped, size);
  });
}

} // namespace margelo::nitro::shoebox
