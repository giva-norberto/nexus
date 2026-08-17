const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_COLLECTION_DOCS = 100;
const MAX_FAMILIES = 100;
const MAX_PURCHASES = 1000;
const MAX_ITEMS = 10000;

const PROJECTS = {
  listalar: { key: 'listalar', name: 'ListaLar', projectId: 'compras-da-casa' }
};

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function getProject(key) {
  const project = PROJECTS[String(key || '').toLowerCase()];
  if (!project) throw new HttpsError('invalid-argument', 'Projeto Firebase não autorizado para leitura.');
  return project;
}

function getProjectApp(project) {
  const appName = `nexus-explorer-${project.key}`;
  const existing = getApps().find((app) => app.name === appName);
  if (existing) return existing;
  try {
    return getApp(appName);
  } catch (_) {
    return initializeApp({ credential: applicationDefault(), projectId: project.projectId }, appName);
  }
}

function cleanPath(value) {
  const path = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!path || path.includes('..') || path.length > 600) {
    throw new HttpsError('invalid-argument', 'Caminho Firestore inválido.');
  }
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.length > 20) throw new HttpsError('invalid-argument', 'Caminho Firestore inválido.');
  return { path: parts.join('/'), parts };
}

function serialize(value, depth = 0) {
  if (depth > 5) return '[profundidade limitada]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => serialize(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) out[key] = serialize(item, depth + 1);
    return out;
  }
  return String(value).slice(0, 1000);
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return fallback;
  let text = String(value).trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '').replace(',', '.');
  else text = text.replace(',', '.');
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function dateMs(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

exports.firebaseFirestoreRead = onCall(
  { region: 'southamerica-east1', maxInstances: 1, timeoutSeconds: 45, memory: '256MiB' },
  async (request) => {
    assertAuthorized(request);
    const project = getProject(request.data?.project || 'listalar');
    const { path, parts } = cleanPath(request.data?.path);
    const db = getFirestore(getProjectApp(project));

    if (parts.length % 2 === 0) {
      const ref = db.doc(path);
      const snap = await ref.get();
      if (!snap.exists) return { project: project.name, projectId: project.projectId, readOnly: true, kind: 'document', path, exists: false };
      const subcollections = await ref.listCollections();
      return {
        project: project.name,
        projectId: project.projectId,
        readOnly: true,
        kind: 'document',
        path,
        exists: true,
        id: snap.id,
        data: serialize(snap.data()),
        subcollections: subcollections.map((item) => item.id).sort().slice(0, 100)
      };
    }

    const requestedLimit = Math.max(1, Math.min(MAX_COLLECTION_DOCS, Number(request.data?.limit || 50)));
    const snap = await db.collection(path).limit(requestedLimit).get();
    return {
      project: project.name,
      projectId: project.projectId,
      readOnly: true,
      kind: 'collection',
      path,
      limit: requestedLimit,
      returned: snap.size,
      documents: snap.docs.map((doc) => ({ id: doc.id, data: serialize(doc.data()) }))
    };
  }
);

exports.firebaseSpendingAnalytics = onCall(
  { region: 'southamerica-east1', maxInstances: 1, timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    assertAuthorized(request);
    const project = getProject(request.data?.project || 'listalar');
    const days = Number(request.data?.days || 0);
    const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : null;
    const db = getFirestore(getProjectApp(project));

    const familiesSnap = await db.collection('familias').limit(MAX_FAMILIES).get();
    let purchaseCount = 0;
    let itemCount = 0;
    let totalSpent = 0;
    let truncatedPurchases = false;
    let truncatedItems = false;
    const items = new Map();
    let highestUnit = null;
    let highestLine = null;

    for (const familyDoc of familiesSnap.docs) {
      if (purchaseCount >= MAX_PURCHASES) { truncatedPurchases = true; break; }
      const remainingPurchases = MAX_PURCHASES - purchaseCount;
      const gastosSnap = await familyDoc.ref.collection('gastos').limit(remainingPurchases).get();

      for (const gastoDoc of gastosSnap.docs) {
        if (purchaseCount >= MAX_PURCHASES) { truncatedPurchases = true; break; }
        const gasto = gastoDoc.data() || {};
        const purchaseDate = dateMs(gasto.dataCompraMs || gasto.dataCompra || gasto.criadoEm);
        if (cutoff && Number.isFinite(purchaseDate) && purchaseDate < cutoff) continue;

        purchaseCount += 1;
        totalSpent += toNumber(gasto.valorTotal, 0);
        if (itemCount >= MAX_ITEMS) { truncatedItems = true; continue; }

        const remainingItems = MAX_ITEMS - itemCount;
        const itemSnap = await gastoDoc.ref.collection('itens').limit(remainingItems).get();
        if (itemSnap.size >= remainingItems) truncatedItems = true;

        for (const itemDoc of itemSnap.docs) {
          if (itemCount >= MAX_ITEMS) { truncatedItems = true; break; }
          itemCount += 1;
          const item = itemDoc.data() || {};
          const name = String(item.descricao || item.descricaoOriginal || 'Item sem descrição').trim();
          const productId = String(item.produtoId || '').trim();
          const gtin = String(item.gtin || '').trim();
          const key = productId ? `produto:${productId}` : gtin ? `gtin:${gtin}` : `descricao:${normalizeText(name)}`;
          const quantity = Math.max(0, toNumber(item.quantidade, 0));
          const unitPrice = Math.max(0, toNumber(item.precoUnitario, 0));
          const lineTotal = Math.max(0, toNumber(item.valorTotal, quantity * unitPrice));

          const current = items.get(key) || {
            key, name, productId, gtin, totalSpent: 0, quantity: 0, occurrences: 0, maxUnitPrice: 0, minUnitPrice: null
          };
          current.totalSpent += lineTotal;
          current.quantity += quantity;
          current.occurrences += 1;
          current.maxUnitPrice = Math.max(current.maxUnitPrice, unitPrice);
          current.minUnitPrice = current.minUnitPrice === null ? unitPrice : Math.min(current.minUnitPrice, unitPrice);
          if (name.length > current.name.length) current.name = name;
          items.set(key, current);

          const context = {
            name,
            unitPrice: roundMoney(unitPrice),
            lineTotal: roundMoney(lineTotal),
            quantity,
            establishment: String(gasto.estabelecimentoNome || ''),
            date: Number.isFinite(purchaseDate) ? new Date(purchaseDate).toISOString() : null,
            familyId: familyDoc.id,
            gastoId: gastoDoc.id,
            itemId: itemDoc.id
          };
          if (!highestUnit || unitPrice > highestUnit.unitPrice) highestUnit = context;
          if (!highestLine || lineTotal > highestLine.lineTotal) highestLine = context;
        }
      }
    }

    const aggregates = [...items.values()].map((item) => ({
      ...item,
      totalSpent: roundMoney(item.totalSpent),
      quantity: Math.round(item.quantity * 1000) / 1000,
      avgUnitPrice: item.quantity > 0 ? roundMoney(item.totalSpent / item.quantity) : 0,
      maxUnitPrice: roundMoney(item.maxUnitPrice),
      minUnitPrice: roundMoney(item.minUnitPrice || 0)
    }));

    const topBySpend = [...aggregates].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 15);
    const topByUnitPrice = [...aggregates].sort((a, b) => b.maxUnitPrice - a.maxUnitPrice).slice(0, 15);
    const topByOccurrences = [...aggregates].sort((a, b) => b.occurrences - a.occurrences).slice(0, 15);

    return {
      project: project.name,
      projectId: project.projectId,
      readOnly: true,
      periodDays: cutoff ? days : null,
      familyCountScanned: familiesSnap.size,
      purchaseCount,
      itemCount,
      totalSpent: roundMoney(totalSpent),
      uniqueItems: aggregates.length,
      topBySpend,
      topByUnitPrice,
      topByOccurrences,
      highestUnit,
      highestLine,
      truncated: truncatedPurchases || truncatedItems || familiesSnap.size >= MAX_FAMILIES,
      limits: { families: MAX_FAMILIES, purchases: MAX_PURCHASES, items: MAX_ITEMS }
    };
  }
);
