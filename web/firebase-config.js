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

  // Interface mais limpa: não exibe detalhes técnicos de autenticação ao usuário.
  if (header) {
    const authBadge = [...header.querySelectorAll('.badge')]
      .find((badge) => badge.textContent.includes('ONLINE / AUTH'));
    if (authBadge) authBadge.textContent = '● ONLINE';
  }

  // Rolagem automática do chat e remoção da mensagem técnica de autenticação.
  if (feed) {
    const cleanupTechnicalGreeting = () => {
      for (const message of feed.querySelectorAll('.msg.assistant')) {
        const bubble = message.querySelector('.bubble');
        if (bubble && bubble.textContent.trim().startsWith('Acesso autenticado.')) {
          message.remove();
        }
      }
    };

    const scrollToLatest = () => {
      cleanupTechnicalGreeting();
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

  // Comandos explícitos de memória e arquivamento de conversa.
  const normalizeCommand = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const collectConversation = () => {
    if (!feed) return [];
    return [...feed.querySelectorAll('.msg')].map((message) => {
      const bubble = message.querySelector('.bubble');
      const text = bubble?.textContent?.trim() || '';
      const role = message.classList.contains('user') ? 'user' : 'assistant';
      return { role, text };
    }).filter((item) => item.text && !item.text.startsWith('Acesso autenticado.'));
  };

  let callablesPromise = null;
  const getMemoryCallables = async () => {
    if (!callablesPromise) {
      callablesPromise = (async () => {
        const [{ getApps }, { getFunctions, httpsCallable }] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/12.2.1/firebase-functions.js')
        ]);
        let apps = getApps();
        for (let i = 0; !apps.length && i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          apps = getApps();
        }
        if (!apps.length) throw new Error('Firebase ainda não inicializado.');
        const functions = getFunctions(apps[0], 'southamerica-east1');
        return {
          saveConversation: httpsCallable(functions, 'saveConversation'),
          saveMemoryCommand: httpsCallable(functions, 'saveMemoryCommand')
        };
      })();
    }
    return callablesPromise;
  };

  const addLocalMessage = (role, text) => {
    if (typeof window.nexusAddMsg === 'function') window.nexusAddMsg(role, text);
  };

  const saveExplicitMemory = async (text) => {
    const callables = await getMemoryCallables();
    const result = await callables.saveMemoryCommand({ text });
    const item = result?.data || {};
    if (item.saved && window.NEXUS_STATE?.memory) {
      window.NEXUS_STATE.memory.unshift({ id: item.id, project: item.project, type: item.type, text: item.text, createdAt: null });
      if (typeof window.nexusRender === 'function') window.nexusRender();
    }
    return item;
  };

  const originalSend = window.sendMsg;
  if (typeof originalSend === 'function') {
    window.sendMsg = async (event) => {
      const input = document.getElementById('input');
      const rawText = input?.value?.trim() || '';
      const normalized = normalizeCommand(rawText);
      const pendingMemory = sessionStorage.getItem('nexusPendingMemory') === '1';

      const isSaveConversation = /\b(salve|salvar|guarde|guardar)\b.*\b(conversa|chat)\b/.test(normalized);
      const isMemoryStart = /^(nexus[, ]*)?(guardar|guarde|salvar|salve)\s+(uma\s+)?(informacao|memoria)\s*[:.!]?\s*$/.test(normalized);
      const directMemoryMatch = normalized.match(/^(?:nexus[, ]*)?(?:guarde|guardar|lembre|salve na memoria|salvar na memoria)(?:\s+(?:que|informacao|isso))?\s*[:,-]?\s+(.+)$/);

      if (isSaveConversation) {
        event?.preventDefault?.();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        const messages = collectConversation().filter((item) => normalizeCommand(item.text) !== normalized);
        if (messages.length < 2) {
          addLocalMessage('assistant', 'Ainda não há conversa suficiente para salvar.');
          return;
        }
        addLocalMessage('assistant', 'Salvando esta conversa...');
        try {
          const callables = await getMemoryCallables();
          const result = await callables.saveConversation({ messages });
          const saved = result?.data || {};
          addLocalMessage('assistant', `Conversa salva no Storage: ${saved.title || 'Conversa Nexus'}${saved.project ? ` • ${saved.project}` : ''}.`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui salvar a conversa. Verifique se as novas Functions já foram publicadas.');
        }
        return;
      }

      if (isMemoryStart) {
        event?.preventDefault?.();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        sessionStorage.setItem('nexusPendingMemory', '1');
        addLocalMessage('assistant', 'Qual informação você quer que eu guarde?');
        return;
      }

      const memoryText = pendingMemory ? rawText : directMemoryMatch?.[1];
      if (memoryText) {
        event?.preventDefault?.();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        sessionStorage.removeItem('nexusPendingMemory');
        try {
          const saved = await saveExplicitMemory(memoryText);
          addLocalMessage('assistant', `Informação guardada: [${saved.type || 'memória'}] ${saved.project ? `${saved.project} — ` : ''}${saved.text || memoryText}`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui guardar a informação. Verifique se as novas Functions já foram publicadas.');
        }
        return;
      }

      return originalSend(event);
    };
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('Nexus service worker não registrado:', error);
    });
  }
});
