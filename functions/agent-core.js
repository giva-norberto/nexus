const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const { TOOL_CATALOG, executeTool } = require('./agent-tools-v20');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1200;
const MAX_TOOLS = 4;
const MAX_EVIDENCE_CHARS = 32000;
const TZ = 'America/Sao_Paulo';

const ALLOWED_ENTITIES = new Set(['users', 'products', 'spending', 'status', 'code', 'memory', 'other']);
const ALLOWED_OPERATIONS = new Set([
  'count', 'sum', 'ranking', 'latest', 'oldest', 'status', 'investigate',
  'compare', 'lookup', 'explain', 'recommend', 'other'
]);
const ALLOWED_METRICS = new Set([
  'userCount', 'lastSignInTime', 'totalSpent', 'purchaseCount', 'itemCount',
  'productSpend', 'priceChangePct', 'minUnitPrice', 'maxUnitPrice',
  'occurrences', 'firebaseStatus', 'codeEvidence', 'memoryMatches'
]);
const ALLOWED_PERIODS = new Set([
  'none', 'all', 'current_month', 'previous_month', 'month', 'last_days',
  'today', 'yesterday', 'range'
]);

const ENTITY_TOOL_HINTS = {
  users: 'firebase_auth_users',
  products: 'listalar_spending_analytics',
  spending: 'listalar_spending_analytics',
  status: 'firebase_project_status',
  code: 'github_investigate',
  memory: 'memory_search'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: clamp(item?.content || item?.text || '', MAX_HISTORY_CHARS)
    }))
    .filter((item) => item.content.trim());
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function providerFailure(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /resource-exhausted|unavailable|internal|429|413|cota|limite|capacity/.test(text);
}

async function callGroq(system, user, { maxTokens = 1000, json = false } = {}) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey.value()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.02,
      max_completion_tokens: maxTokens,
      stream: false,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`Groq HTTP ${response.status}: ${detail}`);
    error.code = response.status === 429 || response.status === 413 ? 'resource-exhausted' : 'internal';
    throw error;
  }

  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Groq retornou resposta vazia.');
  return { text, provider: 'groq' };
}

async function callGemini(system, user, { maxTokens = 1000, json = false } = {}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey.value())}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.02,
          maxOutputTokens: maxTokens,
          ...(json ? { responseMimeType: 'application/json' } : {})
        }
      })
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`Gemini HTTP ${response.status}: ${detail}`);
    error.code = response.status === 429 || response.status === 413 ? 'resource-exhausted' : 'internal';
    throw error;
  }

  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => String(part?.text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) throw new Error('Gemini retornou resposta vazia.');
  return { text, provider: 'gemini' };
}

async function callFree(system, user, options = {}) {
  try {
    return await callGroq(system, user, options);
  } catch (error) {
    if (!providerFailure(error)) throw error;
  }

  try {
    const result = await callGemini(system, user, options);
    return { ...result, fallbackFrom: 'groq' };
  } catch (error) {
    if (providerFailure(error)) return null;
    throw error;
  }
}

async function loadMaps() {
  try {
    const snap = await getFirestore().collection('source_maps').limit(50).get();
    return snap.docs.map((doc) => {
      const value = doc.data() || {};
      return {
        id: doc.id,
        project: String(value.project || doc.id),
        name: String(value.name || value.project || doc.id),
        aliases: Array.isArray(value.aliases) ? value.aliases.map(String) : [],
        sources: Array.isArray(value.sources) ? value.sources : [],
        legacy: false
      };
    });
  } catch (error) {
    console.error('Nexus source_maps read error v3.1', error);
    return [];
  }
}

