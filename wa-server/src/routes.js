import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeSendNumber, maskNumber } from './phone.js';
import { buildOutgoing } from './messages.js';

function erro(status, mensagem, codigo) {
  const error = new Error(mensagem);
  error.status = status;
  error.codigo = codigo;
  return error;
}

// Comparação em tempo constante mesmo quando os tamanhos diferem: compara hashes.
export function chaveValida(recebida, esperada) {
  const a = createHash('sha256').update(String(recebida || '')).digest();
  const b = createHash('sha256').update(String(esperada || '')).digest();
  return timingSafeEqual(a, b);
}

function validarTexto(texto) {
  if (typeof texto !== 'string' || !texto.trim() || texto.length > 4096) {
    throw erro(400, 'Informe um texto de até 4096 caracteres', 'VALIDATION_ERROR');
  }
  return texto.trim();
}

function validarOpcoes(opcoes) {
  if (opcoes === undefined || opcoes === null) return [];
  if (!Array.isArray(opcoes) || opcoes.length < 2 || opcoes.length > 3) {
    throw erro(400, 'Informe de 2 a 3 opções clicáveis', 'VALIDATION_ERROR');
  }
  return opcoes.map((opcao, index) => ({
    id: String(opcao?.id || `op_${index + 1}`).slice(0, 40),
    text: String(opcao?.text || '').trim().slice(0, 20)
  })).filter(opcao => opcao.text);
}

function sanitizarMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return {
    tenantId: String(metadata.tenantId || 'default').slice(0, 80),
    instanceId: String(metadata.instanceId || 'default').slice(0, 80),
    cameraIds: Array.isArray(metadata.cameraIds)
      ? metadata.cameraIds.slice(0, 50).map(id => String(id).slice(0, 120))
      : []
  };
}

export function createRoutes({ config, logger, connection, queue, enviarWebhook }) {
  const router = express.Router();

  router.use((req, res, next) => {
    const recebida = req.get('x-api-key');
    if (!recebida || !chaveValida(recebida, config.apiKey)) {
      logger.warn({ event: 'auth.rejected', rota: req.path, ip: req.ip });
      return res.status(401).json({ erro: 'Não autorizado' });
    }
    return next();
  });

  router.get('/status', (req, res) => res.json({ status: connection.getStatus() }));

  router.get('/info', (req, res) => res.json({
    ...connection.getInfo(),
    fila: queue.pending(),
    processandoFila: queue.processando
  }));

  router.get('/qr', (req, res) => {
    const qr = connection.getQR();
    const querJson = req.get('accept')?.includes('application/json') || req.query.json === '1';
    if (querJson) {
      return res.json({ status: connection.getStatus(), qr });
    }
    const imagem = qr
      ? `<img src="${String(qr).replace(/"/g, '&quot;')}" alt="QR Code do WhatsApp" style="width:320px">`
      : '<p>Aguardando o QR Code. Recarregue esta página em instantes.</p>';
    return res.type('html').send(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="15"><title>QR Code WhatsApp – Multiwey Sentry</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:24px">
      <h1>QR Code do WhatsApp</h1>${imagem}<p>Escaneie com o WhatsApp do chip dedicado.</p>
      <p><small>Status: ${connection.getStatus()}</small></p></body></html>`);
  });

  router.post('/verificar', async (req, res, next) => {
    try {
      if (connection.getStatus() !== 'conectado') throw erro(503, 'WhatsApp desconectado', 'WA_DESCONECTADO');
      const numero = normalizeSendNumber(req.body?.numero);
      if (!numero) throw erro(400, 'Número inválido: informe DDI + DDD + número', 'VALIDATION_ERROR');
      const jid = await connection.findOnWhatsApp(numero);
      logger.info({ event: 'number.checked', destino: maskNumber(numero), existe: true });
      return res.json({ ok: true, existe: true, numero, jid });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/enviar', async (req, res, next) => {
    try {
      const texto = validarTexto(req.body?.texto);
      const opcoes = validarOpcoes(req.body?.opcoes);
      const rodape = req.body?.rodape === undefined ? undefined : String(req.body.rodape).slice(0, 60);
      const metadata = sanitizarMetadata(req.body?.metadata);
      if (connection.getStatus() !== 'conectado') throw erro(503, 'WhatsApp desconectado', 'WA_DESCONECTADO');

      const numero = normalizeSendNumber(req.body?.numero);
      if (!numero) throw erro(400, 'Número inválido: informe DDI + DDD + número', 'VALIDATION_ERROR');
      const jid = await connection.findOnWhatsApp(numero);
      const id = `sentry_${randomUUID()}`;
      connection.track(id, metadata, jid);

      const job = {
        id,
        jid,
        numero,
        texto,
        opcoes,
        rodape,
        metadata,
        destinoMascarado: maskNumber(numero)
      };
      const { queueId } = queue.enqueue(job);
      return res.status(202).json({
        ok: true,
        id,
        queueId,
        status: 'pendente',
        numero,
        jid
      });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
    if (status >= 500) logger.error({ event: 'route.error', rota: req.path, erro: error.message });
    return res.status(status).json({
      erro: status === 500 ? 'Erro interno do servidor' : error.message,
      ...(error.codigo ? { codigo: error.codigo } : {})
    });
  });

  // Exported only for unit tests of the interactive message builder.
  router.buildOutgoing = buildOutgoing;
  return router;
}
