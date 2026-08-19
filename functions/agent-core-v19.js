const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV18 = require('./agent-core-v18');
const firebaseObserver = require('./firebase-observer');

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

function isListaLarUserCountQuestion(prompt) {
  const text = normalize(prompt);
  const listalar = /\blistalar\b|\blista\s*lar\b|compras-da-casa/.test(text);
  const userCount = /quantos?\s+(?:usuarios?|pessoas?)|(?:numero|total|quantidade)\s+de\s+usuarios?|usuarios?\s+cadastrados?|tem\s+quantos?\s+usuarios?/.test(text);
  return listalar && userCount;
}

function valueFromContext(context, field) {
  const match = String(context || '').match(new RegExp(`${field}:\\s*(\\d+)(\\+?)`, 'i'));
  return match ? { value: Number(match[1]), truncated: match[2] === '+' } : null;
}

async function listaLarUserCountAnswer(prompt) {
  const context = await firebaseObserver.buildFirebaseOperationalContext(prompt);
  const total = valueFromContext(context, 'Authentication\\.totalUsers');
  const enabled = valueFromContext(context, 'Authentication\\.enabledUsers');
  const disabled = valueFromContext(context, 'Authentication\\.disabledUsers');

  if (!total) {
    const authError = /Erros de leitura:.*auth:/i.test(String(context || ''));
    return {
      answer: authError
        ? 'Não consegui consultar o Firebase Authentication do ListaLar nesta execução. Não vou usar métricas de compras como substituto para a quantidade de usuários.'
        : 'Não consegui confirmar a quantidade de usuários do ListaLar no Firebase Authentication nesta execução.',
      ok: false
    };
  }

  const suffix = total.truncated ? ' ou mais' : '';
  const details = [];
  if (enabled) details.push(`${enabled.value} ativos`);
  if (disabled?.value) details.push(`${disabled.value} desativados`);

  return {
    answer: `O ListaLar tem ${total.value}${suffix} usuários cadastrados no Firebase Authentication${details.length ? ` (${details.join(' e ')})` : ''}. Contagem consultada diretamente no Firebase, em modo somente leitura.`,
    ok: true
  };
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

    if (isListaLarUserCountQuestion(prompt)) {
      const result = await listaLarUserCountAnswer(prompt);
      return {
        answer: result.answer,
        agentCore: true,
        version: '1.9',
        provider: 'native',
        firebaseOperationalRead: true,
        toolsUsed: [{ name: 'firebase_project_status', ok: result.ok }],
        readOnly: true,
        aiQuotaUsed: false
      };
    }

    const result = await agentCoreV18.askNexusAgent.run(request);
    return {
      ...result,
      version: '1.9'
    };
  }
);
