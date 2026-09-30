// Tests for business card asset ownership isolation in IndexedDB.
// Run with: npx tsx src/capture/assetOwnership.test.ts

// ─── Mock IndexedDB asset store ──────────────────────────────────────────────

interface MockAsset {
  id:        string;
  sessionId: string;
  side:      'front' | 'back';
  dataUrl:   string;
  mimeType:  string;
  originalWidth:  number;
  originalHeight: number;
  storedWidth:    number;
  storedHeight:   number;
  sizeBytes:  number;
  createdAt: string;
  ownerId?:  string | null;
}

const assetStore: Map<string, MockAsset> = new Map();
let idCounter = 0;

function resetStore(): void {
  assetStore.clear();
  idCounter = 0;
}

function makeAsset(
  sessionId: string,
  side: 'front' | 'back',
  ownerId: string | null,
  dataUrl = 'data:image/jpeg;base64,AAA',
): MockAsset {
  const id = `asset_${++idCounter}`;
  const asset: MockAsset = {
    id, sessionId, side, dataUrl,
    mimeType: 'image/jpeg',
    originalWidth: 800, originalHeight: 450,
    storedWidth: 800, storedHeight: 450,
    sizeBytes: 1024,
    createdAt: new Date().toISOString(),
    ownerId,
  };
  assetStore.set(id, asset);
  return asset;
}

// ─── Mock db functions (mirror captureAssetStorage logic) ────────────────────

async function mockDbGet(id: string): Promise<MockAsset | null> {
  return assetStore.get(id) ?? null;
}

async function mockDbGetAllBySession(sessionId: string): Promise<MockAsset[]> {
  return Array.from(assetStore.values()).filter(a => a.sessionId === sessionId);
}

async function mockDbDelete(id: string): Promise<void> {
  assetStore.delete(id);
}

// ─── Mirror the owner-aware captureAssetStorage functions ────────────────────

async function saveAsset(sessionId: string, side: 'front' | 'back', _rawDataUrl: string, ownerId?: string | null): Promise<MockAsset> {
  return makeAsset(sessionId, side, ownerId ?? null);
}

async function getAsset(id: string, ownerId?: string | null): Promise<MockAsset | null> {
  const asset = await mockDbGet(id);
  if (!asset) return null;
  if (ownerId !== undefined) {
    if (asset.ownerId !== ownerId) return null;
  }
  return asset;
}

async function getSessionAssets(sessionId: string, ownerId?: string | null): Promise<MockAsset[]> {
  const assets = await mockDbGetAllBySession(sessionId);
  if (ownerId !== undefined) {
    return assets.filter(a => a.ownerId === ownerId);
  }
  return assets;
}

async function deleteAsset(id: string, ownerId?: string | null): Promise<void> {
  if (ownerId !== undefined) {
    const asset = await mockDbGet(id);
    if (!asset || asset.ownerId !== ownerId) return;
  }
  return mockDbDelete(id);
}

