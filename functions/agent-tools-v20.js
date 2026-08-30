const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const firestoreExplorer = require('./firestore-explorer');

const MAX_AUTH_USERS = 1000;
const MAX_GITHUB_FILES = 5;
const MAX_GITHUB_FILE_BYTES = 220000;
const MAX_MEMORY_DOCS = 80;

const FIREBASE_PROJECTS = {
  listalar: { key: 'listalar', name: 'ListaLar', projectId: 'compras-da-casa' }
};

// Compatibilidade dos projetos já conectados. Novos repositórios podem vir do source_map
// pelo argumento repository, limitado ao proprietário autorizado.
const REPOSITORIES = {
  'pronti-pet': { name: 'Pronti Pet', fullName: 'giva-norberto/pronti-pet' },
  'pronti-app': { name: 'Pronti', fullName: 'giva-norberto/pronti-app' },
  listalar: { name: 'ListaLar', fullName: 'giva-norberto/ListaLar' },
  nexus: { name: 'Nexus', fullName: 'giva-norberto/nexus' }
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, max = 3000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function words(value) {
  const stop = new Set([
    'que', 'para', 'com', 'uma', 'uns', 'das', 'dos', 'por', 'mais', 'qual', 'quais',
    'como', 'onde', 'isso', 'esse', 'essa', 'este', 'esta', 'nexus', 'projeto', 'sobre',
    'meu', 'minha', 'nos', 'nas', 'tem', 'voce', 'vc'
  ]);
  return [...new Set(
    normalize(value)
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stop.has(word))
  )].slice(0, 20);
}

function resolveFirebaseProject(value) {
  const text = normalize(value);
  if (!text || /listalar|lista lar|compras-da-casa/.test(text)) return FIREBASE_PROJECTS.listalar;
  return null;
}

function sourceMapRepository(value) {
  const repository = String(value || '').trim();
  if (!/^giva-norberto\/[A-Za-z0-9_.-]+$/i.test(repository)) return null;
  return {
    name: repository.split('/')[1],
    fullName: repository
  };
}

function resolveRepo(value, repository) {
  const mapped = sourceMapRepository(repository);
  if (mapped) return mapped;

  const text = normalize(value);
  if (/pronti[- ]?pet/.test(text)) return REPOSITORIES['pronti-pet'];
  if (/pronti[- ]?(app)?/.test(text) && !/pet/.test(text)) return REPOSITORIES['pronti-app'];
  if (/listalar|lista lar/.test(text)) return REPOSITORIES.listalar;
  if (/nexus/.test(text)) return REPOSITORIES.nexus;
  return null;
}

function getProjectApp(project) {
  const name = `nexus-agent-${project.key}`;
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;
  try {
    return getApp(name);
  } catch (_) {
    return initializeApp({ credential: applicationDefault(), projectId: project.projectId }, name);
  }
}

async function firebaseProjectStatus(args = {}) {
  const project = resolveFirebaseProject(args.project);
  if (!project) return { tool: 'firebase_project_status', ok: false, error: 'Projeto Firebase não autorizado.' };
  const app = getProjectApp(project);
  const result = {
    tool: 'firebase_project_status',
    ok: true,
    project: project.name,
    projectId: project.projectId,
    readOnly: true,
    authentication: null,
    firestore: null,
    errors: []
  };

  try {
    const auth = getAuth(app);
    let totalUsers = 0;
    let disabledUsers = 0;
    let recentSignIns30d = 0;
    let pageToken;
    const cutoff = Date.now() - 30 * 86400000;

    do {
      const remaining = MAX_AUTH_USERS - totalUsers;
      if (remaining <= 0) break;
      const page = await auth.listUsers(Math.min(1000, remaining), pageToken);
      for (const user of page.users) {
        totalUsers += 1;
        if (user.disabled) disabledUsers += 1;
        const last = user.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : NaN;
        if (Number.isFinite(last) && last >= cutoff) recentSignIns30d += 1;
      }
      pageToken = page.pageToken;
    } while (pageToken && totalUsers < MAX_AUTH_USERS);

    result.authentication = {
      totalUsers,
      enabledUsers: totalUsers - disabledUsers,
      disabledUsers,
      recentSignIns30d,
      truncated: Boolean(pageToken)
    };
  } catch (error) {
    result.errors.push({ area: 'authentication', message: clamp(error?.message || error, 300) });
  }

  try {
    const collections = await getFirestore(app).listCollections();
    result.firestore = {
      rootCollectionCount: collections.length,
      rootCollections: collections.map((item) => item.id).sort().slice(0, 100),
      truncated: collections.length > 100
    };
  } catch (error) {
    result.errors.push({ area: 'firestore', message: clamp(error?.message || error, 300) });
  }

  result.ok = Boolean(result.authentication || result.firestore);
  return result;
}

