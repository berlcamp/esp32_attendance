// Host tests for the parts that must never be wrong: queue durability,
// crash recovery, overflow, compaction, and timestamp reconstruction.
//   pio test -e native
#include <unity.h>

#include <cstdlib>
#include <string>
#include <vector>

#include "Backoff.h"
#include "EventQueue.h"
#include "PosixStorage.h"
#include "ScanEvent.h"

static const char* kRoot = "test-tmp";

static core::QueueConfig smallCfg() {
  core::QueueConfig c;
  c.maxEvents = 5;
  c.compactAfterBytes = 200;
  c.readWindowBytes = 4096;
  return c;
}

static std::string ev(const char* id, int64_t stamp, bool synced) {
  core::ScanEvent e;
  e.eventId = id;
  e.cardUid = "DEADBEEF";
  e.deviceId = "gate-01";
  e.stamp = stamp;
  e.clockSynced = synced;
  return core::buildQueueLine(e);
}

void setUp(void) { system("rm -rf test-tmp && mkdir -p test-tmp"); }
void tearDown(void) {}

// --- FIFO ordering -----------------------------------------------------
void test_drains_oldest_first(void) {
  core::PosixStorage st(kRoot);
  core::EventQueue q(st, smallCfg());
  TEST_ASSERT_TRUE(q.begin());

  TEST_ASSERT_TRUE(q.push(ev("a", 1000, true)));
  TEST_ASSERT_TRUE(q.push(ev("b", 1001, true)));
  TEST_ASSERT_EQUAL_UINT32(2, q.pending());

  size_t consumed = 0;
  std::vector<std::string> batch = q.peek(10, consumed);
  TEST_ASSERT_EQUAL_UINT32(2, batch.size());
  TEST_ASSERT_TRUE(batch[0].find("\"event_id\":\"a\"") != std::string::npos);
  TEST_ASSERT_TRUE(batch[1].find("\"event_id\":\"b\"") != std::string::npos);

  TEST_ASSERT_TRUE(q.commit(consumed, batch.size()));
  TEST_ASSERT_EQUAL_UINT32(0, q.pending());
}

// --- Survives reboot ---------------------------------------------------
void test_pending_survives_restart(void) {
  {
    core::PosixStorage st(kRoot);
    core::EventQueue q(st, smallCfg());
    q.begin();
    q.push(ev("a", 1000, true));
    q.push(ev("b", 1001, true));
  }
  core::PosixStorage st2(kRoot);
  core::EventQueue q2(st2, smallCfg());
  TEST_ASSERT_TRUE(q2.begin());
  TEST_ASSERT_EQUAL_UINT32(2, q2.pending());
}

// --- Crash between "server accepted" and "cursor persisted" -------------
void test_uncommitted_batch_is_replayed(void) {
  core::PosixStorage st(kRoot);
  {
    core::EventQueue q(st, smallCfg());
    q.begin();
    q.push(ev("a", 1000, true));
    size_t consumed = 0;
    q.peek(10, consumed);  // uploaded, then power cut before commit()
  }
  core::EventQueue q2(st, smallCfg());
  q2.begin();
  TEST_ASSERT_EQUAL_UINT32(1, q2.pending());  // re-sent; event_id dedupes it
}

// --- Overflow drops the NEWEST, never the oldest -----------------------
void test_overflow_rejects_newest(void) {
  core::PosixStorage st(kRoot);
  core::EventQueue q(st, smallCfg());
  q.begin();
  for (int i = 0; i < 5; ++i) {
    TEST_ASSERT_TRUE(q.push(ev("x", 1000 + i, true)));
  }
  TEST_ASSERT_TRUE(q.full());
  TEST_ASSERT_FALSE(q.push(ev("overflow", 2000, true)));
  TEST_ASSERT_EQUAL_UINT32(5, q.pending());

  size_t consumed = 0;
  std::vector<std::string> batch = q.peek(1, consumed);
  // Oldest is still intact.
  TEST_ASSERT_TRUE(batch[0].find("1000") != std::string::npos);
}

// --- Compaction keeps unsent events ------------------------------------
void test_compaction_preserves_tail(void) {
  core::PosixStorage st(kRoot);
  core::EventQueue q(st, smallCfg());
  q.begin();
  for (int i = 0; i < 4; ++i) q.push(ev("old", 1000 + i, true));
  q.push(ev("keep", 9999, true));

  size_t consumed = 0;
  std::vector<std::string> batch = q.peek(4, consumed);
  TEST_ASSERT_EQUAL_UINT32(4, batch.size());
  TEST_ASSERT_TRUE(q.commit(consumed, batch.size()));

  TEST_ASSERT_EQUAL_UINT32(1, q.pending());
  TEST_ASSERT_EQUAL_UINT32(0, q.cursor());  // prefix reclaimed

  std::vector<std::string> rest = q.peek(10, consumed);
  TEST_ASSERT_EQUAL_UINT32(1, rest.size());
  TEST_ASSERT_TRUE(rest[0].find("9999") != std::string::npos);
}

// --- Interrupted compaction --------------------------------------------
void test_recovers_from_interrupted_compaction(void) {
  core::PosixStorage st(kRoot);
  // Simulate: tail written to tmp, old log removed, crash before rename.
  st.writeAll("/queue.tmp", ev("survivor", 4242, true));
  st.remove("/queue.jsonl");

  core::EventQueue q(st, smallCfg());
  TEST_ASSERT_TRUE(q.begin());
  TEST_ASSERT_EQUAL_UINT32(1, q.pending());
  size_t consumed = 0;
  std::vector<std::string> batch = q.peek(10, consumed);
  TEST_ASSERT_TRUE(batch[0].find("4242") != std::string::npos);
}

