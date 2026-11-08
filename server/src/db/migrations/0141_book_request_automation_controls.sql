ALTER TABLE book_requests
  ADD COLUMN automatic_retry_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN seed_cleanup_protected boolean NOT NULL DEFAULT false;
