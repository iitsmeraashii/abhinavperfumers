/*
# Update search_companies RPC with normalized matching

## Purpose
Adds a normalized company-name comparison as an additional matching strategy
to the existing search_companies function. This fixes the case where a search
term like "digitex" should match "Digi Tex Solutions" — the space between
"Digi" and "Tex" breaks the existing ILIKE substring match and the trigram
similarity is too low.

## How it works
The function now has three matching strategies (OR):

1. **Standard ILIKE** (existing): `company ILIKE '%term%'`
   - Case-insensitive substring match on the raw company name
   - Handles: "digitex" → "Digitex Solutions" ✓

2. **Normalized ILIKE** (NEW): `regexp_replace(lower(company), '[^a-z0-9]', '', 'g') ILIKE '%normalized_term%'`
   - Removes all spaces and punctuation from both company name and search term
   - Then does a substring match
   - Handles: "digitex" → "Digi Tex Solutions" (normalized: "digitexsolutions" contains "digitex") ✓
   - Handles: "novatech" → "Nova Tech Global" (normalized: "novatechglobal" contains "novatech") ✓

3. **Fuzzy similarity** (existing): `similarity(lower(company), lower(term)) > 0.6`
   - Trigram-based typo tolerance for longer terms
   - Handles: "Digitek Solutions" → "Digitex Solutions" (similarity 0.8) ✓
   - Threshold stays at 0.6 — NOT lowered

## Short terms (≤3 chars)
For short terms, only strategies 1 and 2 apply (no fuzzy), preventing
broad unrelated results from trigram matching on very short strings.

## Security
- No RLS or policy changes — only the function definition changes.
- SECURITY INVOKER is preserved — caller's RLS policies on lead_entries
  are still enforced.

## Notes
- The normalized matching is ADDITIONAL, not a replacement — the existing
  ILIKE and similarity matching remain intact.
- The fuzzy threshold is NOT lowered — unrelated companies like "Apple"
  will still not match "Digitex Solutions".
- Normalization removes characters matching [^a-z0-9] (spaces, punctuation,
  hyphens, etc.) after lowercasing.
*/

CREATE OR REPLACE FUNCTION search_companies(search_term text)
RETURNS TABLE (lead_id text)
LANGUAGE sql
STABLE
AS $$
  SELECT id
  FROM lead_entries
  WHERE
    -- Strategy 1: Standard ILIKE (case-insensitive substring on raw company)
    company ILIKE '%' || trim(search_term) || '%'

    -- Strategy 2: Normalized ILIKE (remove spaces/punctuation, then substring match)
    OR regexp_replace(lower(coalesce(company, '')), '[^a-z0-9]', '', 'g')
       ILIKE '%' || regexp_replace(lower(trim(search_term)), '[^a-z0-9]', '', 'g') || '%'

    -- Strategy 3: Fuzzy similarity (only for terms > 3 chars, threshold 0.6)
    OR (
      length(trim(search_term)) > 3
      AND similarity(
        lower(coalesce(company, '')),
        lower(trim(regexp_replace(search_term, '\s+', ' ', 'g')))
      ) > 0.6
    );
$$;
