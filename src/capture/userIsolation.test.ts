// Tests for offline queue ownership isolation.
// Run with: npx tsx src/capture/userIsolation.test.ts

// ─── Mock IndexedDB ──────────────────────────────────────────────────────────

interface DBRecord { id: string; ownerId: string | null; [k: string]: unknown }

const mockStores: Map<string, Map<string, { id: string; [k: string]: unknown }>> = new Map([
  ['drafts',          new Map()],
  ['completed_leads', new Map()],
  ['assets',          new Map()],
  ['pending_ops',     new Map()],
  ['lead_queue',      new Map()],
]);

function resetStores(): void {
  for (const store of mockStores.values()) store.clear();
}

async function mockDbGet<T>(store: string, key: string): Promise<T | null> {
  const s = mockStores.get(store);
  if (!s) return null;
  return (s.get(key) as T) ?? null;
}

async function mockDbPut(store: string, record: unknown): Promise<void> {
  const s = mockStores.get(store);
  if (!s) return;
  const r = record as { id: string; [k: string]: unknown };
  s.set(r.id, { ...r });
}

async function mockDbDelete(store: string, key: string): Promise<void> {
  const s = mockStores.get(store);
  if (!s) return;
  s.delete(key);
}

// ─── Types (mirror storage interfaces) ───────────────────────────────────────

const DRAFT_KEY = 'active_capture_draft';
const SAVED_DRAFT_PREFIX = 'saved_draft:';

interface PDraft {
  id: string;
  ownerId: string | null;
  captureMethod: string;
  sessionStatus: string;
  draftData: Record<string, unknown>;
  hasUnsavedChanges: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  backendSessionId: string | null;
  backendAssetIds: Record<string, string>;
  backendExtractionIds: Record<string, string>;
  lastSyncedAt: string | null;
}

interface CLead {
  id: string;
  ownerId: string | null;
  status: string;
  captureMethod: string | null;
  draftData: Record<string, unknown>;
  backendSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
  retries: number;
  lastError: string | null;
  failedStage: string | null;
  lastAttemptAt: string | null;
  failedAt: string | null;
  isExhausted: boolean;
}

// ─── Storage logic (verbatim from captureDraftStorage / completedLeadsStorage) ─

function isValidDraft(r: unknown): r is PDraft {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<PDraft>;
  return o.id === DRAFT_KEY && o.captureMethod != null && o.sessionStatus != null && typeof o.draftData === 'object';
}

function isValidSavedDraft(r: unknown): r is PDraft {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<PDraft>;
  return typeof o.id === 'string' && o.id.startsWith(SAVED_DRAFT_PREFIX) && o.captureMethod != null && o.sessionStatus != null && typeof o.draftData === 'object';
}

async function loadDraft(ownerId?: string): Promise<PDraft | null> {
  const raw = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  if (!isValidDraft(raw)) return null;
  if (ownerId && raw.ownerId !== ownerId) return null;
  return raw;
}

async function clearDraft(ownerId?: string): Promise<boolean> {
  const raw = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  if (!raw) return true;
  if (ownerId && raw.ownerId !== ownerId) return false;
  await mockDbDelete('drafts', DRAFT_KEY);
  return true;
}

async function saveSavedDraft(session: Partial<PDraft>, ownerId?: string | null): Promise<string> {
  const draftId = `${SAVED_DRAFT_PREFIX}${crypto.randomUUID()}`;
  const record: PDraft = {
    id: draftId,
    ownerId: ownerId ?? null,
    captureMethod: session.captureMethod ?? 'MANUAL',
    sessionStatus: session.sessionStatus ?? 'DRAFT',
    draftData: session.draftData ?? {},
    hasUnsavedChanges: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    backendSessionId: session.backendSessionId ?? null,
    backendAssetIds: {},
    backendExtractionIds: {},
    lastSyncedAt: null,
  };
  await mockDbPut('drafts', record);
  return draftId;
}

async function loadSavedDraft(draftId: string, ownerId?: string): Promise<PDraft | null> {
  const raw = await mockDbGet<PDraft>('drafts', draftId);
  if (!isValidSavedDraft(raw)) return null;
  if (ownerId && raw.ownerId !== ownerId) return null;
  return raw;
}

