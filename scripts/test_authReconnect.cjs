// Runs the production AuthProvider, cache serialization, connectivity and App
// replay effect with a minimal hook host and controlled SDK/IndexedDB boundaries.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-reconnect-'));
const pause = () => new Promise(r => setTimeout(r, 5));
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise, resolve}; };
const app = fs.readFileSync('src/App.tsx','utf8');
const replayEffect = app.slice(app.indexOf('  useEffect(() => {', app.indexOf('// Flush the offline pending_ops')), app.indexOf('  const { clearEvent } = useEvent();', app.indexOf('// Flush the offline pending_ops')));
assert(replayEffect.includes('startQueueReplay'));
const mocks = {
 react: `export const createContext=()=>({Provider:'Provider'}); export const useContext=()=>globalThis.authValue; export const useState=x=>globalThis.host.state(x); export const useRef=x=>globalThis.host.ref(x); export const useCallback=f=>f; export const useEffect=(f,d)=>globalThis.host.effect(f,d);`,
 'react/jsx-runtime': `export const jsx=(type,props)=>{if(type==='Provider')globalThis.authValue=props.value;return null;};export const jsxs=jsx;`,
 '@supabase/supabase-js': `export const isAuthRetryableFetchError=e=>e?.retryable===true;`,
 supabaseClient: `export const supabase=globalThis.h.sdk; export const hasPersistedSupabaseSessionForUser=id=>globalThis.h.persisted===id; export const clearLocalSupabaseAuthSession=()=>{globalThis.h.persisted=null;};`,
 db: `export const openDB=async()=>{throw Error('Unexpected voice IDB transaction in auth fixture');}; export const dbGet=async(store,key)=>{if(globalThis.h.readFailure)throw Error('read failed');if(globalThis.h.readHold){const hold=globalThis.h.readHold;globalThis.h.readHold=null;await hold.promise;}return globalThis.h.db.get(store+key)||null;}; export const dbPutStrict=async(store,row)=>{if(globalThis.h.writeHold){const hold=globalThis.h.writeHold;globalThis.h.writeHold=null;await hold.promise;}globalThis.h.db.set(store+(row.key||row.id),structuredClone(row));}; export const dbDeleteStrict=async(store,key)=>{globalThis.h.db.delete(store+key);};export const dbPut=dbPutStrict;export const dbDelete=dbDeleteStrict;export const dbGetAllInStoreStrict=async store=>[...globalThis.h.db.entries()].filter(([k])=>k.startsWith(store)).map(([,v])=>v);export const dbGetAllInStore=dbGetAllInStoreStrict;`,
 captureBackendSync: ['syncUpsertSession','syncUpsertAsset','syncUpsertOcrExtraction','syncUpsertQrExtraction','syncUpdateSessionFields','syncUpsertVisionExtraction','syncPromoteSession'].map(n=>`export const ${n}=async()=>{};`).join(''),
 assetStorageUpload: `export const uploadBusinessCardAsset=async()=>{globalThis.h.uploads++;return {uploaded:true,metadataWritten:true};};export const reconcileAssetStorageMetadata=async()=>true;export const uploadNotesImage=async()=>{};`,
 voiceEvidenceManager: `export const executeVoiceNoteUploadOp=async()=>{};`,
 completedLeadsStorage: `export const saveQueuedCapture=async()=>{};export const buildCompletedLead=()=>({});export const getCompletedLead=async()=>null;export const saveCompletedLead=async()=>{};`,
 jobProducer: `export const produceProcessingJob=async()=>({outcome:'queued',jobId:'job'});`,
};
(async()=>{
 await esbuild.build({stdin:{contents:`export * from './src/capture/syncDisplayState';export * from './src/AuthContext';export * from './src/authModeState';export * from './src/capture/authProfileStorage';export * from './src/connectivity/connectivityStore';export * from './src/capture/captureOfflineQueue';import {useEffect} from 'react';import {startQueueReplay} from './src/capture/captureOfflineQueue';const isConsoleEnabled=()=>false;export function Replay(){const {user,authMode}=globalThis.authValue;${replayEffect}}`,resolveDir:process.cwd(),loader:'tsx'},jsx:'automatic',bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'actual.cjs'),logLevel:'silent',plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const key=mocks[a.path]?a.path:path.basename(a.path);if(mocks[key])return {path:key,namespace:'mock'};});b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
 let passed=0;
 function hookHost() {
  return {slots:[],cursor:0,pending:[],state(value){const i=this.cursor++;if(!(i in this.slots))this.slots[i]=value;return [this.slots[i],v=>{this.slots[i]=typeof v==='function'?v(this.slots[i]):v;}];},ref(value){const i=this.cursor++;if(!(i in this.slots))this.slots[i]={current:value};return this.slots[i];},effect(fn,deps){const i=this.cursor++;const old=this.slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){this.pending.push(()=>{old?.cleanup?.();this.slots[i]={deps,cleanup:fn()};});}},run(fn){global.host=this;this.cursor=0;fn();this.pending.splice(0).forEach(f=>f());},dispose(){this.slots.forEach(s=>s?.cleanup?.());}};
 }
 async function fixture(online=true, beforeStart) {
  global.window=new EventTarget();global.document=new EventTarget();document.visibilityState='visible';global.localStorage={removeItem(){}};
  Object.defineProperty(global,'navigator',{value:{onLine:online},configurable:true});
  const profile=id=>({id:'rep-'+id,rep_code:id,name:id,role:'rep',email:'',auth_user_id:id,login_enabled:true,is_active:true});
  const session=id=>({user:{id},access_token:'test-only'});
  const h=global.h={db:new Map(),persisted:'A',id:'A',uploads:0,userCalls:0,profileCalls:0,sessionCalls:0,signouts:0,profileResult:null,userResult:null,sessionResult:null};
  h.sdk={auth:{onAuthStateChange(cb){h.authEvent=cb;return {data:{subscription:{unsubscribe(){}}}};},getSession:async()=>{h.sessionCalls++;return h.sessionResult?await h.sessionResult:{data:{session:session(h.id)},error:null};},getUser:async()=>{h.userCalls++;return h.userResult?await h.userResult:{data:{user:{id:h.id}},error:null};},signOut:async()=>{h.signouts++;h.authEvent('SIGNED_OUT',null);return {error:null};},signInWithPassword:async()=>({error:null})},rpc:async name=>name==='get_rep_login_status'?{data:{status:'ok',email:'test'},error:null}:{error:null},from:()=>({select(){return this;},maybeSingle:async()=>{h.profileCalls++;return h.profileResult?await h.profileResult:{data:profile(h.id),error:null,status:200};}})};
  delete require.cache[require.resolve(path.join(temp,'actual.cjs'))];const api=require(path.join(temp,'actual.cjs'));
  await api.saveCachedAuthProfile({...profile('A'),phone:null,default_event_id:null,default_capture_profile:'EXHIBITION'});
  const auth=hookHost(),replay=hookHost();const render=()=>{auth.run(()=>api.AuthProvider({children:null}));replay.run(api.Replay);};
  const settle=async()=>{for(let i=0;i<5;i++){await pause();render();}};
  beforeStart?.(h);render();h.authEvent('INITIAL_SESSION',h.initialNull?null:session('A'));await settle();
  const transport=v=>{navigator.onLine=v;window.dispatchEvent(new Event(v?'online':'offline'));};
  return {api,h,profile,session,render,settle,transport,dispose(){replay.dispose();auth.dispose();}};
 }
 async function test(name,fn){const f=await fixture();try{await fn(f);passed++;console.log('PASS:',name);}finally{f.dispose();}}
 await test('warm offline closes gate synchronously; reconnect validates before existing App replay',async f=>{
  const {api,h}=f;assert.equal(api.getAuthMode(),'online');f.transport(false);assert.equal(api.isCloudSyncAllowed(),false);await f.settle();assert.equal(api.getAuthMode(),'offline-restored');
  await api.enqueueOp('upload_business_card','s',{assetId:'card',sessionId:'s',ownerId:'A'},'A');const held=deferred();h.userResult=held.promise;f.transport(true);await f.settle();await api.flushQueue('A');assert.equal(h.uploads,0);assert.equal(api.isCloudSyncAllowed(),false);
  for(let i=0;i<5;i++){window.dispatchEvent(new Event('focus'));h.authEvent('TOKEN_REFRESHED',f.session('A'));}await f.settle();assert.equal(h.userCalls,1);
  held.resolve({data:{user:{id:'A'}},error:null});await f.settle();assert.equal(api.getAuthMode(),'online');assert.equal(h.uploads,1);
 });
 await test('online event alone validates auth, replays and changes Queue display; foreground does not duplicate auth',async f=>{
  f.transport(false);await f.settle();
  const lead={id:'s',backendSessionId:'s',ownerId:'A',status:'pending_sync'};
  const ops=[{ownerId:'A',sessionId:'s'}];
  const display=()=>f.api.deriveLeadSyncDisplayState(lead,ops,'A',f.api.isTransportOnline(),global.authValue.authMode);
  assert.equal(display(),'Saved offline');
  await f.api.enqueueOp('upload_business_card','s',{assetId:'card',sessionId:'s',ownerId:'A'},'A');
  const held=deferred();f.h.userResult=held.promise;
  navigator.onLine=true;window.dispatchEvent(new Event('online'));await f.settle();
  assert.equal(f.api.isTransportOnline(),true);assert.equal(f.h.userCalls,1);
  assert.equal(display(),'Saved offline');assert.equal(f.h.uploads,0);
  held.resolve({data:{user:{id:'A'}},error:null});await f.settle();
  assert.equal(display(),'Syncing…');assert.equal(f.h.uploads,1);assert.equal(f.api.getAuthMode(),'online');
  window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await f.settle();
  assert.equal(f.h.userCalls,1);assert.equal(f.h.uploads,1);
 });
 await test('transient auth failure keeps eligible offline access; focus retries',async f=>{f.transport(false);await f.settle();const stamp=(await f.api.loadCachedAuthProfile()).validatedAt;f.h.userResult={data:{user:null},error:{status:429}};f.transport(true);await f.settle();assert.equal(f.api.getAuthMode(),'offline-restored');assert.equal(f.h.signouts,0);assert.equal((await f.api.loadCachedAuthProfile()).validatedAt,stamp);f.h.userResult=null;window.dispatchEvent(new Event('focus'));await f.settle();assert.equal(f.api.getAuthMode(),'online');});
 for(const status of [0,400,401,403,404,429,503])await test(`reconnect ambiguous profile HTTP ${status} stays restricted`,async f=>{f.transport(false);await f.settle();f.h.profileResult={data:null,error:{message:'test'},status};f.transport(true);await f.settle();assert.equal(f.api.getAuthMode(),'offline-restored');assert.equal(f.h.signouts,0);});
 await test('logout wins over in-flight validation and cannot resurrect cache',async f=>{f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();await global.authValue.logout();held.resolve({data:{user:{id:'A'}},error:null});await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(await f.api.loadCachedAuthProfile(),null);window.dispatchEvent(new Event('focus'));await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');});
 await test('pending cache write is ordered before logout clear',async f=>{const held=deferred();f.h.writeHold=held;f.h.authEvent('TOKEN_REFRESHED',f.session('A'));await f.settle();const logout=global.authValue.logout();held.resolve();await logout;assert.equal(await f.api.loadCachedAuthProfile(),null);});
 await test('identity B invalidates pending A validation',async f=>{f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();f.h.id='B';f.h.persisted='B';f.h.userResult=null;f.h.authEvent('SIGNED_IN',f.session('B'));await f.settle();held.resolve({data:{user:{id:'A'}},error:null});await f.settle();assert.equal(global.authValue.user.authUserId,'B');assert.equal((await f.api.loadCachedAuthProfile()).authUserId,'B');});
 await test('offline during validation makes later success stale',async f=>{f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();f.transport(false);held.resolve({data:{user:{id:'A'}},error:null});await f.settle();assert.equal(f.api.getAuthMode(),'offline-restored');});
 await test('getSession refresh recovery feeds server validation',async f=>{f.transport(false);await f.settle();f.h.sessionResult={data:{session:f.session('A')},error:null};f.transport(true);await f.settle();assert.equal(f.h.sessionCalls,1);assert.equal(f.h.userCalls,1);assert.equal(f.api.getAuthMode(),'online');});
 await test('definitive revoked session clears access/cache',async f=>{f.transport(false);await f.settle();f.h.userResult={data:{user:null},error:{code:'session_not_found',status:401}};f.transport(true);await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(await f.api.loadCachedAuthProfile(),null);});
 for(const kind of ['missing','disabled','inactive'])await test(`${kind} rep revokes`,async f=>{f.transport(false);await f.settle();f.h.profileResult={data:kind==='missing'?null:{...f.profile('A'),login_enabled:kind!=='disabled',is_active:kind!=='inactive'},error:null,status:200};f.transport(true);await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(await f.api.loadCachedAuthProfile(),null);});
 await test('early cache read exception releases guard; foreground retries',async f=>{f.transport(false);await f.settle();f.h.readFailure=true;f.transport(true);await f.settle();assert.equal(f.api.isCloudSyncAllowed(),false);f.h.readFailure=false;window.dispatchEvent(new Event('focus'));await f.settle();assert.equal(f.api.getAuthMode(),'online');});
 await test('unmount invalidates pending validation',async f=>{f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();f.dispose();held.resolve({data:{user:{id:'A'}},error:null});await pause();assert.equal(f.api.getAuthMode(),'unauthenticated');});
 await test('expired offline eligibility fails closed without signout',async f=>{const cached=await f.api.loadCachedAuthProfile();f.h.db.set('auth_profilecurrent',{...cached,validatedAt:Date.now()-16*24*60*60*1000});f.transport(false);await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(global.authValue.user,null);assert.equal(f.h.signouts,0);});
 await test('startup classifier still rejects ambiguous profile HTTP 400',async f=>{f.h.profileResult={data:null,error:{message:'test'},status:400};f.h.authEvent('TOKEN_REFRESHED',f.session('A'));await f.settle();assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(f.h.signouts,1);});
 await test('reconnect mismatched profile identity cannot authorize',async f=>{f.transport(false);await f.settle();f.h.profileResult={data:f.profile('B'),error:null,status:200};f.transport(true);await f.settle();assert.equal(f.api.getAuthMode(),'offline-restored');assert.equal(f.h.signouts,0);});
 await test('reconnect during older validation coalesces without overlapping getUser and follows up without focus',async f=>{
  f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;
  f.transport(true);await f.settle();assert.equal(f.h.userCalls,1);
  f.transport(false);await f.settle();f.transport(true);await f.settle();
  assert.equal(f.h.userCalls,1,'older same-user validation must finish before follow-up');
  f.h.userResult=null;held.resolve({data:{user:null},error:{status:503}});await f.settle();
  assert.equal(f.h.userCalls,2);assert.equal(f.api.getAuthMode(),'online');
 });
 await test('foreground requests during failing validation coalesce to one follow-up, then stop',async f=>{
  f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();
  for(let i=0;i<5;i++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));}
  f.h.userResult={data:{user:null},error:{status:503}};
  held.resolve(f.h.userResult);await f.settle();await f.settle();
  assert.equal(f.h.userCalls,2);assert.equal(f.api.getAuthMode(),'offline-restored');
  await f.settle();assert.equal(f.h.userCalls,2,'failure alone must not create a retry loop');
  f.h.userResult=null;f.transport(false);await f.settle();f.transport(true);await f.settle();
  assert.equal(f.h.userCalls,3);assert.equal(f.api.getAuthMode(),'online');
 });
 await test('logout cancels a coalesced reconnect behind old validation',async f=>{
  f.transport(false);await f.settle();const held=deferred();f.h.userResult=held.promise;f.transport(true);await f.settle();
  f.transport(false);await f.settle();f.transport(true);await f.settle();await global.authValue.logout();
  held.resolve({data:{user:{id:'A'}},error:null});await f.settle();
  assert.equal(f.api.getAuthMode(),'unauthenticated');assert.equal(f.h.userCalls,1);assert.equal(await f.api.loadCachedAuthProfile(),null);
 });
 const restoreHold=deferred();const duringRestore=await fixture(false,h=>{h.initialNull=true;h.sessionResult={data:{session:null},error:{retryable:true}};h.readHold=restoreHold;});
 try {
  duringRestore.h.sessionResult=null;duringRestore.transport(true);await duringRestore.settle();
  restoreHold.resolve();await duringRestore.settle();
  assert.equal(duringRestore.api.getAuthMode(),'online','reconnect before cached identity is known must not be lost');
  assert.equal(duringRestore.h.userCalls,1);passed++;console.log('PASS: reconnect during null-session cached identity restoration');
 } finally {duringRestore.dispose();}
 const cold=await fixture(false);assert.equal(cold.api.getAuthMode(),'offline-restored');cold.transport(true);await cold.settle();assert.equal(cold.api.getAuthMode(),'online');cold.dispose();passed++;console.log('PASS: offline cold start reconnect');
 console.log(`${passed} auth reconnect checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
