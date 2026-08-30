const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');
const firestoreExplorer = require('./firestore-explorer');
const agentCore = require('./agent-core');
const agentConversationGateway = require('./agent-conversation-gateway');

module.exports = {
  ...core,
  ...conversationMemory,
  ...agentCore,
  // O painel e o endpoint de agente passam pelo gateway: conversa geral não exige projeto;
  // perguntas operacionais continuam no Core semântico com source_maps e ferramentas.
  askNexus: agentConversationGateway.askNexusAgent,
  askNexusAgent: agentConversationGateway.askNexusAgent,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus,
  firebaseFirestoreRead: firestoreExplorer.firebaseFirestoreRead,
  firebaseSpendingAnalytics: firestoreExplorer.firebaseSpendingAnalytics
};
