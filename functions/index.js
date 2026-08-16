const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MODEL_ID = 'openai/gpt-oss-120b';
const MAX_PROMPT_CHARS = 4000;
const MAX_MEMORY_ITEMS = 20;
const MAX_OUTPUT_TOKENS = 800;
const MAX_GITHUB_CONTEXT_CHARS = 24000;
const MAX_FILES_TO_INSPECT = 5;
const MAX_FILE_BYTES = 180000;
const MAX_SNIPPET_CHARS = 7000;

const TEXT_EXTENSIONS = new Set([
  'js','jsx','ts','tsx','html','htm','css','json','md','txt','yml','yaml',
  'rules','xml','php','py','java','kt','swift','dart','sql','sh','env'
]);

const STOP_WORDS = new Set([
  'a','ao','aos','as','com','como','da','das','de','do','dos','e','em','esse','esta','este',
  'eu','me','meu','minha','na','nas','no','nos','o','os','ou','para','por','que','se','tem','um',
  'uma','voce','você','nexus','analise','analisar','investigue','investigar','problema','codigo','código',
  'repositorio','repositório','github','projeto','ver','veja','consegue'
]);

const REPOSITORIES = [
  { key:'pronti-pet', name:'Pronti Pet', fullName:'giva-norberto/pronti-pet', aliases:['pronti pet','pronti-pet'] },
  { key:'pronti-app', name:'Pronti', fullName:'giva-norberto/pronti-app', aliases:['pronti','pronti app','pronti-app'] },
  { key:'listalar', name:'ListaLar', fullName:'giva-norberto/ListaLar', aliases:['listalar','lista lar'] },
  { key:'nexus', name:'Nexus', fullName:'giva-norberto/nexus', aliases:['nexus'] }
];

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken.value()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nexus-Agent'
    }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    console.error('GitHub API error', response.status, path, detail);
    if (response.status === 401 || response.status === 403) {
      throw new HttpsError('failed-precondition', 'Credencial do GitHub recusada ou sem permissão.');
    }
    if (response.status === 404) {
      throw new HttpsError('not-found', 'Repositório ou recurso não encontrado no GitHub.');
    }
    throw new HttpsError('internal', 'Falha ao consultar o GitHub.');
  }
  return response.json();
}

