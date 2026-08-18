const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MODEL_ID = 'openai/gpt-oss-120b';
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_CALLS = 3;
const MAX_GITHUB_FILES = 5;
const MAX_GITHUB_FILE_BYTES = 180000;
const MAX_EVIDENCE_CHARS = 36000;
const MAX_FAMILIES = 100;
const MAX_PURCHASES = 1000;
const MAX_ITEMS = 10000;

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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(value) {
  const stop = new Set(['que','para','com','uma','uns','das','dos','por','mais','qual','quais','como','onde','isso','esse','essa','este','esta','nexus','projeto','sobre','meu','minha','nos','nas']);
  return [...new Set(normalize(value).replace(/[^a-z0-9_-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 24);
}

function clampText(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY_MESSAGES).map((item) => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: clampText(item?.content || '', 1600)
  })).filter((item) => item.content.trim());
}

async function callGroq(messages, options = {}) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages,
      temperature: options.temperature ?? 0.1,
      max_completion_tokens: options.maxTokens ?? 1000,
      stream: false,
      ...(options.json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    console.error('Groq error', response.status, detail);
    if (response.status === 429) throw new HttpsError('resource-exhausted', 'Limite de uso da IA atingido.');
    if (response.status === 401 || response.status === 403) throw new HttpsError('failed-precondition', 'Credencial da IA recusada.');
    throw new HttpsError('internal', 'Falha ao consultar a IA.');
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new HttpsError('internal', 'A IA não retornou conteúdo.');
  return content;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  }
}

function resolveProject(value, prompt) {
  const direct = normalize(value);
  if (REPOSITORIES[direct]) return direct;
  if (PROJECT_ALIASES[direct]) return PROJECT_ALIASES[direct];
  const text = normalize(prompt);
  for (const [alias, key] of Object.entries(PROJECT_ALIASES)) if (text.includes(alias)) return key;
  return '';
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken.value()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nexus-Agent-Core'
    }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    console.error('GitHub API error', response.status, path, detail);
    throw new Error(`GitHub HTTP ${response.status}`);
  }
  return response.json();
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function scorePath(path, terms) {
  const p = normalize(path);
  const name = p.split('/').pop() || '';
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 12;
    else if (name.includes(term)) score += 7;
    else if (p.includes(term)) score += 3;
  }
  if (/firebase|firestore|auth|status|agenda|atendimento|cliente|gasto|item|function|service|api/.test(name)) score += 1;
  return score;
}

