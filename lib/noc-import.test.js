const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseNocCsv,
  syncNocCameras,
  mapNocStatus,
  mergeObservacoes
} = require('./noc-import');

test('NOC CSV accepts common headers and canonicalizes numeric IDs', () => {
  const parsed = parseNocCsv([
    'ID Camera;Câmera Nome;Municipio;Responsavel;Status',
    '123;CAM 123;Cuiabá;João Silva;Offline'
  ].join('\n'));

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, 'NOC-123');
  assert.equal(parsed.items[0].responsavel_nome, 'João Silva');
});

test('NOC reimport keeps workflow state and preserves existing responsible data', async () => {
  const cameras = [{
    id: 'NOC-123',
    camera_nome: 'CAM 123',
    local: 'Cuiabá',
    responsavel_nome: 'Responsável existente',
    responsavel_telefone: '65999999999',
    email: 'contato@example.com',
    status: 'Verificando',
    tentativas: 2,
    ultima_cobranca: '2026-11-23',
    data_resolucao: '',
    observacoes: '[NOC] Status antigo'
  }];
  const db = {
    async getCameras() { return cameras.map(c => ({ ...c })); },
    async updateCamera(id, next) {
      const i = cameras.findIndex(c => c.id === id);
      cameras[i] = { ...cameras[i], ...next };
    },
    async upsertCamera() {}
  };

  const csv = [
    'ID;Nome;Município;Responsável;Status',
    '123;CAM 123;Cuiabá;;Offline'
  ].join('\n');
  const summary = await syncNocCameras({ db, csvText: csv, tenantId: 'default' });

  assert.equal(summary.updated, 1);
  assert.equal(summary.workflowPreserved, 1);
  assert.equal(cameras[0].status, 'Verificando');
  assert.equal(cameras[0].responsavel_nome, 'Responsável existente');
  assert.equal(cameras[0].responsavel_telefone, '65999999999');
});

test('NOC observations remain stable across reimports', () => {
  const existing = '[NOC] Último status NOC: 22/11/2026 15:11:17\nObservação manual';
  const noc = '[NOC] Último status NOC: 23/11/2026 15:11:17';

  assert.equal(mergeObservacoes(existing, noc), 'Observação manual\n' + noc);
});

test('NOC online aliases resolve the camera and unknown offline status stays pending', () => {
  assert.equal(mapNocStatus('Online', 'Pendente').status, 'Resolvido');
  assert.equal(mapNocStatus('ATIVO', 'Verificando').status, 'Resolvido');
  assert.equal(mapNocStatus('Desconhecido', null).status, 'Pendente');
});
