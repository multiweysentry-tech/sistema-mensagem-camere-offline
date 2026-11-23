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
  const missingWhatsAppConfiguration = () => {
    return new Error('A Vercel não mantém uma sessão WhatsApp via QR. Para usar seu WhatsApp e os bots, abra http://127.0.0.1:3000/#offline no computador onde o servidor persistente está rodando.');
  };

  wa = {
    setIO() {},
    getStatus: () => waConfigured
      ? {
          status: 'configured',
          qr: null,
          phone: null,
          error: 'API configurada; este painel serverless nao confirma conexao nem entrega.'
        }
      : { status: 'unsupported', qr: null, phone: null, error: missingWhatsAppConfiguration().message },
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

      throw missingWhatsAppConfiguration();
    },
    sendButtons: async (to, text, buttons, footer) => {
      const digits = normalizePhone(to);
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Telefone de destino inválido');
      const options = Array.isArray(buttons) ? buttons.slice(0, 3) : [];
      if (options.length < 2) throw new Error('Informe ao menos duas opções clicáveis');

      if (bridgeUrl) {
        return postJson(
          `${bridgeUrl}/api/whatsapp/send-options`,
          {
            'Content-Type': 'application/json',
            ...(process.env.WHATSAPP_BRIDGE_KEY
              ? { 'x-api-key': process.env.WHATSAPP_BRIDGE_KEY }
              : {})
          },
          { to: digits, text, buttons: options, footer }
        );
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
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text },
              ...(footer ? { footer: { text: String(footer).slice(0, 60) } } : {}),
              action: {
                buttons: options.map((button, index) => ({
                  type: 'reply',
                  reply: {
                    id: String(button?.id || `op_${index + 1}`),
                    title: String(button?.text || '').slice(0, 20)
                  }
                }))
              }
            }
          }
        );
        // A Cloud API responde com o id da mensagem aceita; nao ha receipt local
        // para aguardar. "unconfirmed" fica restrito ao timeout do Baileys.
        return { ok: true, id: result.messages?.[0]?.id || null, deliveryStatus: 'sent' };
      }

      throw missingWhatsAppConfiguration();
    },
    sendWithOptions: (to, text, buttons, footer) => wa.sendButtons(to, text, buttons, footer)
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
