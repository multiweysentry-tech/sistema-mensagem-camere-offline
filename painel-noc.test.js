const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dirPainel = path.join(__dirname, 'PAINEL NOC - CAMERAS OFFLINE');
const ler = arquivo => fs.readFileSync(arquivo, 'utf8');
const gerado = ler(path.join(dirPainel, 'index.html'));
const template = ler(path.join(dirPainel, 'painel-template.html'));
const espelho = ler(path.join(__dirname, 'painel-noc', 'index.html'));
const app = ler(path.join(__dirname, 'index.html'));
const appSync = require(path.join(dirPainel, 'backend', 'app-sync.js'));

test('template do painel é a fonte da versão gerada e do espelho', () => {
  assert.match(template, /const PAYLOAD = \/\*__DATA__\*\/null;/);
  assert.doesNotMatch(template, /"geradoEm":"25\/11\/2026/);
  assert.equal(gerado, espelho, 'espelho /painel-noc/ divergiu do painel gerado');
  assert.ok(
    app.includes(appSync.blocoTemplate(gerado)),
    'template embutido no app divergiu do painel gerado'
  );
});

test('leitura de dados do painel tem botão, regexes válidas e texto íntegro', () => {
  assert.match(gerado, /<button[^>]+id="btnLeitura"/);
  assert.match(gerado, /<button[^>]+id="btnEnviarOffline"/);
  assert.match(gerado, /new CustomEvent\('noc:offline'/);
  assert.match(gerado, /id="leituraModal"/);
  assert.match(gerado, /<button[^>]+id="btnSalvarLeitura"/);
  assert.match(gerado, /async function salvarLeitura\(/);
  assert.match(gerado, /window\.addEventListener\('noc:payload'/);
  assert.match(gerado, /COLUNAS_ARMAZENAMENTO/);
  assert.match(gerado, /\[COLUNAS_ARMAZENAMENTO\.join\(';'\)/, 'cabeçalho do CSV salvo precisa usar ;');
  assert.ok(gerado.includes('(\\d{1,2})[/-](\\d{1,2})'), 'regex de data perdeu \\d');
  assert.ok(gerado.includes('\\s*[|;/•·]\\s*'), 'separador de responsáveis perdeu \\s');
  assert.match(gerado, /function parseCsvLinhas\(texto, sep\)/, 'CSV precisa ser lido linha a linha');
  assert.match(gerado, /MAX_CAMPO_CSV = 500/, 'campos do CSV precisam de limite de tamanho');
  assert.match(gerado, /aspas = false; \/\/ nunca deixa aspas abertas/, 'linha com aspas soltas não pode engolir as próximas');
  assert.ok(!gerado.includes('c?meras'), 'mojibake em "câmeras"');
  assert.ok(!gerado.includes('atualiza??o'), 'mojibake em "atualização"');
});

test('CSV com aspas soltas não transforma várias linhas em um único nome', () => {
  const inicio = template.indexOf('const MAX_CAMPO_CSV = 500;');
  const fim = template.indexOf('async function processarLeitura(){', inicio);
  assert.ok(inicio > 0 && fim > inicio, 'parser de CSV não encontrado no template');
  const codigo = template.slice(inicio, fim);
  const csv = [
    'ID;Nome;Município;Responsável;Marcadores;Status;Último status;Tempo offline;Desconexões 24h;SLA 24h;SLA total',
    '"1774";"NOVA XAVANTINA - CAM 39 - ESQUINA AV TERRA NOVA COM RUA ZERO "CASA MORTUÁRIA” Carazinho com Br 158";"NOVA XAVANTINA - MT";"Adeildo | JOÃO MACHADO NETO";"";"Online";"";"";"0";"100%";"100%"',
    '"1775";"NOVA XAVANTINA - CAM 40 - Carazinho com Br 158";"NOVA XAVANTINA - MT";"Adeildo | JOÃO MACHADO NETO";"";"Offline";"";"";"0";"100%";"100%"'
  ].join('\r\n');
  const linhas = vm.runInNewContext(`${codigo}\nparseCsvLinhas(texto, ';')`, { texto: csv });
  assert.equal(linhas.length, 3, 'as três linhas precisam continuar separadas');
  assert.equal(linhas[1].length, 11);
  assert.ok(linhas[1][1].length < 200, 'nome não pode virar um blob de milhões de caracteres');
  assert.ok(linhas[1][1].includes('CASA MORTUÁRIA'));
  assert.equal(linhas[2][0], '1775');
});

test('scripts inline do painel gerado e do template são JavaScript válido', () => {
  for (const [nome, html] of [['gerado', gerado], ['template', template]]) {
    let quantidade = 0;
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      if (!match[1].trim()) continue;
      quantidade += 1;
      assert.doesNotThrow(() => new vm.Script(match[1]), `${nome} script #${quantidade} inválido`);
    }
    assert.ok(quantidade > 0, `${nome} não tem script inline`);
  }
});

test('view nativa executa todos os scripts e carrega dependências externas', () => {
  assert.match(app, /function carregarScriptNOC\(src\)/);
  assert.match(app, /querySelectorAll\("script"\)/);
  assert.match(app, /Promise\.all\(externos\.map\(carregarScriptNOC\)\)/);
  assert.match(app, /host\.shadowRoot/);
  assert.match(app, /window\.__nocStorageEndpoint="\/api\/noc\/arquivos"/);
  assert.match(app, /async function restaurarUltimoArquivoNOC\(/);
  assert.match(app, /new CustomEvent\("noc:payload"/);
  assert.match(gerado, /window\.__nocXlsxPromise/);
});

test('painel NOC oferece baixa, agrupamento e dedupe sem duplicar regra de telefone', () => {
  for (const [nome, html] of [['template', template], ['gerado', gerado], ['embutido', app]]) {
    assert.match(html, /id="btnDarBaixa"/, `${nome}: falta botão de dar baixa`);
    assert.match(html, /function darBaixa\(ids, observacao\)/, `${nome}: falta darBaixa()`);
    assert.match(html, /new CustomEvent\('noc:baixa'/, `${nome}: falta evento noc:baixa`);
    assert.match(html, /id="btnAgrupar"/, `${nome}: falta botão de agrupar`);
    assert.match(html, /function agruparIdsEmResponsavel\(\)/, `${nome}: falta agrupamento`);
    assert.match(html, /groups:\[\{responsavel_nome:nome/, `${nome}: falta groups[]`);
    assert.match(html, /function filtrarLinhasLidas\(lidas\)/, `${nome}: falta dedupe do anexo`);
    assert.match(html, /ignoradasCadastradas\+\+/, `${nome}: falta contagem de IDs cadastradas`);
    assert.match(html, /Data resolução/, `${nome}: falta coluna de data da baixa`);
    assert.match(html, /Observação/, `${nome}: falta coluna de observação`);
    assert.doesNotMatch(html, /replace\(\/\\D\/g/, `${nome}: regra de telefone duplicada`);
  }
  assert.match(template, /<script src="\/phone-utils\.js"><\/script>/);
  assert.match(template, /function chaveTelefone\(v\)/);
});

test('darBaixa altera só o status para Resolvido e registra data e observação', () => {
  const inicioStats = template.indexOf('function calcularStats(arr, meta={})');
  const fimStats = template.indexOf('function renderDashboard(){', inicioStats);
  const inicioAcao = template.indexOf('function atualizarDepoisDeAcao(mensagem){');
  const fimAcao = template.indexOf('function popularResponsaveisAgrupamento(){', inicioAcao);
  assert.ok(inicioStats > 0 && fimStats > inicioStats && inicioAcao > 0 && fimAcao > inicioAcao);
  const codigo = template.slice(inicioStats, fimStats) + '\n' + template.slice(inicioAcao, fimAcao);

  const eventos = [];
  const elementos = {};
  const ctx = {
    window: { dispatchEvent: evento => eventos.push(evento) },
    document: { getElementById: () => null },
    CustomEvent: function CustomEvent(tipo, init) {
      this.type = tipo;
      this.detail = init && init.detail;
    },
    $: id => {
      if (!elementos[id]) {
        elementos[id] = { textContent: '', innerHTML: '', classList: { contains: () => false } };
      }
      return elementos[id];
    },
    norm: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(),
    pendente: d => Boolean(d) && d.status !== 'Online' && d.status !== 'Resolvido',
    chaveId: v => String(v ?? '').replace(/^NOC-/i, '').replace(/[^A-Z0-9]/g, ''),
    MAX_CAMPO_CSV: 500,
    stats: { geradoEm: '25/11/2026, 03:37:08', arquivoFonte: 'noc-original.csv' },
    PAYLOAD: null,
    data: [
      { id: 123, idTexto: '123', municipio: 'Cuiabá', status: 'Offline', offlineMin: 120, desc24: 0, slaTotal: 50 },
      { id: 456, idTexto: '456', municipio: 'Sinop', status: 'Online', offlineMin: 0, desc24: 0, slaTotal: 100 },
      { id: 789, idTexto: '789', municipio: 'Sinop', status: 'Resolvido', offlineMin: 40, desc24: 0, slaTotal: 80 }
    ],
    renderRenderizado: 0,
    renderDashboard() { ctx.renderRenderizado++; },
    mostrar() {},
    prepararLeituraParaSalvar() {}
  };
  ctx.PAYLOAD = { stats: ctx.stats, data: ctx.data, resumoMunicipios: [] };
  vm.runInNewContext(codigo, ctx);

  assert.equal(ctx.darBaixa(['NOC-123'], 'Troca concluída'), 1);
  assert.equal(ctx.data[0].status, 'Resolvido');
  assert.match(ctx.data[0].dataResolucao, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ctx.data[0].observacao, /Troca concluída/);
  assert.equal(ctx.data[0].offlineMin, 0);
  assert.equal(ctx.data[1].status, 'Online', 'câmera online não pode ser alterada');
  assert.equal(ctx.data[1].observacao, undefined);
  assert.equal(ctx.data[2].status, 'Resolvido', 'câmera já resolvida não pode ser reaberta');
  assert.equal(ctx.PAYLOAD.stats.offline, 0);
  assert.equal(ctx.PAYLOAD.stats.resolvidos, 2);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].type, 'noc:baixa');
  assert.deepEqual(Array.from(eventos[0].detail.ids), ['123']);
  assert.equal(eventos[0].detail.observacao, 'Troca concluída');
  assert.ok(ctx.renderRenderizado > 0, 'dashboard precisa ser recalculado após a baixa');
});

test('agruparIdsEmResponsavel envia groups[] ao Offline e não dispara WhatsApp', () => {
  const inicio = template.indexOf('function itensOffline(){');
  const fim = template.indexOf('async function carregarIdsCadastradas(){', inicio);
  assert.ok(inicio > 0 && fim > inicio);
  const codigo = template.slice(inicio, fim);

  const eventos = [];
  const campos = {
    agruparIds: { value: '123; NOC-456; 999' },
    agruparResponsavel: { selectedOptions: [] },
    agruparNome: { value: 'Novo Responsável' },
    agruparTelefone: { value: '(65) 99999-8888' },
    agruparStatus: { textContent: '' }
  };
  let atualizado = false, fechado = false;
  const ctx = {
    window: { dispatchEvent: evento => eventos.push(evento) },
    CustomEvent: function CustomEvent(tipo, init) {
      this.type = tipo;
      this.detail = init && init.detail;
    },
    $: id => campos[id],
    pendente: d => Boolean(d) && d.status !== 'Online' && d.status !== 'Resolvido',
    chaveId: v => String(v ?? '').replace(/^NOC-/i, '').replace(/[^A-Z0-9]/g, ''),
    data: [
      { idTexto: '123', status: 'Offline', responsaveis: ['Antigo'], municipio: 'Cuiabá' },
      { idTexto: '456', status: 'Offline', responsaveis: ['Antigo'], municipio: 'Sinop' },
      { idTexto: '789', status: 'Resolvido', responsaveis: ['Intocável'], municipio: 'Sinop' }
    ],
    atualizarDepoisDeAcao() { atualizado = true; },
    fecharAgrupar() { fechado = true; }
  };
  vm.runInNewContext(codigo, ctx);

  ctx.agruparIdsEmResponsavel();

  assert.equal(atualizado, true);
  assert.equal(fechado, true);
  assert.deepEqual(Array.from(ctx.data[0].responsaveis), ['Novo Responsável']);
  assert.deepEqual(Array.from(ctx.data[1].responsaveis), ['Novo Responsável']);
  assert.deepEqual(Array.from(ctx.data[2].responsaveis), ['Intocável'], 'resolvido não entra no grupo');
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].type, 'noc:offline');
  const grupo = eventos[0].detail.groups[0];
  assert.equal(grupo.responsavel_nome, 'Novo Responsável');
  assert.equal(grupo.responsavel_telefone, '(65) 99999-8888');
  assert.deepEqual(Array.from(grupo.cameraIds), ['123', 'NOC-456', '999']);
  assert.deepEqual(Array.from(eventos[0].detail.items.map(item => item.id)), ['123', '456']);
  assert.equal(eventos.some(evento => /whatsapp/i.test(evento.type)), false);
});

test('anexo do painel ignora IDs já cadastradas e IDs repetidas', () => {
  const inicio = template.indexOf('function filtrarLinhasLidas(lidas){');
  const fim = template.indexOf('/* ---------- Export CSV ---------- */', inicio);
  assert.ok(inicio > 0 && fim > inicio);
  const ctx = {
    idsCadastradas: new Set(['123']),
    chaveId: v => String(v ?? '').replace(/^NOC-/i, '').replace(/[^A-Z0-9]/g, '')
  };
  vm.runInNewContext(template.slice(inicio, fim), ctx);

  const resultado = ctx.filtrarLinhasLidas([
    { idTexto: '123', nome: 'Já cadastrada' },
    { idTexto: '456', nome: 'Nova' },
    { idTexto: 'NOC-456', nome: 'Repetida no arquivo' },
    { idTexto: '789', nome: 'Outra nova' }
  ]);
  assert.deepEqual(Array.from(resultado.parsed.map(item => item.idTexto)), ['456', '789']);
  assert.equal(resultado.ignoradasCadastradas, 1);
  assert.equal(resultado.duplicadasNoArquivo, 1);
});
