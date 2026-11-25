const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./server');
const { createBots, parseReply, localHour } = require('./bots');
const { extrairDDD } = require('./phone-utils');
const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const {
  findExistingNumber,
  normalizeDestination,
  textFromMessage,
  createInteractiveMessage,
  resolveDirectPhoneJid,
  waitForDeliveryAck,
  handleDeliveryStatus
} = require('./whatsapp');

function createMemoryDb(initialCameras = []) {
  const cameras = structuredClone(initialCameras);
  const logs = [];
  const conversations = new Map();
  const messages = new Map();
  const consent = new Map();
  const blocklist = new Map();
  const templates = new Map();
  const config = {
    auto_mode: 'true',
    max_attempts: '3',
    billing_hour: '9',
    maintenance_hour: '17',
    business_hours_start: '8',
    business_hours_end: '18'
  };
  return {
    cameras,
    logs,
    sentMessages: [],
    pool: { query: async () => ({ rows: [] }) },
    async getCameras() { return structuredClone(cameras); },
    async upsertCamera(camera) {
      const index = cameras.findIndex(item => String(item.id) === String(camera.id));
      if (index < 0) cameras.push(structuredClone(camera));
      else cameras[index] = { ...cameras[index], ...structuredClone(camera) };
    },
    async updateCamera(id, fields) {
      const camera = cameras.find(item => String(item.id) === String(id));
      if (!camera) throw new Error('not found');
      Object.assign(camera, structuredClone(fields));
    },
    async deleteCamera(id) {
      const index = cameras.findIndex(item => String(item.id) === String(id));
      if (index >= 0) cameras.splice(index, 1);
    },
    async addLog(entry) { logs.unshift(structuredClone(entry)); },
    async getLog() { return structuredClone(logs); },
    async hasRecentLog(phone, actions, since) {
      return logs.some(entry => actions.includes(entry.acao) &&
        entry.responsavel_telefone === phone &&
        Date.parse(entry.timestamp) >= Date.parse(since));
    },
    async getConversations() {
      return [...conversations.values()].map(item => ({ ...item })).sort((a, b) => b.lastTime.localeCompare(a.lastTime));
    },
    async upsertConversation(jid, name, lastMessage, lastTime) {
      const current = conversations.get(jid);
      conversations.set(jid, { jid, name, lastMessage, lastTime, unread: current?.unread || 0 });
    },
    async incrementUnread(jid) {
      const item = conversations.get(jid);
      if (item) item.unread++;
    },
    async getMessages(jid) { return structuredClone(messages.get(jid) || []); },
    async addMessage(jid, message) {
      const list = messages.get(jid) || [];
      if (list.some(item => item.id === message.id)) return false;
      list.push({ ...message });
      messages.set(jid, list);
      return true;
    },
    async markRead(jid) {
      const item = conversations.get(jid);
      if (item) item.unread = 0;
    },
    async isBlocked(phone) { return blocklist.has(phone); },
    async hasConsent(phone) { return consent.get(phone) === true; },
    async getConsents() {
      return [...consent.entries()].map(([phone, opted_in]) => ({ phone, opted_in }));
    },
    async setConsent(phone, optedIn) { consent.set(phone, optedIn); },
    async ensureConsent(phone) {
      if (consent.has(phone) || blocklist.has(phone)) return false;
      consent.set(phone, true);
      return true;
    },
    async block(phone, reason) { blocklist.set(phone, reason); },
    async unblock(phone) { blocklist.delete(phone); },
    async getTemplates() { return [...templates.values()]; },
    async getTemplate(id) { return templates.get(id) || null; },
    async upsertTemplate(template) { templates.set(template.id, { ...template }); },
    async deleteTemplate(id) { templates.delete(id); },
    renderTemplate(body, vars) {
      return Object.entries(vars).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), body);
    },
    async getBotConfig() { return { ...config }; },
    async setBotConfig(key, value) { config[key] = value; },
    async getReports() {
      const counts = {};
      for (const camera of cameras) counts[camera.status] = (counts[camera.status] || 0) + 1;
      return { counts, total: cameras.length, cobrancasEnviadas: logs.filter(log => log.acao === 'COBRANCA_ENVIADA').length };
    }
  };
}

