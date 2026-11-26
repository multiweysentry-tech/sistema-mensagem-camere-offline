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
  assert.equal(result.modoEnvio, 'texto');
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
  assert.equal(withOptions.modoEnvio, 'template');
  const templateRequest = requests[2];
  assert.equal(templateRequest.url, `${DATAFY_API_BASE}/v1/phone-id-from-datafy/messages`);
  assert.equal(JSON.parse(templateRequest.options.body).type, 'template');
  assert.equal(JSON.parse(templateRequest.options.body).template.name, 'sentry_camera_offline');
});

test('Datafy uses interactive buttons when the configured template is not approved', async () => {
  const requests = [];
  const recorded = {};
  const db = {
    async registerDelivery(entry, tenantId) { recorded.delivery = { ...entry, tenantId }; },
    async upsertConversation() {},
    async addMessage() {}
  };
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline_v2'
    },
    db,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({ phone_number_id: 'phone-id-from-datafy' }), { status: 200 });
      }
      const payload = JSON.parse(options.body);
      if (payload.type === 'template') {
        return new Response(JSON.stringify({
          error: { message: '(#132001) Template name does not exist in the translation', code: 132001 }
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.interativo.1' }] }), { status: 200 });
    }
  });

  const result = await wa.sendWithOptions(
    '5511999999999',
    'Offline:\n• CAM-1',
    undefined,
    'Escolha uma opção. PARAR encerra as mensagens.',
    { tenantId: 'tenant-a', cameraIds: ['CAM-1'] }
  );

  assert.equal(result.id, 'wamid.interativo.1');
  assert.equal(result.deliveryStatus, 'pendente');
  assert.equal(result.modoEnvio, 'interativo');
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[1].options.body).type, 'template');
  assert.equal(requests[2].url, `${DATAFY_API_BASE}/v1/phone-id-from-datafy/messages`);

  const payload = JSON.parse(requests[2].options.body);
  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'button');
  assert.equal(payload.interactive.body.text, 'Offline:\n• CAM-1');
  assert.equal(payload.interactive.footer.text, 'Escolha uma opção. PARAR encerra as mensagens.');
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: 'reply', reply: { id: '1', title: 'Estou verificando' } },
    { type: 'reply', reply: { id: '2', title: 'Preciso de suporte' } },
    { type: 'reply', reply: { id: '3', title: 'Já resolvi' } }
  ]);
  assert.equal(recorded.delivery.id, 'wamid.interativo.1');
  assert.deepEqual(recorded.delivery.cameraIds, ['CAM-1']);
  assert.equal(recorded.delivery.tenantId, 'tenant-a');
});

test('Datafy falls back when 132001 is returned as a top-level statusCode', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline_v2'
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({ phone_number_id: 'phone-id-from-datafy' }), { status: 200 });
      }
      const payload = JSON.parse(options.body);
      if (payload.type === 'template') {
        return new Response(JSON.stringify({ statusCode: 132001, message: 'Template não aprovado' }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.interativo.statuscode' }] }), { status: 200 });
    }
  });

  const result = await wa.sendWithOptions('5511999999999', 'Offline:\n• CAM-1');
  assert.equal(result.id, 'wamid.interativo.statuscode');
  assert.equal(result.modoEnvio, 'interativo');
  assert.equal(JSON.parse(requests[2].options.body).type, 'interactive');
});

test('Datafy does not fall back to interactive buttons for unrelated template errors', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline_v2'
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({ phone_number_id: 'phone-id-from-datafy' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { message: 'Template rejected', code: 132000 }
      }), { status: 400 });
    }
  });

  await assert.rejects(
    wa.sendWithOptions('5511999999999', 'Offline:\n• CAM-1'),
    /Template rejected \(código 132000\)/
  );
  assert.equal(requests.length, 2);
});

test('Datafy surfaces interactive fallback errors such as a closed 24h window', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline_v2'
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({ phone_number_id: 'phone-id-from-datafy' }), { status: 200 });
      }
      const payload = JSON.parse(options.body);
      if (payload.type === 'template') {
        return new Response(JSON.stringify({
          error: { message: '(#132001) Template name does not exist in the translation', code: 132001 }
        }), { status: 400 });
      }
      return new Response(JSON.stringify({
        error: { message: '(#131047) Re-engagement message', code: 131047 }
      }), { status: 400 });
    }
  });

  await assert.rejects(
    wa.sendWithOptions('5511999999999', 'Offline:\n• CAM-1'),
    /Re-engagement message/
  );
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[2].options.body).type, 'interactive');
});

test('Datafy describeAccount validates the linked phone id without sending messages', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_PHONE_NUMBER_ID: '1452138451316674'
    },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || 'GET' });
      return new Response(JSON.stringify({
        cliente_id: 'cli_123',
        phone_number_id: '999999999999999',
        waba_id: '1400357781909099',
        business_id: '345678901234567'
      }), { status: 200 });
    }
  });

  const account = await wa.describeAccount();
  assert.equal(account.phoneNumberId, '999999999999999');
  assert.equal(account.wabaId, '1400357781909099');
  assert.equal(account.configuredPhoneId, '1452138451316674');
  assert.equal(account.phoneIdMatches, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${DATAFY_API_BASE}/me`);
  assert.equal(requests[0].method, 'GET');
});

test('Datafy describeAccount surfaces upstream account errors', async () => {
  const wa = createDatafyWhatsapp({
    env: { DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token' },
    fetch: async () => new Response(JSON.stringify({ statusCode: 402, message: 'Assinatura inativa' }), { status: 402 })
  });

  await assert.rejects(wa.describeAccount(), error => {
    assert.equal(error.status, 402);
    assert.equal(error.datafyCode, 402);
    assert.match(error.message, /Assinatura inativa/);
    return true;
  });
});

test('Datafy listTemplates checks the configured template without sending it', async () => {
  const requests = [];
  const wa = createDatafyWhatsapp({
    env: {
      DATAFY_WA_ACCESS_TOKEN: 'test-datafy-token',
      DATAFY_WA_PHONE_NUMBER_ID: '1452138451316674',
      DATAFY_WA_TEMPLATE_NAME: 'sentry_camera_offline',
      DATAFY_WA_TEMPLATE_LANGUAGE: 'pt_BR'
    },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || 'GET' });
      if (url === `${DATAFY_API_BASE}/me`) {
        return new Response(JSON.stringify({
          phone_number_id: '1452138451314428',
          waba_id: '1400357781906126'
        }), { status: 200 });
      }
      if (url.includes('after=proxima-pagina')) {
        return new Response(JSON.stringify({
          data: [
            { name: 'sentry_camera_offline', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY' }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: [
          { name: 'sentry_camera_offline', language: 'en_US', status: 'APPROVED', category: 'UTILITY' },
          { name: 'outro_template', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING' }
        ],
        paging: { cursors: { after: 'proxima-pagina' } }
      }), { status: 200 });
    }
  });

  const result = await wa.listTemplates();
  assert.equal(result.configuredName, 'sentry_camera_offline');
  assert.equal(result.configuredLanguage, 'pt_BR');
  assert.equal(result.templates.length, 3);
  assert.equal(result.hasMore, false);
  assert.equal(requests.length, 3);
  assert.match(requests[1].url, /\/v1\/1400357781906126\/message_templates\?/);
  assert.match(requests[2].url, /after=proxima-pagina/);
  assert.equal(requests[2].method, 'GET');
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
