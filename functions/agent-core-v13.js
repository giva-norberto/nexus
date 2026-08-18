const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MODEL_ID = 'openai/gpt-oss-120b';
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_TOOL_CALLS = 2;
const MAX_EVIDENCE_CHARS = 16000;
const MAX_FAMILIES = 100;
const MAX_PURCHASES = 1000;
const MAX_ITEMS = 10000;
const MAX_GITHUB_FILES = 3;
const MAX_GITHUB_FILE_BYTES = 180000;

const REPOSITORIES = {
  'pronti-pet': { name: 'Pronti Pet', fullName: 'giva-norberto/pronti-pet' },
  'pronti-app': { name: 'Pronti', fullName: 'giva-norberto/pronti-app' },
  listalar: { name: 'ListaLar', fullName: 'giva-norberto/ListaLar' },
  nexus: { name: 'Nexus', fullName: 'giva-norberto/nexus' }
};

const PROJECT_ALIASES = {
  'pronti pet': 'pronti-pet', 'pronti-pet': 'pronti-pet', pronti: 'pronti-app',
  'pronti app': 'pronti-app', 'pronti-app': 'pronti-app', listalar: 'listalar',
  'lista lar': 'listalar', nexus: 'nexus'
};

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) throw new HttpsError('permission-denied', 'Usuário não autorizado.');
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function clampText(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY_MESSAGES).map((item) => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: clampText(item?.content || '', 800)
  })).filter((item) => item.content.trim());
}

function words(value) {
  const stop = new Set(['que','para','com','uma','uns','das','dos','por','mais','qual','quais','como','onde','isso','esse','essa','este','esta','nexus','projeto','sobre','meu','minha','nos','nas']);
  return [...new Set(normalize(value).replace(/[^a-z0-9_-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 18);
}

async function callGroq(messages, maxTokens = 800, temperature = 0.1) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages, temperature, max_completion_tokens: maxTokens, stream: false })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200);
    console.error('Groq error', response.status, detail);
    if (response.status === 413 || response.status === 429) throw new HttpsError('resource-exhausted', 'Limite de capacidade da IA atingido. Tente novamente em instantes.');
    if (response.status === 401 || response.status === 403) throw new HttpsError('failed-precondition', 'Credencial da IA recusada.');
    throw new HttpsError('internal', 'Falha ao consultar a IA.');
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new HttpsError('internal', 'A IA não retornou conteúdo.');
  return content;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const start = String(text).indexOf('{');
  const end = String(text).lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(String(text).slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function resolveProject(value, prompt, history = []) {
  const direct = normalize(value);
  if (REPOSITORIES[direct]) return direct;
  if (PROJECT_ALIASES[direct]) return PROJECT_ALIASES[direct];
  const text = normalize(`${prompt} ${history.slice(-4).map((x) => x.content).join(' ')}`);
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) if (text.includes(alias)) return key;
  return '';
}

function hasListaLarContext(prompt, history) {
  return resolveProject('', prompt, history) === 'listalar';
}

function isOperationalDataQuestion(prompt, history) {
  if (!hasListaLarContext(prompt, history)) return false;
  const text = normalize(prompt);
  const dataTerms = /compra|compras|produto|produtos|item|itens|gasto|gastei|preco|precos|valor|valores|aument|subiu|queda|baixou|barato|barata|caro|cara|frequencia|vezes|historico|mercado|estabelecimento/;
  const codeTerms = /codigo|arquivo|funcao|bug|erro no codigo|implementacao|arquitetura|repositorio|github|linha|commit|branch|pull request|\bpr\b/;
  return dataTerms.test(text) && !codeTerms.test(text);
}

function isCodeQuestion(prompt, history) {
  const text = normalize(prompt);
  const project = resolveProject('', prompt, history);
  return Boolean(project && /codigo|arquivo|funcao|bug|erro|implementacao|arquitetura|repositorio|github|linha|commit|branch|pull request|\bpr\b|investig/.test(text));
}

function isMemoryQuestion(prompt) {
  return /meu nome|minha preferencia|lembra|memoria|regra|decisao|guardei|salvei|quem sou/.test(normalize(prompt));
}

