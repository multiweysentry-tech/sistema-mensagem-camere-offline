// Armazenamento em memoria usado apenas no Vercel quando nao ha Postgres remoto configurado.
// Objetivo: manter o painel e as APIs funcionais sem retornar 500. Os dados nao persistem
// entre invocacoes/instancias. Defina PG_HOST/PG_PASSWORD com um banco alcancavel para persistir.
const { normalizarContato } = require('./phone-utils');

const mode = 'memory';

const state = {
  cameras: new Map(),
  log: [],
  conversations: new Map(),
  messages: new Map(),
  deliveries: new Map(),
  consent: new Map(),
  blocklist: new Map(),
  templates: new Map(),
  botConfig: new Map(),
  users: new Map(),
  userSessions: new Map(),
  instances: new Map(),
  jobs: new Map()
};

const CAMERA_FIELDS = ['camera_nome', 'local', 'responsavel_nome', 'responsavel_telefone', 'email', 'status', 'tentativas', 'ultima_cobranca', 'data_resolucao', 'observacoes'];

function tenant(value) {
  return String(value || 'default');
}

// Identificadores de tenants nao-default sao prefixados, exatamente como em db.js.
function scopedKey(value, tenantId) {
  if (value === null || value === undefined) return value;
  const t = tenant(tenantId);
  return t === 'default' ? String(value) : `${t}::${String(value)}`;
}

function canonicalPhone(value) {
  return normalizarContato(value) || String(value || '');
}

function phoneKeys(value, tenantId = 'default') {
  return [...new Set([canonicalPhone(value), String(value || '')].filter(Boolean))]
    .map(phone => scopedKey(phone, tenantId));
}

async function init() {
  const now = new Date().toISOString();
  if (!state.templates.has('cobranca_padrao')) {
    state.templates.set('cobranca_padrao', {
      id: 'cobranca_padrao',
      tenant_id: 'default',
      nome: 'Cobrança de câmeras offline',
      corpo: 'Olá, {nome_cliente}!\nO Sentry identificou que estas câmeras estão offline:\n{lista_cameras}\n\nO que você prefere fazer?\n1. Estou analisando\n2. Preciso falar com técnico\n3. Já resolvi',
      variaveis: 'nome_cliente,lista_cameras',
      created_at: now,
      updated_at: now
    });
  }
  const defaults = { billing_days_before: '3', billing_days_after: '1,3,7', billing_hour: '9', maintenance_hour: '17', auto_mode: 'true', max_attempts: '3', business_hours_start: '8', business_hours_end: '18' };
  for (const [key, value] of Object.entries(defaults)) {
    if (!state.botConfig.has(key)) state.botConfig.set(key, { key, tenant_id: 'default', value, updated_at: now });
  }
  console.log('[DB] Schema em memoria pronto (dados nao persistem no Vercel)');
}

async function getCameras(tenantId = 'default') {
  return [...state.cameras.values()]
    .filter(row => row.tenant_id === tenant(tenantId))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function upsertCamera(cam, tenantId = 'default') {
  const id = scopedKey(cam.id, tenantId);
  const current = state.cameras.get(id) || {};
  const row = { id, tenant_id: tenant(tenantId), instance_id: cam.instance_id || current.instance_id || 'default' };
  for (const field of CAMERA_FIELDS) row[field] = cam[field] ?? current[field] ?? '';
  if (row.status === undefined || row.status === '') row.status = 'Pendente';
  state.cameras.set(id, row);
}

async function updateCamera(id, fields, tenantId = 'default') {
  const current = state.cameras.get(scopedKey(id, tenantId));
  if (!current || current.tenant_id !== tenant(tenantId)) return;
  for (const field of CAMERA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) current[field] = fields[field];
  }
}

async function deleteCamera(id, tenantId = 'default') {
  const key = scopedKey(id, tenantId);
  const row = state.cameras.get(key);
  if (row && row.tenant_id === tenant(tenantId)) state.cameras.delete(key);
}

async function addLog(entry, tenantId = 'default') {
  state.log.push({ id: state.log.length + 1, tenant_id: tenant(tenantId), ...entry });
}

async function getLog(tenantId = 'default') {
  return [...state.log]
    .filter(row => row.tenant_id === tenant(tenantId))
    .reverse()
    .slice(0, 500);
}

