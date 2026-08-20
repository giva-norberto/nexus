const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const { TOOL_CATALOG, executeTool } = require('./agent-tools-v20');
const agentCoreV23 = require('./agent-core-v23');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;
const MAX_DIRECT_SOURCES = 4;
const MIN_DIRECT_SOURCE_SCORE = 8;

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

function stemToken(token) {
  let word = normalize(token).replace(/[^a-z0-9_-]/g, '');
  if (word.length > 5 && word.endsWith('oes')) word = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
  return word;
}

function tokens(value) {
  const stop = new Set([
    'para','com','uma','uns','das','dos','por','mais','qual','quais','como','onde','isso','esse',
    'essa','este','esta','meu','minha','nos','nas','tem','voce','vc','lista','lar','listalar',
    'no','na','do','da','de','e','o','a','os','as','um','ao','aos'
  ]);
  return [...new Set(
    normalize(value)
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .map(stemToken)
      .filter((word) => word.length >= 3 && !stop.has(word))
  )];
}

function resolveProject(prompt) {
  const text = normalize(prompt);
  if (/pronti[- ]?pet/.test(text)) return 'pronti-pet';
  if (/pronti[- ]?(?:app)?/.test(text) && !/pet/.test(text)) return 'pronti-app';
  if (/listalar|lista lar|compras-da-casa/.test(text)) return 'listalar';
  if (/\bnexus\b/.test(text)) return 'nexus';
  return '';
}

async function loadSourceMap(project) {
  if (!project) return null;
  try {
    const snapshot = await getFirestore().collection('source_maps').doc(project).get();
    if (!snapshot.exists) return null;
    const value = snapshot.data() || {};
    return {
      project: String(value.project || project),
      name: String(value.name || project),
      sources: Array.isArray(value.sources) ? value.sources.slice(0, 80) : []
    };
  } catch (error) {
    console.error('Nexus source map read error v2.4', project, error);
    return null;
  }
}

function sourceScore(source, prompt) {
  const promptText = normalize(prompt);
  const promptTokens = new Set(tokens(prompt));
  const phrases = [source.domain, source.source, ...(Array.isArray(source.topics) ? source.topics : [])]
    .map(normalize)
    .filter(Boolean);
  let score = 0;
  for (const phrase of phrases) {
    if (phrase.length >= 4 && promptText.includes(phrase)) score += phrase.includes(' ') ? 14 : 8;
    for (const token of tokens(phrase)) if (promptTokens.has(token)) score += 3;
  }
  score += Math.min(3, Math.max(0, Number(source.priority || 0)) / 100);
  return score;
}

function hasConcreteArgs(args) {
  return !/[{][a-zA-Z0-9_-]+[}]/.test(JSON.stringify(args || {}));
}

function selectSources(map, prompt) {
  if (!Array.isArray(map?.sources)) return [];
  const ranked = map.sources
    .filter((source) => source?.readOnly !== false)
    .filter((source) => TOOL_CATALOG.some((tool) => tool.name === source.tool))
    .map((source) => ({ ...source, matchScore: sourceScore(source, prompt) }))
    .filter((source) => source.matchScore >= MIN_DIRECT_SOURCE_SCORE)
    .sort((a, b) => b.matchScore - a.matchScore || Number(b.priority || 0) - Number(a.priority || 0));
  if (!ranked.length) return [];

  const selected = [];
  const seenTools = new Set();
  for (const source of ranked) {
    if (seenTools.has(source.tool)) continue;
    if (source.tool === 'firestore_read' && !hasConcreteArgs(source.args)) continue;
    selected.push(source);
    seenTools.add(source.tool);
    if (selected.length >= MAX_DIRECT_SOURCES) break;
  }
  return selected;
}

function needsReasoning(prompt) {
  const text = normalize(prompt);
  return /\banalis|\brecomen|\bexplica|\bporque|\bpor que|\bcausa|\btendencia|\bprever|\bprevis|\bestrateg|\bmelhor decis|\bo que voce acha|\bcompare e conclua/.test(text);
}

function money(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(Number.isFinite(number) ? number : 0);
}

function formatDate(value) {
  if (!value) return 'sem registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo'
  }).format(date);
}

function authSummary(result) {
  const users = Array.isArray(result?.users) ? result.users : [];
  const valid = users.filter((user) => user.lastSignInTime && Number.isFinite(Date.parse(user.lastSignInTime)));
  const newest = valid[0] || null;
  const oldest = valid.length ? valid[valid.length - 1] : null;
  const lines = [`Total de usuários retornados: ${result?.returned ?? users.length}.`];
  if (newest) lines.push(`Acesso mais recente: ${newest.displayName || newest.email || newest.uid} — ${newest.email || 'sem e-mail'} — ${formatDate(newest.lastSignInTime)}.`);
  if (oldest) lines.push(`Login mais antigo registrado: ${oldest.displayName || oldest.email || oldest.uid} — ${oldest.email || 'sem e-mail'} — ${formatDate(oldest.lastSignInTime)}.`);
  return lines.join('\n');
}