// --- Timestamps ---------------------------------------------------------
void test_late_event_is_flagged_queued(void) {
  std::string line = ev("a", 1000, true);
  std::string fresh = core::finalizeForUpload(line, 1005, 0, 15);
  TEST_ASSERT_TRUE(fresh.find("\"queued\":false") != std::string::npos);

  std::string late = core::finalizeForUpload(line, 9000, 0, 15);
  TEST_ASSERT_TRUE(late.find("\"queued\":true") != std::string::npos);
  TEST_ASSERT_TRUE(late.find("\t") == std::string::npos);  // stamp stripped
}

void test_unsynced_clock_is_reconstructed(void) {
  // Scanned 300s after a 1970-boot, NTP landed later.
  std::string line = ev("a", -300, false);
  TEST_ASSERT_TRUE(line.find("\"scanned_at\":\"\"") != std::string::npos);

  const int64_t now = 1800000000;
  const int64_t boot = now - 900;  // device up 900s
  std::string out = core::finalizeForUpload(line, now, boot, 15);

  TEST_ASSERT_TRUE(out.find(core::isoUtc(boot + 300)) != std::string::npos);
  // Still marked untrusted — the web app must be able to tell.
  TEST_ASSERT_TRUE(out.find("\"clock_synced\":false") != std::string::npos);
  TEST_ASSERT_TRUE(out.find("\"queued\":true") != std::string::npos);
}

// --- Backoff ------------------------------------------------------------

// --- The counter must never be able to destroy the log ------------------
// The uploader commits batch.size() as itemCount, but skips unparseable lines,
// so itemCount can exceed what pending_ really was. The old commit() treated
// "pending_ == 0" as proof the log was drained and truncated the file, taking
// unsent events with it. The file is the truth; the counter is only a cache.
void test_overstated_commit_does_not_destroy_unsent_events(void) {
  core::PosixStorage st(kRoot);
  core::EventQueue q(st, smallCfg());
  TEST_ASSERT_TRUE(q.begin());

  TEST_ASSERT_TRUE(q.push(ev("keep-me", 1000, true)));
  TEST_ASSERT_TRUE(q.push(ev("and-me", 1001, true)));

  // Send only the first, but claim both were handled.
  size_t consumed = 0;
  std::vector<std::string> batch = q.peek(1, consumed);
  TEST_ASSERT_EQUAL_UINT32(1, batch.size());
  TEST_ASSERT_TRUE(q.commit(consumed, 2));

  // The second event is still on disk, so it must still be pending.
  TEST_ASSERT_EQUAL_UINT32(1, q.pending());

  size_t c2 = 0;
  std::vector<std::string> rest = q.peek(10, c2);
  TEST_ASSERT_EQUAL_UINT32(1, rest.size());
  TEST_ASSERT_TRUE(rest[0].find("\"event_id\":\"and-me\"") != std::string::npos);
}

// A miscount must not survive a reboot either: begin() recounts from the file.
void test_miscount_is_repaired_across_restart(void) {
  {
    core::PosixStorage st(kRoot);
    core::EventQueue q(st, smallCfg());
    TEST_ASSERT_TRUE(q.begin());
    TEST_ASSERT_TRUE(q.push(ev("x", 1000, true)));
    TEST_ASSERT_TRUE(q.push(ev("y", 1001, true)));
    size_t consumed = 0;
    std::vector<std::string> batch = q.peek(1, consumed);
    TEST_ASSERT_TRUE(q.commit(consumed, 99));  // wildly overstated
  }
  core::PosixStorage st(kRoot);
  core::EventQueue q(st, smallCfg());
  TEST_ASSERT_TRUE(q.begin());
  TEST_ASSERT_EQUAL_UINT32(1, q.pending());
  TEST_ASSERT_TRUE(q.dataBytes() > 0);
}

void test_backoff_doubles_and_caps(void) {
  core::Backoff b(1000, 8000);
  TEST_ASSERT_EQUAL_UINT32(1000, b.delayMs());
  b.onFailure();
  TEST_ASSERT_EQUAL_UINT32(2000, b.delayMs());
  b.onFailure();
  b.onFailure();
  TEST_ASSERT_EQUAL_UINT32(8000, b.delayMs());
  b.onFailure();
  TEST_ASSERT_EQUAL_UINT32(8000, b.delayMs());
  TEST_ASSERT_EQUAL_UINT32(4, b.failures());
  b.onSuccess();
  TEST_ASSERT_EQUAL_UINT32(1000, b.delayMs());
  TEST_ASSERT_EQUAL_UINT32(0, b.failures());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_drains_oldest_first);
  RUN_TEST(test_pending_survives_restart);
  RUN_TEST(test_uncommitted_batch_is_replayed);
  RUN_TEST(test_overflow_rejects_newest);
  RUN_TEST(test_compaction_preserves_tail);
  RUN_TEST(test_recovers_from_interrupted_compaction);
  RUN_TEST(test_late_event_is_flagged_queued);
  RUN_TEST(test_unsynced_clock_is_reconstructed);
  RUN_TEST(test_overstated_commit_does_not_destroy_unsent_events);
  RUN_TEST(test_miscount_is_repaired_across_restart);
  RUN_TEST(test_backoff_doubles_and_caps);
  return UNITY_END();
}
