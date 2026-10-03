const assert=require('node:assert/strict');
const esbuild=require('esbuild');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-connectivity-'));
 const out=path.join(dir,'test.cjs');
 await esbuild.build({stdin:{contents:"export * from './src/mobile/nativeConnectivity'; export * from './src/connectivity/connectivityStore'; export * from './src/authModeState';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:out,plugins:[{name:'native-mocks',setup(b){b.onResolve({filter:/^@capacitor\//},a=>({path:a.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='@capacitor/core'?'export const Capacitor={isNativePlatform:()=>globalThis.native};':a.path==='@capacitor/network'?'export const Network={getStatus:()=>globalThis.read(),addListener:(name,cb)=>globalThis.add(name,cb)};':'export const App={addListener:(name,cb)=>globalThis.add(name,cb)};'}));}}]});
 let calls=0,removed=0,callbacks={},pending=[];
 global.native=false;global.read=async()=>{calls++;return {connected:false};};
 global.add=(name,cb)=>{callbacks[name]=cb;return Promise.resolve({remove:async()=>{removed++;}});};
 const m=require(out);const provider=m.createNativeConnectivityProvider();
 const tick=async()=>{await Promise.resolve();await Promise.resolve();};
 m.bootstrapNativeConnectivity();assert.equal(calls,0);assert.equal(Object.keys(callbacks).length,0);
 // Web bootstrap must leave configuration available, with no plugin work.
 m.connectivityStore.configureProvider(m.createBrowserConnectivityProvider(),true);
 assert.equal(await provider.readStatus(),false);global.read=async()=>({connected:true});assert.equal(await provider.readStatus(),true);
 let values=[],reconciles=0;let cleanup=provider.subscribe(v=>values.push(v),()=>reconciles++);await tick();
 callbacks.networkStatusChange({connected:false});callbacks.networkStatusChange({connected:true});assert.deepEqual(values,[false,true]);
 callbacks.appStateChange({isActive:false});assert.equal(reconciles,0);callbacks.appStateChange({isActive:true});assert.equal(reconciles,1);
 cleanup();cleanup();await tick();assert.equal(removed,2);callbacks.networkStatusChange({connected:false});callbacks.appStateChange({isActive:true});assert.equal(values.length,2);assert.equal(reconciles,1);
 global.add=(name,cb)=>{callbacks[name]=cb;return new Promise(resolve=>pending.push(resolve));};
 cleanup=provider.subscribe(()=>assert.fail('disposed callback'),()=>assert.fail('disposed callback'));cleanup();
 for(const resolve of pending)resolve({remove:async()=>{removed++;}});await tick();assert.equal(removed,4);
 global.add=()=>Promise.reject(Error('registration failed'));cleanup=provider.subscribe(()=>{},()=>{});await tick();cleanup();
 global.add=()=>{throw Error('synchronous registration failure');};cleanup=provider.subscribe(()=>{},()=>{});await tick();cleanup();
 global.add=()=>Promise.resolve({remove:()=>Promise.reject(Error('remove failed'))});cleanup=provider.subscribe(()=>{},()=>{});await tick();cleanup();await tick();
 global.read=()=>Promise.reject(Error('read failed'));const failed=m.createConnectivityStore(provider,false);const stopFailed=failed.subscribe(()=>{});await tick();assert.equal(failed.getSnapshot(),false);stopFailed();await tick();
 global.native=true;global.read=async()=>({connected:false});global.add=(name,cb)=>{callbacks[name]=cb;return Promise.resolve({remove:async()=>{}});};
 const identity=m.connectivityStore;m.setAuthModeState('offline-restored');m.bootstrapNativeConnectivity();assert.equal(identity,m.connectivityStore);assert.equal(identity.getSnapshot(),true);
 const stop=identity.subscribe(()=>{});await tick();assert.equal(identity.getSnapshot(),false);m.bootstrapNativeConnectivity(); // no forbidden reconfiguration after activation
 callbacks.networkStatusChange({connected:true});assert.equal(identity.getSnapshot(),true);assert.equal(m.isCloudSyncAllowed(),false);stop();await tick();
 console.log('PASS: native status mapping, transitions, foreground/inactive, both cleanups, late registration, disposed callbacks, async/sync registration and removal failures, read rejection containment, web no-op, pre-activation bootstrap, seed, singleton identity, bootstrap idempotency, auth separation');
})().catch(e=>{console.error(e);process.exitCode=1;});