function createTestWa(db) {
  let connected = false;
  return {
    sent: db.sentMessages,
    setIO() {},
    getStatus() { return { status: connected ? 'open' : 'disconnected', phone: connected ? '5511999990003' : null }; },
    async connect() { connected = true; },
    async disconnect() { connected = false; },
    async sendMessage(to, text) {
      if (!connected) throw new Error('WhatsApp nao conectado');
      db.sentMessages.push({ to, text });
      return { ok: true, id: `out_${db.sentMessages.length}` };
    },
    async sendButtons(to, text, buttons) {
      if (!connected) throw new Error('WhatsApp nao conectado');
      db.sentMessages.push({ to, text, buttons });
      return { ok: true, id: `out_${db.sentMessages.length}` };
    },
    async sendWithOptions(to, text, buttons) {
      return this.sendButtons(to, text, buttons);
    },
    async checkNumber(to) {
      return { phone: String(to).replace(/\D/g, ''), exists: true };
    }
  };
}

async function startServer(t, initialCameras = []) {
  const db = createMemoryDb(initialCameras);
  const wa = createTestWa(db);
  const bots = createBots({ db, wa, schedulerApi: { schedule: () => ({ stop() {} }) } });
  const app = createApp({ db, wa, bots, apiKey: '' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    db,
    wa,
    bots
  };
}

async function jsonRequest(baseUrl, route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  return { response, body: await response.json() };
}

const camera = {
  id: 'CAM-9001',
  camera_nome: 'CAM-9001',
  local: 'Unidade central',
  responsavel_nome: 'Equipe central',
  responsavel_telefone: '5511999990003',
  email: 'central@example.com',
  status: 'Pendente',
  tentativas: 0,
  ultima_cobranca: '',
  data_resolucao: '',
  observacoes: ''
};

test('health, dashboard assets, and private project files are served safely', async t => {
  const { baseUrl } = await startServer(t);
  const health = await jsonRequest(baseUrl, '/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: 'ok', cameras: 0 });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Painel de câmeras offline/);
  assert.equal((await fetch(`${baseUrl}/logo-sentry.png`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/server.js`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/data.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/auth_info/creds.json`)).status, 404);
});

test('camera API validates, filters, updates, deletes, and reports missing records', async t => {
  const { baseUrl } = await startServer(t);
  const invalid = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, responsavel_telefone: '123' })
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.codigo, 'VALIDATION_ERROR');

  const created = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(camera)
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.camera.id, camera.id);

  const filtered = await jsonRequest(baseUrl, '/api/cameras?status=Pendente&responsavel=central&q=9001');
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].camera_nome, camera.camera_nome);

  const updated = await jsonRequest(baseUrl, `/api/cameras/${camera.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Suporte', tentativas: 2, id: 'ignored', invalid_column: 'ignored' })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.camera.status, 'Suporte');
  assert.equal(updated.body.camera.id, camera.id);
  assert.equal(updated.body.camera.tentativas, 2);

  const deleted = await jsonRequest(baseUrl, `/api/cameras/${camera.id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const missing = await jsonRequest(baseUrl, `/api/cameras/${camera.id}`);
  assert.equal(missing.response.status, 404);
  const missingUpdate = await jsonRequest(baseUrl, `/api/cameras/${camera.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Resolvido' })
  });
  assert.equal(missingUpdate.response.status, 404);
});

test('camera API atualiza um grupo inteiro em uma única chamada em lote', async t => {
  const { baseUrl, db } = await startServer(t, [
    camera,
    { ...camera, id: 'CAM-9002', camera_nome: 'CAM-9002' }
  ]);
  let lotes = 0;
  db.updateCamerasBulk = async (ids, fields) => {
    lotes++;
    for (const id of ids) await db.updateCamera(id, fields);
    return ids.length;
  };

  const bulk = await jsonRequest(baseUrl, '/api/cameras/bulk', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: ['CAM-9001', 'CAM-9002'],
      fields: { responsavel_nome: 'Nova equipe', responsavel_telefone: '5511888887777' }
    })
  });
  assert.equal(bulk.response.status, 200);
  assert.equal(bulk.body.atualizadas, 2);
  assert.equal(lotes, 1);
  assert.equal(db.cameras.every(item => item.responsavel_nome === 'Nova equipe'), true);
  assert.equal(db.cameras.every(item => item.responsavel_telefone === '5511888887777'), true);

  const invalido = await jsonRequest(baseUrl, '/api/cameras/bulk', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['CAM-9001'], fields: { responsavel_telefone: '123' } })
  });
  assert.equal(invalido.response.status, 400);
  assert.equal(invalido.body.codigo, 'VALIDATION_ERROR');

  let lotesExclusao = 0;
  db.deleteCamerasBulk = async ids => {
    lotesExclusao++;
    for (const id of ids) await db.deleteCamera(id);
    return ids.length;
  };
  const excluidos = await jsonRequest(baseUrl, '/api/cameras/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['CAM-9001'] })
  });
  assert.equal(excluidos.response.status, 200);
  assert.equal(excluidos.body.excluidas, 1);
  assert.equal(lotesExclusao, 1);
  assert.equal(db.cameras.some(item => item.id === 'CAM-9001'), false);
});

test('POST camera remains an upsert and normalizes phone numbers', async t => {
  const { baseUrl } = await startServer(t);
  const first = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, responsavel_telefone: '+55 (11) 99999-0003' })
  });
  const upsert = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, observacoes: 'Atualizada' })
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.camera.responsavel_telefone, '5511999990003');
  assert.equal(upsert.response.status, 200);
  assert.equal(upsert.body.camera.observacoes, 'Atualizada');
});

test('camera registration records consent but preserves an existing opt-out', async t => {
  const { baseUrl, db } = await startServer(t);
  const create = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(camera)
  });
  assert.equal(create.response.status, 201);
  assert.equal(await db.hasConsent(camera.responsavel_telefone), true);

  const optOut = await jsonRequest(baseUrl, '/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: camera.responsavel_telefone, opted_in: false })
  });
  assert.equal(optOut.response.status, 200);

  const secondCamera = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, id: 'CAM-9002' })
  });
  assert.equal(secondCamera.response.status, 201);
  assert.equal(await db.hasConsent(camera.responsavel_telefone), false);
  assert.equal(await db.isBlocked(camera.responsavel_telefone), true);
});

test('WhatsApp endpoints report connection failures and validate outbound messages', async t => {
  const { baseUrl, wa } = await startServer(t);
  const status = await jsonRequest(baseUrl, '/api/whatsapp/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.status, 'disconnected');

  const offlineSend = await jsonRequest(baseUrl, '/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });
  assert.equal(offlineSend.response.status, 503);
  assert.equal(offlineSend.body.codigo, 'WHATSAPP_SEND_FAILED');

  await wa.connect();
  const sent = await jsonRequest(baseUrl, '/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });
  assert.equal(sent.response.status, 200);
  assert.equal(sent.body.ok, true);

  const invalid = await jsonRequest(baseUrl, '/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: '12', text: 'Aviso' })
  });
  assert.equal(invalid.response.status, 400);

  const missingConsent = await jsonRequest(baseUrl, '/api/whatsapp/send-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });
  assert.equal(missingConsent.response.status, 403);
  assert.equal(missingConsent.body.codigo, 'CONSENT_REQUIRED');
  assert.equal(wa.sent.length, 1);
});

test('opções clicáveis também respeitam bloqueio mesmo se houver consentimento registrado', async t => {
  const { baseUrl, db, wa } = await startServer(t);
  await db.setConsent(camera.responsavel_telefone, true);
  await db.block(camera.responsavel_telefone, 'Opt-out');

  const response = await jsonRequest(baseUrl, '/api/whatsapp/send-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });
  assert.equal(response.response.status, 403);
  assert.equal(response.body.codigo, 'CONTACT_BLOCKED');
  assert.equal(wa.sent.length, 0);
});

test('send-options reports accepted but unconfirmed delivery without treating it as success', async t => {
  const { baseUrl, db, wa } = await startServer(t);
  await db.setConsent(camera.responsavel_telefone, true);
  wa.sendWithOptions = async () => ({ ok: true, id: 'unconfirmed-id', deliveryStatus: 'unconfirmed' });

  const result = await jsonRequest(baseUrl, '/api/whatsapp/send-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.deliveryStatus, 'unconfirmed');
  assert.equal(result.body.id, 'unconfirmed-id');
});

test('send-options prevents concurrent duplicate sends to the same contact', async t => {
  const { baseUrl, db, wa } = await startServer(t);
  await db.setConsent(camera.responsavel_telefone, true);
  let releaseSend;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let sendCount = 0;
  wa.sendWithOptions = () => {
    sendCount++;
    markStarted();
    return new Promise(resolve => { releaseSend = resolve; });
  };
  const request = () => jsonRequest(baseUrl, '/api/whatsapp/send-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: camera.responsavel_telefone, text: 'Aviso' })
  });

  const firstRequest = request();
  await started;
  const duplicate = await request();
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.codigo, 'WHATSAPP_SEND_IN_PROGRESS');
  assert.equal(sendCount, 1);

  releaseSend({ ok: true, id: 'first-send', deliveryStatus: 'unconfirmed' });
  const first = await firstRequest;
  assert.equal(first.response.status, 202);
  assert.equal(first.body.id, 'first-send');
});

test('consent requires an explicit boolean and opt-out adds the number to the blocklist', async t => {
  const { baseUrl, db } = await startServer(t);
  const invalid = await jsonRequest(baseUrl, '/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: camera.responsavel_telefone, opted_in: 'false' })
  });
  assert.equal(invalid.response.status, 400);

  const optedIn = await jsonRequest(baseUrl, '/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: camera.responsavel_telefone, opted_in: true })
  });
  assert.equal(optedIn.response.status, 200);
  assert.equal(await db.hasConsent(camera.responsavel_telefone), true);

  const optedOut = await jsonRequest(baseUrl, '/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: camera.responsavel_telefone, opted_in: false })
  });
  assert.equal(optedOut.response.status, 200);
  assert.equal(await db.isBlocked(camera.responsavel_telefone), true);
});

test('log API validates filters and malformed JSON', async t => {
  const { baseUrl } = await startServer(t);
  const logged = await jsonRequest(baseUrl, '/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acao: 'COBRANCA_ENVIADA', camera_id: 'CAM-9001' })
  });
  assert.equal(logged.response.status, 201);
  assert.ok(logged.body.log.timestamp);

  const entries = await jsonRequest(baseUrl, '/api/log?acao=COBRANCA_ENVIADA&camera_id=CAM-9001&limit=1');
  assert.equal(entries.body.length, 1);
  const invalidLimit = await jsonRequest(baseUrl, '/api/log?limit=-1');
  assert.equal(invalidLimit.response.status, 400);

  const invalidJson = await fetch(`${baseUrl}/api/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).codigo, 'INVALID_JSON');
});

