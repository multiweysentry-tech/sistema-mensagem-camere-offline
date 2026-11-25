// Load .env
const fs = require('fs');
const path = require('path');
const { normalizarContato, telefoneBrasileiroValido, chaveComparacaoTelefone } = require('./phone-utils');
const whatsappRemoto = require('./lib/whatsapp');
const { registerWebhook } = require('./lib/webhook');
const { registerMetaWebhook } = require('./lib/meta-webhook');
const envPath = path.join(__dirname, '.env');
if (!process.env.VERCEL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// No Vercel (serverless) nao ha processo persistente nem sistema de arquivos gravavel.
const SERVERLESS = Boolean(process.env.VERCEL);

const CAMERA_STATUSES = [
  'Pendente',
  'Aguardando resposta',
  'Verificando',
  'Suporte',
  'Aguardando validacao',
  'Resolvido'
];
const CAMERA_FIELDS = new Set([
  'camera_nome',
  'local',
  'responsavel_nome',
  'responsavel_telefone',
  'email',
  'status',
  'tentativas',
  'ultima_cobranca',
  'data_resolucao',
  'observacoes'
]);

function normalizePhone(value) {
  return normalizarContato(value);
}

function validPhone(value) {
  return /^\d{10,15}$/.test(normalizePhone(value));
}

// Cadastro so aceita numeros brasileiros com DDD valido.
function validCadastroPhone(value) {
  return telefoneBrasileiroValido(value);
}

// Chave usada para cruzar o JID do WhatsApp com o cadastro, tolerando a
// ausencia do 9º digito.
function conversationKey(value) {
  return chaveComparacaoTelefone(value) || normalizePhone(value);
}

function validateCamera(camera, partial = false) {
  const errors = [];
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) {
    return ['payload invalido'];
  }
  if (!partial && (!camera.id || !String(camera.id).trim())) errors.push('id obrigatorio');
  if (!partial && (!camera.camera_nome || !String(camera.camera_nome).trim())) errors.push('camera_nome obrigatorio');
  if (!partial && (!camera.responsavel_nome || !String(camera.responsavel_nome).trim())) errors.push('responsavel_nome obrigatorio');
  if (!partial && !validCadastroPhone(camera.responsavel_telefone)) errors.push('responsavel_telefone invalido');
  if (Object.prototype.hasOwnProperty.call(camera, 'responsavel_telefone') &&
      !validCadastroPhone(camera.responsavel_telefone)) errors.push('responsavel_telefone invalido');
  if (camera.status !== undefined && !CAMERA_STATUSES.includes(camera.status)) errors.push('status invalido');
  if (camera.tentativas !== undefined &&
      (camera.tentativas === '' || !Number.isInteger(Number(camera.tentativas)) || Number(camera.tentativas) < 0)) {
    errors.push('tentativas invalido');
  }
  return errors;
}

