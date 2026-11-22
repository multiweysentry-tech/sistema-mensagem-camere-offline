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

function extrairDDD(entrada) {
  // Remove sufixo do WhatsApp (@s.whatsapp.net, @c.us) e tudo que nao for digito.
  let num = String(entrada).split('@')[0].replace(/\D/g, '');

  // Remove zeros a esquerda (ex.: 0 de operadora).
  num = num.replace(/^0+/, '');

  // Remove o codigo do pais, se presente.
  if (num.startsWith('55') && (num.length === 12 || num.length === 13)) {
    num = num.slice(2);
  }

  // Devem restar 10 (fixo/movel sem 9) ou 11 digitos (movel com 9).
  if (num.length !== 10 && num.length !== 11) return null;

  const ddd = num.slice(0, 2);
  return DDDS_VALIDOS.has(ddd) ? ddd : null;
}

function normalizarNumeroWhatsapp(entrada) {
  const digitos = String(entrada || '').replace(/\D/g, '').replace(/^0+/, '');
  if (/^\d{10,11}$/.test(digitos)) return `55${digitos}`;
  if (/^55\d{10,11}$/.test(digitos)) return digitos;
  return null;
}

function telefoneBrasileiroValido(entrada) {
  const numero = normalizarNumeroWhatsapp(entrada);
  return Boolean(numero && extrairDDD(numero));
}

module.exports = { DDDS_VALIDOS, extrairDDD, normalizarNumeroWhatsapp, telefoneBrasileiroValido };
