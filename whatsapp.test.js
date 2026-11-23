const test = require('node:test');
const assert = require('node:assert/strict');
const {
  waitForDeliveryAck,
  handleDeliveryStatus,
  shouldProcessStatusUpdate,
  statusFromReceiptNode,
  interactiveRelayNodes
} = require('./whatsapp');

test('ACK de entrega com fromMe=false é processado', () => {
  const key = { id: '3EB0ACK', remoteJid: '5548999990001@s.whatsapp.net', fromMe: false };
  assert.equal(shouldProcessStatusUpdate(key, { status: 3 }), true);
  assert.equal(shouldProcessStatusUpdate(key, { status: 4 }), true);
  assert.equal(shouldProcessStatusUpdate({ ...key, fromMe: true }, { status: 3 }), true);
  assert.equal(shouldProcessStatusUpdate(key, {}), false);
  assert.equal(shouldProcessStatusUpdate({ ...key, id: undefined }, { status: 3 }), false);
});

test('waitForDeliveryAck resolve no ACK de entrega e rejeita erro', async () => {
  const delivered = waitForDeliveryAck('teste-entrega', 2000);
  handleDeliveryStatus('teste-entrega', 3);
  assert.equal(await delivered.promise, 3);

  const failed = waitForDeliveryAck('teste-erro', 2000);
  handleDeliveryStatus('teste-erro', 0);
  await assert.rejects(failed.promise, /rejeitou a mensagem/);
});

test('waitForDeliveryAck expira quando o aparelho nao confirma', async () => {
  const pending = waitForDeliveryAck('teste-sem-ack', 40);
  await assert.rejects(pending.promise, error => error.code === 'DELIVERY_UNCONFIRMED');
});

test('receipt bruto sem type e mapeado como entrega', () => {
  assert.equal(statusFromReceiptNode({ attrs: { id: 'x', from: '55...@s.whatsapp.net' } }), 3);
  assert.equal(statusFromReceiptNode({ attrs: { id: 'x', type: 'sender' } }), 2);
  assert.equal(statusFromReceiptNode({ attrs: { id: 'x', type: 'read' } }), 4);
  assert.equal(statusFromReceiptNode({ attrs: { id: 'x', error: '475' } }), 0);
  assert.equal(statusFromReceiptNode({ attrs: { id: 'x', type: 'desconhecido' } }), null);
});

test('no biz preserva botoes sem marcar mensagem como bot', () => {
  const nodes = interactiveRelayNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tag, 'biz');
  assert.equal(nodes.some(node => node.tag === 'bot'), false);
  const interactive = nodes[0].content.find(node => node.tag === 'interactive');
  assert.equal(interactive?.attrs?.type, 'native_flow');
  assert.equal(interactive?.content?.[0]?.tag, 'native_flow');
});
