const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('scripts inline do painel sao JavaScript valido', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scripTags = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scripTags.exec(html))) {
    count += 1;
    assert.doesNotThrow(() => new vm.Script(match[1]), `script inline #${count} contem erro de sintaxe`);
  }
  assert.ok(count > 0, 'nenhum script inline encontrado no index.html');
});
