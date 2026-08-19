const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');
const firestoreExplorer = require('./firestore-explorer');
const agentCore = require('./agent-core');
const agentCoreV17 = require('./agent-core-v17');

module.exports = {
  ...core,
  ...conversationMemory,
  ...agentCore,
  askNexusAgent: agentCoreV17.askNexusAgent,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus,
  firebaseFirestoreRead: firestoreExplorer.firebaseFirestoreRead,
  firebaseSpendingAnalytics: firestoreExplorer.firebaseSpendingAnalytics
};