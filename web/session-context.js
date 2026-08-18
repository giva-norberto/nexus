// Nexus Agent Core routing.
// O frontend mantém apenas contexto de sessão e verificações explícitas de memória.
// Interpretação de intenção, escolha de ferramentas e análise ficam no backend.
(() => {
  const PROJECTS = [
    { key: 'pronti-pet', name: 'Pronti Pet', repository: 'giva-norberto/pronti-pet', patterns: [/\bpronti\s*pet\b/i, /\bpronti-pet\b/i] },
    { key: 'pronti-app', name: 'Pronti', repository: 'giva-norberto/pronti-app', patterns: [/\bpronti\s*app\b/i, /\bpronti-app\b/i, /\bprojeto\s+pronti\b/i] },
    { key: 'listalar', name: 'ListaLar', repository: 'giva-norberto/ListaLar', patterns: [/\blistalar\b/i, /\blista\s*lar\b/i] },
    { key: 'nexus', name: 'Nexus', repository: 'giva-norberto/nexus', patterns: [/\bprojeto\s+nexus\b/i, /\breposit[oó]rio\s+nexus\b/i, /\brepo\s+nexus\b/i] }
  ];

  const MEMORY_STATUS_RE = /^(?:nexus[, ]*)?(?:voce\s+)?(?:salvou|guardou|lembrou|registrou)\s+(?:esta|essa|isso|disto|disso)?\s*(?:informacao|memoria|mensagem)?\s*[?!.,]*$/i;
  const MEMORY_STATUS_ALT_RE = /^(?:nexus[, ]*)?(?:esta|essa|isso)\s+(?:ficou|esta)\s+(?:salvo|salva|guardado|guardada|registrado|registrada)(?:\s+(?:na|no)\s+(?:memoria|firestore|firebase))?\s*[?!.,]*$/i;

  const normalize = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  const getContext = () => ({
    key: sessionStorage.getItem('nexusActiveProjectKey') || '',
    name: sessionStorage.getItem('nexusActiveProjectName') || '',
    repository: sessionStorage.getItem('nexusActiveRepository') || ''
  });

  const setProject = (project) => {
    sessionStorage.setItem('nexusActiveProjectKey', project.key);
    sessionStorage.setItem('nexusActiveProjectName', project.name);
    sessionStorage.setItem('nexusActiveRepository', project.repository);
  };

  const detectProject = (prompt) => PROJECTS.find((project) => project.patterns.some((pattern) => pattern.test(prompt))) || null;

  const callablePromises = new Map();
  const getCallable = async (name) => {
    if (!callablePromises.has(name)) {
      callablePromises.set(name, (async () => {
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
        return httpsCallable(getFunctions(apps[0], 'southamerica-east1'), name);
      })());
    }
    return callablePromises.get(name);
  };

  const conversationHistory = () => {
    const feed = document.getElementById('feed');
    if (!feed) return [];
    const nodes = [...feed.querySelectorAll('.msg')].slice(-12);
    return nodes.map((node) => ({
      role: node.classList.contains('user') ? 'user' : 'assistant',
      content: node.querySelector('.bubble')?.textContent?.trim() || ''
    })).filter((item) => item.content).slice(-10);
  };

  const previousUserMessage = () => {
    const feed = document.getElementById('feed');
    if (!feed) return '';
    const messages = [...feed.querySelectorAll('.msg.user .bubble')]
      .map((bubble) => bubble.textContent?.trim() || '').filter(Boolean);
    return messages[messages.length - 1] || '';
  };

  let legacyAsk = null;
  Object.defineProperty(window, 'nexusAsk', {
    configurable: true,
    enumerable: true,
    get() {
      return async (prompt) => {
        const text = String(prompt || '').trim();
        if (!text) return { answer: 'Informe uma pergunta.' };
        const project = detectProject(text);
        if (project) setProject(project);
        const context = getContext();
        const contextPrefix = context.key && !project
          ? `Contexto ativo da conversa: projeto ${context.name} (${context.key}).\n\n`
          : '';
        try {
          const agent = await getCallable('askNexusAgent');
          const result = await agent({ prompt: `${contextPrefix}${text}`, history: conversationHistory() });
          return result?.data || {};
        } catch (error) {
          console.error('Nexus Agent Core failed', error);
          if (typeof legacyAsk === 'function') return legacyAsk(text);
          throw error;
        }
      };
    },
    set(fn) { legacyAsk = fn; }
  });

  window.addEventListener('DOMContentLoaded', () => {
    const originalSend = window.sendMsg;
    if (typeof originalSend !== 'function') return;
    window.sendMsg = async (event) => {
      const input = document.getElementById('input');
      const rawText = input?.value?.trim() || '';
      const normalized = normalize(rawText);
      const isMemoryStatus = MEMORY_STATUS_RE.test(normalized) || MEMORY_STATUS_ALT_RE.test(normalized);
      if (!isMemoryStatus) return originalSend(event);
      event?.preventDefault?.();
      const previous = previousUserMessage();
      window.nexusAddMsg?.('user', rawText);
      if (input) input.value = '';
      if (!previous) {
        window.nexusAddMsg?.('assistant', 'Não encontrei uma informação anterior sua para verificar no Firestore.');
        return;
      }
      try {
        const checkMemory = await getCallable('checkMemoryCommand');
        const result = await checkMemory({ text: previous });
        const data = result?.data || {};
        if (data.found) {
          const prefix = data.exact ? 'Sim. Confirmei no Firestore' : 'Sim. Encontrei uma memória correspondente no Firestore';
          window.nexusAddMsg?.('assistant', `${prefix}: [${data.type || 'memória'}] ${data.project ? `${data.project} — ` : ''}${data.text || previous}`);
        } else {
          window.nexusAddMsg?.('assistant', 'Não. Verifiquei o Firestore e não encontrei essa informação salva. Se quiser persistir, use “salve esta informação”.');
        }
      } catch (error) {
        console.error(error);
        window.nexusAddMsg?.('assistant', 'Não consegui verificar o Firestore agora. Não vou afirmar que a informação está salva sem confirmação real.');
      }
    };
  });

  window.nexusSessionContext = {
    get: getContext,
    clear() {
      ['nexusActiveProjectKey','nexusActiveProjectName','nexusActiveRepository'].forEach((key) => sessionStorage.removeItem(key));
    }
  };
})();
