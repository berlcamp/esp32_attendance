#pragma once
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include <string>
#include <vector>

#include "config.h"
#include "secrets.h"

class SupabaseClient {
 public:
  void begin();

  // POSTs a JSON array of event objects. Returns the HTTP status, or a
  // negative HTTPClient error code. 2xx means Postgres has the rows.
  int postBatch(const std::vector<std::string>& jsonObjects,
                std::string& responseBody);

  void end();

 private:
  WiFiClientSecure tls_;
  HTTPClient http_;
  bool open_ = false;
  std::string url_;
};
