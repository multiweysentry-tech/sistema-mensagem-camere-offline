const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./server');
const { createBots, parseReply, localHour } = require('./bots');

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

test('POST camera remains an upsert and normalizes phone numbers', async t => {
  const { baseUrl } = await startServer(t);
  const first = await jsonRequest(baseUrl, '/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...camera, responsavel_telefone: '+55 (65) 99999-1234' })
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
