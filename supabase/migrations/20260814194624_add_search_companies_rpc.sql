/*
# Add search_companies RPC for fuzzy company search

## Purpose
Provides a database-side function that performs fuzzy + partial matching
on the `company` column of `lead_entries`. Used by the Leads page company
search bar to find leads by company name with typo tolerance.

## How it works
1. Normalizes the search term (lowercase, trim, collapse spaces).
2. For short terms (≤3 chars): uses ILIKE only (trigram matching is unreliable
   for very short strings and can return huge unrelated result sets).
3. For longer terms (>3 chars): combines ILIKE partial matching with
   trigram similarity matching (similarity() > 0.6) using OR.
4. Returns lead IDs that match, so the frontend can filter the leads_list_view
   query by these IDs.

## Parameters
- `search_term` (text): the user's company search input

## Returns
- Set of `lead_id` (text) values for matching leads

## Security
- SECURITY INVOKER function — the caller's RLS policies on lead_entries
  are enforced, so sales reps only see their own leads' IDs.

## Notes
- The similarity threshold of 0.6 was chosen through testing:
  - "Digitek Solutions" → "Digitex Solutions" = 0.8 (matches)
  - "ABC Technologies" → "Wipro technologies" = 0.565 (excluded)
- The GIN trigram index (idx_lead_entries_company_trgm) accelerates both
  the % operator and ILIKE queries on the company column.
*/

CREATE OR REPLACE FUNCTION search_companies(search_term text)
RETURNS TABLE (lead_id text)
LANGUAGE sql
STABLE
AS $$
  SELECT id
  FROM lead_entries
  WHERE
    (
      length(trim(search_term)) <= 3
      AND company ILIKE '%' || trim(search_term) || '%'
    )
    OR
    (
      length(trim(search_term)) > 3
      AND (
        company ILIKE '%' || trim(search_term) || '%'
        OR similarity(
          lower(coalesce(company, '')),
          lower(trim(regexp_replace(search_term, '\s+', ' ', 'g')))
        ) > 0.6
      )
    );
$$;
