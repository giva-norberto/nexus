const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV19 = require('./agent-core-v19');
const firebaseObserver = require('./firebase-observer');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;
const LISTALAR_PROBE_PROMPT = 'ListaLar usuarios firebase authentication auth firestore status';

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
    .replace(/[^a-z0-9@._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isListaLarPrompt(prompt) {
  const text = normalize(prompt);
  return /\blistalar\b|\blista\s+lar\b|compras-da-casa/.test(text);
}

function hasUserSubject(prompt) {
  const text = normalize(prompt);
  return /\busuari|\busers?\b|\bpessoas?\b|\bcadastrad/.test(text);
}

function isUserCountIntent(prompt) {
  if (!isListaLarPrompt(prompt) || !hasUserSubject(prompt)) return false;
  const text = normalize(prompt);
  return /\bquant|\bqunt|\bqnt|\bqtd|\bquanto|\bquantos|\bnumero|\btotal|\btem\b/.test(text);
}

function isAccessIntent(prompt) {
  if (!isListaLarPrompt(prompt)) return false;
  const text = normalize(prompt);
  return /\bacesso\b|\bacess|\bconect|\bconexao\b|\bpermiss|\bintegrad/.test(text);
}

function valueFromContext(context, field) {
  const match = String(context || '').match(new RegExp(`${field}:\\s*(\\d+)(\\+?)`, 'i'));
  return match ? { value: Number(match[1]), truncated: match[2] === '+' } : null;
}

async function readListaLarOperationalContext() {
  return firebaseObserver.buildFirebaseOperationalContext(LISTALAR_PROBE_PROMPT);
}

function operationalMeta(ok) {
  return {
    agentCore: true,
    version: '1.10',
    provider: 'native',
    firebaseOperationalRead: true,
    toolsUsed: [{ name: 'firebase_project_status', ok }],
    readOnly: true,
    aiQuotaUsed: false
  };
}

async function answerUserCount() {
  const context = await readListaLarOperationalContext();
  const total = valueFromContext(context, 'Authentication\\.totalUsers');
  const enabled = valueFromContext(context, 'Authentication\\.enabledUsers');
  const disabled = valueFromContext(context, 'Authentication\\.disabledUsers');

  if (!total) {
    const authError = /Erros de leitura:.*auth:/i.test(String(context || ''));
    return {
      answer: authError
        ? 'O Nexus está configurado para consultar o Firebase Authentication do ListaLar em modo somente leitura, mas a leitura do Auth falhou nesta execução. Não vou substituir esse dado por métricas de compras.'
        : 'Não consegui confirmar a quantidade de usuários do ListaLar no Firebase Authentication nesta execução.',
      ...operationalMeta(false)
    };
  }

  const suffix = total.truncated ? ' ou mais' : '';
  const details = [];
  if (enabled) details.push(`${enabled.value} ativos`);
  if (disabled?.value) details.push(`${disabled.value} desativados`);

  return {
    answer: `O ListaLar tem ${total.value}${suffix} usuários cadastrados no Firebase Authentication${details.length ? ` (${details.join(' e ')})` : ''}. Contagem confirmada diretamente no Firebase nesta execução, em modo somente leitura.`,
    ...operationalMeta(true)
  };
}

async function answerAccessStatus() {
  const context = await readListaLarOperationalContext();
  const totalUsers = valueFromContext(context, 'Authentication\\.totalUsers');
  const rootCollections = valueFromContext(context, 'Firestore\\.rootCollectionCount');
  const authOk = Boolean(totalUsers);
  const firestoreOk = Boolean(rootCollections);

  if (authOk && firestoreOk) {
    return {
      answer: `Sim. Nesta execução confirmei acesso somente leitura ao Firebase do ListaLar. O Authentication respondeu com ${totalUsers.value}${totalUsers.truncated ? '+' : ''} usuários e o Firestore respondeu com ${rootCollections.value} coleções raiz. O Nexus não precisa adivinhar esse acesso: ele foi verificado agora.`,
      ...operationalMeta(true)
    };
  }

  if (authOk || firestoreOk) {
    const confirmed = [authOk ? 'Authentication' : '', firestoreOk ? 'Firestore' : ''].filter(Boolean).join(' e ');
    return {
      answer: `O Nexus está configurado com acesso somente leitura ao Firebase do ListaLar e consegui confirmar ${confirmed} nesta execução. A outra parte da leitura não foi confirmada agora.`,
      ...operationalMeta(true)
    };
  }

  return {
    answer: 'O Nexus está configurado para observar o Firebase do ListaLar em modo somente leitura, mas não consegui confirmar uma leitura operacional nesta execução. Portanto, não vou afirmar que o acesso está funcionando até obter evidência do Firebase.',
    ...operationalMeta(false)
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

    if (isUserCountIntent(prompt)) return answerUserCount();
    if (isAccessIntent(prompt)) return answerAccessStatus();

    const result = await agentCoreV19.askNexusAgent.run(request);
    return {
      ...result,
      version: '1.10'
    };
  }
);
