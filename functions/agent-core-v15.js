const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const agentCoreV14 = require('./agent-core-v14');
const firestoreExplorer = require('./firestore-explorer');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const GEMINI_MODEL = 'gemini-2.5-flash';
const FREE_ONLY = true;
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 5;
const MAX_HISTORY_CHARS = 700;
const MAX_EVIDENCE_CHARS = 14000;
const MAX_GITHUB_FILES = 3;
const MAX_GITHUB_FILE_BYTES = 180000;

const REPOSITORIES = {
  'pronti-pet': { name: 'Pronti Pet', fullName: 'giva-norberto/pronti-pet' },
  'pronti-app': { name: 'Pronti', fullName: 'giva-norberto/pronti-app' },
  listalar: { name: 'ListaLar', fullName: 'giva-norberto/ListaLar' },
  nexus: { name: 'Nexus', fullName: 'giva-norberto/nexus' }
};

const PROJECT_ALIASES = {
  'pronti pet': 'pronti-pet',
  'pronti-pet': 'pronti-pet',
  pronti: 'pronti-app',
  'pronti app': 'pronti-app',
  'pronti-app': 'pronti-app',
  listalar: 'listalar',
  'lista lar': 'listalar',
  nexus: 'nexus'
};

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: clampText(item?.content || '', MAX_HISTORY_CHARS)
    }))
    .filter((item) => item.content.trim());
}

function words(value) {
  const stop = new Set([
    'que', 'para', 'com', 'uma', 'uns', 'das', 'dos', 'por', 'mais',
    'qual', 'quais', 'como', 'onde', 'isso', 'esse', 'essa', 'este',
    'esta', 'nexus', 'projeto', 'sobre', 'meu', 'minha', 'nos', 'nas'
  ]);
  return [...new Set(
    normalize(value)
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stop.has(word))
  )].slice(0, 18);
}

function resolveProject(prompt, history = []) {
  const text = normalize(`${prompt} ${history.map((item) => item.content).join(' ')}`);
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) {
    if (text.includes(alias)) return key;
  }
  return '';
}

function isListaLarDataQuestion(prompt, history) {
  if (resolveProject(prompt, history) !== 'listalar') return false;
  const text = normalize(prompt);
  const dataTerms = /compra|compras|produto|produtos|item|itens|gasto|gastei|preco|precos|valor|valores|aument|subiu|queda|baixou|barato|barata|caro|cara|frequencia|vezes|historico|mercado|estabelecimento/;
  const codeTerms = /codigo|arquivo|funcao|bug|erro no codigo|implementacao|arquitetura|repositorio|github|linha|commit|branch|pull request|\bpr\b/;
  return dataTerms.test(text) && !codeTerms.test(text);
}

function isCodeQuestion(prompt, history) {
  const project = resolveProject(prompt, history);
  return Boolean(project && /codigo|arquivo|funcao|bug|erro|implementacao|arquitetura|repositorio|github|linha|commit|branch|pull request|\bpr\b|investig/.test(normalize(prompt)));
}

function isMemoryQuestion(prompt) {
  return /meu nome|minha preferencia|lembra|memoria|regra|decisao|guardei|salvei|quem sou/.test(normalize(prompt));
}

function isProviderFailure(error) {
  const code = normalize(error?.code || '');
  const message = normalize(error?.message || '');
  return (
    code.includes('resource-exhausted') ||
    code.includes('unavailable') ||
    code.includes('internal') ||
    message.includes('limite de capacidade') ||
    message.includes('cota') ||
    message.includes('falha ao consultar a ia')
  );
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken.value()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nexus-AI-Router'
    }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function scorePath(path, terms) {
  const normalizedPath = normalize(path);
  const fileName = normalizedPath.split('/').pop() || '';
  let score = 0;
  for (const term of terms) {
    if (fileName === term) score += 12;
    else if (fileName.includes(term)) score += 7;
    else if (normalizedPath.includes(term)) score += 3;
  }
  if (/firebase|firestore|auth|agenda|atendimento|cliente|gasto|item|function|service|api|config/.test(fileName)) score += 1;
  return score;
}

