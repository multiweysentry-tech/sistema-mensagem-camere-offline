// Unica fonte da regra de normalizacao de telefone brasileiro.
// Funciona no Node (require) e no navegador (window.PhoneUtils).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhoneUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DDDS_VALIDOS = new Set([
    '11','12','13','14','15','16','17','18','19',
    '21','22','24','27','28',
    '31','32','33','34','35','37','38',
    '41','42','43','44','45','46','47','48','49',
    '51','53','54','55',
    '61','62','63','64','65','66','67','68','69',
    '71','73','74','75','77','79',
    '81','82','83','84','85','86','87','88','89',
    '91','92','93','94','95','96','97','98','99'
  ]);

  // Normaliza qualquer entrada (JID, máscara, DDI/zero à esquerda) em uma
  // estrutura única. Nunca inventa o 9º dígito: ele apenas é ignorado na
  // chave de comparação para que 10 e 11 dígitos representem o mesmo contato.
  function normalizarTelefone(entrada) {
    const texto = String(entrada === null || entrada === undefined ? '' : entrada);
    const arroba = texto.indexOf('@');
    const semSufixo = arroba === -1 ? texto : texto.slice(0, arroba);
    const digits = semSufixo.replace(/\D/g, '');
    const semZeros = digits.replace(/^0+/, '');
    const nacional = /^55\d{10,11}$/.test(semZeros) ? semZeros.slice(2) : semZeros;
    const valido = /^\d{10,11}$/.test(nacional) && DDDS_VALIDOS.has(nacional.slice(0, 2));

    const ddd = valido ? nacional.slice(0, 2) : null;
    const assinante = valido ? nacional.slice(2) : null;
    const chaveComparacao = valido ? `${ddd}${assinante.slice(-8)}` : null;
    const internacional = valido ? `55${nacional}` : null;

    return { valido, ddd, chaveComparacao, nacional, internacional, digits };
  }

  function extrairDDD(entrada) {
    return normalizarTelefone(entrada).ddd;
  }

  function normalizarNumeroWhatsapp(entrada) {
    return normalizarTelefone(entrada).internacional;
  }

  function chaveComparacaoTelefone(entrada) {
    return normalizarTelefone(entrada).chaveComparacao;
  }

  // Formato canonico usado como chave de gravacao/consulta. Para entradas
  // invalidas mantem os digitos brutos, preservando o comportamento anterior
  // de validacoes que aceitavam 10 a 15 digitos sem exigir DDD brasileiro.
  function normalizarContato(entrada) {
    const normalizado = normalizarTelefone(entrada);
    return normalizado.internacional || normalizado.digits;
  }

  function telefoneBrasileiroValido(entrada) {
    return normalizarTelefone(entrada).valido;
  }

  return {
    DDDS_VALIDOS,
    normalizarTelefone,
    extrairDDD,
    normalizarNumeroWhatsapp,
    normalizarContato,
    chaveComparacaoTelefone,
    telefoneBrasileiroValido
  };
});
