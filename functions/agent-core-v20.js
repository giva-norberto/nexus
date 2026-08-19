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
const MAX_EVIDENCE_CHARS = 26000;
const FREE_ONLY = true;

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
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
  const start = String(text || '').indexOf('{');
  const end = String(text || '').lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(String(text).slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function providerFailure(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return code.includes('resource-exhausted') || code.includes('unavailable') || code.includes('internal') ||
    message.includes('cota') || message.includes('limite') || message.includes('capacity') || message.includes('429') || message.includes('413');
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
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey.value())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.05, maxOutputTokens: maxTokens }
    })
  });
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
      return { text: await callGemini(system, messages, maxTokens), provider: 'gemini', fallbackFrom: 'groq' };
    } catch (fallbackError) {
      if (providerFailure(fallbackError)) {
        throw new HttpsError('resource-exhausted', 'As cotas gratuitas de IA disponíveis ao Nexus estão indisponíveis agora. Nenhuma alternativa paga foi acionada.');
      }
      throw fallbackError;
    }
  }
}

function plannerSystem() {
  return [
    'Você é o Planner dinâmico do Nexus.',
    'Sua função é decidir se a pergunta atual precisa de uma ferramenta e qual ferramenta usar.',
    'Não responda a pergunta do usuário; apenas planeje o próximo passo.',
    'Priorize a pergunta ATUAL sobre qualquer contexto histórico conflitante.',
    'Use ferramentas para fatos sobre projetos, usuários, acessos, compras, Firestore, GitHub ou memória. Não adivinhe esses fatos.',
    'Você pode fazer várias etapas: depois de uma ferramenta, receberá a evidência e poderá pedir outra.',
    'Não peça ferramenta já executada com os mesmos argumentos, salvo se a evidência indicar falha recuperável.',
    'Escolha somente ferramentas do catálogo fornecido.',
    'Ações de escrita, deploy, merge, exclusão, Rules, IAM, billing e custos NÃO estão disponíveis neste planner.',
    'Se já houver evidência suficiente, escolha action=answer.',
    'Retorne SOMENTE um objeto JSON válido, sem markdown:',
    '{"action":"tool","tool":"nome","args":{},"reason":"motivo curto"}',
    'ou {"action":"answer","reason":"evidência suficiente ou nenhuma ferramenta necessária"}.',
    `CATÁLOGO: ${JSON.stringify(TOOL_CATALOG)}`
  ].join(' ');
}

function synthesisSystem() {
  return [
    'Você é o Nexus, agente técnico central do Giva.',
    'Responda em português do Brasil de forma direta, natural e racional.',
    'A pergunta atual tem prioridade sobre o histórico.',
    'Quando houver evidências de ferramentas, fatos de projeto só podem vir dessas evidências.',
    'Nunca transforme ausência de evidência em inexistência.',
    'Se uma informação depende de runtime não consultado, diga que não foi verificada.',
    'Para Firebase Authentication, lastSignInTime é o último login registrado pelo Firebase Auth; explique essa limitação apenas quando relevante.',
    'Para GitHub, ausência no repositório não prova ausência no ambiente implantado.',
    'Não invente arquivos, usuários, datas, valores, acessos, deploys ou alterações.',
    'Se a pergunta pedir lista, ranking, último/primeiro, comparação ou cálculo, derive a resposta diretamente dos dados retornados.',
    'Você está em modo somente leitura. Não afirme ter executado escrita, deploy, merge ou mudança de produção.',
    'Nenhuma alternativa paga pode ser acionada.'
  ].join(' ');
}

function compactEvidence(evidence) {
  return clamp(JSON.stringify(evidence), MAX_EVIDENCE_CHARS);
}

async function makePlan(prompt, history, evidence, provider) {
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
  const result = await askProvider(plannerSystem(), messages, 450, provider);
  const plan = parseJson(result.text);
  if (!plan || !['tool', 'answer'].includes(plan.action)) {
    return { plan: { action: 'answer', reason: 'Planner retornou formato inválido; seguir para síntese segura.' }, provider: result.provider, fallbackFrom: result.fallbackFrom };
  }
  return { plan, provider: result.provider, fallbackFrom: result.fallbackFrom };
}

async function synthesize(prompt, history, evidence, provider) {
  const messages = [
    ...history,
    {
      role: 'user',
      content: [
        `PERGUNTA ATUAL: ${prompt}`,
        evidence.length ? `EVIDÊNCIAS CONSULTADAS: ${compactEvidence(evidence)}` : 'EVIDÊNCIAS CONSULTADAS: nenhuma ferramenta foi necessária.',
        'Responda agora à pergunta atual. Não descreva o processo interno do planner, a menos que isso seja útil para explicar a fonte do dado.'
      ].join('\n')
    }
  ];
  return askProvider(synthesisSystem(), messages, 1200, provider);
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
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);

    const history = safeHistory(request.data?.history);
    const evidence = [];
    const toolsUsed = [];
    const signatures = new Set();
    let provider = 'groq';
    let fallbackFrom;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const planned = await makePlan(prompt, history, evidence, provider);
      provider = planned.provider || provider;
      fallbackFrom = planned.fallbackFrom || fallbackFrom;
      const plan = planned.plan;

      if (plan.action === 'answer') break;
      const toolName = String(plan.tool || '');
      const args = plan.args && typeof plan.args === 'object' ? plan.args : {};
      if (!TOOL_CATALOG.some((tool) => tool.name === toolName)) {
        evidence.push({ tool: toolName || '(vazio)', ok: false, error: 'Planner solicitou ferramenta não permitida.' });
        break;
      }

      const signature = `${toolName}:${JSON.stringify(args)}`;
      if (signatures.has(signature)) break;
      signatures.add(signature);

      const toolResult = await executeTool(toolName, args, request, {
        prompt,
        githubToken: githubToken.value()
      });
      evidence.push(toolResult);
      toolsUsed.push({ name: toolName, ok: toolResult?.ok !== false });
    }

    const finalResult = await synthesize(prompt, history, evidence, provider);
    provider = finalResult.provider || provider;
    fallbackFrom = finalResult.fallbackFrom || fallbackFrom;

    return {
      answer: finalResult.text,
      agentCore: true,
      version: '2.0',
      dynamicPlanner: true,
      provider,
      fallbackFrom,
      toolsUsed,
      evidenceCount: evidence.length,
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