async function firebaseAuthUsers(args = {}) {
  const project = resolveFirebaseProject(args.project);
  if (!project) return { tool: 'firebase_auth_users', ok: false, error: 'Projeto Firebase não autorizado.' };

  const requestedLimit = Math.max(1, Math.min(MAX_AUTH_USERS, Number(args.limit || 100)));
  const app = getProjectApp(project);
  const auth = getAuth(app);
  const users = [];
  let pageToken;

  do {
    const remaining = requestedLimit - users.length;
    if (remaining <= 0) break;
    const page = await auth.listUsers(Math.min(1000, remaining), pageToken);

    for (const user of page.users) {
      users.push({
        uid: user.uid,
        email: user.email || null,
        displayName: user.displayName || null,
        disabled: Boolean(user.disabled),
        emailVerified: Boolean(user.emailVerified),
        creationTime: user.metadata?.creationTime || null,
        lastSignInTime: user.metadata?.lastSignInTime || null,
        providerIds: (user.providerData || []).map((item) => item.providerId).filter(Boolean)
      });
      if (users.length >= requestedLimit) break;
    }

    pageToken = page.pageToken;
  } while (pageToken && users.length < requestedLimit);

  users.sort((a, b) => {
    const ta = a.lastSignInTime ? Date.parse(a.lastSignInTime) : -Infinity;
    const tb = b.lastSignInTime ? Date.parse(b.lastSignInTime) : -Infinity;
    return tb - ta;
  });

  return {
    tool: 'firebase_auth_users',
    ok: true,
    project: project.name,
    projectId: project.projectId,
    readOnly: true,
    returned: users.length,
    truncated: Boolean(pageToken),
    sort: 'lastSignInTime desc',
    users
  };
}

async function firestoreRead(args = {}, request) {
  const project = resolveFirebaseProject(args.project);
  if (!project) return { tool: 'firestore_read', ok: false, error: 'Projeto Firebase não autorizado.' };

  const path = String(args.path || '').trim();
  if (!path) return { tool: 'firestore_read', ok: false, error: 'Caminho Firestore não informado.' };

  try {
    const result = await firestoreExplorer.firebaseFirestoreRead.run({
      ...request,
      data: {
        ...(request?.data || {}),
        project: project.key,
        path,
        limit: Math.max(1, Math.min(100, Number(args.limit || 50)))
      }
    });
    return { tool: 'firestore_read', ok: true, ...result };
  } catch (error) {
    return { tool: 'firestore_read', ok: false, error: clamp(error?.message || error, 500), path };
  }
}

