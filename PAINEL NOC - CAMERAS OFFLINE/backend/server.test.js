'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const noc = require('./noc-data');
const arquivos = require('./arquivos');
const { criarServidor } = require('./server');

const MODELO = fs.readFileSync(path.join(__dirname, '..', 'painel-template.html'), 'utf8');

const CSV = [
  'ID;Nome;Município;Responsável;Marcadores;Status;Último status;Tempo offline;Desconexões 24h;SLA 24h;SLA total',
  '"1";"SEDUC - ESCOLA A - CAM 01";"CUIABÁ - MT";"João | Maria";"Escolas";"Offline";"22/11/2026 10:00:00";"8d 1h";"12";"10%";"40%"',
  '"2";"CDL - LOJA B - CAM 02";"SINOP - MT";"Pedro";"CDL";"Offline";"23/11/2026 09:00:00";"30min";"0";"100%";"99%"',
  '"3";"GEFRON - POSTO C";"CUIABÁ";"";"";"Online";"23/11/2026 11:00:00";"";"0";"100%";"100%"',
].join('\r\n');

function criarTemporario() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-noc-'));
  fs.writeFileSync(path.join(raiz, 'painel-template.html'), MODELO);
  fs.writeFileSync(path.join(raiz, 'noc-original.csv'), noc.BOM + CSV, 'utf8');
  arquivos.gerarArquivos({ raiz, textoCsv: CSV });
  return raiz;
}

test('parser e normalização', async t => {
  await t.test('parseCSV respeita aspas, separador e BOM', () => {
    const linhas = noc.parseCSV(`\uFEFFID;Nome\n"1";"CAM; com ;"`);
    assert.deepEqual(linhas, [['ID', 'Nome'], ['1', 'CAM; com ;']]);
  });

  await t.test('detectSeparator aceita CSV com vírgula', () => {
    assert.equal(noc.detectSeparator('ID,Nome\n1,CAM'), ',');
  });

  await t.test('payload mantém o formato consumido pelo painel', () => {
    const payload = noc.construirPayload(CSV);
    assert.equal(payload.stats.total, 3);
    assert.equal(payload.stats.offline, 2);
    assert.equal(payload.stats.online, 1);
    assert.equal(payload.stats.municipios, 2);
    assert.equal(payload.stats.mais24h, 1);
    assert.equal(payload.stats.mais7d, 1);
    assert.equal(payload.stats.desc24Total, 12);
    assert.equal(payload.stats.slaMedio, 80);
    assert.equal(payload.data[0].categoria, 'Escolas (SEDUC)');
    assert.deepEqual(payload.data[0].responsaveis, ['João', 'Maria']);
    assert.equal(payload.data[0].offlineMin, 8 * 1440 + 60);
    assert.equal(payload.resumoMunicipios[0].municipio, 'CUIABÁ');
  });

  await t.test('CSV sem colunas obrigatórias é rejeitado', () => {
    assert.throws(() => noc.construirPayload('Foo;Bar\n1;2'), /Colunas obrigatórias/);
  });

  await t.test('filtros e severidade', () => {
    const dados = noc.construirPayload(CSV).data;
    assert.equal(noc.severidadeDe(dados[0]).key, 's4');
    assert.equal(noc.severidadeDe(dados[1]).key, 's0');
    assert.equal(noc.severidadeDe(dados[2]), null);
    assert.equal(noc.filtrar(dados, { severidade: 's4' }).length, 1);
    assert.equal(noc.filtrar(dados, { status: 'Offline', q: 'joão' }).length, 1);
    assert.equal(noc.filtrar(dados, { municipio: 'SINOP' }).length, 1);
  });
});

