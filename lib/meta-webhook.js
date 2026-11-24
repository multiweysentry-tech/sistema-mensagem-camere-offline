const crypto = require('node:crypto');
const express = require('express');
const { normalizarContato } = require('../phone-utils');
const { registrarStatus } = require('./webhook');

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function signatureIsValid(body, signature, secret) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(signature || ''));
  if (!match || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(match[1], 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function datafySignatureIsValid(body, signature, timestamp, secret, now = Date.now()) {
  const seconds = Number(timestamp);
  if (!secret || !Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 300) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(signature || ''));
  if (!match) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const received = Buffer.from(match[1], 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function textFromMessage(message = {}) {
  if (message.type === 'text') return String(message.text?.body || '');
  if (message.type === 'button') return String(message.button?.payload || message.button?.text || '');
  if (message.type === 'interactive') {
    const response = message.interactive?.button_reply || message.interactive?.list_reply;
    return String(response?.id || response?.title || '');
  }
  return '';
}

function deliveryStatus(status) {
  return ({ sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' })[status] || null;
}

function createLogger(logger, level, event, fields) {
  if (typeof logger[level] === 'function') logger[level]({ event, ...fields });
}

function registerMetaWebhook(app, {
  db,
  bots,
  secret = '',
  verifyToken = '',
  phoneNumberId = '',
  tenantId = 'default',
  logger = console,
  route = '/api/whatsapp/meta/webhook',
  signatureValidator = (body, req) => signatureIsValid(body, req.get('x-hub-signature-256'), secret),
  providerName = 'Meta',
  enableHandshake = true
}) {
  app.use(route, express.raw({ type: '*/*', limit: '1mb' }));

  if (enableHandshake) {
    app.get(route, (req, res) => {
      if (!verifyToken) return res.status(503).send('META_WA_VERIFY_TOKEN não configurado');
      const mode = req.query['hub.mode'];
      const received = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && received && safeEqual(received, verifyToken) && challenge) {
        return res.status(200).type('text/plain').send(String(challenge));
      }
      return res.sendStatus(403);
    });
  }

  app.post(route, async (req, res) => {
    if (!secret) return res.status(503).json({ erro: `Segredo do webhook ${providerName} não configurado` });
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!signatureValidator(rawBody, req)) {
      createLogger(logger, 'warn', `${providerName.toLowerCase()}.webhook_signature_invalid`, {});
      return res.status(401).json({ erro: `Assinatura ${providerName} inválida` });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ erro: 'JSON inválido' });
    }
    if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      return res.status(400).json({ erro: 'Evento WhatsApp inválido' });
    }

    try {
      for (const entry of payload.entry) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const actualPhoneId = String(value.metadata?.phone_number_id || '');
          if (phoneNumberId && actualPhoneId !== phoneNumberId) continue;

          for (const status of value.statuses || []) {
            const mappedStatus = deliveryStatus(status.status);
            if (!mappedStatus || !status.id) continue;
            const recipient = normalizarContato(status.recipient_id);
            const delivery = db.findDeliveryByExternalId
              ? await db.findDeliveryByExternalId(status.id)
              : null;
            await registrarStatus(db, {
              id: status.id,
              status: mappedStatus,
              timestamp: status.timestamp
                ? new Date(Number(status.timestamp) * 1000).toISOString()
                : new Date().toISOString(),
              jid: recipient ? `${recipient}@s.whatsapp.net` : null,
              motivo: status.errors?.map(error => error.title || error.message).filter(Boolean).join('; ') || null,
              metadata: {
                tenantId: delivery?.tenantId || tenantId,
                instanceId: delivery?.instanceId || 'default',
                cameraIds: delivery?.cameraIds || []
              }
            }, logger);
          }

          for (const message of value.messages || []) {
            const phone = normalizarContato(message.from);
            const text = textFromMessage(message).trim();
            if (!phone || !text) continue;
            const instanceId = 'default';
            const jid = `${phone}@s.whatsapp.net`;
            const timestamp = message.timestamp
              ? new Date(Number(message.timestamp) * 1000).toISOString()
              : new Date().toISOString();
            const contact = (value.contacts || []).find(item => normalizarContato(item.wa_id) === phone);
            const name = String(contact?.profile?.name || phone).slice(0, 200);
            const entryMessage = {
              id: String(message.id || `meta_${Date.now()}`).slice(0, 200),
              from: jid,
              text: text.slice(0, 4096),
              time: timestamp,
              direction: 'in'
            };
            await db.upsertConversation(jid, name, entryMessage.text, timestamp, tenantId, instanceId);
            const inserted = await db.addMessage(jid, entryMessage, tenantId, instanceId);
            if (inserted === false) continue;
            await db.incrementUnread(jid, tenantId, instanceId);
            app.io?.emit('wa:newMessage', {
              instanceId,
              tenantId,
              jid,
              message: entryMessage,
              conversation: { jid, name, lastMessage: entryMessage.text, lastTime: timestamp }
            });
            if (bots?.onIncomingMessage) {
              await bots.onIncomingMessage(jid, text, { tenantId, instanceId });
            }
          }
        }
      }
      return res.json({ ok: true });
    } catch (error) {
      createLogger(logger, 'error', `${providerName.toLowerCase()}.webhook_processing_failed`, { error: error.message });
      return res.status(500).json({ erro: `Falha ao processar webhook ${providerName}` });
    }
  });
}

module.exports = { registerMetaWebhook, signatureIsValid, datafySignatureIsValid, textFromMessage, deliveryStatus };
