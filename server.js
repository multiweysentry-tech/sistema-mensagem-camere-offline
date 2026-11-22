// Load .env
const fs = require('fs');
const path = require('path');
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
  return String(value || '').replace(/\D/g, '');
}

function validPhone(value) {
  return /^\d{10,15}$/.test(normalizePhone(value));
}

function validateCamera(camera, partial = false) {
  const errors = [];
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) {
    return ['payload invalido'];
  }
  if (!partial && (!camera.id || !String(camera.id).trim())) errors.push('id obrigatorio');
  if (!partial && (!camera.camera_nome || !String(camera.camera_nome).trim())) errors.push('camera_nome obrigatorio');
  if (!partial && (!camera.responsavel_nome || !String(camera.responsavel_nome).trim())) errors.push('responsavel_nome obrigatorio');
  if (!partial && !validPhone(camera.responsavel_telefone)) errors.push('responsavel_telefone invalido');
  if (Object.prototype.hasOwnProperty.call(camera, 'responsavel_telefone') &&
      !validPhone(camera.responsavel_telefone)) errors.push('responsavel_telefone invalido');
  if (camera.status !== undefined && !CAMERA_STATUSES.includes(camera.status)) errors.push('status invalido');
  if (camera.tentativas !== undefined &&
      (camera.tentativas === '' || !Number.isInteger(Number(camera.tentativas)) || Number(camera.tentativas) < 0)) {
    errors.push('tentativas invalido');
  }
  return errors;
}

