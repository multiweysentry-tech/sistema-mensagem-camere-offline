const assert = require('node:assert/strict');
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

test('serverless reports interactive delivery accurately without plain-text fallback', async t => {
  const environmentKeys = [
    'VERCEL',
    'API_KEY',
    'DATABASE_URL',
    'POSTGRES_URL',
    'PG_HOST',
    'PG_PASSWORD',
    'META_WA_ACCESS_TOKEN',
    'META_WA_PHONE_NUMBER_ID',
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
  process.env.WHATSAPP_BRIDGE_URL = '';

  const handlerPath = require.resolve('./api/index');
  delete require.cache[handlerPath];
  const handler = require('./api/index');
  const requests = [];
  let rejectInteractive = true;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.type === 'interactive' && rejectInteractive) {
      return new Response(JSON.stringify({ error: { message: 'Interactive message rejected' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ messages: [{ id: 'meta-message-id' }] }), { status: 200 });
  };

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
  assert.equal(status.body.phone, null);

  const consent = await requestJson(port, '/api/consent', {
    phone: '5511999990003',
    opted_in: true
  });
  assert.equal(consent.status, 200);

  const result = await requestJson(port, '/api/whatsapp/send-options', {
    to: '5511999990003',
    text: 'Escolha uma opção',
    buttons: [
      { id: '1', text: 'Estou verificando' },
      { id: '2', text: 'Preciso de suporte' }
    ]
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.codigo, 'WHATSAPP_SEND_FAILED');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'interactive');

  rejectInteractive = false;
  const accepted = await requestJson(port, '/api/whatsapp/send-options', {
    to: '5511999990003',
    text: 'Escolha uma opção',
    buttons: [
      { id: '1', text: 'Estou verificando' },
      { id: '2', text: 'Preciso de suporte' }
    ]
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.deliveryStatus, 'sent');
  assert.equal(accepted.body.id, 'meta-message-id');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].type, 'interactive');
});
