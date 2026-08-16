const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

const groqApiKey = defineSecret('GROQ_API_KEY');
const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MODEL_ID = 'openai/gpt-oss-120b';
const MAX_PROMPT_CHARS = 4000;
const MAX_MEMORY_ITEMS = 20;
const MAX_OUTPUT_TOKENS = 800;

exports.askNexus = onCall(
  {
    region: 'southamerica-east1',
    secrets: [groqApiKey],
    maxInstances: 1,
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    const email = String(request.auth?.token?.email || '').toLowerCase();
    if (!request.auth || email !== AUTHORIZED_EMAIL) {
      throw new HttpsError('permission-denied', 'Usuário não autorizado.');
    }

    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) {
      throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError('invalid-argument', `Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);
    }

    const db = getFirestore();
    const memorySnapshot = await db
      .collection('memory')
      .orderBy('createdAt', 'desc')
      .limit(MAX_MEMORY_ITEMS)
      .get();

    const memories = memorySnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        project: String(data.project || ''),
        type: String(data.type || ''),
        text: String(data.text || '')
      };
    });

    const memoryText = memories.length
      ? memories
          .map((item, index) => `${index + 1}. [${item.type}] ${item.project ? item.project + ' — ' : ''}${item.text}`)
          .join('\n')
      : 'Nenhuma memória registrada.';

    const systemPrompt = [
      'Você é Nexus, um agente técnico central para engenharia, auditoria e operação de projetos.',
      'Responda em português do Brasil, com precisão e objetividade.',
      'Use as memórias fornecidas apenas quando forem relevantes.',
      'Não invente fatos sobre repositórios, Firebase ou produção que não estejam no contexto.',
      'Ações críticas como alterar produção, excluir dados, mudar regras/permissões, merge, deploy ou gerar custo exigem aprovação humana explícita.',
      'Se a solicitação exigir dados externos ainda não conectados, diga exatamente qual acesso está faltando.'
    ].join(' ');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey.value()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Memória persistente do Nexus:\n${memoryText}\n\nPergunta do usuário:\n${prompt}`
          }
        ],
        temperature: 0.2,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        stream: false
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      console.error('Groq error', response.status, detail);
      if (response.status === 429) {
        throw new HttpsError('resource-exhausted', 'Limite de uso do Groq atingido. Tente novamente mais tarde.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new HttpsError('failed-precondition', 'Credencial do Groq recusada.');
      }
      throw new HttpsError('internal', 'Falha ao consultar o Groq.');
    }

    const payload = await response.json();
    const answer = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!answer) {
      throw new HttpsError('internal', 'O modelo não retornou uma resposta válida.');
    }

    return {
      answer,
      provider: 'Groq',
      model: MODEL_ID,
      memoryItemsUsed: memories.length
    };
  }
);