async function deleteSavedDraft(draftId: string, ownerId?: string): Promise<boolean> {
  const raw = await mockDbGet<PDraft>('drafts', draftId);
  if (!raw) return true;
  if (ownerId && raw.ownerId !== ownerId) return false;
  await mockDbDelete('drafts', draftId);
  return true;
}

async function putCompletedLead(record: CLead): Promise<void> {
  await mockDbPut('completed_leads', record);
}

async function getCompletedLead(id: string): Promise<CLead | null> {
  return mockDbGet<CLead>('completed_leads', id);
}

async function updateCompletedLeadStatus(
  id: string,
  status: string,
  extra: Partial<CLead> = {},
  ownerId?: string,
): Promise<boolean> {
  const existing = await getCompletedLead(id);
  if (!existing) return false;
  if (ownerId && existing.ownerId !== ownerId) return false;
  await putCompletedLead({ ...existing, status, updatedAt: new Date().toISOString(), ...extra });
  return true;
}

async function deleteCompletedLead(id: string, ownerId?: string): Promise<boolean> {
  const existing = await getCompletedLead(id);
  if (!existing) return true;
  if (ownerId && existing.ownerId !== ownerId) return false;
  await mockDbDelete('completed_leads', id);
  return true;
}

async function deleteQueueItem(id: string, ownerId?: string): Promise<boolean> {
  if (id.startsWith('saved_draft:')) {
    return deleteSavedDraft(id, ownerId);
  }
  const lead = await getCompletedLead(id);
  if (lead && ownerId && lead.ownerId !== ownerId) return false;
  await deleteCompletedLead(id, ownerId);
  const draft = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  if (draft) {
    const draftBsid = draft.backendSessionId;
    if (id === 'active_draft' || id === draftBsid) {
      if (ownerId && draft.ownerId !== ownerId) {
        // Don't delete another user's active draft
      } else {
        await mockDbDelete('drafts', DRAFT_KEY);
      }
    }
  }
  return true;
}

// ─── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else { failed++; console.error(`FAIL: ${label}`); }
}

