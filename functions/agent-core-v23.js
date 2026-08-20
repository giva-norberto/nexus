const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const agentCoreV22 = require('./agent-core-v22');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_PROMPT_CHARS = 4000;
const MAX_SOURCE_MAP_CHARS = 7000;

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

function resolveProject(prompt) {
  const text = normalize(prompt);
  if (/pronti[- ]?pet/.test(text)) return 'pronti-pet';
  if (/pronti[- ]?(?:app)?/.test(text) && !/pet/.test(text)) return 'pronti-app';
  if (/listalar|lista lar|compras-da-casa/.test(text)) return 'listalar';
  if (/\bnexus\b/.test(text)) return 'nexus';
  return '';
}

function compactSourceMap(value) {
  if (!value || typeof value !== 'object') return null;
  const sources = Array.isArray(value.sources) ? value.sources : [];
  return {
    project: String(value.project || ''),
    name: String(value.name || ''),
    aliases: Array.isArray(value.aliases) ? value.aliases.slice(0, 30) : [],
    sources: sources.slice(0, 60).map((source) => ({
      id: String(source?.id || ''),
      domain: String(source?.domain || ''),
      source: String(source?.source || ''),
      tool: String(source?.tool || ''),
      topics: Array.isArray(source?.topics) ? source.topics.slice(0, 40) : [],
      paths: Array.isArray(source?.paths) ? source.paths.slice(0, 20) : [],
      fields: Array.isArray(source?.fields) ? source.fields.slice(0, 40) : [],
      args: source?.args && typeof source.args === 'object' ? source.args : {},
      readOnly: source?.readOnly !== false,
      priority: Number(source?.priority || 0)
    }))
  };
}

async function loadSourceMap(project) {
  if (!project) return null;
  try {
    const snapshot = await getFirestore().collection('source_maps').doc(project).get();
    if (!snapshot.exists) return null;
    return compactSourceMap(snapshot.data());
  } catch (error) {
    console.error('Nexus source map read error', project, error);
    return null;
  }
}

function sourceMapContext(project, map) {
  const json = JSON.stringify(map);
  const safe = json.length > MAX_SOURCE_MAP_CHARS
    ? `${json.slice(0, MAX_SOURCE_MAP_CHARS)}...[índice limitado]`
    : json;
  return [
    `ÍNDICE OPERACIONAL CONFIRMADO DO PROJETO ${project}:`,
    'Este índice foi configurado pelo proprietário do Nexus para indicar onde procurar cada domínio de dados.',
    'Use-o como orientação de roteamento; ele não é evidência do valor atual dos dados.',
    'Quando um assunto corresponder a uma entrada, prefira a ferramenta indicada nessa entrada.',
    'Não invente caminhos fora do índice se uma fonte adequada já estiver mapeada.',
    safe
  ].join('\n');
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
    const originalHistory = Array.isArray(request.data?.history) ? request.data.history : [];
    const history = map
      ? [...originalHistory.slice(-5), { role: 'assistant', content: sourceMapContext(project, map) }]
      : originalHistory;

    const result = await agentCoreV22.askNexusAgent.run({
      ...request,
      data: {
        ...(request.data || {}),
        prompt,
        history
      }
    });

    return {
      ...result,
      version: '2.3',
      sourceMapEnabled: true,
      sourceMapProject: project || null,
      sourceMapLoaded: Boolean(map),
      sourceMapSourceCount: Array.isArray(map?.sources) ? map.sources.length : 0
    };
  }
);
