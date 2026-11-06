CREATE TABLE "library_integrity_scan_status" (
  "id" varchar(32) PRIMARY KEY,
  "status" varchar(16) NOT NULL,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "summary" jsonb,
  "error_message" text
);