test('billing bot groups cameras, requires consent, deduplicates sends, and respects opt-out', async t => {
  const { db, wa, bots } = await startServer(t, [
    { ...camera, id: 'CAM-1', camera_nome: 'CAM-1' },
    { ...camera, id: 'CAM-2', camera_nome: 'CAM-2' },
    { ...camera, id: 'CAM-3', responsavel_telefone: '5511999990004', responsavel_nome: 'Sem consentimento' }
  ]);
  const now = new Date('2026-11-16T13:00:00.000Z');
  const skipped = await bots.runBillingBot({ now });
  assert.equal(skipped.sent, 0);
  assert.equal(wa.sent.length, 0);

  await wa.connect();
  await db.setConsent(camera.responsavel_telefone, true);
  const result = await bots.runBillingBot({ now });
  assert.equal(result.sent, 1);
  assert.equal(wa.sent.length, 1);
  assert.match(wa.sent[0].text, /CAM-1[\s\S]*CAM-2/);
  assert.equal((await db.getCameras()).filter(item => item.status === 'Aguardando resposta').length, 2);

  const duplicate = await bots.runBillingBot({ now });
  assert.equal(duplicate.sent, 0);
  assert.equal(wa.sent.length, 1);
  await db.block(camera.responsavel_telefone, 'PARAR');
  const inbound = await bots.onIncomingMessage(`${camera.responsavel_telefone}@s.whatsapp.net`, 'PARAR');
  assert.equal(inbound, undefined);
  assert.equal(wa.sent.length, 2);
  assert.match(wa.sent[1].text, /nao recebera mais/);
});

