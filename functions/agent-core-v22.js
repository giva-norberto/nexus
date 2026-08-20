const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { TOOL_CATALOG, executeTool } = require('./agent-tools-v20');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 900;
const MAX_TOOL_ROUNDS = 4;
const MAX_EVIDENCE_CHARS = 32000;
const FREE_ONLY = true;

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

function clamp(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: clamp(item?.content || '', MAX_HISTORY_CHARS)
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
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return code.includes('resource-exhausted') || code.includes('unavailable') || code.includes('internal') ||
    message.includes('cota') || message.includes('limite') || message.includes('capacity') ||
    message.includes('429') || message.includes('413');
}

async function callGroq(messages, maxTokens = 900) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey.value()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.05,
      max_completion_tokens: maxTokens,
      stream: false
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
  return text;
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => String(part?.text || '')).filter(Boolean).join('\n').trim();
}

async function callGemini(system, messages, maxTokens = 900) {
  const contents = messages.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }]
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey.value())}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.05, maxOutputTokens: maxTokens }
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
  const text = extractGeminiText(payload);
  if (!text) throw new Error('Gemini retornou resposta vazia.');
  return text;
}

async function askProvider(system, messages, maxTokens = 900, preferred = 'groq') {
  if (preferred === 'gemini') {
    try {
      return { text: await callGemini(system, messages, maxTokens), provider: 'gemini' };
    } catch (error) {
      if (!providerFailure(error)) throw error;
    }
  }

  try {
    const groqMessages = [{ role: 'system', content: system }, ...messages];
    return { text: await callGroq(groqMessages, maxTokens), provider: 'groq' };
  } catch (error) {
    if (!providerFailure(error)) throw error;
    try {
      return {
        text: await callGemini(system, messages, maxTokens),
        provider: 'gemini',
        fallbackFrom: 'groq'
      };
    } catch (fallbackError) {
      if (providerFailure(fallbackError)) {
        throw new HttpsError(
          'resource-exhausted',
          'As cotas gratuitas de IA disponíveis ao Nexus estão indisponíveis agora. Nenhuma alternativa paga foi acionada.'
        );
      }
      throw fallbackError;
    }
  }
}

function resolveProject(prompt) {
  const text = normalize(prompt);
  if (/pronti[- ]?pet/.test(text)) return 'pronti-pet';
  if (/pronti[- ]?(?:app)?/.test(text) && !/pet/.test(text)) return 'pronti-app';
  if (/listalar|lista lar|compras-da-casa/.test(text)) return 'listalar';
  if (/\bnexus\b/.test(text)) return 'nexus';
  return '';
}

function detectCoverage(prompt) {
  const text = normalize(prompt);
  const project = resolveProject(prompt);
  const listalar = project === 'listalar';

  const auth = listalar && /\busuari|\bconta|\bperfil|\blogin|\blogou|\bacess|\bentr(?:ou|ar|a)|\binativ|\bautentic|\bsign.?in|\bemail\b|\buid\b|\bprovider/.test(text);
  const spending = listalar && /\bcompra|\bcompras|\bgasto|\bgastos|\bgastei|\bpreco|\bprecos|\bproduto|\bprodutos|\bitem|\bitens|\bmercado|\bestabelecimento|\beconomia|\bvalor total|\btotal gasto/.test(text);
  const code = /\bcodigo|\barquivo|\bfuncao|\bbug\b|\berro(?: no| de)? codigo|\bimplementa|\barquitetura|\brepositorio|\bgithub\b|\bcommit\b|\bbranch\b|\bpull request|\bworkflow|\bci\/cd|\bdeploy\b|\brules\b|\bfirestore rules|\bstorage rules/.test(text);
  const memory = /\blembra|\bmemoria|\bguardei|\bsalvei|\bdecisao anterior|\bpreferencia|\bquem sou/.test(text);
  const firebaseStatus = listalar && !auth && !spending && /\bfirebase|\bfirestore|\bstatus|\bsaude|\bconexao|\bconectado|\bacesso ao projeto/.test(text);

  const required = [];
  if (auth) required.push({
    tool: 'firebase_auth_users',
    args: { project: 'listalar', limit: 1000 },
    domain: 'firebase_auth'
  });
  if (spending) required.push({
    tool: 'listalar_spending_analytics',
    args: { days: 0 },
    domain: 'listalar_spending'
  });
  if (firebaseStatus) required.push({
    tool: 'firebase_project_status',
    args: { project: 'listalar' },
    domain: 'firebase_status'
  });
  if (code && project) required.push({
    tool: 'github_investigate',
    args: { project, query: prompt },
    domain: 'github_code'
  });
  if (memory) required.push({
    tool: 'memory_search',
    args: { query: prompt, ...(project ? { project } : {}) },
    domain: 'memory'
  });

  return { project, auth, spending, code, memory, firebaseStatus, required };
}

