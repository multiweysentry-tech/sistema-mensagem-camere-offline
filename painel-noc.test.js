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
