const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const logger = pino({ level: 'silent' });
const db = require('./db');

let sock = null;
let connectionStatus = 'disconnected';
let qrDataUrl = null;
let phoneNumber = null;
let lastError = null;
let io = null;
let connectionPromise = null;
let reconnectTimer = null;
let manuallyDisconnected = false;
let socketGeneration = 0;
const deliveryWaiters = new Map();
const deliveryAckStatus = proto.WebMessageInfo.Status.DELIVERY_ACK;
const errorStatus = proto.WebMessageInfo.Status.ERROR;

// Os IDs precisam ser entendidos tambem pelo parseReply() dos bots.
const OPTION_BUTTONS = [
  { id: '1', text: 'Estou verificando' },
  { id: '2', text: 'Preciso de suporte' },
  { id: '3', text: 'Já resolvi' }
];
const OPTION_FOOTER = 'Escolha uma opção. PARAR encerra as mensagens.';

function setIO(ioInstance) {
  io = ioInstance;
}

function getStatus() {
  return { status: connectionStatus, qr: qrDataUrl, phone: phoneNumber, error: lastError };
}

function emitStatus() {
  if (io) io.emit('wa:status', getStatus());
}

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
      // Resposta em formato desconhecido: usa o texto simples, se houver.
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

async function connect() {
  if (connectionStatus === 'open' || connectionStatus === 'qr') return getStatus();
  if (sock && connectionStatus === 'connecting') return getStatus();
  if (connectionPromise) return connectionPromise;

  manuallyDisconnected = false;
  lastError = null;
  connectionStatus = 'connecting';
  emitStatus();
  connectionPromise = (async () => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const generation = ++socketGeneration;
    const socket = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Sentry Central', 'Chrome', '1.0.0']
    });
    sock = socket;

    socket.ev.on('creds.update', () => {
      saveCreds().catch(error => console.error('[WhatsApp] Falha ao salvar credenciais locais:', error.message));
    });
    socket.ev.on('connection.update', async update => {
      if (generation !== socketGeneration) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          qrDataUrl = await QRCode.toDataURL(qr);
          if (generation !== socketGeneration) return;
          connectionStatus = 'qr';
          lastError = null;
          emitStatus();
        } catch (error) {
          lastError = `Nao foi possivel gerar o QR Code: ${error.message}`;
          connectionStatus = 'disconnected';
          emitStatus();
        }
      }

      if (connection === 'connecting') {
        connectionStatus = 'connecting';
        emitStatus();
      } else if (connection === 'open') {
        connectionStatus = 'open';
        qrDataUrl = null;
        lastError = null;
        phoneNumber = String(socket.user?.id || '').split(':')[0].split('@')[0] || null;
        emitStatus();
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = !manuallyDisconnected && statusCode !== DisconnectReason.loggedOut;
        if (sock === socket) sock = null;
        connectionStatus = 'disconnected';
        qrDataUrl = null;
        phoneNumber = null;
        if (!shouldReconnect && statusCode === DisconnectReason.loggedOut) {
          lastError = 'A sessao do WhatsApp foi encerrada. Gere um novo QR Code para conectar.';
        }
        emitStatus();
        if (shouldReconnect && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch(error => {
              console.error('[WhatsApp] Falha ao reconectar:', error.message);
            });
          }, 3000);
        }
      }
    });

    socket.ev.on('messages.update', async updates => {
      for (const { key, update } of updates || []) {
        // Baileys 7 entrega os ACKs de entrega/leitura com fromMe=false:
        // o receipt vem do aparelho destinatario, nao do nosso numero.
        if (!shouldProcessStatusUpdate(key, update)) continue;
        handleDeliveryStatus(key.id, update.status);
        let pn = null;
        try {
          pn = await socket.signalRepository?.lidMapping?.getPNForLID(key.remoteJid);
        } catch (error) {
          pn = null;
        }
        console.log(
          `[WhatsApp] ACK ${key.remoteJid} de=${key.fromMe ? 'sim' : 'nao'} pn=${pn || '-'} ${key.id} status=${update.status}`
        );
      }
    });

    // Segunda via: alguns builds do Baileys 7 nao repassam todos os receipts
    // como messages.update. O callback bruto roda antes do evento de alto nivel.
    socket.ws?.on?.('CB:receipt', node => {
      const id = node?.attrs?.id;
      const status = statusFromReceiptNode(node);
      if (!id || status === null || !deliveryWaiters.has(id)) return;
      handleDeliveryStatus(id, status);
      console.log(`[WhatsApp] RECEIPT bruto ${node.attrs.from || '-'} ${id} status=${status}`);
    });

    socket.ev.on('messages.upsert', async event => {
      for (const message of event.messages || []) {
        if (!message.message) continue;
        const jid = message.key?.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const text = textFromMessage(message.message);
        const timestamp = new Date(Number(message.messageTimestamp || Date.now() / 1000) * 1000).toISOString();
        const entry = {
          id: message.key.id || `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          from: jid,
          text,
          time: timestamp,
          direction: message.key.fromMe ? 'out' : 'in'
        };
        try {
          await db.upsertConversation(jid, message.pushName || jid.split('@')[0], text, timestamp);
          const inserted = await db.addMessage(jid, entry);
          if (!inserted) continue;
          if (!message.key.fromMe) await db.incrementUnread(jid);
          if (io) {
            io.emit('wa:newMessage', {
              jid,
              message: entry,
              conversation: {
                jid,
                name: message.pushName || jid.split('@')[0],
                lastMessage: text,
                lastTime: timestamp
              }
            });
          }
          if (!message.key.fromMe && !jid.endsWith('@g.us') && text) {
            const bots = require('./bots');
            const phoneJid = await resolveDirectPhoneJid(message.key, socket.signalRepository?.lidMapping);
            if (phoneJid) await bots.onIncomingMessage(phoneJid, text);
          }
        } catch (error) {
          console.error('[WhatsApp] Falha ao processar mensagem recebida:', error.message);
        }
      }
    });

    return getStatus();
  })();

  try {
    return await connectionPromise;
  } catch (error) {
    connectionStatus = 'disconnected';
    qrDataUrl = null;
    lastError = error.message;
    emitStatus();
    throw error;
  } finally {
    connectionPromise = null;
  }
}

async function disconnect() {
  manuallyDisconnected = true;
  socketGeneration++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const currentSocket = sock;
  sock = null;
  try {
    if (currentSocket) await currentSocket.logout();
  } catch (error) {
    lastError = `Desconectado, mas houve uma falha ao encerrar a sessao: ${error.message}`;
  } finally {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'disconnected';
    qrDataUrl = null;
    phoneNumber = null;
    if (!lastError) lastError = null;
    emitStatus();
  }
}

function normalizeDestination(to) {
  const destination = String(to || '');
  const raw = (destination.includes('@') ? destination.split('@')[0] : destination).replace(/\D/g, '');
  // Numeros brasileiros de 10/11 digitos precisam do codigo do pais para serem entregues.
  const digits = /^\d{10,11}$/.test(raw) && !raw.startsWith('55') ? `55${raw}` : raw;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

function findExistingNumber(results) {
  return results.find(entry => entry?.exists) || null;
}

async function checkNumber(to) {
  if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
  const digits = normalizeDestination(to);
  if (!digits) throw new Error('Telefone de destino invalido');
  const results = await sock.onWhatsApp(digits) || [];
  const found = findExistingNumber(results);
  return {
    phone: digits,
    exists: Boolean(found),
    jid: found?.jid || `${digits}@s.whatsapp.net`
  };
}

async function resolveDestination(to) {
  const destination = await checkNumber(to);
  if (!destination.exists) throw new Error(`Numero ${destination.phone} nao existe no WhatsApp`);
  return destination;
}

async function recordOutgoing(jid, label, text, id) {
  const entry = {
    id: id || `out_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    from: jid,
    text,
    time: new Date().toISOString(),
    direction: 'out'
  };
  await db.upsertConversation(jid, label || jid.split('@')[0], entry.text, entry.time);
  const inserted = await db.addMessage(jid, entry);
  if (inserted && io) {
    io.emit('wa:newMessage', {
      jid,
      message: entry,
      conversation: {
        jid,
        name: label || jid.split('@')[0],
        lastMessage: entry.text,
        lastTime: entry.time
      }
    });
  }
  return { ok: true, id: entry.id };
}

async function sendMessage(to, text) {
  const { phone: digits, jid } = await resolveDestination(to);
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Mensagem invalida (limite de 4096 caracteres)');
  }

  const result = await sock.sendMessage(jid, { text: text.trim() });
  return recordOutgoing(jid, digits, text.trim(), result?.key?.id);
}

// O Baileys 7 nao expoe "buttons" no sendMessage, mas o protocolo ainda suporta
// interactiveMessage; enviamos o protobuf diretamente pelo relay do socket.
async function sendButtons(to, text, buttons, footer) {
  const { phone: digits, jid } = await resolveDestination(to);
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Mensagem invalida (limite de 4096 caracteres)');
  }
  const userJid = sock.user?.id;
  if (!userJid) throw new Error('Sessao do WhatsApp sem identificador do remetente');
  const generated = generateWAMessageFromContent(
    jid,
    createInteractiveMessage(text, buttons, footer),
    { userJid }
  );
  const messageId = generated.key.id;
  const delivery = waitForDeliveryAck(messageId);
  try {
    await sock.relayMessage(jid, generated.message, {
      messageId,
      additionalNodes: interactiveRelayNodes()
    });
    try {
      await delivery.promise;
    } catch (error) {
      if (error.code !== 'DELIVERY_UNCONFIRMED') throw error;
      return {
        ...await recordOutgoing(jid, digits, text.trim(), messageId),
        deliveryStatus: 'unconfirmed'
      };
    }
  } catch (error) {
    delivery.cancel();
    throw error;
  }
  return {
    ...await recordOutgoing(jid, digits, text.trim(), messageId),
    deliveryStatus: 'delivered'
  };
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
  // O no <biz> e necessario para o WhatsApp renderizar os botoes clicaveis.
  // O no <bot biz_bot="1"> NAO deve ser enviado: mensagens marcadas como bot
  // nao geram receipt de entrega no aparelho destinatario, impossibilitando
  // confirmar a chegada (o sistema ficava preso em DELIVERY_UNCONFIRMED).
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

async function sendWithOptions(to, text, buttons, footer) {
  return sendButtons(to, text, buttons || OPTION_BUTTONS, footer);
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  sendMessage,
  sendButtons,
  sendWithOptions,
  checkNumber,
  setIO,
  findExistingNumber,
  textFromMessage,
  createInteractiveMessage,
  resolveDirectPhoneJid,
  waitForDeliveryAck,
  handleDeliveryStatus,
  shouldProcessStatusUpdate,
  statusFromReceiptNode,
  interactiveRelayNodes
};