function analyticsSummary(result) {
  const lines = [
    `Total gasto observado: ${money(result?.totalSpent)}.`,
    `Compras analisadas: ${result?.purchaseCount ?? 0}.`,
    `Itens analisados: ${result?.itemCount ?? 0}.`
  ];
  const top = Array.isArray(result?.topPriceIncreases) ? result.topPriceIncreases[0] : null;
  if (top) {
    lines.push(`Maior aumento de preço observado: ${top.name || top.key || 'item'} — ${Number(top.priceChangePct || 0).toFixed(2)}% (${money(top.firstUnitPrice)} → ${money(top.lastUnitPrice)}).`);
    const history = Array.isArray(top.history) ? top.history.filter((entry) => Number(entry?.unitPrice || 0) > 0) : [];
    if (history.length) {
      const min = [...history].sort((a, b) => Number(a.unitPrice || 0) - Number(b.unitPrice || 0))[0];
      lines.push(`Menor preço observado desse produto: ${money(min.unitPrice)} em ${min.establishment || 'estabelecimento não informado'}${min.date ? `, em ${formatDate(min.date)}` : ''}.`);
    }
  }
  if (result?.truncated) lines.push('Observação: a leitura atingiu limite operacional; o resumo considera os dados retornados.');
  return lines.join('\n');
}

function statusSummary(result) {
  const parts = [];
  if (result?.authentication) {
    const auth = result.authentication;
    parts.push(`Authentication: ${auth.totalUsers ?? 0} usuário(s), ${auth.enabledUsers ?? 0} ativo(s), ${auth.disabledUsers ?? 0} desativado(s).`);
  }
  if (result?.firestore) {
    const fs = result.firestore;
    parts.push(`Firestore: ${fs.rootCollectionCount ?? 0} coleção(ões) raiz${Array.isArray(fs.rootCollections) && fs.rootCollections.length ? ` (${fs.rootCollections.join(', ')})` : ''}.`);
  }
  return parts.join('\n') || 'Status operacional consultado, sem resumo disponível.';
}

function firestoreSummary(result) {
  if (result?.kind === 'document') {
    if (!result.exists) return `Documento ${result.path || ''}: não encontrado.`;
    return `Documento ${result.path || ''}: ${JSON.stringify(result.data || {})}`;
  }
  if (result?.kind === 'collection') {
    return `Coleção ${result.path || ''}: ${result.returned ?? 0} documento(s) retornado(s). ${JSON.stringify((result.documents || []).slice(0, 10))}`;
  }
  return `Firestore: ${JSON.stringify(result || {})}`;
}

function githubSummary(result) {
  const files = Array.isArray(result?.files) ? result.files.map((item) => item.path).filter(Boolean) : [];
  return `GitHub ${result?.repository || ''}: ${files.length ? `arquivos investigados: ${files.join(', ')}` : 'investigação concluída sem arquivo resumível.'}`;
}

function deterministicAnswer(evidence) {
  const sections = [];
  for (const item of evidence) {
    if (!item || item.ok === false) {
      sections.push(`${item?.tool || 'Ferramenta'}: falha na consulta${item?.error ? ` — ${item.error}` : ''}.`);
    } else if (item.tool === 'firebase_auth_users') sections.push(authSummary(item));
    else if (item.tool === 'listalar_spending_analytics') sections.push(analyticsSummary(item));
    else if (item.tool === 'firebase_project_status') sections.push(statusSummary(item));
    else if (item.tool === 'firestore_read') sections.push(firestoreSummary(item));
    else if (item.tool === 'github_investigate') sections.push(githubSummary(item));
    else if (item.tool === 'memory_search') sections.push(`Memória: ${JSON.stringify((item.matches || []).slice(0, 8))}`);
    else sections.push(`${item.tool || 'Ferramenta'}: ${JSON.stringify(item)}`);
  }
  return sections.join('\n\n');
}

async function executeMappedSources(sources, request, prompt) {
  const evidence = [];
  const toolsUsed = [];
  for (const source of sources) {
    const args = source.args && typeof source.args === 'object' ? source.args : {};
    const result = await executeTool(source.tool, args, request, {
      prompt,
      githubToken: githubToken.value()
    });
    evidence.push(result);
    toolsUsed.push({
      name: source.tool,
      ok: result?.ok !== false,
      source: 'source_map_direct',
      sourceId: source.id,
      domain: source.domain,
      matchScore: Math.round(Number(source.matchScore || 0) * 100) / 100
    });
  }
  return { evidence, toolsUsed };
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

    const project = resolveProject(prompt);
    const map = await loadSourceMap(project);
    const selectedSources = selectSources(map, prompt);

    if (!map || !selectedSources.length || needsReasoning(prompt)) {
      const delegated = await agentCoreV23.askNexusAgent.run(request);
      return {
        ...delegated,
        version: '2.4',
        sourceMapDirect: false,
        sourceMapProject: project || null,
        sourceMapLoaded: Boolean(map),
        directReason: !map ? 'source_map_missing' : !selectedSources.length ? 'no_confident_source_match' : 'reasoning_requested'
      };
    }

    const { evidence, toolsUsed } = await executeMappedSources(selectedSources, request, prompt);
    return {
      answer: deterministicAnswer(evidence),
      agentCore: true,
      version: '2.4',
      sourceMapDirect: true,
      sourceMapProject: project,
      sourceMapLoaded: true,
      sourceMapSourceCount: Array.isArray(map.sources) ? map.sources.length : 0,
      matchedSources: selectedSources.map((source) => ({ id: source.id, tool: source.tool, domain: source.domain, score: Math.round(source.matchScore * 100) / 100 })),
      toolsUsed,
      evidenceCount: evidence.length,
      provider: 'native',
      aiQuotaUsed: false,
      zeroAiRoute: true,
      readOnly: true,
      freeOnlyPolicy: true
    };
  }
);
