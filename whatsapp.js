// Compatibilidade com o modulo original e fachada da instancia padrao.
// O protocolo puro vive em wa-protocol.js; o ciclo de vida de cada numero
// vive em wa-session.js; session-manager.js coordena varias instancias.
const protocol = require('./wa-protocol');
const { createSession, sanitizeId, MAX_RECONNECT_ATTEMPTS } = require('./wa-session');

const defaultSession = createSession({ instanceId: 'default' });

module.exports = {
  ...protocol,
  createSession,
  sanitizeId,
  MAX_RECONNECT_ATTEMPTS,
  defaultSession,
  connect: (...args) => defaultSession.connect(...args),
  disconnect: (...args) => defaultSession.disconnect(...args),
  refreshQR: (...args) => defaultSession.refreshQR(...args),
  getStatus: (...args) => defaultSession.getStatus(...args),
  checkNumber: (...args) => defaultSession.checkNumber(...args),
  resolveDestination: (...args) => defaultSession.resolveDestination(...args),
  sendMessage: (...args) => defaultSession.sendMessage(...args),
  sendButtons: (...args) => defaultSession.sendButtons(...args),
  sendWithOptions: (...args) => defaultSession.sendWithOptions(...args),
  setIO: (...args) => defaultSession.setIO(...args)
};