test('billing bot pauses retries for 24 hours after an unconfirmed send', async t => {
  const { db } = await startServer(t, [camera]);
  await db.setConsent(camera.responsavel_telefone, true);
  const failingWa = { async sendWithOptions() { throw new Error('delivery not confirmed'); } };
  const bots = createBots({
    db,
    wa: failingWa,
    schedulerApi: { schedule: () => ({ stop() {} }) }
  });
  const now = new Date();

  const first = await bots.runBillingBot({ now, force: true });
  assert.deepEqual(first, { sent: 0, failed: 1, unconfirmed: 0 });
  const retry = await bots.runBillingBot({ now: new Date(now.getTime() + 60 * 60 * 1000), force: true });
  assert.deepEqual(retry, { sent: 0, failed: 0, unconfirmed: 0 });
  assert.equal(db.logs.filter(entry => entry.acao === 'ERRO').length, 1);
});

test('billing bot keeps accepted but unconfirmed messages out of delivered status and deduplicates', async t => {
  const { db, wa } = await startServer(t, [camera]);
  await db.setConsent(camera.responsavel_telefone, true);
  let sendCount = 0;
  wa.sendWithOptions = async () => {
    sendCount++;
    return { ok: true, id: 'unconfirmed-id', deliveryStatus: 'unconfirmed' };
  };
  const bots = createBots({
    db,
    wa,
    schedulerApi: { schedule: () => ({ stop() {} }) }
  });
  const now = new Date();

  const result = await bots.runBillingBot({ now, force: true });
  assert.deepEqual(result, { sent: 0, failed: 0, unconfirmed: 1 });
  const [updated] = await db.getCameras();
  assert.equal(updated.status, 'Pendente');
  assert.equal(updated.tentativas, 1);
  assert.equal(updated.ultima_cobranca, now.toISOString());
  assert.equal(db.logs[0].acao, 'ENVIO_SEM_CONFIRMACAO');

  const retry = await bots.runBillingBot({ now: new Date(now.getTime() + 60 * 60 * 1000), force: true });
  assert.deepEqual(retry, { sent: 0, failed: 0, unconfirmed: 0 });
  assert.equal(sendCount, 1);
});