function legacyMaps() {
  return [
    {
      id: 'pronti-pet',
      project: 'pronti-pet',
      name: 'Pronti Pet',
      aliases: ['pronti pet', 'pronti-pet'],
      legacy: true,
      sources: [{
        id: 'codigo-pronti-pet',
        domain: 'codigo',
        source: 'github',
        tool: 'github_investigate',
        repository: 'giva-norberto/pronti-pet',
        readOnly: true,
        priority: 50
      }]
    },
    {
      id: 'pronti-app',
      project: 'pronti-app',
      name: 'Pronti',
      aliases: ['pronti', 'pronti app', 'pronti-app'],
      legacy: true,
      sources: [{
        id: 'codigo-pronti',
        domain: 'codigo',
        source: 'github',
        tool: 'github_investigate',
        repository: 'giva-norberto/pronti-app',
        readOnly: true,
        priority: 50
      }]
    },
    {
      id: 'nexus',
      project: 'nexus',
      name: 'Nexus',
      aliases: ['nexus'],
      legacy: true,
      sources: [{
        id: 'codigo-nexus',
        domain: 'codigo',
        source: 'github',
        tool: 'github_investigate',
        repository: 'giva-norberto/nexus',
        readOnly: true,
        priority: 50
      }]
    }
  ];
}

function allMaps(configured) {
  const keys = new Set(configured.map((map) => normalize(map.project)));
  return [
    ...configured,
    ...legacyMaps().filter((map) => !keys.has(normalize(map.project)))
  ];
}

function mapTerms(map) {
  return [map.project, map.name, map.id, ...(map.aliases || [])]
    .map(normalize)
    .filter(Boolean);
}

