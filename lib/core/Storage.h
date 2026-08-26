#pragma once
// Storage abstraction so the queue logic is pure C++ and testable on the host.
// Firmware supplies LittleFsStorage; native tests supply PosixStorage.
#include <cstddef>
#include <string>

namespace core {

class Storage {
 public:
  virtual ~Storage() {}
  virtual bool exists(const char* path) = 0;
  virtual size_t size(const char* path) = 0;
  // Append + flush to durable media before returning true.
  virtual bool append(const char* path, const char* data, size_t len) = 0;
  virtual bool readRange(const char* path, size_t offset, size_t maxBytes,
                         std::string& out) = 0;
  virtual bool writeAll(const char* path, const std::string& data) = 0;
  virtual bool remove(const char* path) = 0;
  virtual bool rename(const char* from, const char* to) = 0;
};

}  // namespace core