test('billing bot tracks Meta sends as pending without marking cameras delivered', async t => {
  const { db } = await startServer(t, [camera]);
  await db.setConsent(camera.responsavel_telefone, true);
  let sendCount = 0;
  let metadata;
  const wa = {
    async sendWithOptions(...args) {
      sendCount++;
      metadata = args[4];
      return { ok: true, id: 'wamid-meta-1', deliveryStatus: 'pendente' };
    }
  };
  const bots = createBots({
    db,
    wa,
    schedulerApi: { schedule: () => ({ stop() {} }) }
  });
  const now = new Date();

  const result = await bots.runBillingBot({ now, force: true, tenantId: 'default', instanceId: 'default' });
  assert.deepEqual(result, { sent: 0, failed: 0, unconfirmed: 0, pending: 1 });
  assert.deepEqual(metadata, { tenantId: 'default', instanceId: 'default', cameraIds: [camera.id] });
  const [updated] = await db.getCameras();
  assert.equal(updated.status, 'Pendente');
  assert.equal(updated.tentativas, 0);
  assert.equal(db.logs[0].acao, 'ENVIO_AGUARDANDO_CONFIRMACAO');

  const retry = await bots.runBillingBot({ now: new Date(now.getTime() + 60 * 60 * 1000), force: true });
  assert.deepEqual(retry, { sent: 0, failed: 0, unconfirmed: 0 });
  assert.equal(sendCount, 1);
});

test('billing bot deduplicates from camera timestamp when its send log is missing', async t => {
  const { db, wa, bots } = await startServer(t, [{
    ...camera,
    status: 'Aguardando resposta',
    tentativas: 1,
    ultima_cobranca: new Date().toISOString()
  }]);
  await db.setConsent(camera.responsavel_telefone, true);
  await wa.connect();

  const result = await bots.runBillingBot({ now: new Date(), force: true });
  assert.deepEqual(result, { sent: 0, failed: 0, unconfirmed: 0 });
  assert.equal(wa.sent.length, 0);
});

