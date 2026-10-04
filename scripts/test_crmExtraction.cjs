// Executes the production component + extraction hook with controlled React/DOM/network boundaries.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),esbuild=require('esbuild');
const tick=()=>new Promise(r=>setImmediate(r));
const defer=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'crm-extraction-'));
const icons='ArrowLeft Camera Trash2 CheckCircle2 RotateCcw AlertCircle Loader2 CreditCard Check Sparkles Globe MapPin Phone Mail Plus X WifiOff ChevronRight Zap FlipHorizontal'.split(' ');
const mocks={
 react:`export const useState=v=>global.hooks.state(v),useRef=v=>global.hooks.ref(v),useCallback=(f,d)=>global.hooks.callback(f,d),useEffect=(f,d)=>global.hooks.effect(f,d);`,
 'react/jsx-runtime':`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment=Symbol();`,
 'react-dom':`export const createPortal=v=>v;`,
 'lucide-react':icons.map(n=>`export const ${n}=()=>null;`).join(''),
 supabaseClient:`export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'test-only'}}})}};`,
 captureAssetStorage:`export const saveAsset=async(s,side,dataUrl,ownerId)=>({id:dataUrl,sessionId:s,side,dataUrl,ownerId});export const deleteAsset=async()=>{};export const getSessionAssets=async()=>[];`,
 captureEvidenceManager:`export const evidenceManager={abandonAsset:async()=>{}};`,
 CaptureUI:`export const Toast=()=>null;`,
 useOcr:`export const useOcr=()=>{};`,
 ocrFallback:`export default async()=>{global.fallbackCalls++;return global.fallback();};`,
 parseBusinessCard:`export const parseBusinessCardText=t=>({fields:{clientName:t},confidence:'high'});`,
};
function host(){return {v:[],i:0,effects:[],events:[],state(init){const i=this.i++;if(!(i in this.v))this.v[i]=typeof init==='function'?init():init;return [this.v[i],next=>{this.v[i]=typeof next==='function'?next(this.v[i]):next;if(this.v[i]?.status)this.events.push(this.v[i].status);}];},ref(v){const i=this.i++;return this.v[i]??(this.v[i]={current:v});},callback(f,d){const i=this.i++,old=this.v[i];if(!old||d.some((x,n)=>x!==old.d[n]))this.v[i]={f,d};return this.v[i].f;},effect(f,d){const i=this.i++,old=this.v[i];if(!old||d.some((x,n)=>x!==old.d[n])){this.v[i]={d,cleanup:old?.cleanup};this.effects.push(()=>{old?.cleanup?.();this.v[i].cleanup=f();});}},flush(){for(const f of this.effects.splice(0))f();},stop(){for(const v of this.v)v?.cleanup?.();}};}
const walk=t=>!t||typeof t!=='object'?[]:[t,...[t.props?.children].flat(3).flatMap(walk)];
const text=t=>typeof t==='string'?t:Array.isArray(t)?t.map(text).join(''):t?.props?text(t.props.children):'';
(async()=>{
 const out=path.join(temp,'actual.cjs');await esbuild.build({entryPoints:['src/capture/BusinessCardCapture.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:out,define:{'import.meta.env':'{}'},plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const key=mocks[a.path]?a.path:path.basename(a.path);if(mocks[key])return {path:key,namespace:'mock'};});b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path]}));}}]});
 const {BusinessCardCapture}=require(out);
 const originalSet=global.setTimeout,originalClear=global.clearTimeout;let now=0,id=0,timers=new Map();
 global.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;};global.clearTimeout=id=>timers.delete(id);
 async function advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now&&timers.has(id)){timers.delete(id);t.fn();}await tick();}
 global.Image=class {naturalWidth=1;naturalHeight=1;set src(v){queueMicrotask(()=>this.onload());}};
 global.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData(){throw Error('skip sharpening');}}),toBlob:fn=>fn(new Blob(['image']))})};
 const response=name=>({ok:true,json:async()=>({success:true,data:{fullName:name,firstName:name,lastName:'',company:'Example',designation:'',emails:[],phoneNumbers:[],website:'',address:'',notes:'',rawText:name,confidence:.9},durationMs:4000})});
 function fixture(extra={}){
  timers.clear();now=0;const hooks=global.hooks=host(),requests=[];global.fallbackCalls=0;global.fallback=async()=>{throw Error('OCR failed');};
  global.fetch=(url,options)=>{const d=defer();requests.push({...d,signal:options.signal});return d.promise;};
  const completed=[],patches=[];const props={session:{draftData:{}},sessionId:'s',ownerId:'u',isOnline:true,extractionPolicy:'IMMEDIATE',exhibitionMode:false,onComplete:(...a)=>completed.push(a),onDraftPatch:patch=>{hooks.events.push('apply');patches.push(patch);props.session={draftData:{...props.session.draftData,...patch}};},...extra};
  const render=()=>{global.hooks=hooks;hooks.i=0;const tree=BusinessCardCapture(props);hooks.flush();return tree;};
  const settle=async()=>{for(let i=0;i<5;i++){await tick();render();}};
  const preview=()=>walk(render()).find(n=>n.props?.side==='front'&&'asset' in n.props);
  const button=()=>walk(render()).find(n=>n.type==='button'&&text(n).startsWith('Continue'));
  const capture=async(name='A')=>{preview().props.onCapture();const overlay=walk(render()).find(n=>n.props?.side==='front'&&'onCancel' in n.props);const p=overlay.props.onCapture('data:image/jpeg;base64,'+Buffer.from(name).toString('base64'));await settle();return {p};};
  render();return {hooks,requests,props,patches,completed,render,settle,preview,button,capture};
 }
 let passed=0;async function test(name,fn){const f=fixture();try{await fn(f);console.log('PASS:',name);passed++;}finally{f.hooks.stop();}}
 await test('A/B/J CRM blocks direct continuation and applies fields before done',async f=>{await f.capture();assert.equal(f.button().props.disabled,true);f.button().props.onClick();assert.equal(f.completed.length,0);f.requests[0].resolve(response('Alice'));await f.settle();assert.equal(f.props.session.draftData.clientName,'Alice');assert(f.hooks.events.indexOf('apply')<f.hooks.events.indexOf('done'));assert.equal(f.button().props.disabled,false);f.button().props.onClick();assert.equal(f.completed.length,1);assert.equal(f.completed[0][2].fields.clientName,'Alice');});
 await test('C extraction and fallback failure unblock',async f=>{await f.capture();f.requests[0].reject(Error('network'));await f.settle();assert(f.hooks.events.includes('error'));assert.equal(f.button().props.disabled,false);assert.equal(fallbackCalls,1);});
 await test('D/E timeout aborts at 30s; late response cannot update or block',async f=>{await f.capture();await advance(29999);assert(f.button().props.disabled);await advance(1);assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.button().props.disabled,false);f.button().props.onClick();f.requests[0].resolve(response('Late'));await f.settle();assert.equal(f.patches.length,0);assert.equal(f.button().props.disabled,false);});
 await test('F old card A cannot apply or unblock active B',async f=>{await f.capture('A');await f.capture('B');assert(f.requests[0].signal.aborted);f.requests[0].resolve(response('Old'));await f.settle();assert.equal(f.patches.length,0);assert(f.button().props.disabled);f.requests[1].resolve(response('New'));await f.settle();assert.equal(f.props.session.draftData.clientName,'New');assert.equal(f.button().props.disabled,false);});
 await test('F old response after B completed preserves B fields and state',async f=>{await f.capture('A');await f.capture('B');f.requests[1].resolve(response('New'));await f.settle();f.requests[0].resolve(response('Old'));await f.settle();assert.equal(f.props.session.draftData.clientName,'New');assert.equal(f.patches.length,1);assert.equal(f.button().props.disabled,false);});
 await test('G deferred capture has no extraction delay',async f=>{f.props.extractionPolicy='DEFERRED';await f.capture();assert.equal(f.requests.length,0);assert.equal(f.button().props.disabled,false);f.button().props.onClick();assert.equal(f.completed.length,1);});
 await test('H offline capture skips request and remains continuable',async f=>{f.props.isOnline=false;await f.capture();assert.equal(f.requests.length,0);assert.equal(f.button().props.disabled,false);});
 await test('fallback success applies before completing',async f=>{global.fallback=async()=> 'OCR Name';await f.capture();f.requests[0].reject(Error('vision unavailable'));await f.settle();assert.equal(f.props.session.draftData.clientName,'OCR Name');assert(f.hooks.events.indexOf('apply')<f.hooks.events.indexOf('done'));assert.equal(f.button().props.disabled,false);});
 await test('30s ceiling also covers stuck fallback',async f=>{const held=defer();global.fallback=()=>held.promise;await f.capture();f.requests[0].reject(Error('vision unavailable'));await f.settle();await advance(30000);assert.equal(f.button().props.disabled,false);held.resolve('Late OCR');await f.settle();assert.equal(f.patches.length,0);});
 await test('unmount cancels and ignores late extraction',async f=>{await f.capture();f.hooks.stop();f.requests[0].resolve(response('Late'));await tick();await tick();assert.equal(f.patches.length,0);assert(f.requests[0].signal.aborted);});
 for(const offline of [false,true]){const f=fixture({exhibitionMode:true,extractionPolicy:'DEFERRED',isOnline:!offline});await f.capture();assert.equal(f.requests.length,0);assert.equal(f.completed.length,1);assert.equal(f.button(),undefined);assert.equal(f.patches.length,0);f.hooks.stop();passed++;console.log('PASS: I Exhibition deferred auto-continue unchanged',offline?'offline':'online');}
 global.setTimeout=originalSet;global.clearTimeout=originalClear;console.log(`${passed} CRM extraction checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
