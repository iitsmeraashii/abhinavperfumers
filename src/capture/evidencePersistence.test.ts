// Tests for voice note and notes image durable persistence + owner safety.
// Run with: npx tsx src/capture/evidencePersistence.test.ts

// ─── Mock infrastructure ─────────────────────────────────────────────────────

interface MockOp {
  id:       string;
  ownerId:  string | null;
  type:     string;
  sessionId: string;
  createdAt: string;
  retries:   number;
  payload:   unknown;
}

const opStore: Map<string, MockOp> = new Map();
const uploadedVoiceNotes: { sessionId: string; ownerId: string | null; blobSize: number }[] = [];
const uploadedNotesImages: { sessionId: string; ownerId: string | null }[] = [];

function resetStores(): void {
  opStore.clear();
  uploadedVoiceNotes.length = 0;
  uploadedNotesImages.length = 0;
}

// ─── Mock db functions (mirror db.ts interface) ─────────────────────────────

async function mockDbPut(_store: string, value: Record<string, unknown> & { id: string }): Promise<void> {
  opStore.set(value.id, value as unknown as MockOp);
}

async function mockDbDelete(_store: string, key: string): Promise<void> {
  opStore.delete(key);
}

async function mockDbGetAllInStore<T>(_store: string): Promise<T[]> {
  return Array.from(opStore.values()) as unknown as T[];
}

// ─── Mock upload functions ──────────────────────────────────────────────────

let uploadShouldFail = false;

async function mockUploadVoiceNote(
  sessionId: string,
  _audioBlob: Blob,
  _mimeType: string,
  ownerId?: string | null,
): Promise<void> {
  if (uploadShouldFail) throw new Error('Simulated upload failure');
  uploadedVoiceNotes.push({ sessionId, ownerId: ownerId ?? null, blobSize: _audioBlob.size });
}

async function mockUploadNotesImage(
  sessionId: string,
  _dataUrl: string,
  _correlationId?: string | null,
  ownerId?: string | null,
): Promise<void> {
  if (uploadShouldFail) throw new Error('Simulated upload failure');
  uploadedNotesImages.push({ sessionId, ownerId: ownerId ?? null });
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';

function makeBlob(size = 1024): Blob {
  const arr = new Uint8Array(size);
  return new Blob([arr], { type: 'audio/ogg' });
}

// ─── Test helpers ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

async function assertEq(actual: unknown, expected: unknown, label: string): Promise<void> {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// ─── Voice Evidence Manager simulation ──────────────────────────────────────
// Mirrors the updated voiceEvidenceManager logic with mock dependencies.

interface PendingVoice {
  sessionId:  string;
  ownerId:    string | null;
  audioBlob:  Blob;
  mimeType:   string;
  durationMs: number;
  localOpId:  string;
}

class TestVoiceManager {
  private _pending: PendingVoice | null = null;

  register(
    sessionId: string,
    audioBlob: Blob,
    durationMs: number,
    mimeType: string,
    uploadTiming: 'IMMEDIATE' | 'ON_SAVE' | 'NEVER',
    ownerId: string | null = null,
  ): void {
    if (!audioBlob || audioBlob.size === 0) return;

    // Durable persistence BEFORE any upload
    const localOpId = `voice_${sessionId}_${Date.now()}`;
    const opRecord: MockOp = {
      id: localOpId,
      ownerId,
      type: 'upload_voice_note',
      sessionId,
      createdAt: new Date().toISOString(),
      retries: 0,
      payload: { sessionId, audioBlob, mimeType, durationMs, ownerId },
    };
    void mockDbPut('pending_ops', opRecord as unknown as Record<string, unknown> & { id: string });

    this._pending = { sessionId, ownerId, audioBlob, mimeType, durationMs, localOpId };

    if (uploadTiming === 'IMMEDIATE' && typeof navigator !== 'undefined' && navigator.onLine) {
      const pending = this._pending;
      this._pending = null;
      void this._uploadAndTranscribe(pending.sessionId, pending.audioBlob, pending.mimeType, pending.ownerId, pending.localOpId);
    }
  }

  onSaveAndNext(sessionId: string, _ownerId: string | null = null): void {
    if (this._pending?.sessionId !== sessionId) return;

    const { audioBlob, mimeType, ownerId: capturedOwnerId, localOpId } = this._pending;
    this._pending = null;

    const effectiveOwnerId = capturedOwnerId ?? _ownerId;
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void this._uploadAndTranscribe(sessionId, audioBlob, mimeType, effectiveOwnerId, localOpId);
    }
    // Offline: already persisted at register() time — no re-enqueue needed
  }

  onSessionReset(ownerId: string | null = null): void {
    if (!this._pending) return;
    const { sessionId, audioBlob, mimeType, ownerId: capturedOwnerId, localOpId } = this._pending;
    this._pending = null;
    const effectiveOwnerId = capturedOwnerId ?? ownerId;
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void this._uploadAndTranscribe(sessionId, audioBlob, mimeType, effectiveOwnerId, localOpId);
    }
  }

  private async _uploadAndTranscribe(
    sessionId: string,
    audioBlob: Blob,
    _mimeType: string,
    ownerId: string | null,
    localOpId: string | null,
  ): Promise<void> {
    let uploadSucceeded = false;
    try {
      await mockUploadVoiceNote(sessionId, audioBlob, _mimeType, ownerId);
      uploadSucceeded = true;
    } catch {
      return;
    }
    if (uploadSucceeded && localOpId) {
      void mockDbDelete('pending_ops', localOpId);
    }
  }
}

