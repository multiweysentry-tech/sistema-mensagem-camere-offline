const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DDDS_VALIDOS,
  normalizarTelefone,
  extrairDDD,
  normalizarNumeroWhatsapp,
  normalizarContato,
  chaveComparacaoTelefone,
  telefoneBrasileiroValido
} = require('./phone-utils');

const CHAVE_ESPERADA = '6599998888';

const FORMATOS_ACEITOS = [
  '5565999998888@s.whatsapp.net',
  '5565999998888@c.us',
  '556599998888',          // 12 dígitos, sem o 9º
  '+55 (65) 99999-8888',   // máscara
  '065999998888',          // zero à esquerda
  '65999998888'            // sem código do país
];

test('todos os formatos de entrada produzem a mesma chave de comparação', () => {
  for (const entrada of FORMATOS_ACEITOS) {
    const resultado = normalizarTelefone(entrada);
    assert.equal(resultado.valido, true, `entrada rejeitada: ${entrada}`);
    assert.equal(resultado.ddd, '65', `DDD incorreto: ${entrada}`);
    assert.equal(resultado.chaveComparacao, CHAVE_ESPERADA, `chave incorreta: ${entrada}`);
  }
});

test('normalizarTelefone remove sufixo, máscara, zero à esquerda e DDI', () => {
  assert.deepEqual(normalizarTelefone('5565999998888@s.whatsapp.net'), {
    valido: true,
    ddd: '65',
    chaveComparacao: CHAVE_ESPERADA,
    nacional: '65999998888',
    internacional: '5565999998888',
    digits: '5565999998888'
  });

  assert.deepEqual(normalizarTelefone('5565999998888@c.us'), {
    valido: true,
    ddd: '65',
    chaveComparacao: CHAVE_ESPERADA,
    nacional: '65999998888',
    internacional: '5565999998888',
    digits: '5565999998888'
  });

  const sem9 = normalizarTelefone('556599998888');
  assert.equal(sem9.nacional, '6599998888');
  assert.equal(sem9.internacional, '556599998888');
  assert.equal(sem9.chaveComparacao, CHAVE_ESPERADA);

  const mascara = normalizarTelefone('+55 (65) 99999-8888');
  assert.equal(mascara.internacional, '5565999998888');
  assert.equal(mascara.chaveComparacao, CHAVE_ESPERADA);

  const comZero = normalizarTelefone('065999998888');
  assert.equal(comZero.digits, '065999998888');
  assert.equal(comZero.internacional, '5565999998888');
  assert.equal(comZero.chaveComparacao, CHAVE_ESPERADA);

  const semDdi = normalizarTelefone('65999998888');
  assert.equal(semDdi.nacional, '65999998888');
  assert.equal(semDdi.internacional, '5565999998888');
  assert.equal(semDdi.chaveComparacao, CHAVE_ESPERADA);
});

test('entradas inválidas não recebem DDD nem chave', () => {
  const invalidas = ['', 'abc', '12345', '5510999990003', '123456789@lid'];
  for (const entrada of invalidas) {
    const resultado = normalizarTelefone(entrada);
    assert.equal(resultado.valido, false, `entrada aceita: ${entrada}`);
    assert.equal(resultado.ddd, null, `DDD inventado: ${entrada}`);
    assert.equal(resultado.chaveComparacao, null, `chave inventada: ${entrada}`);
    assert.equal(resultado.internacional, null, `internacional inventado: ${entrada}`);
    assert.equal(extrairDDD(entrada), null, `extrairDDD: ${entrada}`);
    assert.equal(chaveComparacaoTelefone(entrada), null, `chaveComparacaoTelefone: ${entrada}`);
    assert.equal(telefoneBrasileiroValido(entrada), false, `validação: ${entrada}`);
  }
});

test('DDD inexistente é rejeitado e DDD 55 não é confundido com o DDI', () => {
  assert.equal(DDDS_VALIDOS.has('10'), false);
  assert.equal(DDDS_VALIDOS.has('55'), true);

  const ddd55 = normalizarTelefone('55988887777');
  assert.equal(ddd55.valido, true);
  assert.equal(ddd55.ddd, '55');
  assert.equal(ddd55.nacional, '55988887777');
  assert.equal(ddd55.internacional, '5555988887777');
  assert.equal(ddd55.chaveComparacao, '5588887777');

  const ddd55Mascarado = normalizarTelefone('+55 (55) 98888-7777');
  assert.equal(ddd55Mascarado.ddd, '55');
  assert.equal(ddd55Mascarado.chaveComparacao, ddd55.chaveComparacao);
});

test('wrappers de compatibilidade usam a mesma regra central', () => {
  assert.equal(extrairDDD('+55 (65) 99999-8888'), '65');
  assert.equal(extrairDDD('5565981130338@s.whatsapp.net'), '65');
  assert.equal(normalizarNumeroWhatsapp('65999998888'), '5565999998888');
  assert.equal(normalizarNumeroWhatsapp('065999998888'), '5565999998888');
  assert.equal(chaveComparacaoTelefone('065999998888'), CHAVE_ESPERADA);
  assert.equal(normalizarContato('065999998888'), '5565999998888');
  assert.equal(normalizarContato('abc'), '');
  assert.equal(telefoneBrasileiroValido('5510999990003'), false);
});
