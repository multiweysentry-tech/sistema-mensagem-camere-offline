// Armazenamento em memoria usado apenas no Vercel quando nao ha Postgres remoto configurado.
// Objetivo: manter o painel e as APIs funcionais sem retornar 500. Os dados nao persistem
// entre invocacoes/instancias. Defina PG_HOST/PG_PASSWORD com um banco alcancavel para persistir.
const mode = 'memory';

const state = {
  cameras: new Map(),
  log: [],
  conversations: new Map(),
  messages: new Map(),
  consent: new Map(),
  blocklist: new Map(),
  templates: new Map(),
  botConfig: new Map()
};

const CAMERA_FIELDS = ['camera_nome', 'local', 'responsavel_nome', 'responsavel_telefone', 'email', 'status', 'tentativas', 'ultima_cobranca', 'data_resolucao', 'observacoes'];

async function init() {
  const now = new Date().toISOString();
  if (!state.templates.has('cobranca_padrao')) {
    state.templates.set('cobranca_padrao', {
      id: 'cobranca_padrao',
      nome: 'Cobrança de câmeras offline',
      corpo: 'Olá, {nome_cliente}!\nO Sentry identificou que estas câmeras estão offline:\n{lista_cameras}\n\nO que você prefere fazer?\n1. Estou analisando\n2. Preciso falar com técnico\n3. Já resolvi',
      variaveis: 'nome_cliente,lista_cameras',
      created_at: now,
      updated_at: now
    });
  }
  const defaults = { billing_days_before: '3', billing_days_after: '1,3,7', billing_hour: '9', maintenance_hour: '17', auto_mode: 'true', max_attempts: '3', business_hours_start: '8', business_hours_end: '18' };
  for (const [key, value] of Object.entries(defaults)) {
    if (!state.botConfig.has(key)) state.botConfig.set(key, { key, value, updated_at: now });
  }
  console.log('[DB] Schema em memoria pronto (dados nao persistem no Vercel)');
}

