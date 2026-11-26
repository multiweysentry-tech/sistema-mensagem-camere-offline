const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const { createApp } = require('./server');
const { createAuth, hashPassword } = require('./auth');
const { createSessionManager, shouldAutoConnect } = require('./session-manager');
const { createQueue } = require('./queue');
const { scopedKey } = require('./db');

function createPlatformDb() {
  const users = new Map();
  const sessions = new Map();
  const cameras = [];
  const instances = new Map();
  const jobs = new Map();
  return {
    users, sessions, cameras, instances, jobs,
    async getUserByEmail(email) {
      return [...users.values()].find(user => user.email === String(email).toLowerCase()) || null;
    },
    async getUserById(id) { return users.get(id) || null; },
    async createUser(user) {
      const row = { ...user, tenant_id: user.tenantId || user.tenant_id || 'default' };
      users.set(row.id, row);
      return row;
    },
    async listUsers() { return [...users.values()]; },
    async createSessionToken(userId, tokenHash, expiresAt) {
      sessions.set(tokenHash, { userId, expiresAt });
    },
    async getSessionByToken(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
      return users.get(session.userId) || null;
    },
    async deleteSessionToken(tokenHash) { sessions.delete(tokenHash); },
    async getCameras(tenantId = 'default') {
      return cameras.filter(camera => camera.tenant_id === tenantId).map(camera => ({ ...camera }));
    },
    async upsertCamera(camera, tenantId = 'default') {
      cameras.push({ ...camera, tenant_id: tenantId });
    },
    async listInstances() { return [...instances.values()]; },
    async upsertInstance({ tenantId, instanceId, label, autoConnect }) {
      instances.set(`${tenantId}::${instanceId}`, {
        tenant_id: tenantId, instance_id: instanceId, label, auto_connect: autoConnect ? 1 : 0
      });
    },
    async deleteInstance(tenantId, instanceId) { instances.delete(`${tenantId}::${instanceId}`); },
    async createJob(job) {
      const key = `${job.tenantId}::${job.idempotencyKey}`;
      if (jobs.has(key)) return { rowCount: 0 };
      jobs.set(key, {
        ...job, id: job.id, tenant_id: job.tenantId, payload: JSON.stringify(job.payload || {}),
        status: 'pending', attempts: 0, max_attempts: job.maxAttempts || 3,
        run_at: job.runAt || new Date().toISOString()
      });
      return { rowCount: 1 };
    },
    async claimJobs({ kinds, limit = 10, workerId } = {}) {
      const now = new Date().toISOString();
      const claimed = [];
      for (const job of jobs.values()) {
        if (claimed.length >= limit) break;
        if (job.status !== 'pending' || Date.parse(job.run_at) > Date.now()) continue;
        if (kinds && kinds.length && !kinds.includes(job.kind)) continue;
        job.status = 'processing';
        job.locked_by = workerId;
        job.attempts += 1;
        claimed.push({ ...job });
      }
      return claimed;
    },
    async finishJob(id) {
      for (const job of jobs.values()) {
        if (job.id === id) { job.status = 'done'; break; }
      }
    },
    async failJob(id, error) {
      for (const job of jobs.values()) {
        if (job.id !== id) continue;
        job.last_error = String(error?.message || error);
        job.status = job.attempts >= job.max_attempts ? 'failed' : 'pending';
        job.locked_by = null;
        break;
      }
    },
    async listJobs(tenantId = 'default') {
      return [...jobs.values()].filter(job => job.tenant_id === tenantId);
    }
  };
}

function createNoopWa() {
  return {
    setIO() {},
    getStatus() { return { status: 'disconnected', qr: null, phone: null }; },
    async connect() {},
    async disconnect() {},
    async sendMessage() { return { ok: true }; },
    async sendWithOptions() { return { ok: true }; },
    async checkNumber(to) { return { phone: to, exists: true }; }
  };
}

function createNoopBots() {
  return {
    startSchedulers() {},
    getSchedulerStatus() { return 'inactive'; },
    async runBillingBot() { return { sent: 0 }; },
    async runMaintenanceBot() { return { sent: 0 }; },
    async onIncomingMessage() {}
  };
}

