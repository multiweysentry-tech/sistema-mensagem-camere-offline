// Gerenciador central de instancias WhatsApp.
// Nunca cria duas sessoes para a mesma chave (tenantId + instanceId).
const { createSession } = require('./wa-session');
const { log } = require('./logger');

function shouldAutoConnect(row) {
  if (!row) return false;
  return row.auto_connect === true || row.auto_connect === 'true' || Number(row.auto_connect) === 1;
}

function createSessionManager(options = {}) {
  const db = options.db || null;
  const sessions = new Map();
  let io = null;

  function key(tenantId, instanceId) {
    return `${String(tenantId || 'default')}::${String(instanceId || 'default')}`;
  }

  function get(tenantId = 'default', instanceId = 'default') {
    return sessions.get(key(tenantId, instanceId)) || null;
  }

  function getOrCreate(tenantId = 'default', instanceId = 'default') {
    const mapKey = key(tenantId, instanceId);
    if (sessions.has(mapKey)) return sessions.get(mapKey);
    const session = createSession({
      tenantId,
      instanceId,
      db: options.db,
      bots: options.bots,
      resolveBots: options.resolveBots,
      logger: options.logger
    });
    session.setIO(io);
    sessions.set(mapKey, session);
    log('info', 'wa.instance_created', { tenantId, instanceId });
    return session;
  }

  async function remove(tenantId = 'default', instanceId = 'default', { logout = true } = {}) {
    const mapKey = key(tenantId, instanceId);
    const session = sessions.get(mapKey);
    if (!session) return false;
    await session.disconnect({ logout });
    sessions.delete(mapKey);
    log('info', 'wa.instance_removed', { tenantId, instanceId });
    return true;
  }

  function list(tenantId) {
    const result = [];
    for (const session of sessions.values()) {
      if (tenantId && session.tenantId !== String(tenantId)) continue;
      result.push(session.getStatus());
    }
    return result;
  }

  function setIO(ioInstance) {
    io = ioInstance;
    for (const session of sessions.values()) session.setIO(io);
  }

  async function restore() {
    if (!db || typeof db.listInstances !== 'function') return [];
    const rows = await db.listInstances();
    for (const row of rows) {
      const session = getOrCreate(row.tenant_id || 'default', row.instance_id);
      if (shouldAutoConnect(row)) {
        session.connect().catch(error => log('error', 'wa.restore_failed', {
          tenantId: row.tenant_id,
          instanceId: row.instance_id,
          error
        }));
      }
    }
    return list();
  }

  function all() {
    return [...sessions.values()];
  }

  return { get, getOrCreate, remove, list, all, setIO, restore, key };
}

module.exports = { createSessionManager, shouldAutoConnect };
