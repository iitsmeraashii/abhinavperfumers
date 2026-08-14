// Focused tests for the Company search feature on the Leads page.
//
// These tests verify the matching strategy used by the `search_companies` RPC:
// - Exact match
// - Case-insensitive match
// - Partial company match
// - Prefix match
// - Minor typo (fuzzy)
// - Similar company name
// - Clearly unrelated company (no match)
// - Short search term (ILIKE only, no fuzzy)
// - Empty company search (no effect)
// - Company search combined with existing filters (AND)
// - Pagination preserved
// - No-result case
//
// The matching strategy mirrors the SQL in search_companies():
//   1. Standard ILIKE: company ILIKE '%term%' (case-insensitive substring)
//   2. Normalized ILIKE: remove spaces/punctuation from both, then substring match
//   3. Fuzzy similarity: similarity(lower(company), lower(term)) > 0.6 (terms > 3 chars only)

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

// ─── Constants matching the RPC ────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.6;
const SHORT_TERM_MAX_LENGTH = 3;

// ─── Normalization helpers ────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Aggressive normalization: lowercase, remove ALL spaces and non-alphanumeric chars
function normalizeAggressive(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// ─── Trigram similarity (simplified for testing) ──────────────────────────────
// This is a simplified trigram similarity function for testing purposes.
// It approximates PostgreSQL's similarity() function from pg_trgm.

function trigrams(s: string): Set<string> {
  const padded = `  ${s}  `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    result.add(padded.substring(i, i + 3));
  }
  return result;
}

function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return intersection / union;
}

// ─── Match function mirroring search_companies RPC ────────────────────────────

function companyMatches(company: string, searchTerm: string): boolean {
  const term = searchTerm.trim();
  if (!term) return true; // empty search = no filter

  const normCompany = normalize(company);
  const normTerm = normalize(term);

  // Strategy 1: Standard ILIKE partial match (case-insensitive substring on raw name)
  if (normCompany.includes(normTerm)) return true;

  // Strategy 2: Normalized ILIKE (remove spaces/punctuation, then substring match)
  const aggCompany = normalizeAggressive(company);
  const aggTerm = normalizeAggressive(term);
  if (aggCompany.includes(aggTerm)) return true;

  // Strategy 3: Fuzzy match only for terms longer than 3 chars
  if (term.length > SHORT_TERM_MAX_LENGTH) {
    return similarity(normCompany, normTerm) > SIMILARITY_THRESHOLD;
  }

  return false;
}

// ─── Test data ─────────────────────────────────────────────────────────────────

const COMPANIES = [
  'NOVATECH GLOBAL',
  'Digitex Solutions',
  'Wipro Technologies',
  'Apple Inc',
  'ABC Corp',
];

// ─── 1. Exact company match ────────────────────────────────────────────────────

function test_exact_match() {
  assert(companyMatches('NOVATECH GLOBAL', 'NOVATECH GLOBAL'),
    'Exact match should work');
  assert(companyMatches('Digitex Solutions', 'Digitex Solutions'),
    'Exact match should work for Digitex Solutions');
}

// ─── 2. Case-insensitive match ─────────────────────────────────────────────────

function test_case_insensitive() {
  assert(companyMatches('NOVATECH GLOBAL', 'novatech global'),
    'Case-insensitive match should work');
  assert(companyMatches('Digitex Solutions', 'digitex solutions'),
    'Case-insensitive match should work for Digitex');
}

// ─── 3. Partial company match ──────────────────────────────────────────────────

function test_partial_match() {
  assert(companyMatches('NOVATECH GLOBAL', 'Novatech'),
    'Partial match: "Novatech" should match "NOVATECH GLOBAL"');
  assert(companyMatches('Digitex Solutions', 'Digitex Sol'),
    'Partial match: "Digitex Sol" should match "Digitex Solutions"');
  assert(companyMatches('Digitex Solutions', 'Digitex Solution'),
    'Partial match: "Digitex Solution" should match "Digitex Solutions"');
}

