// Contexto técnico temporário do Nexus.
// Fica apenas na sessão do navegador; não grava Firestore nem Storage.
(() => {
  const PROJECTS = [
    { key: 'pronti-pet', name: 'Pronti Pet', repository: 'giva-norberto/pronti-pet', patterns: [/\bpronti\s*pet\b/i, /\bpronti-pet\b/i] },
    { key: 'pronti-app', name: 'Pronti', repository: 'giva-norberto/pronti-app', patterns: [/\bpronti\s*app\b/i, /\bpronti-app\b/i, /\bprojeto\s+pronti\b/i] },
    { key: 'listalar', name: 'ListaLar', repository: 'giva-norberto/ListaLar', patterns: [/\blistalar\b/i, /\blista\s*lar\b/i] },
    { key: 'nexus', name: 'Nexus', repository: 'giva-norberto/nexus', patterns: [/\bprojeto\s+nexus\b/i, /\breposit[oó]rio\s+nexus\b/i, /\brepo\s+nexus\b/i] }
  ];

  const FILE_RE = /(?:^|[\s'"`(])([A-Za-z0-9_@./-]+\.(?:html?|jsx?|tsx?|css|json|md|txt|ya?ml|rules|xml|php|py|java|kt|swift|dart|sql|sh|env))\b/i;
  const CONTINUATION_RE = /\b(continue|continuar|continua|agora|nesse|nessa|neste|nesta|esse|essa|isso|mesmo arquivo|mesmo projeto|procure|buscar|busque|investigue|investigar|analise|analisar|fun[cç][aã]o|linha|arquivo|firestore|adddoc|setdoc|collection|submit|salvar|gravar|chamada|fluxo)\b/i;
  const MEMORY_STATUS_RE = /^(?:nexus[, ]*)?(?:voce\s+)?(?:salvou|guardou|lembrou|registrou)\s+(?:esta|essa|isso|disto|disso)?\s*(?:informacao|memoria|mensagem)?\s*[?!.,]*$/i;
  const MEMORY_STATUS_ALT_RE = /^(?:nexus[, ]*)?(?:esta|essa|isso)\s+(?:ficou|esta)\s+(?:salvo|salva|guardado|guardada|registrado|registrada)(?:\s+(?:na|no)\s+(?:memoria|firestore|firebase))?\s*[?!.,]*$/i;

  const getContext = () => ({
    key: sessionStorage.getItem('nexusActiveProjectKey') || '',
    name: sessionStorage.getItem('nexusActiveProjectName') || '',
    repository: sessionStorage.getItem('nexusActiveRepository') || '',
    file: sessionStorage.getItem('nexusActiveFile') || ''
  });

  const setProject = (project) => {
    const previous = getContext();
    if (previous.key && previous.key !== project.key) sessionStorage.removeItem('nexusActiveFile');
    sessionStorage.setItem('nexusActiveProjectKey', project.key);
    sessionStorage.setItem('nexusActiveProjectName', project.name);
    sessionStorage.setItem('nexusActiveRepository', project.repository);
  };

  const setFile = (file) => {
    if (file) sessionStorage.setItem('nexusActiveFile', file);
  };

  const detectProject = (prompt) => PROJECTS.find((project) => project.patterns.some((pattern) => pattern.test(prompt))) || null;
  const detectFile = (prompt) => prompt.match(FILE_RE)?.[1] || '';

  const augmentPrompt = (prompt) => {
    const original = String(prompt || '').trim();
    if (!original) return original;

    const project = detectProject(original);
    const file = detectFile(original);
    if (project) setProject(project);
    if (file) setFile(file);

    const context = getContext();
    if (!context.repository) return original;
    if (project) return original;
    if (!file && !CONTINUATION_RE.test(original)) return original;

    const contextLine = [
      `CONTEXTO TÉCNICO ATIVO DA SESSÃO: projeto ${context.name}`,
      `repositório ${context.repository}`,
      context.file ? `arquivo ativo ${context.file}` : ''
    ].filter(Boolean).join('; ');

    return `${contextLine}. Continue a investigação nesse contexto, reabrindo os arquivos necessários no GitHub.\n\n${original}`;
  };

  let rawAsk = null;
  Object.defineProperty(window, 'nexusAsk', {
    configurable: true,
    enumerable: true,
    get() {
      if (typeof rawAsk !== 'function') return undefined;
      return async (prompt) => rawAsk(augmentPrompt(prompt));
    },
    set(fn) {
      rawAsk = fn;
    }
  });

  const normalize = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  const previousUserMessage = () => {
    const feed = document.getElementById('feed');
    if (!feed) return '';
    const messages = [...feed.querySelectorAll('.msg.user .bubble')]
      .map((bubble) => bubble.textContent?.trim() || '')
      .filter(Boolean);
    return messages[messages.length - 1] || '';
  };

  let checkMemoryCallablePromise = null;
  const getCheckMemoryCallable = async () => {
    if (!checkMemoryCallablePromise) {
      checkMemoryCallablePromise = (async () => {
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
        return httpsCallable(functions, 'checkMemoryCommand');
      })();
    }
    return checkMemoryCallablePromise;
  };

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
      if (typeof window.nexusAddMsg === 'function') window.nexusAddMsg('user', rawText);
      if (input) input.value = '';

      if (!previous) {
        if (typeof window.nexusAddMsg === 'function') {
          window.nexusAddMsg('assistant', 'Não encontrei uma informação anterior sua para verificar no Firestore.');
        }
        return;
      }

      try {
        const checkMemory = await getCheckMemoryCallable();
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
      ['nexusActiveProjectKey','nexusActiveProjectName','nexusActiveRepository','nexusActiveFile']
        .forEach((key) => sessionStorage.removeItem(key));
    }
  };
})();
