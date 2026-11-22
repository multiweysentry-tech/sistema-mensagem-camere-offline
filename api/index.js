// Ponto de entrada serverless para o Vercel.
// O servidor local continua sendo `npm start` (server.js).
let createApp;
let db;
let wa;
let bots;
let loadError = null;

// No Vercel, localhost aponta para a propria funcao e nunca alcanca o Postgres local.
const { isRemote: hasRemotePostgres } = require('../db-config');

const unavailable = feature =>
  new Error(`${feature} indisponível no Vercel: exige processo persistente. Use npm start em um servidor próprio.`);

function getBridgeUrl() {
  const value = String(process.env.WHATSAPP_BRIDGE_URL || '').trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value.replace(/\/+$/, '');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(9000)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { erro: text }; }
  if (!response.ok) {
    throw new Error(data.erro || data.error || `HTTP ${response.status}`);
  }
  return data;
}

try {
  ({ createApp } = require('../server'));

  // Sem Postgres remoto, usa armazenamento em memoria para nao retornar 500.
  db = hasRemotePostgres() ? require('../db') : require('../db-memory');

  const bridgeUrl = getBridgeUrl();
  const metaToken = String(process.env.META_WA_ACCESS_TOKEN || '').trim();
  const metaPhoneId = String(process.env.META_WA_PHONE_NUMBER_ID || '').trim();
  const metaEnabled = Boolean(metaToken && metaPhoneId);
  const waConfigured = Boolean(bridgeUrl || metaEnabled);

  wa = {
    setIO() {},
    getStatus: () => waConfigured
      ? { status: 'open', qr: null, phone: metaEnabled ? metaPhoneId : null, error: null }
      : { status: 'unsupported', qr: null, phone: null, error: 'WhatsApp não configurado no Vercel' },
    connect: async () => { throw unavailable('WhatsApp'); },
    disconnect: async () => { throw unavailable('WhatsApp'); },
    checkNumber: async phone => {
      const digits = normalizePhone(phone);
      if (!digits) throw new Error('Telefone inválido');
      return { phone: digits, exists: null, jid: `${digits}@s.whatsapp.net` };
    },
    sendMessage: async (to, text) => {
      const digits = normalizePhone(to);
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Telefone de destino inválido');

      if (bridgeUrl) {
        const result = await postJson(
          `${bridgeUrl}/api/whatsapp/send`,
          {
            'Content-Type': 'application/json',
            ...(process.env.WHATSAPP_BRIDGE_KEY
              ? { 'x-api-key': process.env.WHATSAPP_BRIDGE_KEY }
              : {})
          },
          { to: digits, text }
        );
        return result;
      }

      if (metaEnabled) {
        const result = await postJson(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(metaPhoneId)}/messages`,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${metaToken}`
          },
          {
            messaging_product: 'whatsapp',
            to: digits,
            type: 'text',
            text: { body: text }
          }
        );
        return { ok: true, id: result.messages?.[0]?.id || null };
      }

      throw unavailable('WhatsApp');
    }
  };
  bots = {
    getSchedulerStatus: () => 'unsupported',
    startSchedulers: async () => {},
    runBillingBot: async () => { throw unavailable('Bots'); },
    runMaintenanceBot: async () => { throw unavailable('Bots'); }
  };
} catch (error) {
  // Captura falhas de importacao para nao virar um FUNCTION_INVOCATION_FAILED opaco.
  loadError = error;
}

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      if (loadError) throw loadError;
      await db.init();
      return createApp({ db, wa, bots });
    })().catch(error => {
      appPromise = null; // permite nova tentativa na proxima invocacao
      throw error;
    });
  }
  return appPromise;
}

module.exports = async function handler(req, res) {
  try {
    const app = await getApp();
    return await app(req, res);
  } catch (error) {
    console.error('[Vercel] Falha ao iniciar a aplicacao:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        codigo: 'INIT_ERROR',
        erro: error.message || String(error),
        dica: 'Configure PG_HOST, PG_PORT, PG_USER, PG_PASSWORD e PG_DATABASE com um Postgres remoto para persistir os dados.'
      }));
    }
  }
};