async function githubInvestigate(prompt, history) {
  const projectKey = resolveProject(prompt, history);
  const repo = REPOSITORIES[projectKey];
  if (!repo) return { tool: 'github_investigate', ok: false, error: 'Projeto não identificado.' };

  const meta = await githubFetch(`/repos/${repo.fullName}`);
  const branch = meta.default_branch || 'main';
  const treePayload = await githubFetch(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const tree = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  const terms = words(prompt);
  const refs = String(prompt).match(/[A-Za-z0-9_@./-]+\.(?:js|jsx|ts|tsx|html|css|json|md|rules|yml|yaml)\b/gi) || [];

  let candidates = tree
    .filter((item) => item.type === 'blob' && Number(item.size || 0) <= MAX_GITHUB_FILE_BYTES)
    .map((item) => ({
      ...item,
      score: scorePath(item.path, terms) +
        (refs.some((ref) => normalize(item.path).endsWith(normalize(ref))) ? 100 : 0)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.size || 0) - Number(b.size || 0))
    .slice(0, MAX_GITHUB_FILES);

  if (!candidates.length) {
    candidates = tree
      .filter((item) => item.type === 'blob' && Number(item.size || 0) <= 60000)
      .slice(0, 2);
  }

  const files = [];
  for (const candidate of candidates) {
    try {
      const payload = await githubFetch(
        `/repos/${repo.fullName}/contents/${encodePath(candidate.path)}?ref=${encodeURIComponent(branch)}`
      );
      if (payload?.encoding !== 'base64' || !payload?.content) continue;
      const decoded = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
      const lines = decoded.split('\n');
      const hits = [];

      for (let i = 0; i < lines.length; i += 1) {
        if (terms.some((term) => term.length >= 4 && normalize(lines[i]).includes(term))) hits.push(i);
      }

      const centers = hits.length ? hits.slice(0, 3) : [0];
      const selected = new Set();
      for (const center of centers) {
        for (let i = Math.max(0, center - 5); i <= Math.min(lines.length - 1, center + 8); i += 1) {
          selected.add(i);
        }
      }

      const snippet = [...selected]
        .sort((a, b) => a - b)
        .slice(0, 80)
        .map((lineNumber) => `${lineNumber + 1}: ${lines[lineNumber]}`)
        .join('\n');

      files.push({
        path: candidate.path,
        sha: payload.sha || candidate.sha || '',
        snippet: clampText(snippet, 2800)
      });
    } catch (error) {
      console.error('Gemini fallback GitHub file error', candidate.path, error);
    }
  }

  return {
    tool: 'github_investigate',
    ok: true,
    project: repo.name,
    repository: repo.fullName,
    defaultBranch: branch,
    files
  };
}

async function memorySearch(prompt) {
  try {
    const db = getFirestore();
    const snapshot = await db.collection('memory').orderBy('createdAt', 'desc').limit(60).get();
    const terms = words(prompt);
    const matches = snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        const haystack = normalize(`${data.project || ''} ${data.type || ''} ${data.text || ''}`);
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return {
          id: doc.id,
          project: String(data.project || ''),
          type: String(data.type || ''),
          text: clampText(data.text || '', 500),
          score
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    return { tool: 'memory_search', ok: true, matches };
  } catch (error) {
    console.error('Gemini fallback memory error', error);
    return { tool: 'memory_search', ok: false, error: String(error?.message || error) };
  }
}

function compactListaLarAnalytics(analytics) {
  return {
    tool: 'listalar_analytics',
    ok: true,
    readOnly: true,
    summary: {
      purchaseCount: analytics.purchaseCount,
      itemCount: analytics.itemCount,
      totalSpent: analytics.totalSpent,
      uniqueItems: analytics.uniqueItems,
      priceComparableItems: analytics.priceComparableItems,
      truncated: analytics.truncated
    },
    topBySpend: (analytics.topBySpend || []).slice(0, 10),
    topByUnitPrice: (analytics.topByUnitPrice || []).slice(0, 8),
    topByOccurrences: (analytics.topByOccurrences || []).slice(0, 10),
    topPriceIncreases: (analytics.topPriceIncreases || []).slice(0, 10),
    topPriceDecreases: (analytics.topPriceDecreases || []).slice(0, 10),
    changedPriceItems: (analytics.changedPriceItems || []).slice(0, 20),
    highestUnit: analytics.highestUnit || null,
    highestLine: analytics.highestLine || null
  };
}

async function buildFallbackEvidence(request, prompt, history) {
  if (isListaLarDataQuestion(prompt, history)) {
    try {
      const analyticsRequest = {
        ...request,
        data: { ...(request.data || {}), project: 'listalar', days: 0 }
      };
      const analytics = await firestoreExplorer.firebaseSpendingAnalytics.run(analyticsRequest);
      return [compactListaLarAnalytics(analytics)];
    } catch (error) {
      console.error('Gemini fallback ListaLar analytics error', error);
      return [{ tool: 'listalar_analytics', ok: false, error: String(error?.message || error) }];
    }
  }

  if (isCodeQuestion(prompt, history)) {
    try {
      return [await githubInvestigate(prompt, history)];
    } catch (error) {
      console.error('Gemini fallback GitHub error', error);
      return [{ tool: 'github_investigate', ok: false, error: String(error?.message || error) }];
    }
  }

  if (isMemoryQuestion(prompt)) {
    return [await memorySearch(prompt)];
  }

  return [];
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => String(part?.text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function callGemini(prompt, history, evidence) {
  const systemInstruction = [
    'Você é Nexus, agente técnico central do Giva.',
    'Responda em português do Brasil, de forma direta, precisa e racional.',
    'Você está sendo usado como fallback porque o provedor principal ficou indisponível ou atingiu cota.',
    'Fatos de projetos, código, memória e dados operacionais só podem vir das evidências fornecidas.',
    'Se houver evidência do ListaLar, use os dados e não invente valores.',
    'Para código, cite arquivo e linhas quando presentes nos trechos.',
    'Não invente deploy, merge, gravação, alteração ou ação que não esteja comprovada.',
    'Se as evidências forem insuficientes, diga claramente o que falta.',
    'Esta rota é somente leitura.'
  ].join(' ');

  const contents = history.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }]
  }));

  const evidenceText = clampText(JSON.stringify(evidence), MAX_EVIDENCE_CHARS);
  contents.push({
    role: 'user',
    parts: [{
      text: [
        `Pergunta atual: ${prompt}`,
        evidence.length ? `Evidências disponíveis: ${evidenceText}` : 'Não há evidências de projeto necessárias para esta pergunta.',
        'Responda à pergunta atual.'
      ].join('\n')
    }]
  });

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': geminiApiKey.value(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemInstruction }]
          },
          contents,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 900
          }
        })
      }
    );
  } catch (error) {
    console.error('Gemini network error', error);
    throw new HttpsError('unavailable', 'Groq e Gemini estão temporariamente indisponíveis.');
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200);
    console.error('Gemini error', response.status, detail);

    if (response.status === 429 || response.status === 413) {
      throw new HttpsError(
        'resource-exhausted',
        'As cotas disponíveis da Groq e do Gemini estão indisponíveis no momento. Nenhuma alternativa paga foi acionada.'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpsError('failed-precondition', 'A credencial do Gemini foi recusada.');
    }

    throw new HttpsError('internal', 'O fallback Gemini não conseguiu responder.');
  }

  const payload = await response.json();
  const text = extractGeminiText(payload);
  if (!text) {
    throw new HttpsError('internal', 'O Gemini não retornou conteúdo.');
  }

  return text;
}