function explicitProject(prompt, maps, requested = '') {
  const direct = normalize(requested);
  if (direct) {
    const found = maps.find((map) => mapTerms(map).includes(direct));
    if (found) return found;
  }

  const text = normalize(prompt);
  const candidates = [];
  for (const map of maps) {
    for (const term of mapTerms(map)) {
      if (term.length >= 3 && text.includes(term)) {
        candidates.push({ map, score: term.length });
        break;
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.map || null;
}

function compactCapabilities(maps) {
  return maps.slice(0, 30).map((map) => ({
    project: map.project,
    name: map.name,
    aliases: (map.aliases || []).slice(0, 20),
    sources: (map.sources || [])
      .filter((source) => source?.readOnly !== false)
      .slice(0, 60)
      .map((source) => ({
        id: String(source?.id || ''),
        domain: String(source?.domain || ''),
        source: String(source?.source || ''),
        tool: String(source?.tool || ''),
        topics: Array.isArray(source?.topics) ? source.topics.slice(0, 30) : [],
        fields: Array.isArray(source?.fields) ? source.fields.slice(0, 30) : [],
        paths: Array.isArray(source?.paths) ? source.paths.slice(0, 12) : [],
        repository: source?.repository ? String(source.repository) : null,
        hasDynamicArgs: /\{[A-Za-z0-9_-]+\}/.test(JSON.stringify(source?.args || {}))
      }))
  }));
}

function semanticRouterSystem() {
  return [
    'Você é o interpretador semântico do Nexus Agent Core v3.1.',
    'Sua tarefa NÃO é procurar palavras-chave literalmente. Entenda o sentido da pergunta, inclusive paráfrases, linguagem coloquial e continuação de conversa.',
    'O catálogo fornecido descreve capacidades e fontes reais. Escolha os sourceIds que precisam ser consultados para responder.',
    'Nunca invente project, sourceId, ferramenta, campo ou período que não faça sentido.',
    'Se a pergunta combinar assuntos, selecione todas as fontes necessárias, no máximo quatro.',
    'Use o histórico recente para resolver referências como "e este mês?", "esse produto", "e no outro app?".',
    'Períodos devem ser representados semanticamente; não calcule timestamps.',
    'Para mês corrente use kind=current_month; mês anterior previous_month; mês nomeado use kind=month com year/month; últimos N dias use last_days; hoje/ontem use today/yesterday; intervalo explícito use range.',
    'reasoning=true somente quando a resposta exigir explicação, análise, recomendação, diagnóstico, comparação interpretativa ou leitura/síntese de código. Soma, contagem, ranking, último acesso e status são factuais.',
    'Retorne SOMENTE JSON válido com este formato:',
    JSON.stringify({
      project: 'chave do projeto ou vazio',
      sourceIds: ['id-da-fonte'],
      entities: ['users|products|spending|status|code|memory|other'],
      operations: ['count|sum|ranking|latest|oldest|status|investigate|compare|lookup|explain|recommend|other'],
      metrics: ['userCount|lastSignInTime|totalSpent|purchaseCount|itemCount|productSpend|priceChangePct|minUnitPrice|maxUnitPrice|occurrences|firebaseStatus|codeEvidence|memoryMatches'],
      limit: null,
      period: {
        kind: 'none|all|current_month|previous_month|month|last_days|today|yesterday|range',
        year: null,
        month: null,
        days: null,
        startDate: null,
        endDate: null,
        label: ''
      },
      reasoning: false,
      needsClarification: false,
      clarification: ''
    }),
    'Exemplos conceituais: "onde meu dinheiro foi mais embora" significa ranking por gasto; "quem está sumido há mais tempo" pode significar login mais antigo; "está de pé?" pode significar status/conectividade quando o contexto é um sistema.',
    'Os exemplos são semânticos, não padrões obrigatórios.'
  ].join(' ');
}

async function interpretSemantically(prompt, history, maps, explicitMap) {
  const catalog = compactCapabilities(explicitMap ? [explicitMap] : maps);
  const current = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(new Date());

  const historyText = history.length
    ? history.map((item) => `${item.role}: ${item.content}`).join('\n')
    : 'nenhum';

  const user = [
    `Data/hora local de referência: ${current}.`,
    `Projeto explicitamente identificado antes da IA: ${explicitMap?.project || 'nenhum'}.`,
    `Histórico recente:\n${historyText}`,
    `Catálogo de capacidades:\n${JSON.stringify(catalog)}`,
    `Ferramentas permitidas:\n${JSON.stringify(TOOL_CATALOG)}`,
    `Pergunta atual:\n${prompt}`
  ].join('\n\n');

  const response = await callFree(semanticRouterSystem(), user, { maxTokens: 1000, json: true });
  if (!response) return null;
  const parsed = parseJson(response.text);
  if (!parsed) return null;
  return { raw: parsed, provider: response.provider, fallbackFrom: response.fallbackFrom || null };
}

function validMapFor(rawProject, maps, explicitMap) {
  const wanted = normalize(rawProject);
  if (wanted) {
    const found = maps.find((map) => mapTerms(map).includes(wanted));
    if (found) return found;
  }
  return explicitMap || null;
}

function uniqueAllowed(values, allowed) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).filter((value) => allowed.has(value)))];
}

function sanitizePeriod(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const kind = ALLOWED_PERIODS.has(String(raw.kind || 'none')) ? String(raw.kind || 'none') : 'none';
  const year = Number(raw.year);
  const month = Number(raw.month);
  const days = Number(raw.days);
  return {
    kind,
    year: Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : null,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
    days: Number.isFinite(days) && days > 0 ? Math.min(3650, Math.floor(days)) : null,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startDate || '')) ? String(raw.startDate) : null,
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.endDate || '')) ? String(raw.endDate) : null,
    label: clamp(raw.label || '', 80)
  };
}

function inferSourceIdsFromEntities(map, entities) {
  const selected = [];
  const seen = new Set();
  for (const entity of entities) {
    const tool = ENTITY_TOOL_HINTS[entity];
    if (!tool || seen.has(tool)) continue;
    const source = (map?.sources || []).find((item) => item?.readOnly !== false && item?.tool === tool);
    if (!source) continue;
    selected.push(String(source.id || ''));
    seen.add(tool);
  }
  return selected.filter(Boolean).slice(0, MAX_TOOLS);
}