function compactAnalytics(value) {
  return {
    tool: 'listalar_spending_analytics',
    ok: true,
    project: value.project,
    projectId: value.projectId,
    readOnly: true,
    periodMode: value.periodMode || null,
    periodStartMs: value.periodStartMs ?? null,
    periodEndMs: value.periodEndMs ?? null,
    periodStart: value.periodStart || null,
    periodEnd: value.periodEnd || null,
    periodDays: value.periodDays ?? null,
    familyCountScanned: value.familyCountScanned,
    purchaseCount: value.purchaseCount,
    itemCount: value.itemCount,
    totalSpent: value.totalSpent,
    uniqueItems: value.uniqueItems,
    priceComparableItems: value.priceComparableItems,
    topBySpend: (value.topBySpend || []).slice(0, 15),
    topByUnitPrice: (value.topByUnitPrice || []).slice(0, 15),
    topByOccurrences: (value.topByOccurrences || []).slice(0, 15),
    topPriceIncreases: (value.topPriceIncreases || []).slice(0, 15),
    topPriceDecreases: (value.topPriceDecreases || []).slice(0, 15),
    changedPriceItems: (value.changedPriceItems || []).slice(0, 30),
    highestUnit: value.highestUnit || null,
    highestLine: value.highestLine || null,
    truncated: Boolean(value.truncated),
    limits: value.limits || null
  };
}

async function listaLarSpendingAnalytics(args = {}, request) {
  try {
    const startMs = Number(args.startMs);
    const endMs = Number(args.endMs);
    const result = await firestoreExplorer.firebaseSpendingAnalytics.run({
      ...request,
      data: {
        ...(request?.data || {}),
        project: 'listalar',
        days: Math.max(0, Math.min(3650, Number(args.days || 0))),
        ...(Number.isFinite(startMs) ? { startMs } : {}),
        ...(Number.isFinite(endMs) ? { endMs } : {})
      }
    });
    return compactAnalytics(result);
  } catch (error) {
    return { tool: 'listalar_spending_analytics', ok: false, error: clamp(error?.message || error, 500) };
  }
}

async function githubFetch(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nexus-Agent'
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
  const name = normalizedPath.split('/').pop() || '';
  let score = 0;

  for (const term of terms) {
    if (name === term) score += 12;
    else if (name.includes(term)) score += 7;
    else if (normalizedPath.includes(term)) score += 3;
  }

  if (/firebase|firestore|auth|function|service|api|config|workflow|rules|package|index|bootstrap/.test(name)) score += 2;
  return score;
}

