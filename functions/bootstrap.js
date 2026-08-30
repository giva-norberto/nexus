const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');
const firestoreExplorer = require('./firestore-explorer');
const agentCore = require('./agent-core');

module.exports = {
  ...core,
  ...conversationMemory,
  ...agentCore,
  // Compatibilidade: o painel antigo chama askNexus. Ambos apontam para o mesmo Core v3.
  askNexus: agentCore.askNexusAgent,
  askNexusAgent: agentCore.askNexusAgent,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus,
  firebaseFirestoreRead: firestoreExplorer.firebaseFirestoreRead,
  firebaseSpendingAnalytics: firestoreExplorer.firebaseSpendingAnalytics
};
