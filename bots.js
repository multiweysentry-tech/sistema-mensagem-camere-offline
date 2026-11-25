const cron = require('node-cron');
const defaultWa = require('./whatsapp');
const defaultDb = require('./db');
const { normalizarContato, normalizarTelefone, chaveComparacaoTelefone } = require('./phone-utils');

const TIME_ZONE = 'America/Cuiaba';
let scheduler = null;

function normalizePhone(value) {
  return normalizarContato(value);
}

function contactKey(value) {
  return chaveComparacaoTelefone(value) || normalizePhone(value);
}

function localHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(date));
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseHour(value, fallback, maximum = 23) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= maximum ? hour : fallback;
}

function normalizeText(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function parseReply(text) {
  const normalized = normalizeText(text);
  if (/^(parar|sair|cancelar|stop|unsubscribe)$/.test(normalized)) return { intent: 'opt_out' };
  if (/^(1|analisar|estou analisando|verificando|estou verificando)$/.test(normalized)) {
    return {
      intent: 'investigating',
      status: 'Verificando',
      reply: 'Obrigado! Registramos que voce esta verificando as cameras.'
    };
  }
  if (/^(2|suporte|tecnico|preciso de suporte|preciso falar com tecnico)$/.test(normalized)) {
    return {
      intent: 'support',
      status: 'Suporte',
      reply: 'Sua solicitacao foi encaminhada para a equipe de suporte.'
    };
  }
  if (/^(3|resolvi|resolvido|ja resolvi)$/.test(normalized)) {
    return {
      intent: 'resolved',
      status: 'Aguardando validacao',
      reply: 'Obrigado! Registramos a resolucao e vamos validar o retorno das cameras.'
    };
  }
  if (/^(oi|ola|bom dia|boa tarde|boa noite|ajuda|menu)$/.test(normalized)) {
    return {
      intent: 'help',
      reply: 'Para atualizar as cameras, responda: 1 para estou verificando, 2 para suporte ou 3 para ja resolvi. Para parar mensagens automaticas, responda PARAR.'
    };
  }
  return null;
}

function createBots({ db = defaultDb, wa = defaultWa, schedulerApi = cron, resolveWa = null, listInstances = null } = {}) {
  const campaignsInProgress = new Set();

  function waFor(options = {}) {
    const tenantId = options.tenantId || 'default';
    const instanceId = options.instanceId || 'default';
    return resolveWa ? resolveWa({ tenantId, instanceId }) : wa;
  }

  function campaignKey(phone, options = {}) {
    return `${options.tenantId || 'default'}::${options.instanceId || 'default'}::${phone}`;
  }

  async function getConfig(tenantId = 'default') {
    const config = await db.getBotConfig(tenantId);
    return {
      ...config,
      maxAttempts: Math.max(1, Number.parseInt(config.max_attempts, 10) || 3),
      businessStart: parseHour(config.business_hours_start, 8),
      businessEnd: parseHour(config.business_hours_end, 18),
      overrideStart: parseHour(config.business_hours_override_start, 0),
      overrideEnd: parseHour(config.business_hours_override_end, 24, 24)
    };
  }

  function isBusinessHours(config, now = new Date()) {
    const hour = localHour(now);
    if (config.business_hours_override_date === localDate(now)) {
      return hour >= config.overrideStart && hour < config.overrideEnd;
    }
    return hour >= config.businessStart && hour < config.businessEnd;
  }

  async function canSendCampaign(phone, tenantId = 'default') {
    if (await db.isBlocked(phone, tenantId)) return false;
    return db.hasConsent(phone, tenantId);
  }

  async function hasRecentSend(phone, action, since, tenantId = 'default') {
    const actions = Array.isArray(action) ? action : [action];
    const threshold = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (db.hasRecentLog) return db.hasRecentLog(phone, actions, threshold.toISOString(), tenantId);
    const entries = await db.getLog(tenantId);
    return entries.some(entry => actions.includes(entry.acao) &&
      contactKey(entry.responsavel_telefone) === contactKey(phone) &&
      Date.parse(entry.timestamp) >= threshold.getTime());
  }

  function hasRecentCameraNotice(cameras, now) {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    return cameras.some(camera => {
      const timestamp = Date.parse(camera.ultima_cobranca || '');
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
    });
  }

  // Agrupa pelo contato, nunca apenas pelo nome. Nomes repetidos com numeros
  // diferentes viram usuarios separados; o mesmo numero com nomes diferentes
  // continua sendo um unico destinatario, com todos os nomes registrados.
  function groupByPhone(cameras) {
    const groups = new Map();
    for (const camera of cameras) {
      const phone = normalizePhone(camera.responsavel_telefone);
      if (!/^\d{10,15}$/.test(phone)) continue;
      // 10 e 11 digitos (com/sem o 9º) viram o mesmo contato.
      const key = contactKey(camera.responsavel_telefone) || phone;
      const nome = camera.responsavel_nome || '';
      const group = groups.get(key) || {
        key,
        phone,
        name: nome,
        names: [],
        cameras: []
      };
      if (nome && !group.names.includes(nome)) group.names.push(nome);
      // Se um dos cadastros tem o 9º digito, preferimos esse numero para o envio.
      if (normalizarTelefone(camera.responsavel_telefone).nacional.length >
          normalizarTelefone(group.phone).nacional.length) {
        group.phone = phone;
      }
      group.cameras.push(camera);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  async function runBillingBot({ now = new Date(), force = false, tenantId = 'default', instanceId = 'default' } = {}) {
    const config = await getConfig(tenantId);
    if (!force && config.auto_mode === 'false') return { sent: 0, skipped: 'automatic mode disabled' };
    if (!force && !isBusinessHours(config, now)) return { sent: 0, skipped: 'outside business hours' };

    const instance = waFor({ tenantId, instanceId });
    const cameras = await db.getCameras(tenantId);
    const eligible = cameras.filter(camera => {
      const status = String(camera.status || '').trim();
      const attempts = Number(camera.tentativas) || 0;
      return ['Pendente', 'Aguardando resposta'].includes(status) && attempts < config.maxAttempts;
    });
    let sent = 0;
    let failed = 0;
    let unconfirmed = 0;
    let pending = 0;

    for (const group of groupByPhone(eligible)) {
      const lockKey = campaignKey(group.phone, { tenantId, instanceId });
      if (campaignsInProgress.has(lockKey)) continue;
      campaignsInProgress.add(lockKey);
      try {
        if (!(await canSendCampaign(group.phone, tenantId))) continue;
        if (hasRecentCameraNotice(group.cameras, now)) continue;
        if (await hasRecentSend(group.phone, ['COBRANCA_ENVIADA', 'LEMBRETE_MANUTENCAO', 'ENVIO_SEM_CONFIRMACAO', 'ENVIO_AGUARDANDO_CONFIRMACAO', 'ERRO'], new Date(now.getTime() - 24 * 60 * 60 * 1000), tenantId)) continue;

        const attempts = Math.max(...group.cameras.map(camera => Number(camera.tentativas) || 0)) + 1;
        const cameraList = group.cameras.map(camera => `• ${camera.camera_nome || camera.id}`).join('\n');
        const message = `Olá, ${group.name}!\nO Sentry identificou que estas câmeras estão offline:\n${cameraList}\n\nComo prefere prosseguir? Toque em uma opção abaixo para atualizar o status.`;

        try {
          const result = await instance.sendWithOptions(group.phone, message, undefined, undefined, {
            tenantId,
            instanceId,
            cameraIds: group.cameras.map(camera => camera.id)
          });
          const timestamp = now.toISOString();
          if (result?.deliveryStatus === 'pendente') {
            await db.addLog({
              timestamp,
              camera_id: group.cameras.map(camera => camera.id).join(','),
              camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
              responsavel_telefone: group.phone,
              acao: 'ENVIO_AGUARDANDO_CONFIRMACAO',
              detalhe: `Mensagem ${result.id || 'sem ID'} aceita pela Cloud API; aguardando confirmação de entrega`,
              status_anterior: group.cameras.map(camera => camera.status).join(','),
              status_novo: group.cameras.map(camera => camera.status).join(','),
              instance_id: instanceId
            }, tenantId);
            for (const camera of group.cameras) {
              await db.updateCamera(camera.id, { ultima_cobranca: timestamp }, tenantId);
            }
            pending++;
            continue;
          }
          if (result?.deliveryStatus === 'unconfirmed') {
            await db.addLog({
              timestamp,
              camera_id: group.cameras.map(camera => camera.id).join(','),
              camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
              responsavel_telefone: group.phone,
              acao: 'ENVIO_SEM_CONFIRMACAO',
              detalhe: `WhatsApp aceitou o envio, mas nao confirmou a entrega; tentativa ${attempts}`,
              status_anterior: group.cameras.map(camera => camera.status).join(','),
              status_novo: group.cameras.map(camera => camera.status).join(','),
              instance_id: instanceId
            }, tenantId);
            for (const camera of group.cameras) {
              await db.updateCamera(camera.id, {
                tentativas: (Number(camera.tentativas) || 0) + 1,
                ultima_cobranca: timestamp
              }, tenantId);
            }
            unconfirmed++;
            continue;
          }
          await db.addLog({
            timestamp,
            camera_id: group.cameras.map(camera => camera.id).join(','),
            camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
            responsavel_telefone: group.phone,
            acao: 'COBRANCA_ENVIADA',
            detalhe: `Bot de câmeras offline; tentativa ${attempts}`,
            status_anterior: group.cameras.map(camera => camera.status).join(','),
            status_novo: 'Aguardando resposta',
            instance_id: instanceId
          }, tenantId);
          for (const camera of group.cameras) {
            await db.updateCamera(camera.id, {
              status: 'Aguardando resposta',
              tentativas: (Number(camera.tentativas) || 0) + 1,
              ultima_cobranca: timestamp
            }, tenantId);
          }
          sent++;
        } catch (error) {
          failed++;
          console.error('[Bot Cobrança] Falha ao enviar mensagem:', error.message);
          await db.addLog({
            timestamp: new Date().toISOString(),
            camera_id: group.cameras.map(camera => camera.id).join(','),
            camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
            responsavel_telefone: group.phone,
            acao: 'ERRO',
            detalhe: error.message,
            status_anterior: '',
            status_novo: '',
            instance_id: instanceId
          }, tenantId);
        }
      } finally {
        campaignsInProgress.delete(lockKey);
      }
    }
    return { sent, failed, unconfirmed, ...(pending ? { pending } : {}) };
  }

  async function runMaintenanceBot({ now = new Date(), force = false, tenantId = 'default', instanceId = 'default' } = {}) {
    const config = await getConfig(tenantId);
    if (!force && config.auto_mode === 'false') return { sent: 0, skipped: 'automatic mode disabled' };
    if (!force && !isBusinessHours(config, now)) return { sent: 0, skipped: 'outside business hours' };

    const instance = waFor({ tenantId, instanceId });
    const cameras = await db.getCameras(tenantId);
    const groups = groupByPhone(cameras.filter(camera => String(camera.status || '').trim() === 'Pendente'));
    let sent = 0;
    let failed = 0;
    let unconfirmed = 0;
    let pending = 0;
    for (const group of groups) {
      const lockKey = campaignKey(group.phone, { tenantId, instanceId });
      if (campaignsInProgress.has(lockKey)) continue;
      campaignsInProgress.add(lockKey);
      try {
        if (!(await canSendCampaign(group.phone, tenantId))) continue;
        if (await hasRecentSend(group.phone, ['COBRANCA_ENVIADA', 'LEMBRETE_MANUTENCAO', 'ENVIO_SEM_CONFIRMACAO', 'ENVIO_AGUARDANDO_CONFIRMACAO', 'ERRO'], new Date(now.getTime() - 24 * 60 * 60 * 1000), tenantId)) continue;
        const cameraList = group.cameras.map(camera => `• ${camera.camera_nome || camera.id}${camera.local ? ` (${camera.local})` : ''}`).join('\n');
        try {
          const result = await instance.sendWithOptions(
            group.phone,
            `Lembrete do Sentry: estas câmeras estão offline:\n${cameraList}\nComo prefere prosseguir? Toque em uma opção abaixo para atualizar o status.`,
            undefined,
            undefined,
            { tenantId, instanceId, cameraIds: group.cameras.map(camera => camera.id) }
          );
          if (result?.deliveryStatus === 'pendente') {
            await db.addLog({
              timestamp: now.toISOString(),
              camera_id: group.cameras.map(camera => camera.id).join(','),
              camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
              responsavel_telefone: group.phone,
              acao: 'ENVIO_AGUARDANDO_CONFIRMACAO',
              detalhe: `Lembrete ${result.id || 'sem ID'} aceito pela Cloud API; aguardando confirmação de entrega`,
              status_anterior: 'Pendente',
              status_novo: 'Pendente',
              instance_id: instanceId
            }, tenantId);
            pending++;
            continue;
          }
          if (result?.deliveryStatus === 'unconfirmed') {
            await db.addLog({
              timestamp: now.toISOString(),
              camera_id: group.cameras.map(camera => camera.id).join(','),
              camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
              responsavel_telefone: group.phone,
              acao: 'ENVIO_SEM_CONFIRMACAO',
              detalhe: 'WhatsApp aceitou o lembrete, mas nao confirmou a entrega',
              status_anterior: 'Pendente',
              status_novo: 'Pendente',
              instance_id: instanceId
            }, tenantId);
            unconfirmed++;
            continue;
          }
          await db.addLog({
            timestamp: now.toISOString(),
            camera_id: group.cameras.map(camera => camera.id).join(','),
            camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
            responsavel_telefone: group.phone,
            acao: 'LEMBRETE_MANUTENCAO',
            detalhe: 'Lembrete de câmeras offline enviado',
            status_anterior: 'Pendente',
            status_novo: 'Pendente',
            instance_id: instanceId
          }, tenantId);
          sent++;
        } catch (error) {
          failed++;
          console.error('[Bot Manutenção] Falha ao enviar mensagem:', error.message);
          await db.addLog({
            timestamp: new Date().toISOString(),
            camera_id: group.cameras.map(camera => camera.id).join(','),
            camera_nome: group.cameras.map(camera => camera.camera_nome).join(', '),
            responsavel_telefone: group.phone,
            acao: 'ERRO',
            detalhe: error.message,
            status_anterior: '',
            status_novo: '',
            instance_id: instanceId
          }, tenantId);
        }
      } finally {
        campaignsInProgress.delete(lockKey);
      }
    }
    return { sent, failed, unconfirmed, ...(pending ? { pending } : {}) };
  }

  async function onIncomingMessage(jid, text, options = {}) {
    const tenantId = options.tenantId || 'default';
    const instanceId = options.instanceId || 'default';
    const instance = waFor({ tenantId, instanceId });
    const phone = normalizePhone(jid);
    const key = contactKey(jid);
    if (!phone || !key) return;
    const action = parseReply(text);
    const cameras = (await db.getCameras(tenantId))
      .filter(camera => contactKey(camera.responsavel_telefone) === key);
    const phones = [...new Set([
      phone,
      ...cameras.map(camera => normalizePhone(camera.responsavel_telefone)).filter(Boolean)
    ])];

    if (action?.intent === 'opt_out') {
      for (const target of phones) {
        await db.setConsent(target, false, tenantId);
        await db.block(target, 'Opt-out solicitado por WhatsApp', tenantId);
      }
      await instance.sendMessage(phone, 'Tudo certo. Voce nao recebera mais mensagens automaticas. Para voltar a receber, entre em contato com a equipe.');
      return;
    }

    for (const target of phones) {
      if (await db.isBlocked(target, tenantId)) return;
    }
    const config = await getConfig(tenantId);
    if (!cameras.length) return;
    if (!action) return;

    if (action.status) {
      const active = cameras.filter(camera => camera.status !== 'Resolvido');
      if (!active.length) {
        await instance.sendMessage(phone, 'No momento, nao ha cameras pendentes vinculadas a este numero.');
        return;
      }
      const previousStatus = [...new Set(active.map(camera => camera.status || ''))].join(',');
      const timestamp = new Date().toISOString();
      for (const camera of active) {
        await db.updateCamera(camera.id, {
          status: action.status,
          observacoes: [camera.observacoes, `Resposta WhatsApp: ${String(text).slice(0, 300)}`].filter(Boolean).join(' | '),
          ...(action.status === 'Aguardando validacao' ? { data_resolucao: timestamp.slice(0, 10) } : {})
        }, tenantId);
      }
      await db.addLog({
        timestamp,
        camera_id: active.map(camera => camera.id).join(','),
        camera_nome: active.map(camera => camera.camera_nome).join(', '),
        responsavel_telefone: phone,
        acao: 'RESPOSTA_RECEBIDA',
        detalhe: String(text).slice(0, 500),
        status_anterior: previousStatus,
        status_novo: action.status,
        instance_id: instanceId
      }, tenantId);
    }

    if (action.reply && config.auto_mode !== 'false') await instance.sendMessage(phone, action.reply);
  }

  async function startSchedulers() {
    if (scheduler) return getSchedulerStatus();
    scheduler = schedulerApi.schedule('0 * * * 1-5', async () => {
      try {
        const rows = listInstances ? await listInstances() : [];
        const contexts = rows.length
          ? rows.map(row => ({
              tenantId: row.tenant_id || row.tenantId || 'default',
              instanceId: row.instance_id || row.instanceId || 'default'
            }))
          : [{ tenantId: 'default', instanceId: 'default' }];
        const hour = localHour();
        for (const context of contexts) {
          const config = await getConfig(context.tenantId);
          if (config.auto_mode === 'false') continue;
          if (hour === parseHour(config.billing_hour, 9)) await runBillingBot(context);
          if (hour === parseHour(config.maintenance_hour, 17)) await runMaintenanceBot(context);
        }
      } catch (error) {
        console.error('[Scheduler] Falha na execucao dos bots:', error.message);
      }
    }, { timezone: TIME_ZONE });
    console.log(`[Bots] Agendador iniciado (${TIME_ZONE})`);
    return getSchedulerStatus();
  }

  function getSchedulerStatus() {
    return scheduler ? 'active' : 'inactive';
  }

  return {
    startSchedulers,
    runBillingBot,
    runMaintenanceBot,
    onIncomingMessage,
    getSchedulerStatus,
    groupByPhone,
    groupByResponsible: groupByPhone
  };
}

const defaultBots = createBots();
module.exports = {
  ...defaultBots,
  createBots,
  parseReply,
  localHour
};
