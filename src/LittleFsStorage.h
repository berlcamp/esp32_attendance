#pragma once
// Storage backed by LittleFS on the 11.9MB `spiffs` partition.
#include <LittleFS.h>
#include <sys/stat.h>

#include "Storage.h"

// LittleFS.exists() opens the file, which makes vfs_api log an ERROR every
// time we probe a file that legitimately does not exist yet. stat() on the
// mount path answers the same question silently.
#define LFS_MOUNT "/littlefs"

class LittleFsStorage : public core::Storage {
 public:
  bool exists(const char* path) override {
    struct stat st;
    return ::stat((std::string(LFS_MOUNT) + path).c_str(), &st) == 0;
  }

  size_t size(const char* path) override {
    struct stat st;
    if (::stat((std::string(LFS_MOUNT) + path).c_str(), &st) != 0) return 0;
    return static_cast<size_t>(st.st_size);
  }

  bool append(const char* path, const char* data, size_t len) override {
    File f = LittleFS.open(path, FILE_APPEND);
    if (!f) {
      f = LittleFS.open(path, FILE_WRITE);
      if (!f) return false;
    }
    size_t w = f.write(reinterpret_cast<const uint8_t*>(data), len);
    f.flush();  // durable before we tell the reader the scan is safe
    f.close();
    return w == len;
  }

  bool readRange(const char* path, size_t offset, size_t maxBytes,
                 std::string& out) override {
    out.clear();
    if (!exists(path)) return false;
    File f = LittleFS.open(path, FILE_READ);
    if (!f) return false;
    if (!f.seek(offset)) {
      f.close();
      return false;
    }
    out.resize(maxBytes);
    size_t n = f.read(reinterpret_cast<uint8_t*>(&out[0]), maxBytes);
    out.resize(n);
    f.close();
    return true;
  }

  bool writeAll(const char* path, const std::string& data) override {
    File f = LittleFS.open(path, FILE_WRITE);
    if (!f) return false;
    bool ok = true;
    if (!data.empty()) {
      ok = f.write(reinterpret_cast<const uint8_t*>(data.data()),
                   data.size()) == data.size();
    }
    f.flush();
    f.close();
    return ok;
  }

  bool remove(const char* path) override {
    if (!exists(path)) return true;
    return LittleFS.remove(path);
  }

  bool rename(const char* from, const char* to) override {
    return LittleFS.rename(from, to);
  }
};
