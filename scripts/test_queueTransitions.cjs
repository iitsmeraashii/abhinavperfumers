// Exercises the production repository, scheduler, recovery and diagnostics.
// Network/worker/local storage boundaries are controlled; no live data is used.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-transitions-'));
const job = { id: 'job', capture_session_id: 'session', user_id: 'owner', state: 'PROCESSING', retry_count: 0 };
let h;
function reset() {
  h = { writes: [], rpcCalls: 0, response: { error: null, count: 1 },
    rpcResponse: { data: 1, error: null }, processing: [], localWrites: 0, workerCalls: 0 };
  global.queueTransitionHarness = h;
}
const sdk = {
  rpc: async () => { h.rpcCalls++; return h.rpcResponse; },
  from(table) {
    assert.equal(table, 'processing_queue');
    let update, options;
    const filters = {};
    const chain = {
      update(value, opts) { update = value; options = opts; return chain; },
      select() { return chain; },
      eq(key, value) { filters[key] = value; return chain; },
      in(key, value) { filters[key] = value; return chain; },
      lt() { return chain; },
      order() { return chain; },
      maybeSingle() { return chain; },
      then(resolve, reject) {
        if (update) {
          h.writes.push({ update, options, filters });
          return Promise.resolve(update.state === 'PROCESSING'
            ? { data: job, error: null } : h.response).then(resolve, reject);
        }
        const data = filters.state === 'PROCESSING' ? h.processing
          : Array.isArray(filters.state) && filters.state.includes('QUEUED') ? [{ ...job, state: 'QUEUED' }] : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  },
};
global.queueTransitionSdk = sdk;
const mocks = {
  supabaseClient: 'export const supabase = globalThis.queueTransitionSdk;',
  runtimeDiagnostics: 'export const isConsoleEnabled = () => true;',
  assetSyncDiagnostics: ['logOperationStart', 'logOperationEnd', 'logEvent', 'getCorrelationId'].map(n => `export const ${n}=()=>null;`).join(''),
  connectivityStore: 'export const isTransportOnline=()=>true;',
  authModeState: 'export const isCloudSyncAllowed=()=>true;',
  worker: `export const processJob=async()=>{globalThis.queueTransitionHarness.workerCalls++;return {outcome:'completed',leadId:'lead',error:null,failedStage:null,result:null};};`,
  completedLeadsStorage: `export const loadCompletedLeads=async()=>[];
    export const cleanupOldSyncedCompletedLeads=async()=>0;
    export const updateCompletedLeadStatus=async()=>{globalThis.queueTransitionHarness.localWrites++;return true;};`,
};

(async () => {
  const outfile = path.join(temp, 'actual.cjs');
  await esbuild.build({ stdin: { contents: `export * from './src/alpe/processingQueueRepository';
    export * from './src/alpe/diagnostics'; export {scheduler} from './src/alpe/scheduler';
    export {runRecovery} from './src/alpe/recoveryService';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{ name: 'controlled-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, a => mocks[path.basename(a.path)] ? { path: path.basename(a.path), namespace: 'mock' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path] }));
    } }] });
  const api = require(outfile);
  let passed = 0;
  async function test(name, fn) { reset(); await fn(); passed++; console.log('PASS:', name); }
  const transitions = [
    ['updateJobState', () => api.updateJobState('job', 'COMPLETED'), 'COMPLETED'],
    ['markRecovering', () => api.markRecovering('job'), 'RECOVERING'],
    ['requeueJob', () => api.requeueJob('job'), 'QUEUED'],
  ];
  for (const [name, call, state] of transitions) {
    await test(`${name}: successful exact-count update retains void contract`, async () => {
      assert.equal(await call(), undefined);
      assert.equal(h.writes.length, 1);
      assert.equal(h.writes[0].update.state, state);
      assert.deepEqual(h.writes[0].options, { count: 'exact' });
      assert.deepEqual(h.writes[0].filters, { id: 'job' });
      if (state === 'COMPLETED') assert(h.writes[0].update.processing_completed_at);
      if (state === 'QUEUED') assert.equal(h.writes[0].update.processing_started_at, null);
    });
    await test(`${name}: database error rejects without exposing response details`, async () => {
      h.response = { error: { message: 'PRIVATE_RESPONSE', details: 'PRIVATE_DETAILS' }, count: 1 };
      await assert.rejects(call(), error => /database write failed/.test(error.message) && !/PRIVATE/.test(error.message));
    });
    for (const count of [0, null]) await test(`${name}: count=${count} is unconfirmed`, async () => {
      h.response.count = count;
      await assert.rejects(call(), /no transition confirmed/);
    });
  }
  await test('retry success preserves RPC then update order and payload', async () => {
    assert.equal(await api.markRetrying('job', 'reason'), undefined);
    assert.equal(h.rpcCalls, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].update.state, 'RETRYING');
    assert.equal(h.writes[0].update.failure_reason, 'reason');
  });
  await test('retry RPC error rejects without blind fallback', async () => {
    h.rpcResponse = { data: null, error: { message: 'RPC failed' } };
    await assert.rejects(api.markRetrying('job', 'reason'), /database write failed/);
    assert.equal(h.writes.length, 0);
  });
  await test('retry RPC conditional no-op rejects without bypassing predicates', async () => {
    h.rpcResponse.data = null;
    await assert.rejects(api.markRetrying('job', 'reason'), /no transition confirmed/);
    assert.equal(h.writes.length, 0);
  });
  for (const response of [{ error: { message: 'failed' }, count: null }, { error: null, count: 0 }]) {
    await test('retry follow-up update must also be confirmed', async () => {
      h.response = response;
      await assert.rejects(api.markRetrying('job', 'reason'), /processing_queue/);
      assert.equal(h.rpcCalls, 1);
    });
  }
  await test('recovery failure is reported, not counted as requeued', async () => {
    h.processing = [job]; h.response.error = { message: 'failed' };
    const report = await api.runRecovery('owner');
    assert.equal(report.interruptedRequeued, 0);
    assert.equal(report.totalRecovered, 0);
    assert.equal(report.errors.length, 1);
    assert.deepEqual(h.writes.map(w => w.update.state), ['RECOVERING']);
  });
  await test('successful recovery keeps transition order and counts', async () => {
    h.processing = [job];
    const report = await api.runRecovery('owner');
    assert.equal(report.interruptedRequeued, 1);
    assert.deepEqual(h.writes.map(w => w.update.state), ['RECOVERING', 'QUEUED']);
  });
  await test('throwing diagnostic listener does not block others or reset', async () => {
    let notified = 0;
    const offBad = api.subscribeAlpeRuntime(() => { throw Error('listener'); });
    const offGood = api.subscribeAlpeRuntime(() => notified++);
    try {
      api.updateAlpeRuntime({ workerState: 'running' });
      assert.equal(api.getAlpeRuntimeState().workerState, 'running');
      api.resetAlpeRuntime();
      assert.equal(notified, 2);
      assert.equal(api.getAlpeRuntimeState().workerState, null);
    } finally { offBad(); offGood(); }
  });
  for (const fail of [false, true]) await test(`actual scheduler completion ${fail ? 'failure' : 'success'} and listener isolation`, async () => {
    const logs = [];
    const originalLog = console.log, originalError = console.error;
    const off = api.subscribeAlpeRuntime(() => { throw Error('listener'); });
    const scheduler = api.scheduler;
    // TypeScript-private fields are accessible in the test bundle. Calling the
    // real tick directly avoids timers and does not substitute scheduler logic.
    scheduler.status = 'running'; scheduler.userId = 'owner';
    const before = scheduler.getState().jobsProcessed;
    if (fail) h.response.error = { message: 'completion denied' };
    try {
      console.log = (...args) => logs.push(args);
      console.error = (...args) => logs.push(args);
      await scheduler.tick();
      assert.equal(h.workerCalls, 1);
      assert.equal(scheduler.inFlightTick, false);
      assert.equal(scheduler.getState().jobsProcessed, before + (fail ? 0 : 1));
      assert.equal(logs.some(args => args[1] === 'PROCESSING_COMPLETED'), !fail);
      assert.equal(h.localWrites, fail ? 0 : 1);
      if (fail) assert.match(scheduler.getState().lastError, /database write failed/);
    } finally {
      console.log = originalLog; console.error = originalError; off();
      await scheduler.stop();
    }
  });
  console.log(`PASS: ${passed} queue transition checks`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
