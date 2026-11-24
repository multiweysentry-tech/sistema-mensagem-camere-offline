const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const test = require('node:test');
const { createDatafyWhatsapp, DATAFY_API_BASE } = require('./datafy-whatsapp');
const { datafySignatureIsValid, registerMetaWebhook } = require('./meta-webhook');

test('Datafy resolves the phone number id and sends through its Cloud API mirror', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline'
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({ phone_number_id: 'phone-id-from-datafy' }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [{ id: `wamid.datafy.${requests.length}` }] }), { status: 200 });
    }
  });

  const status = await wa.getStatus();
  assert.equal(status.status, 'configured');
  assert.equal(status.provider, 'datafy');
  const result = await wa.sendMessage('5511999999999', 'Mensagem de teste', { tenantId: 'tenant-a' });
  assert.equal(result.deliveryStatus, 'pendente');
  assert.equal(result.id, 'wamid.datafy.2');
  assert.equal(requests[0].url, `${DATAFY_API_BASE}/me`);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-datafy-token');
  assert.equal(requests[1].url, `${DATAFY_API_BASE}/v1/phone-id-from-datafy/messages`);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-datafy-token');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '5511999999999',
    type: 'text',
    text: { body: 'Mensagem de teste' }
  });

  const withOptions = await wa.sendWithOptions(
    '5511999999999',
    'Câmera offline:\n• CAM-1',
    undefined,
    undefined,
    { tenantId: 'tenant-a', cameraIds: ['CAM-1'] }
  );
  assert.equal(withOptions.id, 'wamid.datafy.3');
  const templateRequest = requests[2];
  assert.equal(templateRequest.url, `${DATAFY_API_BASE}/v1/phone-id-from-datafy/messages`);
  assert.equal(JSON.parse(templateRequest.options.body).type, 'template');
  assert.equal(JSON.parse(templateRequest.options.body).template.name, 'sentry_camera_offline');
});

test('Datafy webhook signature requires the signed timestamp to be recent', () => {
  const secret = 'datafy-webhook-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"object":"whatsapp_business_account"}';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

  assert.equal(datafySignatureIsValid(body, signature, timestamp, secret), true);
  assert.equal(datafySignatureIsValid(body, signature, String(Number(timestamp) - 301), secret), false);
  assert.equal(datafySignatureIsValid(`${body} `, signature, timestamp, secret), false);
});

test('Datafy signed status webhook confirms an accepted WhatsApp delivery', async t => {
  const secret = 'datafy-webhook-secret';
  const delivery = {
    id: 'wamid.datafy',
    tenantId: 'default',
    instanceId: 'default',
    cameraIds: [],
    status: 'pendente',
    createdAt: new Date().toISOString()
  };
  const db = {
    async findDeliveryByExternalId(id) { return id === delivery.id ? { ...delivery } : null; },
    async getDeliveries(ids) { return ids.includes(delivery.id) ? [{ ...delivery }] : []; },
    async updateDeliveryStatus(id, status) { if (id === delivery.id) delivery.status = status; },
    async registerDelivery() {},
    async addLog() {}
  };
  const app = express();
  registerMetaWebhook(app, {
    db,
    secret,
    route: '/api/whatsapp/datafy/webhook',
    signatureValidator: (body, req) => datafySignatureIsValid(
      body,
      req.get('x-datafy-signature-256'),
      req.get('x-datafy-timestamp'),
      secret
    ),
    providerName: 'Datafy',
    enableHandshake: false,
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          statuses: [{ id: delivery.id, status: 'delivered', recipient_id: '5511999999999' }]
        }
      }]
    }]
  });
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/datafy/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-datafy-signature-256': signature,
      'x-datafy-timestamp': timestamp
    },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(delivery.status, 'entregue');
});
