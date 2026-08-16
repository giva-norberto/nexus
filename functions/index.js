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
const MAX_GITHUB_CONTEXT_CHARS = 12000;

const REPOSITORIES = [
  { key: 'pronti-pet', name: 'Pronti Pet', fullName: 'giva-norberto/pronti-pet', aliases: ['pronti pet', 'pronti-pet'] },
  { key: 'pronti-app', name: 'Pronti', fullName: 'giva-norberto/pronti-app', aliases: ['pronti', 'pronti app', 'pronti-app'] },
  { key: 'listalar', name: 'ListaLar', fullName: 'giva-norberto/ListaLar', aliases: ['listalar', 'lista lar'] },
  { key: 'nexus', name: 'Nexus', fullName: 'giva-norberto/nexus', aliases: ['nexus'] }
];

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

function detectRepositories(prompt) {
  const normalized = prompt.toLowerCase();
  const explicit = REPOSITORIES.filter((repo) => repo.aliases.some((alias) => normalized.includes(alias)));
  if (explicit.length) return explicit;

  if (/reposit[oó]rios|github|projetos|c[oó]digo|repos/.test(normalized)) {
    return REPOSITORIES;
  }

  return [];
}

async function getRepositoryContext(repo) {
  const [meta, root, pulls, issues] = await Promise.all([
    githubFetch(`/repos/${repo.fullName}`),
    githubFetch(`/repos/${repo.fullName}/contents`),
    githubFetch(`/repos/${repo.fullName}/pulls?state=open&per_page=5`),
    githubFetch(`/repos/${repo.fullName}/issues?state=open&per_page=5`)
  ]);

  const rootItems = Array.isArray(root)
    ? root.slice(0, 60).map((item) => `${item.type}: ${item.path}`).join('\n')
    : 'Estrutura raiz indisponível.';

  const openPulls = Array.isArray(pulls)
    ? pulls.map((pr) => `#${pr.number} ${pr.title} (${pr.head?.ref || ''} -> ${pr.base?.ref || ''})`).join('\n') || 'Nenhum PR aberto.'
    : 'Nenhum PR aberto.';

  const openIssues = Array.isArray(issues)
    ? issues.filter((item) => !item.pull_request).map((issue) => `#${issue.number} ${issue.title}`).join('\n') || 'Nenhuma issue aberta.'
    : 'Nenhuma issue aberta.';

  return [
    `Projeto: ${repo.name}`,
    `Repositório: ${repo.fullName}`,
    `Branch padrão: ${meta.default_branch || 'main'}`,
    `Privado: ${meta.private ? 'sim' : 'não'}`,
    `Atualizado em: ${meta.updated_at || ''}`,
    'Estrutura raiz:',
    rootItems,
    'Pull requests abertos:',
    openPulls,
    'Issues abertas:',
    openIssues
  ].join('\n');
}

async function buildGithubContext(prompt) {
  const repos = detectRepositories(prompt);
  if (!repos.length) return '';

  const blocks = [];
  for (const repo of repos.slice(0, 4)) {
    try {
      blocks.push(await getRepositoryContext(repo));
    } catch (err) {
      console.error('Repository context error', repo.fullName, err);
      blocks.push(`Projeto: ${repo.name}\nRepositório: ${repo.fullName}\nFalha ao carregar contexto deste repositório.`);
    }
  }

  return blocks.join('\n\n---\n\n').slice(0, MAX_GITHUB_CONTEXT_CHARS);
}

exports.githubStatus = onCall(
  {
    region: 'southamerica-east1',
    secrets: [githubToken],
    maxInstances: 1,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    assertAuthorized(request);

    const projects = [];
    for (const repo of REPOSITORIES) {
      try {
        const meta = await githubFetch(`/repos/${repo.fullName}`);
        projects.push({
          name: repo.name,
          repository: repo.fullName,
          connected: true,
          private: Boolean(meta.private),
          defaultBranch: meta.default_branch || 'main'
        });
      } catch (err) {
        projects.push({
          name: repo.name,
          repository: repo.fullName,
          connected: false
        });
      }
    }

    return { connected: projects.some((item) => item.connected), projects };
  }
);

exports.askNexus = onCall(
  {
    region: 'southamerica-east1',
    secrets: [groqApiKey, githubToken],
    maxInstances: 1,
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    assertAuthorized(request);

    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) {
      throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    }

    const db = getFirestore();
    const [memorySnapshot, githubContext] = await Promise.all([
      db.collection('memory').orderBy('createdAt', 'desc').limit(MAX_MEMORY_ITEMS).get(),
      buildGithubContext(prompt)
    ]);

    const memories = memorySnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        project: String(data.project || ''),
        type: String(data.type || ''),
        text: String(data.text || '')
      };
    });

    const memoryText = memories.length
      ? memories
          .map((item, index) => `${index + 1}. [${item.type}] ${item.project ? item.project + ' — ' : ''}${item.text}`)
          .join('\n')
      : 'Nenhuma memória registrada.';

    const githubText = githubContext || 'Nenhum contexto de repositório foi necessário para esta pergunta.';

    const systemPrompt = [
      'Você é Nexus, um agente técnico central para engenharia, auditoria e operação de projetos.',
      'Responda em português do Brasil, com precisão e objetividade.',
      'Use as memórias fornecidas apenas quando forem relevantes.',
      'Quando houver contexto GitHub, trate-o como fonte real do estado atual dos repositórios autorizados.',
      'Não invente arquivos, branches, PRs, issues ou fatos que não estejam no contexto.',
      'Nesta etapa você possui leitura operacional do GitHub dentro dos repositórios autorizados, mas ainda não executa alterações no GitHub a partir desta função de chat.',
      'Ações críticas como alterar produção, excluir dados, mudar regras/permissões, merge, deploy ou gerar custo exigem aprovação humana explícita.'
    ].join(' ');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey.value()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Memória persistente do Nexus:\n${memoryText}\n\nContexto GitHub atual:\n${githubText}\n\nPergunta do usuário:\n${prompt}`
          }
        ],
        temperature: 0.2,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        stream: false
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      console.error('Groq error', response.status, detail);
      if (response.status === 429) {
        throw new HttpsError('resource-exhausted', 'Limite de uso da IA atingido. Tente novamente mais tarde.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new HttpsError('failed-precondition', 'Credencial da IA recusada.');
      }
      throw new HttpsError('internal', 'Falha ao consultar a IA.');
    }

    const payload = await response.json();
    const answer = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!answer) {
      throw new HttpsError('internal', 'O modelo não retornou uma resposta válida.');
    }

    return {
      answer,
      provider: 'Groq',
      model: MODEL_ID,
      memoryItemsUsed: memories.length,
      githubConnected: Boolean(githubContext)
    };
  }
);
