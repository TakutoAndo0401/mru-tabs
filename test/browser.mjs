import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {launch,evaluate} from './cdp.mjs';

const server=createServer((req,res)=>{
  const name=req.url.slice(1)||'メモ';
  res.setHeader('Content-Type','text/html;charset=utf-8');
  if(name==='csp')res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'none'; script-src 'none'");
  const title=name==='unsafe'?'&lt;img src=x onerror=alert(1)&gt;':'作業 '+name;
  res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>${title}</title><style>
  body{margin:0;background:#edf2fa;font:16px -apple-system,sans-serif;color:#1c3151}nav{height:75px;background:#183050;color:white;display:flex;align-items:center;padding:0 50px;font-size:23px}main{padding:38px 70px}h1{font-size:34px}.grid{display:flex;gap:22px}.box{background:white;padding:25px;border-radius:14px;flex:1;box-shadow:0 8px 20px #18305010}.metric{font-size:38px;color:#276b9e}.bar{height:14px;background:#a4c7ea;border-radius:8px;margin:17px 0}</style>
  <nav>WORKSPACE　/　${name}</nav><main><p>2026 / WEEK 43</p><h1>${name==='design'?'デザインの進捗':name==='notes'?'チームの作業メモ':'プロジェクト一覧'}</h1><div class="grid"><div class="box"><p>今週のタスク</p><div class="metric">24</div><div class="bar"></div><p>レビューと次のアクションを確認</p></div><div class="box"><p>進行中のプロジェクト</p><div class="metric">08</div><div class="bar"></div><p>次のマイルストーンに向けて</p></div><div class="box"><p>メンバー</p><div class="metric">12</div><div class="bar"></div><p>共有済みの更新をチェック</p></div></div></main></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
await mkdir(resolve('evidence'),{recursive:true});
const browser=await launch();
const report={version:'0.3.0',checks:[],limits:[],browser:null,shortcut:null};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<120;i++){const result=await fn();if(result)return result;await delay(50);}throw Error('Waiting for browser state timed out');}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS',name);}
async function attach(targetId){return(await browser.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;}
const targets=async()=> (await browser.send('Target.getTargets',{filter:[{}]})).targetInfos;
function walk(node){return [node,...[...(node.children||[]),...(node.shadowRoots||[]),...(node.contentDocument?[node.contentDocument]:[])].flatMap(walk)];}
let pageSession,workerSession,worker;
const run=expression=>evaluate(browser,workerSession,expression);
async function dialogNode(){const {root}=await browser.send('DOM.getDocument',{depth:-1,pierce:true},pageSession);return walk(root).find(n=>n.nodeName==='DIALOG' && n.attributes?.includes('open'));}
async function ui(expression){
  const node=await dialogNode();assert.ok(node,'Open dialog exists');
  const {object}=await browser.send('DOM.resolveNode',{nodeId:node.nodeId},pageSession);
  const result=await browser.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){const dialog=this;const list=dialog.querySelector('.cards');return (${expression});}`,returnByValue:true,awaitPromise:true},pageSession);
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
}
const selected=()=>ui('Number(list.querySelector("[aria-selected=true]")?.dataset.id)');
async function key(key,modifiers=0){const code=key;await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:({Tab:9,Enter:13,Escape:27,ArrowRight:39,ArrowLeft:37,ArrowDown:40,ArrowUp:38})[key]},pageSession);await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers},pageSession).catch(()=>{});}
let id,windowId;
async function invoke(tabId){
  const tab=await run(`chrome.tabs.get(${tabId})`);
  await run(`chrome.tabs.update(${tabId},{active:true})`);
  await run(`chrome.windows.update(${tab.windowId},{focused:true})`);
  const target=await until(async()=> (await targets()).find(t=>t.type==='tab' && t.url===tab.url));
  await browser.send('Extensions.triggerAction',{id,targetId:target.targetId});
}
async function open(tabId){
  await invoke(tabId);
  const tab=await run(`chrome.tabs.get(${tabId})`);
  const page=(await targets()).find(t=>t.type==='page'&&t.url===tab.url);
  pageSession=await attach(page.targetId);
  await until(async()=>!!await dialogNode());
  await until(()=>ui('list.querySelectorAll(".card").length>0'));
}
async function cancelled(){await key('Escape');await until(async()=>!await dialogNode());}
const active=()=>run(`chrome.tabs.query({windowId:${windowId},active:true}).then(t=>t[0]?.id)`);
try{
  report.browser=await browser.send('Browser.getVersion');
  // Verify invalid shortcut with real Chrome extension loader, in this throwaway profile only.
  await check('MacCtrl+Tab is unassigned; Ctrl+Tab maps to Command+Tab on Mac',async()=>{
    for(const [name,key] of [['Ctrl+Tab','Ctrl+Tab'],['MacCtrl+Tab','MacCtrl+Tab']]){
      const path=await mkdtemp(join(tmpdir(),'mru-invalid-shortcut-'));
      try{
        await writeFile(join(path,'manifest.json'),JSON.stringify({manifest_version:3,name:'Shortcut validation only',version:'1',background:{service_worker:'worker.js'},commands:{test:{description:'test',suggested_key:name==='Ctrl+Tab'?key:{mac:key}}}}));
        await writeFile(join(path,'worker.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
        let error, commands;
        try {
          const probe=await browser.send('Extensions.loadUnpacked',{path});
          const worker=await until(async()=> (await targets()).find(t=>t.type==='service_worker' && t.url===`chrome-extension://${probe.id}/worker.js`));
          const session=await attach(worker.targetId);
          await until(()=>evaluate(browser,session,'typeof chrome!=="undefined" && !!chrome.commands'));
          commands=await evaluate(browser,session,'chrome.commands.getAll()');
          await browser.send('Extensions.uninstall',{id:probe.id});
        } catch(e) {error=e.message;}
        report.limits.push({shortcut:name,error,commands});
        assert.ok(error || (name==='MacCtrl+Tab' ? commands.every(c=>!c.shortcut) : commands.every(c=>c.shortcut==='⌘⇥')));console.log('Shortcut probe',name,JSON.stringify({error,commands}));
      }finally{await rm(path,{recursive:true,force:true});}
    }
  });
  ({id}=await browser.send('Extensions.loadUnpacked',{path:resolve('extension')}));
  worker=await until(async()=> (await targets()).find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${id}/background.js`));
  workerSession=await attach(worker.targetId);
  await browser.send('Runtime.enable',{},workerSession);
  await until(()=>run('typeof chrome!=="undefined" && !!chrome.tabs'));
  const ids=[];
  for(const name of ['notes','design','projects','unsafe']){
    const tab=await run(`chrome.tabs.create({url:${JSON.stringify(base+'/'+name)},active:true})`);ids.push(tab.id);windowId=tab.windowId;
    await until(()=>run(`chrome.tabs.get(${tab.id}).then(t=>t.status==='complete')`));
    const fixturePage=(await targets()).find(t=>t.type==='page' && t.url===base+'/'+name);
    const fixtureSession=await attach(fixturePage.targetId);
    assert.ok((await evaluate(browser,fixtureSession,'document.title')).includes(name==='unsafe'?'<img':'作業'),'HTTP fixture must load');
  }
  const [a,b,c,unsafe]=ids;
  await check('background-only and unfocused active tabs remain unseen until window focus',async()=>{
    const background=await run(`chrome.tabs.create({url:${JSON.stringify(base+'/background')},active:false})`);
    await until(()=>run(`chrome.tabs.get(${background.id}).then(t=>t.status==='complete')`));
    const other=await run(`chrome.windows.create({url:${JSON.stringify(base+'/unfocused')},focused:false})`);
    const hidden=other.tabs[0].id;
    await until(()=>run(`chrome.tabs.get(${hidden}).then(t=>t.status==='complete')`));
    assert.equal(await run(`chrome.windows.get(${other.id}).then(w=>w.focused)`),false);
    const history=await run('chrome.storage.session.get("viewedTabsV2").then(s=>s.viewedTabsV2.ids)');
    assert.ok(!history.includes(background.id));assert.ok(!history.includes(hidden));
    await run(`chrome.windows.update(${other.id},{focused:true})`);
    await until(()=>run(`chrome.storage.session.get("viewedTabsV2").then(s=>s.viewedTabsV2.ids.includes(${hidden}))`));
    await run(`chrome.windows.update(${windowId},{focused:true})`);
    await open(a);
    assert.equal(await ui(`!!list.querySelector('[data-id="${background.id}"]')`),false);
    assert.equal(await ui(`!!list.querySelector('[data-id="${hidden}"]')`),false);
    await cancelled();await delay(650);await run(`chrome.tabs.remove(${background.id})`);await run(`chrome.windows.remove(${other.id})`);
  });
  await check('only one command remains; Mac Control+Q registered',async()=>{
    const manifest=await run('chrome.runtime.getManifest()');
    assert.equal(manifest.commands._execute_action.suggested_key.default,'Ctrl+Shift+Y');
    assert.equal(manifest.commands._execute_action.suggested_key.mac,'MacCtrl+Q');
    assert.deepEqual(manifest.permissions,['tabs','storage','activeTab','scripting']);
    const commands=await run('chrome.commands.getAll()');assert.equal(commands.length,1);assert.equal(commands[0].name,'_execute_action');report.shortcut=commands[0].shortcut;assert.equal(report.shortcut,'⌃Q');
  });
  await check('normal HTTP page opens centered horizontal overlay, captures only invoked visible tab',async()=>{
    await open(a);assert.notEqual(await selected(),a);
    const geometry=await ui('({rect:dialog.getBoundingClientRect().toJSON(),w:innerWidth,h:innerHeight,display:getComputedStyle(list).display,overflow:getComputedStyle(list).overflowX})');
    assert.ok(Math.abs(geometry.rect.x+geometry.rect.width/2-geometry.w/2)<2);
    assert.ok(Math.abs(geometry.rect.y+geometry.rect.height/2-geometry.h/2)<2);
    assert.equal(geometry.display,'flex');assert.equal(geometry.overflow,'auto');
    assert.equal(await ui('list.querySelectorAll("img").length'),1);
    assert.equal(await active(),a);
    assert.equal(await evaluate(browser,pageSession,'document.querySelector("mru-tab-switcher").shadowRoot'),null);
    await cancelled();
  });
  // Build real thumbnails by explicit action on each fixture; no automatic background-tab switching.
  await open(b);await cancelled();await delay(650);
  await open(c);await cancelled();await delay(650);
  await open(b);
  await check('MRU initial previous selection, three retained thumbnails and honest missing preview',async()=>{
    assert.equal(await selected(),c);
    assert.equal(await ui('Number(list.firstElementChild.dataset.id)'),b);
    assert.equal(await ui('list.querySelectorAll("img").length'),3);
    assert.ok(await ui('list.querySelectorAll(".placeholder").length>=1'));
    assert.match(await ui('list.textContent'),/<img src=x/);
    assert.equal(await ui('list.querySelectorAll(".title img").length'),0);
  });
  await check('Tab, Shift+Tab and arrows never switch actual tabs; screenshot',async()=>{
    const before=await run('chrome.storage.session.get("viewedTabsV2")');
    await key('Tab');assert.equal(await selected(),a);await key('Tab',8);assert.equal(await selected(),c);
    await key('ArrowRight');assert.equal(await selected(),a);await key('ArrowLeft');assert.equal(await selected(),c);
    await key('ArrowDown');await key('ArrowUp');assert.equal(await selected(),c);
    assert.equal(await active(),b);assert.deepEqual(await run('chrome.storage.session.get("viewedTabsV2")'),before);
    for(const scheme of ['dark','light']) {
      await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]},pageSession);
      const {data}=await browser.send('Page.captureScreenshot',{format:'png'},pageSession);
      await writeFile(resolve(`evidence/overlay-${scheme}.png`),Buffer.from(data,'base64'));
      if(scheme==='dark')await writeFile(resolve('evidence/overlay.png'),Buffer.from(data,'base64'));
    }
    report.geometry=await ui('({rect:dialog.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight})');
  });
  await check('Escape, close button, outside click and repeated action cancel safely',async()=>{
    await cancelled();assert.equal(await active(),b);
    await open(b);await ui('dialog.querySelector("button").click()');await until(async()=>!await dialogNode());
    await open(b);
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:2,y:2,button:'left',clickCount:1},pageSession);
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:2,y:2,button:'left',clickCount:1},pageSession);
    await until(async()=>!await dialogNode());
    await open(b);await invoke(b);await until(async()=>!await dialogNode());assert.equal(await active(),b);
  });
  await check('Enter commits once under rapid repeat; click commits',async()=>{
    await open(b);const target=await selected();
    await Promise.all([key('Enter'),key('Enter')]);await until(async()=>await active()===target);
    await open(target);const clicked=await selected();await ui('list.querySelector("[aria-selected=true]").click()');
    await until(async()=>await active()===clicked);
  });
  await check('live tab closure and move reselect safely, multiple windows isolated',async()=>{
    await open(b);assert.equal(await selected(),c);
    await run(`chrome.tabs.remove(${c})`);await until(async()=>await selected()!==c);
    const other=await run('chrome.windows.create({url:"about:blank",focused:false})');
    await run(`chrome.tabs.move(${a},{windowId:${other.id},index:-1})`);
    await until(()=>ui(`!list.querySelector('[data-id="${a}"]')`));
    assert.equal(await active(),b);
    assert.ok(!(await ui('[...list.children].map(n=>Number(n.dataset.id))')).includes(other.tabs[0].id));
    await cancelled();await run(`chrome.windows.remove(${other.id})`);
  });
  await check('navigation invalidates old thumbnail, strict page CSP still permits isolated overlay',async()=>{
    await run(`chrome.tabs.update(${b},{url:${JSON.stringify(base+'/csp')}})`);
    await until(()=>run(`chrome.tabs.get(${b}).then(t=>t.status==='complete')`));
    await open(b);assert.equal(await ui('getComputedStyle(list).display'),'flex');await cancelled();
  });
  await check('chrome:// page uses extension window fallback and no restricted-page screenshot',async()=>{
    const tab=await run('chrome.tabs.create({url:"chrome://version",active:true})');
    await until(()=>run(`chrome.tabs.get(${tab.id}).then(t=>t.status==='complete')`));
    await invoke(tab.id);
    const fallback=await until(async()=> (await targets()).find(t=>t.type==='page'&&t.url.startsWith(`chrome-extension://${id}/switcher.html?`)));
    pageSession=await attach(fallback.targetId);await until(async()=>!!await dialogNode());await until(()=>ui('list.children.length>0'));
    assert.equal(await ui('dialog.classList.contains("fallback")'),true);
    assert.match(await ui('dialog.querySelector(".subtitle").textContent'),/別ウインドウ/);
    assert.equal(await ui(`list.querySelector('[data-id="${tab.id}"] img')`),null);
    await delay(250);
    report.fallbackGeometry = await evaluate(browser,pageSession,'chrome.windows.getCurrent().then(window=>({window,viewport:{width:innerWidth,height:innerHeight}}))');
    assert.ok(report.fallbackGeometry.window.width<=1120 && report.fallbackGeometry.window.height<=450);
    const {data}=await browser.send('Page.captureScreenshot',{format:'png'},pageSession);await writeFile(resolve('evidence/restricted-fallback.png'),Buffer.from(data,'base64'));
    await key('Escape');await until(async()=>!(await targets()).some(t=>t.targetId===fallback.targetId));
    assert.equal(await active(),tab.id);await run(`chrome.tabs.remove(${tab.id})`);
  });
  await check('worker restart preserves MRU but forgets volatile previews; single tab safe',async()=>{
    await run(`chrome.tabs.update(${b},{active:true})`);
    const historyBefore=await run('chrome.storage.session.get("viewedTabsV2")');
    const target=(await targets()).find(t=>t.type==='page'&&t.url===base+'/csp');const session=await attach(target.targetId);
    await browser.send('ServiceWorker.enable',{},session);
    const version=await until(async()=>browser.events.filter(e=>e.method==='ServiceWorker.workerVersionUpdated').flatMap(e=>e.params.versions).find(v=>v.scriptURL===`chrome-extension://${id}/background.js`&&v.runningStatus==='running'));
    await browser.send('Target.detachFromTarget',{sessionId:workerSession});await browser.send('ServiceWorker.stopWorker',{versionId:version.versionId},session);
    await until(async()=>!(await targets()).some(t=>t.targetId===worker.targetId));
    // Trigger action using known tab target, without accessing a stopped worker.
    const tabTarget=(await targets()).find(t=>t.type==='tab'&&t.url===base+'/csp');
    await browser.send('Extensions.triggerAction',{id,targetId:tabTarget.targetId});
    worker=await until(async()=> (await targets()).find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${id}/background.js`));workerSession=await attach(worker.targetId);
    await until(()=>run('typeof chrome!=="undefined" && !!chrome.tabs'));
    pageSession=await attach(target.targetId);await until(async()=>!!await dialogNode());await until(()=>ui('list.children.length>0'));
    assert.deepEqual(await run('chrome.storage.session.get("viewedTabsV2")'),historyBefore);
    assert.equal(await ui('list.querySelectorAll("img").length'),1); // current newly captured; others forgotten
    await cancelled();
    await run(`chrome.tabs.query({windowId:${windowId}}).then(t=>chrome.tabs.remove(t.filter(t=>t.id!==${b}).map(t=>t.id)))`);
    await open(b);assert.equal(await ui('list.children.length'),1);assert.equal(await selected(),b);
    await key('Tab');await key('Tab',8);assert.equal(await selected(),b);await cancelled();
  });
  await check('host tab activation elsewhere closes overlay; no stale backdrop',async()=>{
    const other=await run(`chrome.tabs.create({url:${JSON.stringify(base+'/last')},active:false})`);
    await open(b);await run(`chrome.tabs.update(${other.id},{active:true})`);
    await until(async()=>!await dialogNode());
    assert.equal(await evaluate(browser,pageSession,'document.querySelectorAll("mru-tab-switcher").length'),0);
  });
  await check('only eight most recent viewed tabs shown, with title-only cards still selectable',async()=>{
    const generated=[];
    for(let i=0;i<10;i++) {
      const tab=await run(`chrome.tabs.create({url:${JSON.stringify(base+'/recent-')}+${i},active:true})`);generated.push(tab.id);
      await until(()=>run(`chrome.storage.session.get("viewedTabsV2").then(s=>s.viewedTabsV2.ids[0]===${tab.id})`));
    }
    const last=generated.at(-1);await open(last);
    assert.equal(await ui('list.children.length'),8);
    assert.deepEqual(await ui('[...list.children].map(n=>Number(n.dataset.id))'),generated.slice(-8).reverse());
    const previous=generated.at(-2);
    assert.equal(await ui(`!!list.querySelector('[data-id="${previous}"] img')`),false);
    await ui(`list.querySelector('[data-id="${previous}"]').click()`);
    await until(()=>run(`chrome.tabs.get(${previous}).then(t=>t.active)`));
    await run(`chrome.tabs.remove(${JSON.stringify(generated)})`);
  });

}finally{
  await writeFile(resolve('evidence/browser-report.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();server.close();
}
