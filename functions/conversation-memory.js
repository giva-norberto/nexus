const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { createHash } = require('crypto');

const groqApiKey = defineSecret('GROQ_API_KEY');
const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MODEL_ID = 'openai/gpt-oss-120b';
const MAX_MESSAGES = 120;
const MAX_CONVERSATION_CHARS = 100000;
const MAX_MEMORY_TEXT_CHARS = 5000;
const MAX_MEMORY_CHECK_ITEMS = 100;

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function sanitizeMessages(input) {
  const raw = Array.isArray(input) ? input.slice(-MAX_MESSAGES) : [];
  const messages = [];
  let total = 0;
  for (const item of raw) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    const text = String(item?.text || '').trim();
    if (!role || !text) continue;
    const remaining = MAX_CONVERSATION_CHARS - total;
    if (remaining <= 0) break;
    const clipped = text.slice(0, remaining);
    messages.push({ role, text: clipped });
    total += clipped.length;
  }
  return messages;
}

function inferProject(text) {
  const normalized = String(text).toLowerCase();
  if (normalized.includes('pronti pet') || normalized.includes('pronti-pet')) return 'Pronti Pet';
  if (normalized.includes('listalar') || normalized.includes('lista lar')) return 'ListaLar';
  if (normalized.includes('semear')) return 'Semear';
  if (normalized.includes('nexus')) return 'Nexus';
  if (normalized.includes('pronti')) return 'Pronti';
  return 'Geral';
}

function slugify(value) {
  return String(value || 'geral').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'geral';
}

function normalizeMemoryText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryFingerprint(value) {
  return createHash('sha256').update(normalizeMemoryText(value), 'utf8').digest('hex');
}

