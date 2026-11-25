// Ponto de entrada serverless para o Vercel.
// O servidor local continua sendo `npm start` (server.js).
let createApp;
let db;
let wa;
let bots;
let loadError = null;

// No Vercel, localhost aponta para a propria funcao e nunca alcanca o Postgres local.
const { isRemote: hasRemotePostgres } = require('../db-config');

const { normalizarContato } = require('../phone-utils');
const { OPTION_BUTTONS } = require('../wa-options');
const whatsappRemoto = require('../lib/whatsapp');
const { createMetaWhatsapp } = require('../lib/meta-whatsapp');
const { createDatafyWhatsapp } = require('../lib/datafy-whatsapp');

const unavailable = feature =>
  new Error(`${feature} indisponível no Vercel: exige processo persistente. Use npm start em um servidor próprio.`);

function getBridgeUrl() {
  const value = String(process.env.WHATSAPP_BRIDGE_URL || '').trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value.replace(/\/+$/, '');
}

function normalizePhone(value) {
  return normalizarContato(value);
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
  const requestedProvider = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (!['', 'meta', 'datafy', 'baileys'].includes(requestedProvider)) {
    throw new Error('WHATSAPP_PROVIDER deve ser "meta", "datafy" ou "baileys" no deploy Vercel');
  }
  if (requestedProvider === 'meta' && !metaEnabled) {
    throw new Error('WHATSAPP_PROVIDER=meta exige META_WA_ACCESS_TOKEN e META_WA_PHONE_NUMBER_ID');
  }
  const metaWa = requestedProvider === 'meta' || (!requestedProvider && !whatsappRemoto.isRemoteConfigured() && !bridgeUrl && metaEnabled)
    ? createMetaWhatsapp({ db })
    : null;
  const datafyWa = requestedProvider === 'datafy' ? createDatafyWhatsapp({ db }) : null;
  const cloudWa = metaWa || datafyWa;
  if (metaWa && (!metaWa.webhookConfig.secret || !metaWa.webhookConfig.verifyToken)) {
    throw new Error('WhatsApp Meta no Vercel exige META_WA_APP_SECRET e META_WA_VERIFY_TOKEN para validar o webhook');
  }
  if (datafyWa && !datafyWa.webhookConfig.secret) {
    throw new Error('WhatsApp Datafy no Vercel exige DATAFY_WA_WEBHOOK_SECRET para validar eventos de entrega');
  }
  const remoto = cloudWa ? null : whatsappRemoto.isRemoteConfigured() ? whatsappRemoto.createRemoteWhatsapp() : null;
  const activeBridgeUrl = cloudWa ? null : bridgeUrl;
  const waConfigured = Boolean(remoto || activeBridgeUrl || cloudWa);
  const missingWhatsAppConfiguration = () => {
    return new Error('A Vercel não mantém uma sessão WhatsApp via QR. Para usar seu WhatsApp e os bots, abra http://127.0.0.1:3000/#offline no computador onde o servidor persistente está rodando.');
  };

  wa = {
    provider: cloudWa?.provider,
    remote: Boolean(cloudWa),
    webhookConfig: cloudWa?.webhookConfig,
    describeAccount: cloudWa?.describeAccount ? () => cloudWa.describeAccount() : undefined,
    setIO(socketServer) { cloudWa?.setIO(socketServer); },
    getStatus: () => cloudWa
      ? cloudWa.getStatus()
      : waConfigured
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
    sendMessage: async (to, text, metadata) => {
      const digits = normalizePhone(to);
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Telefone de destino inválido');

      if (activeBridgeUrl) {
        const result = await postJson(
          `${activeBridgeUrl}/api/whatsapp/send`,
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

      if (cloudWa) return cloudWa.sendMessage(digits, text, metadata);

      throw missingWhatsAppConfiguration();
    },
    sendButtons: async (to, text, buttons, footer, metadata) => {
      const digits = normalizePhone(to);
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Telefone de destino inválido');
      const options = buttons === undefined
        ? OPTION_BUTTONS
        : Array.isArray(buttons) ? buttons.slice(0, 3) : [];
      if (options.length < 2) throw new Error('Informe ao menos duas opções clicáveis');

      if (activeBridgeUrl) {
        return postJson(
          `${activeBridgeUrl}/api/whatsapp/send-options`,
          {
            'Content-Type': 'application/json',
            ...(process.env.WHATSAPP_BRIDGE_KEY
              ? { 'x-api-key': process.env.WHATSAPP_BRIDGE_KEY }
              : {})
          },
          { to: digits, text, buttons: options, footer }
        );
      }

      if (cloudWa) return cloudWa.sendWithOptions(digits, text, options, footer, metadata);

      throw missingWhatsAppConfiguration();
    },
    sendWithOptions: (to, text, buttons, footer, metadata) =>
      wa.sendButtons(to, text, buttons, footer, metadata)
  };

  if (remoto) {
    // Ordem de preferência: servidor Baileys persistente > ponte legada > Meta.
    wa.remote = true;
    wa.getStatus = () => remoto.getStatus();
    wa.checkNumber = phone => remoto.checkNumber(phone);
    wa.sendMessage = (to, text, metadata) => remoto.sendMessage(to, text, metadata);
    wa.sendButtons = (to, text, buttons, footer, metadata) => remoto.sendButtons(to, text, buttons, footer, metadata);
    wa.sendWithOptions = (to, text, buttons, footer, metadata) => remoto.sendWithOptions(to, text, buttons, footer, metadata);
  }

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