async function getCameras() {
  return [...state.cameras.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function upsertCamera(cam) {
  const current = state.cameras.get(cam.id) || {};
  const row = { id: cam.id };
  for (const field of CAMERA_FIELDS) row[field] = cam[field] ?? current[field] ?? '';
  if (row.status === undefined || row.status === '') row.status = 'Pendente';
  state.cameras.set(cam.id, row);
}

async function updateCamera(id, fields) {
  const current = state.cameras.get(id);
  if (!current) return;
  for (const field of CAMERA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) current[field] = fields[field];
  }
}

async function deleteCamera(id) {
  state.cameras.delete(id);
}

async function addLog(entry) {
  state.log.push({ id: state.log.length + 1, ...entry });
}

async function getLog() {
  return [...state.log].reverse().slice(0, 200);
}

async function hasRecentLog(phone, actions, since) {
  const limit = new Date(since).getTime();
  return state.log.some(entry =>
    entry.responsavel_telefone === phone &&
    actions.includes(entry.acao) &&
    !Number.isNaN(new Date(entry.timestamp).getTime()) &&
    new Date(entry.timestamp).getTime() >= limit
  );
}

async function getConversations() {
  return [...state.conversations.values()]
    .map(c => ({ jid: c.jid, name: c.name, lastMessage: c.last_message, lastTime: c.last_time, unread: c.unread }))
    .sort((a, b) => String(b.lastTime).localeCompare(String(a.lastTime)));
}

async function upsertConversation(jid, name, lastMessage, lastTime) {
  const current = state.conversations.get(jid) || { jid, unread: 0 };
  state.conversations.set(jid, { ...current, jid, name, last_message: lastMessage, last_time: lastTime });
}

async function incrementUnread(jid) {
  const current = state.conversations.get(jid);
  if (current) current.unread = Number(current.unread || 0) + 1;
}

async function getMessages(jid) {
  return [...state.messages.values()]
    .filter(m => m.jid === jid)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map(m => ({ id: m.id, from: m.jid, text: m.text, time: m.time, direction: m.direction }));
}

async function addMessage(jid, msg) {
  if (state.messages.has(msg.id)) return false;
  state.messages.set(msg.id, { ...msg, jid });
  return true;
}

async function markRead(jid) {
  const current = state.conversations.get(jid);
  if (current) current.unread = 0;
}

async function isBlocked(phone) {
  return state.blocklist.has(phone);
}

async function hasConsent(phone) {
  return state.consent.get(phone)?.opted_in === 1;
}

async function getConsents() {
  return [...state.consent.values()]
    .map(row => ({ phone: row.phone, opted_in: Number(row.opted_in) === 1, updated_at: row.updated_at }))
    .sort((a, b) => String(a.phone).localeCompare(String(b.phone)));
}

async function setConsent(phone, optedIn) {
  if (typeof optedIn !== 'boolean') throw new TypeError('optedIn deve ser booleano');
  state.consent.set(phone, { phone, opted_in: optedIn ? 1 : 0, updated_at: new Date().toISOString() });
}

async function block(phone, reason) {
  if (!state.blocklist.has(phone)) state.blocklist.set(phone, { phone, reason: reason || '', created_at: new Date().toISOString() });
}

async function unblock(phone) {
  state.blocklist.delete(phone);
}

async function getBlocklist() {
  return [...state.blocklist.values()].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function getTemplates() {
  return [...state.templates.values()].sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
}

async function getTemplate(id) {
  return state.templates.get(id) || null;
}

async function upsertTemplate(tpl) {
  const now = new Date().toISOString();
  const current = state.templates.get(tpl.id);
  state.templates.set(tpl.id, {
    id: tpl.id,
    nome: tpl.nome,
    corpo: tpl.corpo,
    variaveis: tpl.variaveis || '',
    created_at: current?.created_at || now,
    updated_at: now
  });
}

async function deleteTemplate(id) {
  state.templates.delete(id);
}

function renderTemplate(corpo, vars) {
  let out = corpo;
  for (const [key, value] of Object.entries(vars || {})) out = out.split(`{${key}}`).join(String(value));
  return out;
}

async function getBotConfig() {
  const cfg = {};
  for (const [key, row] of state.botConfig) cfg[key] = row.value;
  return cfg;
}

async function setBotConfig(key, value) {
  state.botConfig.set(key, { key, value, updated_at: new Date().toISOString() });
}

async function getReports() {
  const cameras = [...state.cameras.values()];
  const logs = [...state.log];
  const counts = { Pendente: 0, 'Aguardando resposta': 0, Verificando: 0, Suporte: 0, 'Aguardando validacao': 0, Resolvido: 0 };
  for (const c of cameras) {
    const status = String(c.status || '').trim();
    if (counts[status] !== undefined) counts[status]++;
  }
  const resolvidas = cameras.filter(c => c.status === 'Resolvido' && c.data_resolucao);
  let tempoMedio = null;
  if (resolvidas.length > 0) {
    const total = resolvidas.reduce((acc, c) => acc + (new Date(c.data_resolucao) - new Date(c.ultima_cobranca || c.data_resolucao)), 0);
    tempoMedio = Math.round(total / resolvidas.length / 3600000);
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayMessages = [...state.messages.values()].filter(m => String(m.time).startsWith(today));
  return {
    counts,
    total: cameras.length,
    tempoMedioHoras: tempoMedio,
    cobrancasEnviadas: logs.filter(l => l.acao === 'COBRANCA_ENVIADA').length,
    erros: logs.filter(l => l.acao === 'ERRO').length,
    escalonamentos: logs.filter(l => l.acao === 'ESCALONAMENTO').length,
    resolvidas: resolvidas.length,
    enviadasHoje: todayMessages.filter(m => m.direction === 'out').length,
    recebidasHoje: todayMessages.filter(m => m.direction === 'in').length,
    clientesAguardando: [...state.conversations.values()].filter(c => Number(c.unread) > 0).length
  };
}

module.exports = {
  mode,
  init,
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
  markRead,
  isBlocked,
  hasConsent,
  getConsents,
  setConsent,
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
  getReports
};