function createApp(options = {}) {
  const db = options.db || require('./db');
  const wa = options.wa || require('./whatsapp');
  const bots = options.bots || require('./bots');
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  wa.setIO(io);
  io.on('connection', socket => socket.emit('wa:status', wa.getStatus()));

  app.use(express.json({ limit: '1mb' }));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/logo-sentry.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-sentry.png')));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ codigo: 'INVALID_JSON', erro: 'JSON invalido' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ codigo: 'PAYLOAD_TOO_LARGE', erro: 'Corpo da requisicao muito grande' });
    }
    next(err);
  });

  const apiKey = options.apiKey ?? process.env.API_KEY;
  app.use('/api', (req, res, next) => {
    if (!apiKey || req.get('x-api-key') === apiKey) return next();
    return res.status(401).json({ codigo: 'UNAUTHORIZED', erro: 'Nao autorizado' });
  });

  app.get('/api/health', async (req, res) => {
    try {
      const cameras = await db.getCameras();
      const body = { status: 'ok', cameras: cameras.length };
      if (db.mode) body.storage = db.mode;
      res.json(body);
    } catch (error) {
      res.status(500).json({ status: 'error', erro: error.message });
    }
  });

  app.get('/api/cameras', async (req, res) => {
    try {
      let list = await db.getCameras();
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
      const camera = (await db.getCameras()).find(item => String(item.id) === req.params.id);
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
      const list = await db.getCameras();
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
      });
      const camera = (await db.getCameras()).find(item => String(item.id) === normalizedId);
      return res.status(exists ? 200 : 201).json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.put('/api/cameras/:id', async (req, res) => {
    const existing = (await db.getCameras()).find(camera => String(camera.id) === req.params.id);
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
      await db.updateCamera(req.params.id, fields);
      const camera = (await db.getCameras()).find(item => String(item.id) === req.params.id);
      return res.json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.delete('/api/cameras/:id', async (req, res) => {
    try {
      const camera = (await db.getCameras()).find(item => String(item.id) === req.params.id);
      if (!camera) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Camera nao encontrada' });
      await db.deleteCamera(req.params.id);
      return res.json({ camera });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/log', async (req, res) => {
    try {
      let list = await db.getLog();
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
      await db.addLog(entry);
      return res.status(201).json({ log: entry });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/whatsapp/status', (req, res) => res.json(wa.getStatus()));
  app.post('/api/whatsapp/connect', async (req, res) => {
    try {
      await wa.connect();
      return res.json({ ok: true, status: wa.getStatus() });
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_CONNECT_FAILED', erro: error.message });
    }
  });
  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      await wa.disconnect();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/whatsapp/send', async (req, res) => {
    const { to, text } = req.body || {};
    if ((!validPhone(to) && !/^\d{10,15}@s\.whatsapp\.net$/.test(String(to || ''))) ||
        typeof text !== 'string' || !text.trim() || text.length > 4096) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um telefone e uma mensagem valida (ate 4096 caracteres)' });
    }
    try {
      const result = await wa.sendMessage(String(to), text.trim());
      return res.json(result);
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_SEND_FAILED', erro: error.message });
    }
  });
  app.post('/api/whatsapp/send-options', async (req, res) => {
    const { to, text, buttons, footer } = req.body || {};
    if ((!validPhone(to) && !/^\d{10,15}@s\.whatsapp\.net$/.test(String(to || ''))) ||
        typeof text !== 'string' || !text.trim() || text.length > 4096) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe um telefone e uma mensagem valida (ate 4096 caracteres)' });
    }
    if (buttons !== undefined && (!Array.isArray(buttons) || buttons.length < 2 || buttons.length > 3)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Informe de 2 a 3 botoes' });
    }
    try {
      const result = await wa.sendWithOptions(String(to), text.trim(), buttons, footer);
      return res.json(result);
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_SEND_FAILED', erro: error.message });
    }
  });
  app.get('/api/whatsapp/check/:phone', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    }
    try {
      return res.json(await wa.checkNumber(phone));
    } catch (error) {
      return res.status(503).json({ codigo: 'WHATSAPP_CHECK_FAILED', erro: error.message });
    }
  });
  app.get('/api/whatsapp/conversations', async (req, res) => {
    try {
      let list = await db.getConversations();
      const q = req.query.q;
      if (q) list = list.filter(c => (c.name||'').toLowerCase().includes(q.toLowerCase()) || (c.jid||'').includes(q));
      return res.json(list);
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/whatsapp/history/:phone', async (req, res) => {
    try {
      const phone = req.params.phone.replace(/\D/g,'');
      const convs = await db.getConversations();
      const conv = convs.find(c => c.jid.includes(phone));
      if (!conv) return res.json({ messages: [], conversation: null });
      const msgs = await db.getMessages(conv.jid);
      return res.json({ conversation: conv, messages: msgs });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/whatsapp/messages/:jid', async (req, res) => {
    try {
      return res.json(await db.getMessages(req.params.jid));
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/whatsapp/read/:jid', async (req, res) => {
    try {
      await db.markRead(req.params.jid);
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
      await db.setConsent(normalizePhone(phone), optedIn);
      if (!optedIn) await db.block(normalizePhone(phone), 'Opt-out solicitado');
      else await db.unblock(normalizePhone(phone));
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/consent/:phone', async (req, res) => {
    if (!validPhone(req.params.phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      return res.json({ opted_in: await db.hasConsent(normalizePhone(req.params.phone)) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/consents', async (req, res) => {
    try {
      return res.json(await db.getConsents());
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/blocklist', async (req, res) => {
    const { phone, reason } = req.body || {};
    if (!validPhone(phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      await db.block(normalizePhone(phone), String(reason || '').slice(0, 500));
      await db.setConsent(normalizePhone(phone), false);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.delete('/api/blocklist/:phone', async (req, res) => {
    if (!validPhone(req.params.phone)) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Telefone invalido' });
    try {
      await db.unblock(normalizePhone(req.params.phone));
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/blocklist', async (req, res) => {
    try {
      return res.json(await db.getBlocklist());
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.get('/api/templates', async (req, res) => {
    try {
      return res.json(await db.getTemplates());
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/templates/:id', async (req, res) => {
    try {
      const template = await db.getTemplate(req.params.id);
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
      });
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
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ erro: error.message });
    }
  });
  app.delete('/api/templates/:id', async (req, res) => {
    try {
      await db.deleteTemplate(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/templates/:id/render', async (req, res) => {
    try {
      const template = await db.getTemplate(req.params.id);
      if (!template) return res.status(404).json({ codigo: 'NOT_FOUND', erro: 'Modelo nao encontrado' });
      return res.json({ text: db.renderTemplate(template.corpo, req.body.vars || {}) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });

  app.post('/api/bots/billing/run', async (req, res) => {
    try {
      return res.json({ ok: true, result: await bots.runBillingBot({ force: true }) });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.post('/api/bots/maintenance/run', async (req, res) => {
    try {
      return res.json({ ok: true, result: await bots.runMaintenanceBot({ force: true }) });
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
  app.get('/api/bots/config', async (req, res) => {
    try {
      return res.json(await db.getBotConfig());
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
      'business_hours_end'
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
      const config = await db.getBotConfig();
      const proposed = { ...config, ...Object.fromEntries(entries) };
      if (Number(proposed.business_hours_start) >= Number(proposed.business_hours_end)) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'O fim do horario comercial deve ser posterior ao inicio' });
      }
      for (const [key, value] of entries) await db.setBotConfig(key, value);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ erro: error.message });
    }
  });
  app.get('/api/reports', async (req, res) => {
    try {
      return res.json(await db.getReports());
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
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && (!process.env.API_KEY || process.env.API_KEY.length < 32)) {
    throw new Error('Defina uma API_KEY com pelo menos 32 caracteres antes de aceitar conexoes de outras maquinas');
  }

  const db = require('./db');
  const wa = require('./whatsapp');
  const bots = require('./bots');
  const app = createApp({ db, wa, bots });

  db.init().then(() => {
    app.server.listen(port, host, () => {
      console.log(`Servidor rodando em http://${host}:${port}`);
      bots.startSchedulers().catch(error => console.error('[Bots] Nao foi possivel iniciar os agendadores:', error.message));
      wa.connect().catch(error => console.error('[WhatsApp] Falha inicial de conexao:', error.message));
    });
  }).catch(error => {
    console.error('[DB] Falha ao inicializar o banco:', error.message);
    process.exitCode = 1;
    app.io.close();
  });
}
