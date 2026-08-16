const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const MAX_AUTH_USERS = 10000;

const FIREBASE_PROJECTS = [
  {
    key: 'listalar',
    name: 'ListaLar',
    projectId: 'compras-da-casa',
    aliases: ['listalar', 'lista lar', 'compras-da-casa']
  }
];

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) {
    throw new HttpsError('permission-denied', 'Usuário não autorizado.');
  }
}

function getProjectApp(project) {
  const appName = `nexus-observer-${project.key}`;
  const existing = getApps().find((app) => app.name === appName);
  if (existing) return existing;
  try {
    return getApp(appName);
  } catch (_) {
    return initializeApp({ credential: applicationDefault(), projectId: project.projectId }, appName);
  }
}

function detectProjects(prompt) {
  const text = normalize(prompt);
  return FIREBASE_PROJECTS.filter((project) =>
    project.aliases.some((alias) => text.includes(normalize(alias)))
  );
}

function needsOperationalFirebaseContext(prompt) {
  const text = normalize(prompt);
  return /usuario|usuarios|cadastrad|firebase|authentication|auth|firestore|colecao|colecoes|status|saude|quantos|acessos|login/.test(text);
}

async function readAuthSummary(project) {
  const app = getProjectApp(project);
  const auth = getAuth(app);
  let pageToken;
  let totalUsers = 0;
  let disabledUsers = 0;
  let emailVerifiedUsers = 0;
  let recentSignIns30d = 0;
  let truncated = false;
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  do {
    const remaining = MAX_AUTH_USERS - totalUsers;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const pageSize = Math.min(1000, remaining);
    const result = await auth.listUsers(pageSize, pageToken);
    for (const user of result.users) {
      totalUsers += 1;
      if (user.disabled) disabledUsers += 1;
      if (user.emailVerified) emailVerifiedUsers += 1;
      const lastSignIn = user.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : NaN;
      if (Number.isFinite(lastSignIn) && now - lastSignIn <= thirtyDaysMs) recentSignIns30d += 1;
    }
    pageToken = result.pageToken;
  } while (pageToken);

  return {
    totalUsers,
    disabledUsers,
    enabledUsers: totalUsers - disabledUsers,
    emailVerifiedUsers,
    recentSignIns30d,
    truncated
  };
}

async function readFirestoreSummary(project) {
  const app = getProjectApp(project);
  const db = getFirestore(app);
  const collections = await db.listCollections();
  return {
    rootCollections: collections.map((collection) => collection.id).sort().slice(0, 100),
    rootCollectionCount: collections.length,
    truncated: collections.length > 100
  };
}

async function readProjectOperationalStatus(project) {
  const result = {
    name: project.name,
    projectId: project.projectId,
    readOnly: true,
    auth: null,
    firestore: null,
    errors: []
  };

  try {
    result.auth = await readAuthSummary(project);
  } catch (error) {
    console.error('Firebase observer auth error', project.projectId, error);
    result.errors.push({ area: 'auth', code: String(error?.code || ''), message: String(error?.message || 'Falha ao consultar Authentication.').slice(0, 300) });
  }

  try {
    result.firestore = await readFirestoreSummary(project);
  } catch (error) {
    console.error('Firebase observer firestore error', project.projectId, error);
    result.errors.push({ area: 'firestore', code: String(error?.code || ''), message: String(error?.message || 'Falha ao consultar Firestore.').slice(0, 300) });
  }

  return result;
}

async function buildFirebaseOperationalContext(prompt) {
  if (!needsOperationalFirebaseContext(prompt)) return '';
  const projects = detectProjects(prompt);
  if (!projects.length) return '';

  const blocks = [];
  for (const project of projects) {
    const status = await readProjectOperationalStatus(project);
    const lines = [
      `FIREBASE OPERACIONAL CONFIRMADO: ${status.name}`,
      `Projeto Firebase: ${status.projectId}`,
      'Modo: SOMENTE LEITURA'
    ];

    if (status.auth) {
      lines.push(
        `Authentication.totalUsers: ${status.auth.totalUsers}${status.auth.truncated ? '+' : ''}`,
        `Authentication.enabledUsers: ${status.auth.enabledUsers}`,
        `Authentication.disabledUsers: ${status.auth.disabledUsers}`,
        `Authentication.emailVerifiedUsers: ${status.auth.emailVerifiedUsers}`,
        `Authentication.recentSignIns30d: ${status.auth.recentSignIns30d}`
      );
    }

    if (status.firestore) {
      lines.push(
        `Firestore.rootCollectionCount: ${status.firestore.rootCollectionCount}`,
        `Firestore.rootCollections: ${status.firestore.rootCollections.join(', ') || '(nenhuma)'}`
      );
    }

    if (status.errors.length) {
      lines.push(`Erros de leitura: ${status.errors.map((item) => `${item.area}: ${item.code || 'erro'} - ${item.message}`).join(' | ')}`);
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n---\n\n');
}

exports.firebaseProjectStatus = onCall(
  { region: 'southamerica-east1', maxInstances: 1, timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    assertAuthorized(request);
    const requested = normalize(request.data?.project || '');
    const project = FIREBASE_PROJECTS.find((item) =>
      item.key === requested || item.aliases.some((alias) => normalize(alias) === requested)
    );
    if (!project) throw new HttpsError('invalid-argument', 'Projeto Firebase não autorizado para observação.');
    return readProjectOperationalStatus(project);
  }
);

module.exports.buildFirebaseOperationalContext = buildFirebaseOperationalContext;
module.exports.FIREBASE_PROJECTS = FIREBASE_PROJECTS;