function validateSemantic(raw, maps, explicitMap) {
  const map = validMapFor(raw?.project, maps, explicitMap);
  if (!map) return null;

  const entities = uniqueAllowed(raw?.entities, ALLOWED_ENTITIES);
  const operations = uniqueAllowed(raw?.operations, ALLOWED_OPERATIONS);
  const metrics = uniqueAllowed(raw?.metrics, ALLOWED_METRICS);

  const validIds = new Set(
    (map.sources || [])
      .filter((source) => source?.readOnly !== false)
      .map((source) => String(source?.id || ''))
      .filter(Boolean)
  );

  let sourceIds = Array.isArray(raw?.sourceIds)
    ? [...new Set(raw.sourceIds.map(String).filter((id) => validIds.has(id)))]
    : [];

  if (!sourceIds.length) sourceIds = inferSourceIdsFromEntities(map, entities);

  const limit = Number(raw?.limit);
  return {
    map,
    intent: {
      entities,
      operations,
      metrics,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(20, Math.floor(limit)) : null,
      period: sanitizePeriod(raw?.period),
      reasoning: Boolean(raw?.reasoning),
      needsClarification: Boolean(raw?.needsClarification),
      clarification: clamp(raw?.clarification || '', 400),
      sourceIds: sourceIds.slice(0, MAX_TOOLS),
      semantic: true
    }
  };
}

function tokenSet(value) {
  return new Set(
    normalize(value)
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4)
  );
}

function fallbackSemantic(prompt, maps, explicitMap) {
  const map = explicitMap;
  if (!map) return null;

  const promptText = normalize(prompt);
  const promptTokens = tokenSet(prompt);
  const ranked = (map.sources || [])
    .filter((source) => source?.readOnly !== false)
    .map((source) => {
      const phrases = [
        source?.id,
        source?.domain,
        source?.source,
        ...(Array.isArray(source?.topics) ? source.topics : [])
      ].map(normalize).filter(Boolean);

      let score = 0;
      for (const phrase of phrases) {
        if (phrase.length >= 4 && promptText.includes(phrase)) score += 8;
        for (const token of tokenSet(phrase)) if (promptTokens.has(token)) score += 1;
      }
      score += Math.min(2, Number(source?.priority || 0) / 100);
      return { source, score };
    })
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score);

  const sourceIds = [];
  const seenTools = new Set();
  for (const item of ranked) {
    const tool = String(item.source?.tool || '');
    if (!tool || seenTools.has(tool)) continue;
    sourceIds.push(String(item.source.id || ''));
    seenTools.add(tool);
    if (sourceIds.length >= MAX_TOOLS) break;
  }

  return {
    map,
    intent: {
      entities: [],
      operations: [],
      metrics: [],
      limit: null,
      period: { kind: 'none', year: null, month: null, days: null, startDate: null, endDate: null, label: '' },
      reasoning: false,
      needsClarification: false,
      clarification: '',
      sourceIds,
      semantic: false,
      degradedFallback: true
    }
  };
}

function zonedParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  };
}

function localDateTimeMs(year, month, day, hour = 0, minute = 0, second = 0, milli = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(guess);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      milli
    );
    const delta = target - represented;
    guess += delta;
    if (Math.abs(delta) < 1000) break;
  }
  return guess;
}

function currentLocalDate() {
  const p = zonedParts(Date.now());
  return { year: p.year, month: p.month, day: p.day };
}

function nextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function monthRange(year, month, label) {
  const next = nextMonth(year, month);
  return {
    label,
    startMs: localDateTimeMs(year, month, 1),
    endMs: localDateTimeMs(next.year, next.month, 1) - 1
  };
}

function dayRange(year, month, day, label) {
  const base = new Date(Date.UTC(year, month - 1, day));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    label,
    startMs: localDateTimeMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()),
    endMs: localDateTimeMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1
  };
}

function parseIsoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function resolvePeriod(period) {
  const spec = period || { kind: 'none' };
  const current = currentLocalDate();

  if (spec.kind === 'none' || spec.kind === 'all') return null;
  if (spec.kind === 'current_month') return monthRange(current.year, current.month, spec.label || 'este mês');

  if (spec.kind === 'previous_month') {
    const previous = previousMonth(current.year, current.month);
    return monthRange(previous.year, previous.month, spec.label || 'mês passado');
  }

  if (spec.kind === 'month' && spec.year && spec.month) {
    return monthRange(spec.year, spec.month, spec.label || `${String(spec.month).padStart(2, '0')}/${spec.year}`);
  }

  if (spec.kind === 'last_days' && spec.days) {
    return {
      label: spec.label || `últimos ${spec.days} dias`,
      startMs: Date.now() - spec.days * 86400000,
      endMs: Date.now(),
      days: spec.days
    };
  }

  if (spec.kind === 'today') return dayRange(current.year, current.month, current.day, spec.label || 'hoje');

  if (spec.kind === 'yesterday') {
    const previous = new Date(Date.UTC(current.year, current.month - 1, current.day - 1));
    return dayRange(
      previous.getUTCFullYear(),
      previous.getUTCMonth() + 1,
      previous.getUTCDate(),
      spec.label || 'ontem'
    );
  }

  if (spec.kind === 'range') {
    const start = parseIsoDate(spec.startDate);
    const end = parseIsoDate(spec.endDate);
    if (!start && !end) return null;
    return {
      label: spec.label || 'no período solicitado',
      startMs: start ? localDateTimeMs(start.year, start.month, start.day) : null,
      endMs: end ? dayRange(end.year, end.month, end.day, '').endMs : null
    };
  }

  return null;
}

function concreteArgs(source) {
  return !/\{[A-Za-z0-9_-]+\}/.test(JSON.stringify(source?.args || {}));
}

function selectedSources(map, intent) {
  const byId = new Map(
    (map.sources || [])
      .filter((source) => source?.readOnly !== false)
      .map((source) => [String(source?.id || ''), source])
  );

  const selected = [];
  const seenTools = new Set();
  for (const id of intent.sourceIds || []) {
    const source = byId.get(String(id));
    if (!source) continue;
    const tool = String(source?.tool || '');
    if (!tool || seenTools.has(tool)) continue;
    if (!TOOL_CATALOG.some((entry) => entry.name === tool)) continue;
    if (tool === 'firestore_read' && !concreteArgs(source)) continue;
    selected.push(source);
    seenTools.add(tool);
    if (selected.length >= MAX_TOOLS) break;
  }
  return selected;
}

function toolArgs(source, intent, prompt, map) {
  const args = { ...(source?.args || {}) };
  if (!args.project) args.project = map.project;

  const range = resolvePeriod(intent.period);
  if (source.tool === 'listalar_spending_analytics' && range) {
    if (Number.isFinite(range.startMs)) args.startMs = range.startMs;
    if (Number.isFinite(range.endMs)) args.endMs = range.endMs;
    if (range.days) args.days = range.days;
  }

  if (source.tool === 'github_investigate') {
    args.query = prompt;
    if (source.repository) args.repository = source.repository;
  }

  if (source.tool === 'memory_search') args.query = prompt;

  return { args, range };
}

async function runTools(sources, intent, request, prompt, map) {
  const evidence = [];
  const toolsUsed = [];
  let period = null;

  for (const source of sources) {
    const prepared = toolArgs(source, intent, prompt, map);
    if (prepared.range && !period) period = prepared.range;

    try {
      const result = await executeTool(
        source.tool,
        prepared.args,
        request,
        { prompt, githubToken: githubToken.value() }
      );
      evidence.push(result);
      toolsUsed.push({
        name: source.tool,
        sourceId: source.id || null,
        domain: source.domain || null,
        ok: result?.ok !== false
      });
    } catch (error) {
      evidence.push({
        tool: source.tool,
        ok: false,
        error: clamp(error?.message || error, 500)
      });
      toolsUsed.push({
        name: source.tool,
        sourceId: source.id || null,
        domain: source.domain || null,
        ok: false
      });
    }
  }

  return { evidence, toolsUsed, period };
}

