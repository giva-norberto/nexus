const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');
const firestoreExplorer = require('./firestore-explorer');
const agentCore = require('./agent-core');
const agentCoreV243 = require('./agent-core-v243');

module.exports = {
  ...core,
  ...conversationMemory,
  ...agentCore,
  askNexusAgent: agentCoreV243.askNexusAgent,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus,
  firebaseFirestoreRead: firestoreExplorer.firebaseFirestoreRead,
  firebaseSpendingAnalytics: firestoreExplorer.firebaseSpendingAnalytics
};