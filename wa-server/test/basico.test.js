import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSendNumber, maskNumber, PhoneUtils } from '../src/phone.js';
import { chaveValida } from '../src/routes.js';
import { assinar } from '../src/webhook.js';
import { createSendQueue } from '../src/queue.js';

const logger = { info() {}, warn() {}, error() {} };

test('normalização de envio usa 55 + DDD + 9º dígito quando necessário', () => {
  const legado = normalizeSendNumber('1199990000');
  assert.equal(legado, '5511999990000');
  const completo = normalizeSendNumber('65999998888');
  assert.equal(completo, `55${PhoneUtils.normalizarTelefone('65999998888').nacional}`);
  const comMascara = normalizeSendNumber('(65) 99999-8888');
  assert.equal(comMascara, completo);
  assert.equal(normalizeSendNumber('123'), null);
});

test('destino é mascarado nos logs', () => {
  assert.equal(maskNumber('5565999988888'), '+55 65 **** 8888');
});

test('comparação de chave é constante e aceita apenas a chave correta', () => {
  assert.equal(chaveValida('chave-longa', 'chave-longa'), true);
  assert.equal(chaveValida('chave-curta', 'chave-longa'), false);
  assert.equal(chaveValida('', 'chave-longa'), false);
});

test('assinatura do webhook é HMAC SHA-256 determinístico', () => {
  const primeira = assinar('{"tipo":"status"}', 'segredo');
  assert.match(primeira, /^sha256=[a-f0-9]{64}$/);
  assert.equal(primeira, assinar('{"tipo":"status"}', 'segredo'));
  assert.notEqual(primeira, assinar('{"tipo":"status"}', 'outro'));
});

test('fila envia em ordem e resolve todas as promessas', async () => {
  const enviados = [];
  const queue = createSendQueue({
    logger,
    minDelayMs: 0,
    maxDelayMs: 0,
    maxPerMinute: 50,
    worker: async job => { enviados.push(job.id); return { ok: true, id: job.id }; }
  });
  const resultados = await Promise.all(
    ['a', 'b', 'c'].map(id => queue.enqueue({ id, jid: `${id}@s.whatsapp.net`, destinoMascarado: '***' }).promise)
  );
  assert.deepEqual(enviados, ['a', 'b', 'c']);
  assert.deepEqual(resultados.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(queue.pending(), 0);
});
