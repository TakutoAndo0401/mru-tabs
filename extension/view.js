// Shared by the isolated-world overlay and restricted-page fallback. No page text is read.
globalThis.createMruView = (root,token,onClose,fallback) => {
  const css = `
    :host { all:initial; color-scheme:dark; }
    * { box-sizing:border-box; }
    dialog { color-scheme:dark; margin:auto; width:min(1120px,calc(100vw - 48px)); max-height:calc(100vh - 40px); overflow:auto; padding:26px; border:1px solid #626262; border-radius:14px; background:#272727; color:#f6f6f6; box-shadow:0 26px 90px #0009; font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans',sans-serif; }
    dialog::backdrop { background:#07121c85; backdrop-filter:blur(7px); }
    dialog.fallback { width:100%; max-height:100vh; height:100vh; border:0; border-radius:0; box-shadow:none; }
    header { display:flex; align-items:flex-start; gap:20px; margin-bottom:20px; }
    .heading { flex:1; } h1 { font:600 19px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans',sans-serif; margin:0 0 4px; letter-spacing:.02em; }
    .subtitle { margin:0; font-size:12px; color:#b5b5b5; }
    button { appearance:none; font:inherit; color:#ddd; border:1px solid #666; background:#383838; border-radius:6px; padding:4px 10px; cursor:pointer; }
    button:hover { background:#505050; } button:focus-visible { outline:2px solid white; }
    .cards { display:flex; gap:12px; padding:5px 5px 13px; overflow-x:auto; overscroll-behavior:contain; outline:none; scrollbar-color:#858585 transparent; }
    .cards:focus-visible { border-radius:8px; outline:1px solid #888; outline-offset:3px; }
    .card { flex:0 0 252px; width:252px; overflow:hidden; border:2px solid transparent; border-radius:8px; padding:8px; background:#333; cursor:pointer; }
    .card:hover { background:#424242; }
    .card[aria-selected=true] { border-color:#f8f8f8; background:#4a4a4a; box-shadow:0 0 0 1px #f8f8f8; }
    .title { display:flex; align-items:center; gap:8px; margin:0 0 9px; font-size:12px; font-weight:500; }
    .tab-icon { display:grid; place-items:center; width:19px; height:19px; border-radius:4px; background:#8ac2ed; color:#162b42; font-size:13px; flex-shrink:0; }
    .title-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .preview { position:relative; height:142px; border-radius:3px; background:#1f1f1f; overflow:hidden; display:grid; place-items:center; }
    img { width:100%; height:100%; object-fit:contain; display:block; }
    .placeholder { text-align:center; color:#aaa; font-size:12px; padding:14px; }
    .placeholder span { display:block; font-size:28px; color:#757575; margin-bottom:7px; }
    .meta { display:flex; gap:8px; margin-top:9px; color:#bbb; font-size:10px; min-height:16px; }
    .domain { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .active { color:#bee0ff; flex-shrink:0; }
    footer { display:flex; justify-content:space-between; gap:14px; margin-top:17px; padding-top:14px; border-top:1px solid #494949; font-size:11px; color:#b9b9b9; }
    .status { margin:9px 0 0; font-size:11px; color:#d2d2d2; min-height:17px; }
    [aria-busy=true] { opacity:.6; }
    @media(max-width:600px) { dialog { padding:18px; width:calc(100vw - 24px); } footer { flex-direction:column; gap:3px; } .card { flex-basis:220px; width:220px; } }
    @media(forced-colors:active) { .card[aria-selected=true] { outline:3px solid Highlight; } }
    @media(prefers-color-scheme:light) {
      dialog { color-scheme:light; background:#eeeeee; color:#222; border-color:#aaa; }
      dialog::backdrop { background:#12223955; }
      .subtitle,footer,.status { color:#555; }
      .card { background:#ddd; } .card:hover { background:#d5d5d5; }
      .card[aria-selected=true] { border-color:#1967b4; background:#d4e3f3; box-shadow:0 0 0 1px #1967b4; }
      .meta,.placeholder { color:#555; } .active { color:#164f81; }
      .preview { background:#ccc; } button { color:#333; background:#ddd; border-color:#aaa; }
      footer { border-color:#bbb; }
    }
  `;
  const sheet=new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets=[sheet];
  const el=(tag,className,text)=>{ const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; };
  const dialog=el('dialog',fallback?'fallback':'');
  dialog.setAttribute('aria-label','最近使ったタブ');
  const header=el('header'), heading=el('div','heading');
  heading.append(el('h1','','最近使ったタブ'),el('p','subtitle',fallback?'このページでは別ウインドウで表示しています':'今のウインドウ · 閲覧済みの直近8件'));
  const closeButton=el('button','','×'); closeButton.setAttribute('aria-label','閉じる');
  header.append(heading,closeButton);
  const list=el('div','cards'); list.tabIndex=0;
  list.setAttribute('role','listbox'); list.setAttribute('aria-label','タブの横並び一覧'); list.setAttribute('aria-orientation','horizontal');
  const footer=el('footer');
  footer.append(el('span','','Tab / ← → 選択　Shift＋Tab 逆順　Enter 決定　Esc 取消'));
  const shortcut=el('span'); footer.append(shortcut);
  const status=el('p','status','読み込み中…'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
  dialog.append(header,list,footer,status); root.append(dialog);
  let tabs=[], selected=null, initialized=false, busy=false, disposed=false;
  let tail=Promise.resolve();
  let imageTimers=[];
  const request=type=>chrome.runtime.sendMessage({type,token});
  function cancel() {
    if(disposed) return;
    request('mru:close').catch(()=>{}); onClose();
  }
  function domain(url) { try {return new URL(url).hostname || '制限ページ';}catch{return 'アドレス未取得';} }
  function mark() {
    for(const card of list.children) card.setAttribute('aria-selected',String(Number(card.dataset.id)===selected));
    const card=[...list.children].find(card=>Number(card.dataset.id)===selected);
    if(card) { list.setAttribute('aria-activedescendant',card.id); card.scrollIntoView({block:'nearest',inline:'nearest'}); }
    else list.removeAttribute('aria-activedescendant');
  }
  function render() {
    for(const timer of imageTimers)clearTimeout(timer);
    imageTimers=[];
    list.replaceChildren();
    for(const tab of tabs) {
      const card=el('div','card'); card.id=`mru-card-${tab.id}`; card.dataset.id=tab.id; card.setAttribute('role','option');
      const title=el('div','title'); title.append(el('span','tab-icon','▣'),el('span','title-text',tab.title));
      const preview=el('div','preview');
      if(tab.preview && Date.now()-tab.preview.at>=120_000)tab.preview=null;
      if(tab.preview) {
        const image=el('img'); image.src=tab.preview.data; image.alt='一覧を開いた時点の保存プレビュー'; preview.append(image);
        imageTimers.push(setTimeout(()=>{if(!disposed){tab.preview=null;render();}},Math.max(1,tab.preview.at+120_000-Date.now())));
      } else {
        const placeholder=el('div','placeholder'); placeholder.append(el('span','','▧'),el('div','','プレビューなし'));
        preview.append(placeholder);
      }
      const meta=el('div','meta'); meta.append(el('span','domain',domain(tab.url)));
      meta.append(el('span',tab.active?'active':'',tab.active?'現在のタブ':tab.preview?'保存プレビュー':''));
      card.append(title,preview,meta);
      card.addEventListener('click',()=>{if(!busy){selected=tab.id;mark();commit();}});
      list.append(card);
    }
    mark();
  }
  function refresh() {
    tail=tail.catch(()=>{}).then(async()=>{
      if(disposed || busy) return;
      const response=await request('mru:list');
      if(disposed || busy) return;
      if(!response?.ok) throw Error(response?.error || '一覧を取得できません。');
      tabs=response.tabs;
      if(!initialized || !tabs.some(tab=>tab.id===selected)) selected=(tabs.find(tab=>!tab.active)||tabs[0])?.id??null;
      initialized=true; render(); shortcut.textContent=`一覧: ${response.shortcut}`;
      status.textContent=!tabs.length?'閲覧済みのタブはまだありません。通常のタブを表示してから開き直してください。':`${tabs.length}件 · 閲覧済みのタブです。プレビューがなくても切り替えできます。`;
    }).catch(error=>{if(!disposed)status.textContent=error.message;});
    return tail;
  }
  async function commit() {
    if(busy || disposed || selected===null) return;
    busy=true; list.setAttribute('aria-busy','true');
    try {
      const response=await chrome.runtime.sendMessage({type:'mru:activate',token,tabId:selected});
      if(!response?.ok)throw Error();
      onClose();
    } catch {
      if(disposed)return;
      busy=false; list.removeAttribute('aria-busy'); await refresh();
      status.textContent='タブが閉じられたか移動しました。選び直してください。'; list.focus();
    }
  }
  function key(event) {
    if(disposed)return;
    if(event.key==='Escape') {event.preventDefault();event.stopImmediatePropagation();cancel();return;}
    if(event.altKey || event.ctrlKey || event.metaKey)return;
    const delta=event.key==='Tab'?(event.shiftKey?-1:1):['ArrowRight','ArrowDown'].includes(event.key)?1:['ArrowLeft','ArrowUp'].includes(event.key)?-1:0;
    if(!delta && event.key!=='Enter')return;
    event.preventDefault();event.stopImmediatePropagation();
    if(delta && !busy && tabs.length) {
      const index=Math.max(0,tabs.findIndex(tab=>tab.id===selected));
      selected=tabs[(index+delta+tabs.length)%tabs.length].id;mark();list.focus();
    } else if(event.key==='Enter')commit();
  }
  const message=msg=>{
    if(msg.token!==token)return;
    if(msg.type==='mru:end')onClose();
    else if(msg.type==='mru:changed')refresh();
  };
  const visibility=()=>{if(document.hidden)cancel();};
  closeButton.addEventListener('click',cancel);
  dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
  dialog.addEventListener('click',event=>{
    const rect=dialog.getBoundingClientRect();
    if(event.target===dialog && (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom))cancel();
  });
  document.addEventListener('keydown',key,true);
  document.addEventListener('visibilitychange',visibility);
  chrome.runtime.onMessage.addListener(message);
  dialog.showModal(); list.focus(); refresh();
  const expires=setTimeout(cancel,120_000);
  const refreshImages=setInterval(refresh,15_000);
  return {dispose(){
    if(disposed)return;
    disposed=true;clearTimeout(expires);clearInterval(refreshImages);
    for(const timer of imageTimers)clearTimeout(timer);
    document.removeEventListener('keydown',key,true);document.removeEventListener('visibilitychange',visibility);
    chrome.runtime.onMessage.removeListener(message);dialog.close();root.replaceChildren();
  }};
};
