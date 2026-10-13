// Hot-patch regression: exercise the real promotion payload and shared edit helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-phone-'));
  try {
    const mocks = {
      supabaseClient: `export const supabase={from(table){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:null,error:null}),insert(row){global.phonePayload=row;return q},update(){return q},then(resolve){return Promise.resolve({error:null}).then(resolve)}};return q},rpc:async()=>({error:null})};`,
      captureAuth: `export const getAuthIdentity=async()=>({userId:'test-owner',repCode:'TEST'});`,
      completedLeadsStorage: `export const buildCompletedLead=()=>({});export const saveCompletedLead=async()=>{};`,
    };
    const outfile = path.join(temp, 'test.cjs');
    await esbuild.build({ stdin: { contents: `export {executePromotion} from './src/capture/capturePromotionService';export {phoneForStorage} from './src/capture/normalizePhone';export {splitInternationalPhone} from './src/capture/splitInternationalPhone';export {resolveWhatsAppPhone} from './src/capture/whatsappPhoneResolver';export {searchCountries} from './src/capture/countryData';`, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, a => { const key = path.basename(a.path); if (mocks[key]) return { path: key, namespace: 'mock' }; });
      b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path] }));
    } }] });
    const api = require(outfile);
    let passed = 0;
    const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); passed++; };
    for (const [phone, dialCode, expected] of [
      ['99341118', '+968', '+96899341118'],
      ['9876543210', '+91', '+919876543210'],
      ['+96899341118', '+968', '+96899341118'],
      ['96899341118', '+968', '+96899341118'],
      ['9934 1118', '+968', '+96899341118'],
      ['9934-1118', '+968', '+96899341118'],
      ['(9934) 1118', '+968', '+96899341118'],
      ['0096899341118', '+968', '+96899341118'],
      ['+96899341118', '+91', '+96899341118'],
      ['99341118', undefined, '99341118'],
      ['+96899341118', undefined, '+96899341118'],
      ['', '+968', ''], [null, '+968', ''], [undefined, '+968', ''],
    ]) check(api.phoneForStorage(phone, { dialCode }), expected, `storage ${phone}`);
    for (const captureMethod of ['MANUAL', 'BUSINESS_CARD']) {
      const result = await api.executePromotion({ backendSessionId: 'session', completedLeadId: 'local', captureMethod, eventCode: null, eventId: null, eventName: null,
        draftData: { phone: '99341118', phoneCountryCode: '+968', phoneNumbers: ['+96899341118', '+91 98765 43210', '555-12345'] } });
      check(result.error, null, `${captureMethod} promotion succeeds`);
      check(global.phonePayload.phones, ['+96899341118', '+91 98765 43210', '555-12345'], `${captureMethod} primary and unchanged secondary/dedup`);
    }
    for (const [phone, expected] of [['99341118', ['99341118']], [null, null], ['', null]]) {
      const result = await api.executePromotion({ backendSessionId: 'session', completedLeadId: 'local', captureMethod: 'BUSINESS_CARD', eventCode: null, eventId: null, eventName: null, draftData: { phone } });
      check(result.error, null, 'missing country/empty promotion succeeds');
      check(global.phonePayload.phones, expected, 'unresolved primary preserved; empty stays absent');
    }
    for (const [stored, dialCode, local] of [['+96899341118', '+968', '99341118'], ['+919876543210', '+91', '9876543210']]) {
      check(api.splitInternationalPhone(stored), { dialCode, localNumber: local }, 'edit load');
      check(api.phoneForStorage(local, { dialCode }), stored, 'edit save round trip');
    }
    check(api.phoneForStorage('99342222', { dialCode: '+968' }), '+96899342222', 'edit number');
    check(api.phoneForStorage('99341118', { dialCode: '+977' }), '+97799341118', 'edit country');
    check(api.resolveWhatsAppPhone('+96899341118'), '96899341118', 'WhatsApp canonical');
    check(api.resolveWhatsAppPhone('+96899341118', { selectedDialCode: '+91' }), '96899341118', 'WhatsApp no India prefix');
    for (const query of ['Oman', '+968', '968', 'oman', ' 968 ']) check(api.searchCountries(query).some(c => c.name === 'Oman'), true, `country search ${query}`);
    check(api.searchCountries('India').some(c => c.name === 'India'), true, 'existing name search');
    // Ensure the production edit path consumes the tested helper, not a copied implementation.
    check(fs.readFileSync('src/LeadDetailPage.tsx', 'utf8').includes('phones.push(phoneForStorage(raw, { dialCode: dc }))'), true, 'edit save uses shared helper');
    console.log(`${passed} primary phone checks passed`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); delete global.phonePayload; }
})().catch(e => { console.error(e); process.exitCode = 1; });
