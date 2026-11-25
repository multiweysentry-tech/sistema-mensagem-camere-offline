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
  assert.ok(gerado.includes('(\\d{1,2})[/-](\\d{1,2})'), 'regex de data perdeu \\d');
  assert.ok(gerado.includes('\\s*[|;/•·]\\s*'), 'separador de responsáveis perdeu \\s');
  assert.match(gerado, /XLSX\.read\(text, \{type:'string', FS: separador\}\)/, 'CSV não informa o separador ao XLSX');
  assert.ok(!gerado.includes('c?meras'), 'mojibake em "câmeras"');
  assert.ok(!gerado.includes('atualiza??o'), 'mojibake em "atualização"');
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
  assert.match(gerado, /window\.__nocXlsxPromise/);
});
