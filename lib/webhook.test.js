const assert = require('node:assert/strict');
const express = require('express');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { registerWebhook, assinaturaValida } = require('./webhook');

const segredo = 'segredo-de-teste';
const assinar = corpo => `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;
const logger = { info() {}, warn() {}, error() {} };

test('validação HMAC rejeita corpo alterado e assinatura ausente', () => {
  const corpo = Buffer.from('{"tipo":"status"}');
  const assinatura = assinar(corpo);
  assert.equal(assinaturaValida(corpo, assinatura, segredo), true);
  assert.equal(assinaturaValida(Buffer.from('{"tipo":"erro"}'), assinatura, segredo), false);
  assert.equal(assinaturaValida(corpo, '', segredo), false);
  assert.equal(assinaturaValida(corpo, assinatura, ''), false);
});

test('webhook confirmado atualiza status e só então promove a câmera', async t => {
  const camera = { id: 'CAM-1', status: 'offline', tentativas: 0 };
  const entrega = { id: 'sentry_1', status: 'pendente', cameraIds: ['CAM-1'] };
  const atualizacoes = [];
  const logs = [];
  const db = {
    async getDeliveries() { return [{ ...entrega }]; },
    async registerDelivery() {},
    async updateDeliveryStatus(id, status, motivo) {
      entrega.status = status;
      entrega.motivo = motivo;
      atualizacoes.push(status);
    },
    async getCameras() { return [camera]; },
    async updateCamera(id, campos) { Object.assign(camera, campos); },
    async addLog(entry) { logs.push(entry); }
  };
  const app = express();
  registerWebhook(app, { db, secret: segredo, logger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`;

  const corpo = JSON.stringify({
    tipo: 'status',
    id: 'sentry_1',
    status: 'entregue',
    timestamp: new Date().toISOString(),
    metadata: { tenantId: 'default', cameraIds: ['CAM-1'] }
  });
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': assinar(corpo) },
    body: corpo
  });
  assert.equal(resposta.status, 200);
  assert.deepEqual(atualizacoes, ['entregue']);
  assert.equal(camera.status, 'Aguardando resposta');
  assert.equal(camera.tentativas, 1);
  assert.ok(logs.some(entry => entry.acao === 'ENTREGA_CONFIRMADA'));

  const recusada = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'sha256=' + '0'.repeat(64) },
    body: corpo
  });
  assert.equal(recusada.status, 401);
  assert.deepEqual(await recusada.json(), { erro: 'Assinatura inválida' });
});
