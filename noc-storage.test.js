const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./server');
const { saveNocFile, getLatestNocFile, listNocFiles } = require('./lib/noc-storage');

const CSV = [
  'ID;Nome;Município;Status;Tempo offline;SLA total',
  '7001;CAM 7001;Cuiabá;Offline;2 h;87%',
  '7002;CAM 7002;Sinop;Online;-;100%'
].join('\r\n');

function createDb() {
  return {
    async getCameras() { return []; },
    async getLog() { return []; }
  };
}

function createWa() {
  return {
    setIO() {},
    async getStatus() { return { status: 'disconnected' }; }
  };
}

async function startServer(t) {
  const app = createApp({ db: createDb(), wa: createWa(), bots: {}, apiKey: '' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('noc-storage persiste o CSV canônico e devolve o payload reconstruído', async () => {
  const db = createDb();
  const saved = await saveNocFile({ db, tenantId: 'default', filename: 'leitura.csv', csvText: CSV });
  assert.equal(saved.registro.nome, 'leitura.csv');
  assert.equal(saved.registro.linhas, 2);
  assert.equal(saved.payload.data.length, 2);
  assert.match(saved.registro.conteudo, /CAM 7001/);

  const latest = await getLatestNocFile(db, 'default');
  assert.equal(latest.id, saved.registro.id);
  assert.equal(latest.payload.data.length, 2);

  const list = await listNocFiles(db, 'default');
  assert.equal(list.length, 1);
  assert.equal(list[0].conteudo, undefined, 'a listagem não devolve o CSV inteiro');
});

test('rotas de armazenamento do Painel NOC gravam, listam e restauram o último arquivo', async t => {
  const baseUrl = await startServer(t);

  const saved = await postJson(baseUrl, '/api/noc/arquivos', {
    csv: CSV,
    nomeArquivo: 'noc-importado.csv'
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.payload.data.length, 2);
  assert.equal(saved.body.registro.nome, 'noc-importado.csv');

  const latest = await (await fetch(baseUrl + '/api/noc/arquivos/ultimo')).json();
  assert.equal(latest.ok, true);
  assert.equal(latest.registro.id, saved.body.registro.id);
  assert.equal(latest.payload.data[0].nome, 'CAM 7001');

  const list = await (await fetch(baseUrl + '/api/noc/arquivos')).json();
  assert.equal(list.arquivos.length, 1);
  assert.equal(list.arquivos[0].conteudo, undefined);

  const invalid = await postJson(baseUrl, '/api/noc/arquivos', { csv: '' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.codigo, 'NOC_FILE_ERROR');
});
