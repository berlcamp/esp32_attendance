#pragma once
// Durable, power-loss-safe FIFO of pending scans.
//
//   /queue.jsonl  append-only log, one event per line
//   /queue.cur    byte offset of the first UNSENT event
//   /queue.tmp    staging file used during compaction
//
// Events are deleted only after Supabase has acknowledged them. A crash between
// "server inserted" and "cursor persisted" re-sends the batch, which is
// harmless: event_id is the primary key and inserts ignore duplicates.
#include <cstddef>
#include <string>
#include <vector>

#include "Storage.h"

namespace core {

struct QueueConfig {
  const char* dataPath = "/queue.jsonl";
  const char* cursorPath = "/queue.cur";
  const char* tmpPath = "/queue.tmp";
  size_t maxEvents = 20000;      // hard cap; overflow drops the NEWEST
  size_t compactAfterBytes = 65536;  // reclaim the flushed prefix past this
  size_t readWindowBytes = 65536;    // max bytes pulled per peek()
};

class EventQueue {
 public:
  EventQueue(Storage& storage, const QueueConfig& cfg = QueueConfig())
      : st_(storage), cfg_(cfg) {}

  // Recovers cursor + pending count, and repairs an interrupted compaction.
  bool begin();

  // Appends one already-formatted line. False = queue full, event NOT stored.
  bool push(const std::string& line);

  // Oldest-first. bytesConsumed is what commit() must be given on success.
  std::vector<std::string> peek(size_t maxItems, size_t& bytesConsumed);

  // Called only after the server has accepted those events.
  bool commit(size_t bytesConsumed, size_t itemCount);

  bool clear();

  size_t pending() const { return pending_; }
  size_t cursor() const { return cursor_; }
  bool full() const { return pending_ >= cfg_.maxEvents; }

 private:
  bool persistCursor();
  bool compact();

  Storage& st_;
  QueueConfig cfg_;
  size_t cursor_ = 0;
  size_t pending_ = 0;
};

}  // namespace core
