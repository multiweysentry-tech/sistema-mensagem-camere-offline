// Reusa a única fonte de normalização do projeto (phone-utils.js na raiz).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PhoneUtils = require('../../phone-utils.js');

// Regra de envio pedida: 55 + DDD + 9º dígito + número.
// A chave de comparação do cadastro continua tolerando números de 10 dígitos;
// aqui apenas preenchemos o 9º dígito para a consulta no WhatsApp. Se o número
// não existir, onWhatsApp() devolve 400 antes de qualquer envio.
export function normalizeSendNumber(value) {
  const info = PhoneUtils.normalizarTelefone(value);
  if (!info.valido) return null;
  let nacional = info.nacional;
  if (/^\d{10}$/.test(nacional)) nacional = `${nacional.slice(0, 2)}9${nacional.slice(2)}`;
  return `55${nacional}`;
}

export function maskNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10) return '***';
  return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} **** ${digits.slice(-4)}`;
}

export { PhoneUtils };
