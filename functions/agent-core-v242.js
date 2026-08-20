const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const agentCoreV241 = require('./agent-core-v241');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;
const MAX_HINT_DOMAINS = 6;

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

function tokenSet(value) {
  const stop = new Set([
    'para','com','uma','uns','das','dos','por','mais','qual','quais','como','onde','isso','esse',
    'essa','este','esta','meu','minha','nos','nas','tem','voce','vc','lista','lar','listalar',
    'no','na','do','da','de','e','o','a','os','as','um','ao','aos','quero','saber'
  ]);
  return new Set(
    normalize(value)
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stop.has(word))
  );
}

function resolveProject(prompt) {
  const text = normalize(prompt);
  if (/pronti[- ]?pet/.test(text)) return 'pronti-pet';
  if (/pronti[- ]?(?:app)?/.test(text) && !/pet/.test(text)) return 'pronti-app';
  if (/listalar|lista lar|compras-da-casa/.test(text)) return 'listalar';
  if (/\bnexus\b/.test(text)) return 'nexus';
  return '';
}

async function loadSourceMap(project) {
  if (!project) return null;
  try {
    const snapshot = await getFirestore().collection('source_maps').doc(project).get();
    if (!snapshot.exists) return null;
    const value = snapshot.data() || {};
    return {
      project: String(value.project || project),
      sources: Array.isArray(value.sources) ? value.sources.slice(0, 80) : []
    };
  } catch (error) {
    console.error('Nexus source map read error v2.4.2', project, error);
    return null;
  }
}

function sourceMatchesPrompt(source, prompt) {
  const promptText = normalize(prompt);
  const promptTokens = tokenSet(prompt);
  const phrases = [
    source?.domain,
    source?.source,
    ...(Array.isArray(source?.topics) ? source.topics : [])
  ].map(normalize).filter(Boolean);

  let overlap = 0;
  for (const phrase of phrases) {
    if (phrase.length >= 3 && promptText.includes(phrase)) return true;
    for (const token of tokenSet(phrase)) {
      if (promptTokens.has(token)) overlap += 1;
    }
  }
  return overlap >= 2;
}

function routingDomains(map, prompt) {
  if (!Array.isArray(map?.sources)) return [];
  const seen = new Set();
  const domains = [];
  for (const source of map.sources) {
    if (source?.readOnly === false || !sourceMatchesPrompt(source, prompt)) continue;
    const domain = normalize(source.domain || source.source || source.id).replace(/\s+/g, '_');
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
    if (domains.length >= MAX_HINT_DOMAINS) break;
  }
  return domains;
}

function addRoutingHints(prompt, domains) {
  if (domains.length < 2) return prompt;
  return `${prompt}\n[ROTEAMENTO_INTERNO_SOURCE_MAP: ${domains.join(' | ')}]`;
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

    const project = resolveProject(prompt);
    const map = await loadSourceMap(project);
    const domains = routingDomains(map, prompt);
    const routedPrompt = addRoutingHints(prompt, domains);

    const result = await agentCoreV241.askNexusAgent.run({
      ...request,
      data: {
        ...(request.data || {}),
        prompt: routedPrompt
      }
    });

    return {
      ...result,
      version: '2.4.2',
      multiDomainGuard: true,
      routingHintApplied: routedPrompt !== prompt,
      routingDomains: domains,
      routingDomainCount: domains.length
    };
  }
);
