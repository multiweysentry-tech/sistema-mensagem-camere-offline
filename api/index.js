// Ponto de entrada serverless para o Vercel.
// O servidor local continua sendo `npm start` (server.js).
let createApp;
let db;
let wa;
let bots;
let loadError = null;

try {
  ({ createApp } = require('../server'));
  db = require('../db');
  wa = require('../whatsapp');
  bots = require('../bots');
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
      // No Vercel nao iniciamos agendadores nem conexao WhatsApp:
      // sao processos de longa duracao e exigem sistema de arquivos gravavel.
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
        dica: 'Configure PG_HOST, PG_PORT, PG_USER, PG_PASSWORD e PG_DATABASE nas variaveis de ambiente da Vercel.'
      }));
    }
  }
};