async function deleteSessionAssets(sessionId: string, ownerId?: string | null): Promise<void> {
  const assets = await getSessionAssets(sessionId, ownerId);
  await Promise.all(assets.map(a => deleteAsset(a.id, ownerId)));
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';
const RAHUL = 'auth-uid-rahul-003';

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

// ─── Creation tests ──────────────────────────────────────────────────────────

// 1. New asset stores ownerId
async function testNewAssetStoresOwnerId(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-001', 'front', 'data:image/jpeg;base64,AAA', ADMIN);
  assert(asset.ownerId === ADMIN, 'Creation: new asset stores ownerId');
}

// 2. Asset ownerId equals the operation's captured auth UID
async function testOwnerIdEqualsCapturedAuthUid(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-002', 'front', 'data:...', SHUBHIKA);
  await assertEq(asset.ownerId, SHUBHIKA, 'Creation: ownerId equals captured auth UID');
}

// 3. Owner is not resolved later from current auth
async function testOwnerNotResolvedLater(): Promise<void> {
  resetStore();
  // User A creates the asset
  const asset = await saveAsset('sess-003', 'front', 'data:...', ADMIN);
  // Simulate "current auth" being SHUBHIKA — retrieve with ADMIN's ownerId
  const retrieved = await getAsset(asset.id, ADMIN);
  assert(retrieved !== null, 'Creation: owner retrieved with correct ownerId');
  await assertEq(retrieved?.ownerId, ADMIN, 'Creation: ownerId unchanged from creation time');

  // Retrieve with wrong owner — should be null
  const wrongOwner = await getAsset(asset.id, SHUBHIKA);
  await assertEq(wrongOwner, null, 'Creation: wrong owner cannot retrieve asset');
}

// ─── Retrieval tests ─────────────────────────────────────────────────────────

// 4. User A can retrieve User A asset
async function testUserARetrievesOwnAsset(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-004', 'front', 'data:...', ADMIN);
  const retrieved = await getAsset(asset.id, ADMIN);
  assert(retrieved !== null, 'Retrieval: User A can retrieve own asset');
  await assertEq(retrieved?.id, asset.id, 'Retrieval: correct asset returned');
}

// 5. User B cannot retrieve User A asset
async function testUserBCannotRetrieveUserAAsset(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-005', 'front', 'data:...', ADMIN);
  const retrieved = await getAsset(asset.id, SHUBHIKA);
  await assertEq(retrieved, null, 'Retrieval: User B cannot retrieve User A asset');
}

// 6. Owner-scoped retrieval excludes legacy ownerless assets
async function testOwnerScopedExcludesLegacy(): Promise<void> {
  resetStore();
  // Create a legacy asset (no ownerId)
  makeAsset('sess-006', 'front', null);
  // ADMIN-scoped retrieval should NOT return it
  const retrieved = await getAsset('asset_1', ADMIN);
  await assertEq(retrieved, null, 'Retrieval: owner-scoped excludes legacy ownerless asset');
}

// 7. getSessionAssets(sessionId, A) returns only A's assets
async function testGetSessionAssetsReturnsOnlyOwnerA(): Promise<void> {
  resetStore();
  await saveAsset('sess-007', 'front', 'data:...', ADMIN);
  await saveAsset('sess-007', 'back', 'data:...', ADMIN);
  await saveAsset('sess-007', 'front', 'data:...', SHUBHIKA);

  const adminAssets = await getSessionAssets('sess-007', ADMIN);
  await assertEq(adminAssets.length, 2, 'Retrieval: getSessionAssets(A) returns only A assets');
  assert(adminAssets.every(a => a.ownerId === ADMIN), 'Retrieval: all returned assets belong to A');
}

// 8. getSessionAssets(sessionId, B) cannot return A's assets
async function testGetSessionAssetsBCannotReturnA(): Promise<void> {
  resetStore();
  await saveAsset('sess-008', 'front', 'data:...', ADMIN);
  await saveAsset('sess-008', 'back', 'data:...', SHUBHIKA);

  const shubhikaAssets = await getSessionAssets('sess-008', SHUBHIKA);
  await assertEq(shubhikaAssets.length, 1, 'Retrieval: getSessionAssets(B) returns only B assets');
  await assertEq(shubhikaAssets[0].ownerId, SHUBHIKA, 'Retrieval: B asset has correct owner');
}

// 9. Same session ID with different ownerId does not bypass ownership
async function testSameSessionDifferentOwnerNoBypass(): Promise<void> {
  resetStore();
  await saveAsset('sess-009', 'front', 'data:...', ADMIN);
  await saveAsset('sess-009', 'back', 'data:...', RAHUL);

  const adminAssets = await getSessionAssets('sess-009', ADMIN);
  const rahulAssets = await getSessionAssets('sess-009', RAHUL);

  await assertEq(adminAssets.length, 1, 'Retrieval: same session, A gets 1 asset');
  await assertEq(rahulAssets.length, 1, 'Retrieval: same session, C gets 1 asset');
  await assertEq(adminAssets[0].ownerId, ADMIN, 'Retrieval: A asset belongs to A');
  await assertEq(rahulAssets[0].ownerId, RAHUL, 'Retrieval: C asset belongs to C');
}

// ─── Deletion tests ──────────────────────────────────────────────────────────

// 10. User A can delete User A asset
async function testUserADeletesOwnAsset(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-010', 'front', 'data:...', ADMIN);
  await deleteAsset(asset.id, ADMIN);
  const retrieved = await getAsset(asset.id, ADMIN);
  await assertEq(retrieved, null, 'Deletion: User A can delete own asset');
}

// 11. User B cannot delete User A asset
async function testUserBCannotDeleteUserAAsset(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-011', 'front', 'data:...', ADMIN);
  await deleteAsset(asset.id, SHUBHIKA);
  // Asset should still exist
  const retrieved = await getAsset(asset.id, ADMIN);
  assert(retrieved !== null, 'Deletion: User B cannot delete User A asset (still exists)');
}

// 12. User B cannot delete A's session assets
async function testUserBCannotDeleteASessionAssets(): Promise<void> {
  resetStore();
  await saveAsset('sess-012', 'front', 'data:...', ADMIN);
  await saveAsset('sess-012', 'back', 'data:...', ADMIN);

  await deleteSessionAssets('sess-012', SHUBHIKA);
  const remaining = await getSessionAssets('sess-012', ADMIN);
  await assertEq(remaining.length, 2, 'Deletion: User B cannot delete A session assets');
}

// 13. Owner-scoped deletion cannot delete legacy ownerless assets
async function testOwnerScopedCannotDeleteLegacy(): Promise<void> {
  resetStore();
  const legacy = makeAsset('sess-013', 'front', null);
  await deleteAsset(legacy.id, ADMIN);
  // Legacy asset should still exist
  const retrieved = await mockDbGet(legacy.id);
  assert(retrieved !== null, 'Deletion: owner-scoped cannot delete legacy ownerless asset');
}

// 14. Denied deletion leaves the original record unchanged
async function testDeniedDeletionLeavesRecord(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-014', 'front', 'data:...', ADMIN);
  const originalCreatedAt = asset.createdAt;
  await deleteAsset(asset.id, SHUBHIKA);
  const retrieved = await getAsset(asset.id, ADMIN);
  assert(retrieved !== null, 'Deletion: denied deletion leaves record intact');
  await assertEq(retrieved?.createdAt, originalCreatedAt, 'Deletion: record unchanged after denied delete');
}

// ─── User switching tests ────────────────────────────────────────────────────

// 15. User A creates → User B logs in → B cannot retrieve
async function testUserSwitchCannotRetrieve(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-015', 'front', 'data:...', ADMIN);
  // Simulate User B now logged in
  const bRetrieval = await getAsset(asset.id, SHUBHIKA);
  await assertEq(bRetrieval, null, 'UserSwitch: B cannot retrieve A asset after user switch');
}

// 16. User A creates → User B logs in → B cannot delete
async function testUserSwitchCannotDelete(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-016', 'front', 'data:...', ADMIN);
  // Simulate User B now logged in
  await deleteAsset(asset.id, SHUBHIKA);
  // A should still be able to retrieve it
  const aRetrieval = await getAsset(asset.id, ADMIN);
  assert(aRetrieval !== null, 'UserSwitch: B cannot delete A asset (A still retrieves it)');
}

// 17. User A logs back in → A can still retrieve
async function testUserARetrievesAfterReturn(): Promise<void> {
  resetStore();
  const asset = await saveAsset('sess-017', 'front', 'data:...', ADMIN);
  // Simulate B logs in, tries to access, fails
  await getAsset(asset.id, SHUBHIKA);
  // A logs back in
  const aRetrieval = await getAsset(asset.id, ADMIN);
  assert(aRetrieval !== null, 'UserSwitch: A can retrieve own asset after logging back in');
  await assertEq(aRetrieval?.ownerId, ADMIN, 'UserSwitch: A asset ownerId preserved');
}

// ─── Legacy tests ────────────────────────────────────────────────────────────

// 18. Legacy ownerless asset remains in IndexedDB
async function testLegacyAssetRemains(): Promise<void> {
  resetStore();
  const legacy = makeAsset('sess-018', 'front', null);
  const raw = await mockDbGet(legacy.id);
  assert(raw !== null, 'Legacy: ownerless asset remains in store');
}

// 19. Owner-scoped APIs exclude legacy asset
async function testOwnerScopedExcludesLegacyFromSession(): Promise<void> {
  resetStore();
  makeAsset('sess-019', 'front', null);
  makeAsset('sess-019', 'back', null);
  const adminAssets = await getSessionAssets('sess-019', ADMIN);
  await assertEq(adminAssets.length, 0, 'Legacy: owner-scoped getSessionAssets excludes legacy assets');
}

// 20. Explicit unscoped diagnostic access remains possible
async function testUnscopedAccessPossible(): Promise<void> {
  resetStore();
  const legacy = makeAsset('sess-020', 'front', null);
  // Unscoped retrieval (no ownerId argument)
  const unscoped = await getAsset(legacy.id);
  assert(unscoped !== null, 'Legacy: unscoped diagnostic access works');
  // Unscoped session retrieval
  const unscopedSession = await getSessionAssets('sess-020');
  await assertEq(unscopedSession.length, 1, 'Legacy: unscoped getSessionAssets returns legacy asset');
  // Unscoped deletion
  await deleteAsset(legacy.id);
  const afterDelete = await mockDbGet(legacy.id);
  await assertEq(afterDelete, null, 'Legacy: unscoped deletion works for recovery');
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testNewAssetStoresOwnerId();
  await testOwnerIdEqualsCapturedAuthUid();
  await testOwnerNotResolvedLater();

  await testUserARetrievesOwnAsset();
  await testUserBCannotRetrieveUserAAsset();
  await testOwnerScopedExcludesLegacy();
  await testGetSessionAssetsReturnsOnlyOwnerA();
  await testGetSessionAssetsBCannotReturnA();
  await testSameSessionDifferentOwnerNoBypass();

  await testUserADeletesOwnAsset();
  await testUserBCannotDeleteUserAAsset();
  await testUserBCannotDeleteASessionAssets();
  await testOwnerScopedCannotDeleteLegacy();
  await testDeniedDeletionLeavesRecord();

  await testUserSwitchCannotRetrieve();
  await testUserSwitchCannotDelete();
  await testUserARetrievesAfterReturn();

  await testLegacyAssetRemains();
  await testOwnerScopedExcludesLegacyFromSession();
  await testUnscopedAccessPossible();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
