import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSelection,stepSelection} from '../extension/model.js';
import {createController} from '../extension/controller.js';
import {PreviewCache} from '../extension/previews.js';
const tab=(id,windowId=1,active=false)=>({id,windowId,active,index:id,lastAccessed:999999-id,title:`Tab ${id}`,url:`https://test.invalid/${id}`});
const saved=ids=>({viewedTabsV2:{version:2,ids}});
function mock(initial,store={},focused=1){
  let tabs=structuredClone(initial),storage=structuredClone(store);
  const state={focused,updates:[],get tabs(){return tabs;},set tabs(value){tabs=value;},get storage(){return storage;}};
  state.api={runtime:{getURL:path=>'chrome-extension://test/'+path},storage:{session:{get:async()=>structuredClone(storage),set:async value=>{Object.assign(storage,structuredClone(value));},remove:async key=>{delete storage[key];}}},
    windows:{getLastFocused:async()=>({id:state.focused??-1,focused:state.focused!==null,state:'normal'})},
    tabs:{query:async()=>structuredClone(tabs),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return {...t};},update:async id=>{const t=await state.api.tabs.get(id);tabs.forEach(v=>{if(v.windowId===t.windowId)v.active=v.id===id;});state.updates.push(id);}}};
  state.show=id=>{const t=tabs.find(t=>t.id===id);state.focused=t.windowId;tabs.forEach(v=>{if(v.windowId===t.windowId)v.active=v.id===id;});};
  return state;
}
const ids=tabs=>tabs.map(t=>t.id);

test('first seed uses only focused current tab; V1/lastAccessed never migrates unseen tabs',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3,2,true)],{mruV1:{1:[2,1],2:[3]}});
  const c=createController(m.api);
  assert.deepEqual(ids(await c.list(1)),[1]);assert.deepEqual(await c.list(2),[]);
  assert.equal(m.storage.mruV1,undefined);assert.deepEqual(m.storage.viewedTabsV2,{version:2,ids:[1]});
});
test('background creation and activation in unfocused window do not mark viewed',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3,2,true)]);const c=createController(m.api);
  await c.list(1);m.tabs.push(tab(4));await c.changed();
  await c.changed({type:'observe'});
  assert.deepEqual(ids(await c.list(1)),[1]);assert.deepEqual(await c.list(2),[]);
  m.focused=2;await c.observe();assert.deepEqual(ids(await c.list(2)),[3]);
});
test('zero history, no focused window, and empty list keyboard behavior are safe',async()=>{
  const m=mock([tab(1,1,true)],{},null);const c=createController(m.api);
  assert.deepEqual(await c.list(1),[]);m.focused=1;
  assert.deepEqual(await c.list(1),[]); // Read operations do not invent a visit.
  await c.observe();assert.deepEqual(ids(await c.list(1)),[1]);
  assert.equal(nextSelection([],null,false),null);assert.equal(stepSelection([],null,1),null);
});
test('empty V2 state stays empty across restart; initial current tab is not repeatedly seeded',async()=>{
  const m=mock([tab(1,1,true)],saved([]));assert.deepEqual(await createController(m.api).list(1),[]);
});
test('no remaining Chrome windows initializes an empty history safely',async()=>{
  const m=mock([],{},null);m.api.windows.getLastFocused=async()=>{throw Error('No window');};
  assert.deepEqual(await createController(m.api).list(1),[]);
  assert.deepEqual(m.storage.viewedTabsV2,{version:2,ids:[]});
});
test('only recent eight viewed tabs per window, excluded own fallback and duplicate IDs',async()=>{
  const tabs=Array.from({length:12},(_,i)=>tab(i+1,1,i===11));tabs.push(tab(20,2,true),{...tab(30,3,true),url:'chrome-extension://test/switcher.html?session=x'});
  const m=mock(tabs,saved([12,11,10,9,8,7,6,5,4,3,2,1,20,30,12]));const c=createController(m.api);
  assert.deepEqual(ids(await c.list(1)),[12,11,10,9,8,7,6,5]);assert.deepEqual(ids(await c.list(2)),[20]);assert.deepEqual(await c.list(3),[]);
});
test('selection starts at previous, preserves choice and wraps without actual activation',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3)],saved([1,2,3]));const c=createController(m.api);
  const tabs=await c.list(1),before=structuredClone(m.storage);
  assert.equal(nextSelection(tabs,null,false),2);assert.equal(nextSelection(tabs,3,true),3);
  assert.equal(stepSelection(tabs,1,-1),3);assert.equal(stepSelection(tabs,3,1),1);
  assert.equal(nextSelection([tab(1,1,true)],null,false),1);
  assert.deepEqual(m.storage,before);assert.deepEqual(m.updates,[]);
});
test('image expiration never removes a viewed tab or prevents activation',async()=>{
  let now=0;const cache=new PreviewCache({now:()=>now,ttl:100});cache.put(2,'https://test.invalid/2','image');
  const m=mock([tab(1,1,true),tab(2)],saved([1,2]));const c=createController(m.api);
  now=101;assert.equal(cache.get(2,'https://test.invalid/2'),null);
  assert.deepEqual(ids(await c.list(1)),[1,2]);await c.activate(1,2);assert.deepEqual(m.updates,[2]);
});
test('closed tabs pruned, moved viewed tabs retain identity only in target window, replacement inherits view',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3),tab(8,2,true)],saved([1,2,3]));const c=createController(m.api);
  await c.list(1);m.tabs=m.tabs.filter(t=>t.id!==3);m.tabs.find(t=>t.id===2).windowId=2;await c.changed();
  assert.deepEqual(ids(await c.list(1)),[1]);assert.deepEqual(ids(await c.list(2)),[2]);
  m.tabs.find(t=>t.id===2).id=9;await c.changed({type:'replace',removedId:2,addedId:9});
  assert.deepEqual(ids(await c.list(2)),[9]);
});
test('unseen, closed and moved commit targets fail safely; queue recovers',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3),tab(8,2,true)],saved([1,2,8]));const c=createController(m.api);
  await assert.rejects(c.activate(1,3),/閲覧履歴/);await assert.rejects(c.activate(1,99));await assert.rejects(c.activate(1,8),/別のウインドウ/);
  assert.deepEqual(m.updates,[]);await c.activate(1,2);assert.deepEqual(m.updates,[2]);
});
test('rapid commits serialize and V2 history survives worker recreation',async()=>{
  const m=mock([tab(1,1,true),tab(2),tab(3)],saved([1,2,3]));const c=createController(m.api);
  await Promise.all([2,3,1,2,3].map(id=>c.activate(1,id)));
  assert.deepEqual(m.updates,[2,3,1,2,3]);assert.deepEqual(ids(await createController(m.api).list(1)),[3,2,1]);
});
test('late observe reads actual focused active state rather than blindly trusting old tab event',async()=>{
  const m=mock([tab(1),tab(2),tab(3,1,true)],saved([1]));const c=createController(m.api);
  await c.changed({type:'observe',tabId:2,windowId:1});assert.deepEqual(ids(await c.list(1)),[3,1]);
});