function plannerSystem(coverage) {
  return [
    'Você é o Planner dinâmico do Nexus.',
    'Decida se a pergunta atual precisa de ferramenta e qual ferramenta usar no próximo passo.',
    'Não responda a pergunta do usuário; apenas planeje.',
    'A pergunta ATUAL tem prioridade absoluta sobre histórico conflitante.',
    'Para fatos atuais de projetos conectados, use dados operacionais reais antes de código.',
    'Firebase Authentication contém usuários, contas, login, inatividade, criação e lastSignInTime do ListaLar.',
    'listalar_spending_analytics contém compras, gastos, produtos e preços do ListaLar.',
    'Firestore contém documentos/dados persistidos do aplicativo.',
    'GitHub contém código, arquivos, bugs e arquitetura; não é substituto para dados operacionais.',
    'Uma pergunta pode exigir MAIS DE UMA ferramenta. Não pare após a primeira se ainda faltar um domínio solicitado.',
    `Cobertura mínima detectada pelo guardião: ${JSON.stringify(coverage.required.map((item) => ({ tool: item.tool, domain: item.domain })))}`,
    'O guardião pode completar ferramentas obrigatórias que o planner esquecer, mas você deve tentar cobrir todos os domínios relevantes por conta própria.',
    'Não invente arquivo, coleção, campo ou dado. Não peça ao usuário arquivos antes de tentar ferramentas disponíveis.',
    'Ações de escrita, exclusão, deploy, merge, Rules, IAM, billing e custos não estão disponíveis.',
    'Retorne SOMENTE JSON válido:',
    '{"action":"tool","tool":"nome","args":{},"reason":"motivo curto"}',
    'ou {"action":"answer","reason":"evidência suficiente ou nenhuma ferramenta necessária"}.',
    `CATÁLOGO: ${JSON.stringify(TOOL_CATALOG)}`
  ].join(' ');
}

function synthesisSystem(coverage) {
  return [
    'Você é o Nexus, agente técnico central do Giva.',
    'Responda em português do Brasil, de forma direta, natural, precisa e racional.',
    'A pergunta atual tem prioridade sobre o histórico.',
    `Data/hora UTC desta execução: ${new Date().toISOString()}.`,
    'Use essa data real para cálculos de dias, períodos, inatividade e recência.',
    'Fatos de projetos só podem vir das evidências de ferramentas retornadas nesta execução.',
    'Nunca transforme ausência de evidência em inexistência.',
    'Quando uma pergunta combinar domínios, combine as evidências de todas as ferramentas relevantes numa única resposta.',
    'Para Firebase Authentication, lastSignInTime é o último login registrado pelo Firebase Auth.',
    'Para GitHub, ausência no repositório não prova ausência no ambiente implantado.',
    'Não invente arquivos, usuários, datas, valores, acessos, deploys ou alterações.',
    'Se a pergunta pedir lista, ranking, último/primeiro, comparação, filtro, contagem ou cálculo, derive o resultado dos dados retornados.',
    `Domínios detectados: ${JSON.stringify({ auth: coverage.auth, spending: coverage.spending, code: coverage.code, memory: coverage.memory, firebaseStatus: coverage.firebaseStatus })}.`,
    'Se houver evidência operacional e evidência de código concorrentes, priorize a operacional para responder estado atual.',
    'Modo somente leitura. Nenhuma alternativa paga pode ser acionada.'
  ].join(' ');
}

function compactEvidence(evidence) {
  return clamp(JSON.stringify(evidence), MAX_EVIDENCE_CHARS);
}