function money(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(value || 0));
}

function localDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(parsed);
}

function suffix(period) {
  return period?.label ? ` em ${period.label}` : '';
}

function analyticsAnswer(intent, result, period) {
  const lines = [];
  const periodSuffix = suffix(period);

  if (intent.metrics.includes('totalSpent') || intent.operations.includes('sum')) {
    lines.push(`Total gasto${periodSuffix}: ${money(result?.totalSpent)}.`);
  }
  if (intent.metrics.includes('purchaseCount')) {
    lines.push(`Compras${periodSuffix}: ${result?.purchaseCount ?? 0}.`);
  }
  if (intent.metrics.includes('itemCount')) {
    lines.push(`Itens${periodSuffix}: ${result?.itemCount ?? 0}.`);
  }

  if (intent.metrics.includes('productSpend') || (intent.operations.includes('ranking') && intent.entities.includes('products'))) {
    const items = (result?.topBySpend || []).slice(0, intent.limit || 5);
    if (items.length) {
      lines.push(`Produtos com maior gasto${periodSuffix}:`);
      items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.name || item.key || 'Produto'} — ${money(item.totalSpent)}.`);
      });
    }
  }

  if (intent.metrics.includes('priceChangePct')) {
    const items = (result?.topPriceIncreases || []).slice(0, intent.limit || 5);
    if (items.length) {
      lines.push(`Maiores aumentos de preço${periodSuffix}:`);
      items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.name || item.key || 'Produto'} — ${Number(item.priceChangePct || 0).toFixed(2)}%.`);
      });
    }
  }

  if (intent.metrics.includes('minUnitPrice')) {
    const candidates = (result?.topBySpend || [])
      .filter((item) => Number(item?.minUnitPrice || 0) > 0)
      .sort((a, b) => Number(a.minUnitPrice || 0) - Number(b.minUnitPrice || 0))
      .slice(0, intent.limit || 5);
    if (candidates.length) {
      lines.push(`Menores preços unitários observados${periodSuffix}:`);
      candidates.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.name || item.key || 'Produto'} — ${money(item.minUnitPrice)}.`);
      });
    }
  }

  if (intent.metrics.includes('occurrences')) {
    const items = (result?.topByOccurrences || []).slice(0, intent.limit || 5);
    if (items.length) {
      lines.push(`Produtos mais recorrentes${periodSuffix}:`);
      items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.name || item.key || 'Produto'} — ${item.occurrences || 0} ocorrência(s).`);
      });
    }
  }

  if (!lines.length) {
    lines.push(
      `Total gasto observado${periodSuffix}: ${money(result?.totalSpent)}. ` +
      `Compras: ${result?.purchaseCount ?? 0}. Itens: ${result?.itemCount ?? 0}.`
    );
  }

  return lines.join('\n');
}

function authAnswer(intent, result) {
  const users = Array.isArray(result?.users) ? result.users : [];
  const dated = users
    .filter((user) => user?.lastSignInTime && Number.isFinite(Date.parse(user.lastSignInTime)))
    .sort((a, b) => Date.parse(b.lastSignInTime) - Date.parse(a.lastSignInTime));

  const lines = [];
  if (intent.metrics.includes('userCount') || intent.operations.includes('count')) {
    lines.push(`Total de usuários: ${result?.returned ?? users.length}.`);
  }

  if (intent.operations.includes('latest') && dated[0]) {
    lines.push(
      `Acesso mais recente: ${dated[0].displayName || dated[0].email || dated[0].uid} — ` +
      `${localDateTime(dated[0].lastSignInTime)}.`
    );
  }

  if (intent.operations.includes('oldest') && dated.length) {
    const oldest = dated[dated.length - 1];
    lines.push(
      `Há mais tempo sem novo login: ${oldest.displayName || oldest.email || oldest.uid} — ` +
      `último login em ${localDateTime(oldest.lastSignInTime)}.`
    );
  }

  return lines.join('\n') || `Total de usuários: ${result?.returned ?? users.length}.`;
}

