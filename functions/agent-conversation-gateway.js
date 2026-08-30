const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCore = require('./agent-core');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1200;

function clamp(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[conteúdo limitado]` : text;
}

function providerFailure(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /resource-exhausted|unavailable|internal|429|413|cota|limite|capacity/.test(text);
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: clamp(item?.content || item?.text || '', MAX_HISTORY_CHARS)
    }))
    .filter((item) => item.content.trim());
}

async function callGroq(system, user) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey.value()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      max_completion_tokens: 900,
      stream: false
    })
  });
  if (!response.ok) {
    const error = new Error(`Groq HTTP ${response.status}`);
    error.code = response.status === 429 || response.status === 413 ? 'resource-exhausted' : 'internal';
    throw error;
  }
  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Groq retornou resposta vazia.');
  return { text, provider: 'groq' };
}

async function callGemini(system, user) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey.value())}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
      })
    }
  );
  if (!response.ok) {
    const error = new Error(`Gemini HTTP ${response.status}`);
    error.code = response.status === 429 || response.status === 413 ? 'resource-exhausted' : 'internal';
    throw error;
  }
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => String(part?.text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) throw new Error('Gemini retornou resposta vazia.');
  return { text, provider: 'gemini' };
}

async function callFree(system, user) {
  try {
    return await callGroq(system, user);
  } catch (error) {
    if (!providerFailure(error)) throw error;
  }
  try {
    const result = await callGemini(system, user);
    return { ...result, fallbackFrom: 'groq' };
  } catch (error) {
    if (providerFailure(error)) return null;
    throw error;
  }
}

function isUnrouted(result) {
  return Boolean(
    result &&
    !result.sourceMapProject &&
    !result.intent &&
    !result.toolsUsed &&
    Number(result.evidenceCount || 0) === 0
  );
}

async function answerConversationally(request, baseResult) {
  const prompt = String(request.data?.prompt || '').trim();
  const history = safeHistory(request.data?.history);
  const historyText = history.length
    ? history.map((item) => `${item.role}: ${item.content}`).join('\n')
    : 'nenhum';

  const system = [
    'Você é Nexus, o agente central deste ambiente.',
    'Converse naturalmente em português do Brasil.',
    'Nem toda pergunta exige projeto, source_map ou ferramenta. Identidade, capacidades, explicações gerais e conversa comum devem ser respondidas diretamente.',
    'Use o histórico recente para manter contexto e resolver referências.',
    'Se a pergunta pedir um fato operacional de um projeto e nenhuma fonte tiver sido encontrada, não invente dados: explique que falta identificar ou conectar a fonte necessária.',
    'Você pode dizer que o Nexus usa source_maps e ferramentas configuradas quando uma pergunta exige dados de projeto.',
    'Não afirme ter alterado produção, feito deploy, escrito dados ou executado ação que não ocorreu.',
    'Política: somente leitura para investigação neste fluxo e nenhuma alternativa paga automática.',
    'Responda ao sentido da pergunta, sem exigir frases ou comandos decorados.'
  ].join(' ');

  const user = [
    `Histórico recente:\n${historyText}`,
    `Pergunta atual:\n${prompt}`,
    `Resultado do roteador de projeto (apenas contexto técnico):\n${clamp(JSON.stringify(baseResult || {}), 2500)}`
  ].join('\n\n');

  return callFree(system, user);
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
    const baseResult = await agentCore.askNexusAgent.run(request);
    if (!isUnrouted(baseResult)) return baseResult;

    const conversational = await answerConversationally(request, baseResult);
    if (!conversational?.text) {
      return {
        ...baseResult,
        answer: 'Não há uma fonte de projeto aplicável a esta pergunta e as IAs gratuitas de conversa estão indisponíveis agora. Nenhuma alternativa paga foi acionada.',
        version: '3.2',
        conversationMode: true,
        conversationProvider: 'unavailable'
      };
    }

    return {
      ...baseResult,
      answer: conversational.text,
      version: '3.2',
      architecture: 'semantic-conversation-or-project',
      conversationMode: true,
      conversationProvider: conversational.provider,
      conversationFallbackFrom: conversational.fallbackFrom || null,
      readOnly: true,
      freeOnlyPolicy: true
    };
  }
);