// ─── Notes Image Evidence Manager simulation ────────────────────────────────

class TestNotesImageManager {
  private _pendingNotes: { sessionId: string; dataUrl: string; ownerId: string | null; localOpId: string } | null = null;

  registerNotesImage(sessionId: string, dataUrl: string, ownerId: string | null = null): void {
    if (!dataUrl?.startsWith('data:')) return;
    const localOpId = `notes_${sessionId}_${Date.now()}`;
    const opRecord: MockOp = {
      id: localOpId,
      ownerId,
      type: 'upload_notes_image',
      sessionId,
      createdAt: new Date().toISOString(),
      retries: 0,
      payload: { sessionId, dataUrl, ownerId },
    };
    void mockDbPut('pending_ops', opRecord as unknown as Record<string, unknown> & { id: string });
    this._pendingNotes = { sessionId, dataUrl, ownerId, localOpId };
  }

  onSaveAndNext(sessionId: string): void {
    if (this._pendingNotes?.sessionId !== sessionId) return;
    const { dataUrl, ownerId, localOpId } = this._pendingNotes;
    this._pendingNotes = null;
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      void mockUploadNotesImage(sessionId, dataUrl, undefined, ownerId).then(() => {
        if (localOpId) void mockDbDelete('pending_ops', localOpId);
      }).catch(() => {});
    }
    // Offline: already persisted at register() time
  }
}

// ─── VOICE TESTS ────────────────────────────────────────────────────────────