exports.askNexusAgent = onCall(
  {
    region: 'southamerica-east1',
    secrets: [groqApiKey, githubToken, geminiApiKey],
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  async (request) => {
    assertAuthorized(request);

    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    }

    const history = safeHistory(request.data?.history);

    try {
      const primary = await agentCoreV14.askNexusAgent.run(request);
      return {
        ...primary,
        version: '1.5',
        aiRouter: true,
        provider: primary?.nativeAnalysis ? 'native' : 'groq',
        freeOnlyPolicy: FREE_ONLY
      };
    } catch (error) {
      if (!isProviderFailure(error)) throw error;

      console.warn(
        'AI Router: primary provider unavailable, trying Gemini fallback',
        error?.code || '',
        error?.message || ''
      );

      const evidence = await buildFallbackEvidence(request, prompt, history);
      const answer = await callGemini(prompt, history, evidence);

      return {
        answer,
        agentCore: true,
        version: '1.5',
        aiRouter: true,
        provider: 'gemini',
        fallbackFrom: 'groq',
        providerCallUsed: true,
        toolsUsed: evidence.map((item) => ({
          name: item.tool || 'fallback_context',
          ok: Boolean(item.ok)
        })),
        readOnly: true,
        freeOnlyPolicy: FREE_ONLY
      };
    }
  }
);
