import { createController } from './controller.js';
import { PreviewCache, thumbnail } from './previews.js';
const controller = createController(chrome);
const previews = new PreviewCache();
const sessions = new Map();
const activationEpoch = new Map();
let actionTail = Promise.resolve(), lastCapture = 0;
const warn = error => console.warn('MRU:', error.message);

async function end(token) {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  if (session.fallbackWindow) await chrome.windows.remove(session.fallbackWindow).catch(() => {});
  else await chrome.tabs.sendMessage(session.tabId, {type:'mru:end',token}).catch(() => {});
}
async function notify() {
  for (const [token,s] of sessions) {
    if (Date.now() - s.created > 120_000) { await end(token); continue; }
    const message = {type:'mru:changed',token};
    if (s.fallbackWindow) chrome.runtime.sendMessage(message).catch(() => {});
    else chrome.tabs.sendMessage(s.tabId,message).catch(() => {});
  }
}
function changed(event) { controller.changed(event).then(notify).catch(warn); }

async function capture(tab) {
  // Only the user-invoked, currently visible HTTP(S) tab. Never visit background tabs.
  if (!/^https?:/.test(tab.url || '') || tab.incognito || Date.now()-lastCapture < 600) return;
  lastCapture = Date.now();
  const epoch = activationEpoch.get(tab.windowId);
  try {
    const before = (await chrome.tabs.query({windowId:tab.windowId,active:true}))[0];
    if (before?.id !== tab.id || before.url !== tab.url) return;
    const data = await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:50});
    const after = await chrome.tabs.get(tab.id);
    if (!after.active || after.windowId !== tab.windowId || after.url !== tab.url || activationEpoch.get(tab.windowId) !== epoch) return;
    const image = await thumbnail(data);
    if (image) {
      previews.put(tab.id,tab.url,image);
      setTimeout(()=>previews.prune(),120_001);
    }
  } catch { /* Missing grant, rate limit or protected image: use placeholder. */ }
}
async function toggle(tab) {
  if (!Number.isInteger(tab?.id)) return;
  const existing = [...sessions].find(([,s]) => s.windowId===tab.windowId || s.fallbackWindow===tab.windowId);
  if (existing) { await end(existing[0]); return; }
  await controller.observe();
  await capture(tab);
  const current = await chrome.tabs.get(tab.id);
  if (!current.active || current.windowId!==tab.windowId || current.url!==tab.url) return;
  const token = crypto.randomUUID();
  const session = {tabId:tab.id,windowId:tab.windowId,created:Date.now()};
  sessions.set(token,session);
  try {
    if (!/^https?:/.test(tab.url || '')) throw Error('Restricted scheme');
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['view.js','overlay.js']});
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:token=>globalThis.mountMruOverlay(token),args:[token]});
  } catch {
    const origin = await chrome.windows.get(tab.windowId);
    const width = Math.min(1120,origin.width), height = Math.min(450,origin.height);
    const win = await chrome.windows.create({type:'popup',url:chrome.runtime.getURL(`switcher.html?session=${token}`),
      width,height,left:Math.round(origin.left+(origin.width-width)/2),top:Math.round(origin.top+(origin.height-height)/2),focused:true});
    session.fallbackWindow = win.id;
    // Some window managers/headless configurations override initial creation bounds.
    await chrome.windows.update(win.id,{width,height,left:Math.round(origin.left+(origin.width-width)/2),top:Math.round(origin.top+(origin.height-height)/2)});
  }
}
chrome.action.onClicked.addListener(tab => {
  actionTail = actionTail.catch(()=>{}).then(()=>toggle(tab)).catch(warn);
});
chrome.tabs.onActivated.addListener(info => {
  activationEpoch.set(info.windowId,(activationEpoch.get(info.windowId)||0)+1);
  for (const [token,s] of sessions) if(s.windowId===info.windowId && s.tabId!==info.tabId) end(token).catch(warn);
  changed({type:'observe'});
});
// Focus is observed independently of tab activation (including switching windows/apps).
chrome.windows.onFocusChanged.addListener(()=>changed({type:'observe'}));
chrome.tabs.onCreated.addListener(()=>changed());
chrome.tabs.onRemoved.addListener(id => {
  previews.delete(id);
  for (const [token,s] of sessions) if(s.tabId===id) end(token).catch(warn);
  changed();
});
chrome.tabs.onAttached.addListener(()=>changed());
chrome.tabs.onDetached.addListener(id => {
  previews.delete(id);
  for (const [token,s] of sessions) if(s.tabId===id) end(token).catch(warn);
  changed();
});
chrome.tabs.onReplaced.addListener((addedId,removedId)=>{
  previews.delete(removedId);
  for (const [token,s] of sessions) if(s.tabId===removedId) end(token).catch(warn);
  changed({type:'replace',addedId,removedId});
});
chrome.tabs.onUpdated.addListener((id,info)=>{
  if(info.url || info.status==='loading') {
    previews.delete(id);
    for (const [token,s] of sessions) if(s.tabId===id) end(token).catch(warn);
  }
  if(info.title || info.url) notify().catch(warn);
});
chrome.windows.onRemoved.addListener(id=>{
  activationEpoch.delete(id);
  for (const [token,s] of sessions) if(s.windowId===id || s.fallbackWindow===id) end(token).catch(warn);
  changed();
});
chrome.runtime.onInstalled.addListener(()=>changed());
chrome.runtime.onStartup.addListener(()=>changed());
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || !message?.type?.startsWith('mru:')) return;
  const session=sessions.get(message.token);
  const fallback=sender.url===chrome.runtime.getURL(`switcher.html?session=${message.token}`);
  if(!session || (!fallback && (sender.tab?.id!==session.tabId || sender.frameId!==0))) {
    respond({ok:false,error:'一覧の有効期限が切れました。開き直してください。'}); return;
  }
  if(message.type==='mru:close') { respond({ok:true}); end(message.token).catch(warn); return; }
  (async()=>{
    const origin=await chrome.tabs.get(session.tabId);
    if(origin.windowId!==session.windowId) throw Error('元のタブが移動しました。');
    if(message.type==='mru:list') {
      const tabs=await controller.list(session.windowId);
      const commands=await chrome.commands.getAll();
      return {ok:true,tabs:tabs.map(tab=>({...tab,preview:previews.get(tab.id,tab.url)})),
        shortcut:commands.find(c=>c.name==='_execute_action')?.shortcut || '未割当',fallback};
    }
    if(message.type==='mru:activate' && Number.isInteger(message.tabId)) {
      await controller.activate(session.windowId,message.tabId);
      await chrome.windows.update(session.windowId,{focused:true});
      await end(message.token); return {ok:true};
    }
    throw Error('不明な操作です。');
  })().then(respond,error=>respond({ok:false,error:error.message}));
  return true;
});
