// Executes production modules with controlled persistence and network boundaries.
// Run with Node 24: node scripts/test_offlineCapture.cjs
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-tests-'));
const mocks = {
  captureAssetStorage: `export const getAsset=async(id,owner)=>{const a=globalThis.h.assets.get(id);return a?.ownerId===owner?a:null;};`,
  completedLeadsStorage: `export const buildCompletedLead=(id,captureMethod,draftData,backendSessionId,eventId,eventName,ownerId)=>({id,captureMethod,draftData,backendSessionId,eventId,eventName,ownerId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); export const saveQueuedCapture=async(lead,op)=>{if(globalThis.h.failWrite)throw Error('Disk failure');globalThis.h.rows.set(op.id,structuredClone(op));globalThis.h.leads.set(lead.id,structuredClone(lead));}; export const loadCompletedLeads=async(owner)=>[...globalThis.h.leads.values()].filter(l=>l.ownerId===owner); export const deleteCompletedLead=async()=>{}; export const getCompletedLead=async()=>null;`,
  captureDraftStorage: `export const loadAllSavedDrafts=async()=>[]; export const deleteSavedDraft=async()=>{};`,
  captureEventHandlers: ['registerCardEvidence','registerVoiceNoteEvidence','notifySessionReset','handleVisionExtraction','handleOcrExtraction','handleQrExtraction'].map(n=>`export const ${n}=()=>{};`).join(''),
  db: `export const dbGet=async()=>null; export const dbPutStrict = async (store, row) => { if(globalThis.h.failWrite) throw Error('Disk failure'); globalThis.h.rows.set(row.id, structuredClone(row)); }; export const dbPut = dbPutStrict; export const dbDelete = async (s,id)=>globalThis.h.rows.delete(id); export const dbGetAllInStore = async ()=>[...globalThis.h.rows.values()]; export const dbGetAllInStoreStrict=dbGetAllInStore; export const dbDeleteStrict=dbDelete;`,
  captureBackendSync: ['syncUpsertSession','syncUpsertAsset','syncUpsertOcrExtraction','syncUpsertQrExtraction','syncUpdateSessionFields','syncUpsertVisionExtraction','syncPromoteSession'].map(n=>`export const ${n} = async ()=>{};`).join(''),
  voiceEvidenceManager: `export const executeVoiceNoteUploadOp=async()=>{}; export const voiceEvidenceManager={register(){},onSessionReset(){},onSaveAndNext(){}};`,
  assetStorageUpload: `export const uploadBusinessCardAsset=async(asset)=>{globalThis.h.uploads.push(asset); if(globalThis.h.throwUpload)throw Error('Network failed'); return globalThis.h.uploadResult;}; export const reconcileAssetStorageMetadata=async()=>true; export const uploadNotesImage=async()=>{};`,
  jobProducer: `export const produceProcessingJob=async(params)=>{globalThis.h.lastJob=params;globalThis.h.jobs++; return globalThis.h.jobResult;};`,
};
(async()=>{
 await esbuild.build({stdin:{contents:`export {connectivityStore} from './src/connectivity/connectivityStore'; export * from './src/capture/captureOfflineQueue'; export * from './src/authModeState'; export {loadQueueItems} from './src/capture/leadQueueStorage'; export * from './src/capture/captureProfile'; export {parseQrPayload} from './src/capture/parseQrPayload'; export * from './src/capture/captureProcessingAdapter'; export {evidenceManager} from './src/capture/captureEvidenceManager';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'actual.cjs'),logLevel:'silent',plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},args=>{const name=path.basename(args.path);if(mocks[name])return {path:name,namespace:'mock'};});b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
 globalThis.h={rows:new Map(),leads:new Map(),assets:new Map(),uploads:[],jobs:0,uploadResult:{uploaded:false,metadataWritten:false},jobResult:{outcome:'failed',jobId:null,error:'Evidence not ready'}};
 global.window = new EventTarget();
 let transportOnline=true;
 Object.defineProperty(navigator,'onLine',{get:()=>transportOnline,set:value=>{transportOnline=value;window.dispatchEvent(new Event(value?'online':'offline'));},configurable:true});
 const q=require(path.join(temp,'actual.cjs'));q.connectivityStore.subscribe(()=>{});q.setAuthModeState('online');
 const card={assetId:'card',sessionId:'s',ownerId:'u',dataUrl:'data:image/jpeg;base64,YQ==',side:'front',mimeType:'image/jpeg'};
 await q.enqueueOp('upload_business_card','s',card,'u');await q.flushQueue('u');assert.equal(h.rows.size,1);assert.equal([...h.rows.values()][0].retries,1);
 h.uploadResult={uploaded:true,metadataWritten:false};await q.flushQueue('u');assert.equal(h.rows.size,1,'metadata failure must retain retry');
 h.uploadResult={uploaded:true,metadataWritten:true};await q.flushQueue('u');assert.equal(h.rows.size,0);
 await q.enqueueOp('enqueue_processing_job','s',{backendSessionId:'s'},'u');await q.flushQueue('u');assert.equal(h.rows.size,1,'failed result must retain processing');
 h.jobResult={outcome:'queued',jobId:null,error:null};await q.flushQueue('u');assert.equal(h.rows.size,1,'deferred without job must remain');
 h.jobResult={outcome:'queued',jobId:'job',error:null};await q.flushQueue('u');assert.equal(h.rows.size,0);
 q.setAuthModeState('offline-restored');await q.enqueueOp('upload_business_card','s',card,'u');const calls=h.uploads.length;await q.flushQueue('u');assert.equal(h.uploads.length,calls);assert.equal(h.rows.size,1);
 h.failWrite=true;await assert.rejects(q.enqueueOp('upload_business_card','s',card,'u'),/Disk failure/);h.failWrite=false;
 h.rows.clear();h.uploads=[];q.setAuthModeState('online');
 const asset={...card,id:'handoff',sizeBytes:1,originalWidth:1,originalHeight:1,storedWidth:1,storedHeight:1};
 q.evidenceManager.register({type:'business_card_front',sessionId:'s',asset,uploadTiming:'ON_SAVE'});
 await q.evidenceManager.prepareForSubmission('s');assert.equal(h.uploads.length,1);assert.equal(h.rows.size,0,'normal online upload stays direct');
 for(const browserOnline of [true,false]){
  h.rows.clear();h.uploads=[];navigator.onLine=browserOnline;q.setAuthModeState('offline-restored');
  q.evidenceManager.register({type:'business_card_front',sessionId:'off',asset:{...asset,id:'off',sessionId:'off'},uploadTiming:'ON_SAVE'});
  await q.evidenceManager.prepareForSubmission('off');assert.equal(h.uploads.length,0);assert.equal(h.rows.size,1);assert.equal([...h.rows.values()][0].payload.dataUrl,card.dataUrl);q.evidenceManager.onSessionReset('u');
 }
 h.rows.clear();q.evidenceManager.register({type:'business_card_front',sessionId:'immediate',asset:{...asset,id:'immediate',sessionId:'immediate'},uploadTiming:'IMMEDIATE'});
 await q.evidenceManager.waitForUploads('immediate');assert.equal(h.rows.size,1);assert.equal(h.uploads.length,0);
 navigator.onLine=true;q.setAuthModeState('online');
 h.rows.clear();h.uploads=[];h.uploadResult={uploaded:false,metadataWritten:false};
 q.evidenceManager.register({type:'business_card_front',sessionId:'failure',asset:{...asset,id:'failure',sessionId:'failure'},uploadTiming:'ON_SAVE'});
 h.jobResult={outcome:'failed',jobId:null,error:'Evidence upload did not complete; processing was not queued'};
 const params={session:{draftData:{cardFrontAssetId:'failure'},captureMethod:'BUSINESS_CARD'},backendSessionId:'failure',ownerId:'u',isOnline:true};
 assert.equal((await q.submitCaptureSession(params)).outcome,'queued');assert.deepEqual([...h.rows.values()].map(o=>o.type),['upload_business_card','enqueue_processing_job']);
 h.rows.clear();h.jobResult={outcome:'failed',jobId:null,error:'Permanent unrelated failure'};
 assert.equal((await q.submitCaptureSession({...params,backendSessionId:'unrelated'})).outcome,'failed');assert.equal(h.rows.size,0);
 h.uploadResult={uploaded:true,metadataWritten:true};h.jobResult={outcome:'queued',jobId:'job',error:null};
 assert.equal((await q.submitCaptureSession({...params,backendSessionId:'online'})).outcome,'submitted');assert.equal(h.rows.size,0);
 h.rows.clear();h.jobs=0;h.uploadResult={uploaded:false,metadataWritten:false};
 await q.enqueueOp('enqueue_processing_job','ordered',{backendSessionId:'ordered'},'u');
 await q.enqueueOp('upload_business_card','ordered',{...card,sessionId:'ordered'},'u');
 await q.flushQueue('u');assert.equal(h.jobs,0,'processing must wait for evidence even if created first');assert.equal(h.rows.size,2);
 h.uploadResult={uploaded:true,metadataWritten:true};await q.flushQueue('u');assert.equal(h.jobs,1);assert.equal(h.rows.size,0);
 h.rows.clear();h.uploads=[];q.evidenceManager.onSessionReset('u');q.setAuthModeState('offline-restored');
 const repeated={...asset,id:'repeated',sessionId:'repeat'};
 for(let i=0;i<3;i++)q.evidenceManager.register({type:'business_card_front',sessionId:'repeat',asset:repeated,uploadTiming:'ON_SAVE'});
 await q.evidenceManager.prepareForSubmission('repeat');assert.equal(h.rows.size,1,'duplicate callbacks create one intent');
 await q.evidenceManager.abandonAsset('repeated');assert.equal(h.rows.size,0,'discard cancels queued image');
 q.setAuthModeState('online');h.uploadResult={uploaded:true,metadataWritten:false,storagePath:'u/partial.jpg'};
 await q.enqueueOp('upload_business_card','partial',{...card,assetId:'partial',sessionId:'partial'},'u');
 await q.flushQueue('u');assert.equal(h.rows.size,1);const uploaded=h.uploads.length;
 await q.flushQueue('u');assert.equal(h.rows.size,0);assert.equal(h.uploads.length,uploaded,'metadata-only retry must not reupload');
 assert.equal(q.effectiveCaptureProfile('CRM',false),'EXHIBITION');assert.equal(q.effectiveCaptureProfile('CRM',true),'CRM');
 h.rows.clear();h.jobs=0;q.setAuthModeState('offline-restored');
 const manual={session:{draftData:{clientName:'Offline Example',phone:'1234567890',captureEventId:'event',previousRepCode:'REP-007'},captureMethod:'MANUAL'},backendSessionId:'manual',ownerId:'u',eventId:'event',isOnline:true};
 assert.equal((await q.submitCaptureSession(manual)).outcome,'queued');assert.equal(h.jobs,0);
 assert.deepEqual([...h.rows.values()][0].payload.draftData,manual.session.draftData);
 assert.equal([...h.rows.values()][0].payload.eventId,'event');
 // B1.13/23 replay uses the durable association, without consulting today's active list.
 q.setAuthModeState('online');await q.flushQueue('u');assert.equal(h.lastJob.eventId,'event');assert.equal(h.lastJob.draftData.captureEventId,'event');assert.equal(h.lastJob.draftData.previousRepCode,'REP-007');assert.equal(h.rows.size,0);q.setAuthModeState('offline-restored');
 h.rows.clear();h.jobs=0;
 const raw='BEGIN:VCARD\nVERSION:3.0\nFN:Offline QR Example\nORG:Example Co\nTEL:+919999999999\nEND:VCARD';
 const decoded=q.parseQrPayload(raw);assert.equal(decoded.fields.clientName,'Offline QR Example');
 const qrDraft={...decoded.fields,rawQr:raw};
 assert.equal((await q.submitCaptureSession({...manual,backendSessionId:'qr',session:{draftData:qrDraft,captureMethod:'MANUAL',originalCaptureMethod:'QR'}})).outcome,'queued');
 assert.equal(h.jobs,0);const qrOp=[...h.rows.values()][0];assert.equal(qrOp.payload.captureMethod,'QR');assert.equal(qrOp.payload.draftData.rawQr,raw);
 const visible=await q.loadQueueItems('u');assert(visible.some(l=>l.id==='manual'&&l.status==='pending_sync'));assert(visible.some(l=>l.id==='qr'&&l.status==='pending_sync'));assert.equal((await q.loadQueueItems('other')).length,0);
 h.failWrite=true;await assert.rejects(q.submitCaptureSession({...manual,backendSessionId:'disk-failure'}),/Disk failure/);assert(!h.leads.has('disk-failure'));h.failWrite=false;
 // Simulate a new JS runtime while preserving committed local records.
 h.rows.clear();h.leads.clear();q.evidenceManager.onSessionReset('u');q.setAuthModeState('offline-restored');
 q.evidenceManager.register({type:'business_card_front',sessionId:'restart',asset:{...asset,id:'restart-card',sessionId:'restart'},uploadTiming:'ON_SAVE'});
 await q.submitCaptureSession({...manual,backendSessionId:'restart',session:{draftData:{cardFrontAssetId:'restart-card'},captureMethod:'BUSINESS_CARD'}});
 await q.submitCaptureSession({...manual,backendSessionId:'restart-manual'});
 await q.submitCaptureSession({...manual,backendSessionId:'restart-qr',session:{draftData:qrDraft,captureMethod:'MANUAL',originalCaptureMethod:'QR'}});
 assert.equal(h.rows.size,4);assert.equal((await q.loadQueueItems('u')).length,3);
 delete require.cache[require.resolve(path.join(temp,'actual.cjs'))];const restored=require(path.join(temp,'actual.cjs'));restored.connectivityStore.subscribe(()=>{});
 const before=h.uploads.length;await restored.flushQueue('u');assert.equal(h.uploads.length,before,'new runtime starts unauthorized');assert.equal(h.rows.size,4);
 restored.setAuthModeState('online');h.uploadResult={uploaded:true,metadataWritten:true};h.jobResult={outcome:'queued',jobId:'replayed',error:null};
 let tick,cleared=false;const oldSet=global.setInterval,oldClear=global.clearInterval;
 global.setInterval=(fn)=>{tick=fn;return 1};global.clearInterval=()=>{cleared=true};
 const stop=restored.startQueueReplay('u',e=>{throw e});await new Promise(r=>setImmediate(r));assert.equal(h.rows.size,0);assert.equal(h.uploads.at(-1).dataUrl,asset.dataUrl);
 await restored.enqueueOp('upload_business_card','retry',{...card,assetId:'retry'},'u');h.uploadResult={uploaded:false,metadataWritten:false};tick();await new Promise(r=>setImmediate(r));assert.equal(h.rows.size,1);
 h.uploadResult={uploaded:true,metadataWritten:true};tick();await new Promise(r=>setImmediate(r));assert.equal(h.rows.size,0,'backend recovery retries without a new online event');
 stop();assert(cleared);global.setInterval=oldSet;global.clearInterval=oldClear;
 h.rows.clear();restored.setAuthModeState('offline-restored');
 h.assets.set('recovered',{...asset,id:'recovered',sessionId:'recovered-session'});
 const recoveredParams={...manual,backendSessionId:'recovered-session',session:{draftData:{cardFrontAssetId:'recovered'},captureMethod:'MANUAL',originalCaptureMethod:'BUSINESS_CARD'}};
 assert.equal((await restored.submitCaptureSession(recoveredParams)).outcome,'queued');assert.equal(h.rows.size,2);
 await assert.rejects(restored.submitCaptureSession({...recoveredParams,session:{...recoveredParams.session,draftData:{cardFrontAssetId:'missing'}}}),/unavailable/);
 h.rows.clear();restored.setAuthModeState('online');h.jobResult={outcome:'failed',jobId:null,error:'TypeError: Failed to fetch'};
 assert.equal((await restored.submitCaptureSession({...manual,backendSessionId:'manual-outage'})).outcome,'queued');
 assert.equal((await restored.submitCaptureSession({...manual,backendSessionId:'qr-outage',session:{draftData:qrDraft,captureMethod:'MANUAL',originalCaptureMethod:'QR'}})).outcome,'queued');assert.equal(h.rows.size,2);
 h.jobResult={outcome:'failed',jobId:null,error:'permission denied'};
 assert.equal((await restored.submitCaptureSession({...manual,backendSessionId:'denied'})).outcome,'failed');assert(!h.rows.has('processing_u_denied'));
 console.log('PASS: actual queue failure, partial success, deferral, online success, auth gate, persistence failure');
 // Existing suites are regression coverage; several model old logic rather than import it.
 if(process.argv.includes('--existing'))for(const file of fs.readdirSync('src/capture').filter(f=>f.endsWith('.test.ts'))){const out=path.join(temp,file+'.cjs');await esbuild.build({entryPoints:['src/capture/'+file],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent',define:{'import.meta.env':'undefined'},plugins:[{name:'supabase',setup(b){b.onResolve({filter:/supabaseClient$/},()=>({path:path.resolve('scripts/test_supabase_stub.ts')}))}}]});execFileSync(process.execPath,[out],{stdio:'pipe'});console.log('PASS:',file);}
})().catch(e=>{console.error(e);process.exitCode=1});
