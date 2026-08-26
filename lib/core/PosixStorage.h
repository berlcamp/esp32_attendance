#pragma once
// Host-side Storage for `pio test -e native`. Not compiled into firmware.
#ifndef ARDUINO

#include <sys/stat.h>

#include <cstdio>
#include <string>

#include "Storage.h"

namespace core {

class PosixStorage : public Storage {
 public:
  explicit PosixStorage(const std::string& root) : root_(root) {}

  bool exists(const char* path) override {
    struct stat s;
    return ::stat(full(path).c_str(), &s) == 0;
  }

  size_t size(const char* path) override {
    struct stat s;
    if (::stat(full(path).c_str(), &s) != 0) return 0;
    return static_cast<size_t>(s.st_size);
  }

  bool append(const char* path, const char* data, size_t len) override {
    FILE* f = ::fopen(full(path).c_str(), "ab");
    if (!f) return false;
    bool ok = ::fwrite(data, 1, len, f) == len;
    ::fflush(f);
    ::fclose(f);
    return ok;
  }

  bool readRange(const char* path, size_t offset, size_t maxBytes,
                 std::string& out) override {
    out.clear();
    FILE* f = ::fopen(full(path).c_str(), "rb");
    if (!f) return false;
    if (::fseek(f, static_cast<long>(offset), SEEK_SET) != 0) {
      ::fclose(f);
      return false;
    }
    out.resize(maxBytes);
    size_t n = ::fread(&out[0], 1, maxBytes, f);
    out.resize(n);
    ::fclose(f);
    return true;
  }

  bool writeAll(const char* path, const std::string& data) override {
    FILE* f = ::fopen(full(path).c_str(), "wb");
    if (!f) return false;
    bool ok = data.empty() || ::fwrite(data.data(), 1, data.size(), f) == data.size();
    ::fflush(f);
    ::fclose(f);
    return ok;
  }

  bool remove(const char* path) override {
    return ::remove(full(path).c_str()) == 0 || !exists(path);
  }

  bool rename(const char* from, const char* to) override {
    return ::rename(full(from).c_str(), full(to).c_str()) == 0;
  }

 private:
  std::string full(const char* p) const { return root_ + p; }
  std::string root_;
};

}  // namespace core
#endif  // ARDUINO