function deterministicPlan(prompt, history) {
  if (isOperationalDataQuestion(prompt, history)) {
    return { objective: prompt, project: 'listalar', entities: [], tools: [{ name: 'listalar_analytics', args: { project: 'listalar', query: prompt } }], needsClarification: false, clarification: '', deterministic: true };
  }
  if (isCodeQuestion(prompt, history)) {
    const project = resolveProject('', prompt, history);
    return { objective: prompt, project, entities: [], tools: [{ name: 'github_investigate', args: { project, query: prompt } }], needsClarification: false, clarification: '', deterministic: true };
  }
  if (isMemoryQuestion(prompt)) {
    return { objective: prompt, project: '', entities: [], tools: [{ name: 'memory_search', args: { query: prompt } }], needsClarification: false, clarification: '', deterministic: true };
  }
  return null;
}

async function plan(prompt, history) {
  const fixed = deterministicPlan(prompt, history);
  if (fixed) return fixed;
  const system = [
    'Você é o planejador do Nexus. Retorne somente um objeto JSON, sem markdown.',
    'Ferramentas: memory_search, github_investigate, listalar_analytics.',
    'ListaLar factual (compras/preços/produtos/gastos) => listalar_analytics.',
    'Código/bug/arquivo/repositório => github_investigate.',
    'Memória/regra/preferência => memory_search.',
    'Máximo 2 ferramentas.',
    'Formato: {"objective":"...","project":"...","entities":[],"tools":[{"name":"...","args":{}}],"needsClarification":false,"clarification":""}'
  ].join(' ');
  try {
    const raw = await callGroq([{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }], 350, 0);
    const parsed = parseJson(raw);
    if (!parsed || !Array.isArray(parsed.tools)) return { objective: prompt, project: '', entities: [], tools: [], needsClarification: false, clarification: '', plannerFallback: true };
    parsed.tools = parsed.tools.filter((t) => ['memory_search','github_investigate','listalar_analytics'].includes(t?.name)).slice(0, MAX_TOOL_CALLS);
    return parsed;
  } catch (error) {
    console.error('Planner fallback', error?.code || '', error?.message || error);
    return { objective: prompt, project: '', entities: [], tools: [], needsClarification: false, clarification: '', plannerFallback: true };
  }
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${githubToken.value()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nexus-Agent-Core' }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

function encodePath(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }

function scorePath(path, terms) {
  const p = normalize(path); const name = p.split('/').pop() || ''; let score = 0;
  for (const term of terms) { if (name === term) score += 12; else if (name.includes(term)) score += 7; else if (p.includes(term)) score += 3; }
  if (/firebase|firestore|auth|status|agenda|atendimento|cliente|gasto|item|function|service|api/.test(name)) score += 1;
  return score;
}

async function toolGithubInvestigate(args, userPrompt) {
  const projectKey = resolveProject(args?.project, userPrompt);
  const repo = REPOSITORIES[projectKey];
  if (!repo) return { tool: 'github_investigate', ok: false, error: 'Projeto GitHub não identificado.' };
  const query = String(args?.query || userPrompt).trim();
  const meta = await githubFetch(`/repos/${repo.fullName}`); const branch = meta.default_branch || 'main';
  const treePayload = await githubFetch(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const tree = Array.isArray(treePayload?.tree) ? treePayload.tree : []; const terms = words(query);
  const refs = String(query).match(/[A-Za-z0-9_@./-]+\.(?:js|jsx|ts|tsx|html|css|json|md|rules|yml|yaml)\b/gi) || [];
  let candidates = tree.filter((x) => x.type === 'blob' && Number(x.size || 0) <= MAX_GITHUB_FILE_BYTES)
    .map((x) => ({ ...x, score: scorePath(x.path, terms) + (refs.some((ref) => normalize(x.path).endsWith(normalize(ref))) ? 100 : 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || Number(a.size || 0) - Number(b.size || 0)).slice(0, MAX_GITHUB_FILES);
  if (!candidates.length) candidates = tree.filter((x) => x.type === 'blob' && Number(x.size || 0) <= 60000).slice(0, 2);
  const files = [];
  for (const candidate of candidates) {
    try {
      const payload = await githubFetch(`/repos/${repo.fullName}/contents/${encodePath(candidate.path)}?ref=${encodeURIComponent(branch)}`);
      if (payload?.encoding !== 'base64' || !payload?.content) continue;
      const decoded = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8'); const lines = decoded.split('\n'); const hits = [];
      for (let i = 0; i < lines.length; i += 1) if (terms.some((term) => term.length >= 4 && normalize(lines[i]).includes(term))) hits.push(i);
      const centers = hits.length ? hits.slice(0, 3) : [0]; const selected = new Set();
      for (const center of centers) for (let i = Math.max(0, center - 6); i <= Math.min(lines.length - 1, center + 10); i += 1) selected.add(i);
      const snippet = [...selected].sort((a, b) => a - b).slice(0, 100).map((i) => `${i + 1}: ${lines[i]}`).join('\n');
      files.push({ path: candidate.path, sha: payload.sha || candidate.sha || '', snippet: clampText(snippet, 3500) });
    } catch (error) { console.error('Agent GitHub file error', candidate.path, error); }
  }
  return { tool: 'github_investigate', ok: true, project: repo.name, repository: repo.fullName, defaultBranch: branch, files };
}

async function toolMemorySearch(args, userPrompt) {
  const db = getFirestore(); const snap = await db.collection('memory').orderBy('createdAt', 'desc').limit(60).get();
  const queryTerms = words(args?.query || userPrompt); const project = normalize(args?.project || '');
  const matches = snap.docs.map((doc) => { const data = doc.data() || {}; const hay = normalize(`${data.project || ''} ${data.type || ''} ${data.text || ''}`);
    let score = queryTerms.reduce((total, term) => total + (hay.includes(term) ? 1 : 0), 0); if (project && normalize(data.project).includes(project)) score += 3;
    return { id: doc.id, project: String(data.project || ''), type: String(data.type || ''), text: clampText(data.text || '', 500), score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  return { tool: 'memory_search', ok: true, matches };
}

function getListaLarApp() {
  const name = 'nexus-agent-listalar'; const existing = getApps().find((app) => app.name === name); if (existing) return existing;
  try { return getApp(name); } catch (_) { return initializeApp({ credential: applicationDefault(), projectId: 'compras-da-casa' }, name); }
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = String(value ?? '').trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '').replace(',', '.'); else text = text.replace(',', '.');
  const parsed = Number(text); return Number.isFinite(parsed) ? parsed : 0;
}
function money(value) { return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100; }
function dateMs(value) {
  if (!value) return NaN; if (typeof value.toMillis === 'function') return value.toMillis(); if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value; const parsed = Date.parse(String(value)); return Number.isFinite(parsed) ? parsed : NaN;
}

function isAmbiguousPurchaseMetric(prompt) {
  const text = normalize(prompt);
  if (!/mais comprei|comprei mais|onde compro mais|mercado.*mais compra/.test(text)) return false;
  return !/valor|gasto|gastei|reais|r\$|vezes|quantidade de compras|numero de compras|frequencia/.test(text);
}

async function toolListaLarAnalytics(args, userPrompt, history = []) {
  const db = getFirestore(getListaLarApp());
  const productHint = normalize(args?.product || args?.entity || '');
  const days = Math.max(0, Math.min(3650, Number(args?.days || 0))); const cutoff = days ? Date.now() - days * 86400000 : null;
  const families = await db.collection('familias').limit(MAX_FAMILIES).get();
  const productsMap = new Map(); const establishmentsMap = new Map(); let purchases = 0, itemRows = 0, totalSpent = 0;

  for (const family of families.docs) {
    if (purchases >= MAX_PURCHASES || itemRows >= MAX_ITEMS) break;
    const gastos = await family.ref.collection('gastos').limit(MAX_PURCHASES - purchases).get();
    for (const gastoDoc of gastos.docs) {
      if (purchases >= MAX_PURCHASES || itemRows >= MAX_ITEMS) break;
      const gasto = gastoDoc.data() || {}; const purchaseMs = dateMs(gasto.dataCompraMs || gasto.dataCompra || gasto.criadoEm);
      if (cutoff && Number.isFinite(purchaseMs) && purchaseMs < cutoff) continue;
      purchases += 1;
      const purchaseTotal = Math.max(0, toNumber(gasto.valorTotal)); totalSpent += purchaseTotal;
      const establishmentName = String(gasto.estabelecimentoNome || 'Estabelecimento não informado').trim();
      const establishmentKey = normalize(establishmentName) || 'nao-informado';
      const establishment = establishmentsMap.get(establishmentKey) || { name: establishmentName, totalSpent: 0, purchaseCount: 0, itemRows: 0, itemValue: 0, lastPurchase: null };
      establishment.totalSpent += purchaseTotal; establishment.purchaseCount += 1;
      if (Number.isFinite(purchaseMs) && (!establishment.lastPurchase || purchaseMs > establishment.lastPurchase.ms)) establishment.lastPurchase = { ms: purchaseMs, date: new Date(purchaseMs).toISOString() };

      const itemSnap = await gastoDoc.ref.collection('itens').limit(MAX_ITEMS - itemRows).get();
      for (const itemDoc of itemSnap.docs) {
        if (itemRows >= MAX_ITEMS) break;
        itemRows += 1; establishment.itemRows += 1;
        const item = itemDoc.data() || {};
        const name = String(item.descricao || item.descricaoOriginal || 'Item sem descrição').trim(); const productId = String(item.produtoId || '').trim(); const gtin = String(item.gtin || '').trim();
        const key = productId ? `p:${productId}` : gtin ? `g:${gtin}` : `d:${normalize(name)}`;
        const quantity = Math.max(0, toNumber(item.quantidade)); const unitPrice = Math.max(0, toNumber(item.precoUnitario)); const lineTotal = Math.max(0, toNumber(item.valorTotal) || quantity * unitPrice);
        establishment.itemValue += lineTotal;
        const current = productsMap.get(key) || { key, name, totalSpent: 0, quantity: 0, occurrences: 0, history: [] };
        current.totalSpent += lineTotal; current.quantity += quantity; current.occurrences += 1;
        if (name.length > current.name.length) current.name = name;
        if (current.history.length < 40) current.history.push({ dateMs: Number.isFinite(purchaseMs) ? purchaseMs : null, date: Number.isFinite(purchaseMs) ? new Date(purchaseMs).toISOString() : null, unitPrice: money(unitPrice), quantity, lineTotal: money(lineTotal), establishment: establishmentName });
        productsMap.set(key, current);
      }
      establishmentsMap.set(establishmentKey, establishment);
    }
  }

  const products = [...productsMap.values()].map((product) => {
    const historyRows = product.history.filter((entry) => entry.unitPrice > 0).sort((a, b) => (a.dateMs ?? Number.MAX_SAFE_INTEGER) - (b.dateMs ?? Number.MAX_SAFE_INTEGER));
    const first = historyRows[0] || null; const last = historyRows[historyRows.length - 1] || null;
    const change = first && last ? money(last.unitPrice - first.unitPrice) : 0; const changePct = first && last && first.unitPrice > 0 ? Math.round((change / first.unitPrice) * 10000) / 100 : 0;
    return { name: product.name, totalSpent: money(product.totalSpent), quantity: Math.round(product.quantity * 1000) / 1000, occurrences: product.occurrences, avgUnitPrice: product.quantity > 0 ? money(product.totalSpent / product.quantity) : 0,
      firstUnitPrice: first?.unitPrice || 0, lastUnitPrice: last?.unitPrice || 0, firstDate: first?.date || null, lastDate: last?.date || null, priceChange: change, priceChangePct: changePct,
      minUnitPrice: historyRows.length ? Math.min(...historyRows.map((entry) => entry.unitPrice)) : 0, maxUnitPrice: historyRows.length ? Math.max(...historyRows.map((entry) => entry.unitPrice)) : 0,
      history: historyRows.slice(-8).map(({ dateMs: _, ...entry }) => entry) };
  });

  const establishments = [...establishmentsMap.values()].map((entry) => ({
    name: entry.name,
    totalSpent: money(entry.totalSpent),
    purchaseCount: entry.purchaseCount,
    itemRows: entry.itemRows,
    itemValue: money(entry.itemValue),
    lastPurchaseDate: entry.lastPurchase?.date || null
  }));

  const contextText = normalize(`${userPrompt} ${history.slice(-6).map((item) => item.content).join(' ')}`);
  const mentionedEstablishments = establishments.filter((entry) => {
    const name = normalize(entry.name);
    if (!name || name === 'estabelecimento nao informado') return false;
    const significant = name.split(' ').filter((part) => part.length >= 3);
    return contextText.includes(name) || (significant.length >= 2 && significant.every((part) => contextText.includes(part)));
  }).slice(0, 8);

  const matching = productHint ? products.filter((product) => normalize(product.name).includes(productHint) || productHint.split(' ').every((word) => normalize(product.name).includes(word))) : [];
  return {
    tool: 'listalar_analytics', ok: true, readOnly: true,
    summary: { purchases, itemRows, uniqueProducts: products.length, uniqueEstablishments: establishments.length, totalSpent: money(totalSpent), days: days || null },
    productHint: productHint || null,
    matchingProducts: matching.slice(0, 6),
    topSpend: [...products].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 6),
    topFrequency: [...products].sort((a, b) => b.occurrences - a.occurrences).slice(0, 6),
    priceIncreases: products.filter((product) => product.occurrences >= 2 && product.priceChange > 0).sort((a, b) => b.priceChangePct - a.priceChangePct).slice(0, 6),
    priceDecreases: products.filter((product) => product.occurrences >= 2 && product.priceChange < 0).sort((a, b) => a.priceChangePct - b.priceChangePct).slice(0, 6),
    mostExpensive: [...products].sort((a, b) => b.maxUnitPrice - a.maxUnitPrice).slice(0, 6),
    topEstablishmentsBySpend: [...establishments].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 8),
    topEstablishmentsByPurchases: [...establishments].sort((a, b) => b.purchaseCount - a.purchaseCount || b.totalSpent - a.totalSpent).slice(0, 8),
    mentionedEstablishments,
    ambiguity: isAmbiguousPurchaseMetric(userPrompt) ? {
      type: 'purchase_metric',
      message: 'A expressão "mais comprei" pode significar maior valor gasto ou maior número de compras. Responda as duas métricas, salvo se o usuário especificar uma.'
    } : null,
    interpretationHint: normalize(args?.query || userPrompt)
  };
}

async function executeTool(call, prompt, history) {
  if (call.name === 'memory_search') return toolMemorySearch(call.args || {}, prompt);
  if (call.name === 'github_investigate') return toolGithubInvestigate(call.args || {}, prompt);
  if (call.name === 'listalar_analytics') return toolListaLarAnalytics(call.args || {}, prompt, history);
  return { tool: call.name, ok: false, error: 'Ferramenta não permitida.' };
}

function compactEvidence(evidence) {
  return evidence.map((item) => {
    if (item?.tool === 'listalar_analytics') return item;
    if (item?.tool === 'github_investigate') return { ...item, files: (item.files || []).slice(0, 3).map((f) => ({ path: f.path, sha: f.sha, snippet: clampText(f.snippet, 3500) })) };
    if (item?.tool === 'memory_search') return { ...item, matches: (item.matches || []).slice(0, 8) };
    return item;
  });
}

exports.askNexusAgent = onCall(
  { region: 'southamerica-east1', secrets: [groqApiKey, githubToken], maxInstances: 1, timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    assertAuthorized(request);
    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    const history = safeHistory(request.data?.history); const planResult = await plan(prompt, history);
    if (planResult.needsClarification && planResult.clarification) return { answer: String(planResult.clarification), agentCore: true, plan: planResult, toolsUsed: [] };

    const evidence = [];
    for (const call of planResult.tools || []) {
      try { evidence.push(await executeTool(call, prompt, history)); }
      catch (error) { console.error('Agent tool failed', call?.name, error); evidence.push({ tool: call?.name || 'unknown', ok: false, error: String(error?.message || error) }); }
    }

    const compact = compactEvidence(evidence); const evidenceText = clampText(JSON.stringify(compact), MAX_EVIDENCE_CHARS);
    const system = [
      'Você é Nexus, agente técnico central do Giva. Responda em português do Brasil, direto, preciso e racional.',
      'Fatos de projetos e dados só podem vir das evidências fornecidas.',
      'Se listalar_analytics retornou dados, responda pelos dados do Firestore e nunca por explicação do código.',
      'Nunca calcule total por estabelecimento somando apenas produtos visíveis; use somente as métricas de estabelecimento fornecidas pela ferramenta.',
      'Quando a pergunta tiver duas interpretações razoáveis e ambas puderem ser calculadas, não escolha uma silenciosamente: informe as duas e diga qual métrica está usando na conclusão.',
      'Em "onde/qual mercado comprei mais", se não houver métrica explícita, compare valor total gasto E número de compras.',
      'Para aumento/queda de preço, compare primeiro e último preço cronológico e informe percentual.',
      'Não chame aumento do último preço de aumento do preço médio, salvo se a média tiver sido realmente calculada e comparada.',
      'Para código, cite arquivo e linhas quando existirem.',
      'Não invente ações, deploy, merge ou gravações. Esta função é somente leitura.',
      'Se não houver evidência suficiente, diga isso em uma frase e explique o que falta.'
    ].join(' ');

    const answer = await callGroq([
      { role: 'system', content: system }, ...history,
      { role: 'user', content: `Pergunta: ${prompt}\nPlano: ${JSON.stringify({ objective: planResult.objective, project: planResult.project, entities: planResult.entities, tools: (planResult.tools || []).map((t) => t.name) })}\nEvidências: ${evidenceText}` }
    ], 800, 0.1);

    return {
      answer,
      agentCore: true,
      version: '1.3',
      plan: { objective: planResult.objective || '', project: planResult.project || '', entities: planResult.entities || [], tools: (planResult.tools || []).map((tool) => tool.name), deterministic: Boolean(planResult.deterministic), plannerFallback: Boolean(planResult.plannerFallback) },
      toolsUsed: evidence.map((item) => ({ name: item.tool, ok: Boolean(item.ok) })),
      readOnly: true
    };
  }
);