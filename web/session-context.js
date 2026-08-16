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

    // Quando o projeto já foi citado nesta mensagem, o backend consegue detectá-lo sozinho.
    if (project) return original;

    // Só reaproveita contexto em uma continuação técnica ou quando um arquivo foi citado.
    if (!file && !CONTINUATION_RE.test(original)) return original;

    const contextLine = [
      `CONTEXTO TÉCNICO ATIVO DA SESSÃO: projeto ${context.name}`,
      `repositório ${context.repository}`,
      context.file ? `arquivo ativo ${context.file}` : ''
    ].filter(Boolean).join('; ');

    return `${contextLine}. Continue a investigação nesse contexto, reabrindo os arquivos necessários no GitHub.\n\n${original}`;
  };

  // Intercepta a função que o módulo Firebase atribui depois e preserva a API existente.
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

  window.nexusSessionContext = {
    get: getContext,
    clear() {
      ['nexusActiveProjectKey','nexusActiveProjectName','nexusActiveRepository','nexusActiveFile']
        .forEach((key) => sessionStorage.removeItem(key));
    }
  };
})();