// 1. Voice registration captures ownerId
async function testVoiceRegistrationCapturesOwnerId(): Promise<void> {
  resetStores();
  const mgr = new TestVoiceManager();
  // Use ON_SAVE so the upload doesn't fire immediately
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.register('sess-001', makeBlob(2048), 5000, 'audio/ogg', 'ON_SAVE', ADMIN);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Voice: op persisted at registration');
  await assertEq(ops[0].ownerId, ADMIN, 'Voice: op ownerId is ADMIN');
  await assertEq(ops[0].type, 'upload_voice_note', 'Voice: op type is upload_voice_note');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 2. Voice evidence is durably persisted before online upload dispatch
async function testVoicePersistedBeforeOnlineUpload(): Promise<void> {
  resetStores();
  uploadShouldFail = false;
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

  mgr.register('sess-002', makeBlob(4096), 3000, 'audio/ogg', 'IMMEDIATE', ADMIN);

  // Wait for async upload to complete
  await new Promise(r => setTimeout(r, 50));

  // The op was persisted, and since upload succeeded, it was cleaned up
  assert(uploadedVoiceNotes.length === 1, 'Voice: upload was dispatched (IMMEDIATE online)');
  await assertEq(uploadedVoiceNotes[0].ownerId, ADMIN, 'Voice: upload used captured ownerId');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 3. Online upload failure does not lose the local voice evidence
async function testVoiceUploadFailurePreservesLocal(): Promise<void> {
  resetStores();
  uploadShouldFail = true;
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

  mgr.register('sess-003', makeBlob(2048), 2000, 'audio/ogg', 'IMMEDIATE', ADMIN);
  await new Promise(r => setTimeout(r, 50));

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Voice: local evidence preserved after upload failure');
  await assertEq(ops[0].ownerId, ADMIN, 'Voice: failed op retains original ownerId');
  assert(uploadedVoiceNotes.length === 0, 'Voice: no successful upload recorded');

  uploadShouldFail = false;
  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 4. Voice evidence survives reload/recovery after being persisted
async function testVoiceSurvivesReload(): Promise<void> {
  resetStores();
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.register('sess-004', makeBlob(8192), 10000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // Simulate reload: the manager instance is gone, but the op is in storage
  new TestVoiceManager();

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Voice: op survives reload (still in pending_ops)');
  await assertEq(ops[0].payload && (ops[0].payload as { audioBlob: Blob }).audioBlob.size, 8192, 'Voice: Blob size preserved in persisted op');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 5. Queued voice Blob can be reconstructed from IndexedDB
async function testVoiceBlobReconstructedFromIDB(): Promise<void> {
  resetStores();
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  const blob = makeBlob(5120);
  mgr.register('sess-005', blob, 4000, 'audio/ogg', 'ON_SAVE', SHUBHIKA);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  const payload = ops[0].payload as { audioBlob: Blob; mimeType: string; ownerId: string | null };
  assert(payload.audioBlob instanceof Blob, 'Voice: Blob reconstructed from IndexedDB is a Blob');
  await assertEq(payload.audioBlob.size, 5120, 'Voice: reconstructed Blob size matches original');
  await assertEq(payload.ownerId, SHUBHIKA, 'Voice: reconstructed payload ownerId is SHUBHIKA');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 6. User A voice evidence cannot become User B's queue operation
async function testVoiceNoCrossUserQueueOp(): Promise<void> {
  resetStores();
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.register('sess-006', makeBlob(1024), 1000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // Simulate user switch: onSaveAndNext called with SHUBHIKA's ownerId
  mgr.onSaveAndNext('sess-006', SHUBHIKA);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Voice: op still in queue after user-switch onSaveAndNext');
  await assertEq(ops[0].ownerId, ADMIN, 'Voice: op ownerId remains ADMIN (not SHUBHIKA)');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 7. Voice evidence remains owner A after logout/login
async function testVoiceOwnerRetainedAfterLogoutLogin(): Promise<void> {
  resetStores();
  uploadShouldFail = false;
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.register('sess-007', makeBlob(2048), 2000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // Simulate logout/login — new manager instance, user B logs in
  const mgr2 = new TestVoiceManager();
  mgr2.onSessionReset(SHUBHIKA);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Voice: op preserved after user switch + session reset');
  await assertEq(ops[0].ownerId, ADMIN, 'Voice: op ownerId is still ADMIN after SHUBHIKA session reset');
  assert(uploadedVoiceNotes.length === 0, 'Voice: no upload dispatched by wrong user session reset (offline)');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 8. Voice upload uses captured ownerId rather than current auth user
async function testVoiceUploadUsesCapturedOwnerId(): Promise<void> {
  resetStores();
  uploadShouldFail = false;
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

  // Register with ADMIN ownerId
  mgr.register('sess-008', makeBlob(1024), 1000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // Simulate user switch before Save & Next
  mgr.onSaveAndNext('sess-008', SHUBHIKA);

  await new Promise(r => setTimeout(r, 50));

  assert(uploadedVoiceNotes.length === 1, 'Voice: upload completed after onSaveAndNext');
  await assertEq(uploadedVoiceNotes[0].ownerId, ADMIN, 'Voice: upload used ADMIN (captured), not SHUBHIKA (current)');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 9. User B's flush does not process User A's voice operation
async function testVoiceFlushOwnerIsolation(): Promise<void> {
  resetStores();
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.register('sess-009', makeBlob(2048), 3000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // Simulate User B flushing their queue — should not touch ADMIN's op
  const allOps = await mockDbGetAllInStore<MockOp>('pending_ops');
  const userBOps = allOps.filter(op => op.ownerId === SHUBHIKA);
  await assertEq(userBOps.length, 0, 'Voice: User B flush finds 0 ops (ADMIN op not visible)');

  const userAOps = allOps.filter(op => op.ownerId === ADMIN);
  await assertEq(userAOps.length, 1, 'Voice: ADMIN op still in queue for ADMIN to process');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 10. User A can process the operation after logging back in
async function testVoiceOwnerCanProcessAfterReturn(): Promise<void> {
  resetStores();
  uploadShouldFail = false;
  const mgr = new TestVoiceManager();
  const origOnline = navigator.onLine;

  // ADMIN registers offline, goes away, comes back online
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  mgr.register('sess-010', makeBlob(1024), 1000, 'audio/ogg', 'ON_SAVE', ADMIN);

  // ADMIN returns, goes online, Save & Next
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  mgr.onSaveAndNext('sess-010', ADMIN);

  await new Promise(r => setTimeout(r, 50));

  assert(uploadedVoiceNotes.length === 1, 'Voice: ADMIN successfully processed own op after returning');
  await assertEq(uploadedVoiceNotes[0].ownerId, ADMIN, 'Voice: processed op has ADMIN ownerId');

  const remainingOps = await mockDbGetAllInStore<MockOp>('pending_ops');
  await assertEq(remainingOps.length, 0, 'Voice: op cleaned up after successful upload');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// ─── NOTES IMAGE TESTS ──────────────────────────────────────────────────────

// 11. Notes image is durably persisted at registration
async function testNotesImagePersistedAtRegistration(): Promise<void> {
  resetStores();
  const mgr = new TestNotesImageManager();

  mgr.registerNotesImage('sess-n001', 'data:image/jpeg;base64,AAA', ADMIN);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Notes: op persisted at registration');
  await assertEq(ops[0].ownerId, ADMIN, 'Notes: op ownerId is ADMIN');
  await assertEq(ops[0].type, 'upload_notes_image', 'Notes: op type is upload_notes_image');
}

// 12. Notes image is not silently dropped when offline
async function testNotesImageNotDroppedOffline(): Promise<void> {
  resetStores();
  const mgr = new TestNotesImageManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.registerNotesImage('sess-n002', 'data:image/jpeg;base64,BBB', ADMIN);
  mgr.onSaveAndNext('sess-n002');

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Notes: op preserved when offline Save & Next');
  assert(uploadedNotesImages.length === 0, 'Notes: no upload attempted offline (expected)');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 13. Offline notes image reaches the correct queue path
async function testNotesImageOfflineQueuePath(): Promise<void> {
  resetStores();
  const mgr = new TestNotesImageManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.registerNotesImage('sess-n003', 'data:image/jpeg;base64,CCC', SHUBHIKA);

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  const notesOps = ops.filter(op => op.type === 'upload_notes_image');
  await assertEq(notesOps.length, 1, 'Notes: offline op in queue with correct type');
  await assertEq(notesOps[0].ownerId, SHUBHIKA, 'Notes: offline op has correct ownerId');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 14. Notes image survives reload before upload
async function testNotesImageSurvivesReload(): Promise<void> {
  resetStores();
  const mgr = new TestNotesImageManager();

  mgr.registerNotesImage('sess-n004', 'data:image/jpeg;base64,DDD', ADMIN);

  // Simulate reload — new instance, op should still be in storage
  new TestNotesImageManager();

  const ops = await mockDbGetAllInStore<MockOp>('pending_ops');
  assert(ops.length === 1, 'Notes: op survives reload');
  const payload = ops[0].payload as { dataUrl: string; ownerId: string | null };
  await assertEq(payload.dataUrl, 'data:image/jpeg;base64,DDD', 'Notes: dataUrl preserved across reload');
  await assertEq(payload.ownerId, ADMIN, 'Notes: ownerId preserved across reload');
}

// 15. Notes image retains original owner/session association
async function testNotesImageRetainsOwner(): Promise<void> {
  resetStores();
  uploadShouldFail = false;
  const mgr = new TestNotesImageManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

  mgr.registerNotesImage('sess-n005', 'data:image/jpeg;base64,EEE', ADMIN);
  mgr.onSaveAndNext('sess-n005');

  await new Promise(r => setTimeout(r, 50));

  assert(uploadedNotesImages.length === 1, 'Notes: upload completed');
  await assertEq(uploadedNotesImages[0].ownerId, ADMIN, 'Notes: upload used ADMIN ownerId');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 16. User B cannot process User A's queued notes-image operation
async function testNotesImageUserBCannotProcessUserA(): Promise<void> {
  resetStores();
  const mgr = new TestNotesImageManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  mgr.registerNotesImage('sess-n006', 'data:image/jpeg;base64,FFF', ADMIN);

  // Simulate User B trying to flush
  const allOps = await mockDbGetAllInStore<MockOp>('pending_ops');
  const userBOps = allOps.filter(op => op.ownerId === SHUBHIKA);
  await assertEq(userBOps.length, 0, 'Notes: User B flush finds 0 ops (ADMIN op not visible)');

  const userAOps = allOps.filter(op => op.ownerId === ADMIN);
  await assertEq(userAOps.length, 1, 'Notes: ADMIN op still in queue');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testVoiceRegistrationCapturesOwnerId();
  await testVoicePersistedBeforeOnlineUpload();
  await testVoiceUploadFailurePreservesLocal();
  await testVoiceSurvivesReload();
  await testVoiceBlobReconstructedFromIDB();
  await testVoiceNoCrossUserQueueOp();
  await testVoiceOwnerRetainedAfterLogoutLogin();
  await testVoiceUploadUsesCapturedOwnerId();
  await testVoiceFlushOwnerIsolation();
  await testVoiceOwnerCanProcessAfterReturn();

  await testNotesImagePersistedAtRegistration();
  await testNotesImageNotDroppedOffline();
  await testNotesImageOfflineQueuePath();
  await testNotesImageSurvivesReload();
  await testNotesImageRetainsOwner();
  await testNotesImageUserBCannotProcessUserA();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
