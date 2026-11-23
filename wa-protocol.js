// Protocolo puro do WhatsApp: funcoes sem estado de conexao.
// Este arquivo nao cria sockets e pode ser usado por qualquer instancia.
const { proto } = require('@whiskeysockets/baileys');
const { randomBytes } = require('crypto');

const deliveryAckStatus = proto.WebMessageInfo.Status.DELIVERY_ACK;
const errorStatus = proto.WebMessageInfo.Status.ERROR;
const deliveryWaiters = new Map();

const OPTION_BUTTONS = [
  { id: '1', text: 'Estou verificando' },
  { id: '2', text: 'Preciso de suporte' },
  { id: '3', text: 'Já resolvi' }
];
const OPTION_FOOTER = 'Escolha uma opção. PARAR encerra as mensagens.';

function interactiveReplyText(message = {}) {
  const response = message.interactiveResponseMessage;
  if (!response) return '';
  const params = response.nativeFlowResponseMessage?.paramsJson;
  if (params) {
    try {
      const parsed = JSON.parse(params);
      const legacyIds = { op_1: '1', op_2: '2', op_3: '3' };
      if (parsed?.id) return legacyIds[parsed.id] || String(parsed.id);
      if (parsed?.display_text) return String(parsed.display_text);
    } catch (error) {
      // Formato desconhecido: usa o texto simples, se houver.
    }
  }
  return response.body?.text || '';
}

function textFromMessage(message = {}) {
  const content = message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;
  return interactiveReplyText(content) || content.conversation ||
    content.extendedTextMessage?.text ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedId ||
    content.listResponseMessage?.title ||
    content.interactiveResponseMessage?.body?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    '';
}

function waitForDeliveryAck(messageId, timeoutMs = 12000) {
  let settle;
  let settled = false;
  let timer;
  const promise = new Promise((resolve, reject) => {
    settle = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deliveryWaiters.delete(messageId);
      if (error) reject(error);
      else resolve(status);
    };
    deliveryWaiters.set(messageId, status => {
      if (status === errorStatus) settle(new Error('WhatsApp rejeitou a mensagem'));
      else if (status >= deliveryAckStatus) settle(null, status);
    });
    timer = setTimeout(() => {
      const error = new Error('WhatsApp aceitou o envio, mas nao confirmou a entrega em 12 segundos');
      error.code = 'DELIVERY_UNCONFIRMED';
      settle(error);
    }, timeoutMs);
  });
  return {
    promise,
    cancel() {
      if (!settled) settle(null, null);
    }
  };
}

function handleDeliveryStatus(messageId, status) {
  deliveryWaiters.get(messageId)?.(Number(status));
}

function shouldProcessStatusUpdate(key, update) {
  // ACKs de entrega/leitura chegam com fromMe=false; nao filtrar por ele.
  return Boolean(key?.id) && update?.status !== undefined;
}

function statusFromReceiptNode(node) {
  const attrs = node?.attrs || {};
  if (attrs.error) return errorStatus;
  const statusByType = {
    sender: proto.WebMessageInfo.Status.SERVER_ACK,
    read: proto.WebMessageInfo.Status.READ,
    'read-self': proto.WebMessageInfo.Status.READ,
    played: proto.WebMessageInfo.Status.PLAYED
  };
  // Receipt sem "type" e o ACK de entrega do aparelho destinatario.
  return Object.prototype.hasOwnProperty.call(statusByType, attrs.type)
    ? statusByType[attrs.type]
    : attrs.type === undefined ? deliveryAckStatus : null;
}

async function resolveDirectPhoneJid(key, lidMapping) {
  const remoteJid = String(key?.remoteJid || '');
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;
  const alternateJid = String(key?.remoteJidAlt || '');
  if (/^\d+@s\.whatsapp\.net$/.test(alternateJid)) return alternateJid;
  if (!remoteJid.endsWith('@lid')) return remoteJid;
  if (typeof lidMapping?.getPNForLID !== 'function') return null;
  const mappedJid = await lidMapping.getPNForLID(remoteJid);
  return typeof mappedJid === 'string' && /^\d+@s\.whatsapp\.net$/.test(mappedJid)
    ? mappedJid
    : null;
}

function normalizeDestination(to) {
  const destination = String(to || '');
  const raw = (destination.includes('@') ? destination.split('@')[0] : destination).replace(/\D/g, '');
  const digits = /^\d{10,11}$/.test(raw) && !raw.startsWith('55') ? `55${raw}` : raw;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

function findExistingNumber(results) {
  return results.find(entry => entry?.exists) || null;
}

function createInteractiveMessage(text, buttons, footer) {
  const items = (Array.isArray(buttons) ? buttons : []).slice(0, 3).map((button, index) => ({
    id: String(button?.id || `op_${index + 1}`),
    text: String(button?.text || '').trim().slice(0, 20)
  })).filter(button => button.text);
  if (items.length < 2) throw new Error('Informe ao menos duas opções clicáveis');

  return proto.Message.create({
    interactiveMessage: proto.Message.InteractiveMessage.create({
      body: { text: text.trim() },
      footer: { text: String(footer || OPTION_FOOTER).trim().slice(0, 60) },
      nativeFlowMessage: {
        buttons: items.map(button => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: button.text, id: button.id })
        })),
        messageParamsJson: JSON.stringify({ from: 'api', templateId: randomBytes(8).toString('hex') }),
        messageVersion: 3
      }
    })
  });
}

function interactiveRelayNodes() {
  // O no <biz> e necessario para renderizar os botoes clicaveis.
  // O no <bot biz_bot="1"> NAO deve ser enviado: suprime o receipt de entrega.
  return [{
    tag: 'biz',
    attrs: {
      actual_actors: '2',
      host_storage: '2',
      privacy_mode_ts: String(Math.floor(Date.now() / 1000))
    },
    content: [
      {
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
      },
      {
        tag: 'quality_control',
        attrs: { decision_id: randomBytes(20).toString('hex'), source_type: 'third_party' },
        content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
      }
    ]
  }];
}

module.exports = {
  OPTION_BUTTONS,
  OPTION_FOOTER,
  deliveryAckStatus,
  errorStatus,
  interactiveReplyText,
  textFromMessage,
  waitForDeliveryAck,
  handleDeliveryStatus,
  shouldProcessStatusUpdate,
  statusFromReceiptNode,
  resolveDirectPhoneJid,
  normalizeDestination,
  findExistingNumber,
  createInteractiveMessage,
  interactiveRelayNodes
};
