const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');

function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function requestRaw(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('Vercel Meta provider uses approved templates and reports pending delivery', async t => {
  const environmentKeys = [
    'VERCEL',
    'API_KEY',
    'DATABASE_URL',
    'POSTGRES_URL',
    'PG_HOST',
    'PG_PASSWORD',
    'META_WA_ACCESS_TOKEN',
    'META_WA_PHONE_NUMBER_ID',
    'META_WA_APP_SECRET',
    'META_WA_VERIFY_TOKEN',
    'META_WA_TEMPLATE_NAME',
    'META_WA_TIMEOUT_MS',
    'WHATSAPP_PROVIDER',
    'WHATSAPP_BRIDGE_URL'
  ];
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const previousFetch = global.fetch;
  process.env.VERCEL = '1';
  process.env.API_KEY = '';
  process.env.DATABASE_URL = '';
  process.env.POSTGRES_URL = '';
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PASSWORD = '';
  process.env.META_WA_ACCESS_TOKEN = 'test-token';
  process.env.META_WA_PHONE_NUMBER_ID = 'test-phone-id';
  process.env.META_WA_APP_SECRET = 'test-app-secret';
  process.env.META_WA_VERIFY_TOKEN = 'test-verify-token';
  process.env.META_WA_TEMPLATE_NAME = 'sentry_camera_offline';
  process.env.META_WA_TIMEOUT_MS = '';
  process.env.WHATSAPP_PROVIDER = 'meta';
  process.env.WHATSAPP_BRIDGE_URL = '';

  const handlerPath = require.resolve('./api/index');
  delete require.cache[handlerPath];
  const requests = [];
  let rejectTemplate = true;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.type === 'template' && rejectTemplate) {
      return new Response(JSON.stringify({ error: { message: 'Template rejected' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ messages: [{ id: 'meta-message-id' }] }), { status: 200 });
  };
  const handler = require('./api/index');

  const server = http.createServer((request, response) => handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    global.fetch = previousFetch;
    await new Promise(resolve => server.close(resolve));
    delete require.cache[handlerPath];
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const port = server.address().port;
  const status = await requestJson(port, '/api/whatsapp/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'configured');
  assert.equal(status.body.provider, 'meta');
  assert.equal(status.body.phone, null);

  const consent = await requestJson(port, '/api/consent', {
    phone: '5511999990003',
    opted_in: true
  });
  assert.equal(consent.status, 200);

  const result = await requestJson(port, '/api/whatsapp/send-options', {
    to: '5511999990003',
    text: 'Câmera offline:\n• CAM-1',
    buttons: [
      { id: '1', text: 'Estou verificando' },
      { id: '2', text: 'Preciso de suporte' },
      { id: '3', text: 'Já resolvi' }
    ]
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.codigo, 'WHATSAPP_SEND_FAILED');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'template');
  assert.equal(requests[0].template.name, 'sentry_camera_offline');

  rejectTemplate = false;
  const accepted = await requestJson(port, '/api/whatsapp/send-options', {
    to: '5511999990003',
    text: 'Câmera offline:\n• CAM-1',
    buttons: [
      { id: '1', text: 'Estou verificando' },
      { id: '2', text: 'Preciso de suporte' },
      { id: '3', text: 'Já resolvi' }
    ]
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.deliveryStatus, 'pendente');
  assert.equal(accepted.body.id, 'meta-message-id');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].type, 'template');

  const callbackPath = '/api/whatsapp/meta/webhook';
  const challenge = await requestRaw(
    port,
    `${callbackPath}?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345`
  );
  assert.equal(challenge.status, 200);
  assert.equal(challenge.text, '12345');

  const event = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'test-phone-id' },
          statuses: [{ id: accepted.body.id, status: 'delivered', recipient_id: '5511999990003' }]
        }
      }]
    }]
  });
  const signature = `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(event).digest('hex')}`;
  const callback = await requestRaw(port, callbackPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body: event
  });
  assert.equal(callback.status, 200);
  assert.equal(JSON.parse(callback.text).ok, true);
  const deliveries = await requestJson(port, '/api/whatsapp/delivery');
  assert.equal(deliveries.body.entregas[0].status, 'entregue');
});