function createApp(options = {}) {
  const db = options.db || require('./db');
  const wa = options.wa || (whatsappRemoto.isRemoteConfigured()
    ? whatsappRemoto.createRemoteWhatsapp()
    : require('./whatsapp'));
  const bots = options.bots || require('./bots');
  const auth = options.auth || null;
  const sessionManager = options.sessionManager || null;
  const nocWatcher = options.nocWatcher || null;
  const app = express();
  const whatsappSendsInProgress = new Set();
  const nocStorage = require('./lib/noc-storage');
  const server = http.createServer(app);
  const io = new Server(server);

  if (sessionManager) sessionManager.setIO(io);
  else wa.setIO(io);

  io.on('connection', async socket => {
    try {
      const identity = auth
        ? await auth.socketAuthorize(socket)
        : { tenantId: options.tenantId || 'default' };
      socket.join(`tenant:${identity.tenantId}`);
      if (sessionManager) {
        socket.emit('wa:status', sessionManager.list(identity.tenantId));
      } else {
        socket.emit('wa:status', await wa.getStatus());
      }
    } catch (error) {
      socket.emit('wa:error', { erro: 'Nao autorizado' });
      socket.disconnect(true);
    }
  });

  // Resolve a instancia WhatsApp da requisicao, isolada por tenant.
  function instanceFor(req) {
    const instanceId = String(req.body?.instanceId || req.query?.instanceId || 'default');
    if (wa.remote) return wa;
    if (sessionManager) return sessionManager.getOrCreate(req.tenantId || 'default', instanceId);
    return wa;
  }

  // Webhook precisa do corpo bruto para validar o HMAC e não pode passar pelo login.
  const { log: logEvent } = require('./logger');
  const logWebhook = {
    info: fields => logEvent('info', 'webhook', fields),
    warn: fields => logEvent('warn', 'webhook', fields),
    error: fields => logEvent('error', 'webhook', fields)
  };
  registerWebhook(app, {
    db,
    secret: String(process.env.WEBHOOK_SECRET || '').trim(),
    logger: logWebhook,
    timeoutMinutes: Number(process.env.WA_CONFIRM_TIMEOUT_MINUTES || 15)
  });
  if (wa.provider === 'meta' || wa.provider === 'datafy') {
    registerMetaWebhook(app, {
      db,
      bots,
      ...wa.webhookConfig,
      route: wa.webhookConfig.route,
      signatureValidator: wa.webhookConfig.signatureValidator,
      providerName: wa.provider === 'datafy' ? 'Datafy' : 'Meta',
      enableHandshake: wa.provider === 'meta',
      logger: logWebhook
    });
  }

  async function registrarEnvioRemoto(req, resultado, texto) {
    if (!resultado?.remote || !db.registerDelivery) return;
    const tenantId = req.tenantId || 'default';
    const instanceId = String(req.body?.instanceId || 'default');
    const agora = new Date().toISOString();
    const jid = resultado.jid;
    const cameraIds = Array.isArray(req.body?.cameraIds)
      ? req.body.cameraIds.slice(0, 50).map(String)
      : [];
    if (db.upsertConversation) {
      await db.upsertConversation(jid, resultado.numero || normalizePhone(req.body?.to), String(texto).slice(0, 200), agora, tenantId, instanceId);
    }
    if (db.addMessage) {
      await db.addMessage(jid, {
        id: resultado.id,
        from: jid,
        text: texto,
        time: agora,
        direction: 'out',
        status: 'pendente'
      }, tenantId, instanceId);
    }
    await db.registerDelivery({
      id: resultado.id,
      tenantId,
      instanceId,
      jid,
      cameraIds,
      texto: String(texto).slice(0, 4096),
      status: 'pendente',
      createdAt: agora
    }, tenantId);
  }

  const jsonParserDefault = express.json({ limit: '1mb' });
  const jsonParserLarge = express.json({ limit: '15mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/import/pdf/scan' || req.path === '/api/noc/arquivos') return jsonParserLarge(req, res, next);
    return jsonParserDefault(req, res, next);
  });
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/logo-sentry.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-sentry.png')));
  app.get('/phone-utils.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=0');
    return res.sendFile(path.join(__dirname, 'phone-utils.js'));
  });
  const painelNocDir = fs.existsSync(path.join(__dirname, 'PAINEL NOC - CAMERAS OFFLINE'))
    ? path.join(__dirname, 'PAINEL NOC - CAMERAS OFFLINE')
    : path.join(__dirname, 'painel-noc');
  app.use('/painel-noc', express.static(painelNocDir));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ codigo: 'INVALID_JSON', erro: 'JSON invalido' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ codigo: 'PAYLOAD_TOO_LARGE', erro: 'Corpo da requisicao muito grande' });
    }
    next(err);
  });

  if (auth) {
    app.use('/api', (req, res, next) => {
      req.tenantId = req.user?.tenantId || options.tenantId || 'default';
      next();
    });
    app.use('/api', auth.middleware);
    auth.registerRoutes(app);
  } else {
    const apiKey = options.apiKey ?? process.env.API_KEY;
    app.use('/api', (req, res, next) => {
      req.tenantId = options.tenantId || 'default';
      if (!apiKey || req.get('x-api-key') === apiKey) return next();
      return res.status(401).json({ codigo: 'UNAUTHORIZED', erro: 'Nao autorizado' });
    });
    // Modo desenvolvimento sem ADMIN_*: o painel permanece aberto e informa
    // ao frontend que nao ha autenticacao obrigatoria.
    app.get('/api/auth/me', (req, res) => res.json({ user: null, required: false }));
    app.post('/api/auth/login', (req, res) => res.status(400).json({ codigo: 'AUTH_DISABLED', erro: 'Autenticacao nao configurada neste servidor' }));
    app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));
  }

  app.get('/api/health', async (req, res) => {
    try {
      const cameras = await db.getCameras(req.tenantId);
      const body = { status: 'ok', cameras: cameras.length };
      if (db.mode) body.storage = db.mode;
      res.json(body);
    } catch (error) {
      res.status(500).json({ status: 'error', erro: error.message });
    }
  });

  app.get('/api/cameras', async (req, res) => {
    try {
      let list = await db.getCameras(req.tenantId);
      const { status, responsavel, q } = req.query;
      if (status) list = list.filter(camera => String(camera.status) === String(status));
      if (responsavel) {
        const search = String(responsavel).toLocaleLowerCase('pt-BR');
        list = list.filter(camera => String(camera.responsavel_nome || '').toLocaleLowerCase('pt-BR').includes(search));
      }
      if (q) {
        const search = String(q).toLocaleLowerCase('pt-BR');
        list = list.filter(camera => JSON.stringify(camera).toLocaleLowerCase('pt-BR').includes(search));
      }
      res.json(list);
    } catch (error) {
      res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/cameras/:id', async (req, res) => {
    try {
      const camera = (await db.getCameras(req.tenantId)).find(item => String(item.id) === req.params.id);
      if (!camera) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Camera nao encontrada' });
      return res.json(camera);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/cameras', async (req, res) => {
    const errors = validateCamera(req.body);
    if (errors.length) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erros: errors });
    try {
      const normalizedId = String(req.body.id).trim();
      const list = await db.getCameras(req.tenantId);
      const exists = list.some(camera => String(camera.id) === normalizedId);
      await db.upsertCamera({
        ...req.body,
        id: normalizedId,
        responsavel_telefone: normalizePhone(req.body.responsavel_telefone),
        status: req.body.status || 'Pendente',
        tentativas: req.body.tentativas === undefined ? 0 : Number(req.body.tentativas),
        local: req.body.local || '',
        email: req.body.email || '',
        ultima_cobranca: req.body.ultima_cobranca || '',
        data_resolucao: req.body.data_resolucao || '',
        observacoes: req.body.observacoes || ''
      }, req.tenantId);
      await db.ensureConsent(normalizePhone(req.body.responsavel_telefone), req.tenantId);
      const camera = (await db.getCameras(req.tenantId)).find(item => String(item.id) === normalizedId);
      return res.status(exists ? 200 : 201).json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.put('/api/cameras/:id', async (req, res) => {
    const existing = (await db.getCameras(req.tenantId)).find(camera => String(camera.id) === req.params.id);
    if (!existing) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Camera nao encontrada' });
    const fields = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => CAMERA_FIELDS.has(key))
    );
    const errors = validateCamera(fields, true);
    if (errors.length) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erros: errors });
    if (Object.prototype.hasOwnProperty.call(fields, 'responsavel_telefone')) {
      fields.responsavel_telefone = normalizePhone(fields.responsavel_telefone);
    }
    try {
      await db.updateCamera(req.params.id, fields, req.tenantId);
      const camera = (await db.getCameras(req.tenantId)).find(item => String(item.id) === req.params.id);
      return res.json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.delete('/api/cameras/:id', async (req, res) => {
    try {
      const camera = (await db.getCameras(req.tenantId)).find(item => String(item.id) === req.params.id);
      if (!camera) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Camera nao encontrada' });
      await db.deleteCamera(req.params.id, req.tenantId);
      return res.json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/log', async (req, res) => {
    try {
      let list = await db.getLog(req.tenantId);
      const { acao, camera_id: cameraId, limit } = req.query;
      if (acao) list = list.filter(entry => String(entry.acao) === String(acao));
      if (cameraId) list = list.filter(entry => String(entry.camera_id || '').split(',').includes(String(cameraId)));
      const max = limit === undefined ? 100 : Number(limit);
      if (!Number.isInteger(max) || max < 1) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'limit deve ser um inteiro positivo' });
      }
      return res.json(list.slice(0, Math.min(max, 500)));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/log', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Registro de log invalido' });
    }
    try {
      const entry = {
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString(),
        acao: String(req.body.acao || '').trim()
      };
      if (!entry.acao) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'acao obrigatoria' });
      await db.addLog(entry, req.tenantId);
      return res.status(201).json({ log: entry });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/whatsapp/status', async (req, res) => {
    try {
      const status = await instanceFor(req).getStatus();
      if (!sessionManager || wa.remote) return res.json(status);
      return res.json({ ...status, instances: sessionManager.list(req.tenantId) });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_STATUS_FAILED', erro: error.message });
    }
  });

  // Status real de cada alerta. O timeout é calculado na leitura para funcionar
  // também no Vercel, onde não existe processo em background.
  app.get('/api/whatsapp/delivery', async (req, res) => {
    const timeoutMinutos = Number(process.env.WA_CONFIRM_TIMEOUT_MINUTES || 15);
    try {
      if (!db.getDeliveries) return res.json({ entregas: [], timeoutMinutos });
      const entregas = (await db.getDeliveries([], req.tenantId)).map(entrega => {
        const idadeMinutos = (Date.now() - Date.parse(entrega.createdAt || '')) / 60000;
        const aguardando = ['pendente', 'enviada'].includes(entrega.status);
        return {
          ...entrega,
          expirado: aguardando && idadeMinutos > timeoutMinutos,
          statusExibido: aguardando && idadeMinutos > timeoutMinutos ? 'sem_confirmacao' : entrega.status
        };
      });
      return res.json({ entregas, timeoutMinutos });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/whatsapp/connect', async (req, res) => {
    try {
      const instance = instanceFor(req);
      await instance.connect();
      return res.json({ ok: true, status: instance.getStatus() });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_CONNECT_FAILED', erro: error.message });
    }
  });
  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      // Desconexao manual preserva as credenciais por padrao.
      await instanceFor(req).disconnect({ logout: req.body?.logout === true });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/whatsapp/qr', async (req, res) => {
    try {
      const instance = instanceFor(req);
      await instance.refreshQR();
      return res.json({ ok: true, status: instance.getStatus() });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_QR_FAILED', erro: error.message });
    }
  });
  app.post('/api/whatsapp/send', async (req, res) => {
    const { to, text } = req.body || {};
    if (!validPhone(to) ||
        typeof text !== 'string' || !text.trim() || text.length > 4096) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um telefone e uma mensagem valida (ate 4096 caracteres)' });
    }
    const metadata = {
      tenantId: req.tenantId || 'default',
      instanceId: String(req.body?.instanceId || 'default'),
      cameraIds: Array.isArray(req.body?.cameraIds) ? req.body.cameraIds.slice(0, 50).map(String) : []
    };
    try {
      const result = await instanceFor(req).sendMessage(String(to), text.trim(), metadata);
      await registrarEnvioRemoto(req, result, text.trim());
      return res.status(result.deliveryStatus === 'pendente' ? 202 : 200).json(result);
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_SEND_FAILED', erro: error.message });
    }
  });
  app.post('/api/whatsapp/send-options', async (req, res) => {
    const { to, text, buttons, footer } = req.body || {};
    if (!validPhone(to) ||
        typeof text !== 'string' || !text.trim() || text.length > 4096) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um telefone e uma mensagem valida (ate 4096 caracteres)' });
    }
    if (buttons !== undefined && (!Array.isArray(buttons) || buttons.length < 2 || buttons.length > 3)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe de 2 a 3 botoes' });
    }
    const phone = normalizePhone(to);
    try {
      if (await db.isBlocked(phone, req.tenantId)) {
        return res.status(403).json({ codigo: 'CONTACT_BLOCKED', erro: 'Contato bloqueado para mensagens' });
      }
      if (!(await db.hasConsent(phone, req.tenantId))) {
        return res.status(403).json({ codigo: 'CONSENT_REQUIRED', erro: 'Contato sem consentimento registrado' });
      }
    } catch (error) {
      return res.status(500).json({ codigo: 'CONSENT_CHECK_FAILED', erro: error.message });
    }
    const sendKey = `${req.tenantId || 'default'}::${req.body?.instanceId || 'default'}::${phone}`;
    if (whatsappSendsInProgress.has(sendKey)) {
      return res.status(409).json({
        codigo: 'WHATSAPP_SEND_IN_PROGRESS',
        erro: 'Ja existe um envio em andamento para este contato'
      });
    }
    whatsappSendsInProgress.add(sendKey);
    const metadata = {
      tenantId: req.tenantId || 'default',
      instanceId: String(req.body?.instanceId || 'default'),
      cameraIds: Array.isArray(req.body?.cameraIds) ? req.body.cameraIds.slice(0, 50).map(String) : []
    };
    try {
      const result = await instanceFor(req).sendWithOptions(String(to), text.trim(), buttons, footer, metadata);
      await registrarEnvioRemoto(req, result, text.trim());
      return res.status(['unconfirmed', 'pendente'].includes(result.deliveryStatus) ? 202 : 200).json(result);
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_SEND_FAILED', erro: error.message });
    } finally {
      whatsappSendsInProgress.delete(sendKey);
    }
  });
  app.get('/api/whatsapp/check/:phone', async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!validCadastroPhone(phone)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    }
    try {
      return res.json(await instanceFor(req).checkNumber(phone));
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_CHECK_FAILED', erro: error.message });
    }
  });
  app.get('/api/whatsapp/conversations', async (req, res) => {
    try {
      let list = await db.getConversations(req.tenantId);
      const q = req.query.q;
      if (q) list = list.filter(c => (c.name||'').toLowerCase().includes(q.toLowerCase()) || (c.jid||'').includes(q));
      return res.json(list);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/whatsapp/history/:phone', async (req, res) => {
    try {
      const phone = conversationKey(req.params.phone);
      const convs = await db.getConversations(req.tenantId);
      const conv = convs.find(c => conversationKey(c.jid) === phone);
      if (!conv) return res.json({ messages: [], conversation: null });
      const msgs = await db.getMessages(conv.jid, req.tenantId);
      return res.json({ conversation: conv, messages: msgs });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/whatsapp/messages/:jid', async (req, res) => {
    try {
      return res.json(await db.getMessages(req.params.jid, req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/whatsapp/read/:jid', async (req, res) => {
    try {
      await db.markRead(req.params.jid, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/consent', async (req, res) => {
    const { phone, opted_in: optedIn } = req.body || {};
    if (!validPhone(phone) || typeof optedIn !== 'boolean') {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um telefone valido e opted_in booleano' });
    }
    try {
      await db.setConsent(normalizePhone(phone), optedIn, req.tenantId);
      if (!optedIn) await db.block(normalizePhone(phone), 'Opt-out solicitado', req.tenantId);
      else await db.unblock(normalizePhone(phone), req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/consent/:phone', async (req, res) => {
    if (!validPhone(req.params.phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      return res.json({ opted_in: await db.hasConsent(normalizePhone(req.params.phone), req.tenantId) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/consents', async (req, res) => {
    try {
      return res.json(await db.getConsents(req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/blocklist', async (req, res) => {
    const { phone, reason } = req.body || {};
    if (!validPhone(phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      await db.block(normalizePhone(phone), String(reason || '').slice(0, 500), req.tenantId);
      await db.setConsent(normalizePhone(phone), false, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.delete('/api/blocklist/:phone', async (req, res) => {
    if (!validPhone(req.params.phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      await db.unblock(normalizePhone(req.params.phone), req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/blocklist', async (req, res) => {
    try {
      return res.json(await db.getBlocklist(req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/templates', async (req, res) => {
    try {
      return res.json(await db.getTemplates(req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/templates/:id', async (req, res) => {
    try {
      const template = await db.getTemplate(req.params.id, req.tenantId);
      if (!template) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Modelo nao encontrado' });
      return res.json(template);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/templates', async (req, res) => {
    try {
      const tpl = req.body || {};
      if (!String(tpl.id || '').trim() || !String(tpl.nome || '').trim() || !String(tpl.corpo || '').trim()) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe id, nome e corpo do modelo' });
      }
      if (String(tpl.corpo).length > 4096 || String(tpl.nome).length > 200 || String(tpl.id).length > 100) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Modelo excede o limite de tamanho permitido' });
      }
      await db.upsertTemplate({
        ...tpl,
        id: String(tpl.id).trim(),
        nome: String(tpl.nome).trim(),
        corpo: String(tpl.corpo),
        variaveis: String(tpl.variaveis || '')
      }, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ erro: error.message });
    }
  });
  app.put('/api/templates/:id', async (req, res) => {
    try {
      const tpl = req.body || {};
      if (!String(tpl.nome || '').trim() || !String(tpl.corpo || '').trim()) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe nome e corpo do modelo' });
      }
      await db.upsertTemplate({
        ...tpl,
        id: req.params.id,
        nome: String(tpl.nome).trim(),
        corpo: String(tpl.corpo),
        variaveis: String(tpl.variaveis || '')
      }, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ erro: error.message });
    }
  });
  app.delete('/api/templates/:id', async (req, res) => {
    try {
      await db.deleteTemplate(req.params.id, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/templates/:id/render', async (req, res) => {
    try {
      const template = await db.getTemplate(req.params.id, req.tenantId);
      if (!template) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Modelo nao encontrado' });
      return res.json({ text: db.renderTemplate(template.corpo, req.body.vars || {}) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/bots/billing/run', async (req, res) => {
    try {
      return res.json({ ok: true, result: await bots.runBillingBot({ force: true, tenantId: req.tenantId, instanceId: String(req.body?.instanceId || 'default') }) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/bots/maintenance/run', async (req, res) => {
    try {
      return res.json({ ok: true, result: await bots.runMaintenanceBot({ force: true, tenantId: req.tenantId, instanceId: String(req.body?.instanceId || 'default') }) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/bots/status', async (req, res) => {
    try {
      return res.json({ schedulers: bots.getSchedulerStatus ? bots.getSchedulerStatus() : 'managed by server' });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  // --- Armazenamento do arquivo lido na aba "Leitura de dados" ---
  app.post('/api/noc/arquivos', async (req, res) => {
    try {
      const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
      const filename = String(req.body?.nomeArquivo || 'noc-importado.csv');
      const resultado = await nocStorage.saveNocFile({
        db,
        tenantId: req.tenantId || 'default',
        filename,
        csvText: csv
      });
      return res.status(201).json({
        ok: true, registro: resultado.registro, payload: resultado.payload
      });
    } catch (error) {
      return res.status(400).json({ codigo: 'NOC_FILE_ERROR', erro: error.message });
    }
  });

  app.get('/api/noc/arquivos/ultimo', async (req, res) => {
    try {
      const registro = await nocStorage.getLatestNocFile(db, req.tenantId || 'default');
      if (!registro) return res.json({ ok: true, registro: null, payload: null });
      const { conteudo, ...metadados } = registro;
      const payload = typeof registro.payload === 'string'
        ? JSON.parse(registro.payload)
        : registro.payload;
      return res.json({ ok: true, registro: metadados, payload });
    } catch (error) {
      return res.status(500).json({ codigo: 'NOC_FILE_ERROR', erro: error.message });
    }
  });

  app.get('/api/noc/arquivos', async (req, res) => {
    try {
      const limite = Math.max(1, Math.min(Number(req.query.limite) || 20, 100));
      return res.json({ ok: true, arquivos: await nocStorage.listNocFiles(db, req.tenantId || 'default', limite) });
    } catch (error) {
      return res.status(500).json({ codigo: 'NOC_FILE_ERROR', erro: error.message });
    }
  });

  app.delete('/api/noc/arquivos', async (req, res) => {
    try {
      const removidos = await nocStorage.deleteNocFiles(db, req.tenantId || 'default');
      return res.json({ ok: true, removidos });
    } catch (error) {
      return res.status(500).json({ codigo: 'NOC_FILE_ERROR', erro: error.message });
    }
  });

  // --- Importação NOC (CSV exportado do sistema de câmeras) ---
  app.get('/api/import/noc/status', async (req, res) => {
    try {
      return res.json({
        watcher: nocWatcher ? nocWatcher.getStatus() : { running: false, reason: 'watcher não iniciado neste processo' }
      });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/import/noc', async (req, res) => {
    try {
      const { syncNocCameras } = require('./lib/noc-import');
      const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
      if (!csv.trim()) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Envie o conteúdo do CSV em body.csv' });
      }
      const tenantId = req.tenantId || 'default';
      const dryRun = req.body?.dryRun === true;
      const summary = await syncNocCameras({ db, csvText: csv, tenantId, dryRun, sourceFile: req.body?.filename || 'upload.csv' });
      await db.addLog({
        timestamp: new Date().toISOString(),
        camera_id: '',
        camera_nome: summary.sourceFile || 'NOC CSV',
        responsavel_telefone: '',
        acao: 'IMPORTACAO_NOC',
        detalhe: `${dryRun ? '[DRY-RUN] ' : ''}${summary.created} criadas, ${summary.updated} atualizadas, ${summary.unchanged} sem mudança, ${summary.offline} offline, ${summary.online} online`,
        status_anterior: '',
        status_novo: '',
        trace_id: null
      }, tenantId).catch(() => {});
      return res.json({ ok: true, summary });
    } catch (error) {
      return res.status(400).json({ codigo: 'IMPORT_ERROR', erro: error.message });
    }
  });

  app.post('/api/import/noc/run', async (req, res) => {
    try {
      if (!nocWatcher) return res.status(400).json({ codigo: 'WATCHER_DISABLED', erro: 'Watcher NOC não está ativo. Configure NOC_WATCH_ENABLED=true e NOC_WATCH_DIR.' });
      const result = await nocWatcher.scanOnce();
      return res.json({ ok: true, result, watcher: nocWatcher.getStatus() });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  // --- Bot NOC: transforma a relação offline do Painel NOC em rascunhos na aba Offline ---
  app.post('/api/import/noc/scan', async (req, res) => {
    try {
      const { runNocDraftBot } = require('./lib/noc-import');
      const preparado = await runNocDraftBot({
        db,
        tenantId: req.tenantId || 'default',
        options: { ...(req.body || {}), dryRun: true }
      });
      return res.json({
        ok: true,
        result: {
          sourceFile: preparado.sourceFile,
          assignments: preparado.assignments,
          offline: preparado.offline,
          drafts: preparado.drafts,
          errors: preparado.errors
        }
      });
    } catch (error) {
      return res.status(400).json({ codigo: 'NOC_SCAN_ERROR', erro: error.message });
    }
  });

  app.post('/api/import/noc/apply', async (req, res) => {
    try {
      const { applyNocAssignments } = require('./lib/noc-import');
      const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
      if (!assignments.length) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Nenhuma atribuição NOC informada' });
      const summary = await applyNocAssignments({
        db,
        tenantId: req.tenantId || 'default',
        assignments,
        dryRun: req.body?.dryRun === true
      });
      return res.json({ ok: true, summary });
    } catch (error) {
      return res.status(400).json({ codigo: 'NOC_APPLY_ERROR', erro: error.message });
    }
  });

  app.post('/api/bots/noc/run', async (req, res) => {
    try {
      const tenantId = req.tenantId || 'default';
      const { runNocDraftBot } = require('./lib/noc-import');
      const prepared = await runNocDraftBot({ db, tenantId, options: req.body || {} });
      const result = {
        ...prepared,
        created: prepared.sync.created,
        updated: prepared.sync.updated,
        unchanged: prepared.sync.unchanged,
        semTelefone: prepared.sync.semTelefone,
        sent: 0,
        failed: 0,
        unconfirmed: 0,
        pending: prepared.drafts
      };
      await db.addLog({
        timestamp: new Date().toISOString(),
        camera_id: '',
        camera_nome: prepared.sourceFile || 'NOC',
        responsavel_telefone: '',
        acao: 'BOT_NOC',
        detalhe: `Rascunhos preparados: ${result.created} criadas, ${result.updated} atualizadas, ${prepared.drafts} aguardando responsável/telefone. Nenhuma mensagem enviada.`,
        status_anterior: '',
        status_novo: '',
        trace_id: null
      }, tenantId).catch(() => {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(400).json({ codigo: 'NOC_BOT_ERROR', erro: error.message });
    }
  });

  // --- Importação PDF: varredura para destinar/atribuir câmeras ---
  app.post('/api/import/pdf/scan', express.json({ limit: '15mb' }), async (req, res) => {
    try {
      const { scanPdfForAssignments } = require('./lib/pdf-import');
      const pdfBase64 = String(req.body?.pdfBase64 || req.body?.base64 || '');
      const filePath = String(req.body?.filePath || '');
      const filename = String(req.body?.filename || 'documento.pdf');
      if (!pdfBase64 && !filePath) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Envie pdfBase64 (ou filePath no servidor local)' });
      }
      const result = await scanPdfForAssignments({
        db,
        tenantId: req.tenantId || 'default',
        base64: pdfBase64 || undefined,
        filePath: filePath || undefined,
        filename
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(400).json({ codigo: 'PDF_SCAN_ERROR', erro: error.message });
    }
  });

  app.post('/api/import/pdf/apply', async (req, res) => {
    try {
      const { applyPdfAssignments } = require('./lib/pdf-import');
      const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
      if (!assignments.length) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Nenhuma atribuição informada' });
      const summary = await applyPdfAssignments({
        db,
        tenantId: req.tenantId || 'default',
        assignments,
        dryRun: req.body?.dryRun === true
      });
      return res.json({ ok: true, summary });
    } catch (error) {
      return res.status(400).json({ codigo: 'PDF_APPLY_ERROR', erro: error.message });
    }
  });
  app.get('/api/bots/config', async (req, res) => {
    try {
      return res.json(await db.getBotConfig(req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/bots/config', async (req, res) => {
    const allowed = new Set([
      'billing_days_before',
      'billing_days_after',
      'billing_hour',
      'maintenance_hour',
      'auto_mode',
      'max_attempts',
      'business_hours_start',
      'business_hours_end',
      'business_hours_override_date',
      'business_hours_override_start',
      'business_hours_override_end'
    ]);
    const entries = Object.entries(req.body || {});
    if (!entries.length || entries.some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Configuracao de bot invalida' });
    }
    for (const [key, value] of entries) {
      if (['billing_hour', 'maintenance_hour', 'business_hours_start', 'business_hours_end'].includes(key) &&
          (!/^\d{1,2}$/.test(value) || Number(value) < 0 || Number(value) > 23)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: `${key} deve ser uma hora entre 0 e 23` });
      }
      if (key === 'business_hours_override_date' && value &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
           !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
           new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'business_hours_override_date deve ser uma data valida (AAAA-MM-DD)' });
      }
      if (key === 'business_hours_override_start' &&
          (!/^\d{1,2}$/.test(value) || Number(value) < 0 || Number(value) > 23)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'business_hours_override_start deve ser uma hora entre 0 e 23' });
      }
      if (key === 'business_hours_override_end' &&
          (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 24)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'business_hours_override_end deve ser uma hora entre 1 e 24' });
      }
      if (key === 'max_attempts' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'max_attempts deve ficar entre 1 e 100' });
      }
      if (key === 'auto_mode' && !['true', 'false'].includes(value)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'auto_mode deve ser true ou false' });
      }
      if (['billing_days_before', 'billing_days_after'].includes(key) && value && !/^\d+(,\d+)*$/.test(value)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: `${key} deve conter dias separados por virgula` });
      }
    }
    try {
      const config = await db.getBotConfig(req.tenantId);
      const proposed = { ...config, ...Object.fromEntries(entries) };
      if (Number(proposed.business_hours_start) >= Number(proposed.business_hours_end)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'O fim do horario comercial deve ser posterior ao inicio' });
      }
      if (proposed.business_hours_override_date) {
        const overrideStart = Number(proposed.business_hours_override_start);
        const overrideEnd = Number(proposed.business_hours_override_end);
        if (!Number.isInteger(overrideStart) || !Number.isInteger(overrideEnd) ||
            overrideStart < 0 || overrideStart > 23 || overrideEnd < 1 ||
            overrideEnd > 24 || overrideStart >= overrideEnd) {
          return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um intervalo temporario valido para a data selecionada' });
        }
      }
      for (const [key, value] of entries) await db.setBotConfig(key, value, req.tenantId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/reports', async (req, res) => {
    try {
      return res.json(await db.getReports(req.tenantId));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  // ---- Instancias WhatsApp (uma sessao isolada por numero) ----
  function validInstanceId(value) {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(String(value || ''));
  }

  app.get('/api/instances', async (req, res) => {
    try {
      const stored = db.listInstances ? await db.listInstances() : [];
      const statuses = sessionManager ? sessionManager.list(req.tenantId) : [];
      const byId = new Map(statuses.map(item => [item.instanceId, item]));
      const rows = stored.filter(row => String(row.tenant_id || 'default') === String(req.tenantId || 'default'));
      const result = rows.map(row => ({
        instanceId: row.instance_id,
        label: row.label || row.instance_id,
        autoConnect: Boolean(row.auto_connect),
        ...(byId.get(row.instance_id) || { status: 'disconnected' })
      }));
      for (const status of statuses) {
        if (!result.some(item => item.instanceId === status.instanceId)) {
          result.push({ instanceId: status.instanceId, label: status.instanceId, autoConnect: false, ...status });
        }
      }
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/instances', async (req, res) => {
    const instanceId = String(req.body?.instanceId || '').trim();
    if (!validInstanceId(instanceId)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'instanceId deve conter ate 64 letras, numeros, _ ou -' });
    }
    try {
      if (db.upsertInstance) {
        await db.upsertInstance({
          tenantId: req.tenantId,
          instanceId,
          label: String(req.body?.label || '').slice(0, 120),
          autoConnect: Boolean(req.body?.autoConnect)
        });
      }
      if (sessionManager) sessionManager.getOrCreate(req.tenantId, instanceId);
      return res.status(201).json({ ok: true, instanceId });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/instances/:instanceId/connect', async (req, res) => {
    if (!validInstanceId(req.params.instanceId)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'instanceId invalido' });
    if (!sessionManager) return res.status(503).json({ codigo: 'UNAVAILABLE', erro: 'Gerenciador de instancias indisponivel' });
    try {
      const instance = sessionManager.getOrCreate(req.tenantId, req.params.instanceId);
      await instance.connect();
      return res.json({ ok: true, status: instance.getStatus() });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_CONNECT_FAILED', erro: error.message });
    }
  });

  app.post('/api/instances/:instanceId/disconnect', async (req, res) => {
    if (!validInstanceId(req.params.instanceId)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'instanceId invalido' });
    if (!sessionManager) return res.status(503).json({ codigo: 'UNAVAILABLE', erro: 'Gerenciador de instancias indisponivel' });
    try {
      const instance = sessionManager.get(req.tenantId, req.params.instanceId);
      if (!instance) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Instancia nao encontrada' });
      await instance.disconnect({ logout: false });
      return res.json({ ok: true, status: instance.getStatus() });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/instances/:instanceId/qr', async (req, res) => {
    if (!validInstanceId(req.params.instanceId)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'instanceId invalido' });
    if (!sessionManager) return res.status(503).json({ codigo: 'UNAVAILABLE', erro: 'Gerenciador de instancias indisponivel' });
    try {
      const instance = sessionManager.getOrCreate(req.tenantId, req.params.instanceId);
      await instance.refreshQR();
      return res.json({ ok: true, status: instance.getStatus() });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_QR_FAILED', erro: error.message });
    }
  });

  app.delete('/api/instances/:instanceId', async (req, res) => {
    if (!validInstanceId(req.params.instanceId)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'instanceId invalido' });
    if (!sessionManager) return res.status(503).json({ codigo: 'UNAVAILABLE', erro: 'Gerenciador de instancias indisponivel' });
    try {
      const removed = await sessionManager.remove(req.tenantId, req.params.instanceId, { logout: true });
      if (db.deleteInstance) await db.deleteInstance(req.tenantId, req.params.instanceId);
      return res.json({ ok: true, removed });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const jobs = db.listJobs ? await db.listJobs(req.tenantId, limit) : [];
      return res.json(jobs);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.use((err, req, res, next) => {
    console.error('[HTTP] Erro inesperado:', err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ codigo: 'INTERNAL_ERROR', erro: 'Erro interno do servidor' });
  });

  app.listen = function (...args) {
    return server.listen(...args);
  };
  app.server = server;
  app.io = io;
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const { log } = require('./logger');
  const { createAuth } = require('./auth');
  const { createSessionManager } = require('./session-manager');
  const { createQueue } = require('./queue');
  const botsModule = require('./bots');

  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
    throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD antes de expor o servidor fora de localhost');
  }

  const db = require('./db');
  const { createMetaWhatsapp, isConfigured: isMetaConfigured } = require('./lib/meta-whatsapp');
  const { createDatafyWhatsapp, isConfigured: isDatafyConfigured } = require('./lib/datafy-whatsapp');
  const provider = String(process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
  if (!['baileys', 'meta', 'datafy'].includes(provider)) {
    throw new Error('WHATSAPP_PROVIDER deve ser "baileys", "meta" ou "datafy"');
  }
  const metaConfigurado = provider === 'meta';
  const datafyConfigurado = provider === 'datafy';
  if (metaConfigurado && !isMetaConfigured()) {
    throw new Error('WHATSAPP_PROVIDER=meta exige META_WA_ACCESS_TOKEN e META_WA_PHONE_NUMBER_ID');
  }
  if (datafyConfigurado && !isDatafyConfigured()) {
    throw new Error('WHATSAPP_PROVIDER=datafy exige DATAFY_WA_ACCESS_TOKEN');
  }
  const remotoConfigurado = !metaConfigurado && !datafyConfigurado && whatsappRemoto.isRemoteConfigured();
  const wa = datafyConfigurado
    ? createDatafyWhatsapp({ db })
    : metaConfigurado
      ? createMetaWhatsapp({ db })
      : remotoConfigurado
        ? whatsappRemoto.createRemoteWhatsapp()
        : require('./whatsapp');
  if (metaConfigurado && (!wa.webhookConfig.secret || !wa.webhookConfig.verifyToken)) {
    throw new Error('WHATSAPP_PROVIDER=meta exige META_WA_APP_SECRET e META_WA_VERIFY_TOKEN para validar o webhook');
  }
  if (datafyConfigurado && !wa.webhookConfig.secret) {
    throw new Error('WHATSAPP_PROVIDER=datafy exige DATAFY_WA_WEBHOOK_SECRET para validar eventos de entrega');
  }
  const auth = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD ? createAuth({ db }) : null;

  let bots = botsModule;
  const sessionManager = remotoConfigurado || metaConfigurado || datafyConfigurado ? null : createSessionManager({
    db,
    resolveBots: () => bots
  });
  const instanciaPadrao = () => (sessionManager
    ? sessionManager.getOrCreate('default', 'default')
    : wa);
  bots = botsModule.createBots({
    db,
    wa: instanciaPadrao(),
    resolveWa: sessionManager
      ? ({ tenantId, instanceId }) => sessionManager.getOrCreate(tenantId, instanceId)
      : () => wa,
    listInstances: () => db.listInstances()
  });
  if (remotoConfigurado) {
    log('info', 'wa.remote_mode', { url: wa.serverUrl });
  } else if (metaConfigurado) {
    log('info', 'wa.meta_mode', { graphVersion: process.env.META_WA_GRAPH_VERSION || 'v27.0' });
  }

  const { createNocWatcher } = require('./lib/noc-watch');
  const nocWatchEnabled = !SERVERLESS && process.env.NOC_WATCH_ENABLED !== 'false';
  const nocWatcher = nocWatchEnabled
    ? createNocWatcher({
        db,
        logger: { log: (...a) => log('info', 'noc_watch', { msg: a.join(' ') }), warn: (...a) => log('warn', 'noc_watch', { msg: a.join(' ') }), error: (...a) => log('error', 'noc_watch', { msg: a.join(' ') }) },
        dir: process.env.NOC_WATCH_DIR || path.join(__dirname, 'importacao', 'entrada'),
        tenantId: process.env.NOC_IMPORT_TENANT || 'default',
        intervalMs: Number(process.env.NOC_WATCH_INTERVAL_MS || 60000)
      })
    : null;

  const app = createApp({ db, wa, bots, auth, sessionManager, nocWatcher });
  const queue = createQueue({ db, workerId: `sentry-${process.pid}`, pollMs: 1500 });

  function instanciaDoPayload(payload) {
    return sessionManager
      ? sessionManager.getOrCreate(payload.tenantId || 'default', payload.instanceId || 'default')
      : wa;
  }
  queue.register('send_text', async payload => {
    await instanciaDoPayload(payload).sendMessage(payload.to, payload.text);
  });
  queue.register('send_options', async payload => {
    await instanciaDoPayload(payload).sendWithOptions(payload.to, payload.text, payload.buttons, payload.footer);
  });
  queue.register('run_billing', async payload => bots.runBillingBot({
    force: true, tenantId: payload.tenantId || 'default', instanceId: payload.instanceId || 'default'
  }));
  queue.register('run_maintenance', async payload => bots.runMaintenanceBot({
    force: true, tenantId: payload.tenantId || 'default', instanceId: payload.instanceId || 'default'
  }));
  // Prepara apenas rascunhos; o envio continua no fluxo normal com consentimento/24 h.
  queue.register('run_noc', async payload => {
    const { runNocDraftBot } = require('./lib/noc-import');
    return runNocDraftBot({ db, tenantId: payload.tenantId || 'default', options: payload.options || payload });
  });

  process.on('unhandledRejection', reason => log('error', 'process.unhandled_rejection', { error: reason }));
  process.on('uncaughtException', error => {
    log('error', 'process.uncaught_exception', { error });
    process.exit(1);
  });

  async function shutdown() {
    if (nocWatcher) nocWatcher.stop();
    queue.stop();
    if (sessionManager) await Promise.allSettled(sessionManager.all().map(session => session.disconnect({ logout: false })));
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function start() {
    await db.init();
    if (auth) await auth.bootstrapAdmin();
    else log('warn', 'auth.disabled', { reason: 'ADMIN_EMAIL/ADMIN_PASSWORD ausentes; acesso restrito a loopback' });

    // A instancia padrao reaproveita o auth_info existente e e restaurada no boot.
    await db.upsertInstance({
      tenantId: 'default', instanceId: 'default', label: 'WhatsApp principal', autoConnect: true
    });

    app.server.listen(port, host, () => {
      console.log(`Servidor rodando em http://${host}:${port}`);
      log('info', 'server.listening', { host, port, auth: Boolean(auth) });
      bots.startSchedulers().catch(error => log('error', 'bots.scheduler_failed', { error }));
      if (sessionManager) sessionManager.restore().catch(error => log('error', 'wa.restore_failed', { error }));
      if (nocWatcher) nocWatcher.start();
      queue.start();
    });
  }

  start().catch(error => {
    log('error', 'server.start_failed', { error });
    process.exitCode = 1;
    app.io.close();
  });
}
