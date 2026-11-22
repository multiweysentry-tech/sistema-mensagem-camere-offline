// Ponto de entrada serverless para o Vercel.
// O servidor local continua sendo `npm start` (server.js).
let createApp;
let db;
let wa;
let bots;
let loadError = null;

// No Vercel, localhost aponta para a propria funcao e nunca alcanca o Postgres local.
function hasRemotePostgres() {
  const host = String(process.env.PG_HOST || '').trim();
  if (!host || !process.env.PG_PASSWORD) return false;
  return !/^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(host);
}

const unavailable = feature =>
  new Error(`${feature} indisponível no Vercel: exige processo persistente. Use npm start em um servidor próprio.`);

try {
  ({ createApp } = require('../server'));

  // Sem Postgres remoto, usa armazenamento em memoria para nao retornar 500.
  db = hasRemotePostgres() ? require('../db') : require('../db-memory');

  // Nao carregar whatsapp.js/bots.js no Vercel: o Baileys e ESM e o runtime do Vercel
  // nao suporta require() de ESM, alem de exigir sistema de arquivos gravavel.
  wa = {
    setIO() {},
    getStatus: () => ({ status: 'unsupported', qr: null, phone: null, error: 'Indisponível no Vercel' }),
    connect: async () => { throw unavailable('WhatsApp'); },
    disconnect: async () => { throw unavailable('WhatsApp'); },
    sendMessage: async () => { throw unavailable('WhatsApp'); }
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
