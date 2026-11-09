ALTER TABLE book_content_verifications
  ADD COLUMN review_status varchar(30),
  ADD COLUMN review_note text,
  ADD COLUMN reviewed_by integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT book_content_verifications_review_status_chk
    CHECK (review_status IS NULL OR review_status IN ('confirmed_mismatch', 'false_positive', 'needs_recheck'));

--> statement-breakpoint
CREATE INDEX book_content_verifications_review_status_idx
  ON book_content_verifications (review_status);
