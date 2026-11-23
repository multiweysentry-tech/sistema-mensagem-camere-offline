const { normalizarContato } = require('../phone-utils');
const { OPTION_BUTTONS } = require('../wa-options');

const DEFAULT_GRAPH_VERSION = 'v27.0';

function isConfigured(env = process.env) {
  return Boolean(
    String(env.META_WA_ACCESS_TOKEN || '').trim() &&
    String(env.META_WA_PHONE_NUMBER_ID || '').trim()
  );
}

function createMetaWhatsapp(options = {}) {
  const env = options.env || process.env;
  const accessToken = String(options.accessToken || env.META_WA_ACCESS_TOKEN || '').trim();
  const phoneNumberId = String(options.phoneNumberId || env.META_WA_PHONE_NUMBER_ID || '').trim();
  const graphVersion = String(options.graphVersion || env.META_WA_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();
  const templateName = String(options.templateName || env.META_WA_TEMPLATE_NAME || '').trim();
  const templateLanguage = String(options.templateLanguage || env.META_WA_TEMPLATE_LANGUAGE || 'pt_BR').trim();
  const appSecret = String(options.appSecret || env.META_WA_APP_SECRET || '').trim();
  const verifyToken = String(options.verifyToken || env.META_WA_VERIFY_TOKEN || '').trim();
  const tenantId = String(options.tenantId || env.META_WA_TENANT_ID || 'default').trim();
  const timeoutMs = Number(options.timeoutMs || env.META_WA_TIMEOUT_MS || (env.VERCEL ? 7000 : 15000));
  const fetchImpl = options.fetch || globalThis.fetch;
  const db = options.db || null;
  let io = null;

  if (!accessToken || !phoneNumberId) {
    throw new Error('META_WA_ACCESS_TOKEN e META_WA_PHONE_NUMBER_ID são obrigatórios para WHATSAPP_PROVIDER=meta');
  }
  if (!/^v\d+\.\d+$/.test(graphVersion)) {
    throw new Error('META_WA_GRAPH_VERSION deve estar no formato v27.0');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('META_WA_TIMEOUT_MS deve ser um inteiro entre 1000 e 60000');
  }
  if (env.VERCEL && timeoutMs > 7000) {
    throw new Error('META_WA_TIMEOUT_MS não pode passar de 7000 no Vercel');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível neste runtime');

  async function graphPost(payload) {
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new Error(`Não foi possível acessar a WhatsApp Cloud API: ${error.message}`, { cause: error });
    }

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`A WhatsApp Cloud API retornou uma resposta inválida (HTTP ${response.status})`, { cause: error });
    }
    if (!response.ok) {
      const detail = data.error?.message || `HTTP ${response.status}`;
      const code = data.error?.code ? ` (código ${data.error.code})` : '';
      throw new Error(`WhatsApp Cloud API: ${detail}${code}`);
    }

    const id = data.messages?.[0]?.id;
    if (!id) throw new Error('WhatsApp Cloud API não retornou o ID da mensagem');
    return { id };
  }

  async function finishSend(result, to, text, metadata = {}) {
    const tenantId = String(metadata.tenantId || 'default');
    const instanceId = String(metadata.instanceId || 'default');
    const phone = normalizarContato(to);
    const jid = `${phone}@s.whatsapp.net`;
    const createdAt = new Date().toISOString();
    if (db?.registerDelivery) {
      await db.registerDelivery({
        id: result.id,
        tenantId,
        instanceId,
        jid,
        cameraIds: Array.isArray(metadata.cameraIds) ? metadata.cameraIds.slice(0, 50).map(String) : [],
        texto: String(text).slice(0, 4096),
        status: 'pendente',
        createdAt
      }, tenantId);
    }
    if (db?.upsertConversation) {
      await db.upsertConversation(jid, phone, String(text).slice(0, 200), createdAt, tenantId, instanceId);
    }
    if (db?.addMessage) {
      await db.addMessage(jid, {
        id: result.id,
        from: jid,
        text: String(text).slice(0, 4096),
        time: createdAt,
        direction: 'out',
        status: 'pendente'
      }, tenantId, instanceId);
    }
    io?.emit('wa:newMessage', {
      tenantId,
      instanceId,
      jid,
      message: { id: result.id, from: jid, text: String(text).slice(0, 4096), time: createdAt, direction: 'out', status: 'pendente' },
      conversation: { jid, name: phone, lastMessage: String(text).slice(0, 200), lastTime: createdAt }
    });
    return {
      ok: true,
      id: result.id,
      number: phone,
      jid,
      remote: true,
      deliveryStatus: 'pendente'
    };
  }

  function normalizeRecipient(to) {
    const phone = normalizarContato(to);
    if (!/^\d{10,15}$/.test(phone)) throw new Error('Telefone de destino inválido');
    return phone;
  }

  async function sendMessage(to, text, metadata = {}) {
    const phone = normalizeRecipient(to);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Mensagem inválida (limite de 4096 caracteres)');
    }
    const result = await graphPost({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: text.trim() }
    });
    return finishSend(result, phone, text.trim(), metadata);
  }

  async function sendWithOptions(to, text, buttons, _footer, metadata = {}) {
    const phone = normalizeRecipient(to);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Mensagem inválida (limite de 4096 caracteres)');
    }
    if (!templateName) {
      throw new Error('Configure META_WA_TEMPLATE_NAME com o nome de um template Utility aprovado contendo {{1}} e os três botões rápidos do Sentry');
    }
    const selectedButtons = Array.isArray(buttons) && buttons.length ? buttons : OPTION_BUTTONS;
    const matchesStandardButtons = selectedButtons.length === OPTION_BUTTONS.length &&
      selectedButtons.every((button, index) =>
        String(button?.id || '') === OPTION_BUTTONS[index].id &&
        String(button?.text || '').trim() === OPTION_BUTTONS[index].text
      );
    if (!matchesStandardButtons) {
      throw new Error('A WhatsApp Cloud API exige um template aprovado com os três botões padrão do Sentry');
    }
    const cameras = [...text.matchAll(/^•\s*(.+)$/gm)].map(match => match[1].trim()).filter(Boolean);
    if (!cameras.length) throw new Error('A notificação do WhatsApp deve conter ao menos uma câmera em linha iniciada por •');
    const cameraList = cameras.join(', ');
    if (cameraList.length > 900) {
      throw new Error('A lista de câmeras excede o limite seguro do template WhatsApp; divida o envio em grupos menores');
    }

    const components = [
      { type: 'body', parameters: [{ type: 'text', text: cameraList }] },
      ...OPTION_BUTTONS.map((button, index) => ({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: button.id }]
      }))
    ];
    const result = await graphPost({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components
      }
    });
    return finishSend(result, phone, text.trim(), metadata);
  }

  return {
    provider: 'meta',
    remote: true,
    setIO(socketServer) { io = socketServer; },
    getStatus: () => ({
      status: 'configured',
      provider: 'meta',
      remote: true,
      qr: null,
      phone: null,
      error: null
    }),
    async connect() {
      throw new Error('WhatsApp Cloud API não usa QR Code; gerencie a conexão no WhatsApp Manager');
    },
    async disconnect() {
      throw new Error('WhatsApp Cloud API não possui sessão local para desconectar');
    },
    async refreshQR() {
      throw new Error('WhatsApp Cloud API não usa QR Code');
    },
    async checkNumber(to) {
      const phone = normalizeRecipient(to);
      return { phone, exists: null, jid: `${phone}@s.whatsapp.net` };
    },
    sendMessage,
    sendButtons: sendWithOptions,
    sendWithOptions,
    webhookConfig: { secret: appSecret, verifyToken, phoneNumberId, tenantId }
  };
}

module.exports = { createMetaWhatsapp, isConfigured, DEFAULT_GRAPH_VERSION };
