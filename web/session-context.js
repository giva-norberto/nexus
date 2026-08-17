// Contexto técnico temporário e roteamento operacional do Nexus.
// Contexto de sessão fica no navegador; dados persistentes são lidos somente via Functions autorizadas.
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

  const normalize = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

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

  const setFile = (file) => { if (file) sessionStorage.setItem('nexusActiveFile', file); };
  const detectProject = (prompt) => PROJECTS.find((project) => project.patterns.some((pattern) => pattern.test(prompt))) || null;
  const detectFile = (prompt) => String(prompt || '').match(FILE_RE)?.[1] || '';

  const augmentPrompt = (prompt) => {
    const original = String(prompt || '').trim();
    if (!original) return original;
    const project = detectProject(original);
    const file = detectFile(original);
    if (project) setProject(project);
    if (file) setFile(file);
    const context = getContext();
    if (!context.repository || project || (!file && !CONTINUATION_RE.test(original))) return original;
    const contextLine = [
      `CONTEXTO TÉCNICO ATIVO DA SESSÃO: projeto ${context.name}`,
      `repositório ${context.repository}`,
      context.file ? `arquivo ativo ${context.file}` : ''
    ].filter(Boolean).join('; ');
    return `${contextLine}. Continue a investigação nesse contexto, reabrindo os arquivos necessários no GitHub.\n\n${original}`;
  };

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

  const mentionsListaLar = (prompt) => {
    const text = normalize(prompt);
    return /\blistalar\b|\blista lar\b|\bcompras-da-casa\b/.test(text) || getContext().key === 'listalar';
  };

  const isListaLarSpendingQuery = (prompt) => {
    const text = normalize(prompt);
    if (!mentionsListaLar(prompt)) return false;
    return /gasto|gastos|gastei|mais caro|mais cara|caro|cara|preco|precos|item|itens|produto|produtos|compras|compra|ticket|ranking/.test(text)
      && /mais|maior|ranking|gasto|caro|preco|item|produto|compras/.test(text);
  };

  const requestedDays = (prompt) => {
    const text = normalize(prompt);
    const explicit = text.match(/(?:ultimos?|nos ultimos?)\s+(\d{1,4})\s+dias?/);
    if (explicit) return Math.min(3650, Math.max(1, Number(explicit[1])));
    if (/este mes|mes atual|neste mes/.test(text)) return 31;
    if (/este ano|ano atual|neste ano/.test(text)) return 365;
    if (/ultimos? 30 dias/.test(text)) return 30;
    if (/ultimos? 90 dias/.test(text)) return 90;
    return null;
  };

  const requestedTopN = (prompt, fallback = 5) => {
    const text = normalize(prompt);
    const explicit = text.match(/(?:top\s*|os\s+|as\s+)?(\d{1,2})\s+(?:itens|produtos|mais|maiores|caros|caras)/);
    if (!explicit) return fallback;
    return Math.min(15, Math.max(1, Number(explicit[1])));
  };

  const brl = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const vezes = (value) => `${Number(value || 0)} ${Number(value || 0) === 1 ? 'vez' : 'vezes'}`;

  const formatSpendingAnalytics = (data, prompt) => {
    const text = normalize(prompt);
    const period = data?.periodDays ? `Últimos ${data.periodDays} dias` : 'Todo o histórico disponível';
    const topSpend = Array.isArray(data?.topBySpend) ? data.topBySpend : [];
    const topPrice = Array.isArray(data?.topByUnitPrice) ? data.topByUnitPrice : [];
    const topN = requestedTopN(prompt, 5);
    const wantsPrice = /mais caro|mais cara|preco|precos/.test(text);
    const wantsSpend = /gasto|gastei|mais|ranking|item|produto|compras/.test(text);
    const lines = [
      'LISTALAR — ANÁLISE DE COMPRAS',
      '',
      `Período: ${period}`,
      `Compras analisadas: ${data?.purchaseCount || 0}`,
      `Itens registrados: ${data?.itemCount || 0}`,
      `Produtos diferentes: ${data?.uniqueItems || 0}`,
      `Total gasto: ${brl(data?.totalSpent)}`
    ];

    if (wantsSpend && topSpend.length) {
      lines.push('', `MAIORES GASTOS POR PRODUTO — TOP ${Math.min(topN, topSpend.length)}`);
      topSpend.slice(0, topN).forEach((item, index) => {
        lines.push(`${index + 1}. ${item.name}`);
        lines.push(`   Total: ${brl(item.totalSpent)} • Comprado: ${vezes(item.occurrences)}`);
      });
    }

    if (wantsPrice) {
      if (data?.highestUnit) {
        lines.push('', 'ITEM MAIS CARO POR UNIDADE');
        lines.push(`${data.highestUnit.name}`);
        lines.push(`Preço unitário: ${brl(data.highestUnit.unitPrice)}${data.highestUnit.establishment ? ` • Local: ${data.highestUnit.establishment}` : ''}`);
      }
      if (data?.highestLine) {
        lines.push('', 'MAIOR VALOR EM UMA ÚNICA LINHA DE COMPRA');
        lines.push(`${data.highestLine.name}: ${brl(data.highestLine.lineTotal)}`);
      }
      if (topPrice.length && !data?.highestUnit) {
        lines.push('', `MAIORES PREÇOS UNITÁRIOS — TOP ${Math.min(topN, topPrice.length)}`);
        topPrice.slice(0, topN).forEach((item, index) => lines.push(`${index + 1}. ${item.name}: ${brl(item.maxUnitPrice)}`));
      }
    }

    if (topSpend.some((item) => /\b[a-z]{1,4}\b/i.test(String(item.name || '')))) {
      lines.push('', 'Observação: alguns nomes vêm abreviados exatamente como foram registrados na nota fiscal.');
    }
    if (data?.truncated) {
      lines.push('', `ATENÇÃO: a leitura atingiu o limite de segurança de ${data?.limits?.purchases || 0} compras / ${data?.limits?.items || 0} itens. O ranking pode ser parcial.`);
    }
    lines.push('', 'Fonte: Firestore do ListaLar • Modo somente leitura');
    return { answer: lines.join('\n'), firebaseOperational: true, analytics: data };
  };

  const isFirestorePathQuery = (prompt) => {
    const text = normalize(prompt);
    return mentionsListaLar(prompt) && /(?:colecao|documento|caminho)\s+[a-z0-9_-]+(?:\/[a-z0-9_-]+)*/.test(text)
      && /abra|leia|liste|mostre|ver|acessar|acesse|documentos/.test(text);
  };

  const extractFirestorePath = (prompt) => {
    const text = normalize(prompt);
    const match = text.match(/(?:colecao|documento|caminho)\s+([a-z0-9_-]+(?:\/[a-z0-9_-]+)*)/);
    return match?.[1] || '';
  };

  const formatFirestoreRead = (data) => {
    if (data?.kind === 'document') {
      if (!data.exists) return { answer: `LISTALAR — FIRESTORE\n\nDocumento não encontrado: ${data.path}\n\nFonte: Firestore • Modo somente leitura`, firebaseOperational: true };
      const lines = [
        'LISTALAR — DOCUMENTO DO FIRESTORE',
        '',
        `Caminho: ${data.path}`,
        '',
        JSON.stringify(data.data, null, 2)
      ];
      if (data.subcollections?.length) lines.push('', `Subcoleções: ${data.subcollections.join(', ')}`);
      lines.push('', 'Fonte: Firestore • Modo somente leitura');
      return { answer: lines.join('\n'), firebaseOperational: true, firestoreRead: data };
    }
    const docs = Array.isArray(data?.documents) ? data.documents : [];
    const lines = [
      'LISTALAR — COLEÇÃO DO FIRESTORE',
      '',
      `Caminho: ${data?.path || ''}`,
      `Documentos retornados: ${data?.returned || 0}`,
      ''
    ];
    docs.slice(0, 20).forEach((doc, index) => {
      lines.push(`${index + 1}. ${doc.id}`);
      lines.push(`   ${JSON.stringify(doc.data)}`);
    });
    if (!docs.length) lines.push('(coleção vazia)');
    if (docs.length > 20) lines.push('', `Mostrando 20 de ${docs.length} documentos retornados.`);
    lines.push('', 'Fonte: Firestore • Modo somente leitura');
    return { answer: lines.join('\n'), firebaseOperational: true, firestoreRead: data };
  };

  const isListaLarOperationalQuery = (prompt) => {
    const text = normalize(prompt);
    return mentionsListaLar(prompt) && /usuario|usuarios|cadastrad|firebase|authentication|\bauth\b|firestore|colecao|colecoes|status|saude|quantos|acessos|login/.test(text);
  };

  const formatFirebaseOperationalAnswer = (status, prompt) => {
    const text = normalize(prompt);
    const auth = status?.auth;
    const firestore = status?.firestore;
    const errors = Array.isArray(status?.errors) ? status.errors : [];
    if (/quantos|usuario|usuarios|cadastrad/.test(text) && auth) {
      const lines = [
        'LISTALAR — USUÁRIOS',
        '',
        `Cadastrados: ${auth.totalUsers}${auth.truncated ? '+' : ''}`,
        `Ativos: ${auth.enabledUsers}`,
        `Desativados: ${auth.disabledUsers}`,
        `E-mails verificados: ${auth.emailVerifiedUsers}`,
        `Login nos últimos 30 dias: ${auth.recentSignIns30d}`,
        '',
        'Fonte: Firebase Authentication • Modo somente leitura'
      ];
      return { answer: lines.join('\n'), firebaseOperational: true, status };
    }
    const lines = ['LISTALAR — STATUS OPERACIONAL', ''];
    if (auth) {
      lines.push('AUTHENTICATION');
      lines.push(`Usuários: ${auth.totalUsers}${auth.truncated ? '+' : ''} • Ativos: ${auth.enabledUsers} • Desativados: ${auth.disabledUsers}`);
      lines.push(`Login nos últimos 30 dias: ${auth.recentSignIns30d}`);
    } else {
      lines.push('AUTHENTICATION: leitura indisponível');
    }
    lines.push('');
    if (firestore) {
      lines.push('FIRESTORE');
      lines.push(`Coleções raiz: ${firestore.rootCollectionCount}`);
      if (firestore.rootCollections?.length) lines.push(firestore.rootCollections.join(', '));
    } else {
      lines.push('FIRESTORE: leitura indisponível');
    }
    if (errors.length) lines.push('', `Pendências: ${errors.map((item) => item.area).join(', ')}`);
    lines.push('', 'Modo somente leitura • Nenhum dado foi alterado');
    return { answer: lines.join('\n'), firebaseOperational: true, status };
  };

  let rawAsk = null;
  Object.defineProperty(window, 'nexusAsk', {
    configurable: true,
    enumerable: true,
    get() {
      if (typeof rawAsk !== 'function') return undefined;
      return async (prompt) => {
        const project = detectProject(String(prompt || ''));
        if (project) setProject(project);

        if (isListaLarSpendingQuery(prompt)) {
          try {
            const analyticsFn = await getCallable('firebaseSpendingAnalytics');
            const result = await analyticsFn({ project: 'listalar', days: requestedDays(prompt) });
            return formatSpendingAnalytics(result?.data || {}, prompt);
          } catch (error) {
            console.error('Nexus spending analytics failed', error);
            return { answer: 'Não consegui concluir a análise de gastos do ListaLar. Nenhum dado foi alterado.', firebaseOperational: true, error: true };
          }
        }

        if (isFirestorePathQuery(prompt)) {
          try {
            const path = extractFirestorePath(prompt);
            const readFn = await getCallable('firebaseFirestoreRead');
            const result = await readFn({ project: 'listalar', path, limit: 50 });
            return formatFirestoreRead(result?.data || {});
          } catch (error) {
            console.error('Nexus Firestore read failed', error);
            return { answer: 'Não consegui ler esse caminho do Firestore do ListaLar. Nenhum documento foi alterado.', firebaseOperational: true, error: true };
          }
        }

        if (isListaLarOperationalQuery(prompt)) {
          try {
            const firebaseStatus = await getCallable('firebaseProjectStatus');
            const result = await firebaseStatus({ project: 'listalar' });
            return formatFirebaseOperationalAnswer(result?.data || {}, prompt);
          } catch (error) {
            console.error('Nexus Firebase operational query failed', error);
            return { answer: 'Não consegui consultar o status operacional do ListaLar. Nenhum dado foi alterado.', firebaseOperational: true, error: true };
          }
        }
        return rawAsk(augmentPrompt(prompt));
      };
    },
    set(fn) { rawAsk = fn; }
  });

  const previousUserMessage = () => {
    const feed = document.getElementById('feed');
    if (!feed) return '';
    const messages = [...feed.querySelectorAll('.msg.user .bubble')].map((bubble) => bubble.textContent?.trim() || '').filter(Boolean);
    return messages[messages.length - 1] || '';
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
      ['nexusActiveProjectKey','nexusActiveProjectName','nexusActiveRepository','nexusActiveFile'].forEach((key) => sessionStorage.removeItem(key));
    }
  };
})();