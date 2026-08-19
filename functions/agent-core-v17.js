const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV16 = require('./agent-core-v16');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';
const FREE_ONLY = true;
const MAX_PROMPT_CHARS = 4000;
const MAX_FILE_BYTES = 220000;
const MAX_EVIDENCE_CHARS = 18000;

const REPOSITORIES = {
  'pronti-pet': { name: 'Pronti Pet', fullName: 'giva-norberto/pronti-pet' },
  'pronti-app': { name: 'Pronti', fullName: 'giva-norberto/pronti-app' },
  listalar: { name: 'ListaLar', fullName: 'giva-norberto/ListaLar' },
  nexus: { name: 'Nexus', fullName: 'giva-norberto/nexus' }
};

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

function clampText(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function explicitProject(prompt) {
  const text = normalize(prompt);
  const found = [];
  if (/\bpronti[\s-]+pet\b/.test(text)) found.push('pronti-pet');
  if (/\blista\s*lar\b|\blistalar\b/.test(text)) found.push('listalar');
  if (/\bnexus\b/.test(text)) found.push('nexus');
  if (/\bpronti(?:\s+app)?\b/.test(text) && !/\bpronti[\s-]+pet\b/.test(text)) found.push('pronti-app');
  return [...new Set(found)].length === 1 ? [...new Set(found)][0] : '';
}

function isArchitectureAudit(prompt) {
  const text = normalize(prompt);
  const project = explicitProject(prompt);
  if (!project) return false;
  return /arquitetura|risco tecnico|riscos tecnicos|seguranca|ci\/cd|pipeline|deploy|auditoria|audit|infraestrutura|secret|segredo|firestore rules|storage rules|governanca/.test(text);
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken.value()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nexus-Architecture-Audit'
    }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

async function fetchTextFile(repoFullName, branch, path) {
  try {
    const payload = await githubFetch(
      `/repos/${repoFullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
    );
    if (payload?.encoding !== 'base64' || !payload?.content) return null;
    const bytes = Number(payload.size || 0);
    if (bytes > MAX_FILE_BYTES) return null;
    const text = Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
    return { path, sha: payload.sha || '', text: clampText(text, 7000) };
  } catch (error) {
    console.warn('Architecture audit file skipped', path, error?.message || error);
    return null;
  }
}

function findMatchingPaths(paths, regex) {
  return paths.filter((path) => regex.test(path));
}

async function buildArchitectureEvidence(prompt) {
  const projectKey = explicitProject(prompt);
  const repo = REPOSITORIES[projectKey];
  if (!repo) throw new HttpsError('invalid-argument', 'Projeto não identificado para auditoria.');

  const meta = await githubFetch(`/repos/${repo.fullName}`);
  const branch = meta.default_branch || 'main';
  const treePayload = await githubFetch(
    `/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  const tree = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  const paths = tree.filter((item) => item.type === 'blob').map((item) => item.path);

  const workflowPaths = findMatchingPaths(paths, /^\.github\/workflows\/.*\.ya?ml$/i);
  const rulesPaths = findMatchingPaths(paths, /(^|\/)(firestore|storage)\.rules$/i);
  const envPaths = findMatchingPaths(paths, /(^|\/)(\.env(?:\..+)?|\.runtimeconfig\.json)$/i);
  const firebaseConfigPaths = paths.filter((path) => ['firebase.json', '.firebaserc'].includes(path));
  const packagePaths = paths.filter((path) => /^functions\/package\.json$/i.test(path));
  const agentPaths = paths.filter((path) => /^functions\/(agent-core-v1[4-7]|bootstrap)\.js$/i.test(path));

  const priority = [
    ...firebaseConfigPaths,
    ...workflowPaths,
    ...rulesPaths,
    ...packagePaths,
    ...agentPaths
  ];
  const uniquePriority = [...new Set(priority)].slice(0, 12);

  const files = [];
  for (const path of uniquePriority) {
    const file = await fetchTextFile(repo.fullName, branch, path);
    if (file) files.push(file);
  }

  const allText = files.map((file) => file.text).join('\n');
  const managedSecrets = [...allText.matchAll(/defineSecret\(['"]([^'"]+)['"]\)/g)]
    .map((match) => match[1]);
  const workflowText = files
    .filter((file) => workflowPaths.includes(file.path))
    .map((file) => file.text)
    .join('\n');

  const functionsDeployInWorkflow = /firebase\s+deploy\s+--only\s+functions|--only\s+functions|functions:deploy/i.test(workflowText);
  const testCommandsInWorkflow = /npm\s+(?:run\s+)?test|npm\s+run\s+lint|eslint|vitest|jest|node\s+--test/i.test(workflowText);

  return {
    tool: 'github_architecture_audit',
    ok: true,
    project: repo.name,
    repository: repo.fullName,
    defaultBranch: branch,
    repositoryInventoryChecked: true,
    inventory: {
      totalFiles: paths.length,
      workflowFiles: workflowPaths,
      rulesFiles: rulesPaths,
      envLikeFiles: envPaths,
      firebaseConfigFiles: firebaseConfigPaths,
      functionsPackageFiles: packagePaths,
      agentFilesInspected: files.filter((file) => /^functions\/(agent-core|bootstrap)/i.test(file.path)).map((file) => file.path)
    },
    derivedFacts: {
      firestoreRulesVersioned: rulesPaths.some((path) => /(^|\/)firestore\.rules$/i.test(path)),
      storageRulesVersioned: rulesPaths.some((path) => /(^|\/)storage\.rules$/i.test(path)),
      functionsDeployInWorkflow,
      testOrLintInWorkflow: testCommandsInWorkflow,
      managedSecretsFound: [...new Set(managedSecrets)]
    },
    files: files.map((file) => ({
      path: file.path,
      sha: file.sha,
      snippet: clampText(file.text, 4200)
    }))
  };
}

function providerFailure(status) {
  return status === 413 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function callGroq(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey.value()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.1,
      max_completion_tokens: 900,
      stream: false
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    console.error('Architecture Groq error', response.status, detail);
    const error = new Error(`GROQ_${response.status}`);
    error.providerStatus = response.status;
    throw error;
  }

  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('GROQ_EMPTY');
  return text;
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => String(part?.text || '')).filter(Boolean).join('\n').trim();
}

async function callGemini(system, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey.value(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 1000 }
      })
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    console.error('Architecture Gemini error', response.status, detail);
    if (response.status === 429 || response.status === 413) {
      throw new HttpsError(
        'resource-exhausted',
        'As cotas gratuitas disponíveis estão indisponíveis no momento. Nenhuma alternativa paga foi acionada.'
      );
    }
    throw new HttpsError('internal', 'A auditoria técnica não conseguiu consultar a IA.');
  }

  const payload = await response.json();
  const text = extractGeminiText(payload);
  if (!text) throw new HttpsError('internal', 'A IA não retornou conteúdo para a auditoria.');
  return text;
}