async function makePlan(prompt, history, evidence, provider, coverage) {
  const messages = [
    ...history,
    {
      role: 'user',
      content: [
        `PERGUNTA ATUAL: ${prompt}`,
        evidence.length ? `EVIDÊNCIAS JÁ COLETADAS: ${compactEvidence(evidence)}` : 'EVIDÊNCIAS JÁ COLETADAS: nenhuma',
        'Decida o próximo passo.'
      ].join('\n')
    }
  ];

  const result = await askProvider(plannerSystem(coverage), messages, 500, provider);
  const plan = parseJson(result.text);
  if (!plan || !['tool', 'answer'].includes(plan.action)) {
    return {
      plan: { action: 'answer', reason: 'Planner retornou formato inválido; guardião completará cobertura obrigatória.' },
      provider: result.provider,
      fallbackFrom: result.fallbackFrom
    };
  }
  return { plan, provider: result.provider, fallbackFrom: result.fallbackFrom };
}

async function synthesize(prompt, history, evidence, provider, coverage) {
  const messages = [
    ...history,
    {
      role: 'user',
      content: [
        `PERGUNTA ATUAL: ${prompt}`,
        evidence.length ? `EVIDÊNCIAS CONSULTADAS: ${compactEvidence(evidence)}` : 'EVIDÊNCIAS CONSULTADAS: nenhuma ferramenta foi necessária.',
        'Responda agora somente à pergunta atual.'
      ].join('\n')
    }
  ];
  return askProvider(synthesisSystem(coverage), messages, 1400, provider);
}

function isPlannerToolAllowed(toolName, coverage) {
  if (toolName !== 'github_investigate') return true;
  const hasOperationalDomain = coverage.auth || coverage.spending || coverage.firebaseStatus;
  if (hasOperationalDomain && !coverage.code) return false;
  return true;
}

async function runTool(toolName, args, request, prompt) {
  return executeTool(toolName, args, request, {
    prompt,
    githubToken: githubToken.value()
  });
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
    const coverage = detectCoverage(prompt);
    const evidence = [];
    const toolsUsed = [];
    const rejectedTools = [];
    const signatures = new Set();
    let provider = 'groq';
    let fallbackFrom;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const planned = await makePlan(prompt, history, evidence, provider, coverage);
      provider = planned.provider || provider;
      fallbackFrom = planned.fallbackFrom || fallbackFrom;
      const plan = planned.plan;

      if (plan.action === 'answer') break;

      const toolName = String(plan.tool || '');
      const args = plan.args && typeof plan.args === 'object' ? plan.args : {};

      if (!TOOL_CATALOG.some((tool) => tool.name === toolName)) {
        rejectedTools.push({ name: toolName || '(vazio)', reason: 'Ferramenta não permitida.' });
        continue;
      }

      if (!isPlannerToolAllowed(toolName, coverage)) {
        rejectedTools.push({
          name: toolName,
          reason: 'GitHub rejeitado: pergunta pede dado operacional e não contém intenção de código/arquitetura.'
        });
        continue;
      }

      const signature = `${toolName}:${JSON.stringify(args)}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);

      const toolResult = await runTool(toolName, args, request, prompt);
      evidence.push(toolResult);
      toolsUsed.push({ name: toolName, ok: toolResult?.ok !== false, source: 'planner' });
    }

    const usedNames = new Set(toolsUsed.map((item) => item.name));
    for (const requirement of coverage.required) {
      if (usedNames.has(requirement.tool)) continue;
      const signature = `${requirement.tool}:${JSON.stringify(requirement.args)}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);

      const toolResult = await runTool(requirement.tool, requirement.args, request, prompt);
      evidence.push(toolResult);
      toolsUsed.push({
        name: requirement.tool,
        ok: toolResult?.ok !== false,
        source: 'coverage_guard',
        domain: requirement.domain
      });
      usedNames.add(requirement.tool);
    }

    const finalResult = await synthesize(prompt, history, evidence, provider, coverage);
    provider = finalResult.provider || provider;
    fallbackFrom = finalResult.fallbackFrom || fallbackFrom;

    const requiredNames = coverage.required.map((item) => item.tool);
    const coverageSatisfied = requiredNames.every((name) => usedNames.has(name));

    return {
      answer: finalResult.text,
      agentCore: true,
      version: '2.2',
      dynamicPlanner: true,
      evidenceCoverageGuard: true,
      provider,
      fallbackFrom,
      toolsUsed,
      rejectedTools,
      evidenceCount: evidence.length,
      coverageRequired: requiredNames,
      coverageSatisfied,
      readOnly: true,
      freeOnlyPolicy: FREE_ONLY,
      aiQuotaUsed: true,
      governance: {
        writes: false,
        productionDeploy: false,
        rulesIamBillingChanges: false
      }
    };
  }
);
