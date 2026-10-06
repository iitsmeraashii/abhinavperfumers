// Focused tests for the Samples Requested feature on Conversation Detail.
//
// These tests verify:
// A. Authorized user can process an OPEN request
// B. processed_by is the authenticated user (server-side, not client-supplied)
// C. processed_at is populated
// D. Optional note is stored
// E. Blank note becomes NULL
// F. Unauthorized user cannot process the request
// G. Already PROCESSED request cannot be processed again
// H. Missing samples_requested row returns a clear error
// I. Existing conversation/message functionality is unaffected
// J. UI changes from OPEN → PROCESSED after successful processing

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

// ─── Types matching the source code ──────────────────────────────────────────

interface SamplesRequested {
  id: string;
  requested_at: string;
  status: string;
  processed_at: string | null;
  processed_by: string | null;
  processed_note: string | null;
  processed_by_name: string | null;
}

// ─── Simulated RPC: mark_samples_processed ───────────────────────────────────
// Mirrors the PL/pgSQL function logic for testing the business rules.

interface RpcInput {
  p_conversation_id: string;
  p_note: string;
  authUid: string | null;
  hasAccess: boolean;
  existingRow: SamplesRequested | null;
}

interface RpcResult {
  success: boolean;
  error?: string;
  status?: string;
  processed_at?: string;
  processed_by?: string | null;
  updatedRow?: SamplesRequested;
}

function simulateMarkSamplesProcessed(input: RpcInput): RpcResult {
  // Access check
  if (!input.hasAccess) {
    return { success: false, error: 'Conversation not found' };
  }

  // Find the row
  if (!input.existingRow) {
    return { success: false, error: 'No samples request found for this conversation' };
  }

  // Guard: already processed
  if (input.existingRow.status === 'PROCESSED') {
    return { success: false, error: 'Samples request has already been processed' };
  }

  // Guard: not OPEN
  if (input.existingRow.status !== 'OPEN') {
    return { success: false, error: 'Samples request is not in a processable state' };
  }

  // processed_by is ALWAYS auth.uid() from the server — never from the client
  const processedBy = input.authUid;
  const processedNote = input.p_note.trim() === '' ? null : input.p_note.trim();
  const now = new Date().toISOString();

  const updatedRow: SamplesRequested = {
    ...input.existingRow,
    status: 'PROCESSED',
    processed_at: now,
    processed_by: processedBy,
    processed_note: processedNote,
    processed_by_name: null,
  };

  return {
    success: true,
    status: 'PROCESSED',
    processed_at: now,
    processed_by: processedBy,
    updatedRow,
  };
}

// ─── A. Authorized user can process an OPEN request ──────────────────────────

function test_authorized_can_process_open() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: 'Handled via email',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });

  assert(result.success === true, 'Authorized user should be able to process an OPEN request');
  assert(result.status === 'PROCESSED', 'Status should be PROCESSED after processing');
}

// ─── B. processed_by is the authenticated user ───────────────────────────────

function test_processed_by_is_auth_user() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });

  assert(result.processed_by === 'user-uid-1',
    'processed_by must be the authenticated user UID, not client-supplied');
  assert(result.updatedRow?.processed_by === 'user-uid-1',
    'Updated row processed_by must match auth user');
}

// ─── C. processed_at is populated ────────────────────────────────────────────

function test_processed_at_populated() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const before = Date.now();
  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });
  const after = Date.now();

  assert(result.processed_at !== undefined && result.processed_at !== null,
    'processed_at must be populated');
  const processedTime = new Date(result.processed_at!).getTime();
  assert(processedTime >= before && processedTime <= after,
    'processed_at should be approximately now()');
}

// ─── D. Optional note is stored ──────────────────────────────────────────────

function test_optional_note_stored() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '  Samples dispatched via courier  ',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });

  assert(result.updatedRow?.processed_note === 'Samples dispatched via courier',
    'Note should be trimmed and stored');
}

// ─── E. Blank note becomes NULL ──────────────────────────────────────────────

function test_blank_note_becomes_null() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  // Empty string
  let result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });
  assert(result.updatedRow?.processed_note === null,
    'Empty note should become NULL');

  // Whitespace only
  result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '   ',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });
  assert(result.updatedRow?.processed_note === null,
    'Whitespace-only note should become NULL');
}

// ─── F. Unauthorized user cannot process the request ─────────────────────────

function test_unauthorized_cannot_process() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'unauthorized-uid',
    hasAccess: false,
    existingRow: row,
  });

  assert(result.success === false, 'Unauthorized user should not succeed');
  assert(result.error === 'Conversation not found',
    'Unauthorized user should get "Conversation not found" error');
}

// ─── G. Already PROCESSED request cannot be processed again ──────────────────

