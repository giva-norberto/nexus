const core = require('./index');
const conversationMemory = require('./conversation-memory');
const firebaseObserver = require('./firebase-observer');

module.exports = {
  ...core,
  ...conversationMemory,
  firebaseProjectStatus: firebaseObserver.firebaseProjectStatus
};