async function githubInvestigate(args = {}, _request, runtime = {}) {
  const repo = resolveRepo(args.project || args.repository || runtime.prompt, args.repository);
  if (!repo) return { tool: 'github_investigate', ok: false, error: 'Projeto GitHub não identificado.' };

  const query = String(args.query || runtime.prompt || '').trim();
  const token = runtime.githubToken;
  if (!token) return { tool: 'github_investigate', ok: false, error: 'Token GitHub indisponível.' };

  const meta = await githubFetch(`/repos/${repo.fullName}`, token);
  const branch = meta.default_branch || 'main';
  const treePayload = await githubFetch(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
  const tree = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  const blobPaths = tree.filter((item) => item.type === 'blob').map((item) => item.path);
  const terms = words(query);
  const refs = String(query).match(/[A-Za-z0-9_@./-]+\.(?:js|jsx|ts|tsx|html|css|json|md|rules|yml|yaml)\b/gi) || [];

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
      .slice(0, 3);
  }

  const files = [];
  for (const candidate of candidates) {
    try {
      const payload = await githubFetch(
        `/repos/${repo.fullName}/contents/${encodePath(candidate.path)}?ref=${encodeURIComponent(branch)}`,
        token
      );
      if (payload?.encoding !== 'base64' || !payload?.content) continue;

      const decoded = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
      const lines = decoded.split('\n');
      const hits = [];

      for (let i = 0; i < lines.length; i += 1) {
        if (terms.some((term) => term.length >= 4 && normalize(lines[i]).includes(term))) hits.push(i);
      }

      const centers = hits.length ? hits.slice(0, 4) : [0];
      const selected = new Set();
      for (const center of centers) {
        for (let i = Math.max(0, center - 7); i <= Math.min(lines.length - 1, center + 12); i += 1) {
          selected.add(i);
        }
      }

      const snippet = [...selected]
        .sort((a, b) => a - b)
        .slice(0, 140)
        .map((lineNo) => `${lineNo + 1}: ${lines[lineNo]}`)
        .join('\n');

      files.push({
        path: candidate.path,
        sha: payload.sha || candidate.sha || '',
        snippet: clamp(snippet, 6000)
      });
    } catch (error) {
      files.push({ path: candidate.path, error: clamp(error?.message || error, 250) });
    }
  }

  return {
    tool: 'github_investigate',
    ok: true,
    project: repo.name,
    repository: repo.fullName,
    defaultBranch: branch,
    readOnly: true,
    inventory: {
      fileCount: blobPaths.length,
      hasFirestoreRules: blobPaths.some((path) => /(^|\/)firestore\.rules$/i.test(path)),
      hasStorageRules: blobPaths.some((path) => /(^|\/)storage\.rules$/i.test(path)),
      workflows: blobPaths.filter((path) => /^\.github\/workflows\//.test(path)).slice(0, 50),
      pathsSample: blobPaths.slice(0, 250)
    },
    files
  };
}

async function memorySearch(args = {}, _request, runtime = {}) {
  try {
    const db = getFirestore();
    const snapshot = await db.collection('memory').orderBy('createdAt', 'desc').limit(MAX_MEMORY_DOCS).get();
    const query = String(args.query || runtime.prompt || '');
    const terms = words(query);
    const project = normalize(args.project || '');

    const matches = snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        const haystack = normalize(`${data.project || ''} ${data.type || ''} ${data.text || ''}`);
        let score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        if (project && normalize(data.project || '').includes(project)) score += 3;
        return {
          id: doc.id,
          project: String(data.project || ''),
          type: String(data.type || ''),
          text: clamp(data.text || '', 700),
          score
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    return { tool: 'memory_search', ok: true, readOnly: true, matches };
  } catch (error) {
    return { tool: 'memory_search', ok: false, error: clamp(error?.message || error, 500) };
  }
}

const TOOL_CATALOG = [
  {
    name: 'firebase_project_status',
    description: 'Confirma acesso operacional somente leitura ao Firebase do ListaLar e retorna resumo de Authentication e coleções raiz do Firestore.',
    args: { project: 'listalar' }
  },
  {
    name: 'firebase_auth_users',
    description: 'Lista usuários reais do Firebase Authentication do ListaLar com email, nome, status, criação e lastSignInTime.',
    args: { project: 'listalar', limit: '1..1000' }
  },
  {
    name: 'firestore_read',
    description: 'Lê documento ou coleção específica do Firestore do ListaLar em modo somente leitura.',
    args: { project: 'listalar', path: 'caminho Firestore', limit: '1..100' }
  },
  {
    name: 'listalar_spending_analytics',
    description: 'Calcula analytics determinísticos de compras do ListaLar com suporte a período por startMs/endMs ou últimos N dias.',
    args: { days: 'opcional', startMs: 'opcional', endMs: 'opcional' }
  },
  {
    name: 'github_investigate',
    description: 'Investiga código e arquitetura em repositório GitHub autorizado. Pode receber repository do source_map.',
    args: { project: 'opcional', repository: 'giva-norberto/repositorio', query: 'o que investigar' }
  },
  {
    name: 'memory_search',
    description: 'Busca memória persistida do Nexus sobre decisões, preferências, fatos e contexto dos projetos.',
    args: { query: 'o que buscar', project: 'opcional' }
  }
];

async function executeTool(name, args, request, runtime) {
  switch (name) {
    case 'firebase_project_status': return firebaseProjectStatus(args, request, runtime);
    case 'firebase_auth_users': return firebaseAuthUsers(args, request, runtime);
    case 'firestore_read': return firestoreRead(args, request, runtime);
    case 'listalar_spending_analytics': return listaLarSpendingAnalytics(args, request, runtime);
    case 'github_investigate': return githubInvestigate(args, request, runtime);
    case 'memory_search': return memorySearch(args, request, runtime);
    default: return { tool: name, ok: false, error: 'Ferramenta não permitida.' };
  }
}

module.exports = { TOOL_CATALOG, executeTool };
