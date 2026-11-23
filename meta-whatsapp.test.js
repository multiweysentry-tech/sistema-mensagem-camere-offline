const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createMetaWhatsapp } = require('./lib/meta-whatsapp');
const { registerMetaWebhook } = require('./lib/meta-webhook');

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('Meta Cloud API sends approved template and records pending delivery metadata', async () => {
  let request;
  const recorded = {};
  const db = {
    async registerDelivery(entry, tenantId) { recorded.delivery = { ...entry, tenantId }; },
    async upsertConversation(...args) { recorded.conversation = args; },
    async addMessage(...args) { recorded.message = args; }
  };
  const wa = createMetaWhatsapp({
    env: {
      META_WA_ACCESS_TOKEN: 'test-token',
      META_WA_PHONE_NUMBER_ID: 'phone-id',
      META_WA_TEMPLATE_NAME: 'sentry_camera_offline'
    },
    db,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    }
  });

  const result = await wa.sendWithOptions(
    '5511999999999',
    'Offline:\n• Camera 1\n• Camera 2',
    undefined,
    undefined,
    { tenantId: 'tenant-a', instanceId: 'branch-1', cameraIds: ['CAM-1', 'CAM-2'] }
  );

  assert.equal(result.deliveryStatus, 'pendente');
  assert.equal(result.id, 'wamid.1');
  assert.equal(request.url, 'https://graph.facebook.com/v27.0/phone-id/messages');
  const body = JSON.parse(request.options.body);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'sentry_camera_offline');
  assert.deepEqual(body.template.components[0].parameters, [{ type: 'text', text: 'Camera 1, Camera 2' }]);
  assert.deepEqual(recorded.delivery.cameraIds, ['CAM-1', 'CAM-2']);
  assert.equal(recorded.delivery.tenantId, 'tenant-a');
  assert.equal(recorded.delivery.instanceId, 'branch-1');
  assert.equal(recorded.conversation[4], 'tenant-a');
});

test('Meta Cloud API surfaces API errors and requires an approved bot template', async () => {
  const configured = createMetaWhatsapp({
    env: { META_WA_ACCESS_TOKEN: 'test-token', META_WA_PHONE_NUMBER_ID: 'phone-id' },
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Template rejected', code: 132000 } })
    })
  });
  await assert.rejects(
    configured.sendWithOptions('5511999999999', 'Offline:\n• Camera 1'),
    /META_WA_TEMPLATE_NAME/
  );

  const withTemplate = createMetaWhatsapp({
    env: {
      META_WA_ACCESS_TOKEN: 'test-token',
      META_WA_PHONE_NUMBER_ID: 'phone-id',
      META_WA_TEMPLATE_NAME: 'sentry_camera_offline'
    },
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Template rejected', code: 132000 } })
    })
  });
  await assert.rejects(
    withTemplate.sendWithOptions('5511999999999', 'Offline:\n• Camera 1'),
    /Template rejected \(código 132000\)/
  );
});

test('Meta webhook validates handshake and HMAC, then processes delivery and replies', async t => {
  const delivery = {
    id: 'wamid.delivery',
    tenantId: 'tenant-a',
    instanceId: 'branch-1',
    cameraIds: ['CAM-1'],
    status: 'pendente',
    createdAt: new Date().toISOString()
  };
  let updatedCamera;
  let inbound;
  const db = {
    async findDeliveryByExternalId(id) { return id === delivery.id ? { ...delivery, cameraIds: [...delivery.cameraIds] } : null; },
    async getDeliveries(ids, tenantId) {
      return tenantId === delivery.tenantId && ids.includes(delivery.id)
        ? [{ ...delivery, cameraIds: [...delivery.cameraIds] }]
        : [];
    },
    async updateDeliveryStatus(id, status) { delivery.status = status; },
    async getCameras(tenantId) {
      assert.equal(tenantId, delivery.tenantId);
      return [{ id: 'CAM-1', status: 'Pendente', tentativas: 0 }];
    },
    async updateCamera(id, patch) { updatedCamera = { id, ...patch }; },
    async addLog() {},
    async upsertConversation() {},
    async addMessage() { return true; },
    async incrementUnread() {}
  };
  const app = express();
  app.io = { emit() {} };
  registerMetaWebhook(app, {
    db,
    bots: { async onIncomingMessage(...args) { inbound = args; } },
    secret: 'app-secret',
    verifyToken: 'verify-secret',
    phoneNumberId: 'phone-id',
    tenantId: 'tenant-a',
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/whatsapp/meta/webhook`;

  const challenge = await fetch(`${baseUrl}?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=12345`);
  assert.equal(challenge.status, 200);
  assert.equal(await challenge.text(), '12345');

  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'phone-id' },
          statuses: [{ id: delivery.id, status: 'delivered', recipient_id: '5511999999999' }],
          messages: [{
            id: 'wamid.inbound',
            from: '5511999999999',
            type: 'text',
            text: { body: '1' },
            timestamp: '1760000000'
          }]
        }
      }]
    }]
  });
  const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  const invalid = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=invalid' },
    body
  });
  assert.equal(invalid.status, 401);

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body
  });
  assert.equal(response.status, 200);
  assert.equal(delivery.status, 'entregue');
  assert.equal(updatedCamera.status, 'Aguardando resposta');
  assert.equal(updatedCamera.tentativas, 1);
  assert.equal(inbound[0], '5511999999999@s.whatsapp.net');
  assert.equal(inbound[1], '1');
  assert.equal(inbound[2].tenantId, 'tenant-a');
});