async function hasRecentLog(phone, actions, since, tenantId = 'default') {
  const limit = new Date(since).getTime();
  const keys = phoneKeys(phone, tenantId);
  return state.log.some(entry =>
    entry.tenant_id === tenant(tenantId) &&
    keys.includes(scopedKey(entry.responsavel_telefone, tenantId)) &&
    actions.includes(entry.acao) &&
    !Number.isNaN(new Date(entry.timestamp).getTime()) &&
    new Date(entry.timestamp).getTime() >= limit
  );
}

async function getConversations(tenantId = 'default') {
  return [...state.conversations.values()]
    .filter(c => c.tenant_id === tenant(tenantId))
    .map(c => ({ jid: c.jid, name: c.name, lastMessage: c.last_message, lastTime: c.last_time, unread: c.unread, instanceId: c.instance_id }))
    .sort((a, b) => String(b.lastTime).localeCompare(String(a.lastTime)));
}

async function upsertConversation(jid, name, lastMessage, lastTime, tenantId = 'default', instanceId = 'default') {
  const key = scopedKey(jid, tenantId);
  const current = state.conversations.get(key) || { jid: key, unread: 0 };
  state.conversations.set(key, {
    ...current,
    jid: key,
    tenant_id: tenant(tenantId),
    instance_id: String(instanceId || 'default'),
    name,
    last_message: lastMessage,
    last_time: lastTime
  });
}

async function incrementUnread(jid, tenantId = 'default') {
  const current = state.conversations.get(scopedKey(jid, tenantId));
  if (current && current.tenant_id === tenant(tenantId)) current.unread = Number(current.unread || 0) + 1;
}

async function getMessages(jid, tenantId = 'default') {
  const key = scopedKey(jid, tenantId);
  return [...state.messages.values()]
    .filter(m => m.jid === key && m.tenant_id === tenant(tenantId))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map(m => ({ id: m.id, from: m.jid, text: m.text, time: m.time, direction: m.direction, status: m.status }));
}

async function addMessage(jid, msg, tenantId = 'default', instanceId = 'default') {
  const id = scopedKey(msg.id, tenantId);
  if (state.messages.has(id)) return false;
  state.messages.set(id, {
    ...msg,
    id,
    jid: scopedKey(jid, tenantId),
    tenant_id: tenant(tenantId),
    instance_id: String(instanceId || 'default')
  });
  return true;
}

async function markRead(jid, tenantId = 'default') {
  const current = state.conversations.get(scopedKey(jid, tenantId));
  if (current && current.tenant_id === tenant(tenantId)) current.unread = 0;
}

async function isBlocked(phone, tenantId = 'default') {
  return phoneKeys(phone, tenantId).some(key => {
    const row = state.blocklist.get(key);
    return Boolean(row && row.tenant_id === tenant(tenantId));
  });
}

async function hasConsent(phone, tenantId = 'default') {
  const rows = phoneKeys(phone, tenantId)
    .map(key => state.consent.get(key))
    .filter(row => row && row.tenant_id === tenant(tenantId));
  // Se existir registro legado em sentido contrario, o opt-out prevalece.
  return rows.length > 0 && rows.every(row => Number(row.opted_in) === 1);
}

async function getConsents(tenantId = 'default') {
  return [...state.consent.values()]
    .filter(row => row.tenant_id === tenant(tenantId))
    .map(row => ({ phone: row.phone, opted_in: Number(row.opted_in) === 1, updated_at: row.updated_at }))
    .sort((a, b) => String(a.phone).localeCompare(String(b.phone)));
}

async function setConsent(phone, optedIn, tenantId = 'default') {
  if (typeof optedIn !== 'boolean') throw new TypeError('optedIn deve ser booleano');
  const key = scopedKey(canonicalPhone(phone), tenantId);
  state.consent.set(key, { phone: key, tenant_id: tenant(tenantId), opted_in: optedIn ? 1 : 0, updated_at: new Date().toISOString() });
}

async function ensureConsent(phone, tenantId = 'default') {
  if (await isBlocked(phone, tenantId) || await hasConsent(phone, tenantId)) return false;
  await setConsent(phone, true, tenantId);
  return true;
}

async function block(phone, reason, tenantId = 'default') {
  const key = scopedKey(canonicalPhone(phone), tenantId);
  if (!state.blocklist.has(key)) {
    state.blocklist.set(key, { phone: key, tenant_id: tenant(tenantId), reason: reason || '', created_at: new Date().toISOString() });
  }
}

async function unblock(phone, tenantId = 'default') {
  for (const key of phoneKeys(phone, tenantId)) {
    const row = state.blocklist.get(key);
    if (row && row.tenant_id === tenant(tenantId)) state.blocklist.delete(key);
  }
}