function encodeRepoPath(path) {
  return String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function detectRepositories(prompt) {
  const normalized = normalize(prompt);
  const explicit = REPOSITORIES.filter((repo) => repo.aliases.some((alias) => normalized.includes(normalize(alias))));
  if (explicit.length) return explicit;
  if (/repositorios|github|projetos|codigo|repos/.test(normalized)) return REPOSITORIES;
  return [];
}

function getPromptKeywords(prompt) {
  return [...new Set(
    normalize(prompt)
      .replace(/[^a-z0-9._/-]+/g, ' ')
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
  )].slice(0, 18);
}

function isTextFile(path) {
  const lower = String(path).toLowerCase();
  const name = lower.split('/').pop() || '';
  if (['dockerfile','makefile','.gitignore','.firebaserc','.replit'].includes(name)) return true;
  const extension = name.includes('.') ? name.split('.').pop() : '';
  return TEXT_EXTENSIONS.has(extension);
}

function extractFileReferences(prompt) {
  const text = String(prompt || '');
  const found = new Set();
  const explicit = text.match(/[A-Za-z0-9_@./-]+\.(?:html?|jsx?|tsx?|css|json|md|txt|ya?ml|rules|xml|php|py|java|kt|swift|dart|sql|sh|env)\b/gi) || [];
  explicit.forEach((item) => found.add(item.replace(/^['"`]+|['"`]+$/g, '')));
  const normalized = normalize(text);
  for (const name of ['index','app','agenda','firebase-config','firestore','storage','rules','package','readme']) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(normalized)) found.add(name);
  }
  return [...found];
}

function scoreFilePath(path, keywords) {
  const normalizedPath = normalize(path);
  const fileName = normalizedPath.split('/').pop() || normalizedPath;
  let score = 0;
  for (const keyword of keywords) {
    const clean = keyword.replace(/^\.\//, '');
    if (!clean) continue;
    if (fileName === clean) score += 12;
    else if (fileName.includes(clean)) score += 7;
    else if (normalizedPath.includes(clean)) score += 4;
  }
  if (/firebase|firestore|rules|auth|login|agenda|atendimento|cliente|fila|vacina|dashboard|function/.test(fileName)) score += 1;
  return score;
}

function findReferencedFiles(entries, references) {
  if (!references.length) return [];
  const files = entries.filter((item) => item.type === 'blob' && isTextFile(item.path) && Number(item.size || 0) <= MAX_FILE_BYTES);
  const selected = [];
  for (const reference of references) {
    const ref = normalize(reference).replace(/^\.\//, '');
    const hasExtension = ref.includes('.');
    const matches = files.map((item) => {
      const path = normalize(item.path);
      const name = path.split('/').pop() || path;
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      let rank = 0;
      if (path === ref) rank = 100;
      else if (name === ref) rank = 95;
      else if (!hasExtension && stem === ref) rank = 90;
      else if (path.endsWith(`/${ref}`)) rank = 85;
      else if (!hasExtension && name.startsWith(`${ref}.`)) rank = 80;
      else if (name.includes(ref)) rank = 60;
      return { item, rank };
    }).filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank || String(a.item.path).length - String(b.item.path).length);
    if (matches[0] && !selected.some((item) => item.path === matches[0].item.path)) selected.push(matches[0].item);
  }
  return selected.slice(0, MAX_FILES_TO_INSPECT);
}

function buildRelevantSnippet(content, prompt) {
  const lines = String(content).split('\n');
  const keywords = getPromptKeywords(prompt).filter((keyword) => keyword.length >= 4);
  if (!keywords.length || lines.length <= 120) {
    return lines.slice(0, 140).map((line, index) => `${index + 1}: ${line}`).join('\n').slice(0, MAX_SNIPPET_CHARS);
  }
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const normalizedLine = normalize(lines[i]);
    if (keywords.some((keyword) => normalizedLine.includes(keyword))) hits.push(i);
  }
  if (!hits.length) {
    return lines.slice(0, 140).map((line, index) => `${index + 1}: ${line}`).join('\n').slice(0, MAX_SNIPPET_CHARS);
  }
  const ranges = [];
  for (const hit of hits.slice(0, 8)) {
    const start = Math.max(0, hit - 10);
    const end = Math.min(lines.length - 1, hit + 18);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 3) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => lines.slice(start, end + 1)
    .map((line, offset) => `${start + offset + 1}: ${line}`).join('\n'))
    .join('\n...\n').slice(0, MAX_SNIPPET_CHARS);
}

async function loadFileBlock(repo, branch, candidate, prompt, direct) {
  const payload = await githubFetch(`/repos/${repo.fullName}/contents/${encodeRepoPath(candidate.path)}?ref=${encodeURIComponent(branch)}`);
  if (!payload || payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content) return '';
  const decoded = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
  return [
    `ARQUIVO CONFIRMADO${direct ? ' (solicitado diretamente)' : ''}: ${candidate.path}`,
    `SHA: ${payload.sha || candidate.sha || ''}`,
    'Conteúdo relevante com linhas reais:',
    buildRelevantSnippet(decoded, prompt)
  ].join('\n');
}

async function inspectRelevantFiles(repo, defaultBranch, prompt) {
  const tree = await githubFetch(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  const entries = Array.isArray(tree?.tree) ? tree.tree : [];
  const references = extractFileReferences(prompt);
  let candidates = findReferencedFiles(entries, references);
  const direct = candidates.length > 0;

  if (!candidates.length) {
    const keywords = getPromptKeywords(prompt);
    candidates = entries
      .filter((item) => item.type === 'blob' && isTextFile(item.path) && Number(item.size || 0) <= MAX_FILE_BYTES)
      .map((item) => ({ ...item, score: scoreFilePath(item.path, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.size || 0) - Number(b.size || 0))
      .slice(0, MAX_FILES_TO_INSPECT);
  }

  if (!candidates.length) {
    return references.length
      ? `Arquivo solicitado não localizado. Referências procuradas: ${references.join(', ')}.`
      : 'Nenhum arquivo teve correspondência suficiente com os termos da pergunta.';
  }

  const blocks = [];
  for (const candidate of candidates) {
    try {
      const block = await loadFileBlock(repo, defaultBranch, candidate, prompt, direct);
      if (block) blocks.push(block);
    } catch (err) {
      console.error('File inspection error', repo.fullName, candidate.path, err);
    }
  }
  return blocks.length
    ? `Arquivos inspecionados em profundidade:\n\n${blocks.join('\n\n---\n\n')}`
    : 'Não foi possível carregar os arquivos selecionados.';
}

async function getRepositoryContext(repo, prompt) {
  const meta = await githubFetch(`/repos/${repo.fullName}`);
  const defaultBranch = meta.default_branch || 'main';
  const [root, pulls, issues, fileInspection] = await Promise.all([
    githubFetch(`/repos/${repo.fullName}/contents?ref=${encodeURIComponent(defaultBranch)}`),
    githubFetch(`/repos/${repo.fullName}/pulls?state=open&per_page=5`),
    githubFetch(`/repos/${repo.fullName}/issues?state=open&per_page=5`),
    inspectRelevantFiles(repo, defaultBranch, prompt)
  ]);
  const rootItems = Array.isArray(root) ? root.slice(0, 60).map((item) => `${item.type}: ${item.path}`).join('\n') : 'Estrutura raiz indisponível.';
  const openPulls = Array.isArray(pulls) ? pulls.map((pr) => `#${pr.number} ${pr.title} (${pr.head?.ref || ''} -> ${pr.base?.ref || ''})`).join('\n') || 'Nenhum PR aberto.' : 'Nenhum PR aberto.';
  const openIssues = Array.isArray(issues) ? issues.filter((item) => !item.pull_request).map((issue) => `#${issue.number} ${issue.title}`).join('\n') || 'Nenhuma issue aberta.' : 'Nenhuma issue aberta.';
  return [
    `Projeto: ${repo.name}`,
    `Repositório: ${repo.fullName}`,
    `Branch padrão: ${defaultBranch}`,
    `Privado: ${meta.private ? 'sim' : 'não'}`,
    `Atualizado em: ${meta.updated_at || ''}`,
    'Estrutura raiz:', rootItems,
    'Pull requests abertos:', openPulls,
    'Issues abertas:', openIssues,
    fileInspection
  ].join('\n');
}

async function buildGithubContext(prompt) {
  const repos = detectRepositories(prompt);
  if (!repos.length) return '';
  const blocks = [];
  for (const repo of repos.slice(0, 4)) {
    try {
      blocks.push(await getRepositoryContext(repo, prompt));
    } catch (err) {
      console.error('Repository context error', repo.fullName, err);
      blocks.push(`Projeto: ${repo.name}\nRepositório: ${repo.fullName}\nFalha ao carregar contexto deste repositório.`);
    }
  }
  return blocks.join('\n\n---\n\n').slice(0, MAX_GITHUB_CONTEXT_CHARS);
}

exports.githubStatus = onCall(
  { region:'southamerica-east1', secrets:[githubToken], maxInstances:1, timeoutSeconds:30, memory:'256MiB' },
  async (request) => {
    assertAuthorized(request);
    const projects = [];
    for (const repo of REPOSITORIES) {
      try {
        const meta = await githubFetch(`/repos/${repo.fullName}`);
        projects.push({ name:repo.name, repository:repo.fullName, connected:true, private:Boolean(meta.private), defaultBranch:meta.default_branch || 'main' });
      } catch (err) {
        projects.push({ name:repo.name, repository:repo.fullName, connected:false });
      }
    }
    return { connected: projects.some((item) => item.connected), projects };
  }
);

exports.askNexus = onCall(
  { region:'southamerica-east1', secrets:[groqApiKey, githubToken], maxInstances:1, timeoutSeconds:60, memory:'256MiB' },
  async (request) => {
    assertAuthorized(request);
    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);

    const db = getFirestore();
    const [memorySnapshot, githubContext] = await Promise.all([
      db.collection('memory').orderBy('createdAt', 'desc').limit(MAX_MEMORY_ITEMS).get(),
      buildGithubContext(prompt)
    ]);

    const memories = memorySnapshot.docs.map((doc) => {
      const data = doc.data();
      return { project:String(data.project || ''), type:String(data.type || ''), text:String(data.text || '') };
    });
    const memoryText = memories.length
      ? memories.map((item, index) => `${index + 1}. [${item.type}] ${item.project ? item.project + ' — ' : ''}${item.text}`).join('\n')
      : 'Nenhuma memória registrada.';
    const githubText = githubContext || 'Nenhum contexto de repositório foi necessário para esta pergunta.';

    const systemPrompt = [
      'Você é Nexus, um agente técnico central para engenharia, auditoria e operação de projetos.',
      'Responda em português do Brasil, com precisão e objetividade.',
      'Use as memórias fornecidas quando forem relevantes.',
      'Quando houver contexto GitHub, trate-o como fonte real do estado atual dos repositórios autorizados.',
      'Se aparecer ARQUIVO CONFIRMADO (solicitado diretamente), diga que abriu e leu esse arquivo e responda usando o conteúdo mostrado.',
      'Diferencie fatos confirmados no conteúdo dos arquivos de inferências técnicas.',
      'Quando apontar a origem de um problema, informe o caminho exato do arquivo e as linhas quando disponíveis.',
      'Nunca diga que inspecionou um arquivo se ele não aparecer como ARQUIVO CONFIRMADO no contexto.',
      'Se o conteúdo carregado não bastar, diga o que ainda precisa ser analisado, sem inventar.',
      'Nesta etapa você possui leitura e investigação operacional do GitHub, mas não executa alterações no GitHub a partir desta função de chat.',
      'Ações críticas como alterar produção, excluir dados, mudar regras/permissões, merge, deploy ou gerar custo exigem aprovação humana explícita.'
    ].join(' ');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${groqApiKey.value()}`, 'Content-Type':'application/json' },
      body:JSON.stringify({
        model:MODEL_ID,
        messages:[
          { role:'system', content:systemPrompt },
          { role:'user', content:`Memória persistente do Nexus:\n${memoryText}\n\nContexto GitHub atual:\n${githubText}\n\nPergunta do usuário:\n${prompt}` }
        ],
        temperature:0.2,
        max_completion_tokens:MAX_OUTPUT_TOKENS,
        stream:false
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      console.error('Groq error', response.status, detail);
      if (response.status === 429) throw new HttpsError('resource-exhausted', 'Limite de uso da IA atingido. Tente novamente mais tarde.');
      if (response.status === 401 || response.status === 403) throw new HttpsError('failed-precondition', 'Credencial da IA recusada.');
      throw new HttpsError('internal', 'Falha ao consultar a IA.');
    }

    const payload = await response.json();
    const answer = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!answer) throw new HttpsError('internal', 'O modelo não retornou uma resposta válida.');
    return { answer, provider:'Groq', model:MODEL_ID, memoryItemsUsed:memories.length, githubConnected:Boolean(githubContext) };
  }
);
