const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const jsx = (type, props) => ({ type, props });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(' ');
function load(file, dependencies = {}, extra = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8').replace(/import\.meta\.env\.[A-Z_]+/g, '"test"'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, { exports, require: name => {
    if (!(name in dependencies)) throw new Error('Unexpected import: '+name);
    return dependencies[name];
  }, ...extra });
  return exports;
}
function harness() {
  const slots = []; let cursor = 0, queued = [];
  const changed = (previous, next) => !previous || next.some((v, i) => v !== previous[i]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) queued.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, fn, cleanup: fn() }; }); },
    useCallback(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
  };
  return { react, render(component, props) { cursor=0; const tree=component(props); const effects=queued; queued=[]; effects.forEach(fn=>fn()); return tree; }, cleanup() { slots.forEach(s=>s?.cleanup?.()); }, strictReplay() { slots.forEach(s=> { if (s?.fn) { s.cleanup?.(); s.cleanup=s.fn(); } }); } };
}
const model = load('src/eventOverviewModel.ts');
const fixture = id => ({
  eventId: id, eventCode: id, templateConfigured: true,
  metrics: { total: 10, contacted: 2, samples: 1, converted: 2, lost: 1, invalid: 1, review: 1, connected: 3, engaged: 6, sampled: 4, hot: 2, warm: 3, cold: 1, unassigned: 3, other_temperature: 1 },
  countries: [{value:'India',count:6},{value:null,count:4}], states:[{value:'Goa',count:10}],
  reps:[{code:'R1',name:'Rep One',total:10,contacted:2,samples:1,converted:2,lost:1}],
  days:[{day:'2026-10-16',count:10}], countriesMore:false,statesMore:false,repsMore:false,daysMore:false,
});
assert.ok(model.parseEventOverview(fixture('A'),'A'));
assert.equal(model.parseEventOverview(fixture('B'),'A'),null);
for (const bad of [null, {}, {...fixture('A'),metrics:{...fixture('A').metrics,sampled:9}}, {...fixture('A'),metrics:{...fixture('A').metrics,total:'10'}}, {...fixture('A'),countries:[{value:'India',count:1}]}]) assert.equal(model.parseEventOverview(bad,'A'),null);
assert.deepEqual(Array.from(model.eventFunnel(fixture('A')), s=>s.count),[10,3,6,4]);
assert.deepEqual(Array.from(model.eventFunnel({...fixture('A'),templateConfigured:false}),s=>s.label),['Total leads','Sales Rep Engaged','Samples Sent']);
assert.equal(model.geographyLabel(null),'Unassigned');
assert.equal(model.geographyLabel('  '),'Whitespace only');
assert.equal(model.geographyLabel(' India '),'India (surrounding spaces)');
const gate = new model.EventRequestGate(); const ticket=gate.begin();assert.ok(gate.current(ticket));gate.invalidate();assert.ok(!gate.current(ticket));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let online=true, auth={user:{authUserId:'admin-A',role:'admin',rep_code:'ADMIN'},authMode:'online'};
const identityKey = user => user ? `${user.authUserId}|${user.role}` : null;
const isAuthorized = () => online && auth.authMode==='online';
const icons=new Proxy({}, {get:(_target,name)=>String(name)});
const common = {'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':icons,'./AuthContext':{useAuth:()=>auth},'./capture/useOnlineStatus':{useOnlineStatus:()=>online},'./dashboardMetricsLoader':{identityKey,isAuthorized},'./eventOverviewModel':model};
(async()=>{
  const h=harness();const requests=[];let pending=[];let navigation;
  const component=load('src/EventOverview.tsx',{...common,react:h.react,'./EventOverview.css':{},'./supabaseClient':{supabase:{rpc:(name,args)=>{requests.push({name,args});return new Promise(resolve=>pending.push(resolve));}}}});
  let props={eventId:'A',revision:'saved-1',onViewLeads:(eventCode,filters)=>navigation={eventCode,filters}};
  let render=()=>h.render(component.default,props);
  render();assert.equal(requests.length,1);assert.equal(requests[0].args.p_event_id,'A');
  h.strictReplay();assert.equal(requests.length,2);
  pending.shift()({data:fixture('A'),error:null});await tick();assert.equal(nodes(render()).filter(n=>n.type===component.EventFunnel).length,0);
  pending.shift()({data:fixture('A'),error:null});await tick();let tree=render();
  const funnel=component.EventFunnel({data:fixture('A')});assert.equal(nodes(funnel).filter(n=>n.type==='button'||n.props?.onClick).length,0);
  const statusButton=nodes(tree).find(n=>n.type==='button'&&text(n).includes('Contacted'));
  statusButton.props.onClick();assert.equal(navigation.eventCode,'A');assert.equal(navigation.filters.leadStatus,'CONTACTED');
  const geography=nodes(tree).find(n=>n.type===component.GeographyBreakdown&&n.props.title==='Countries');geography.props.onSelect(null);assert.equal(navigation.filters.country,'__unassigned__');geography.props.onSelect(' India ');assert.equal(navigation.filters.country,' India ');
  props={...props,eventId:'B'};tree=render();assert.equal(nodes(tree).filter(n=>n.type===component.EventFunnel).length,0);
  props={...props,eventId:'C'};render();pending.shift()({data:fixture('B'),error:null});await tick();assert.equal(nodes(render()).filter(n=>n.type===component.EventFunnel).length,0);
  pending.shift()({data:null,error:{}});await tick();tree=render();assert.ok(text(tree).includes('could not be loaded'));nodes(tree).find(n=>n.type==='button'&&text(n)==='Retry').props.onClick();render();
  online=false;render();pending.shift()({data:fixture('C'),error:null});await tick();assert.ok(text(render()).includes('online admin session'));
  online=true;auth.authMode='offline-restored';const before=requests.length;render();assert.equal(requests.length,before);
  auth.authMode='online';render();auth.user={...auth.user,authUserId:'admin-B'};render();pending.shift()({data:fixture('C'),error:null});await tick();assert.equal(nodes(render()).filter(n=>n.type===component.EventFunnel).length,0);
  h.cleanup();pending.shift()({data:fixture('C'),error:null});await tick();
  console.log('Event overview: parsing, inferred stages, non-clickable funnel, drill-downs, StrictMode, request races, auth/offline and cleanup passed.');

  // Exercise actual EventsPage hook wiring: latest selection owns editable form.
  const pageHarness=harness();const reads=[];
  const supabase={from:table=>{
    const request={table,filters:[]}; let resolve;
    const promise=new Promise(r=>resolve=r);
    const query={select(){return query;},eq(key,value){request.filters.push([key,value]);return query;},order(){reads.push({...request,resolve});return promise;},maybeSingle(){reads.push({...request,resolve});return promise;}};
    return query;
  }};
  const page=load('src/EventsPage.tsx',{...common,react:pageHarness.react,'./supabaseClient':{supabase},'./EventOverview':{default:'overview'},'./utils/dateFormat':{formatDateShort:value=>value}}, {window:{innerWidth:1200,addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout});
  const event=id=>({id,event_code:id,name:`Event ${id}`,status:'ACTIVE',start_date:null,end_date:null,description:null,location:null,whatsapp_template_id:'t',whatsapp_template_name:'template',whatsapp_image_url:null,lead_count:1});
  const pageRender=()=>pageHarness.render(page.default,{});
  pageRender();assert.equal(reads.length,1);reads.shift().resolve({data:[event('A'),event('B')],error:null});await tick();
  const choose=id=>{ const tree=pageRender();const button=nodes(tree).find(n=>n.type==='button'&&text(n).includes(`Event ${id}`));assert.ok(button);button.props.onClick(); };
  choose('A');choose('B');assert.equal(reads.length,2);const first=reads.shift(),second=reads.shift();second.resolve({data:event('B'),error:null});await tick();first.resolve({data:event('A'),error:null});await tick();
  tree=pageRender();assert.ok(nodes(tree).some(n=>n.type==='input'&&n.props.value==='Event B'));assert.ok(!nodes(tree).some(n=>n.type==='input'&&n.props.value==='Event A'));
  choose('A');reads.shift().resolve({data:null,error:{}});await tick();tree=pageRender();assert.ok(text(tree).includes('details could not be loaded'));assert.equal(nodes(tree).filter(n=>n.type==='input'&&n.props.value==='Event B').length,0);
  pageHarness.cleanup();
  console.log('Events page: no duplicate initial fetch, out-of-order detail responses rejected, failure has no partial-record fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