test('geração de arquivos e API HTTP', async t => {
  const raiz = criarTemporario();
  const servidor = criarServidor({ raiz });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  t.after(() => {
    servidor.close();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  await t.test('artefatos são gravados com o payload embutido', () => {
    const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
    assert.match(html, /"total":3/);
    assert.match(fs.readFileSync(path.join(raiz, 'noc-organizado.csv'), 'utf8'), /SEDUC/);
    assert.match(fs.readFileSync(path.join(raiz, 'resumo-por-municipio.csv'), 'utf8'), /CUIABÁ/);
    assert.equal(arquivos.obterPayload({ raiz }).data.length, 3);
  });

  await t.test('GET /api/health e /api/painel', async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.total, 3);
    const painel = await (await fetch(`${base}/api/painel`)).json();
    assert.equal(painel.data.length, 3);
    assert.equal(painel.resumoMunicipios.length, 2);
  });

  await t.test('GET /api/camaras aplica filtros e paginação', async () => {
    const r = await (await fetch(`${base}/api/camaras?status=Offline&severidade=s0&limite=1`)).json();
    assert.equal(r.total, 1);
    assert.equal(r.itens.length, 1);
    assert.equal(r.itens[0].id, 2);
  });

  await t.test('GET /api/exportar.csv devolve CSV filtrado com BOM', async () => {
    const resposta = await fetch(`${base}/api/exportar.csv?municipio=SINOP`);
    const bytes = Buffer.from(await resposta.arrayBuffer());
    const texto = bytes.toString('utf8');
    assert.match(resposta.headers.get('content-disposition'), /attachment/);
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(texto, /CDL - LOJA B/);
    assert.doesNotMatch(texto, /SEDUC/);
  });

  await t.test('POST /api/importar em dryRun não altera os arquivos', async () => {
    const antes = fs.readFileSync(path.join(raiz, 'noc-original.csv'), 'utf8');
    const resposta = await fetch(`${base}/api/importar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: CSV.replace(/"12"/, '"99"'), dryRun: true }),
    });
    const json = await resposta.json();
    assert.equal(json.dryRun, true);
    assert.equal(json.stats.desc24Total, 99);
    assert.equal(fs.readFileSync(path.join(raiz, 'noc-original.csv'), 'utf8'), antes);
  });

  await t.test('POST /api/importar regenera os artefatos e cria backup', async () => {
    const csvNovo = CSV.replace(/"3";"GEFRON - POSTO C"/, '"3";"GEFRON - POSTO D"');
    const resposta = await fetch(`${base}/api/importar`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csvNovo,
    });
    const json = await resposta.json();
    assert.equal(json.ok, true);
    assert.equal(json.backups.length, 4);
    assert.match(fs.readFileSync(path.join(raiz, 'index.html'), 'utf8'), /POSTO D/);
    assert.equal(arquivos.obterPayload({ raiz, forcar: true }).data.length, 3);
  });

  await t.test('arquivos internos não são servidos', async () => {
    const resposta = await fetch(`${base}/backend/server.js`);
    assert.equal(resposta.status, 404);
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Painel NOC/);
  });
});

test('token de API quando configurado', async t => {
  const raiz = criarTemporario();
  const servidor = criarServidor({ raiz, token: 'segredo' });
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  t.after(() => {
    servidor.close();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'x-api-key': 'x' } })).status, 401);
  const ok = await fetch(`${base}/api/health`, { headers: { 'x-api-key': 'segredo' } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('regressões de segurança e consistência', async t => {
  await t.test('payload embutido não permite fechar a tag <script>', () => {
    const nome = 'CAM 1 </script><img src=x onerror=alert(1)>';
    const payload = noc.construirPayload(
      ['ID;Nome;Município;Status', `"1";"${nome}";"CUIABÁ";"Offline"`].join('\r\n')
    );
    const html = noc.renderizarHTML(MODELO, payload);
    assert.doesNotMatch(html, /<\/script><img/);
    assert.match(html, /\\u003cimg/);
    assert.ok(MODELO.includes('${' + 'esc(d.idTexto)' + '}'));
  });

  await t.test('parseCSV não abre aspas no meio de um campo', () => {
    assert.deepEqual(
      noc.parseCSV('ID;Nome\n1;CAM 12" polegados\n2;OUTRA'),
      [['ID', 'Nome'], ['1', 'CAM 12" polegados'], ['2', 'OUTRA']]
    );
  });

  await t.test('gerar a partir de CSV externo não envenena o cache', () => {
    const raiz = criarTemporario();
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const externo = 'ID;Nome;Município;Status\n"99";"CAM EXTERNA";"SINOP";"Offline"';
    arquivos.gerarArquivos({ raiz, textoCsv: externo, arquivoFonte: 'externo.csv' });
    const emCache = arquivos.obterPayload({ raiz });
    const doDisco = arquivos.obterPayload({ raiz, forcar: true });
    assert.equal(emCache.data[0].nome, doDisco.data[0].nome);
  });

  await t.test('importação com falha na última escrita restaura todos os artefatos', () => {
    const raiz = criarTemporario();
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const nomes = ['noc-original.csv', 'noc-organizado.csv', 'resumo-por-municipio.csv', 'index.html'];
    const antes = nomes.map(nome => fs.readFileSync(path.join(raiz, nome), 'utf8'));
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (destino, conteudo, ...resto) {
      if (String(destino).includes('index.html') && String(conteudo).includes('POSTO NOVO')) {
        throw new Error('falha de escrita simulada');
      }
      return realWrite.call(this, destino, conteudo, ...resto);
    };
    try {
      const csvNovo = CSV.replace('GEFRON - POSTO C', 'GEFRON - POSTO NOVO');
      assert.throws(
        () => arquivos.importarCSV({ raiz, textoCSV: csvNovo, salvarOriginal: true }),
        /falha de escrita simulada/
      );
    } finally {
      fs.writeFileSync = realWrite;
    }
    const depois = nomes.map(nome => fs.readFileSync(path.join(raiz, nome), 'utf8'));
    assert.deepEqual(depois, antes);
  });

  await t.test('POST acima do limite recebe 413 em vez de conexão encerrada', async () => {
    const raiz = criarTemporario();
    const servidor = criarServidor({ raiz, limiteBytes: 32 });
    await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    t.after(() => { servidor.close(); fs.rmSync(raiz, { recursive: true, force: true }); });
    const resposta = await fetch(`${base}/api/importar`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: 'x'.repeat(5000),
    });
    assert.equal(resposta.status, 413);
    assert.equal((await resposta.json()).codigo, 'PAYLOAD_TOO_LARGE');
  });

  await t.test('csvResumo escapa aspas duplas', () => {
    const payload = noc.construirPayload('ID;Nome;Município;Status\n"1";"CAM";"SÃO ""MICRO"" - MT";"Offline"');
    const linhas = noc.parseCSV(noc.csvResumo(payload));
    assert.equal(linhas[1].length, 6);
    assert.equal(linhas[1][0], 'SÃO "MICRO"'); // o sufixo " - MT" é removido na normalização
  });

  await t.test('busca ignora acentos e caixa', () => {
    const dados = noc.construirPayload(CSV).data;
    assert.equal(noc.filtrar(dados, { q: 'cuiaba' }).length, 2);
    assert.equal(noc.filtrar(dados, { q: 'JOAO' }).length, 1);
  });

  await t.test('parseOfflineMinutes aceita abreviatura m', () => {
    assert.equal(noc.parseOfflineMinutes('1h 30m'), 90);
    assert.equal(noc.parseOfflineMinutes('3d 15h 58min'), 3 * 1440 + 15 * 60 + 58);
  });

  await t.test('ID original com zeros à esquerda é preservado', () => {
    const payload = noc.construirPayload('ID;Nome;Município;Status\n"00042";"CAM";"CUIABÁ";"Offline"');
    assert.equal(payload.data[0].idTexto, '00042');
    assert.equal(payload.data[0].id, 42);
    assert.match(noc.csvOrganizado(payload), /"00042"/);
    assert.match(noc.csvFiltrado(payload.data), /"00042"/);
    assert.equal(noc.filtrar(payload.data, { q: '00042' }).length, 1);
  });

  await t.test('geradoEm da API acompanha o timestamp embutido no HTML', () => {
    const raiz = criarTemporario();
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const selo = '01/01/2020, 00:00:00';
    arquivos.gerarArquivos({ raiz, textoCsv: CSV, geradoEm: selo });
    assert.match(fs.readFileSync(path.join(raiz, 'index.html'), 'utf8'), /"geradoEm":"01\/01\/2020, 00:00:00"/);
    assert.equal(arquivos.obterPayload({ raiz, forcar: true }).stats.geradoEm, selo);
  });

  await t.test('geração espelha os artefatos nas pastas informadas', () => {
    const raiz = criarTemporario();
    const espelho = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-noc-espelho-'));
    t.after(() => {
      fs.rmSync(raiz, { recursive: true, force: true });
      fs.rmSync(espelho, { recursive: true, force: true });
    });
    arquivos.gerarArquivos({ raiz, textoCsv: CSV, espelharEm: [espelho] });
    for (const nome of ['noc-original.csv', 'noc-organizado.csv', 'resumo-por-municipio.csv', 'index.html']) {
      assert.equal(
        fs.readFileSync(path.join(espelho, nome), 'utf8'),
        fs.readFileSync(path.join(raiz, nome), 'utf8'),
        `divergência em ${nome}`
      );
    }
  });

  await t.test('URI malformada responde 404', async () => {
    const raiz = criarTemporario();
    const servidor = criarServidor({ raiz });
    await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    t.after(() => { servidor.close(); fs.rmSync(raiz, { recursive: true, force: true }); });
    assert.equal((await fetch(`${base}/%ZZ`)).status, 404);
  });
});