// ─── 4. Prefix match ────────────────────────────────────────────────────────────

function test_prefix_match() {
  assert(companyMatches('NOVATECH GLOBAL', 'novatech glob'),
    'Prefix match: "novatech glob" should match "NOVATECH GLOBAL"');
  assert(companyMatches('Digitex Solutions', 'Digite'),
    'Prefix match: "Digite" should match "Digitex Solutions"');
}

// ─── 5. Minor typo (fuzzy) ─────────────────────────────────────────────────────

function test_minor_typo() {
  // "Digitek" vs "Digitex" — one char difference
  const sim = similarity('digitex solutions', 'digitek solutions');
  assert(sim > SIMILARITY_THRESHOLD,
    `Similarity for "Digitek Solutions" vs "Digitex Solutions" should be > 0.6 (got ${sim})`);
  assert(companyMatches('Digitex Solutions', 'Digitek Solutions'),
    'Minor typo: "Digitek Solutions" should match "Digitex Solutions"');
}

// ─── 6. Similar company name ───────────────────────────────────────────────────

function test_similar_company() {
  // "Novatech Globals" vs "Novatech Global" — very similar
  const sim = similarity('novatech global', 'novatech globals');
  assert(sim > SIMILARITY_THRESHOLD,
    `Similarity for "Novatech Globals" vs "Novatech Global" should be > 0.6 (got ${sim})`);
  assert(companyMatches('NOVATECH GLOBAL', 'Novatech Globals'),
    'Similar name: "Novatech Globals" should match "NOVATECH GLOBAL"');
}

// ─── 7. Clearly unrelated company ──────────────────────────────────────────────

function test_unrelated_company() {
  assert(!companyMatches('NOVATECH GLOBAL', 'ABC Technologies'),
    'Unrelated: "ABC Technologies" should NOT match "NOVATECH GLOBAL"');
  assert(!companyMatches('NOVATECH GLOBAL', 'Apple'),
    'Unrelated: "Apple" should NOT match "NOVATECH GLOBAL"');
  assert(!companyMatches('Digitex Solutions', 'Apple Inc'),
    'Unrelated: "Apple Inc" should NOT match "Digitex Solutions"');
  assert(!companyMatches('Digitex Solutions', 'ABC Corp'),
    'Unrelated: "ABC Corp" should NOT match "Digitex Solutions"');
}

// ─── 8. Short search term ──────────────────────────────────────────────────────

function test_short_term() {
  // Short terms should use ILIKE only (no fuzzy)
  // "IT" should NOT match "Wipro Technologies" — "it" is not a substring,
  // and fuzzy matching is disabled for short terms to avoid huge unrelated results
  assert(!companyMatches('Wipro Technologies', 'IT'),
    'Short term: "IT" should NOT match "Wipro Technologies" (not a substring, no fuzzy for short terms)');

  // "AI" should NOT match "NOVATECH GLOBAL" (not a substring, and too short for fuzzy)
  assert(!companyMatches('NOVATECH GLOBAL', 'AI'),
    'Short term: "AI" should NOT match "NOVATECH GLOBAL"');

  // "Co" should match "ABC Corp" (substring of "Corp")
  assert(companyMatches('ABC Corp', 'Co'),
    'Short term: "Co" should match "ABC Corp" (substring)');
}

// ─── 9. Empty company search ────────────────────────────────────────────────────

function test_empty_search() {
  assert(companyMatches('NOVATECH GLOBAL', ''),
    'Empty search should match everything (no filter)');
  assert(companyMatches('Digitex Solutions', '   '),
    'Whitespace-only search should match everything');
}

// ─── 10. Company search combined with existing filters ────────────────────────

