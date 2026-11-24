const { createMetaWhatsapp } = require('./meta-whatsapp');
const { datafySignatureIsValid } = require('./meta-webhook');

const DATAFY_API_BASE = 'https://cloud.datafyapi.com.br';
const DATAFY_MESSAGES_BASE = `${DATAFY_API_BASE}/v1`;

function isConfigured(env = process.env) {
  return Boolean(String(env.DATAFY_WA_ACCESS_TOKEN || '').trim());
}

function createDatafyWhatsapp(options = {}) {
  const env = options.env || process.env;
  const accessToken = String(options.accessToken || env.DATAFY_WA_ACCESS_TOKEN || '').trim();
  const phoneNumberId = String(options.phoneNumberId || env.DATAFY_WA_PHONE_NUMBER_ID || '').trim();
  const webhookSecret = String(options.webhookSecret || env.DATAFY_WA_WEBHOOK_SECRET || '').trim();
  const tenantId = String(options.tenantId || env.DATAFY_WA_TENANT_ID || 'default').trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!accessToken) throw new Error('DATAFY_WA_ACCESS_TOKEN é obrigatório para WHATSAPP_PROVIDER=datafy');
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível neste runtime');

  let phoneNumberIdPromise = null;
  async function resolvePhoneNumberId() {
    if (phoneNumberId) return phoneNumberId;
    if (!phoneNumberIdPromise) {
      phoneNumberIdPromise = (async () => {
        const response = await fetchImpl(`${DATAFY_API_BASE}/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(Number(env.DATAFY_WA_TIMEOUT_MS || (env.VERCEL ? 7000 : 15000)))
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.message || body.error?.message || `Datafy API /me: HTTP ${response.status}`);
        }
        if (!body.phone_number_id) throw new Error('Datafy API /me não retornou phone_number_id');
        return String(body.phone_number_id);
      })().catch(error => {
        phoneNumberIdPromise = null;
        throw error;
      });
    }
    return phoneNumberIdPromise;
  }

  const whatsapp = createMetaWhatsapp({
    env: {
      ...env,
      META_WA_ACCESS_TOKEN: accessToken,
      META_WA_PHONE_NUMBER_ID: phoneNumberId,
      META_WA_APP_SECRET: '',
      META_WA_VERIFY_TOKEN: '',
      META_WA_TEMPLATE_NAME: env.DATAFY_WA_TEMPLATE_NAME || env.META_WA_TEMPLATE_NAME || '',
      META_WA_TEMPLATE_LANGUAGE: env.DATAFY_WA_TEMPLATE_LANGUAGE || env.META_WA_TEMPLATE_LANGUAGE || 'pt_BR'
    },
    accessToken,
    phoneNumberId,
    resolvePhoneNumberId,
    apiBaseUrl: DATAFY_MESSAGES_BASE,
    provider: 'datafy',
    db: options.db,
    fetch: fetchImpl,
    timeoutMs: Number(env.DATAFY_WA_TIMEOUT_MS || (env.VERCEL ? 7000 : 15000))
  });

  const originalGetStatus = whatsapp.getStatus;
  return {
    ...whatsapp,
    webhookConfig: {
      route: '/api/whatsapp/datafy/webhook',
      secret: webhookSecret,
      verifyToken: '',
      phoneNumberId,
      tenantId,
      signatureValidator: (body, req) => datafySignatureIsValid(
        body,
        req.get('x-datafy-signature-256'),
        req.get('x-datafy-timestamp'),
        webhookSecret
      )
    },
    async getStatus() {
      if (phoneNumberId) return originalGetStatus();
      await resolvePhoneNumberId();
      return originalGetStatus();
    }
  };
}

module.exports = { createDatafyWhatsapp, isConfigured, DATAFY_API_BASE, DATAFY_MESSAGES_BASE };
