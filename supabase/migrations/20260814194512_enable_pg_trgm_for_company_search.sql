/*
# Enable pg_trgm for fuzzy company search

## Purpose
Enables the pg_trgm PostgreSQL extension to support trigram-based fuzzy matching
on the `company` column of `lead_entries`. This allows the Leads page to perform
database-side fuzzy search with typo tolerance when searching by company name.

## Changes
1. Creates the pg_trgm extension (trigram matching functions + GIN index support).
2. Creates a GIN index on the `company` column using `gin_trgm_ops` with
   `lower(...)` normalization so that case-insensitive matching works and
   trigram similarity queries can use the index for performance.

## Why pg_trgm
- `similarity()` function provides a 0–1 score for fuzzy matching
- `%` operator enables index-accelerated trigram matching
- `ILIKE` with `%` prefix/suffix covers partial/prefix matching
- All matching happens database-side — no need to load all leads into the browser

## Security
- No RLS or policy changes — only an extension and an index are created.
- The index does not expose any new data; it only speeds up existing queries.

## Notes
- The index is on `lead_entries` (the base table), not the view, because
  `leads_list_view` is a simple SELECT from `lead_entries`.
*/

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_lead_entries_company_trgm
  ON lead_entries
  USING gin (lower(coalesce(company, '')) gin_trgm_ops);
