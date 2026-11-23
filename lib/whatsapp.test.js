const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const {
  isRemoteConfigured,
  createRemoteWhatsapp,
  mapStatus
} = require('./whatsapp');

test('configuração remota exige URL e chave', () => {
  assert.equal(isRemoteConfigured({ WA_SERVER_URL: 'https://wa.example', WA_API_KEY: 'chave' }), true);
  assert.equal(isRemoteConfigured({ WA_SERVER_URL: 'https://wa.example' }), false);
  assert.equal(isRemoteConfigured({ WA_SERVER_URL: 'ftp://wa.example', WA_API_KEY: 'chave' }), false);
  assert.throws(() => createRemoteWhatsapp({ url: 'https://wa.example' }), /WA_API_KEY/);
});

test('mapeia status do servidor para o estado usado pela UI', () => {
  assert.equal(mapStatus('conectado'), 'open');
  assert.equal(mapStatus('aguardando_qr'), 'qr');
  assert.equal(mapStatus('desconectado'), 'disconnected');
});

test('cliente envia x-api-key e marca envio como pendente até o webhook', async t => {
  const chamadas = [];
  const server = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', parte => { corpo += parte; });
    req.on('end', () => {
      chamadas.push({ url: req.url, metodo: req.method, chave: req.headers['x-api-key'], corpo });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/status') return res.end(JSON.stringify({ status: 'conectado' }));
      if (req.url === '/verificar') {
        return res.end(JSON.stringify({ ok: true, existe: true, numero: '5565999998888', jid: '5565999998888@s.whatsapp.net' }));
      }
      return res.end(JSON.stringify({
        ok: true,
        id: 'sentry_123',
        queueId: 'fila_456',
        numero: '5565999998888',
        jid: '5565999998888@s.whatsapp.net'
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const cliente = createRemoteWhatsapp({ url, apiKey: 'chave-teste' });

  const saude = await cliente.getHealth();
  assert.equal(saude.status, 'conectado');
  const status = await cliente.getStatus();
  assert.equal(status.status, 'open');
  const verificado = await cliente.checkNumber('65999998888');
  assert.equal(verificado.exists, true);
  const enviado = await cliente.sendWithOptions('65999998888', 'Olá', [{ id: '1', text: 'Sim' }, { id: '2', text: 'Não' }], 'rodape', {
    tenantId: 'default',
    cameraIds: ['CAM-1']
  });

  assert.equal(enviado.deliveryStatus, 'pendente');
  assert.equal(enviado.id, 'sentry_123');
  assert.equal(enviado.queueId, 'fila_456');
  assert.equal(enviado.remote, true);
  assert.ok(chamadas.every(item => item.chave === 'chave-teste'));
  const envio = chamadas.find(item => item.url === '/enviar');
  const corpo = JSON.parse(envio.corpo);
  assert.equal(corpo.numero, '5565999998888');
  assert.equal(corpo.metadata.cameraIds[0], 'CAM-1');
  assert.equal(corpo.opcoes[0].id, '1');
});
