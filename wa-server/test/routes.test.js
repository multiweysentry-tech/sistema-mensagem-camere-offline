import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createRoutes } from '../src/routes.js';

const logger = { info() {}, warn() {}, error() {} };

function servicoDeTeste() {
  const estado = { status: 'desconectado', qr: null, enfileirados: [], rastreados: [] };
  const connection = {
    getStatus: () => estado.status,
    getInfo: () => ({ status: estado.status, phone: null, qrDisponivel: Boolean(estado.qr) }),
    getQR: () => estado.qr,
    findOnWhatsApp: async numero => `${numero}@s.whatsapp.net`,
    track: (id, metadata, jid) => estado.rastreados.push({ id, metadata, jid })
  };
  const queue = {
    pending: () => estado.enfileirados.length,
    get processando() { return false; },
    enqueue: job => {
      estado.enfileirados.push(job);
      return { queueId: `fila_${estado.enfileirados.length}`, promise: Promise.resolve({ ok: true }) };
    }
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/', createRoutes({
    config: { apiKey: 'chave-teste' },
    logger,
    connection,
    queue,
    enviarWebhook: async () => true
  }));
  return { app, estado };
}

async function comServidor(t, app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  return callback(`http://127.0.0.1:${server.address().port}`);
}

test('rotas exigem x-api-key e devolvem erro JSON consistente', async t => {
  const { app } = servicoDeTeste();
  await comServidor(t, app, async url => {
    const resposta = await fetch(`${url}/status`);
    assert.equal(resposta.status, 401);
    assert.deepEqual(await resposta.json(), { erro: 'Não autorizado' });

    const chaveErrada = await fetch(`${url}/status`, { headers: { 'x-api-key': 'errada' } });
    assert.equal(chaveErrada.status, 401);
  });
});

test('status e QR sao protegidos e refletem o estado da sessao', async t => {
  const { app, estado } = servicoDeTeste();
  await comServidor(t, app, async url => {
    const headers = { 'x-api-key': 'chave-teste' };
    let resposta = await fetch(`${url}/status`, { headers });
    assert.deepEqual(await resposta.json(), { status: 'desconectado' });

    resposta = await fetch(`${url}/qr?json=1`, { headers });
    assert.deepEqual(await resposta.json(), { status: 'desconectado', qr: null });

    estado.qr = 'data:image/png;base64,abc';
    resposta = await fetch(`${url}/qr?json=1`, { headers });
    assert.equal((await resposta.json()).qr, estado.qr);
  });
});

test('enviar recusa sessao desconectada e enfileira quando conectado', async t => {
  const { app, estado } = servicoDeTeste();
  await comServidor(t, app, async url => {
    const headers = { 'x-api-key': 'chave-teste', 'Content-Type': 'application/json' };
    const corpo = JSON.stringify({
      numero: '1199990000',
      texto: 'Olá',
      opcoes: [{ id: '1', text: 'Sim' }, { id: '2', text: 'Não' }],
      rodape: 'Escolha uma opção',
      metadata: { tenantId: 'tenant-a', cameraIds: ['CAM-1'] }
    });

    let resposta = await fetch(`${url}/enviar`, { method: 'POST', headers, body: corpo });
    assert.equal(resposta.status, 503);
    assert.equal((await resposta.json()).codigo, 'WA_DESCONECTADO');

    estado.status = 'conectado';
    resposta = await fetch(`${url}/enviar`, { method: 'POST', headers, body: corpo });
    assert.equal(resposta.status, 202);
    const resultado = await resposta.json();
    assert.equal(resultado.ok, true);
    assert.equal(resultado.status, 'pendente');
    assert.match(resultado.id, /^sentry_/);
    assert.equal(resultado.numero, '5511999990000');
    assert.equal(resultado.jid, '5511999990000@s.whatsapp.net');
    assert.equal(estado.enfileirados.length, 1);
    assert.equal(estado.enfileirados[0].opcoes.length, 2);
    assert.equal(estado.enfileirados[0].metadata.cameraIds[0], 'CAM-1');
    assert.equal(estado.rastreados[0].id, resultado.id);

    resposta = await fetch(`${url}/verificar`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ numero: '65999998888' })
    });
    assert.equal(resposta.status, 200);
    assert.equal((await resposta.json()).existe, true);
  });
});