async function assertEq(actual: unknown, expected: unknown, label: string): Promise<void> {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

function makeDraft(ownerId: string | null, backendSessionId = 'bsid-001'): PDraft {
  return {
    id: DRAFT_KEY, ownerId, captureMethod: 'MANUAL', sessionStatus: 'CAPTURING',
    draftData: { clientName: 'Test Lead', company: 'Test Co' },
    hasUnsavedChanges: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    backendSessionId, backendAssetIds: {}, backendExtractionIds: {}, lastSyncedAt: null,
  };
}

function makeCompletedLead(id: string, ownerId: string | null): CLead {
  return {
    id, ownerId, status: 'local_only', captureMethod: 'MANUAL',
    draftData: { clientName: 'Test Lead', company: 'Test Co' },
    backendSessionId: id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    syncedAt: null, retries: 0, lastError: null,
    failedStage: null, lastAttemptAt: null, failedAt: null, isExhausted: false,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';

// ─── Tests: cross-user isolation (ownerId = ADMIN, caller = SHUBHIKA) ─────────

async function testActiveDraftLoadIsolation(): Promise<void> {
  resetStores();
  await mockDbPut('drafts', makeDraft(ADMIN));

  const adminLoad = await loadDraft(ADMIN);
  assert(adminLoad !== null, 'ADMIN can load their own active draft');
  await assertEq(adminLoad?.ownerId, ADMIN, 'ADMIN draft ownerId is ADMIN');

  const shubhikaLoad = await loadDraft(SHUBHIKA);
  assert(shubhikaLoad === null, 'SHUBHIKA cannot load ADMIN active draft');

  const stillThere = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(stillThere !== null, 'ADMIN draft still in storage after SHUBHIKA load attempt');
  await assertEq(stillThere?.ownerId, ADMIN, 'ADMIN draft ownerId unchanged after SHUBHIKA attempt');
}

async function testActiveDraftClearIsolation(): Promise<void> {
  resetStores();
  await mockDbPut('drafts', makeDraft(ADMIN));

  const clearResult = await clearDraft(SHUBHIKA);
  await assertEq(clearResult, false, 'SHUBHIKA clearDraft returns false for ADMIN draft');

  const stillThere = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(stillThere !== null, 'ADMIN draft NOT deleted by SHUBHIKA clearDraft');
  await assertEq(stillThere?.ownerId, ADMIN, 'ADMIN draft ownerId unchanged after SHUBHIKA clear');

  const adminClear = await clearDraft(ADMIN);
  await assertEq(adminClear, true, 'ADMIN clearDraft returns true for own draft');
  const gone = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(gone === null, 'ADMIN draft deleted after ADMIN clearDraft');
}

async function testSavedDraftLoadIsolation(): Promise<void> {
  resetStores();
  const draftId = await saveSavedDraft({ captureMethod: 'MANUAL', sessionStatus: 'DRAFT', draftData: { clientName: 'X' } }, ADMIN);

  const shubhikaLoad = await loadSavedDraft(draftId, SHUBHIKA);
  assert(shubhikaLoad === null, 'SHUBHIKA cannot load ADMIN saved draft');

  const adminLoad = await loadSavedDraft(draftId, ADMIN);
  assert(adminLoad !== null, 'ADMIN can load own saved draft');
}

async function testSavedDraftDeleteIsolation(): Promise<void> {
  resetStores();
  const draftId = await saveSavedDraft({ captureMethod: 'MANUAL', sessionStatus: 'DRAFT', draftData: { clientName: 'X' } }, ADMIN);

  const delResult = await deleteSavedDraft(draftId, SHUBHIKA);
  await assertEq(delResult, false, 'SHUBHIKA deleteSavedDraft returns false for ADMIN draft');

  const stillThere = await mockDbGet<PDraft>('drafts', draftId);
  assert(stillThere !== null, 'ADMIN saved draft NOT deleted by SHUBHIKA');

  const adminDel = await deleteSavedDraft(draftId, ADMIN);
  await assertEq(adminDel, true, 'ADMIN deleteSavedDraft returns true');
  const gone = await mockDbGet<PDraft>('drafts', draftId);
  assert(gone === null, 'ADMIN saved draft deleted by ADMIN');
}

async function testQueueItemDeleteIsolation(): Promise<void> {
  resetStores();
  const leadId = 'lead-001';
  await putCompletedLead(makeCompletedLead(leadId, ADMIN));

  const delResult = await deleteQueueItem(leadId, SHUBHIKA);
  await assertEq(delResult, false, 'SHUBHIKA deleteQueueItem returns false for ADMIN lead');

  const stillThere = await getCompletedLead(leadId);
  assert(stillThere !== null, 'ADMIN queue item NOT deleted by SHUBHIKA');

  const adminDel = await deleteQueueItem(leadId, ADMIN);
  await assertEq(adminDel, true, 'ADMIN deleteQueueItem returns true');
  const gone = await getCompletedLead(leadId);
  assert(gone === null, 'ADMIN queue item deleted by ADMIN');
}

async function testCompletedLeadUpdateIsolation(): Promise<void> {
  resetStores();
  const leadId = 'lead-002';
  await putCompletedLead(makeCompletedLead(leadId, ADMIN));

  const updateResult = await updateCompletedLeadStatus(leadId, 'synced', { syncedAt: new Date().toISOString() }, SHUBHIKA);
  await assertEq(updateResult, false, 'SHUBHIKA updateCompletedLeadStatus returns false');

  const lead = await getCompletedLead(leadId);
  await assertEq(lead?.status, 'local_only', 'ADMIN lead status NOT changed by SHUBHIKA');

  const adminUpdate = await updateCompletedLeadStatus(leadId, 'synced', { syncedAt: new Date().toISOString() }, ADMIN);
  await assertEq(adminUpdate, true, 'ADMIN updateCompletedLeadStatus returns true');
  const updated = await getCompletedLead(leadId);
  await assertEq(updated?.status, 'synced', 'ADMIN lead status changed by ADMIN');
}

async function testCompletedLeadDeleteIsolation(): Promise<void> {
  resetStores();
  const leadId = 'lead-003';
  await putCompletedLead(makeCompletedLead(leadId, ADMIN));

  const delResult = await deleteCompletedLead(leadId, SHUBHIKA);
  await assertEq(delResult, false, 'SHUBHIKA deleteCompletedLead returns false');

  const stillThere = await getCompletedLead(leadId);
  assert(stillThere !== null, 'ADMIN completed lead NOT deleted by SHUBHIKA');

  const adminDel = await deleteCompletedLead(leadId, ADMIN);
  await assertEq(adminDel, true, 'ADMIN deleteCompletedLead returns true');
  const gone = await getCompletedLead(leadId);
  assert(gone === null, 'ADMIN completed lead deleted by ADMIN');
}

// ─── Tests: legacy null-owner records denied to scoped callers ───────────────
// A legacy record with ownerId=null must NOT be accessible to any scoped caller.
// It must remain in storage, unchanged, and only available via unscoped calls.

async function testNullOwnerDraftDeniedToScopedCallers(): Promise<void> {
  resetStores();
  await mockDbPut('drafts', makeDraft(null));

  // ADMIN cannot load a null-owner draft
  const adminLoad = await loadDraft(ADMIN);
  assert(adminLoad === null, 'null-owner draft denied to ADMIN (scoped)');

  // SHUBHIKA cannot load a null-owner draft
  const shubhikaLoad = await loadDraft(SHUBHIKA);
  assert(shubhikaLoad === null, 'null-owner draft denied to SHUBHIKA (scoped)');

  // Record is still in storage, unchanged
  const stillThere = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(stillThere !== null, 'null-owner draft preserved in storage after scoped load attempts');
  await assertEq(stillThere?.ownerId, null, 'null-owner draft ownerId still null (not modified)');

  // ADMIN cannot clear a null-owner draft
  const adminClear = await clearDraft(ADMIN);
  await assertEq(adminClear, false, 'null-owner draft clearDraft denied to ADMIN (scoped)');

  // SHUBHIKA cannot clear a null-owner draft
  const shubhikaClear = await clearDraft(SHUBHIKA);
  await assertEq(shubhikaClear, false, 'null-owner draft clearDraft denied to SHUBHIKA (scoped)');

  // Record still in storage after denied clear attempts
  const afterClear = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(afterClear !== null, 'null-owner draft NOT deleted by scoped clear attempts');
  await assertEq(afterClear?.ownerId, null, 'null-owner draft ownerId still null after denied clears');

  // Unscoped call (no ownerId) CAN access it — diagnostics/recovery
  const unscopedLoad = await loadDraft();
  assert(unscopedLoad !== null, 'null-owner draft accessible via unscoped loadDraft (diagnostics)');
  await assertEq(unscopedLoad?.ownerId, null, 'unscoped load does not modify ownerId');

  const unscopedClear = await clearDraft();
  await assertEq(unscopedClear, true, 'null-owner draft clearable via unscoped clearDraft (recovery)');
  const gone = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(gone === null, 'null-owner draft deleted by unscoped clearDraft');
}

async function testNullOwnerSavedDraftDeniedToScopedCallers(): Promise<void> {
  resetStores();
  // Simulate a legacy saved draft with null owner
  const draftId = `${SAVED_DRAFT_PREFIX}legacy-001`;
  await mockDbPut('drafts', {
    id: draftId, ownerId: null, captureMethod: 'MANUAL', sessionStatus: 'DRAFT',
    draftData: { clientName: 'Legacy' }, hasUnsavedChanges: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    backendSessionId: null, backendAssetIds: {}, backendExtractionIds: {}, lastSyncedAt: null,
  });

  const adminLoad = await loadSavedDraft(draftId, ADMIN);
  assert(adminLoad === null, 'null-owner saved draft denied to ADMIN (scoped)');

  const shubhikaLoad = await loadSavedDraft(draftId, SHUBHIKA);
  assert(shubhikaLoad === null, 'null-owner saved draft denied to SHUBHIKA (scoped)');

  const adminDel = await deleteSavedDraft(draftId, ADMIN);
  await assertEq(adminDel, false, 'null-owner saved draft delete denied to ADMIN (scoped)');

  const shubhikaDel = await deleteSavedDraft(draftId, SHUBHIKA);
  await assertEq(shubhikaDel, false, 'null-owner saved draft delete denied to SHUBHIKA (scoped)');

  // Still in storage
  const stillThere = await mockDbGet<PDraft>('drafts', draftId);
  assert(stillThere !== null, 'null-owner saved draft preserved after scoped attempts');
  await assertEq(stillThere?.ownerId, null, 'null-owner saved draft ownerId unchanged');

  // Unscoped can access
  const unscopedLoad = await loadSavedDraft(draftId);
  assert(unscopedLoad !== null, 'null-owner saved draft accessible via unscoped load (diagnostics)');
}

async function testNullOwnerCompletedLeadDeniedToScopedCallers(): Promise<void> {
  resetStores();
  const leadId = 'lead-legacy-null';
  await putCompletedLead(makeCompletedLead(leadId, null));

  // Scoped update denied
  const adminUpdate = await updateCompletedLeadStatus(leadId, 'synced', {}, ADMIN);
  await assertEq(adminUpdate, false, 'null-owner completed lead update denied to ADMIN (scoped)');

  const shubhikaUpdate = await updateCompletedLeadStatus(leadId, 'synced', {}, SHUBHIKA);
  await assertEq(shubhikaUpdate, false, 'null-owner completed lead update denied to SHUBHIKA (scoped)');

  // Record unchanged
  const lead = await getCompletedLead(leadId);
  assert(lead !== null, 'null-owner completed lead preserved after scoped update attempts');
  await assertEq(lead?.status, 'local_only', 'null-owner completed lead status unchanged after scoped updates');
  await assertEq(lead?.ownerId, null, 'null-owner completed lead ownerId unchanged');

  // Scoped delete denied
  const adminDel = await deleteCompletedLead(leadId, ADMIN);
  await assertEq(adminDel, false, 'null-owner completed lead delete denied to ADMIN (scoped)');

  const shubhikaDel = await deleteCompletedLead(leadId, SHUBHIKA);
  await assertEq(shubhikaDel, false, 'null-owner completed lead delete denied to SHUBHIKA (scoped)');

  // Still in storage
  const stillThere = await getCompletedLead(leadId);
  assert(stillThere !== null, 'null-owner completed lead NOT deleted by scoped deletes');

  // Unscoped delete can remove it (recovery)
  const unscopedDel = await deleteCompletedLead(leadId);
  await assertEq(unscopedDel, true, 'null-owner completed lead deletable via unscoped delete (recovery)');
  const gone = await getCompletedLead(leadId);
  assert(gone === null, 'null-owner completed lead deleted by unscoped delete');
}

async function testNullOwnerQueueItemDeniedToScopedCallers(): Promise<void> {
  resetStores();
  const leadId = 'lead-legacy-queue';
  await putCompletedLead(makeCompletedLead(leadId, null));

  // Scoped deleteQueueItem denied
  const adminDel = await deleteQueueItem(leadId, ADMIN);
  await assertEq(adminDel, false, 'null-owner queue item delete denied to ADMIN (scoped)');

  const shubhikaDel = await deleteQueueItem(leadId, SHUBHIKA);
  await assertEq(shubhikaDel, false, 'null-owner queue item delete denied to SHUBHIKA (scoped)');

  // Still in storage
  const stillThere = await getCompletedLead(leadId);
  assert(stillThere !== null, 'null-owner queue item NOT deleted by scoped deleteQueueItem');
  await assertEq(stillThere?.ownerId, null, 'null-owner queue item ownerId unchanged');
}

async function testNullOwnerDeniedAllOperationsSummary(): Promise<void> {
  // Summary test: verifies the 5 required cases across all operations
  resetStores();

  // Case 1: ownerId=ADMIN, caller=ADMIN → allowed
  await mockDbPut('drafts', makeDraft(ADMIN));
  const case1 = await loadDraft(ADMIN);
  assert(case1 !== null, 'Case 1: ownerId=ADMIN, caller=ADMIN → allowed');
  await clearDraft(ADMIN); // cleanup

  // Case 2: ownerId=ADMIN, caller=SHUBHIKA → denied
  await mockDbPut('drafts', makeDraft(ADMIN));
  const case2 = await loadDraft(SHUBHIKA);
  assert(case2 === null, 'Case 2: ownerId=ADMIN, caller=SHUBHIKA → denied');
  await clearDraft(); // unscoped cleanup

  // Case 3: ownerId=null, caller=ADMIN → denied
  await mockDbPut('drafts', makeDraft(null));
  const case3 = await loadDraft(ADMIN);
  assert(case3 === null, 'Case 3: ownerId=null, caller=ADMIN → denied');
  await clearDraft(); // unscoped cleanup

  // Case 4: ownerId=null, caller=SHUBHIKA → denied
  await mockDbPut('drafts', makeDraft(null));
  const case4 = await loadDraft(SHUBHIKA);
  assert(case4 === null, 'Case 4: ownerId=null, caller=SHUBHIKA → denied');
  await clearDraft(); // unscoped cleanup

  // Case 5: ownerId=null, no ownerId supplied → unscoped behavior preserved
  await mockDbPut('drafts', makeDraft(null));
  const case5 = await loadDraft();
  assert(case5 !== null, 'Case 5: ownerId=null, no caller ownerId → unscoped access preserved');
  await assertEq(case5?.ownerId, null, 'Case 5: unscoped access does not modify ownerId');
  await clearDraft(); // unscoped cleanup
}

// ─── Tests: user-switching lifecycle ─────────────────────────────────────────

async function testUserSwitchingLifecycle(): Promise<void> {
  resetStores();

  const adminDraft = makeDraft(ADMIN, 'bsid-lifecycle');
  adminDraft.draftData = { clientName: 'Admin Lead', company: 'Admin Co', cardSessionId: 'bsid-lifecycle' };
  await mockDbPut('drafts', adminDraft);

  await mockDbPut('assets', { id: 'asset-001', sessionId: 'bsid-lifecycle', ownerId: null, dataUrl: 'data:image/jpeg;base64,AAA' });

  const shubhikaLoad = await loadDraft(SHUBHIKA);
  assert(shubhikaLoad === null, 'Lifecycle: SHUBHIKA cannot load ADMIN draft');

  const shubhikaClear = await clearDraft(SHUBHIKA);
  await assertEq(shubhikaClear, false, 'Lifecycle: SHUBHIKA cannot clear ADMIN draft');

  const draftCheck = await mockDbGet<PDraft>('drafts', DRAFT_KEY);
  assert(draftCheck !== null, 'Lifecycle: ADMIN draft preserved after SHUBHIKA session');
  await assertEq(draftCheck?.ownerId, ADMIN, 'Lifecycle: ADMIN draft ownerId unchanged');

  const assetCheck = await mockDbGet<DBRecord>('assets', 'asset-001');
  assert(assetCheck !== null, 'Lifecycle: ADMIN asset preserved after SHUBHIKA session');

  const shubhikaDraftId = await saveSavedDraft({ captureMethod: 'QR', sessionStatus: 'DRAFT', draftData: { clientName: 'Shubhika Lead' } }, SHUBHIKA);

  const shubhikaOwnLoad = await loadSavedDraft(shubhikaDraftId, SHUBHIKA);
  assert(shubhikaOwnLoad !== null, 'Lifecycle: SHUBHIKA can load own saved draft');

  const adminLoadShubhika = await loadSavedDraft(shubhikaDraftId, ADMIN);
  assert(adminLoadShubhika === null, 'Lifecycle: ADMIN cannot load SHUBHIKA saved draft');

  const adminRestore = await loadDraft(ADMIN);
  assert(adminRestore !== null, 'Lifecycle: ADMIN can restore own draft after user switch');
  await assertEq(adminRestore?.ownerId, ADMIN, 'Lifecycle: ADMIN draft ownerId still ADMIN');
  await assertEq(adminRestore?.draftData.clientName, 'Admin Lead', 'Lifecycle: ADMIN draft contents unchanged');
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Cross-user isolation (owned records)
  await testActiveDraftLoadIsolation();
  await testActiveDraftClearIsolation();
  await testSavedDraftLoadIsolation();
  await testSavedDraftDeleteIsolation();
  await testQueueItemDeleteIsolation();
  await testCompletedLeadUpdateIsolation();
  await testCompletedLeadDeleteIsolation();

  // Legacy null-owner records denied to scoped callers
  await testNullOwnerDraftDeniedToScopedCallers();
  await testNullOwnerSavedDraftDeniedToScopedCallers();
  await testNullOwnerCompletedLeadDeniedToScopedCallers();
  await testNullOwnerQueueItemDeniedToScopedCallers();
  await testNullOwnerDeniedAllOperationsSummary();

  // Lifecycle
  await testUserSwitchingLifecycle();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
