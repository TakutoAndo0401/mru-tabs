globalThis.mountMruOverlay = token => {
  globalThis.disposeMruOverlay?.();
  const host = document.createElement('mru-tab-switcher');
  host.style.setProperty('all','initial','important');
  const root = host.attachShadow({mode:'closed'});
  document.documentElement.append(host);
  let disposed=false;
  const close=()=>{
    if(disposed) return;
    disposed=true; view.dispose(); host.remove(); globalThis.disposeMruOverlay=null;
  };
  const view=globalThis.createMruView(root,token,close,false);
  globalThis.disposeMruOverlay=close;
};