async function startAuthServer(t, db, auth) {
  const app = createApp({ db, wa: createNoopWa(), bots: createNoopBots(), auth, apiKey: '' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('auth exige sessao, isola tenants e permite login', async t => {
  const db = createPlatformDb();
  await db.createUser({
    id: 'user-a', tenantId: 'tenant-a', email: 'a@example.com', name: 'A',
    password_hash: hashPassword('senha-longa-123'), role: 'admin'
  });
  await db.createUser({
    id: 'user-b', tenantId: 'tenant-b', email: 'b@example.com', name: 'B',
    password_hash: hashPassword('outra-senha-123'), role: 'admin'
  });
  await db.upsertCamera({ id: 'CAM-A' }, 'tenant-a');
  await db.upsertCamera({ id: 'CAM-B' }, 'tenant-b');

  const auth = createAuth({ db });
  const baseUrl = await startAuthServer(t, db, auth);

  const anonymous = await fetch(`${baseUrl}/api/cameras`);
  assert.equal(anonymous.status, 401);

  const wrong = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com', password: 'errada' })
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com', password: 'senha-longa-123' })
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('sentry_session='));

  const listA = await fetch(`${baseUrl}/api/cameras`, { headers: { Cookie: cookie } });
  assert.equal(listA.status, 200);
  const camerasA = await listA.json();
  assert.deepEqual(camerasA.map(camera => camera.id), ['CAM-A']);

  const loginB = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'b@example.com', password: 'outra-senha-123' })
  });
  const cookieB = String(loginB.headers.get('set-cookie') || '').split(';')[0];
  const listB = await fetch(`${baseUrl}/api/cameras`, { headers: { Cookie: cookieB } });
  const camerasB = await listB.json();
  assert.deepEqual(camerasB.map(camera => camera.id), ['CAM-B']);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/cameras`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);
});

test('session-manager nao duplica sessoes e isola por tenant', () => {
  const manager = createSessionManager({ db: createPlatformDb() });
  const first = manager.getOrCreate('tenant-a', 'principal');
  const same = manager.getOrCreate('tenant-a', 'principal');
  const otherInstance = manager.getOrCreate('tenant-a', 'filial');
  const otherTenant = manager.getOrCreate('tenant-b', 'principal');

  assert.equal(first, same);
  assert.notEqual(first, otherInstance);
  assert.notEqual(first, otherTenant);
  assert.equal(manager.list('tenant-a').length, 2);
  assert.equal(manager.list('tenant-b').length, 1);
  assert.equal(first.getStatus().instanceId, 'principal');
  assert.equal(first.getStatus().tenantId, 'tenant-a');
});

test('restore reconhece auto_connect do Postgres como inteiro', () => {
  assert.equal(shouldAutoConnect({ auto_connect: 1 }), true);
  assert.equal(shouldAutoConnect({ auto_connect: '1' }), true);
  assert.equal(shouldAutoConnect({ auto_connect: true }), true);
  assert.equal(shouldAutoConnect({ auto_connect: 0 }), false);
  assert.equal(shouldAutoConnect(null), false);
});

test('fila persistente e idempotente com retry controlado', async () => {
  const db = createPlatformDb();
  const queue = createQueue({ db, workerId: 'test-worker', pollMs: 100000 });
  let attempts = 0;
  queue.register('send_text', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('falha transitória');
  });

  const first = await queue.enqueue({
    kind: 'send_text', tenantId: 'tenant-a', instanceId: 'principal',
    payload: { to: '5511999990001', text: 'oi' }, idempotencyKey: 'campanha-1'
  });
  const duplicate = await queue.enqueue({
    kind: 'send_text', tenantId: 'tenant-a', instanceId: 'principal',
    payload: { to: '5511999990001', text: 'oi' }, idempotencyKey: 'campanha-1'
  });
  assert.equal(first.queued, true);
  assert.equal(duplicate.queued, false);

  await queue.tick();
  let jobs = await db.listJobs('tenant-a');
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].attempts, 1);
  assert.equal(jobs[0].last_error, 'falha transitória');

  await queue.tick();
  jobs = await db.listJobs('tenant-a');
  assert.equal(jobs[0].status, 'done');
  assert.equal(attempts, 2);
  queue.stop();
});

test('scopedKey mantem tenant padrao e isola os demais', () => {
  assert.equal(scopedKey('CAM-1', 'default'), 'CAM-1');
  assert.equal(scopedKey('CAM-1', 'tenant-a'), 'tenant-a::CAM-1');
  assert.equal(scopedKey(null, 'tenant-a'), null);
});

test('schema legado do log recebe a coluna trace_id na inicialização', () => {
  const dbSource = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
  const initBody = dbSource.slice(
    dbSource.indexOf('async function init()'),
    dbSource.indexOf('async function getCameras')
  );

  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS log \([\s\S]*?trace_id TEXT/);
  assert.match(dbSource, /INSERT INTO log \([\s\S]*?trace_id\)/);
  const alterIndex = initBody.indexOf('ALTER TABLE log ADD COLUMN IF NOT EXISTS trace_id');
  const schemaIndex = initBody.indexOf('CREATE TABLE IF NOT EXISTS log');
  assert.ok(schemaIndex >= 0 && alterIndex > schemaIndex, 'a migration precisa rodar na init()');
});

test('modulos da plataforma compilam sem erros de sintaxe', () => {
  const files = [
    'auth.js', 'db.js', 'db-memory.js', 'logger.js', 'queue.js',
    'session-manager.js', 'wa-protocol.js', 'wa-session.js', 'whatsapp.js',
    'server.js', 'bots.js', 'api/index.js'
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), `syntax error em ${file}`);
  }
});

test('painel expoe login, instancias e diagnostico sem credenciais no cliente', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /api\/auth\/login/);
  assert.match(html, /api\/instances/);
  assert.match(html, /api\/jobs/);
  assert.match(html, /loginView\(\)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});
