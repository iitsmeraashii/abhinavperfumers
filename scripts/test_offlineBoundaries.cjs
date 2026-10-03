// Production persistence/cloud-boundary regression checks. Node 24, no network.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-boundaries-'));
const mocks = {
 supabaseClient: 'export const supabase = globalThis.boundarySupabase;',
 assetSyncDiagnostics: ['logOperationStart','logOperationEnd','logEvent','getCorrelationId'].map(n=>`export const ${n}=()=>null;`).join(''),
 runtimeDiagnostics: 'export const isConsoleEnabled=()=>false;',
 diagnostics: ['alpeLog','updateAlpeRuntime','alpeError'].map(n=>`export const ${n}=()=>{};`).join(''),
};
(async()=>{
 const h={authCalls:0,uploads:0,writes:0,user:'u',flip:false,storageError:null,insertError:null,existing:null,filters:[]};
 global.boundarySupabase={auth:{getUser:async()=>{h.authCalls++;return {data:{user:{id:h.user}}}}},storage:{from:()=>({upload:async()=>{h.uploads++;if(h.flip)api.setAuthModeState('offline-restored');return {data:{path:'u/a.jpg'},error:h.storageError}}})},from(table){let inserted=false;const chain={upsert(){h.writes++;return chain},insert(){inserted=true;return chain},select(){return chain},eq(k,v){h.filters.push([k,v]);return chain},maybeSingle:async()=>table==='processing_queue'?{data:inserted?(h.insertError?null:{id:'s'}):h.existing,error:inserted?h.insertError:null}:{data:{id:'meta',storage_path:'u/a.jpg'},error:null},then(resolve){return Promise.resolve({data:[{id:'meta'}],error:null}).then(resolve)}};return chain}};
 await esbuild.build({stdin:{contents:`export * from './src/capture/db'; export {saveQueuedCapture} from './src/capture/completedLeadsStorage'; export {uploadBusinessCardAsset,reconcileAssetStorageMetadata} from './src/capture/assetStorageUpload'; export * from './src/authModeState'; export {enqueueJob} from './src/alpe/processingQueueRepository';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'actual.cjs'),logLevel:'silent',plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>mocks[path.basename(a.path)]?{path:path.basename(a.path),namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
 const api=require(path.join(temp,'actual.cjs'));
 global.indexedDB={open(){const request={error:Error('Database unavailable')};queueMicrotask(()=>request.onerror());return request}};
 await assert.rejects(api.dbPutStrict('assets',{id:'a'}),/Database unavailable/);
 await assert.rejects(api.saveQueuedCapture({id:'s'},{id:'processing_u_s'}),/Database unavailable/);
 let transaction,stores,writes=[];
 global.indexedDB={open(){const request={result:{transaction(names){stores=names;transaction={objectStore:store=>({put(row){writes.push([store,row]);return {}}})};return transaction}}};queueMicrotask(()=>request.onsuccess());return request}};
 let committed=false;const pending=api.dbPutStrict('assets',{id:'a'}).then(()=>{committed=true});await new Promise(r=>setImmediate(r));assert.equal(committed,false);transaction.oncomplete();await pending;assert(committed);
 writes=[];const atomic=api.saveQueuedCapture({id:'s'},{id:'processing_u_s'});await new Promise(r=>setImmediate(r));assert.deepEqual(stores,['completed_leads','pending_ops']);assert.equal(writes.length,2);transaction.error=Error('Transaction aborted');transaction.onabort();await assert.rejects(atomic,/Transaction aborted/);
 Object.defineProperty(navigator,'onLine',{value:true,writable:true,configurable:true});
 const card={id:'a',sessionId:'s',ownerId:'u',dataUrl:'data:image/jpeg;base64,YQ==',side:'front',mimeType:'image/jpeg'};
 api.setAuthModeState('offline-restored');assert.equal((await api.uploadBusinessCardAsset(card)).uploaded,false);assert.equal(h.authCalls,0);assert.equal(await api.reconcileAssetStorageMetadata(card),false);assert.equal(h.writes,0);
 api.setAuthModeState('online');navigator.onLine=false;await api.uploadBusinessCardAsset(card);assert.equal(h.authCalls,0);navigator.onLine=true;
 h.user='other';await api.uploadBusinessCardAsset(card);assert.equal(h.uploads,0);h.user='u';
 h.flip=true;const partial=await api.uploadBusinessCardAsset(card);assert.equal(partial.uploaded,true);assert.equal(partial.metadataWritten,false);assert.equal(h.writes,0,'auth changed during upload: no metadata write');
 h.flip=false;api.setAuthModeState('online');const ok=await api.uploadBusinessCardAsset(card);assert.equal(ok.uploaded,true);assert.equal(ok.metadataWritten,true);assert.equal(h.writes,1);
 const cancelled=await api.uploadBusinessCardAsset(card,null,()=>true);assert.equal(cancelled.uploaded,false);
 h.storageError={message:'Network failure'};assert.equal((await api.uploadBusinessCardAsset(card)).uploaded,false);
 h.insertError={code:'23505',message:'duplicate'};h.existing={id:'s'};
 const input={jobId:'s',captureSessionId:'s',userId:'u'};assert.equal((await api.enqueueJob(input)).success,true);assert(h.filters.some(([k,v])=>k==='user_id'&&v==='u'));
 h.existing=null;assert.equal((await api.enqueueJob(input)).success,false,'unverified collision must not count as success');
 h.insertError=null;assert.equal((await api.enqueueJob(input)).success,true);
 console.log('PASS: actual IndexedDB open/commit/abort, atomic capture transaction, cloud gates, owner check, mid-upload auth change, cancellation, online upload, duplicate processing insert');
})().catch(e=>{console.error(e);process.exitCode=1});
