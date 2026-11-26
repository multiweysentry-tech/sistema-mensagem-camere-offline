const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseNocCsv,
  syncNocCameras,
  mapNocStatus,
  mergeObservacoes,
  buildNocAssignments,
  applyNocAssignments,
  applyNocGroups,
  serializeNocItemsToCsv,
  runNocDraftBot
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

test('NOC CSV with stray quotes keeps rows separate and names bounded', () => {
  const csv = [
    'ID;Nome;Município;Responsável;Status',
    '"1774";"NOVA XAVANTINA - CAM 39 - ZERO "CASA MORTUÁRIA” Carazinho com Br 158";"NOVA XAVANTINA - MT";"Adeildo";"Online"',
    '"1775";"NOVA XAVANTINA - CAM 40 - Carazinho com Br 158";"NOVA XAVANTINA - MT";"Adeildo";"Offline"'
  ].join('\r\n');

  const parsed = parseNocCsv(csv);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.items.length, 2);
  const primeiro = parsed.items.find(item => item.id === 'NOC-1774');
  assert.ok(primeiro, 'linha 1774 não pode desaparecer');
  assert.ok(primeiro.camera_nome.length < 200, 'nome não pode virar um blob gigante');
  assert.ok(primeiro.camera_nome.includes('CASA MORTUÁRIA'));
  assert.ok(parsed.items.some(item => item.id === 'NOC-1775'), 'linha 1775 não pode ser engolida');
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

test('buildNocAssignments lists only offline cameras and keeps existing contacts', () => {
  const csv = [
    'ID;Nome;Município;Responsável;Status;Tempo offline',
    '123;CAM 123;Cuiabá;João;Offline;2 h',
    '124;CAM 124;Rondonópolis;Maria;Online;',
    '125;CAM 125;Sinop;;Offline;30 min'
  ].join('\n');
  const cameras = [{
    id: 'NOC-123',
    responsavel_nome: 'João',
    responsavel_telefone: '65999999999',
    local: 'Cuiabá'
  }];

  const result = buildNocAssignments({ csvText: csv, cameras });

  assert.equal(result.offline, 2);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.assignments[0].cameraId, 'NOC-123');
  assert.equal(result.assignments[0].responsavel_telefone, '65999999999');
  assert.equal(result.assignments[0].action, 'revisar');
  assert.equal(result.assignments[1].cameraId, 'NOC-125');
  assert.equal(result.assignments[1].responsavel_nome, 'Sem responsável informado');
  assert.equal(result.assignments[1].action, 'novo');
  assert.equal(result.semTelefone, 1);
});

test('bot NOC preserves a manually typed draft name when reimported', async () => {
  const cameras = [{
    id: 'NOC-123', camera_nome: 'CAM 123', local: 'Cuiabá', responsavel_nome: 'Responsável digitado',
    responsavel_telefone: '', status: 'Pendente'
  }];
  const db = {
    async getCameras() { return cameras.map(c => ({ ...c })); },
    async updateCamera(id, next) { Object.assign(cameras.find(c => c.id === id), next); },
    async upsertCamera() {}
  };
  const csv = ['ID;Nome;Município;Responsável;Status', '123;CAM 123;Cuiabá;Nome do NOC;Offline'].join('\n');

  await runNocDraftBot({ db, options: { csv } });

  assert.equal(cameras[0].responsavel_nome, 'Responsável digitado');
  assert.equal(cameras[0].responsavel_telefone, '');
});

test('applyNocAssignments saves contacts progressively, validates phone and logs destination', async () => {
  const cameras = [
    { id: 'NOC-123', camera_nome: 'CAM 123', responsavel_nome: '', responsavel_telefone: '', local: '', status: 'Pendente' },
    { id: 'NOC-124', camera_nome: 'CAM 124', responsavel_nome: '', responsavel_telefone: '', local: '', status: 'Pendente' }
  ];
  const logs = [];
  const db = {
    async getCameras() { return cameras.map(c => ({ ...c })); },
    async updateCamera(id, fields) {
      const camera = cameras.find(c => c.id === id);
      Object.assign(camera, fields);
    },
    async addLog(entry) { logs.push(entry); }
  };

  const dry = await applyNocAssignments({
    db,
    dryRun: true,
    assignments: [{ cameraId: 'NOC-123', responsavel_nome: 'João', responsavel_telefone: '(65) 99999-9999', local: 'Cuiabá' }]
  });
  assert.equal(dry.applied, 1);
  assert.equal(cameras[0].responsavel_telefone, '');

  const invalid = await applyNocAssignments({
    db,
    assignments: [{ cameraId: 'NOC-124', responsavel_nome: 'Maria', responsavel_telefone: '123' }]
  });
  assert.equal(invalid.applied, 0);
  assert.equal(invalid.skipped, 1);
  assert.equal(cameras[1].responsavel_telefone, '');

  const applied = await applyNocAssignments({
    db,
    assignments: [
      { cameraId: 'NOC-123', responsavel_nome: 'João', responsavel_telefone: '(65) 99999-9999', local: 'Cuiabá' },
      { cameraId: 'NOC-124', responsavel_nome: 'Maria' }
    ]
  });
  assert.equal(applied.applied, 2);
  assert.equal(cameras[0].responsavel_telefone, '5565999999999');
  assert.equal(cameras[1].responsavel_nome, 'Maria');
  assert.equal(cameras[1].responsavel_telefone, '');
  assert.equal(logs.filter(log => log.acao === 'DESTINACAO_NOC').length, 2);
});