function statusAnswer(result) {
  const auth = result?.authentication;
  const firestore = result?.firestore;
  return [
    auth
      ? `Authentication: ${auth.totalUsers ?? 0} usuário(s), ${auth.enabledUsers ?? 0} ativo(s), ${auth.disabledUsers ?? 0} desativado(s).`
      : '',
    firestore
      ? `Firestore: ${firestore.rootCollectionCount ?? 0} coleção(ões) raiz${firestore.rootCollections?.length ? ` (${firestore.rootCollections.join(', ')})` : ''}.`
      : ''
  ].filter(Boolean).join('\n');
}

function githubAnswer(result) {
  const files = (result?.files || []).filter((item) => item?.path);
  if (!files.length) return 'Nenhum arquivo relevante foi encontrado na investigação do GitHub.';
  return [
    `GitHub ${result.repository || ''}:`,
    ...files.map((item, index) => `${index + 1}. ${item.path}`)
  ].join('\n');
}

function memoryAnswer(result) {
  const matches = (result?.matches || []).slice(0, 8);
  if (!matches.length) return 'Não encontrei memória relevante.';
  return matches.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
}

function deterministicAnswer(intent, evidence, period) {
  const sections = [];
  for (const item of evidence) {
    if (!item || item.ok === false) {
      sections.push(`${item?.tool || 'Ferramenta'}: falha — ${item?.error || 'sem detalhe'}.`);
      continue;
    }

    if (item.tool === 'listalar_spending_analytics') sections.push(analyticsAnswer(intent, item, period));
    else if (item.tool === 'firebase_auth_users') sections.push(authAnswer(intent, item));
    else if (item.tool === 'firebase_project_status') sections.push(statusAnswer(item));
    else if (item.tool === 'github_investigate') sections.push(githubAnswer(item));
    else if (item.tool === 'memory_search') sections.push(memoryAnswer(item));
    else sections.push(clamp(JSON.stringify(item), 3000));
  }

  return sections.filter(Boolean).join('\n\n') || 'Não encontrei evidência suficiente para responder com segurança.';
}

