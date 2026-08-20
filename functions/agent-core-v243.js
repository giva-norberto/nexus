const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV242 = require('./agent-core-v242');

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

    const result = await agentCoreV242.askNexusAgent.run(request);

    return {
      ...result,
      version: '2.4.3',
      sourceSelectionPolicy: 'independent_per_source',
      minDirectSourceScore: 8
    };
  }
);
