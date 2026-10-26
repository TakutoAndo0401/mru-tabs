import { promote } from './model.js';

// V1 mixed every open tab into MRU. V2 contains only positively observed tab IDs.
const KEY = 'viewedTabsV2';
export function createController(api) {
  let viewed = [], loaded = false, tail = Promise.resolve();
  const serialize = work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  async function focusedTab(tabs) {
    const window = await api.windows.getLastFocused({}).catch(() => null);
    // "Last focused" alone is insufficient when Chrome is behind another app.
    if (!window?.focused || window.state === 'minimized') return undefined;
    return tabs.find(tab => tab.windowId === window.id && tab.active);
  }
  async function refresh(event) {
    let seed = false;
    if (!loaded) {
      const saved = (await api.storage.session.get(KEY))[KEY];
      const valid = saved?.version === 2 && Array.isArray(saved.ids);
      viewed = valid ? [...new Set(saved.ids.filter(Number.isInteger))] : [];
      seed = !valid;
      loaded = true;
      // Do not infer visits from V1 order or lastAccessed, even on upgrade.
      await api.storage.session.remove?.('mruV1');
    }
    if (event?.type === 'replace') viewed = viewed.map(id => id === event.removedId ? event.addedId : id);
    const tabs = (await api.tabs.query({})).filter(tab => !tab.url?.startsWith(api.runtime?.getURL('switcher.html') || '\0'));
    const live = new Set(tabs.map(tab => tab.id));
    viewed = [...new Set(viewed)].filter(id => live.has(id));
    if (seed || event?.type === 'observe') {
      const tab = await focusedTab(tabs);
      if (tab) viewed = promote(viewed, tab.id);
    }
    await api.storage.session.set({ [KEY]: { version: 2, ids: viewed } });
    return tabs;
  }
  function list(windowId) {
    return serialize(async () => {
      const tabs = await refresh();
      const byId = new Map(tabs.filter(tab => tab.windowId === windowId).map(tab => [tab.id, tab]));
      return viewed.filter(id => byId.has(id)).slice(0, 8).map(id => {
        const tab = byId.get(id);
        return { id, title: tab.title || '無題のタブ', url: tab.url || '', active: tab.active };
      });
    });
  }
  function activate(windowId, tabId) {
    return serialize(async () => {
      await refresh();
      const tab = await api.tabs.get(tabId);
      if (tab.windowId !== windowId) throw new Error('タブが別のウインドウに移動しました。');
      if (!viewed.includes(tabId)) throw new Error('閲覧履歴にないタブです。選び直してください。');
      await api.tabs.update(tabId, { active: true });
      await refresh({ type: 'observe' });
    });
  }
  return { list, activate, changed: event => serialize(() => refresh(event)), observe: () => serialize(() => refresh({ type: 'observe' })) };
}
