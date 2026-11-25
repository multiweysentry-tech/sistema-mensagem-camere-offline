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

test('painel carrega a normalização central sem duplicar a regra', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, 'phone-utils.js'), 'utf8');

  assert.match(html, /<script src="\/phone-utils\.js"><\/script>/);
  assert.doesNotMatch(html, /DDDS_VALIDOS\s*=\s*new Set/);
  assert.doesNotMatch(html, /replace\(\/\\D\/g/);
  assert.doesNotThrow(() => new vm.Script(shared), 'phone-utils.js contem erro de sintaxe');

  const context = {};
  vm.createContext(context);
  vm.runInContext(shared, context);
  assert.equal(context.PhoneUtils.extrairDDD('065999998888'), '65');
  assert.equal(
    context.PhoneUtils.chaveComparacaoTelefone('5565999998888@s.whatsapp.net'),
    '6599998888'
  );
});

test('painel não oferece ações locais de QR para servidor WhatsApp remoto', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  assert.match(html, /const connectionControls=waState\.provider==="meta"\s*\?[\s\S]*?:\s*waState\.remote/);
  assert.match(html, /Status no servidor Baileys: <b>\$\{esc\(waState\.remoteStatus\|\|waState\.status\)\}/);
  assert.match(html, /waState\.remote\?"":status==="open"/);
  assert.match(html, /endpoint protegido <code>\/qr<\/code>/);
});

test('painel oferece bot NOC para transformar offline em rascunhos, sem envio automático', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  assert.match(html, /function nocDraftView\(\)/);
  assert.match(html, /data-a="nocbot"/);
  assert.match(html, /btn\("s","editgroup"/);
  assert.match(html, /editgroup\(r\)\{/);
  assert.match(html, /if\(telefone\)fields\.responsavel_telefone=telefone/);
  assert.match(html, /data-a="gesend"/);
  assert.match(html, /ENVIAR WHATSAPP/);
  assert.match(html, /\/api\/bots\/noc\/run/);
  assert.match(html, /window\.addEventListener\("noc:offline"/);
  assert.match(html, /O bot somente prepara os rascunhos/);
  assert.match(html, /Nenhuma mensagem enviada/);
});

test('painel não afirma que mensagens sem WhatsApp configurado serão enfileiradas', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  assert.match(html, /waState\.status==="unsupported"/);
  assert.match(html, /WhatsApp não configurado neste painel · mensagens não serão enviadas/);
  assert.doesNotMatch(html, /alertas ficarão na fila, sem envio/);
});