async function getBlocklist(tenantId = 'default') {
  return [...state.blocklist.values()]
    .filter(row => row.tenant_id === tenant(tenantId))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function getTemplates(tenantId = 'default') {
  return [...state.templates.values()]
    .filter(row => row.tenant_id === tenant(tenantId))
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
}

async function getTemplate(id, tenantId = 'default') {
  const row = state.templates.get(scopedKey(id, tenantId));
  return row && row.tenant_id === tenant(tenantId) ? { ...row } : null;
}

async function upsertTemplate(tpl, tenantId = 'default') {
  const id = scopedKey(tpl.id, tenantId);
  const now = new Date().toISOString();
  const current = state.templates.get(id);
  state.templates.set(id, {
    id,
    tenant_id: tenant(tenantId),
    nome: tpl.nome,
    corpo: tpl.corpo,
    variaveis: tpl.variaveis || '',
    created_at: current?.created_at || now,
    updated_at: now
  });
}

async function deleteTemplate(id, tenantId = 'default') {
  const key = scopedKey(id, tenantId);
  const row = state.templates.get(key);
  if (row && row.tenant_id === tenant(tenantId)) state.templates.delete(key);
}

function renderTemplate(corpo, vars) {
  let out = corpo;
  for (const [key, value] of Object.entries(vars || {})) out = out.split(`{${key}}`).join(String(value));
  return out;
}

async function getBotConfig(tenantId = 'default') {
  const t = tenant(tenantId);
  const cfg = {};
  for (const [key, row] of state.botConfig) {
    if (row.tenant_id !== t) continue;
    const prefix = t === 'default' ? null : `${t}::`;
    const name = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
    cfg[name] = row.value;
  }
  return cfg;
}

async function setBotConfig(key, value, tenantId = 'default') {
  const storedKey = scopedKey(key, tenantId);
  const current = state.botConfig.get(storedKey);
  state.botConfig.set(storedKey, {
    key: storedKey,
    tenant_id: tenant(tenantId),
    value,
    updated_at: new Date().toISOString(),
    created_at: current?.created_at || new Date().toISOString()
  });
}

async function getReports(tenantId = 'default') {
  const t = tenant(tenantId);
  const cameras = [...state.cameras.values()].filter(c => c.tenant_id === t);
  const logs = [...state.log].filter(l => l.tenant_id === t).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const counts = { Pendente: 0, 'Aguardando resposta': 0, Verificando: 0, Suporte: 0, 'Aguardando validacao': 0, Resolvido: 0 };
  const porResponsavel = new Map();
  const temposResolucao = [];
  const agora = Date.now();

  for (const c of cameras) {
    const st = String(c.status || '').trim();
    if (counts[st] !== undefined) counts[st] += 1;
    const resp = String(c.responsavel_nome || 'Sem responsável').trim() || 'Sem responsável';
    const item = porResponsavel.get(resp) || { responsavel: resp, telefone: c.responsavel_telefone || '', total: 0, abertas: 0, resolvidas: 0, atrasadas: 0 };
    item.total += 1;
    if (st === 'Resolvido') item.resolvidas += 1;
    else {
      item.abertas += 1;
      const base = Date.parse(c.ultima_cobranca || '') || 0;
      if (base && agora - base > 24 * 3600000) item.atrasadas += 1;
    }
    porResponsavel.set(resp, item);
    if (st === 'Resolvido' && c.data_resolucao) {
      const fim = Date.parse(c.data_resolucao);
      const inicio = Date.parse(c.ultima_cobranca || '') || fim;
      if (Number.isFinite(fim) && Number.isFinite(inicio) && fim >= inicio) temposResolucao.push(fim - inicio);
    }
  }

  const tempoMedioHoras = temposResolucao.length ? Math.round((temposResolucao.reduce((a, b) => a + b, 0) / temposResolucao.length / 3600000) * 10) / 10 : null;
  const recentWindow = Date.now() - 24 * 3600000;
  const recentMessages = [...state.messages.values()].filter(m => m.tenant_id === t && Date.parse(m.time || '') >= recentWindow);
  const entregas = { pendente: 0, enviada: 0, entregue: 0, lida: 0, falhou: 0 };
  for (const d of state.deliveries.values()) {
    if (d.tenant_id !== t) continue;
    const k = String(d.status || '');
    if (entregas[k] !== undefined) entregas[k] += 1;
  }

  return {
    counts,
    total: cameras.length,
    tempoMedioHoras,
    tempoMaxHoras: temposResolucao.length ? Math.round((Math.max(...temposResolucao) / 3600000) * 10) / 10 : null,
    tempoMinHoras: temposResolucao.length ? Math.round((Math.min(...temposResolucao) / 3600000) * 10) / 10 : null,
    cobrancasEnviadas: logs.filter(l => l.acao === 'COBRANCA_ENVIADA').length,
    enviosSemConfirmacao: logs.filter(l => ['ENVIO_SEM_CONFIRMACAO', 'ENVIO_AGUARDANDO_CONFIRMACAO'].includes(l.acao)).length,
    erros: logs.filter(l => ['ERRO', 'ENVIO_FALHOU'].includes(l.acao)).length,
    escalonamentos: logs.filter(l => l.acao === 'ESCALONAMENTO' || (l.acao === 'RESPOSTA_RECEBIDA' && l.status_novo === 'Suporte')).length,
    respostasRecebidas: logs.filter(l => l.acao === 'RESPOSTA_RECEBIDA').length,
    resolvidas: counts.Resolvido,
    enviadasHoje: recentMessages.filter(m => m.direction === 'out').length,
    recebidasHoje: recentMessages.filter(m => m.direction === 'in').length,
    clientesAguardando: [...state.conversations.values()].filter(c => c.tenant_id === t && Number(c.unread) > 0).length,
    entregas,
    responsaveisTop: [...porResponsavel.values()].sort((a, b) => b.abertas - a.abertas || b.total - a.total).slice(0, 10),
    atividadesRecentes: logs.slice(0, 15).map(l => ({
      timestamp: l.timestamp, acao: l.acao, camera: l.camera_nome || l.camera_id || '',
      responsavel: l.responsavel_telefone || '', detalhe: l.detalhe || '',
      anterior: l.status_anterior || '', novo: l.status_novo || ''
    })),
    camerasAbertasAntigas: cameras
      .filter(c => c.status !== 'Resolvido')
      .map(c => {
        const base = Date.parse(c.ultima_cobranca || '') || 0;
        return { id: c.id, nome: c.camera_nome || c.id, responsavel: c.responsavel_nome || '', status: c.status, horasAberta: base ? Math.round(((agora - base) / 3600000) * 10) / 10 : null };
      })
      .sort((a, b) => (b.horasAberta || 0) - (a.horasAberta || 0))
      .slice(0, 10)
  };
}

// ---- Autenticacao ----
async function listUsers() {
  return [...state.users.values()].map(row => ({ ...row }));
}
async function createUser(user) {
  const row = { ...user, tenant_id: user.tenantId || user.tenant_id || 'default' };
  state.users.set(row.id, row);
  return getUserById(row.id);
}
async function getUserById(id) {
  const row = state.users.get(id);
  return row ? { ...row } : null;
}
async function getUserByEmail(email) {
  const key = String(email || '').toLowerCase();
  const row = [...state.users.values()].find(user => String(user.email).toLowerCase() === key);
  return row ? { ...row } : null;
}
async function createSessionToken(userId, tokenHash, expiresAt) {
  state.userSessions.set(tokenHash, { token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
}
async function getSessionByToken(tokenHash) {
  const session = state.userSessions.get(tokenHash);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  return getUserById(session.user_id);
}
async function deleteSessionToken(tokenHash) {
  state.userSessions.delete(tokenHash);
}

// ---- Instancias WhatsApp ----
async function listInstances() {
  return [...state.instances.values()].map(row => ({ ...row }));
}
async function upsertInstance(instance) {
  const key = `${instance.tenantId || 'default'}::${instance.instanceId}`;
  const current = state.instances.get(key) || {};
  state.instances.set(key, {
    tenant_id: instance.tenantId || 'default',
    instance_id: instance.instanceId,
    label: instance.label || current.label || '',
    auto_connect: instance.autoConnect ? 1 : 0,
    created_at: current.created_at || new Date().toISOString()
  });
}
async function deleteInstance(tenantId, instanceId) {
  state.instances.delete(`${tenantId || 'default'}::${instanceId}`);
}

// ---- Fila persistente ----
async function createJob(job) {
  const key = `${job.tenantId || 'default'}::${job.idempotencyKey}`;
  if (state.jobs.has(key)) return { rowCount: 0 };
  state.jobs.set(key, {
    id: job.id,
    tenant_id: job.tenantId || 'default',
    instance_id: job.instanceId || 'default',
    kind: job.kind,
    payload: job.payload || {},
    idempotency_key: job.idempotencyKey,
    status: 'pending',
    attempts: 0,
    max_attempts: job.maxAttempts || 3,
    run_at: job.runAt || new Date().toISOString(),
    created_at: new Date().toISOString()
  });
  return { rowCount: 1 };
}
async function claimJobs({ kinds, limit = 10, workerId } = {}) {
  const now = new Date().toISOString();
  const claimed = [];
  for (const job of state.jobs.values()) {
    if (claimed.length >= limit) break;
    if (job.status !== 'pending' || Date.parse(job.run_at) > Date.now()) continue;
    if (kinds && kinds.length && !kinds.includes(job.kind)) continue;
    job.status = 'processing';
    job.locked_at = now;
    job.locked_by = workerId || 'worker';
    job.attempts += 1;
    claimed.push({ ...job });
  }
  return claimed;
}
async function finishJob(id) {
  for (const job of state.jobs.values()) {
    if (job.id === id) {
      job.status = 'done';
      job.finished_at = new Date().toISOString();
      return job;
    }
  }
}
async function failJob(id, error) {
  for (const job of state.jobs.values()) {
    if (job.id !== id) continue;
    job.last_error = String(error?.message || error);
    job.status = job.attempts >= job.max_attempts ? 'failed' : 'pending';
    job.run_at = new Date().toISOString();
    job.locked_at = null;
    job.locked_by = null;
    return job;
  }
}
async function listJobs(tenantId = 'default', limit = 50) {
  return [...state.jobs.values()]
    .filter(job => job.tenant_id === tenant(tenantId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(job => ({ ...job }));
}

async function registerDelivery(entry, tenantId = 'default') {
  const id = scopedKey(entry.id, tenantId);
  if (state.deliveries.has(id)) return;
  const agora = entry.createdAt || new Date().toISOString();
  state.deliveries.set(id, {
    id,
    tenant_id: tenant(tenantId),
    instance_id: String(entry.instanceId || 'default'),
    jid: entry.jid || null,
    camera_ids: (entry.cameraIds || []).join(','),
    texto: entry.texto || null,
    status: entry.status || 'pendente',
    motivo: null,
    created_at: agora,
    updated_at: agora
  });
}

async function updateDeliveryStatus(id, status, motivo, tenantId = 'default') {
  const key = scopedKey(id, tenantId);
  const row = state.deliveries.get(key);
  if (!row || row.tenant_id !== tenant(tenantId)) return null;
  row.status = status;
  row.motivo = motivo || null;
  row.updated_at = new Date().toISOString();
  return { ...row };
}

async function getDeliveries(ids = [], tenantId = 'default') {
  const chaves = Array.isArray(ids) && ids.length ? ids.map(id => scopedKey(id, tenantId)) : [];
  return [...state.deliveries.values()]
    .filter(row => row.tenant_id === tenant(tenantId) && (!chaves.length || chaves.includes(row.id)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 100)
    .map(row => ({
      id: row.id,
      instanceId: row.instance_id,
      jid: row.jid,
      cameraIds: row.camera_ids ? row.camera_ids.split(',').filter(Boolean) : [],
      status: row.status,
      motivo: row.motivo,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
}

async function findDeliveryByExternalId(id) {
  const externalId = String(id || '');
  if (!externalId) return null;
  const matches = [...state.deliveries.values()]
    .filter(row => row.id === externalId || row.id.endsWith(`::${externalId}`));
  if (matches.length !== 1) return null;
  const [row] = matches;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    jid: row.jid,
    cameraIds: row.camera_ids ? String(row.camera_ids).split(',').filter(Boolean) : [],
    status: row.status,
    motivo: row.motivo,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  mode,
  init,
  scopedKey,
  getCameras,
  upsertCamera,
  updateCamera,
  deleteCamera,
  addLog,
  getLog,
  hasRecentLog,
  getConversations,
  upsertConversation,
  incrementUnread,
  getMessages,
  addMessage,
  registerDelivery,
  updateDeliveryStatus,
  getDeliveries,
  findDeliveryByExternalId,
  markRead,
  isBlocked,
  hasConsent,
  getConsents,
  setConsent,
  ensureConsent,
  block,
  unblock,
  getBlocklist,
  getTemplates,
  getTemplate,
  upsertTemplate,
  deleteTemplate,
  renderTemplate,
  getBotConfig,
  setBotConfig,
  getReports,
  listUsers,
  createUser,
  getUserById,
  getUserByEmail,
  createSessionToken,
  getSessionByToken,
  deleteSessionToken,
  listInstances,
  upsertInstance,
  deleteInstance,
  createJob,
  claimJobs,
  finishJob,
  failJob,
  listJobs
};
