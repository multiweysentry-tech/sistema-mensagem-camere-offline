const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./server');

function createMemoryDb() {
  const cameras = [];
  const logs = [];
  return {
    cameras,
    logs,
    async getCameras() { return cameras.map(camera => ({ ...camera })); },
    async upsertCamera(camera, tenantId) {
      const current = cameras.find(item => String(item.id) === String(camera.id));
      if (current) {
        Object.assign(current, camera, {
          responsavel_telefone: current.responsavel_telefone || camera.responsavel_telefone
        });
      } else {
        cameras.push({ ...camera, tenantId: tenantId || 'default' });
      }
    },
    async updateCamera(id, fields) {
      const camera = cameras.find(item => String(item.id) === String(id));
      if (!camera) throw new Error('not found');
      Object.assign(camera, fields);
    },
    async addLog(entry) { logs.unshift({ ...entry }); },
    async getLog() { return logs.map(log => ({ ...log })); }
  };
}

function createTestWa() {
  return {
    sent: [],
    setIO() {},
    async getStatus() { return { status: 'disconnected' }; },
    async sendMessage() { throw new Error('o bot NOC não deve enviar mensagens'); },
    async sendWithOptions() { throw new Error('o bot NOC não deve enviar mensagens'); }
  };
}

async function startServer(t) {
  const db = createMemoryDb();
  const wa = createTestWa();
  const bots = {
    async runBillingBot() { return { sent: 0, failed: 0, unconfirmed: 0 }; },
    async runMaintenanceBot() { return { sent: 0, failed: 0, unconfirmed: 0 }; },
    getSchedulerStatus() { return {}; },
    async startSchedulers() {}
  };
  const app = createApp({ db, wa, bots, apiKey: '' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  return { db, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function jsonRequest(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('bot NOC cria rascunhos a partir da relação do Painel NOC sem enviar mensagens', async t => {
  const { db, baseUrl } = await startServer(t);
  const csv = [
    'ID;Nome;Município;Responsável;Status;Tempo offline',
    '9001;CAM 9001;Cuiabá;João Silva;Offline;2 h',
    '9002;CAM 9002;Sinop;;Offline;40 min'
  ].join('\n');

  const bot = await jsonRequest(baseUrl, '/api/bots/noc/run', { csv });
  assert.equal(bot.status, 200);
  assert.equal(bot.body.ok, true);
  assert.equal(bot.body.result.created, 2);
  assert.equal(bot.body.result.drafts, 2);
  assert.equal(bot.body.result.sent, 0);
  assert.equal(db.cameras.length, 2);
  assert.equal(db.cameras[0].id, 'NOC-9001');
  assert.equal(db.cameras.every(camera => camera.responsavel_telefone === ''), true);
  assert.equal(db.logs.some(log => log.acao === 'BOT_NOC'), true);

  const cameras = await (await fetch(`${baseUrl}/api/cameras`)).json();
  assert.equal(cameras.length, 2);
  assert.equal(cameras.every(camera => camera.status === 'Pendente'), true);
});

test('scan NOC não grava e apply NOC cadastra contato sem disparar envio', async t => {
  const { db, baseUrl } = await startServer(t);
  const csv = [
    'ID;Nome;Município;Responsável;Status',
    '9010;CAM 9010;Cuiabá;Maria;Offline'
  ].join('\n');

  const scan = await jsonRequest(baseUrl, '/api/import/noc/scan', { csv });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.result.offline, 1);
  assert.equal(db.cameras.length, 0, 'scan é somente leitura');

  const bot = await jsonRequest(baseUrl, '/api/bots/noc/run', { csv });
  assert.equal(bot.body.result.created, 1);
  const cameraId = db.cameras[0].id;

  const apply = await jsonRequest(baseUrl, '/api/import/noc/apply', {
    assignments: [{
      cameraId,
      responsavel_nome: 'Maria',
      responsavel_telefone: '(65) 98888-7777',
      local: 'Cuiabá'
    }]
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.summary.applied, 1);
  assert.equal(db.cameras[0].responsavel_telefone, '5565988887777');
  assert.equal(db.logs.some(log => log.acao === 'DESTINACAO_NOC'), true);

  const invalid = await jsonRequest(baseUrl, '/api/import/noc/apply', {
    assignments: [{ cameraId, responsavel_telefone: '123' }]
  });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.summary.applied, 0);
  assert.equal(invalid.body.summary.skipped, 1);
});

test('bot NOC aceita a relação completa do painel sem limite de 1 MB', async t => {
  const { db, baseUrl } = await startServer(t);
  const nomeLongo = 'CÂMERA DE MONITORAMENTO '.repeat(40);
  const items = Array.from({ length: 1200 }, (_, i) => ({
    id: String(20000 + i),
    nome: `${nomeLongo} ${i}`,
    municipio: 'Cuiabá',
    status: 'Offline'
  }));
  const corpo = JSON.stringify({ items });
  assert.ok(Buffer.byteLength(corpo, 'utf8') > 1024 * 1024, 'o teste precisa exceder 1 MB');

  const bot = await jsonRequest(baseUrl, '/api/bots/noc/run', { items });
  assert.equal(bot.status, 200);
  assert.equal(bot.body.ok, true);
  assert.equal(bot.body.result.drafts, 1200);
  assert.equal(db.cameras.length, 1200);
});
