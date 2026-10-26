const root = document.body.attachShadow({mode:'closed'});
document.body.style.margin = '0';
document.documentElement.style.background = '#202020';
globalThis.createMruView(root,new URL(location.href).searchParams.get('session'),()=>window.close(),true);
window.addEventListener('blur',()=>window.close());
