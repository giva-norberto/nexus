const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV24 = require('./agent-core-v24');

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

function explicitAnalysisIntent(prompt) {
  const text = normalize(prompt);
  return /(?:^|\b)(?:analise|analisar|analisa|analise-me|faca uma analise|faça uma análise|quero uma analise|quero análise)(?:\b|$)/.test(text);
}

function sanitizeFactualParticiples(prompt) {
  if (explicitAnalysisIntent(prompt)) return prompt;
  return String(prompt || '').replace(/\banalisad([oa]s?)\b/gi, 'processad$1');
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
    const originalPrompt = String(request.data?.prompt || '').trim();
    if (!originalPrompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    if (originalPrompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    }

    const routedPrompt = sanitizeFactualParticiples(originalPrompt);
    const result = await agentCoreV24.askNexusAgent.run({
      ...request,
      data: {
        ...(request.data || {}),
        prompt: routedPrompt
      }
    });

    return {
      ...result,
      version: '2.4.1',
      intentGuard: true,
      factualParticiplesNormalized: routedPrompt !== originalPrompt
    };
  }
);