test('incoming WhatsApp choices update only matching cameras and parse common replies', async t => {
  const { db, wa, bots } = await startServer(t, [camera]);
  await wa.connect();
  await bots.onIncomingMessage(`${camera.responsavel_telefone}@s.whatsapp.net`, '3');
  assert.equal((await db.getCameras())[0].status, 'Aguardando validacao');
  assert.equal(db.logs[0].acao, 'RESPOSTA_RECEBIDA');
  assert.equal(wa.sent.length, 1);
  assert.equal(parseReply('Preciso falar com técnico').status, 'Suporte');
  assert.equal(parseReply('PARAR').intent, 'opt_out');
  assert.equal(localHour(new Date('2026-11-16T13:00:00.000Z')), 9);
});

test('manual bots ignore automatic mode and can run outside business hours', async t => {
  const { baseUrl, db, wa } = await startServer(t, [camera]);
  await db.setConsent(camera.responsavel_telefone, true);
  await db.setBotConfig('auto_mode', 'false');
  await wa.connect();

  const billing = await jsonRequest(baseUrl, '/api/bots/billing/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(billing.response.status, 200);
  assert.equal(billing.body.result.sent, 1);
});

test('temporary business hours allow sends only on the configured date through midnight', async t => {
  const { db, wa, bots } = await startServer(t, [camera]);
  await db.setConsent(camera.responsavel_telefone, true);
  await wa.connect();
  await db.setBotConfig('business_hours_override_date', '2026-11-22');
  await db.setBotConfig('business_hours_override_start', '18');
  await db.setBotConfig('business_hours_override_end', '24');

  const withinWindow = await bots.runBillingBot({ now: new Date('2026-11-22T22:00:00.000Z') });
  assert.equal(withinWindow.sent, 1);

  const atMidnight = await bots.runBillingBot({ now: new Date('2026-11-23T04:00:00.000Z') });
  assert.equal(atMidnight.skipped, 'outside business hours');
});

test('temporary business-hours configuration accepts midnight and rejects invalid intervals', async t => {
  const { baseUrl } = await startServer(t);
  const settings = {
    business_hours_override_date: '2026-11-22',
    business_hours_override_start: '18',
    business_hours_override_end: '24'
  };
  const saved = await jsonRequest(baseUrl, '/api/bots/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(
    Object.fromEntries(Object.entries(await (await jsonRequest(baseUrl, '/api/bots/config')).body)
      .filter(([key]) => key.startsWith('business_hours_override_'))),
    settings
  );

  const invalid = await jsonRequest(baseUrl, '/api/bots/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, business_hours_override_end: '25' })
  });
  assert.equal(invalid.response.status, 400);
});

