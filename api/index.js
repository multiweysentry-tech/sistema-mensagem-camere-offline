// Ponto de entrada serverless para o Vercel.
// O servidor local continua sendo `npm start` (server.js).
const { createApp } = require('../server');
const db = require('../db');
const wa = require('../whatsapp');
const bots = require('../bots');

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
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
        erro: error.message,
        dica: 'Configure PG_HOST, PG_PORT, PG_USER, PG_PASSWORD e PG_DATABASE nas variaveis de ambiente da Vercel.'
      }));
    }
  }
};