async function synthesize(prompt, history, intent, evidence, deterministic) {
  const system = [
    'Você é Nexus, agente técnico central.',
    'A intenção já foi interpretada semanticamente e as ferramentas já foram executadas.',
    'Responda em português do Brasil, com precisão e objetividade.',
    'Use somente as evidências desta execução para afirmar fatos sobre projetos.',
    'Não invente arquivos, dados, datas, ações, deploys ou alterações.',
    'Quando houver código, use snippets reais para indicar arquivos e evidências; se não bastar, diga que não basta.',
    'Preserve os números e fatos da resposta determinística quando ela estiver correta.',
    'Modo somente leitura. Nenhuma alternativa paga.'
  ].join(' ');

  const historyText = history.length
    ? history.map((item) => `${item.role}: ${item.content}`).join('\n')
    : 'nenhum';

  const user = [
    `Pergunta atual: ${prompt}`,
    `Histórico recente: ${historyText}`,
    `Intenção estruturada: ${JSON.stringify(intent)}`,
    `Evidências: ${clamp(JSON.stringify(evidence), MAX_EVIDENCE_CHARS)}`,
    `Resposta determinística disponível: ${deterministic}`
  ].join('\n\n');

  return callFree(system, user, { maxTokens: 1300, json: false });
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
    const configuredMaps = await loadMaps();
    const maps = allMaps(configuredMaps);
    const explicitMap = explicitProject(prompt, maps, request.data?.project || '');

    let routingProvider = 'native-fallback';
    let routingFallbackFrom = null;
    let routingAiCalls = 0;
    let interpreted = null;

    try {
      const semantic = await interpretSemantically(prompt, history, maps, explicitMap);
      if (semantic) {
        interpreted = validateSemantic(semantic.raw, maps, explicitMap);
        routingProvider = semantic.provider;
        routingFallbackFrom = semantic.fallbackFrom;
        routingAiCalls = 1;
      }
    } catch (error) {
      console.error('Nexus semantic router v3.1 error', error);
      if (!providerFailure(error)) throw error;
    }

    if (!interpreted) interpreted = fallbackSemantic(prompt, maps, explicitMap);

    if (!interpreted) {
      return {
        answer: 'Não consegui identificar com segurança qual projeto ou fonte consultar. Informe o projeto ou cadastre-o no Índice de Fontes.',
        agentCore: true,
        version: '3.1',
        architecture: 'semantic-intent-capability-tool',
        semanticRouting: routingAiCalls > 0,
        routingProvider,
        routingAiCalls,
        readOnly: true,
        freeOnlyPolicy: true
      };
    }

    const { map, intent } = interpreted;

    if (intent.needsClarification && intent.clarification) {
      return {
        answer: intent.clarification,
        agentCore: true,
        version: '3.1',
        architecture: 'semantic-intent-capability-tool',
        sourceMapProject: map.project,
        intent,
        semanticRouting: Boolean(intent.semantic),
        routingProvider,
        routingFallbackFrom,
        routingAiCalls,
        readOnly: true,
        freeOnlyPolicy: true
      };
    }

    const sources = selectedSources(map, intent);
    if (!sources.length) {
      return {
        answer: intent.degradedFallback
          ? 'As IAs gratuitas de interpretação estão indisponíveis e o roteamento de contingência não encontrou uma fonte com confiança suficiente. Nenhuma alternativa paga foi acionada.'
          : `Entendi a intenção, mas o Índice de Fontes de ${map.name} não possui uma capacidade executável compatível.`,
        agentCore: true,
        version: '3.1',
        architecture: 'semantic-intent-capability-tool',
        sourceMapProject: map.project,
        intent,
        semanticRouting: Boolean(intent.semantic),
        routingProvider,
        routingFallbackFrom,
        routingAiCalls,
        readOnly: true,
        freeOnlyPolicy: true
      };
    }

    const { evidence, toolsUsed, period } = await runTools(sources, intent, request, prompt, map);
    const deterministic = deterministicAnswer(intent, evidence, period);

    const needsSynthesis =
      intent.reasoning ||
      intent.entities.includes('code') ||
      intent.operations.some((operation) => ['explain', 'recommend', 'compare', 'investigate'].includes(operation));

    let answer = deterministic;
    let synthesisProvider = 'native';
    let synthesisAiCalls = 0;

    if (needsSynthesis) {
      try {
        const result = await synthesize(prompt, history, intent, evidence, deterministic);
        if (result?.text) {
          answer = result.text;
          synthesisProvider = result.provider;
          synthesisAiCalls = 1;
        }
      } catch (error) {
        console.error('Nexus synthesis v3.1 error', error);
        if (!providerFailure(error)) throw error;
      }
    }

    return {
      answer,
      agentCore: true,
      version: '3.1',
      architecture: 'semantic-intent-capability-tool',
      regexIntentParser: false,
      semanticRouting: Boolean(intent.semantic),
      degradedSemanticFallback: Boolean(intent.degradedFallback),
      sourceMapProject: map.project,
      sourceMapLoaded: !map.legacy,
      intent,
      matchedSources: sources.map((source) => ({
        id: source.id || null,
        domain: source.domain || null,
        tool: source.tool || null
      })),
      toolsUsed,
      evidenceCount: evidence.length,
      routingProvider,
      routingFallbackFrom,
      routingAiCalls,
      synthesisProvider,
      synthesisAiCalls,
      aiCalls: routingAiCalls + synthesisAiCalls,
      readOnly: true,
      freeOnlyPolicy: true
    };
  }
);
