const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');
const firestoreExplorer = require('./firestore-explorer');
const agentCore = require('./agent-core');
const agentCoreV241 = require('./agent-core-v241');

module.exports = {
  ...core,
  ...conversationMemory,
  ...agentCore,
  askNexusAgent: agentCoreV241.askNexusAgent,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus,
  firebaseFirestoreRead: firestoreExplorer.firebaseFirestoreRead,
  firebaseSpendingAnalytics: firestoreExplorer.firebaseSpendingAnalytics
};