async function architectureAnswer(prompt, evidence) {
  const system = [
    'Você é Nexus, agente técnico central do Giva, executando uma auditoria de arquitetura baseada em evidências.',
    'Responda em português do Brasil, direto, técnico e racional.',
    'A árvore completa do repositório foi inventariada: use inventory e derivedFacts para afirmações de presença ou ausência.',
    'Nunca diga que algo não existe apenas porque não apareceu em um snippet; ausência só pode ser afirmada quando repositoryInventoryChecked=true e o inventário correspondente estiver vazio/false.',
    'Não confunda regra não versionada no GitHub com regra inexistente no Firebase em produção.',
    'Não diga que gerenciamento de segredos é inexistente se managedSecretsFound tiver itens.',
    'Não recomende deploy automático de Functions como primeira correção se a governança exige aprovação humana; prefira CI de validação e deploy manual/aprovado.',
    'Diferencie risco confirmado, lacuna de evidência e recomendação.',
    'Cite arquivos quando a evidência trouxer path. Não invente linhas não fornecidas.'
  ].join(' ');

  const evidenceText = clampText(JSON.stringify(evidence), MAX_EVIDENCE_CHARS);
  const userText = `Pergunta: ${prompt}\nEvidências verificadas: ${evidenceText}\nApresente os riscos com prioridade e diga qual corrigiria primeiro.`;

  const groqMessages = [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];

  try {
    const answer = await callGroq(groqMessages);
    return { answer, provider: 'groq' };
  } catch (error) {
    const status = Number(error?.providerStatus || 0);
    if (status && !providerFailure(status)) throw new HttpsError('internal', 'Falha ao consultar o provedor principal.');
    const answer = await callGemini(system, userText);
    return { answer, provider: 'gemini' };
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

    if (isArchitectureAudit(prompt)) {
      const evidence = await buildArchitectureEvidence(prompt);
      const result = await architectureAnswer(prompt, evidence);
      return {
        answer: result.answer,
        agentCore: true,
        version: '1.7',
        aiRouter: true,
        provider: result.provider,
        architectureAudit: true,
        repositoryInventoryChecked: true,
        toolsUsed: [{ name: 'github_architecture_audit', ok: true }],
        readOnly: true,
        freeOnlyPolicy: FREE_ONLY
      };
    }

    const result = await agentCoreV16.askNexusAgent.run(request);
    return {
      ...result,
      version: '1.7'
    };
  }
);
