CREATE TABLE "hardcover_series_catalog_cache" (
  "normalized_name" varchar(500) PRIMARY KEY,
  "series_name" varchar(500) NOT NULL,
  "books" jsonb NOT NULL,
  "catalog_found" boolean NOT NULL,
  "expected_book_count" integer,
  "fetched_at" timestamptz NOT NULL
);
