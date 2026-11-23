// Webhook HMAC do servidor Baileys. Registrado antes do express.json e antes
// do middleware de login: a autenticação aqui é a assinatura, não a sessão.
const crypto = require('node:crypto');
const express = require('express');

const STATUS_PERMITIDOS = new Set(['enviada', 'entregue', 'lida', 'erro', 'falhou', 'pendente']);
const STATUS_BANCO = { erro: 'falhou', falhou: 'falhou' };

function assinaturaValida(rawBody, Assinatura, secret) {
  if (!secret || !Assinatura) return false;
  const recebida = String(Assinatura).startsWith('sha256=')
    ? String(Assinatura).slice(7)
    : String(Assinatura);
  if (!/^[a-f0-9]{64}$/i.test(recebida)) return false;
  const esperada = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const recebidaBuffer = Buffer.from(recebida, 'hex');
  return esperada.length === recebidaBuffer.length && crypto.timingSafeEqual(esperada, recebidaBuffer);
}

function payloadSeguro(payload) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};
  return {
    tenantId: String(metadata.tenantId || 'default').slice(0, 80),
    instanceId: String(metadata.instanceId || 'default').slice(0, 80),
    cameraIds: Array.isArray(metadata.cameraIds)
      ? metadata.cameraIds.slice(0, 50).map(id => String(id).slice(0, 120))
      : []
  };
}

async function registrarStatus(db, payload, logger) {
  const id = String(payload.id || '').slice(0, 200);
  const status = STATUS_BANCO[payload.status] || payload.status;
  const tenantId = payloadSeguro(payload).tenantId;
  const motivo = payload.motivo ? String(payload.motivo).slice(0, 1000) : null;
  const anterior = db.getDeliveries
    ? (await db.getDeliveries([id], tenantId))[0] || null
    : null;
  const cameraIds = payloadSeguro(payload).cameraIds.length
    ? payloadSeguro(payload).cameraIds
    : anterior?.cameraIds || [];

  if (!anterior && db.registerDelivery) {
    await db.registerDelivery({
      id,
      tenantId,
      instanceId: payloadSeguro(payload).instanceId,
      jid: payload.jid || null,
      cameraIds: payloadSeguro(payload).cameraIds,
      texto: null,
      status: 'pendente',
      createdAt: payload.timestamp || new Date().toISOString()
    }, tenantId);
  }

  if (db.updateDeliveryStatus) {
    await db.updateDeliveryStatus(id, status, motivo, tenantId);
  }

  if (status === 'falhou' && db.addLog) {
    await db.addLog({
      timestamp: new Date().toISOString(),
      camera_id: payloadSeguro(payload).cameraIds.join(','),
      acao: 'ENVIO_FALHOU',
      detalhe: `Mensagem ${id}: ${motivo || 'falha sem motivo informado'}`,
      status_anterior: anterior?.status || 'pendente',
      status_novo: 'falhou'
    }, tenantId);
  }

  // Só promove a câmera quando o telefone confirma a entrega — nunca no 202 da fila.
  if (status === 'entregue' && anterior && !['entregue', 'lida'].includes(anterior.status)) {
    if (cameraIds.length && db.getCameras && db.updateCamera) {
      const cameras = await db.getCameras(tenantId);
      const agora = new Date().toISOString();
      for (const cameraId of cameraIds) {
        const camera = cameras.find(item => String(item.id) === String(cameraId));
        if (!camera || !['offline', 'Pendente', 'Verificando', 'analisando'].includes(camera.status)) continue;
        await db.updateCamera(camera.id, {
          status: 'Aguardando resposta',
          tentativas: (Number(camera.tentativas) || 0) + 1,
          ultima_cobranca: agora
        }, tenantId);
      }
      if (db.addLog) {
        await db.addLog({
          timestamp: agora,
          camera_id: cameraIds.join(','),
          acao: 'ENTREGA_CONFIRMADA',
          detalhe: `Entrega confirmada pelo WhatsApp para a mensagem ${id}`,
          status_anterior: 'offline',
          status_novo: 'Aguardando resposta'
        }, tenantId);
      }
    }
  }
  logger.info({ event: 'webhook.status', id, status, tenantId, cameraIds: payloadSeguro(payload).cameraIds.length });
}

async function registrarMensagem(db, payload, app, logger) {
  const tenantId = 'default';
  const jid = String(payload.remetente || '').slice(0, 300);
  const texto = String(payload.texto || '').slice(0, 4096);
  if (!jid || !texto) return;
  const time = payload.timestamp || new Date().toISOString();
  if (db.upsertConversation) await db.upsertConversation(jid, jid.split('@')[0], texto, time, tenantId);
  if (db.addMessage) {
    await db.addMessage(jid, {
      id: String(payload.id || `in_${Date.now()}`).slice(0, 200),
      from: jid,
      text: texto,
      time,
      direction: 'in'
    }, tenantId);
  }
  if (db.incrementUnread) await db.incrementUnread(jid, tenantId);
  app.io?.emit('wa:newMessage', { instanceId: 'default', tenantId, jid, message: { id: payload.id, text: texto, time, direction: 'in' } });
  logger.info({ event: 'webhook.mensagem', id: payload.id || null, jid: jid.split('@')[0] + '@…' });
}

function registerWebhook(app, { db, secret, logger = console, timeoutMinutes = 15 }) {
  app.use('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '1mb' }));

  app.post('/api/whatsapp/webhook', async (req, res) => {
    if (!secret) {
      return res.status(503).json({ erro: 'WEBHOOK_SECRET não configurado no painel' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!assinaturaValida(raw, req.get('x-webhook-signature'), secret)) {
      logger.warn({ event: 'webhook.assinatura_invalida' });
      return res.status(401).json({ erro: 'Assinatura inválida' });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ erro: 'JSON inválido' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ erro: 'Payload inválido' });
    }
    try {
      if (payload.tipo === 'status') {
        if (!payload.id || !STATUS_PERMITIDOS.has(payload.status)) {
          return res.status(400).json({ erro: 'Evento de status inválido' });
        }
        await registrarStatus(db, payload, logger);
      } else if (payload.tipo === 'mensagem') {
        await registrarMensagem(db, payload, app, logger);
      } else {
        return res.status(400).json({ erro: 'Tipo de evento desconhecido' });
      }
      return res.json({ ok: true });
    } catch (error) {
      logger.error({ event: 'webhook.erro', erro: error.message });
      return res.status(500).json({ erro: 'Falha ao processar webhook' });
    }
  });
}

module.exports = { registerWebhook, registrarStatus, assinaturaValida, STATUS_PERMITIDOS, STATUS_BANCO };
