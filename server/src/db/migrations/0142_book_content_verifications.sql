CREATE TABLE book_content_verifications (
  id serial PRIMARY KEY,
  book_file_id integer NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
  file_hash varchar(32),
  source varchar(20) NOT NULL,
  status varchar(20) NOT NULL,
  expected_title varchar(500) NOT NULL,
  expected_authors jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_title varchar(500),
  detected_author varchar(500),
  confidence numeric(4, 3),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation text,
  model varchar(200),
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT book_content_verifications_source_chk CHECK (source IN ('ebook', 'audiobook')),
  CONSTRAINT book_content_verifications_status_chk CHECK (status IN ('match', 'mismatch', 'inconclusive', 'error')),
  CONSTRAINT book_content_verifications_confidence_chk CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE UNIQUE INDEX book_content_verifications_book_file_uidx ON book_content_verifications (book_file_id);
CREATE INDEX book_content_verifications_status_idx ON book_content_verifications (status);
