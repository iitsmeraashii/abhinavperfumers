// Real Chromium IndexedDB transactions; isolated profile/origin, no application backend.
// Uses an existing Playwright installation and Chrome; installs no dependencies.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
(async () => {
  const built = await esbuild.build({stdin:{contents:"import * as db from './src/capture/db'; window.testDb = db;",resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    const page = await browser.newPage();
    await page.route('https://sync-display.test/**', route => route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    await page.goto('https://sync-display.test/');
    await page.addScriptTag({content:built.outputFiles[0].text});
    const results = await page.evaluate(async () => {
      const api = window.testDb, db = await api.openDB();
      const results = []; let notifications = 0;
      const off = api.subscribePendingOps(() => notifications++);
      const check = (name, condition) => { if (!condition) throw new Error(name); results.push(name); };
      const transaction = (stores, work) => new Promise((resolve,reject) => {
        const tx = db.transaction(stores,'readwrite');
        tx.oncomplete = () => resolve('committed');
        tx.onabort = () => resolve('aborted');
        tx.onerror = () => {}; // abort handler verifies the final outcome
        try {work(tx);} catch(e) {reject(e);}
      });
      const row = {id:'a',ownerId:'owner',sessionId:'s'};
      let outcome = await transaction(['pending_ops'],tx=>tx.objectStore('pending_ops').put(row));
      check('successful commit notifies once and completion resolves',outcome==='committed' && notifications===1);
      outcome = await transaction(['pending_ops'],tx=>{const req=tx.objectStore('pending_ops').put({...row,id:'aborted'});req.onsuccess=()=>tx.abort();});
      check('abort after request success never notifies',outcome==='aborted' && notifications===1);
      check('aborted write was rolled back',!(await api.dbGetAllByIndexStrict('pending_ops','by_owner','owner')).some(x=>x.id==='aborted'));
      await transaction(['assets'],tx=>tx.objectStore('assets').put({id:'asset'}));
      check('unrelated store does not notify',notifications===1);
      await transaction(['pending_ops','completed_leads'],tx=>{tx.objectStore('pending_ops').put({...row,id:'b'});tx.objectStore('completed_leads').put({id:'lead',ownerId:'owner'});});
      check('multi-store commit notifies once',notifications===2);
      const offThrow = api.subscribePendingOps(()=>{throw new Error('subscriber test');});
      let healthy=0;const offHealthy=api.subscribePendingOps(()=>healthy++);
      outcome=await transaction(['pending_ops'],tx=>tx.objectStore('pending_ops').delete('b'));
      check('throwing subscriber does not block other subscriber or completion',healthy===1 && notifications===3 && outcome==='committed');
      await transaction(['pending_ops'],tx=>{tx.objectStore('pending_ops').put({...row,id:'other',ownerId:'other'});});
      const scoped=await api.dbGetAllByIndexStrict('pending_ops','by_owner','owner');
      check('real existing owner index excludes other owner',scoped.length===1 && scoped[0].id==='a');
      off();offThrow();offHealthy();
      await transaction(['pending_ops'],tx=>tx.objectStore('pending_ops').delete('a'));
      check('unsubscribe prevents notifications',notifications===4 && healthy===2);
      db.close();return results;
    });
    for(const result of results) console.log('PASS:',result);
    assert.equal(results.length,8);
    console.log('8 real IndexedDB observer checks passed');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
