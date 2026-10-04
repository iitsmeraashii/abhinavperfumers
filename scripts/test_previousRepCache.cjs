// Production hook/storage with controlled React, Supabase and IndexedDB boundaries.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-reps-'));
const tick = () => new Promise(r => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const rep = { rep_code: 'REP-007', name: 'Example Rep' };
function host() {
  return {
    slots: [], i: 0, todo: [],
    state(x) { const i = this.i++; if (!(i in this.slots)) this.slots[i] = x; return [this.slots[i], v => this.slots[i] = typeof v === 'function' ? v(this.slots[i]) : v]; },
    ref(x) { const i = this.i++; return this.slots[i] ?? (this.slots[i] = { current: x }); },
    memo(f, d) { const i = this.i++, old = this.slots[i]; if (!old || d.some((x, j) => x !== old.d[j])) this.slots[i] = { d, value: f }; return this.slots[i].value; },
    effect(f, d) { const i = this.i++, old = this.slots[i]; if (!old || !old.d || d.some((x, j) => x !== old.d[j])) this.todo.push(() => { old?.cleanup?.(); this.slots[i] = { d, cleanup: f() }; }); },
    run(f) { global.host = this; this.i = 0; global.value = f(); this.todo.splice(0).forEach(f => f()); },
    stop() { this.slots.forEach(x => { if (x?.cleanup) { x.cleanup(); x.d = null; } }); },
  };
}
const mocks = {
  react: `export const useState=x=>global.host.state(x);export const useRef=x=>global.host.ref(x);export const useCallback=(f,d)=>global.host.memo(f,d);export const useEffect=(f,d)=>global.host.effect(f,d);`,
  AuthContext: `export const useAuth=()=>global.h.auth;`,
  authModeState: `export const isCloudSyncAllowed=()=>global.h.auth.authMode==='online';`,
  connectivityStore: `export const isTransportOnline=()=>global.h.online;`,
  supabaseClient: `export const supabase={from(table){global.h.tables.push(table);return {select(fields){global.h.fields=fields;return this;},eq(k,v){global.h.filter=[k,v];return this;},order(k){global.h.order=k;global.h.calls++;return global.h.hold||Promise.resolve({data:global.h.list,error:global.h.error});}};}};`,
  db: `export const dbGet=async(s,k)=>{if(global.h.readError)throw Error('disk');if(global.h.readHold){const p=global.h.readHold;global.h.readHold=null;return p;}return global.h.db.get(k)||null;};export const dbPutStrict=async(s,row)=>{if(global.h.writeError)throw Error('disk');global.h.db.set(row.ownerId,structuredClone(row));};`,
};
(async () => {
  const out = path.join(temp, 'actual.cjs');
  await esbuild.build({ stdin: { contents: "export * from './src/capture/usePreviousReps';export * from './src/capture/previousRepCacheStorage';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [{ name: 'boundaries', setup(b) { b.onResolve({ filter: /.*/ }, a => { const k = path.basename(a.path); if (mocks[k]) return { path: k, namespace: 'mock' }; }); b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path] })); } }] });
  function setup(mode = 'online', db = new Map()) {
    global.h = { auth: { user: { authUserId: 'A' }, authMode: mode }, online: mode === 'online', db, list: [rep], calls: 0, tables: [] };
    delete require.cache[require.resolve(out)]; const api = require(out), hooks = host();
    const render = () => hooks.run(api.usePreviousReps);
    const settle = async () => { for (let i = 0; i < 5; i++) { render(); await tick(); } };
    return { h: global.h, api, hooks, render, settle };
  }
  let passed = 0;
  async function test(name, fn) { const f = setup(); try { await fn(f); console.log('PASS:', name); passed++; } finally { f.hooks.stop(); } }
  await test('prefetch without dropdown, active query, exact cache round trip', async f => { await f.settle(); assert.equal(f.h.calls, 1); assert.deepEqual(global.value.reps, [rep]); assert.deepEqual(await f.api.loadPreviousRepCache('A'), [rep]); assert.deepEqual(f.h.filter, ['is_active', true]); assert.equal(f.h.fields, 'rep_code, name'); assert.equal(f.h.order, 'name'); });
  await test('cold offline restart restores owner list without server calls', async f => { await f.settle(); f.hooks.stop(); const cold = setup('offline-restored', f.h.db); await cold.settle(); assert.deepEqual(global.value.reps, [rep]); assert.equal(cold.h.calls, 0); cold.hooks.stop(); });
  await test('authoritative empty replaces state and cache', async f => { await f.settle(); f.h.list = []; await global.value.refresh(); f.render(); assert.deepEqual(global.value.reps, []); assert.deepEqual(await f.api.loadPreviousRepCache('A'), []); });
  await test('failed refresh preserves cache and remains retryable', async f => { await f.settle(); f.h.error = Error('network'); await global.value.refresh(); assert.deepEqual(await f.api.loadPreviousRepCache('A'), [rep]); f.h.error = null; f.h.list = []; await global.value.refresh(); f.render(); assert.deepEqual(global.value.reps, []); assert.equal(f.h.calls, 3); });
  await test('first-load failure retries on next dropdown open', async f => { f.h.error = Error('network'); await f.settle(); assert.deepEqual(global.value.reps, []); f.h.error = null; await global.value.refresh(); f.render(); assert.deepEqual(global.value.reps, [rep]); });
  await test('owner switch never exposes A list to B', async f => { await f.settle(); f.h.auth.user = { authUserId: 'B' }; f.h.auth.authMode = 'offline-restored'; f.h.online = false; f.render(); assert.deepEqual(global.value.reps, []); await f.settle(); assert.deepEqual(global.value.reps, []); });
  for (const change of ['logout', 'switch', 'unmount', 'offline']) await test(`late fetch ignored after ${change}`, async f => { const hold = defer(); f.h.hold = hold.promise; await f.settle(); if (change === 'unmount') f.hooks.stop(); else { f.h.auth.user = change === 'logout' ? null : { authUserId: change === 'switch' ? 'B' : 'A' }; f.h.auth.authMode = change === 'logout' ? 'unauthenticated' : 'offline-restored'; f.h.online = false; f.render(); } hold.resolve({ data: [rep], error: null }); await tick(); await tick(); if (change !== 'unmount') { f.render(); assert.deepEqual(global.value.reps, []); } assert.equal(await f.api.loadPreviousRepCache('A'), null); });
  await test('malformed cache ignored without deleting unrelated owners', async f => { f.h.db.set('A', { ownerId: 'A', schemaVersion: 1, reps: [{ rep_code: 123 }] }); f.h.db.set('B', { keep: true }); assert.equal(await f.api.loadPreviousRepCache('A'), null); assert.deepEqual(f.h.db.get('B'), { keep: true }); });
  await test('search preserves exact code and historical label never substitutes', async f => { assert.deepEqual(f.api.filterPreviousReps([rep], 'example'), [rep]); assert.deepEqual(f.api.filterPreviousReps([rep], 'rep-007'), [rep]); assert.equal(f.api.previousRepLabel([], rep.rep_code), 'REP-007 (stored selection — unavailable in active list)'); assert.equal(f.api.previousRepSnapshot([rep])[0].rep_code, 'REP-007'); });
  await test('authenticated reconnect refreshes, transport alone does not', async f => { await f.settle(); f.h.auth.authMode = 'offline-restored'; f.h.online = false; await f.settle(); f.h.online = true; await global.value.refresh(); assert.equal(f.h.calls, 1); f.h.auth.authMode = 'online'; f.h.list = []; await f.settle(); assert.equal(f.h.calls, 2); assert.deepEqual(global.value.reps, []); });
  await test('concurrent refresh deduplicates', async f => { await f.settle(); const hold = defer(); f.h.hold = hold.promise; const a = global.value.refresh(), b = global.value.refresh(); assert.equal(a, b); hold.resolve({ data: [], error: null }); await a; assert.equal(f.h.calls, 2); });
  await test('late cache restore cannot overwrite successful empty fetch', async f => { const hold = defer(); f.h.readHold = hold.promise; f.render(); f.h.list = []; await global.value.refresh(); hold.resolve({ ownerId: 'A', schemaVersion: 1, reps: [rep] }); await f.settle(); assert.deepEqual(global.value.reps, []); });
  await test('disk failure allows online state and retry', async f => { f.h.readError = true; f.h.writeError = true; await f.settle(); assert.deepEqual(global.value.reps, [rep]); f.h.readError = false; f.h.writeError = false; await global.value.refresh(); assert.deepEqual(await f.api.loadPreviousRepCache('A'), [rep]); });
  await test('StrictMode cleanup/remount invalidates old request', async f => { const hold = defer(); f.h.hold = hold.promise; await f.settle(); f.hooks.stop(); f.h.hold = null; f.h.list = []; await f.settle(); hold.resolve({ data: [rep], error: null }); await f.settle(); assert.deepEqual(global.value.reps, []); });
  const hook = fs.readFileSync('src/capture/usePreviousReps.ts', 'utf8');
  assert(!/addEventListener|Capacitor|setInterval/.test(hook));
  const capture = fs.readFileSync('src/CaptureLeadPage.tsx', 'utf8');
  assert(capture.includes('const previousReps = usePreviousReps();'));
  assert(capture.includes('previousReps={previousReps}'));
  const form = fs.readFileSync('src/capture/ManualEntryForm.tsx', 'utf8');
  assert(form.includes("onChange={code => handleChange('previousRepCode', code)}"));
  assert(form.includes('onChange(r.rep_code)'));
  assert(form.includes('void refresh();'));
  passed++; console.log('PASS: production Capture wiring, exact selection and no independent connectivity listeners');
  const dbOut = path.join(temp, 'db.cjs');
  await esbuild.build({ entryPoints: ['src/capture/db.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dbOut });
  const stores = new Set(['drafts', 'assets', 'pending_ops', 'lead_queue', 'completed_leads', 'auth_profile', 'event_cache']);
  const created = []; let request;
  const database = { objectStoreNames: { contains: n => stores.has(n) }, createObjectStore(n, options) { created.push([n, options]); stores.add(n); return { createIndex() {} }; }, close() {} };
  global.indexedDB = { open(name, version) { assert.equal(name, 'capture_app'); assert.equal(version, 12); request = { result: database, transaction: { objectStore: () => ({ indexNames: { contains: () => true } }) } }; return request; } };
  const opened = require(dbOut).openDB(); request.onupgradeneeded({ oldVersion: 10, target: request }); request.onsuccess(); await opened;
  assert.deepEqual(created, [['capture_config_cache', { keyPath: 'key' }], ['previous_rep_cache', { keyPath: 'ownerId' }]]); assert.equal(stores.size, 9);
  passed++; console.log('PASS: v10 to v12 migration adds only B2/B3 cache stores');
  // Exercise the real backend/promotion payload builders with an isolated SDK.
  const flowOut = path.join(temp, 'flow.cjs');
  const flowMocks = {
    supabaseClient: `export const supabase={from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null,error:null}),upsert(row){global.flow.session=row;return q;},insert(row){global.flow.lead=row;return q;},update(){return q;},then(resolve){return Promise.resolve({error:null}).then(resolve);}};return q;},rpc:async()=>({error:null})};`,
    captureAuth: `export const getAuthIdentity=async()=>({userId:'A',repCode:'CURRENT'});`,
    completedLeadsStorage: `export const buildCompletedLead=()=>({});export const saveCompletedLead=async()=>{};`,
    assetSyncDiagnostics: `export const logOperationStart=()=>({});export const logOperationEnd=()=>{};export const logEvent=()=>{};export const getCorrelationId=()=>null;`,
  };
  await esbuild.build({ stdin: { contents: "export {syncUpsertSession} from './src/capture/captureBackendSync';export {executePromotion} from './src/capture/capturePromotionService';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: flowOut, define: { 'import.meta.env': 'undefined' }, plugins: [{ name: 'flow-boundaries', setup(b) { b.onResolve({filter:/.*/},a=>{const k=path.basename(a.path);if(flowMocks[k])return {path:k,namespace:'flow'};});b.onLoad({filter:/.*/,namespace:'flow'},a=>({contents:flowMocks[a.path]})); } }] });
  const flowApi = require(flowOut); global.flow = {};
  const draftData = { clientName: 'B2 Test', previousRepCode: rep.rep_code };
  let synced = false;
  await flowApi.syncUpsertSession({sessionId:'session',captureMethod:'MANUAL',sessionStatus:'CAPTURING',draftData,eventId:'event'}, {onSyncing(){},onSynced(){synced=true;},onSyncError(e){throw Error(e);}});
  assert(synced); assert.equal(global.flow.session.previous_rep_code, rep.rep_code);
  const result = await flowApi.executePromotion({backendSessionId:'session',draftData,eventCode:null,eventId:'event',eventName:null,completedLeadId:'session',captureMethod:'MANUAL'});
  assert.equal(result.error,null);assert.equal(global.flow.lead.previous_associated_rep,rep.rep_code);
  passed++; console.log('PASS: production backend sync and promotion preserve exact previous rep code');
  console.log(`${passed} B2 checks passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
