#include "SupabaseClient.h"

#include <esp_crt_bundle.h>

// The ESP-IDF root CA bundle is linked into the firmware image by the
// Arduino build; this is the standard symbol for its start address.
extern const uint8_t rootca_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");

void SupabaseClient::begin() {
  // Verify against the full ESP-IDF root CA bundle rather than a single pinned
  // root: Supabase rotating to a cert under a different root would otherwise
  // brick the device in the field, and setInsecure() would let anyone on the
  // gate's network inject fake attendance.
  tls_.setCACertBundle(rootca_crt_bundle_start);
  tls_.setTimeout(HTTP_TIMEOUT_MS / 1000);

  url_ = std::string(SUPABASE_URL) + "/rest/v1/rpc/" + SUPABASE_RPC;
  http_.setReuse(true);  // one TLS handshake, reused across catch-up batches
  http_.setTimeout(HTTP_TIMEOUT_MS);
  http_.setConnectTimeout(HTTP_TIMEOUT_MS);
}

int SupabaseClient::postBatch(const std::vector<std::string>& jsonObjects,
                              std::string& responseBody) {
  if (jsonObjects.empty()) return 200;

  std::string body;
  body.reserve(jsonObjects.size() * 220 + 16);
  body += "{\"events\":[";
  for (size_t i = 0; i < jsonObjects.size(); ++i) {
    if (i) body += ',';
    body += jsonObjects[i];
  }
  body += "]}";

  if (!http_.begin(tls_, url_.c_str())) return -1000;
  open_ = true;

  http_.addHeader("apikey", SUPABASE_ANON_KEY);
  http_.addHeader("Authorization", "Bearer " SUPABASE_ANON_KEY);
  http_.addHeader("Content-Type", "application/json");
  // Custom schema is invisible to PostgREST without this header AND without
  // being listed under Settings -> API -> Exposed schemas.
  http_.addHeader("Content-Profile", SUPABASE_SCHEMA);
  // Idempotency lives inside record_attendance() now: it does ON CONFLICT
  // (event_id) DO NOTHING, so a retry after a lost response inserts nothing.
  // The function returns how many rows were actually new.

  int code = http_.POST(reinterpret_cast<uint8_t*>(&body[0]), body.size());
  responseBody = code > 0 ? std::string(http_.getString().c_str()) : "";
  http_.end();
  open_ = false;
  return code;
}

void SupabaseClient::end() {
  if (open_) {
    http_.end();
    open_ = false;
  }
}
