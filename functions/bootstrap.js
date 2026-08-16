const core = require('./index');
const conversationMemory = require('./conversation-memory');

module.exports = {
  ...core,
  ...conversationMemory
};
