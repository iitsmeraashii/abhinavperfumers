// Production hook with controlled React lifecycle, subscriptions and deferred IDB reads.
const assert=require('node:assert/strict'),esbuild=require('esbuild'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tick=()=>new Promise(r=>setImmediate(r));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function host(){return {v:[],i:0,effects:[],writes:0,state(init){const i=this.i++;if(!(i in this.v))this.v[i]=init;return [this.v[i],v=>{this.writes++;this.v[i]=v;}];},effect(f,d){const i=this.i++,old=this.v[i];if(!old||d.some((v,n)=>v!==old.d[n])){this.v[i]={d};this.effects.push(()=>{old?.cleanup?.();this.v[i].cleanup=f();});}},flush(){for(const f of this.effects.splice(0))f();},stop(){for(const v of this.v)v?.cleanup?.();}};}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sync-hook-'));
 const mocks={react:'export const useState=v=>global.h.state(v),useEffect=(f,d)=>global.h.effect(f,d);',db:'export const subscribePendingOps=f=>global.subscribe("ops",f); export const dbGetAllByIndexStrict=(s,i,o)=>global.readOps(s,i,o);',completedLeadsStorage:'export const subscribeCompletedLeads=f=>global.subscribe("leads",f);export const loadCompletedLeads=o=>global.readLeads(o);'};
 await esbuild.build({entryPoints:['src/capture/useSyncDisplay.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(dir,'hook.cjs'),plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const k=path.basename(a.path);if(mocks[k])return {path:k,namespace:'mock'};});b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path]}));}}]});
 const {useSyncDisplay}=require(path.join(dir,'hook.cjs'));
 global.window=new EventTarget();global.document=new EventTarget();document.visibilityState='visible';
 let passed=0;
 async function check(name,fn){const h=global.h=host(),listeners={ops:new Set(),leads:new Set()},reads=[];
 global.subscribe=(type,f)=>{listeners[type].add(f);return ()=>listeners[type].delete(f);};
 global.readLeads=owner=>{const d=defer();reads.push({owner,leads:d});return d.promise;};
 global.readOps=(store,index,owner)=>{assert.equal(store,'pending_ops');assert.equal(index,'by_owner');const r=reads.at(-1);assert.equal(r.owner,owner);r.ops=defer();return r.ops.promise;};
 const render=(owner='u',online=true,auth='online')=>{h.i=0;const result=useSyncDisplay(owner,online,auth);h.flush();return result;};
 const finish=(r,ops=[])=>{r.leads.resolve([{id:r.owner,ownerId:r.owner,backendSessionId:r.owner,status:'pending_sync'}]);r.ops.resolve(ops);};
 const emit=()=>{for(const f of listeners.ops)f();for(const f of listeners.leads)f();};
 try{await fn({h,listeners,reads,render,finish,emit});passed++;console.log('PASS:',name);}finally{h.stop();assert.equal(listeners.ops.size+listeners.leads.size,0);}}
 await check('burst coalesces into one indexed read',async f=>{f.render();f.emit();f.emit();assert.equal(f.reads.length,0);await tick();assert.equal(f.reads.length,1);f.finish(f.reads[0]);await tick();assert.equal(f.render().states.get('u'),'Saved');});
 await check('superseded read cannot overwrite newer result',async f=>{f.render();await tick();f.emit();await tick();assert.equal(f.reads.length,2);f.finish(f.reads[1],[{ownerId:'u',sessionId:'u'}]);await tick();assert.equal(f.render().states.get('u'),'Syncing…');f.finish(f.reads[0]);await tick();assert.equal(f.render().states.get('u'),'Syncing…');});
 await check('owner switch masks old snapshot and ignores late previous-owner read',async f=>{f.render();await tick();f.finish(f.reads[0]);await tick();f.render();f.emit();await tick();assert.equal(f.render('v').states.size,0);await tick();f.finish(f.reads[2]);await tick();f.finish(f.reads[1]);await tick();assert.deepEqual([...f.render('v').states.keys()],['v']);});
 await check('unmount prevents late state write',async f=>{f.render();await tick();f.h.stop();const before=f.h.writes;f.finish(f.reads[0]);await tick();assert.equal(f.h.writes,before);});
 await check('unmount before microtask avoids read',async f=>{f.render();f.h.stop();await tick();assert.equal(f.reads.length,0);});
 await check('auth and transport gate retained snapshot immediately',async f=>{f.render();await tick();f.finish(f.reads[0],[{ownerId:'u',sessionId:'u'}]);await tick();assert.equal(f.render('u',true,'offline-restored').states.get('u'),'Saved offline');assert.equal(f.render('u',false,'online').states.get('u'),'Saved offline');});
 await check('focus and visibility burst coalesces',async f=>{f.render();await tick();f.finish(f.reads[0]);await tick();window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(f.reads.length,2);});
 console.log(`${passed} production hook checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