test('runNocDraftBot accepts items from the Painel NOC and creates drafts without contacts', async () => {
  const cameras = [];
  const db = {
    async getCameras() { return cameras.map(c => ({ ...c })); },
    async upsertCamera(camera) {
      const current = cameras.find(c => c.id === camera.id);
      if (current) Object.assign(current, camera, { responsavel_telefone: current.responsavel_telefone || camera.responsavel_telefone });
      else cameras.push({ ...camera });
    },
    async updateCamera(id, fields) {
      const camera = cameras.find(c => c.id === id);
      Object.assign(camera, fields);
    },
    async addLog() {}
  };
  const csvFromItems = serializeNocItemsToCsv([{
    id: 'CAM-77', nome: 'Câmera 77', municipio: 'Cuiabá', responsaveis: ['João', 'Maria'],
    status: 'Offline', offlineStr: '3 h', desc24: 2
  }]);
  assert.match(csvFromItems, /João \| Maria/);

  const bot = await runNocDraftBot({
    db,
    options: {
      items: [{
        id: 'CAM-77', nome: 'Câmera 77', municipio: 'Cuiabá', responsaveis: ['João', 'Maria'],
        status: 'Offline', offlineStr: '3 h', desc24: 2
      }]
    }
  });

  assert.equal(bot.created, 1);
  assert.equal(bot.drafts, 1);
  assert.equal(bot.assignments[0].cameraId, 'NOC-CAM-77');
  assert.equal(cameras[0].responsavel_telefone, '');
  assert.equal(cameras[0].status, 'Pendente');
});

test('applyNocGroups vincula várias IDs a um responsável sem enviar WhatsApp', async () => {
  const cameras = [
    { id: 'NOC-123', status: 'Pendente', responsavel_nome: 'Antigo', responsavel_telefone: '' },
    { id: 'NOC-124', status: 'Pendente', responsavel_nome: 'Antigo', responsavel_telefone: '' },
    { id: 'NOC-125', status: 'Pendente', responsavel_nome: 'Maria', responsavel_telefone: '' },
    { id: 'NOC-126', status: 'Resolvido', responsavel_nome: 'Intocável', responsavel_telefone: '' }
  ];
  const lotes = [];
  const db = {
    async getCameras() { return cameras.map(camera => ({ ...camera })); },
    async updateCamerasBulk(ids, fields, tenantId) {
      lotes.push({ ids, fields, tenantId });
      for (const id of ids) {
        const camera = cameras.find(item => String(item.id) === String(id));
        Object.assign(camera, fields);
      }
    }
  };
  const groups = [
    { responsavel_nome: 'João', responsavel_telefone: '(65) 99999-8888', cameraIds: ['123', 'NOC-124'] },
    { responsavel_nome: 'Maria', responsavel_telefone: '123', cameraIds: ['125'] },
    { responsavel_nome: 'Encerrado', cameraIds: ['126'] },
    { responsavel_nome: 'Inexistente', cameraIds: ['999'] }
  ];

  const seco = await applyNocGroups({ db, tenantId: 'default', groups, dryRun: true });
  assert.equal(seco.aplicadas, 0);
  assert.equal(lotes.length, 0);
  assert.equal(cameras[0].responsavel_nome, 'Antigo');

  const resumo = await applyNocGroups({ db, tenantId: 'default', groups });
  assert.equal(resumo.grupos, 4);
  assert.equal(resumo.aplicadas, 2);
  assert.equal(resumo.ignoradas, 3);
  assert.equal(lotes.length, 1);
  assert.deepEqual(lotes[0].ids, ['NOC-123', 'NOC-124']);
  assert.equal(lotes[0].tenantId, 'default');
  assert.equal(cameras[0].responsavel_nome, 'João');
  assert.equal(cameras[0].responsavel_telefone, '5565999998888');
  assert.equal(cameras[1].responsavel_nome, 'João');
  assert.equal(cameras[2].responsavel_nome, 'Maria', 'telefone inválido não pode alterar o cadastro');
  assert.equal(cameras[2].responsavel_telefone, '');
  assert.equal(cameras[3].responsavel_nome, 'Intocável', 'câmera Resolvida não entra no grupo');
  assert.equal(JSON.stringify(resumo).toLowerCase().includes('whatsapp'), false);
});