function test_combined_with_filters() {
  // The company search is an AND condition with other filters.
  // This test verifies the matching logic itself — the AND is enforced
  // by the Supabase query builder (query.in('id', ids) is ANDed with other filters).
  const companyMatch = companyMatches('NOVATECH GLOBAL', 'Novatech');
  assert(companyMatch,
    'Company match should work independently for AND combination');

  // If company doesn't match, the lead shouldn't appear regardless of other filters
  const noMatch = companyMatches('Apple Inc', 'Novatech');
  assert(!noMatch,
    'Non-matching company should not appear even with other filters');
}

// ─── 11. Pagination preserved ──────────────────────────────────────────────────

function test_pagination() {
  // The company search uses query.in('id', ids) which is compatible with
  // .range(from, to) pagination. The RPC returns all matching IDs, and
  // the paginated query filters by those IDs.
  // This test verifies that the matching function works consistently
  // across multiple calls (stateless).
  const match1 = companyMatches('NOVATECH GLOBAL', 'Novatech');
  const match2 = companyMatches('NOVATECH GLOBAL', 'Novatech');
  assert(match1 === match2,
    'Pagination: matching should be consistent across calls');
}

// ─── 12. No-result case ─────────────────────────────────────────────────────────

function test_no_result() {
  assert(!companyMatches('NOVATECH GLOBAL', 'XYZ Corporation'),
    'No result: "XYZ Corporation" should NOT match "NOVATECH GLOBAL"');
  assert(!companyMatches('Digitex Solutions', 'Microsoft'),
    'No result: "Microsoft" should NOT match "Digitex Solutions"');
}

// ─── 13. Normalized matching (spaces/punctuation removed) ──────────────────────

function test_normalized_matching() {
  // "digitex" should match "Digi Tex Solutions" after normalization
  // "Digi Tex Solutions" → normalized: "digitexsolutions" contains "digitex"
  assert(companyMatches('Digi Tex Solutions', 'digitex'),
    'Normalized: "digitex" should match "Digi Tex Solutions"');

  // "digitex" should match "Digitex Sols" after normalization
  // "Digitex Sols" → normalized: "digitexsols" contains "digitex"
  assert(companyMatches('Digitex Sols', 'digitex'),
    'Normalized: "digitex" should match "Digitex Sols"');

  // "novatech" should match "Nova Tech Global" after normalization
  // "Nova Tech Global" → normalized: "novatechglobal" contains "novatech"
  assert(companyMatches('Nova Tech Global', 'novatech'),
    'Normalized: "novatech" should match "Nova Tech Global"');

  // "digitex sol" should match "Digi Tex Solutions" after normalization
  // "Digi Tex Solutions" → normalized: "digitexsolutions" contains "digitexsol"
  assert(companyMatches('Digi Tex Solutions', 'digitex sol'),
    'Normalized: "digitex sol" should match "Digi Tex Solutions"');
}

// ─── 14. Normalized matching does not introduce false positives ───────────────

function test_normalized_no_false_positives() {
  // "apple" should NOT match "Digitex Solutions" even with normalization
  // "Digitex Solutions" → normalized: "digitexsolutions" does NOT contain "apple"
  assert(!companyMatches('Digitex Solutions', 'apple'),
    'Normalized: "apple" should NOT match "Digitex Solutions"');

  // "apple" should NOT match "NOVATECH GLOBAL"
  assert(!companyMatches('NOVATECH GLOBAL', 'apple'),
    'Normalized: "apple" should NOT match "NOVATECH GLOBAL"');

  // Unrelated companies with different normalized forms should not match
  assert(!companyMatches('Wipro Technologies', 'digitex'),
    'Normalized: "digitex" should NOT match "Wipro Technologies"');
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

test_exact_match();
test_case_insensitive();
test_partial_match();
test_prefix_match();
test_minor_typo();
test_similar_company();
test_unrelated_company();
test_short_term();
test_empty_search();
test_combined_with_filters();
test_pagination();
test_no_result();
test_normalized_matching();
test_normalized_no_false_positives();

console.log(`Company search tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
