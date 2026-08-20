const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV20 = require('./agent-core-v20');

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

function mentionsKnownProject(prompt) {
  return /\blistalar\b|\blista lar\b|\bnexus\b|\bpronti(?:[- ]?pet|[- ]?app)?\b/.test(normalize(prompt));
}

function isListaLarAuthDomain(prompt) {
  const text = normalize(prompt);
  const listalar = /\blistalar\b|\blista lar\b|compras-da-casa/.test(text);
  const authDomain = /\busuari|\bconta|\bperfil|\blogin|\blogou|\bacess|\bentr(?:ou|ar|a)|\binativ|\bautentic|\bsign.?in|\bemail\b|\buid\b|\bprovider/.test(text);
  return listalar && authDomain;
}

function toolNames(result) {
  return Array.isArray(result?.toolsUsed)
    ? result.toolsUsed.map((item) => String(item?.name || '')).filter(Boolean)
    : [];
}

function routingPolicy(originalPrompt, strictAuth = false) {
  const lines = [
    'POLÍTICA DE ROTEAMENTO E GROUNDING DO NEXUS v2.1:',
    '1. A PERGUNTA ORIGINAL abaixo é a única pergunta que deve ser respondida.',
    '2. Para fatos atuais ou dados de um projeto conectado, use primeiro a ferramenta que contém o dado real; não responda por hipótese sobre código.',
    '3. Escolha a fonte pela natureza do dado, não por palavras exatas da frase.',
    '4. Firebase Authentication é a fonte autoritativa disponível para usuários, contas, e-mails, status, provedores, criação de conta e lastSignInTime do ListaLar.',
    '5. Para perguntas sobre usuário mais recente/antigo, inatividade, período sem login, ranking ou contagem por data, use firebase_auth_users e derive o resultado dos registros retornados.',
    '6. Firestore é fonte para documentos e dados persistidos do aplicativo; listalar_spending_analytics é fonte para compras, gastos, produtos e preços.',
    '7. GitHub é fonte para código, arquivos, implementação, bugs e arquitetura. NÃO use GitHub como substituto de Firebase Auth/Firestore para responder dados operacionais.',
    '8. Nunca invente nomes de arquivos nem peça ao usuário para enviar código antes de tentar uma ferramenta operacional já disponível.',
    '9. Se a pergunta puder ser respondida calculando, filtrando, ordenando ou comparando os dados de uma ferramenta, colete os dados e faça a análise na síntese.',
    '10. lastSignInTime representa o último login registrado pelo Firebase Authentication; não procure um campo customizado de último acesso, salvo se a pergunta pedir especificamente atividade interna do app além do login.'
  ];
  if (strictAuth) {
    lines.push('11. Nesta execução anterior o roteamento não selecionou a fonte autoritativa. Para a pergunta original, consulte firebase_auth_users antes de responder; não consulte GitHub para substituir esse dado.');
  }
  lines.push('', `PERGUNTA ORIGINAL: ${originalPrompt}`);
  return lines.join('\n');
}

async function delegate(request, originalPrompt, strictAuth = false) {
  const routedRequest = {
    ...request,
    data: {
      ...(request.data || {}),
      prompt: routingPolicy(originalPrompt, strictAuth)
    }
  };
  return agentCoreV20.askNexusAgent.run(routedRequest);
}

function needsGroundingRetry(originalPrompt, result) {
  const tools = toolNames(result);

  if (isListaLarAuthDomain(originalPrompt)) {
    return !tools.includes('firebase_auth_users');
  }

  if (mentionsKnownProject(originalPrompt) && tools.length === 0) {
    const text = normalize(originalPrompt);
    const clearlyConceptual = /\bo que e\b|\bexplique\b|\bconceito\b|\bcomo funciona em geral\b/.test(text);
    return !clearlyConceptual;
  }

  return false;
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

    let result = await delegate(request, prompt, false);
    let routingGuardRetry = false;

    if (needsGroundingRetry(prompt, result)) {
      routingGuardRetry = true;
      result = await delegate(request, prompt, isListaLarAuthDomain(prompt));
    }

    return {
      ...result,
      version: '2.1',
      dynamicPlanner: true,
      routingGuard: true,
      routingGuardRetry,
      originalPromptPreserved: true
    };
  }
);