async function toolGithubInvestigate(args, userPrompt) {
  const projectKey = resolveProject(args?.project, userPrompt);
  const repo = REPOSITORIES[projectKey];
  if (!repo) return { tool: 'github_investigate', ok: false, error: 'Projeto GitHub não identificado.' };
  const query = String(args?.query || userPrompt).trim();
  const meta = await githubFetch(`/repos/${repo.fullName}`);
  const branch = meta.default_branch || 'main';
  const treePayload = await githubFetch(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const tree = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  const terms = words(query);
  const explicitRefs = String(query).match(/[A-Za-z0-9_@./-]+\.(?:js|jsx|ts|tsx|html|css|json|md|rules|yml|yaml)\b/gi) || [];
  let candidates = tree.filter((x) => x.type === 'blob' && Number(x.size || 0) <= MAX_GITHUB_FILE_BYTES)
    .map((x) => ({ ...x, score: scorePath(x.path, terms) + (explicitRefs.some((ref) => normalize(x.path).endsWith(normalize(ref))) ? 100 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.size || 0) - Number(b.size || 0))
    .slice(0, MAX_GITHUB_FILES);
  if (!candidates.length) candidates = tree.filter((x) => x.type === 'blob' && Number(x.size || 0) <= 60000).slice(0, 3);

  const files = [];
  for (const candidate of candidates) {
    try {
      const payload = await githubFetch(`/repos/${repo.fullName}/contents/${encodePath(candidate.path)}?ref=${encodeURIComponent(branch)}`);
      if (payload?.encoding !== 'base64' || !payload?.content) continue;
      const decoded = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
      const lines = decoded.split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = normalize(lines[i]);
        if (terms.some((t) => t.length >= 4 && line.includes(t))) hits.push(i);
      }
      const centers = hits.length ? hits.slice(0, 5) : [0];
      const selected = new Set();
      for (const center of centers) for (let i = Math.max(0, center - 8); i <= Math.min(lines.length - 1, center + 14); i += 1) selected.add(i);
      const snippet = [...selected].sort((a, b) => a - b).slice(0, 180).map((i) => `${i + 1}: ${lines[i]}`).join('\n');
      files.push({ path: candidate.path, sha: payload.sha || candidate.sha || '', snippet: clampText(snippet, 7500) });
    } catch (error) {
      console.error('Agent GitHub file error', candidate.path, error);
    }
  }
  return {
    tool: 'github_investigate', ok: true, project: repo.name, repository: repo.fullName,
    defaultBranch: branch, files, note: files.length ? 'Arquivos reais lidos do GitHub.' : 'Nenhum arquivo relevante pôde ser lido.'
  };
}

async function toolMemorySearch(args, userPrompt) {
  const db = getFirestore();
  const snap = await db.collection('memory').orderBy('createdAt', 'desc').limit(80).get();
  const query = String(args?.query || userPrompt);
  const terms = words(query);
  const project = normalize(args?.project || '');
  const scored = snap.docs.map((doc) => {
    const data = doc.data() || {};
    const hay = normalize(`${data.project || ''} ${data.type || ''} ${data.text || ''}`);
    let score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    if (project && normalize(data.project).includes(project)) score += 3;
    return { id: doc.id, project: String(data.project || ''), type: String(data.type || ''), text: String(data.text || ''), score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  return { tool: 'memory_search', ok: true, matches: scored };
}

function getListaLarApp() {
  const name = 'nexus-agent-listalar';
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;
  try { return getApp(name); } catch (_) {
    return initializeApp({ credential: applicationDefault(), projectId: 'compras-da-casa' }, name);
  }
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = String(value ?? '').trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '').replace(',', '.'); else text = text.replace(',', '.');
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function dateMs(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : NaN;
}

function money(n) { return Math.round((number(n) + Number.EPSILON) * 100) / 100; }

async function toolListaLarAnalytics(args, userPrompt) {
  const db = getFirestore(getListaLarApp());
  const query = normalize(args?.query || userPrompt);
  const productHint = normalize(args?.product || args?.entity || '');
  const days = Math.max(0, Math.min(3650, Number(args?.days || 0)));
  const cutoff = days ? Date.now() - days * 86400000 : null;
  const families = await db.collection('familias').limit(MAX_FAMILIES).get();
  const map = new Map();
  let purchases = 0, itemRows = 0, totalSpent = 0;

  for (const family of families.docs) {
    if (purchases >= MAX_PURCHASES || itemRows >= MAX_ITEMS) break;
    const gastos = await family.ref.collection('gastos').limit(MAX_PURCHASES - purchases).get();
    for (const gastoDoc of gastos.docs) {
      if (purchases >= MAX_PURCHASES || itemRows >= MAX_ITEMS) break;
      const gasto = gastoDoc.data() || {};
      const dms = dateMs(gasto.dataCompraMs || gasto.dataCompra || gasto.criadoEm);
      if (cutoff && Number.isFinite(dms) && dms < cutoff) continue;
      purchases += 1;
      totalSpent += number(gasto.valorTotal);
      const items = await gastoDoc.ref.collection('itens').limit(MAX_ITEMS - itemRows).get();
      for (const itemDoc of items.docs) {
        if (itemRows >= MAX_ITEMS) break;
        itemRows += 1;
        const item = itemDoc.data() || {};
        const name = String(item.descricao || item.descricaoOriginal || 'Item sem descrição').trim();
        const productId = String(item.produtoId || '').trim();
        const gtin = String(item.gtin || '').trim();
        const key = productId ? `p:${productId}` : gtin ? `g:${gtin}` : `d:${normalize(name)}`;
        const qty = Math.max(0, number(item.quantidade));
        const unit = Math.max(0, number(item.precoUnitario));
        const line = Math.max(0, number(item.valorTotal) || qty * unit);
        const current = map.get(key) || { key, name, totalSpent: 0, quantity: 0, occurrences: 0, history: [] };
        current.totalSpent += line; current.quantity += qty; current.occurrences += 1;
        if (name.length > current.name.length) current.name = name;
        if (current.history.length < 60) current.history.push({ dateMs: Number.isFinite(dms) ? dms : null, date: Number.isFinite(dms) ? new Date(dms).toISOString() : null, unitPrice: money(unit), quantity: qty, lineTotal: money(line), establishment: String(gasto.estabelecimentoNome || '') });
        map.set(key, current);
      }
    }
  }

  const products = [...map.values()].map((p) => {
    const history = p.history.filter((h) => h.unitPrice > 0).sort((a, b) => (a.dateMs ?? Number.MAX_SAFE_INTEGER) - (b.dateMs ?? Number.MAX_SAFE_INTEGER));
    const first = history[0] || null, last = history[history.length - 1] || null;
    const change = first && last ? money(last.unitPrice - first.unitPrice) : 0;
    const changePct = first && last && first.unitPrice > 0 ? Math.round((change / first.unitPrice) * 10000) / 100 : 0;
    return {
      name: p.name, totalSpent: money(p.totalSpent), quantity: Math.round(p.quantity * 1000) / 1000, occurrences: p.occurrences,
      avgUnitPrice: p.quantity > 0 ? money(p.totalSpent / p.quantity) : 0,
      firstUnitPrice: first?.unitPrice || 0, lastUnitPrice: last?.unitPrice || 0,
      priceChange: change, priceChangePct: changePct,
      minUnitPrice: history.length ? Math.min(...history.map((h) => h.unitPrice)) : 0,
      maxUnitPrice: history.length ? Math.max(...history.map((h) => h.unitPrice)) : 0,
      history: history.slice(-20).map(({ dateMs: _, ...rest }) => rest)
    };
  });

  const matching = productHint ? products.filter((p) => normalize(p.name).includes(productHint) || productHint.split(' ').every((w) => normalize(p.name).includes(w))) : [];
  const topSpend = [...products].sort((a,b) => b.totalSpent - a.totalSpent).slice(0,10);
  const topFrequency = [...products].sort((a,b) => b.occurrences - a.occurrences).slice(0,10);
  const increases = products.filter((p) => p.occurrences >= 2 && p.priceChange > 0).sort((a,b) => b.priceChangePct - a.priceChangePct).slice(0,10);
  const decreases = products.filter((p) => p.occurrences >= 2 && p.priceChange < 0).sort((a,b) => a.priceChangePct - b.priceChangePct).slice(0,10);
  const mostExpensive = [...products].sort((a,b) => b.maxUnitPrice - a.maxUnitPrice).slice(0,10);
  return {
    tool: 'listalar_analytics', ok: true, readOnly: true,
    summary: { purchases, itemRows, uniqueProducts: products.length, totalSpent: money(totalSpent), days: days || null },
    productHint: productHint || null, matchingProducts: matching.slice(0,12), topSpend, topFrequency, priceIncreases: increases, priceDecreases: decreases, mostExpensive,
    interpretationHint: query
  };
}

async function plan(prompt, history) {
  const plannerSystem = [
    'Você é o planejador do Nexus Agent Core. Sua função é decidir quais ferramentas de SOMENTE LEITURA usar antes de responder.',
    'Retorne APENAS JSON válido.',
    'Ferramentas permitidas: memory_search, github_investigate, listalar_analytics.',
    'Use listalar_analytics para qualquer pergunta factual sobre compras, produtos, gastos, preços, aumento/queda de preço, frequência ou histórico do ListaLar.',
    'Use github_investigate para perguntas sobre código, bug, arquitetura, implementação ou estado de repositório.',
    'Use memory_search quando memória persistente puder ser relevante para regra, decisão, preferência ou contexto do usuário.',
    'Não invente ferramentas. Máximo 3 chamadas. Se a pergunta puder ser respondida conversacionalmente sem dados reais, tools pode ser vazio.',
    'Para continuação como "e onde foi mais barato?", use o histórico para recuperar o assunto/produto anterior.',
    'Formato: {"objective":"...","project":"...","entities":["..."],"tools":[{"name":"...","args":{...}}],"needsClarification":false,"clarification":""}'
  ].join(' ');
  const content = await callGroq([
    { role: 'system', content: plannerSystem },
    ...history,
    { role: 'user', content: prompt }
  ], { json: true, maxTokens: 650, temperature: 0 });
  const parsed = parseJson(content);
  if (!parsed || !Array.isArray(parsed.tools)) return { objective: prompt, project: '', entities: [], tools: [], needsClarification: false };
  parsed.tools = parsed.tools.filter((t) => ['memory_search','github_investigate','listalar_analytics'].includes(t?.name)).slice(0, MAX_TOOL_CALLS);
  return parsed;
}

async function executeTool(call, prompt) {
  if (call.name === 'memory_search') return toolMemorySearch(call.args || {}, prompt);
  if (call.name === 'github_investigate') return toolGithubInvestigate(call.args || {}, prompt);
  if (call.name === 'listalar_analytics') return toolListaLarAnalytics(call.args || {}, prompt);
  return { tool: call.name, ok: false, error: 'Ferramenta não permitida.' };
}

exports.askNexusAgent = onCall(
  { region: 'southamerica-east1', secrets: [groqApiKey, githubToken], maxInstances: 1, timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    assertAuthorized(request);
    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    const history = safeHistory(request.data?.history);

    const planResult = await plan(prompt, history);
    if (planResult.needsClarification && planResult.clarification) {
      return { answer: String(planResult.clarification), agentCore: true, plan: planResult, toolsUsed: [] };
    }

    const evidence = [];
    for (const call of planResult.tools) {
      try { evidence.push(await executeTool(call, prompt)); }
      catch (error) { console.error('Agent tool failed', call?.name, error); evidence.push({ tool: call?.name || 'unknown', ok: false, error: String(error?.message || error) }); }
    }

    const evidenceText = clampText(JSON.stringify(evidence, null, 2), MAX_EVIDENCE_CHARS);
    const answerSystem = [
      'Você é Nexus, agente técnico central do Giva. Responda em português do Brasil.',
      'Responda especificamente ao que foi perguntado; não despeje um relatório padrão.',
      'Use somente as evidências fornecidas para afirmar fatos sobre projetos, compras, preços, GitHub, Firebase ou memória.',
      'Se a evidência não sustentar uma conclusão, diga claramente que não há dados suficientes.',
      'Em perguntas de preço, diferencie preço unitário, total gasto e quantidade.',
      'Em evolução de preço, use cronologia: primeiro preço versus último preço e variação percentual; não confunda mínimo/máximo com tendência.',
      'Em investigação de código, cite caminho do arquivo e linhas quando o snippet trouxer números de linha.',
      'Não diga que alterou, fez merge, deployou ou gravou dados. Esta função é somente leitura.',
      'Se houver várias evidências, sintetize. Evite respostas repetitivas e modelos fixos.'
    ].join(' ');

    const answer = await callGroq([
      { role: 'system', content: answerSystem },
      ...history,
      { role: 'user', content: `Pergunta atual: ${prompt}\n\nPlano do Nexus:\n${JSON.stringify(planResult)}\n\nEvidências reais obtidas pelas ferramentas:\n${evidenceText}` }
    ], { maxTokens: 1200, temperature: 0.15 });

    return {
      answer,
      agentCore: true,
      plan: { objective: planResult.objective || '', project: planResult.project || '', entities: planResult.entities || [], tools: planResult.tools.map((t) => t.name) },
      toolsUsed: evidence.map((x) => ({ name: x.tool, ok: Boolean(x.ok) })),
      readOnly: true
    };
  }
);