test('runNocDraftBot aplica groups[] do Painel NOC depois de preparar os rascunhos', async () => {
  const cameras = [];
  const db = {
    async getCameras() { return cameras.map(camera => ({ ...camera })); },
    async upsertCamera(camera) {
      const atual = cameras.find(item => item.id === camera.id);
      if (atual) Object.assign(atual, camera, { responsavel_telefone: atual.responsavel_telefone || camera.responsavel_telefone });
      else cameras.push({ ...camera });
    },
    async updateCamera(id, fields) {
      Object.assign(cameras.find(camera => camera.id === id), fields);
    },
    async addLog() {}
  };
  const csv = [
    'ID;Nome;Município;Responsável;Status',
    '321;CAM 321;Cuiabá;Nome do NOC;Offline'
  ].join('\n');

  const resultado = await runNocDraftBot({
    db,
    options: {
      csv,
      groups: [{ responsavel_nome: 'Equipe NOC', responsavel_telefone: '(65) 98888-7777', cameraIds: ['321'] }]
    }
  });

  assert.equal(resultado.created, 1);
  assert.equal(resultado.grupos.aplicadas, 1);
  assert.equal(cameras[0].id, 'NOC-321');
  assert.equal(cameras[0].responsavel_nome, 'Equipe NOC');
  assert.equal(cameras[0].responsavel_telefone, '5565988887777');
});

test('sincronização NOC contabiliza duplicatas e não reabre câmera baixada', async () => {
  const cameras = [{
    id: 'NOC-1', camera_nome: 'CAM 1', local: 'Cuiabá', status: 'Resolvido',
    data_resolucao: '2026-11-25', observacoes: 'Baixa manual', responsavel_telefone: ''
  }];
  const db = {
    async getCameras() { return cameras.map(camera => ({ ...camera })); },
    async upsertCamerasBulk(linhas) {
      for (const linha of linhas) {
        const indice = cameras.findIndex(camera => String(camera.id) === String(linha.id));
        if (indice >= 0) cameras[indice] = { ...cameras[indice], ...linha };
        else cameras.push({ ...linha });
      }
    }
  };
  const linhaBaixada = '"1";"CAM 1";"Cuiabá";"";"";"Resolvido";"25/11/2026 10:00:00";"";"0";"100%";"100%";"2026-11-25";"Baixa manual"';
  const csv = [
    'ID;Nome;Município;Responsável;Marcadores;Status;Último status;Tempo offline;Desconexões 24h;SLA 24h;SLA total;Data resolução;Observação',
    linhaBaixada,
    linhaBaixada,
    '"2";"CAM 2";"Cuiabá";"";"";"Offline";"26/11/2026 10:00:00";"2 h";"0";"80%";"80%";"";""'
  ].join('\n');

  const resumo = await syncNocCameras({ db, csvText: csv });
  assert.equal(resumo.duplicatasNoArquivo, 1);
  assert.equal(resumo.jaCadastradas, 1);
  assert.equal(resumo.created, 1);
  assert.equal(mapNocStatus('Resolvido', 'Resolvido').status, 'Resolvido');
  const baixada = cameras.find(camera => camera.id === 'NOC-1');
  assert.equal(baixada.status, 'Resolvido');
  assert.equal(baixada.data_resolucao, '2026-11-25');
  assert.match(baixada.observacoes, /Baixa manual/);
});

test('sincronização NOC persiste centenas de câmeras em uma única chamada em lote', async () => {
  const itens = Array.from({ length: 900 }, (_, i) => ({
    id: String(30000 + i),
    nome: `CAM ${i}`,
    municipio: 'Cuiabá',
    status: 'Offline'
  }));
  const csv = serializeNocItemsToCsv(itens);
  let lotes = 0;
  let gravadas = [];
  const db = {
    async getCameras() { return []; },
    async upsertCamerasBulk(cameras) { lotes++; gravadas = cameras; },
    async upsertCamera() { throw new Error('escrita individual não deveria ser usada'); },
    async updateCamera() { throw new Error('escrita individual não deveria ser usada'); }
  };

  const seco = await syncNocCameras({ db, csvText: csv, dryRun: true });
  assert.equal(seco.created, 900);
  assert.equal(lotes, 0, 'dryRun não grava');

  const summary = await syncNocCameras({ db, csvText: csv });
  assert.equal(lotes, 1, 'a importação completa deve usar um único lote');
  assert.equal(gravadas.length, 900);
  assert.equal(summary.created, 900);
  assert.equal(gravadas.every(cam => cam.responsavel_telefone === ''), true);
});
