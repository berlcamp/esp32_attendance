#include "EventQueue.h"

#include <cstdio>
#include <cstdlib>

namespace core {

bool EventQueue::begin() {
  // Repair an interrupted compaction. queue.tmp holds the surviving tail.
  if (st_.exists(cfg_.tmpPath)) {
    if (!st_.exists(cfg_.dataPath)) {
      // Crashed after removing the old log: the tail IS the queue.
      st_.rename(cfg_.tmpPath, cfg_.dataPath);
      cursor_ = 0;
      persistCursor();
    } else {
      // Crashed before the swap: the original log is still authoritative.
      st_.remove(cfg_.tmpPath);
    }
  }

  cursor_ = 0;
  if (st_.exists(cfg_.cursorPath)) {
    std::string raw;
    if (st_.readRange(cfg_.cursorPath, 0, 32, raw)) {
      cursor_ = static_cast<size_t>(strtoul(raw.c_str(), nullptr, 10));
    }
  }

  const size_t total = st_.exists(cfg_.dataPath) ? st_.size(cfg_.dataPath) : 0;
  if (cursor_ > total) cursor_ = total;  // corrupt cursor -> replay everything

  recount();
  return true;
}

// Count unsent lines. ~20k lines is a few hundred ms at boot, once.
void EventQueue::recount() {
  const size_t total = st_.exists(cfg_.dataPath) ? st_.size(cfg_.dataPath) : 0;
  if (cursor_ > total) cursor_ = total;

  pending_ = 0;
  size_t off = cursor_;
  std::string chunk;
  while (off < total) {
    if (!st_.readRange(cfg_.dataPath, off, cfg_.readWindowBytes, chunk)) break;
    if (chunk.empty()) break;
    for (char c : chunk) {
      if (c == '\n') ++pending_;
    }
    off += chunk.size();
  }
}

bool EventQueue::push(const std::string& line) {
  if (full()) return false;  // caller must log this loudly; never silent
  if (!st_.append(cfg_.dataPath, line.data(), line.size())) return false;
  ++pending_;
  return true;
}

std::vector<std::string> EventQueue::peek(size_t maxItems,
                                          size_t& bytesConsumed) {
  std::vector<std::string> out;
  bytesConsumed = 0;
  if (pending_ == 0 || maxItems == 0) return out;

  std::string chunk;
  if (!st_.readRange(cfg_.dataPath, cursor_, cfg_.readWindowBytes, chunk)) {
    return out;
  }

  size_t start = 0;
  while (out.size() < maxItems) {
    size_t nl = chunk.find('\n', start);
    if (nl == std::string::npos) break;  // partial line: leave it for next peek
    out.push_back(chunk.substr(start, nl - start));
    start = nl + 1;
  }
  bytesConsumed = start;
  return out;
}

bool EventQueue::commit(size_t bytesConsumed, size_t itemCount) {
  cursor_ += bytesConsumed;
  pending_ = itemCount >= pending_ ? 0 : pending_ - itemCount;

  const size_t total = st_.size(cfg_.dataPath);

  // Truncate ONLY on the file's own evidence that everything is sent. The old
  // condition also fired on `pending_ == 0`, which throws the log away on the
  // word of an in-memory counter — and the uploader can overstate itemCount
  // (it passes batch.size() while some lines were unparseable), so a wrong
  // counter silently destroyed unsent events that were still on disk.
  if (cursor_ >= total) {
    // Fully drained: cheapest possible compaction.
    cursor_ = 0;
    pending_ = 0;
    st_.writeAll(cfg_.dataPath, std::string());
    return persistCursor();
  }

  // Bytes remain past the cursor, so the counter was wrong, not the file.
  // Believe the file.
  if (pending_ == 0) recount();

  if (cursor_ >= cfg_.compactAfterBytes) return compact();
  return persistCursor();
}

bool EventQueue::compact() {
  const size_t total = st_.size(cfg_.dataPath);
  st_.remove(cfg_.tmpPath);
  st_.writeAll(cfg_.tmpPath, std::string());

  size_t off = cursor_;
  std::string chunk;
  while (off < total) {
    if (!st_.readRange(cfg_.dataPath, off, cfg_.readWindowBytes, chunk)) {
      return false;
    }
    if (chunk.empty()) break;
    if (!st_.append(cfg_.tmpPath, chunk.data(), chunk.size())) return false;
    off += chunk.size();
  }

  if (!st_.remove(cfg_.dataPath)) return false;
  if (!st_.rename(cfg_.tmpPath, cfg_.dataPath)) return false;
  cursor_ = 0;
  return persistCursor();
}

bool EventQueue::clear() {
  cursor_ = 0;
  pending_ = 0;
  st_.remove(cfg_.tmpPath);
  st_.writeAll(cfg_.dataPath, std::string());
  return persistCursor();
}

bool EventQueue::persistCursor() {
  char buf[24];
  snprintf(buf, sizeof(buf), "%lu", static_cast<unsigned long>(cursor_));
  return st_.writeAll(cfg_.cursorPath, std::string(buf));
}

}  // namespace core