function similarityScore(a, b) {
  const aa = new Set(normalizeMemoryText(a).split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  const bb = new Set(normalizeMemoryText(b).split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

async function askJson(system, user, maxTokens = 500) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
      stream: false
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    console.error('Groq memory error', response.status, detail);
    return null;
  }
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

exports.saveConversation = onCall({
  region: 'southamerica-east1', secrets: [groqApiKey], maxInstances: 1, timeoutSeconds: 60, memory: '256MiB'
}, async (request) => {
  assertAuthorized(request);
  const messages = sanitizeMessages(request.data?.messages);
  if (messages.length < 2) throw new HttpsError('invalid-argument', 'Não há conversa suficiente para salvar.');

  const transcript = messages.map((m) => `${m.role === 'user' ? 'Usuário' : 'Nexus'}: ${m.text}`).join('\n\n');
  const analysis = await askJson(
    'Você organiza conversas do Nexus. Retorne somente JSON válido com: title (máx. 70 caracteres), summary (máx. 700 caracteres), project. project deve ser um de: Nexus, Pronti Pet, Pronti, ListaLar, Semear, Geral. Não invente fatos.',
    transcript.slice(0, 30000),
    450
  );

  const firstUser = messages.find((m) => m.role === 'user')?.text || 'Conversa Nexus';
  const title = String(analysis?.title || firstUser).replace(/\s+/g, ' ').trim().slice(0, 70) || 'Conversa Nexus';
  const summary = String(analysis?.summary || 'Conversa salva por solicitação do usuário.').trim().slice(0, 700);
  const allowedProjects = new Set(['Nexus', 'Pronti Pet', 'Pronti', 'ListaLar', 'Semear', 'Geral']);
  const project = allowedProjects.has(String(analysis?.project || '')) ? String(analysis.project) : inferProject(transcript);

  const db = getFirestore();
  const ref = db.collection('conversations_index').doc();
  const now = new Date();
  const storagePath = `conversations/${now.getUTCFullYear()}/${slugify(project)}/${ref.id}.json`;
  const document = {
    id: ref.id, title, summary, project, createdAt: now.toISOString(),
    createdBy: request.auth.token.email, messageCount: messages.length, messages
  };

  await getStorage().bucket().file(storagePath).save(JSON.stringify(document, null, 2), {
    contentType: 'application/json; charset=utf-8', resumable: false,
    metadata: { cacheControl: 'private, max-age=0, no-store', metadata: { nexusConversationId: ref.id } }
  });

  await ref.set({
    title, summary, project, storagePath, messageCount: messages.length,
    createdBy: request.auth.token.email,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), status: 'saved'
  });

  return { saved: true, id: ref.id, title, summary, project, storagePath, messageCount: messages.length };
});

exports.saveMemoryCommand = onCall({
  region: 'southamerica-east1', secrets: [groqApiKey], maxInstances: 1, timeoutSeconds: 45, memory: '256MiB'
}, async (request) => {
  assertAuthorized(request);
  const text = String(request.data?.text || '').trim().slice(0, MAX_MEMORY_TEXT_CHARS);
  if (!text) throw new HttpsError('invalid-argument', 'Informe a informação que deve ser guardada.');

  const classification = await askJson(
    'Classifique uma memória explícita do usuário para o Nexus. Retorne somente JSON válido com: project e type. project deve ser Nexus, Pronti Pet, Pronti, ListaLar, Semear ou Geral. type deve ser: regra de negócio, decisão técnica, preferência, fato confirmado ou observação. Não reescreva nem resuma o conteúdo do usuário.',
    text,
    220
  );

  const allowedProjects = new Set(['Nexus', 'Pronti Pet', 'Pronti', 'ListaLar', 'Semear', 'Geral']);
  const allowedTypes = new Set(['regra de negócio', 'decisão técnica', 'preferência', 'fato confirmado', 'observação']);
  const project = allowedProjects.has(String(classification?.project || '')) ? String(classification.project) : inferProject(text);
  const type = allowedTypes.has(String(classification?.type || '')) ? String(classification.type) : 'fato confirmado';
  const fingerprint = memoryFingerprint(text);
  const db = getFirestore();

  const duplicate = await db.collection('memory').where('fingerprint', '==', fingerprint).limit(1).get();
  if (!duplicate.empty) {
    const doc = duplicate.docs[0];
    const data = doc.data();
    return { saved: true, alreadyExisted: true, id: doc.id, project: data.project || project, type: data.type || type, text: data.text || text };
  }

  const ref = await db.collection('memory').add({
    project,
    type,
    text,
    fingerprint,
    source: 'explicit-command',
    createdBy: request.auth.token.email,
    createdAt: FieldValue.serverTimestamp()
  });

  return { saved: true, alreadyExisted: false, id: ref.id, project, type, text };
});

exports.checkMemoryCommand = onCall({
  region: 'southamerica-east1', maxInstances: 1, timeoutSeconds: 20, memory: '256MiB'
}, async (request) => {
  assertAuthorized(request);
  const text = String(request.data?.text || '').trim().slice(0, MAX_MEMORY_TEXT_CHARS);
  if (!text) throw new HttpsError('invalid-argument', 'Informe a informação que deve ser verificada.');

  const db = getFirestore();
  const fingerprint = memoryFingerprint(text);
  const exact = await db.collection('memory').where('fingerprint', '==', fingerprint).limit(1).get();
  if (!exact.empty) {
    const doc = exact.docs[0];
    const data = doc.data();
    return { found: true, exact: true, id: doc.id, project: data.project || '', type: data.type || '', text: data.text || '' };
  }

  const snapshot = await db.collection('memory').orderBy('createdAt', 'desc').limit(MAX_MEMORY_CHECK_ITEMS).get();
  let best = null;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const candidateText = String(data.text || '');
    const score = similarityScore(text, candidateText);
    if (!best || score > best.score) best = { doc, data, score };
  }

  if (best && best.score >= 0.88) {
    return {
      found: true,
      exact: false,
      id: best.doc.id,
      project: best.data.project || '',
      type: best.data.type || '',
      text: best.data.text || '',
      similarity: best.score
    };
  }

  return { found: false };
});
