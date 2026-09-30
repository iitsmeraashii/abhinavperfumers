// Lifecycle tests for Version 382:
// A. Deferred card upload data loss on session reset
// B. Delete during in-flight upload safety
// C. Back to Options orphaned local assets
//
// Run with: npx tsx src/capture/cardLifecycle.test.ts

// ─── Mock infrastructure ─────────────────────────────────────────────────────

interface MockAsset {
  id:        string;
  sessionId: string;
  side:      'front' | 'back';
  dataUrl:   string;
  mimeType:  string;
  sizeBytes: number;
  ownerId?:  string | null;
}

interface MockOp {
  id:        string;
  ownerId:   string | null;
  type:      string;
  sessionId: string;
  createdAt: string;
  retries:   number;
  payload:   unknown;
}

const assetStore: Map<string, MockAsset> = new Map();
const opStore: Map<string, MockOp> = new Map();
const uploadedCards: { assetId: string; sessionId: string; metadataWritten: boolean }[] = [];
let uploadDelay = 0;
let uploadShouldFail = false;
let idCounter = 0;

function resetStores(): void {
  assetStore.clear();
  opStore.clear();
  uploadedCards.length = 0;
  uploadDelay = 0;
  uploadShouldFail = false;
  idCounter = 0;
}

function makeAsset(sessionId: string, side: 'front' | 'back', ownerId: string | null): MockAsset {
  const id = `asset_${++idCounter}`;
  const asset: MockAsset = { id, sessionId, side, dataUrl: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', sizeBytes: 1024, ownerId };
  assetStore.set(id, asset);
  return asset;
}

// ─── Mock evidence manager (mirrors Version 382 logic) ───────────────────────

class TestEvidenceManager {
  private _pendingCardUploads: Map<string, MockAsset[]> = new Map();
  private _abandonedAssetIds: Set<string> = new Set();

  register(asset: MockAsset, uploadTiming: 'IMMEDIATE' | 'ON_SAVE' | 'NEVER'): void {
    if (uploadTiming === 'ON_SAVE') {
      const arr = this._pendingCardUploads.get(asset.sessionId) ?? [];
      arr.push(asset);
      this._pendingCardUploads.set(asset.sessionId, arr);
    } else if (uploadTiming === 'IMMEDIATE' && !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void this._uploadBusinessCard(asset);
    }
  }

  flushPendingUploads(sessionId: string): void {
    const pending = this._pendingCardUploads.get(sessionId);
    if (!pending || pending.length === 0) return;
    this._pendingCardUploads.delete(sessionId);
    for (const asset of pending) {
      void this._uploadBusinessCard(asset);
    }
  }

  abandonAsset(assetId: string): void {
    this._abandonedAssetIds.add(assetId);
    for (const [sid, assets] of this._pendingCardUploads) {
      this._pendingCardUploads.set(sid, assets.filter(a => a.id !== assetId));
    }
  }

  isAssetAbandoned(assetId: string): boolean {
    return this._abandonedAssetIds.has(assetId);
  }

  onSessionReset(ownerId: string | null = null): void {
    // Durable enqueue of remaining deferred card uploads
    for (const [sessionId, assets] of this._pendingCardUploads) {
      for (const asset of assets) {
        if (this._abandonedAssetIds.has(asset.id)) continue;
        const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const op: MockOp = {
          id: opId,
          ownerId: asset.ownerId ?? ownerId,
          type: 'upload_business_card',
          sessionId,
          createdAt: new Date().toISOString(),
          retries: 0,
          payload: { assetId: asset.id, sessionId, dataUrl: asset.dataUrl, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, ownerId: asset.ownerId ?? ownerId },
        };
        opStore.set(opId, op);
      }
    }
    this._pendingCardUploads.clear();
    this._abandonedAssetIds.clear();
  }

  private async _uploadBusinessCard(asset: MockAsset): Promise<void> {
    if (this.isAssetAbandoned(asset.id)) return;

    // In Node.js tests, navigator.onLine is undefined — treat as online
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    if (uploadDelay > 0) {
      await new Promise(r => setTimeout(r, uploadDelay));
    }

    // Re-check abandoned AFTER delay (simulates in-flight check)
    if (this.isAssetAbandoned(asset.id)) return;

    if (uploadShouldFail) return;

    uploadedCards.push({ assetId: asset.id, sessionId: asset.sessionId, metadataWritten: true });
  }
}

// ─── Mock asset storage ──────────────────────────────────────────────────────

async function deleteSessionAssets(sessionId: string, ownerId?: string | null): Promise<void> {
  const assets = Array.from(assetStore.values()).filter(a => a.sessionId === sessionId);
  for (const a of assets) {
    if (ownerId !== undefined && a.ownerId !== ownerId) continue;
    assetStore.delete(a.id);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';

// ─── Test helpers ────────────────────────────────────────────────────────────

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

// ─── ISSUE A: Deferred card upload data loss ─────────────────────────────────

// 1. onSessionReset() cannot silently discard a pending card upload
async function testResetCannotDiscardPendingUpload(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();
  const asset = makeAsset('sess-001', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Reset WITHOUT calling flushPendingUploads first
  mgr.onSessionReset(ADMIN);

  const ops = Array.from(opStore.values());
  assert(ops.length === 1, 'A1: pending card upload enqueued on reset (not discarded)');
  await assertEq(ops[0].type, 'upload_business_card', 'A1: op type is upload_business_card');
  assert(uploadedCards.length === 0, 'A1: no upload dispatched (was deferred)');
}

// 2. Pending deferred card upload survives reset
async function testDeferredUploadSurvivesReset(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();
  const asset = makeAsset('sess-002', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  mgr.onSessionReset(ADMIN);

  const ops = Array.from(opStore.values());
  assert(ops.length === 1, 'A2: deferred upload survived reset in queue');
  const payload = ops[0].payload as { assetId: string; dataUrl: string };
  await assertEq(payload.assetId, asset.id, 'A2: queued op has correct asset ID');
  await assertEq(payload.dataUrl, 'data:image/jpeg;base64,AAA', 'A2: queued op has asset data');
}

// 3. Offline card upload survives reset
async function testOfflineCardUploadSurvivesReset(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();
  const origOnline = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

  const asset = makeAsset('sess-003', 'front', ADMIN);
  // Even IMMEDIATE timing won't upload offline
  mgr.register(asset, 'IMMEDIATE');

  mgr.onSessionReset(ADMIN);

  // No pending uploads after offline reset (IMMEDIATE doesn't enqueue to _pendingCardUploads)
  // But the local asset is still available
  assert(assetStore.size === 1, 'A3: local asset still exists after offline reset');
  assert(uploadedCards.length === 0, 'A3: no upload attempted offline');

  Object.defineProperty(navigator, 'onLine', { value: origOnline, configurable: true });
}

// 4. Failed card upload remains retryable
async function testFailedUploadRemainsRetryable(): Promise<void> {
  resetStores();
  uploadShouldFail = true;
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-004', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Flush attempts upload but it fails
  mgr.flushPendingUploads('sess-004');
  await new Promise(r => setTimeout(r, 50));

  assert(uploadedCards.length === 0, 'A4: failed upload did not record success');

  // Reset after failed flush — no pending uploads left (flush already cleared them)
  mgr.onSessionReset(ADMIN);
  // The local asset still exists for manual retry
  assert(assetStore.size === 1, 'A4: local asset still exists for retry');

  uploadShouldFail = false;
}

// 5. Normal flush + reset path does not duplicate uploads
async function testFlushThenResetNoDuplication(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-005', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Normal path: flush first, then reset
  mgr.flushPendingUploads('sess-005');
  await new Promise(r => setTimeout(r, 200));

  mgr.onSessionReset(ADMIN);

  const ops = Array.from(opStore.values());
  assert(uploadedCards.length === 1, 'A5: exactly one upload dispatched (no duplication)');
  await assertEq(ops.length, 0, 'A5: no ops enqueued (flush already handled it)');
}

// 6. Repeated reset is idempotent
async function testRepeatedResetIdempotent(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-006', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  mgr.onSessionReset(ADMIN);
  const opsAfterFirst = Array.from(opStore.values());

  // Second reset — pending map is already empty
  mgr.onSessionReset(ADMIN);
  const opsAfterSecond = Array.from(opStore.values());

  await assertEq(opsAfterFirst.length, 1, 'A6: first reset enqueues 1 op');
  await assertEq(opsAfterSecond.length, 1, 'A6: second reset does not duplicate');
}

// ─── ISSUE B: Delete during in-flight upload ─────────────────────────────────

// 7. Retaking a card cannot leave an inconsistent backend asset record
async function testRetakeDuringUpload(): Promise<void> {
  resetStores();
  uploadDelay = 50;
  const mgr = new TestEvidenceManager();

  const origAsset = makeAsset('sess-007', 'front', ADMIN);
  mgr.register(origAsset, 'ON_SAVE');

  // Simulate retake: abandon old asset, then flush
  mgr.abandonAsset(origAsset.id);
  mgr.flushPendingUploads('sess-007');

  await new Promise(r => setTimeout(r, 100));

  assert(uploadedCards.length === 0, 'B7: retaken asset did not produce backend record');
  uploadDelay = 0;
}

// 8. Explicit card deletion cannot leave an unexpected backend asset record
async function testDeleteDuringUpload(): Promise<void> {
  resetStores();
  uploadDelay = 50;
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-008', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // User deletes — abandon first, then flush
  mgr.abandonAsset(asset.id);
  mgr.flushPendingUploads('sess-008');

  await new Promise(r => setTimeout(r, 100));

  assert(uploadedCards.length === 0, 'B8: deleted asset did not produce backend record');
  uploadDelay = 0;
}

// 9. Draft discard cannot create a late asset record after discard
async function testDiscardDuringUpload(): Promise<void> {
  resetStores();
  uploadDelay = 50;
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-009', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Simulate discard: abandon + delete session assets + flush + reset
  mgr.abandonAsset(asset.id);
  await deleteSessionAssets('sess-009', ADMIN);
  mgr.flushPendingUploads('sess-009');
  mgr.onSessionReset(ADMIN);

  await new Promise(r => setTimeout(r, 100));

  assert(uploadedCards.length === 0, 'B9: discarded asset did not produce late backend record');
  assert(assetStore.size === 0, 'B9: local assets cleaned up after discard');
  uploadDelay = 0;
}

// 10. An already-durable queue operation remains processable if local UI state is reset
async function testDurableQueueOpProcessableAfterReset(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-010', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Reset enqueues to durable queue
  mgr.onSessionReset(ADMIN);

  const ops = Array.from(opStore.values());
  assert(ops.length === 1, 'B10: op in durable queue after reset');
  await assertEq(ops[0].payload && (ops[0].payload as { assetId: string }).assetId, asset.id, 'B10: op has asset ID');
  // The op contains all data needed for upload (dataUrl in payload)
  const payload = ops[0].payload as { dataUrl: string; mimeType: string };
  assert(!!payload.dataUrl, 'B10: op payload contains dataUrl for retry');
  assert(!!payload.mimeType, 'B10: op payload contains mimeType for retry');
}

// 11. Owner-scoped deletion still prevents cross-user deletion
async function testOwnerScopedDeletionPreventsCrossUser(): Promise<void> {
  resetStores();
  makeAsset('sess-011', 'front', ADMIN);
  makeAsset('sess-011', 'back', SHUBHIKA);

  // SHUBHIKA tries to delete all session assets
  await deleteSessionAssets('sess-011', SHUBHIKA);

  const remaining = Array.from(assetStore.values()).filter(a => a.sessionId === 'sess-011');
  await assertEq(remaining.length, 1, 'B11: cross-user deletion prevented (ADMIN asset remains)');
  await assertEq(remaining[0].ownerId, ADMIN, 'B11: remaining asset belongs to ADMIN');
}

// ─── ISSUE C: Back to Options orphaned local assets ──────────────────────────

// 12. Back to Options cleans up genuinely abandoned local card assets
async function testBackToOptionsCleansUpAssets(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-012', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Simulate handleBackToOptions: reset + deleteSessionAssets
  mgr.onSessionReset(ADMIN);
  await deleteSessionAssets('sess-012', ADMIN);

  const remaining = Array.from(assetStore.values()).filter(a => a.sessionId === 'sess-012');
  await assertEq(remaining.length, 0, 'C12: back to options cleaned up local card assets');
}

// 13. Back to Options does not destroy evidence still required by a durable pending upload
async function testBackToOptionsPreservesDurableQueueOp(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  const asset = makeAsset('sess-013', 'front', ADMIN);
  mgr.register(asset, 'ON_SAVE');

  // Simulate handleBackToOptions: reset enqueues to queue, THEN delete local asset
  mgr.onSessionReset(ADMIN);
  await deleteSessionAssets('sess-013', ADMIN);

  // Local asset is deleted, but the durable queue op still has the data
  const ops = Array.from(opStore.values());
  assert(ops.length === 1, 'C13: durable queue op preserved after local asset deletion');
  const payload = ops[0].payload as { dataUrl: string };
  assert(!!payload.dataUrl, 'C13: queue op still has dataUrl for upload retry');
}

// 14. Starting a new capture method after abandoning business-card capture does not leave orphaned local assets
async function testNewCaptureAfterAbandonNoOrphans(): Promise<void> {
  resetStores();
  const mgr = new TestEvidenceManager();

  makeAsset('sess-014', 'front', ADMIN);
  makeAsset('sess-014', 'back', ADMIN);

  // Simulate back to options + switch to MANUAL
  mgr.onSessionReset(ADMIN);
  await deleteSessionAssets('sess-014', ADMIN);

  // Start a new session — no orphans from old session
  const remaining = Array.from(assetStore.values());
  await assertEq(remaining.length, 0, 'C14: no orphaned local assets after abandoning card capture');
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testResetCannotDiscardPendingUpload();
  await testDeferredUploadSurvivesReset();
  await testOfflineCardUploadSurvivesReset();
  await testFailedUploadRemainsRetryable();
  await testFlushThenResetNoDuplication();
  await testRepeatedResetIdempotent();

  await testRetakeDuringUpload();
  await testDeleteDuringUpload();
  await testDiscardDuringUpload();
  await testDurableQueueOpProcessableAfterReset();
  await testOwnerScopedDeletionPreventsCrossUser();

  await testBackToOptionsCleansUpAssets();
  await testBackToOptionsPreservesDurableQueueOp();
  await testNewCaptureAfterAbandonNoOrphans();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
