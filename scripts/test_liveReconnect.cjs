// Actual singleton/provider + useOnlineStatus, with React lifecycle and browser EventTargets.
const assert=require('node:assert/strict'),esbuild=require('esbuild'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-reconnect-'));
 await esbuild.build({stdin:{contents:"export * from './src/connectivity/connectivityStore';export * from './src/capture/useOnlineStatus';export * from './src/capture/syncDisplayState';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(dir,'test.cjs'),plugins:[{name:'react-boundary',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const useRef=v=>global.host.ref(v);export const useEffect=(f,d)=>global.host.effect(f,d);export const useSyncExternalStore=(s,g)=>global.host.external(s,g);'}));}}]});
 class BrowserTarget extends EventTarget { registrations=new Map(); addEventListener(type,fn,...rest){if(!this.registrations.has(type))this.registrations.set(type,new Set());this.registrations.get(type).add(fn);super.addEventListener(type,fn,...rest);}removeEventListener(type,fn,...rest){this.registrations.get(type)?.delete(fn);super.removeEventListener(type,fn,...rest);} count(type){return this.registrations.get(type)?.size??0;} }
 global.window=new BrowserTarget();global.document=new BrowserTarget();document.visibilityState='visible';Object.defineProperty(global,'navigator',{value:{onLine:true},configurable:true});
 const api=require(path.join(dir,'test.cjs'));
 function host(){return {slots:[],i:0,ref(v){const n=this.i++;return this.slots[n]??(this.slots[n]={current:v});},effect(fn){const n=this.i++;if(!this.slots[n])this.slots[n]={off:fn()};},external(subscribe,get){const n=this.i++;if(!this.slots[n])this.slots[n]={off:subscribe(()=>{})};return get();},dispose(){this.slots.forEach(s=>s.off?.());this.slots=[];}};}
 let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS:',name);};
 let transitions=0,reconnects=0,offline=0;
 const root=api.connectivityStore.subscribe(()=>transitions++),a=host(),b=host();
 const render=(h,options)=>{global.host=h;h.i=0;return api.useOnlineStatus(options);};
 render(a,{});render(b,{onReconnect:()=>reconnects++,onOffline:()=>offline++});
 check('initial online and one browser listener set',()=>{assert.equal(api.isTransportOnline(),true);for(const t of ['online','offline','focus'])assert.equal(window.count(t),1);assert.equal(document.count('visibilitychange'),1);});
 navigator.onLine=false;window.dispatchEvent(new Event('offline'));
 check('real offline event notifies singleton and hook exactly once',()=>{assert.equal(api.isTransportOnline(),false);assert.equal(transitions,1);assert.equal(offline,1);});
 a.dispose();navigator.onLine=true;window.dispatchEvent(new Event('online'));
 check('manual online dispatch works without focus after another consumer unmounts',()=>{assert.equal(api.isTransportOnline(),true);assert.equal(transitions,2);assert.equal(reconnects,1);});
 window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));
 check('online/focus/visibility dedupe',()=>{assert.equal(transitions,2);assert.equal(reconnects,1);});
 const lead={id:'s',backendSessionId:'s',ownerId:'u',status:'pending_sync'};
 check('Queue projection waits for authorization then leaves offline without focus',()=>{assert.equal(api.deriveLeadSyncDisplayState(lead,[{ownerId:'u',sessionId:'s'}],'u',api.isTransportOnline(),'offline-restored'),'Saved offline');assert.equal(api.deriveLeadSyncDisplayState(lead,[{ownerId:'u',sessionId:'s'}],'u',api.isTransportOnline(),'online'),'Syncing…');});
 for(const event of ['focus','visibilitychange']){navigator.onLine=false;window.dispatchEvent(new Event('offline'));navigator.onLine=true;assert.equal(api.isTransportOnline(),false);(event==='focus'?window:document).dispatchEvent(new Event(event));assert.equal(api.isTransportOnline(),true);}
 check('focus and visibility independently repair missed online events once',()=>{assert.equal(transitions,6);assert.equal(reconnects,3);});
 let fresh=0;render(b,{onReconnect:()=>fresh++});navigator.onLine=false;window.dispatchEvent(new Event('offline'));navigator.onLine=true;window.dispatchEvent(new Event('online'));
 check('latest callback is used without subscription churn',()=>{assert.equal(fresh,1);assert.equal(window.count('online'),1);});
 b.dispose();root();check('last consumer removes all browser listeners',()=>{for(const t of ['online','offline','focus'])assert.equal(window.count(t),0);assert.equal(document.count('visibilitychange'),0);});
 for(let i=0;i<3;i++){const h=host();render(h,{onReconnect:()=>fresh++});navigator.onLine=false;window.dispatchEvent(new Event('offline'));navigator.onLine=true;window.dispatchEvent(new Event('online'));assert.equal(window.count('online'),1);h.dispose();assert.equal(window.count('online'),0);}
 check('StrictMode-style remount remains functional without leaks',()=>assert.equal(fresh,4));
 // Regression: delayed/mismatched event name must not override current browser state.
 const stop=api.connectivityStore.subscribe(()=>{});navigator.onLine=true;window.dispatchEvent(new Event('offline'));
 check('browser event reconciles current navigator value rather than stale event name',()=>assert.equal(api.isTransportOnline(),true));stop();
 // A consumer failure must not starve later consumers of the same transition.
 let emit;const store=api.createConnectivityStore({readStatus:()=>true,subscribe:fn=>{emit=fn;return()=>{};}});let healthy=0;
 const bad=store.subscribe(()=>{throw Error('test consumer');});const good=store.subscribe(()=>healthy++);
 check('subscriber exception cannot interrupt other subscribers',()=>{assert.doesNotThrow(()=>emit(false));assert.equal(healthy,1);assert.equal(store.getSnapshot(),false);});bad();good();
 console.log(`${passed} live reconnect checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
