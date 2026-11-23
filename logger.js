// Logging estruturado sem dependencias externas.
// Nunca imprime credenciais, QR ou numero completo de telefone.
const { randomUUID } = require('crypto');
const { normalizarTelefone } = require('./phone-utils');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function redactPhone(value) {
  const digits = normalizarTelefone(value).digits;
  if (digits.length < 6) return '[redacted]';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

function safeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (/token|password|secret|qr|credential|authorization|apikey|api_key/i.test(key)) {
      out[key] = '[redacted]';
    } else if (/phone|jid|telefone|remotejid/i.test(key)) {
      out[key] = redactPhone(value);
    } else if (value instanceof Error) {
      out[key] = value.message;
    } else if (typeof value === 'object') {
      out[key] = '[object]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function log(level, event, fields = {}, traceId = randomUUID()) {
  if ((LEVELS[level] || 20) < threshold) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    traceId,
    ...safeFields(fields)
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = { log, redactPhone, safeFields, newTraceId: randomUUID };
