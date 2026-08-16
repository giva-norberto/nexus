window.NEXUS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyB3UZlfxP1qJ5JWQGy7FFl9AahISojaSGM",
  authDomain: "nexus-da920.firebaseapp.com",
  projectId: "nexus-da920",
  storageBucket: "nexus-da920.firebasestorage.app",
  messagingSenderId: "288616302811",
  appId: "1:288616302811:web:6febc7951de9fb00eae4fe",
  measurementId: "G-G70PRJCF6W"
};

window.addEventListener('DOMContentLoaded', () => {
  const feed = document.getElementById('feed');
  const aside = document.querySelector('aside');
  const header = document.querySelector('header');
  const app = document.getElementById('app');

  // Rolagem automática do chat.
  if (feed) {
    const scrollToLatest = () => {
      requestAnimationFrame(() => {
        feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
      });
    };
    const observer = new MutationObserver(scrollToLatest);
    observer.observe(feed, { childList: true, subtree: true, characterData: true });
    scrollToLatest();
  }

  // PWA: metadados e manifest sem exigir alteração estrutural no HTML principal.
  if (!document.querySelector('link[rel="manifest"]')) {
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = './manifest.webmanifest';
    document.head.appendChild(manifest);
  }
  if (!document.querySelector('meta[name="theme-color"]')) {
    const theme = document.createElement('meta');
    theme.name = 'theme-color';
    theme.content = '#121722';
    document.head.appendChild(theme);
  }
  if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const capable = document.createElement('meta');
    capable.name = 'apple-mobile-web-app-capable';
    capable.content = 'yes';
    document.head.appendChild(capable);
  }
  if (!document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')) {
    const statusBar = document.createElement('meta');
    statusBar.name = 'apple-mobile-web-app-status-bar-style';
    statusBar.content = 'black-translucent';
    document.head.appendChild(statusBar);
  }
  const appleTitle = document.createElement('meta');
  appleTitle.name = 'apple-mobile-web-app-title';
  appleTitle.content = 'Nexus';
  document.head.appendChild(appleTitle);

  // Layout limpo: painel lateral vira gaveta recolhível.
  if (aside && header && app) {
    const style = document.createElement('style');
    style.textContent = `
      :root{--nexus-aside-width:360px}
      #app{grid-template-columns:1fr!important}
      aside{
        position:fixed!important;
        top:0!important;
        right:0!important;
        width:min(var(--nexus-aside-width),92vw)!important;
        height:100dvh!important;
        max-height:100dvh!important;
        z-index:40!important;
        transform:translateX(102%);
        transition:transform .22s ease;
        box-shadow:-18px 0 55px rgba(0,0,0,.38);
        border-left:1px solid var(--line)!important;
        border-top:0!important;
      }
      body.nexus-panel-open aside{transform:translateX(0)}
      .nexus-panel-backdrop{
        position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:35;
        opacity:0;pointer-events:none;transition:opacity .2s ease;
      }
      body.nexus-panel-open .nexus-panel-backdrop{opacity:1;pointer-events:auto}
      .nexus-menu-btn{display:inline-grid;place-items:center;min-width:42px;font-size:18px;padding:7px 10px}
      .nexus-install-btn{display:none}
      header{padding-right:12px!important}
      #feed{max-width:1100px;width:100%;margin:0 auto}
      #composer{padding-left:max(18px,calc((100vw - 1100px)/2));padding-right:max(18px,calc((100vw - 1100px)/2))}
      @media(max-width:760px){
        header{gap:7px!important;padding:9px 10px!important;flex-wrap:nowrap!important}
        header .badge{display:none!important}
        header .userTag{display:none!important}
        header .brand{font-size:12px}
        header .btn:not(.nexus-menu-btn):not(.nexus-install-btn){padding:8px 9px;font-size:12px}
        #feed{padding:14px 10px 104px!important}
        .msg{max-width:96%!important}
        #composer{padding:10px!important;gap:7px!important}
        .composerHint{display:none!important}
        #input{min-height:48px!important}
        #sendBtn{padding:10px 12px!important}
        .nexus-install-btn{font-size:12px}
      }
    `;
    document.head.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'nexus-panel-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'btn nexus-menu-btn';
    menuBtn.setAttribute('aria-label', 'Abrir painel lateral');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.textContent = '☰';
    header.appendChild(menuBtn);

    const setPanel = (open) => {
      document.body.classList.toggle('nexus-panel-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.textContent = open ? '✕' : '☰';
      menuBtn.setAttribute('aria-label', open ? 'Fechar painel lateral' : 'Abrir painel lateral');
    };
    menuBtn.addEventListener('click', () => setPanel(!document.body.classList.contains('nexus-panel-open')));
    backdrop.addEventListener('click', () => setPanel(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setPanel(false);
    });
  }

  // Instalação como aplicativo no celular/desktop (PWA).
  let deferredInstallPrompt = null;
  if (header) {
    const installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.className = 'btn nexus-install-btn';
    installBtn.textContent = 'Instalar';
    installBtn.title = 'Instalar Nexus neste dispositivo';
    header.appendChild(installBtn);

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installBtn.style.display = 'inline-flex';
    });

    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (_) {}
      deferredInstallPrompt = null;
      installBtn.style.display = 'none';
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      installBtn.style.display = 'none';
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('Nexus service worker não registrado:', error);
    });
  }
});
