// C1 production manager/storage/upload/queue/producer, with controlled IDB and SDK boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-c1-'));
const tick = () => new Promise(r => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
const mocks = {
  db: `export const openDB=async()=>global.h.db; export const dbGetAllInStoreStrict=async()=>[...global.h.rows.values()].map(v=>structuredClone(v)); export const dbGetAllInStore=dbGetAllInStoreStrict; export const dbPutStrict=async(s,r)=>global.h.rows.set(r.id,structuredClone(r)); export const dbPut=dbPutStrict; export const dbDelete=async(s,id)=>global.h.rows.delete(id);export const dbDeleteStrict=dbDelete;`,
  connectivityStore: `export const isTransportOnline=()=>global.h.online;`,
  authModeState: `export const isCloudSyncAllowed=()=>global.h.authorized;`,
  supabaseClient: `export const supabase={auth:{getUser:async()=>({data:{user:global.h.user?{id:global.h.user}:null},error:null})},from:t=>global.h.query(t),storage:{from:()=>({upload:async(p,b)=>global.h.upload(p,b)})},functions:{invoke:async()=>{global.h.events.push('transcribe');return global.h.transcribeHold||{data:{},error:null};}}};`,
  completedLeadsStorage: `export const getCompletedLead=async(id)=>global.h.leads.get(id)||null;export const saveCompletedLead=async(l)=>global.h.leads.set(l.id,l);export const buildCompletedLead=(id,captureMethod,draftData,backendSessionId,eventId,eventName,ownerId)=>({id,captureMethod,draftData,backendSessionId,eventId,eventName,ownerId});export const saveQueuedCapture=async(l,o)=>{global.h.leads.set(l.id,structuredClone(l));global.h.rows.set(o.id,structuredClone(o));};`,
  captureBackendSync: ['syncUpsertSession','syncUpsertAsset','syncUpsertOcrExtraction','syncUpsertQrExtraction','syncUpdateSessionFields','syncUpsertVisionExtraction','syncPromoteSession'].map(n=>`export const ${n}=async()=>{global.h.parent=true;};`).join(''),
  captureEvidenceManager: `export const evidenceManager={prepareForSubmission:async()=>{},flushPendingUploads(){},waitForUploads:async()=>{}};`,
  captureEventHandlers: ['registerCardEvidence','registerVoiceNoteEvidence','notifySessionReset','handleVisionExtraction','handleOcrExtraction','handleQrExtraction'].map(n=>`export const ${n}=()=>{};`).join(''),
  captureAuth: `export const getAuthIdentity=async()=>({userId:global.h.user,repCode:null});`,
  processingQueueRepository: `export const enqueueJob=async()=>{global.h.events.push('job');return {success:true,jobId:'s',error:null};};`,
  runtimeDiagnostics: `export const isConsoleEnabled=()=>false;`,
  diagnostics: `export const alpeLog=()=>{};export const alpeError=()=>{};`,
  assetSyncDiagnostics: ['logOperationStart','logOperationEnd','logEvent','getCorrelationId'].map(n=>`export const ${n}=()=>{};`).join(''),
};
function database(h) {
  return {transaction(){
    const tx={error:null}; const working=new Map([...h.rows].map(([k,v])=>[k,structuredClone(v)]));
    tx.objectStore=()=>({getAll:()=>request([...working.values()]),get:id=>request(working.get(id)),put:r=>working.set(r.id,structuredClone(r)),delete:id=>working.delete(id)});
    function request(value){const r={result:value};queueMicrotask(()=>{r.onsuccess?.();queueMicrotask(()=>{const commit=()=>{if(h.failCommit){tx.error=Error('Disk full');tx.onabort?.();}else{h.rows=working;tx.oncomplete?.();}};if(h.holdCommit)h.commits.push(commit);else commit();});});return r;}
    return tx;
  }};
}
function setup(out,rows=new Map()) {
  const h=global.h={rows,leads:new Map(),online:false,authorized:false,user:'u',parent:true,events:[],uploads:[],commits:[]};
  h.db=database(h);
  h.upload=async(p,b)=>{h.events.push('upload');h.uploads.push({path:p,bytes:Buffer.from(await b.arrayBuffer())});if(h.uploadHold)await h.uploadHold;if(h.lose==='upload')h.online=false; if(h.lose==='auth')h.authorized=false;if(h.lose==='owner')h.user='other';if(h.throwUpload)throw Error('Network');return {error:h.uploadError?Error('Storage'):null};};
  h.query=t=>{let value;const q={select(){return q;},eq(){return q;},upsert(v){value=v;return q;},async maybeSingle(){if(t==='capture_sessions')return {data:h.parent?{id:'s'}:null,error:null};return {data:h.asset||null,error:null};},async single(){h.events.push('metadata');if(h.metadataHold)await h.metadataHold;if(h.metadataError)return {data:null,error:Error('Metadata')};h.asset=value;if(h.loseMetadata)h.authorized=false;return {data:h.emptyConfirmation?null:value,error:null};}};return q;};
  delete require.cache[require.resolve(out)];return {h,api:require(out)};
}
(async()=>{
  const out=path.join(temp,'actual.cjs');
  await esbuild.build({stdin:{contents:`export * from './src/capture/assetStorageUpload';export * from './src/capture/voiceTranscriptionService';export * from './src/capture/voiceEvidenceManager';export * from './src/capture/voiceOpStorage';export * from './src/capture/captureOfflineQueue';export * from './src/capture/captureProcessingAdapter';export * from './src/alpe/jobProducer';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:out,plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>mocks[path.basename(a.path)]?{path:path.basename(a.path),namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path]}));}}]});
  let passed=0;
  const blob=new Blob([new Uint8Array([0,1,255,99,8])],{type:'audio/webm'});
  const register=f=>f.api.voiceEvidenceManager.register('s',blob,1000,'audio/webm','ON_SAVE','u');
  const online=f=>{f.h.online=true;f.h.authorized=true;};
  async function test(name,fn){await fn(setup(out));passed++;console.log('PASS:',name);}
  await test('strict persistence waits for transaction completion, not request success',async f=>{f.h.holdCommit=true;let saved=false;const p=register(f).then(()=>saved=true);await tick();assert.equal(saved,false);assert.equal(f.h.rows.size,0);f.h.commits.shift()();await p;assert(saved);assert.equal(f.h.rows.size,1);});
  await test('failed commit rejects and does not report local success',async f=>{f.h.failCommit=true;await assert.rejects(register(f),/Disk full/);assert.equal(f.h.rows.size,0);});
  await test('exact Blob survives fresh module runtime; offline invokes no network; reconnect replays bytes',async f=>{await register(f);assert.deepEqual(f.h.events,[]);const rows=structuredClone(f.h.rows);const cold=setup(out,rows);assert.deepEqual(Buffer.from(await [...rows.values()][0].payload.audioBlob.arrayBuffer()),Buffer.from(await blob.arrayBuffer()));online(cold);await cold.api.flushQueue('u');assert.equal(cold.h.rows.size,0);assert.deepEqual(cold.h.uploads[0].bytes,Buffer.from(await blob.arrayBuffer()));assert.deepEqual(cold.h.events,['upload','metadata','transcribe']);});
  for(const failure of ['uploadError','throwUpload','metadataError']) await test(`${failure} retains exact Blob, op and suppresses transcription`,async f=>{await register(f);online(f);f.h[failure]=true;await f.api.flushQueue('u');assert.equal(f.h.rows.size,1);assert.equal([...f.h.rows.values()][0].retries,1);assert.deepEqual(Buffer.from(await [...f.h.rows.values()][0].payload.audioBlob.arrayBuffer()),Buffer.from(await blob.arrayBuffer()));assert(!f.h.events.includes('transcribe'));f.h[failure]=false;await f.api.flushQueue('u');assert.equal(f.h.rows.size,0);assert.equal(f.h.uploads.length,failure==='metadataError'?1:2);});
  for(const loss of ['upload','auth','owner']) await test(`${loss} loss in flight retains audio without transcription`,async f=>{await register(f);online(f);f.h.lose=loss;await f.api.flushQueue('u');assert.equal(f.h.rows.size,1);assert(!f.h.events.includes('metadata'));assert(!f.h.events.includes('transcribe'));});
  await test('metadata response without confirmation retains op',async f=>{await register(f);online(f);f.h.emptyConfirmation=true;await f.api.flushQueue('u');assert.equal(f.h.rows.size,1);assert(!f.h.events.includes('transcribe'));});
  await test('auth loss during metadata confirmation retains audio and suppresses transcription',async f=>{await register(f);online(f);f.h.loseMetadata=true;await f.api.flushQueue('u');assert.equal(f.h.rows.size,1);assert(!f.h.events.includes('transcribe'));});
  await test('missing authenticated owner retains op',async f=>{await register(f);online(f);f.h.user=null;await f.api.flushQueue('u');assert.equal(f.h.rows.size,1);assert.deepEqual(f.h.events,[]);});
  await test('transport alone is insufficient; auth reconnect permits replay',async f=>{await register(f);f.h.online=true;await f.api.flushQueue('u');assert.equal(f.h.uploads.length,0);online(f);await f.api.flushQueue('u');assert.equal(f.h.rows.size,0);});
  await test('pending transcription does not hold attachment completion or processing',async f=>{const id=await register(f);online(f);f.h.transcribeHold=defer().promise;await f.api.voiceEvidenceManager.ensureRemote('s','u',{voiceNoteRecordingId:id});assert.equal(f.h.rows.size,0);assert(f.h.events.includes('transcribe'));});
  await test('re-record replaces only session/owner slot; remove cancels unsent upload',async f=>{await register(f);const newer=new Blob(['new']);const id=await f.api.voiceEvidenceManager.register('s',newer,2000,'audio/webm','ON_SAVE','u');assert.equal(f.h.rows.size,1);assert.equal([...f.h.rows.values()][0].payload.recordingId,id);assert.equal(await [...f.h.rows.values()][0].payload.audioBlob.text(),'new');await f.api.voiceEvidenceManager.remove('s','u');online(f);await f.api.flushQueue('u');assert.deepEqual(f.h.events,[]);});
  await test('late upload of replaced recording cannot delete latest pending Blob',async f=>{await register(f);const hold=defer();f.h.uploadHold=hold.promise;online(f);const first=f.api.flushQueue('u');await tick();f.h.online=false;const id=await register(f);hold.resolve();await first;assert.equal([...f.h.rows.values()][0].payload.recordingId,id);assert(!f.h.events.includes('metadata'));});
  await test('Save & Next queues voice without waiting remote; producer blocks until remote durable',async f=>{const id=await register(f);online(f);const params={session:{captureMethod:'MANUAL',draftData:{voiceNoteDurationMs:1000,voiceNoteRecordingId:id}},backendSessionId:'s',ownerId:'u',isOnline:true};assert.equal((await f.api.submitCaptureSession(params)).outcome,'queued');assert.deepEqual(f.h.events,[]);f.h.metadataError=true;await f.api.flushQueue('u');assert(!f.h.events.includes('job'));assert.equal(f.h.rows.size,2);f.h.metadataError=false;await f.api.flushQueue('u');assert.equal(f.h.rows.size,0);assert(f.h.events.indexOf('job')>f.h.events.lastIndexOf('metadata'));});
  await test('declared voice missing from both disk and remote blocks direct job producer',async f=>{online(f);const result=await f.api.produceProcessingJob({backendSessionId:'s',ownerId:'u',draftData:{voiceNoteDurationMs:1000},captureMethod:'MANUAL'});assert.equal(result.outcome,'failed');assert(!f.h.events.includes('job'));});
  await test('normal immediate online recording commits then uploads and transcribes',async f=>{online(f);await f.api.voiceEvidenceManager.register('s',blob,1000,'audio/webm','IMMEDIATE','u');await f.api.voiceEvidenceManager.flush('s','u');assert.equal(f.h.rows.size,0);assert.deepEqual(f.h.events,['upload','metadata','transcribe']);});
  await test('existing lead-detail upload caller resolves authenticated owner',async f=>{online(f);await f.api.uploadVoiceNote('s',blob,'audio/webm');assert.equal(f.h.asset.storage_path,'u/s/voice.webm');assert.deepEqual(f.h.events,['upload','metadata']);});
  await test('shared transcription entry rejects offline and restricted auth',async f=>{await f.api.transcribeVoiceNote('s');f.h.online=true;await f.api.transcribeVoiceNote('s');assert.deepEqual(f.h.events,[]);});
  console.log(`${passed} production C1 persistence/replay checks passed`);
  const backendOut=path.join(temp,'backend.cjs');
  const backendMocks={...mocks,capturePromotionService:'export const executePromotion=async()=>{};'};delete backendMocks.captureBackendSync;
  await esbuild.build({stdin:{contents:"export {syncUpsertSession} from './src/capture/captureBackendSync';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:backendOut,plugins:[{name:'backend-boundaries',setup(b){b.onResolve({filter:/.*/},a=>backendMocks[path.basename(a.path)]?{path:path.basename(a.path),namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:backendMocks[a.path]}));}}]});
  const ownerFixture=setup(out);online(ownerFixture);ownerFixture.h.user='other';let ownerError;
  await require(backendOut).syncUpsertSession({sessionId:'s',captureMethod:'MANUAL',draftData:{},sessionStatus:'CAPTURING'},{onSyncing(){},onSynced(){throw Error('Must not sync wrong owner');},onSyncError:e=>ownerError=e,onOffline(){}},'u');
  assert.match(ownerError,/owner changed/);assert.deepEqual(ownerFixture.h.events,[]);passed++;console.log('PASS: parent session reconstruction rejects changed owner');
  // Run the production recorder and the form's actual Save & Next disabled expression.
  const source=fs.readFileSync('src/capture/ManualEntryForm.tsx','utf8');
  const start=source.indexOf('function VoiceNoteRecorder('),end=source.indexOf('// ───',start);
  const disabled=source.match(/disabled=\{(voiceBlocked \|\| saving \|\| !canSave)\}/)[1];
  const uiOut=path.join(temp,'ui.cjs');
  const recorderSource=source.slice(start,end);
  const pollStart=source.indexOf('  useEffect(() => {\n    if (!backendSessionId || (voiceDuration');
  const pollEnd=source.indexOf('\n\n  // Derive',pollStart);
  await esbuild.build({stdin:{contents:`const useState=v=>global.host.state(v),useRef=v=>global.host.ref(v),useEffect=(f,d)=>global.host.effect(f,d);const FieldLabel=()=>null,VoiceTranscriptBlock=()=>null,Square=()=>null,Mic=()=>null,X=()=>null;${recorderSource};export {VoiceNoteRecorder};export function blocked(voicePersistence){const voiceBlocked=voicePersistence==='saving'||voicePersistence==='error',saving=false,canSave=true;return ${disabled};}export function polling(p){const {backendSessionId,voiceDuration,voiceRecordingId,isOnline,authMode,polledStatusRef,voiceTranscriptRef,handlePatchDraftRef,setPolledTranscriptionStatus,supabase,isTransportOnline,isCloudSyncAllowed}=p;${source.slice(pollStart,pollEnd)}}`,loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:uiOut,plugins:[{name:'jsx',setup(b){b.onResolve({filter:/react\/jsx-runtime/},()=>({path:'jsx',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment=Symbol();'}));}}]});
  const ui=require(uiOut);
  function host(){return {values:[],i:0,cleanup:null,deps:null,state(v){const i=this.i++;if(!(i in this.values))this.values[i]=v;return [this.values[i],v=>this.values[i]=typeof v==='function'?v(this.values[i]):v];},ref(v){const i=this.i++;return this.values[i]??(this.values[i]={current:v});},effect(f,d){if(!this.deps||d.some((v,i)=>v!==this.deps[i])){this.cleanup?.();this.deps=d;this.cleanup=f();}}};}
  function nodes(t){if(!t||typeof t!=='object')return [];return [t,...[t.props?.children].flat(2).flatMap(nodes)];}
  let lastRecorder;
  global.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){lastRecorder=this;}start(){}stop(){this.ondataavailable?.({data:blob});this.onstop?.();}};
  Object.defineProperty(global.navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},configurable:true});
  for(const failure of [false,true]){
    const f=setup(out);f.h.holdCommit=true;f.h.failCommit=failure;let state='idle';const hooks=host();global.host=hooks;
    const props={onPersistenceState:s=>state=s,onUpdate(){},onBlobReady:async(b,ms,mime)=>{await f.api.voiceEvidenceManager.register('s',b,ms,mime,'ON_SAVE','u');},onRemove:()=>f.api.voiceEvidenceManager.remove('s','u')};
    const render=()=>{hooks.i=0;return ui.VoiceNoteRecorder(props);};
    await nodes(render()).find(n=>n.props?.['aria-label']==='Start recording').props.onClick();
    nodes(render()).find(n=>n.props?.['aria-label']==='Stop recording').props.onClick();
    assert.equal(state,'saving');assert(ui.blocked(state));await tick();assert(ui.blocked(state));
    f.h.commits.shift()();await tick();assert.equal(state,failure?'error':'saved');assert.equal(ui.blocked(state),failure);
    if(failure){assert(nodes(render()).some(n=>n.props?.role==='alert'));f.h.failCommit=false;nodes(render()).find(n=>n.type==='button'&&n.props.children==='Retry saving').props.onClick();await tick();f.h.commits.shift()();await tick();assert.equal(state,'saved');assert.deepEqual(Buffer.from(await [...f.h.rows.values()][0].payload.audioBlob.arrayBuffer()),Buffer.from(await blob.arrayBuffer()));}
    hooks.cleanup?.();passed++;console.log('PASS: production recorder stop/commit gate',failure?'abort + retry':'success');
  }
  // Execute the existing recursive polling effect with fake timers and lifecycle rerenders.
  const timers=new Map();let nextTimer=1;const savedSet=global.setTimeout,savedClear=global.clearTimeout;
  global.setTimeout=fn=>{const id=nextTimer++;timers.set(id,fn);return id;};global.clearTimeout=id=>timers.delete(id);
  const hooks=host();global.host=hooks;let calls=0,status='pending',onlineState=false,auth=false,reply=null;
  const p={backendSessionId:'s',voiceDuration:1000,isOnline:false,authMode:'offline-restored',polledStatusRef:{current:'pending'},voiceTranscriptRef:{current:''},handlePatchDraftRef:{current(){}},setPolledTranscriptionStatus:s=>{status=s;p.polledStatusRef.current=s;},isTransportOnline:()=>onlineState,isCloudSyncAllowed:()=>auth,supabase:{from(){calls++;return {select(){return this;},eq(){return this;},maybeSingle:async()=>reply||{data:{transcription_status:'uploaded'}}};}}};
  const renderPoll=()=>ui.polling(p);const fire=async()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await tick();};
  renderPoll();assert.equal(timers.size,0);p.isOnline=onlineState=true;renderPoll();assert.equal(timers.size,0);p.authMode='online';auth=true;renderPoll();assert.equal(timers.size,1);renderPoll();assert.equal(timers.size,1);await fire();assert.equal(calls,1);assert.equal(timers.size,1);
  p.isOnline=onlineState=false;p.authMode='offline-restored';auth=false;renderPoll();assert.equal(timers.size,0);assert.equal(status,'pending');p.isOnline=onlineState=true;p.authMode='online';auth=true;renderPoll();assert.equal(timers.size,1);
  const delayed=defer();reply=delayed.promise;await fire();p.isOnline=onlineState=false;auth=false;renderPoll();delayed.resolve({data:{transcription_status:'failed'}});await tick();assert.equal(status,'pending');assert.equal(timers.size,0);hooks.cleanup?.();global.setTimeout=savedSet;global.clearTimeout=savedClear;passed++;
  console.log('PASS: production polling pauses/resumes once; offline late response cannot mark failed');
  console.log(`${passed} C1 checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
