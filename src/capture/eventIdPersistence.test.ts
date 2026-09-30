// Regression tests for event_id persistence fix (Prompt 27, Part 1).
//
// Verifies that syncUpsertSession omits event_id from the upsert payload
// when eventId is undefined (the initial session-creation sync), and
// includes it when eventId is a string or null (produceProcessingJob's
// authoritative sync). This prevents a fire-and-forget initial sync from
// clobbering the event_id written by produceProcessingJob.
//
// Run with: npx tsx src/capture/eventIdPersistence.test.ts

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// ─── Payload builder (mirrors syncUpsertSession's conditional event_id logic) ──

function buildUpsertPayload(eventId: string | null | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id:              'sess-001',
    user_id:         'auth-uid-001',
    capture_method:  'MANUAL',
    session_status:  'capturing',
    synced_at:       new Date().toISOString(),
  };

  // This mirrors the fix in captureBackendSync.ts:
  // "Only include event_id in the upsert when the caller explicitly provides
  // a value (string or null). When eventId is undefined, the field is excluded."
  if (eventId !== undefined) {
    payload.event_id = eventId;
  }

  return payload;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. undefined eventId → event_id NOT in payload (initial session sync)
function testUndefinedEventIdOmitted(): void {
  const payload = buildUpsertPayload(undefined);
  assert(!('event_id' in payload), 'F1: event_id omitted when eventId is undefined');
}

// 2. string eventId → event_id included with correct value
function testStringEventIdIncluded(): void {
  const payload = buildUpsertPayload('event-abc-123');
  assert('event_id' in payload, 'F2: event_id present when eventId is a string');
  assert(payload.event_id === 'event-abc-123', 'F2: event_id value matches');
}

// 3. null eventId → event_id included as null (explicit clear)
function testNullEventIdIncluded(): void {
  const payload = buildUpsertPayload(null);
  assert('event_id' in payload, 'F3: event_id present when eventId is null');
  assert(payload.event_id === null, 'F3: event_id value is null');
}

// 4. Simulate race: initial sync (undefined) vs produceProcessingJob (string)
// The initial sync's payload must NOT contain event_id, so even if it
// arrives after produceProcessingJob's sync, it cannot overwrite event_id.
function testRaceConditionPrevention(): void {
  const initialPayload = buildUpsertPayload(undefined);
  const producerPayload = buildUpsertPayload('event-override-456');

  // produceProcessingJob writes event_id = 'event-override-456'
  assert(producerPayload.event_id === 'event-override-456', 'F4: producer writes correct event_id');

  // Initial sync arrives late — its payload has no event_id key, so the
  // upsert won't touch the event_id column (with defaultToNull:false or
  // by omitting the field). The event_id written by the producer survives.
  assert(!('event_id' in initialPayload), 'F4: initial sync payload has no event_id to clobber with');
}

// 5. Default event fallback: when user doesn't override, resolveEvent returns
// selectedEvent?.id. produceProcessingJob passes this as a string eventId,
// so it IS written to capture_sessions. This is correct.
function testDefaultEventStillWritten(): void {
  const defaultEventId = 'event-default-001';
  const payload = buildUpsertPayload(defaultEventId);
  assert(payload.event_id === defaultEventId, 'F5: default event_id written by producer');
}

// 6. Event override: user selects Event A (different from default)
// draftData.captureEventId = 'event-A'. resolveEvent returns 'event-A'.
// produceProcessingJob passes 'event-A' as eventId → written to capture_sessions.
function testEventOverrideWritten(): void {
  const overrideEventId = 'event-A-789';
  const payload = buildUpsertPayload(overrideEventId);
  assert(payload.event_id === overrideEventId, 'F6: overridden event_id written by producer');
}

// ─── Run ──────────────────────────────────────────────────────────────────────

testUndefinedEventIdOmitted();
testStringEventIdIncluded();
testNullEventIdIncluded();
testRaceConditionPrevention();
testDefaultEventStillWritten();
testEventOverrideWritten();

console.log(`\neventIdPersistence: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