test('partial camera updates and template writes reject invalid required fields', async t => {
  const { baseUrl } = await startServer(t, [camera]);
  const invalidPhone = await jsonRequest(baseUrl, `/api/cameras/${camera.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responsavel_telefone: '' })
  });
  assert.equal(invalidPhone.response.status, 400);

  const invalidTemplate = await jsonRequest(baseUrl, '/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '', nome: '', corpo: '' })
  });
  assert.equal(invalidTemplate.response.status, 400);
  assert.equal(invalidTemplate.body.codigo, 'VALIDATION_ERROR');

  const savedTemplate = await jsonRequest(baseUrl, '/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'aviso', nome: 'Aviso', corpo: 'Olá {nome}', variaveis: 'nome' })
  });
  assert.equal(savedTemplate.response.status, 200);

  const updatedTemplate = await jsonRequest(baseUrl, '/api/templates/aviso', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Aviso atualizado', corpo: 'Novo texto {nome}', variaveis: 'nome' })
  });
  assert.equal(updatedTemplate.response.status, 200);
});

test('DDD invalido e rejeitado no cadastro e na consulta do WhatsApp', async t => {
  assert.equal(extrairDDD('+55 (65) 98113-3033'), '65');
  assert.equal(extrairDDD('5565981130338@s.whatsapp.net'), '65');
  assert.equal(extrairDDD('5510999990003'), null);

  const { baseUrl } = await startServer(t);
  const invalid = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, id: 'CAM-DDD-INVALIDO', responsavel_telefone: '5510999990003' })
  });
  assert.equal(invalid.response.status, 400);

  const invalidCheck = await jsonRequest(baseUrl, '/api/whatsapp/check/5510999990003');
  assert.equal(invalidCheck.response.status, 400);

  const validCheck = await jsonRequest(baseUrl, '/api/whatsapp/check/5548999990001');
  assert.equal(validCheck.response.status, 200);
  assert.equal(validCheck.body.exists, true);
});

test('destino do WhatsApp usa a normalização central para todos os formatos', () => {
  assert.equal(normalizeDestination('065999998888'), '5565999998888');
  assert.equal(normalizeDestination('65999998888'), '5565999998888');
  assert.equal(normalizeDestination('+55 (65) 99999-8888'), '5565999998888');
  assert.equal(normalizeDestination('556599998888'), '556599998888');
  assert.equal(normalizeDestination('5565999998888@s.whatsapp.net'), '5565999998888');
  assert.equal(normalizeDestination('5565999998888@c.us'), '5565999998888');
  assert.equal(normalizeDestination('12345'), null);
});

test('WhatsApp reconhece número existente quando o JID retornado é LID', () => {
  const result = findExistingNumber([{ jid: '123456789@lid', exists: true }]);
  assert.equal(result.jid, '123456789@lid');
});

test('findExistingNumber prefere o JID de telefone ao LID', () => {
  const result = findExistingNumber([
    { jid: '123456789@lid', exists: true },
    { jid: '5565999998888@c.us', exists: true }
  ]);
  assert.equal(result.jid, '5565999998888@c.us');
});

test('respostas recebidas por LID são associadas ao JID de telefone, não ao ID LID', async () => {
  assert.equal(
    await resolveDirectPhoneJid({
      remoteJid: '123456789@lid',
      remoteJidAlt: '5511999990003@s.whatsapp.net'
    }),
    '5511999990003@s.whatsapp.net'
  );
  assert.equal(
    await resolveDirectPhoneJid(
      { remoteJid: '123456789@lid' },
      { getPNForLID: async () => '5511999990003@s.whatsapp.net' }
    ),
    '5511999990003@s.whatsapp.net'
  );
  assert.equal(await resolveDirectPhoneJid({ remoteJid: '123456789@lid' }), null);
});

test('notificação gera opções clicáveis para o cliente e interpreta a resposta selecionada', () => {
  const message = createInteractiveMessage('Como prefere prosseguir?', [
    { id: '1', text: 'Estou verificando' },
    { id: '2', text: 'Preciso de suporte' },
    { id: '3', text: 'Já resolvi' }
  ]);
  const generated = generateWAMessageFromContent(
    '123456789@s.whatsapp.net',
    message,
    { userJid: '987654321@s.whatsapp.net' }
  );
  assert.ok(generated.key.id);
  const interactive = generated.message.interactiveMessage;
  assert.equal(generated.message.viewOnceMessage, null);
  assert.equal(interactive.nativeFlowMessage.messageVersion, 3);
  assert.ok(interactive.nativeFlowMessage.messageParamsJson);
  const buttons = interactive.nativeFlowMessage.buttons.map(button => JSON.parse(button.buttonParamsJson));
  assert.deepEqual(buttons, [
    { display_text: 'Estou verificando', id: '1' },
    { display_text: 'Preciso de suporte', id: '2' },
    { display_text: 'Já resolvi', id: '3' }
  ]);

  const reply = textFromMessage({
    interactiveResponseMessage: {
      nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: '2', display_text: 'Preciso de suporte' }) }
    }
  });
  assert.equal(parseReply(reply).intent, 'support');
});

test('envio interativo só confirma após ACK de entrega, não apenas ACK do servidor', async () => {
  const messageId = 'delivery-ack-test';
  const delivery = waitForDeliveryAck(messageId, 1000);
  let settled = false;
  delivery.promise.then(() => { settled = true; }, () => { settled = true; });

  handleDeliveryStatus(messageId, proto.WebMessageInfo.Status.SERVER_ACK);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  handleDeliveryStatus(messageId, proto.WebMessageInfo.Status.DELIVERY_ACK);
  assert.equal(await delivery.promise, proto.WebMessageInfo.Status.DELIVERY_ACK);

  const timeout = waitForDeliveryAck('delivery-ack-timeout', 5);
  await assert.rejects(timeout.promise, error =>
    error.code === 'DELIVERY_UNCONFIRMED' && /nao confirmou a entrega/.test(error.message)
  );
});
