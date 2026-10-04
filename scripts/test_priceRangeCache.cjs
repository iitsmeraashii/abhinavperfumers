// B3: execute production service/storage/hook with controlled SDK/IDB boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'price-range-'));
const tick = () => new Promise(r => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const builtins = ['INR', 'USD', '<', '>', '=', '-'];
const mocks = {
  react: `export const useSyncExternalStore=(subscribe,get)=>get();export const useEffect=(f,d)=>global.host.effect(f,d);`,
  AuthContext: `export const useAuth=()=>global.h.auth;`,
  authModeState: `export const isCloudSyncAllowed=()=>global.h.auth.authMode==='online';`,
  connectivityStore: `export const isTransportOnline=()=>global.h.online;`,
  supabaseClient: `export const supabase={rpc:async(name,args)=>{global.h.calls.push({name,args});return name==='get_price_range_quick_values'?(global.h.hold||{data:global.h.values,error:global.h.error}):(global.h.saveHold||{data:global.h.saveResult||{success:true,values:args.p_values},error:global.h.saveError});}};`,
  db: `export const dbGet=async()=>{if(global.h.readError)throw Error('disk');return global.h.readHold||global.h.row;};export const dbPutStrict=async(store,row)=>{if(global.h.writeError)throw Error('disk');global.h.store=store;global.h.row=structuredClone(row);};`,
};
function host() { return { deps: null, cleanup: null, effect(fn, deps) { if (!this.deps || deps.some((v,i)=>v!==this.deps[i])) { this.cleanup?.(); this.deps=deps; this.cleanup=fn(); } }, stop() { this.cleanup?.(); this.deps=null; } }; }
(async () => {
  const out=path.join(temp,'actual.cjs');
  await esbuild.build({stdin:{contents:"export * from './src/runtime/priceRangeConfiguration';export * from './src/capture/priceRangeCacheStorage';export * from './src/capture/usePriceRangeQuickValues';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:out,plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const k=path.basename(a.path);if(mocks[k])return {path:k,namespace:'mock'};});b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path]}));}}]});
  let passed=0;
  function setup(mode='online',row=null) {
    global.h={auth:{user:{authUserId:'A'},authMode:mode},online:mode==='online',row,values:[' AED ','aed','USD','', 'GBP'],calls:[]};
    global.localStorage={getItem(){throw Error('Legacy storage must never be read');},setItem(){throw Error('Must not write legacy storage');}};
    delete require.cache[require.resolve(out)];const api=require(out),hooks=host();
    const render=()=>{global.host=hooks;return api.usePriceRangeQuickValues();};
    const settle=async()=>{for(let i=0;i<6;i++){render();await tick();}};
    return {api,h:global.h,hooks,render,settle};
  }
  async function test(name,fn){const f=setup();try{await fn(f);passed++;console.log('PASS:',name);}finally{f.hooks.stop();}}
  await test('A/G prefetch normalizes and persists without field interaction',async f=>{await f.settle();assert.deepEqual(f.api.getPriceRangeSnapshot().values,['AED','GBP']);assert.deepEqual(f.h.row.values,['AED','GBP']);assert.equal(f.h.row.key,'price_range_quick_values');assert.equal(f.h.row.schemaVersion,1);assert.equal(f.h.store,'capture_config_cache');assert.equal(f.h.calls.length,1);assert(!('ownerId' in f.h.row));});
  await test('B/C/N cold offline restart restores confirmed values and built-ins, ignores legacy storage',async f=>{await f.settle();const row=f.h.row;f.hooks.stop();const cold=setup('offline-restored',row);await cold.settle();assert.deepEqual(cold.api.getPriceRangeSnapshot().quickValues,[...builtins,'AED','GBP']);assert.equal(cold.h.calls.length,0);cold.hooks.stop();});
  await test('D failed and rejected refresh preserve confirmed disk and memory',async f=>{await f.settle();f.h.error=Error('network');await f.api.refreshPriceRange();assert.deepEqual(f.h.row.values,['AED','GBP']);f.h.hold=Promise.reject(Error('transport'));await f.api.refreshPriceRange();assert.deepEqual(f.api.getPriceRangeSnapshot().values,['AED','GBP']);});
  await test('E malformed response cannot overwrite cache',async f=>{await f.settle();for(const bad of [null,{},[123]]){f.h.values=bad;await f.api.refreshPriceRange();assert.deepEqual(f.h.row.values,['AED','GBP']);}});
  await test('F successful empty clears additions durably but retains built-ins',async f=>{await f.settle();f.h.values=[];await f.api.refreshPriceRange();assert.deepEqual(f.h.row.values,[]);assert.deepEqual(f.api.getPriceRangeSnapshot().quickValues,builtins);});
  await test('H transport reconnect alone cannot fetch; A2 online transition refreshes',async f=>{await f.settle();f.h.auth.authMode='offline-restored';f.h.online=false;await f.settle();f.h.online=true;await f.api.refreshPriceRange();assert.equal(f.h.calls.length,1);f.h.auth.authMode='online';f.h.values=['EUR'];await f.settle();assert.equal(f.h.calls.length,2);assert.deepEqual(f.h.row.values,['EUR']);});
  await test('I concurrent refresh deduplicates',async f=>{await f.settle();const hold=defer();f.h.hold=hold.promise;const a=f.api.refreshPriceRange(),b=f.api.refreshPriceRange();assert.equal(a,b);hold.resolve({data:[],error:null});await a;assert.equal(f.h.calls.length,2);});
  await test('J older fetch cannot overwrite confirmed admin save',async f=>{await f.settle();const hold=defer();f.h.hold=hold.promise;const old=f.api.refreshPriceRange();await f.api.saveConfirmedPriceRange(['EUR']);hold.resolve({data:['OLD'],error:null});await old;assert.deepEqual(f.h.row.values,['EUR']);assert.deepEqual(f.api.getPriceRangeSnapshot().values,['EUR']);});
  for(const transition of ['logout','owner','offline','unmount']) await test(`K ${transition} invalidates delayed fetch`,async f=>{const hold=defer();f.h.hold=hold.promise;await f.settle();if(transition==='unmount')f.hooks.stop();else{f.h.auth.user=transition==='logout'?null:{authUserId:transition==='owner'?'B':'A'};f.h.auth.authMode=transition==='logout'?'unauthenticated':'offline-restored';f.h.online=false;await f.settle();}hold.resolve({data:['OLD'],error:null});await tick();await tick();assert.equal(f.h.row,null);assert.deepEqual(f.api.getPriceRangeSnapshot().values,[]);});
  await test('L successful admin save and [] update reactive snapshot and disk',async f=>{await f.settle();let notifications=0;const stop=f.api.subscribePriceRange(()=>notifications++);await f.api.saveConfirmedPriceRange([' EUR ','eur','INR']);assert.deepEqual(f.api.getPriceRangeSnapshot().values,['EUR']);assert.deepEqual(f.h.row.values,['EUR']);await f.api.saveConfirmedPriceRange([]);assert.deepEqual(f.h.row.values,[]);assert.deepEqual(f.api.getPriceRangeSnapshot().quickValues,builtins);assert(notifications>0);stop();});
  await test('M failed admin save leaves confirmed snapshot and disk intact',async f=>{await f.settle();f.h.saveError=Error('denied');await assert.rejects(f.api.saveConfirmedPriceRange(['LOCAL']));assert.deepEqual(f.h.row.values,['AED','GBP']);assert.deepEqual(f.api.getPriceRangeSnapshot().values,['AED','GBP']);f.h.saveError=null;f.h.saveResult={success:false,error:'Not authorized'};await assert.rejects(f.api.saveConfirmedPriceRange([]));assert.deepEqual(f.h.row.values,['AED','GBP']);});
  await test('malformed record and strict write failure retain safe snapshot; retry succeeds',async f=>{f.h.row={key:'price_range_quick_values',schemaVersion:1,values:[42],fetchedAt:1};assert.equal(await f.api.loadPriceRangeCache(),null);f.h.writeError=true;await f.settle();assert.deepEqual(f.api.getPriceRangeSnapshot().quickValues,builtins);f.h.writeError=false;await f.api.refreshPriceRange();assert.deepEqual(f.api.getPriceRangeSnapshot().values,['AED','GBP']);});
  await test('late IndexedDB restore cannot overwrite newer authoritative empty',async f=>{const hold=defer();f.h.readHold=hold.promise;f.render();f.h.values=[];await f.api.refreshPriceRange();hold.resolve({key:'price_range_quick_values',schemaVersion:1,values:['OLD'],fetchedAt:1});await tick();assert.deepEqual(f.api.getPriceRangeSnapshot().values,[]);});
  await test('StrictMode cleanup/reactivation ignores old lifecycle',async f=>{const hold=defer();f.h.hold=hold.promise;await f.settle();f.hooks.stop();f.h.hold=null;f.h.values=['EUR'];await f.settle();hold.resolve({data:['OLD'],error:null});await tick();assert.deepEqual(f.api.getPriceRangeSnapshot().values,['EUR']);});
  await test('overlapping consumers share lifecycle; final release invalidates',async f=>{await f.settle();const stop=f.api.activatePriceRange('A','online');f.hooks.stop();await f.api.refreshPriceRange();assert.equal(f.h.calls.length,2);stop();await f.api.refreshPriceRange();assert.equal(f.h.calls.length,2);});
  await test('old admin save cannot publish after identity change or block new refresh',async f=>{await f.settle();const hold=defer();f.h.saveHold=hold.promise;const old=f.api.saveConfirmedPriceRange(['OLD']);f.h.auth.user={authUserId:'B'};f.h.values=['NEW'];await f.settle();hold.resolve({data:{success:true,values:['OLD']},error:null});await assert.rejects(old);assert.deepEqual(f.api.getPriceRangeSnapshot().values,['NEW']);});

  // Exercise the production input: free text and insertion are independent of options.
  const source=fs.readFileSync('src/capture/ManualEntryForm.tsx','utf8');
  const start=source.indexOf("const PRICE_RANGE_OPERATORS"),end=source.indexOf('// ─── Lead type',start);
  const uiOut=path.join(temp,'input.cjs');
  await esbuild.build({stdin:{contents:`const useRef=()=>global.inputRef;const FieldLabel=()=>null;const inputCls=()=>'';${source.slice(start,end)};export {PriceRangeInput};`,loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:uiOut,plugins:[{name:'jsx',setup(b){b.onResolve({filter:/react\/jsx-runtime/},()=>({path:'jsx',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;'}));}}]});
  let changed;global.inputRef={current:{selectionStart:4,selectionEnd:7,focus(){}}};global.requestAnimationFrame=fn=>fn();
  const tree=require(uiOut).PriceRangeInput({value:'OLD 500',onChange:v=>changed=v,quickValues:builtins});
  const input=tree.props.children[1];assert.equal(input.props.value,'OLD 500');input.props.onChange({target:{value:'Historical arbitrary text'}});assert.equal(changed,'Historical arbitrary text');
  const buttonGroups=tree.props.children[2].props.children;buttonGroups[1][0].props.onClick();assert.equal(changed,'OLD INR ');assert.equal(global.inputRef.current.selectionStart,8);
  passed++;console.log('PASS: O/P production input retains historical text and cursor insertion');

  const dbOut=path.join(temp,'db.cjs');await esbuild.build({entryPoints:['src/capture/db.ts'],bundle:true,platform:'node',format:'cjs',outfile:dbOut});
  const stores=new Set(['drafts','assets','pending_ops','lead_queue','completed_leads','auth_profile','event_cache','previous_rep_cache']),created=[];let request;
  const database={objectStoreNames:{contains:n=>stores.has(n)},createObjectStore(n,options){created.push([n,options]);stores.add(n);return {createIndex(){}};},close(){}};
  global.indexedDB={open(name,version){assert.equal(name,'capture_app');assert.equal(version,12);request={result:database,transaction:{objectStore:()=>({indexNames:{contains:()=>true}})}};return request;}};
  const opened=require(dbOut).openDB();request.onupgradeneeded({oldVersion:11,target:request});request.onsuccess();await opened;assert.deepEqual(created,[['capture_config_cache',{keyPath:'key'}]]);assert.equal(stores.size,9);
  passed++;console.log('PASS: Q v11 to v12 adds only capture_config_cache');
  console.log(`${passed} B3 checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
