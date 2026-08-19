const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV15 = require('./agent-core-v15');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;

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

function projectsMentioned(value) {
  const text = normalize(value);
  const found = [];

  if (/\bpronti[\s-]+pet\b/.test(text)) found.push('pronti-pet');
  if (/\blista\s*lar\b|\blistalar\b/.test(text)) found.push('listalar');
  if (/\bnexus\b/.test(text)) found.push('nexus');

  if (/\bpronti(?:\s+app)?\b/.test(text) && !/\bpronti[\s-]+pet\b/.test(text)) {
    found.push('pronti-app');
  }

  return [...new Set(found)];
}

function sanitizeHistoryForExplicitProject(prompt, history) {
  const currentProjects = projectsMentioned(prompt);

  // Quando a pergunta atual cita exatamente um projeto, ele tem prioridade
  // sobre referências antigas a outros projetos no histórico da conversa.
  if (currentProjects.length !== 1 || !Array.isArray(history)) {
    return { history: Array.isArray(history) ? history : [], explicitProject: '' };
  }

  const explicitProject = currentProjects[0];
  const filtered = history.filter((item) => {
    const mentioned = projectsMentioned(item?.content || '');
    return mentioned.length === 0 || mentioned.includes(explicitProject);
  });

  return { history: filtered, explicitProject };
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

    const originalHistory = Array.isArray(request.data?.history) ? request.data.history : [];
    const routed = sanitizeHistoryForExplicitProject(prompt, originalHistory);

    const routedRequest = routed.explicitProject
      ? {
          ...request,
          data: {
            ...(request.data || {}),
            history: routed.history
          }
        }
      : request;

    const result = await agentCoreV15.askNexusAgent.run(routedRequest);

    return {
      ...result,
      version: '1.6',
      projectRoutingGuard: Boolean(routed.explicitProject),
      explicitProject: routed.explicitProject || null
    };
  }
);
