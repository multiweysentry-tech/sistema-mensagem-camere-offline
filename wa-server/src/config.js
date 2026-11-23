import path from 'node:path';

function integer(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const apiKey = String(env.API_KEY || '').trim();
  if (!apiKey) throw new Error('API_KEY obrigatoria: defina uma chave longa e aleatoria');

  const minDelayMs = integer(env, 'QUEUE_MIN_DELAY_MS', 3000, { min: 0, max: 600000 });
  const maxDelayMs = integer(env, 'QUEUE_MAX_DELAY_MS', 8000, { min: 1, max: 600000 });
  if (maxDelayMs < minDelayMs) throw new Error('QUEUE_MAX_DELAY_MS deve ser >= QUEUE_MIN_DELAY_MS');

  return {
    host: String(env.HOST || '0.0.0.0').trim(),
    port: integer(env, 'PORT', 3001, { min: 1, max: 65535 }),
    apiKey,
    sessionDir: path.resolve(String(env.SESSION_DIR || './session').trim()),
    webhookUrl: String(env.WEBHOOK_URL || '').trim(),
    webhookSecret: String(env.WEBHOOK_SECRET || '').trim(),
    minDelayMs,
    maxDelayMs,
    maxPerMinute: integer(env, 'MAX_ENVIO_POR_MINUTO', 20, { min: 1, max: 1000 }),
    logLevel: String(env.LOG_LEVEL || 'info').trim()
  };
}
