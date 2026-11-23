import express from 'express';
import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { createConnection } from './src/state.js';
import { createSendQueue } from './src/queue.js';
import { createRoutes } from './src/routes.js';
import { buildOutgoing } from './src/messages.js';
import { enviarWebhook } from './src/webhook.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

function publicar(payload) {
  return enviarWebhook({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    payload,
    logger
  });
}

const connection = createConnection({
  sessionDir: config.sessionDir,
  logger,
  onEvent: payload => publicar(payload)
});

const queue = createSendQueue({
  logger,
  minDelayMs: config.minDelayMs,
  maxDelayMs: config.maxDelayMs,
  maxPerMinute: config.maxPerMinute,
  worker: async job => {
    try {
      const sock = connection.getSocket();
      if (job.opcoes?.length >= 2 && !sock.user?.id) {
        throw new Error('Sessão do WhatsApp sem identificador do remetente');
      }
      const mensagem = buildOutgoing({
        jid: job.jid,
        texto: job.texto,
        opcoes: job.opcoes,
        rodape: job.rodape,
        id: job.id,
        userJid: sock.user?.id
      });
      if (mensagem.tipo === 'botoes') {
        await sock.relayMessage(job.jid, mensagem.conteudo, mensagem.opcoesEnvio);
      } else {
        await sock.sendMessage(job.jid, mensagem.conteudo, mensagem.opcoesEnvio);
      }
      logger.info({
        event: 'send.ok',
        id: job.id,
        queueId: job.queueId,
        destino: job.destinoMascarado,
        tipo: mensagem.tipo
      });
      await publicar({
        tipo: 'status',
        id: job.id,
        status: 'enviada',
        jid: job.jid,
        timestamp: new Date().toISOString(),
        metadata: job.metadata
      });
      return { ok: true, id: job.id, queueId: job.queueId };
    } catch (error) {
      logger.error({
        event: 'send.failed',
        id: job.id,
        queueId: job.queueId,
        destino: job.destinoMascarado,
        erro: error.message
      });
      await publicar({
        tipo: 'status',
        id: job.id,
        status: 'erro',
        motivo: String(error.message || error).slice(0, 500),
        jid: job.jid,
        timestamp: new Date().toISOString(),
        metadata: job.metadata
      });
      throw error;
    }
  }
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/', createRoutes({ config, logger, connection, queue, enviarWebhook: publicar }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  logger.error({ event: 'http.error', rota: req.path, erro: error.message });
  return res.status(500).json({ erro: 'Erro interno do servidor' });
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ event: 'server.listen', host: config.host, port: config.port });
  connection.start();
});

function encerrar() {
  logger.info({ event: 'server.shutdown' });
  connection.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
