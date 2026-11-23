import { createHmac } from 'node:crypto';

export function assinar(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export async function enviarWebhook({ url, secret, payload, logger, tentativas = 2 }) {
  if (!url || !secret) {
    logger.warn({ event: 'webhook.not_configured', url: Boolean(url), secret: Boolean(secret) });
    return false;
  }
  const raw = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'x-webhook-signature': assinar(raw, secret)
  };
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) {
        logger.info({ event: 'webhook.ok', tipo: payload.tipo, id: payload.id || null });
        return true;
      }
      logger.warn({ event: 'webhook.http_error', tipo: payload.tipo, status: response.status, tentativa });
    } catch (error) {
      logger.warn({ event: 'webhook.error', tipo: payload.tipo, erro: error.message, tentativa });
    }
    if (tentativa < tentativas) await new Promise(resolve => setTimeout(resolve, 500 * tentativa));
  }
  return false;
}
