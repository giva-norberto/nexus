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

  if (header) {
    const authBadge = [...header.querySelectorAll('.badge')]
      .find((badge) => badge.textContent.includes('ONLINE / AUTH'));
    if (authBadge) authBadge.textContent = '● ONLINE';
  }

  if (feed) {
    const cleanupTechnicalGreeting = () => {
      for (const message of feed.querySelectorAll('.msg.assistant')) {
        const bubble = message.querySelector('.bubble');
        if (bubble && bubble.textContent.trim().startsWith('Acesso autenticado.')) message.remove();
      }
    };
    const scrollToLatest = () => {
      cleanupTechnicalGreeting();
      requestAnimationFrame(() => feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }));
    };
    const observer = new MutationObserver(scrollToLatest);
    observer.observe(feed, { childList: true, subtree: true, characterData: true });
    scrollToLatest();
  }

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
  if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
    const capable = document.createElement('meta');
    capable.name = 'mobile-web-app-capable';
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

  if (!document.querySelector('link[rel="icon"]')) {
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.href = './nexus-icon.svg';
    favicon.type = 'image/svg+xml';
    document.head.appendChild(favicon);
  }

  if (aside && header && app) {
    const style = document.createElement('style');
    style.textContent = `
      :root{--nexus-aside-width:360px}
      #app{grid-template-columns:1fr!important}
      aside{position:fixed!important;top:0!important;right:0!important;width:min(var(--nexus-aside-width),92vw)!important;height:100dvh!important;max-height:100dvh!important;z-index:40!important;transform:translateX(102%);transition:transform .22s ease;box-shadow:-18px 0 55px rgba(0,0,0,.38);border-left:1px solid var(--line)!important;border-top:0!important}
      body.nexus-panel-open aside{transform:translateX(0)}
      .nexus-panel-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:35;opacity:0;pointer-events:none;transition:opacity .2s ease}
      body.nexus-panel-open .nexus-panel-backdrop{opacity:1;pointer-events:auto}
      .nexus-menu-btn{display:inline-grid;place-items:center;min-width:42px;font-size:18px;padding:7px 10px}
      .nexus-install-btn{display:none}
      header{padding-right:12px!important}
      #feed{max-width:1100px;width:100%;margin:0 auto}
      #composer{padding-left:max(18px,calc((100vw - 1100px)/2));padding-right:max(18px,calc((100vw - 1100px)/2))}
      @media(max-width:760px){header{gap:7px!important;padding:9px 10px!important;flex-wrap:nowrap!important}header .badge{display:none!important}header .userTag{display:none!important}header .brand{font-size:12px}header .btn:not(.nexus-menu-btn):not(.nexus-install-btn){padding:8px 9px;font-size:12px}#feed{padding:14px 10px 104px!important}.msg{max-width:96%!important}#composer{padding:10px!important;gap:7px!important}.composerHint{display:none!important}#input{min-height:48px!important}#sendBtn{padding:10px 12px!important}.nexus-install-btn{font-size:12px}}
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
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPanel(false); });
  }

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

  const normalizeCommand = (value) => String(value || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  const collectConversation = () => {
    if (!feed) return [];
    return [...feed.querySelectorAll('.msg')].map((message) => {
      const bubble = message.querySelector('.bubble');
      const text = bubble?.textContent?.trim() || '';
      const role = message.classList.contains('user') ? 'user' : 'assistant';
      return { role, text };
    }).filter((item) => item.text && !item.text.startsWith('Acesso autenticado.'));
  };

  const isMemoryCommandText = (text) => /^(salve|salvar|save|guarde|guardar|lembre)/.test(normalizeCommand(text));

  const getPreviousUserMessage = (currentNormalized = '', subject = '') => {
    const messages = collectConversation();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i];
      if (item.role !== 'user') continue;
      const normalizedItem = normalizeCommand(item.text);
      if (!normalizedItem || normalizedItem === currentNormalized || isMemoryCommandText(normalizedItem)) continue;
      if (subject === 'nome' && !/\bnome\b|me chame|pode me chamar/.test(normalizedItem)) continue;
      return item.text;
    }
    return '';
  };

  const memorySubjectPrompt = (subject) => {
    const prompts = {
      nome: 'Qual é o seu nome e como você prefere que eu te chame?',
      cidade: 'Qual cidade você quer que eu guarde?',
      telefone: 'Qual telefone você quer que eu guarde?',
      email: 'Qual e-mail você quer que eu guarde?',
      aniversario: 'Qual data de aniversário você quer que eu guarde?'
    };
    return prompts[subject] || 'Qual informação você quer que eu guarde?';
  };

  const decorateSubjectMemory = (subject, value) => {
    const labels = {
      nome: 'Nome do usuário',
      cidade: 'Cidade do usuário',
      telefone: 'Telefone do usuário',
      email: 'E-mail do usuário',
      aniversario: 'Aniversário do usuário'
    };
    return subject && labels[subject] ? `${labels[subject]}: ${value}` : value;
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
    if (!item.saved) throw new Error('A função não confirmou o salvamento.');
    if (window.NEXUS_STATE?.memory) {
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
      const pendingSubject = sessionStorage.getItem('nexusPendingMemorySubject') || '';

      const inlineMemoryMatch = rawText.match(/^([\s\S]+?)\s*(?:\n+|[.!?]\s+)(?:nexus[, ]*)?(?:salve|salvar|save|guarde|guardar|lembre)\s+(?:esta|essa|isso|disto|disso)?\s*(?:informação|informacao|memória|memoria|mensagem)?\s*[.!]?\s*$/i);
      const isSaveConversation = /\b(salve|salvar|save|guarde|guardar)\b.*\b(conversa|chat)\b/.test(normalized);
      const isMemoryStart = /^(nexus[, ]*)?(guardar|guarde|salvar|salve|save)\s+(uma\s+)?(informacao|memoria)\s*[:.!]?\s*$/.test(normalized);
      const isPreviousMemoryReference = /^(nexus[, ]*)?(salve|salvar|save|guarde|guardar|lembre)\s+(esta|essa|isso|disto|disso)?\s*(informacao|memoria|mensagem)?\s*(anterior)?\s*[.!]?\s*$/.test(normalized)
        || /^(nexus[, ]*)?(salve|salvar|save|guarde|guardar|lembre)\s+(isso|disso|disto)\s*[.!]?\s*$/.test(normalized);
      const subjectRequest = normalized.match(/^(?:nexus[, ]*)?(?:salve|salvar|save|guarde|guardar|lembre)\s+(?:o\s+|a\s+)?(?:meu|minha)\s+(nome|cidade|telefone|email|e-mail|aniversario)\s*[.!]?$/);
      const directMemoryMatch = normalized.match(/^(?:nexus[, ]*)?(?:guarde|guardar|lembre|salve na memoria|salvar na memoria|save)(?:\s+(?:que|informacao|isso))?\s*[:,-]?\s+(.+)$/);

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
          if (!saved.saved) throw new Error('A função não confirmou o salvamento.');
          addLocalMessage('assistant', `Conversa salva no Storage: ${saved.title || 'Conversa Nexus'}${saved.project ? ` • ${saved.project}` : ''}.`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui salvar a conversa. Nada foi confirmado como armazenado.');
        }
        return;
      }

      if (inlineMemoryMatch) {
        event?.preventDefault?.();
        const memoryValue = inlineMemoryMatch[1].trim();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        try {
          const saved = await saveExplicitMemory(memoryValue);
          addLocalMessage('assistant', `Informação guardada com confirmação do Firestore: [${saved.type}] ${saved.project ? `${saved.project} — ` : ''}${saved.text}`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui confirmar o salvamento da informação. Ela não será tratada como memória persistente.');
        }
        return;
      }

      if (subjectRequest) {
        event?.preventDefault?.();
        const subject = subjectRequest[1] === 'e-mail' ? 'email' : subjectRequest[1];
        const previousText = getPreviousUserMessage(normalized, subject);
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        if (previousText) {
          try {
            const saved = await saveExplicitMemory(previousText);
            addLocalMessage('assistant', `Informação guardada com confirmação do Firestore: [${saved.type}] ${saved.project ? `${saved.project} — ` : ''}${saved.text}`);
          } catch (error) {
            console.error(error);
            addLocalMessage('assistant', 'Não consegui confirmar o salvamento. A informação não será tratada como memória persistente.');
          }
          return;
        }
        sessionStorage.setItem('nexusPendingMemory', '1');
        sessionStorage.setItem('nexusPendingMemorySubject', subject);
        addLocalMessage('assistant', memorySubjectPrompt(subject));
        return;
      }

      if (isMemoryStart) {
        event?.preventDefault?.();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        sessionStorage.setItem('nexusPendingMemory', '1');
        sessionStorage.removeItem('nexusPendingMemorySubject');
        addLocalMessage('assistant', 'Qual informação você quer que eu guarde?');
        return;
      }

      if (isPreviousMemoryReference) {
        event?.preventDefault?.();
        const previousText = getPreviousUserMessage(normalized);
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        if (!previousText) {
          addLocalMessage('assistant', 'Não encontrei uma mensagem anterior sua para guardar. Diga a informação novamente ou use “guarde que ...”.');
          return;
        }
        try {
          const saved = await saveExplicitMemory(previousText);
          addLocalMessage('assistant', `Informação guardada com confirmação do Firestore: [${saved.type}] ${saved.project ? `${saved.project} — ` : ''}${saved.text}`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui confirmar o salvamento dessa informação. Ela não será tratada como memória persistente.');
        }
        return;
      }

      const memoryText = pendingMemory ? decorateSubjectMemory(pendingSubject, rawText) : directMemoryMatch?.[1];
      if (memoryText) {
        event?.preventDefault?.();
        addLocalMessage('user', rawText);
        if (input) input.value = '';
        sessionStorage.removeItem('nexusPendingMemory');
        sessionStorage.removeItem('nexusPendingMemorySubject');
        try {
          const saved = await saveExplicitMemory(memoryText);
          addLocalMessage('assistant', `Informação guardada com confirmação do Firestore: [${saved.type}] ${saved.project ? `${saved.project} — ` : ''}${saved.text}`);
        } catch (error) {
          console.error(error);
          addLocalMessage('assistant', 'Não consegui confirmar o salvamento da informação. Ela não será tratada como memória persistente.');
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
