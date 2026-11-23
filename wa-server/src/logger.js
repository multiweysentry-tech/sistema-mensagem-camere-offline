import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { servico: 'wa-server' },
    redact: {
      paths: ['req.headers.x-api-key', 'apiKey', 'webhookSecret'],
      remove: true
    }
  });
}
