const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const agentCoreV13 = require('./agent-core-v13');
const firestoreExplorer = require('./firestore-explorer');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function money(value) {
  const n = Number(value || 0);
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function percent(value) {
  return `${Number(value || 0).toFixed(2).replace('.', ',')}%`;
}

function datePt(value) {
  if (!value) return 'data não informada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'data não informada';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function recentText(history) {
  if (!Array.isArray(history)) return '';
  return normalize(history.slice(-6).map((item) => item?.content || '').join(' '));
}

function isListaLarContext(prompt, history) {
  return /listalar|lista lar/.test(normalize(`${prompt} ${recentText(history)}`));
}

function isNativeComplexQuestion(prompt, history) {
  if (!isListaLarContext(prompt, history)) return false;
  const text = normalize(prompt);
  const codeTerms = /codigo|arquivo|funcao|bug|implementacao|arquitetura|repositorio|github|commit|branch|pull request|\bpr\b/;
  if (codeTerms.test(text)) return false;
  const complex = /mais de uma vez/.test(text) && /aument/.test(text) && /menor/.test(text) && /maior/.test(text) && /impacto/.test(text);
  const priceIncrease = /aument|subiu|subiram/.test(text) && /preco|precos|produto|produtos|item|itens/.test(text);
  return complex || priceIncrease;
}

function uniqueItems(analytics) {
  const source = [
    ...(analytics.topPriceIncreases || []),
    ...(analytics.changedPriceItems || []),
    ...(analytics.topByOccurrences || []),
    ...(analytics.topBySpend || [])
  ];
  const map = new Map();
  for (const item of source) {
    const key = item.key || normalize(item.name);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function enrichedIncrease(item) {
  const history = Array.isArray(item.history)
    ? item.history.filter((entry) => Number(entry.unitPrice || 0) > 0 && entry.date)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    : [];
  const first = history[0] || null;
  const last = history[history.length - 1] || null;
  const baseline = Number(first?.unitPrice || item.firstUnitPrice || 0);
  const latest = Number(last?.unitPrice || item.lastUnitPrice || 0);
  const change = baseline > 0 ? latest - baseline : Number(item.priceChange || 0);
  const changePct = baseline > 0 ? (change / baseline) * 100 : Number(item.priceChangePct || 0);
  const cheapest = history.length ? [...history].sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice))[0] : null;
  const mostExpensive = history.length ? [...history].sort((a, b) => Number(b.unitPrice) - Number(a.unitPrice))[0] : null;
  const impact = baseline > 0
    ? history.slice(1).reduce((sum, entry) => {
        const delta = Math.max(0, Number(entry.unitPrice || 0) - baseline);
        const qty = Math.max(0, Number(entry.quantity || 0));
        return sum + delta * qty;
      }, 0)
    : 0;
  return {
    ...item,
    baseline,
    latest,
    change,
    changePct,
    cheapest,
    mostExpensive,
    impact: Math.round((impact + Number.EPSILON) * 100) / 100
  };
}

function nativeComplexAnswer(analytics) {
  const increases = uniqueItems(analytics)
    .filter((item) => Number(item.occurrences || 0) >= 2)
    .map(enrichedIncrease)
    .filter((item) => item.change > 0)
    .sort((a, b) => b.impact - a.impact || b.changePct - a.changePct);

  if (!increases.length) {
    return 'Analisei os produtos comprados mais de uma vez e não encontrei aumento entre o primeiro e o último preço registrado.';
  }

  const lines = increases.slice(0, 10).map((item, index) => {
    const cheap = item.cheapest;
    const expensive = item.mostExpensive;
    const cheapText = cheap
      ? `${money(cheap.unitPrice)} em **${cheap.establishment || 'estabelecimento não informado'}** (${datePt(cheap.date)})`
      : `${money(item.minUnitPrice)}`;
    const expensiveText = expensive
      ? `${money(expensive.unitPrice)} em **${expensive.establishment || 'estabelecimento não informado'}** (${datePt(expensive.date)})`
      : `${money(item.maxUnitPrice)}`;
    return `${index + 1}. **${item.name}** — primeiro ${money(item.baseline)}, último ${money(item.latest)}, variação **${percent(item.changePct)}**. Menor: ${cheapText}. Maior: ${expensiveText}. Impacto calculado: **${money(item.impact)}**.`;
  });

  const leader = increases[0];
  return [
    `Analisei os produtos comprados mais de uma vez. Encontrei **${increases.length}** com aumento entre o primeiro e o último preço:`,
    '',
    ...lines,
    '',
    `**Maior impacto no gasto:** **${leader.name}**, com ${money(leader.impact)} de gasto adicional calculado no histórico disponível.`,
    '',
    'Critério: usei o primeiro preço observado de cada produto como referência. Para cada compra posterior, calculei somente o adicional positivo `(preço posterior − primeiro preço) × quantidade` e somei esses valores. Assim, o impacto considera preço e quantidade, e não apenas o percentual de aumento.',
    '',
    'Esta análise foi calculada diretamente pelos dados do ListaLar; não consumiu cota da IA.'
  ].join('\n');
}

function nativePriceIncreaseAnswer(analytics) {
  const increases = (analytics.topPriceIncreases || [])
    .map(enrichedIncrease)
    .filter((item) => item.change > 0)
    .sort((a, b) => b.changePct - a.changePct);
  if (!increases.length) return 'Não encontrei produtos com aumento entre o primeiro e o último preço registrado no ListaLar.';
  return [
    'Produtos com maior aumento de preço no ListaLar:',
    '',
    ...increases.slice(0, 10).map((item, index) => `${index + 1}. **${item.name}** — ${money(item.baseline)} → ${money(item.latest)} (**${percent(item.changePct)}**)`),
    '',
    'Resultado calculado diretamente pelos dados do ListaLar, sem consumir cota da IA.'
  ].join('\n');
}

function nativeAnswer(prompt, analytics) {
  const text = normalize(prompt);
  const complex = /mais de uma vez/.test(text) && /aument/.test(text) && /menor/.test(text) && /maior/.test(text) && /impacto/.test(text);
  return complex ? nativeComplexAnswer(analytics) : nativePriceIncreaseAnswer(analytics);
}

exports.askNexusAgent = onCall(
  {
    region: 'southamerica-east1',
    secrets: [groqApiKey, githubToken],
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  async (request) => {
    assertAuthorized(request);
    const prompt = String(request.data?.prompt || '').trim();
    if (!prompt) throw new HttpsError('invalid-argument', 'Informe uma pergunta.');
    const history = Array.isArray(request.data?.history) ? request.data.history : [];

    if (isNativeComplexQuestion(prompt, history)) {
      const analyticsRequest = {
        ...request,
        data: { ...(request.data || {}), project: 'listalar', days: 0 }
      };
      const analytics = await firestoreExplorer.firebaseSpendingAnalytics.run(analyticsRequest);
      return {
        answer: nativeAnswer(prompt, analytics),
        agentCore: true,
        version: '1.4',
        nativeAnalysis: true,
        providerCallUsed: false,
        toolsUsed: [{ name: 'firebaseSpendingAnalytics', ok: true }],
        readOnly: true
      };
    }

    return agentCoreV13.askNexusAgent.run(request);
  }
);