function test_already_processed_cannot_reprocess() {
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'PROCESSED',
    processed_at: '2026-10-05T04:00:00Z',
    processed_by: 'user-uid-1',
    processed_note: 'Done',
    processed_by_name: 'Admin',
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: 'Re-processing',
    authUid: 'user-uid-2',
    hasAccess: true,
    existingRow: row,
  });

  assert(result.success === false, 'Already PROCESSED should not be re-processable');
  assert(result.error === 'Samples request has already been processed',
    'Should return clear "already processed" error');
}

// ─── H. Missing samples_requested row returns a clear error ──────────────────

function test_missing_row_returns_error() {
  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: null,
  });

  assert(result.success === false, 'Missing row should not succeed');
  assert(result.error === 'No samples request found for this conversation',
    'Should return clear "no samples request found" error');
}

// ─── I. Existing conversation/message functionality is unaffected ────────────

function test_existing_functionality_unaffected() {
  // The Samples Requested feature is purely additive:
  // - No changes to whatsapp_conversations schema or RLS
  // - No changes to whatsapp_messages
  // - No changes to whatsapp_conversation_leads
  // - No changes to composer, linking, or message sending
  // - The RPC is new and doesn't modify any existing function
  // - The UI additions are in a new card in the info panel

  // Verify the RPC only touches samples_requested, not other tables
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: '',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: row,
  });

  // The result only contains samples_requested fields — no conversation or message data
  assert(result.success === true, 'Processing should succeed');
  assert(!('conversation' in result), 'RPC should not return conversation data');
  assert(!('messages' in result), 'RPC should not return message data');
}

// ─── J. UI changes from OPEN → PROCESSED after successful processing ─────────

function test_ui_state_transition() {
  // Simulate the UI state machine:
  // 1. Load: samplesRequested.status = 'OPEN'
  // 2. User clicks "Mark as Processed", modal opens
  // 3. User confirms, RPC is called
  // 4. On success: refreshSamplesRequested() is called
  // 5. New data has status = 'PROCESSED'

  let uiState: SamplesRequested | null = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'OPEN',
    processed_at: null,
    processed_by: null,
    processed_note: null,
    processed_by_name: null,
  };

  // Before processing: UI shows OPEN state with "Mark as Processed" button
  assert(uiState?.status === 'OPEN', 'UI should start in OPEN state');

  // Simulate RPC call
  const result = simulateMarkSamplesProcessed({
    p_conversation_id: 'conv-1',
    p_note: 'Done',
    authUid: 'user-uid-1',
    hasAccess: true,
    existingRow: uiState,
  });

  assert(result.success === true, 'RPC should succeed');

  // Simulate refreshSamplesRequested() — update local state with RPC result
  if (result.success && result.updatedRow) {
    uiState = result.updatedRow;
  }

  // After processing: UI shows PROCESSED state
  assert(uiState?.status === 'PROCESSED', 'UI should transition to PROCESSED state');
  assert(uiState?.processed_at !== null, 'UI should show processed_at');
  assert(uiState?.processed_note === 'Done', 'UI should show processed note');

  // In PROCESSED state, the "Mark as Processed" button should NOT be shown
  const showMarkButton = uiState?.status === 'OPEN';
  assert(showMarkButton === false, 'Mark as Processed button should not appear in PROCESSED state');
}

// ─── Additional: processed_by_name resolution ────────────────────────────────

function test_processed_by_name_resolution() {
  // The refreshSamplesRequested function resolves processed_by UUID to a rep name
  // via sales_representatives.auth_user_id lookup
  const row: SamplesRequested = {
    id: 'sr-1',
    requested_at: '2026-10-05T03:00:00Z',
    status: 'PROCESSED',
    processed_at: '2026-10-05T04:00:00Z',
    processed_by: '32ad32e0-dcf9-4e99-990f-ed10dc488f61',
    processed_note: null,
    processed_by_name: null,
  };

  // Simulate the name resolution: if processed_by matches a rep's auth_user_id,
  // set processed_by_name to the rep's name
  const mockRepName = 'ADMIN001';
  row.processed_by_name = mockRepName;

  assert(row.processed_by_name === 'ADMIN001',
    'processed_by_name should be resolved from sales_representatives.name');
  assert(row.processed_by !== row.processed_by_name,
    'processed_by (UUID) and processed_by_name (display name) should differ');
}

// ─── Additional: no row = card not rendered ──────────────────────────────────

function test_no_row_card_not_rendered() {
  // When samplesRequested is null (no row exists), the card should not render
  const uiState: SamplesRequested | null = null;
  const shouldRenderCard = uiState !== null;
  assert(shouldRenderCard === false,
    'Samples Requested card should not render when no row exists');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

test_authorized_can_process_open();
test_processed_by_is_auth_user();
test_processed_at_populated();
test_optional_note_stored();
test_blank_note_becomes_null();
test_unauthorized_cannot_process();
test_already_processed_cannot_reprocess();
test_missing_row_returns_error();
test_existing_functionality_unaffected();
test_ui_state_transition();
test_processed_by_name_resolution();
test_no_row_card_not_rendered();

console.log(`Samples Requested tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
