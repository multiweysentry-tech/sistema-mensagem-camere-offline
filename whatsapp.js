const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

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

// Os IDs precisam ser entendidos tambem pelo parseReply() dos bots.
const OPTION_BUTTONS = [
  { id: '1', text: 'Em análise' },
  { id: '2', text: 'Falar com técnico' },
  { id: '3', text: 'Informei resolução' }
];
const OPTION_FOOTER = 'Escolha uma opção. PARAR encerra as mensagens.';
const OPTION_FALLBACK_TEXT = '\n\nResponda 1 para estou verificando, 2 para suporte ou 3 para já resolvi.';

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
        if (!key?.fromMe || update?.status === undefined) continue;
        let pn = null;
        try {
          pn = await socket.signalRepository?.lidMapping?.getPNForLID(key.remoteJid);
        } catch (error) {
          pn = null;
        }
        console.log(`[WhatsApp] ACK ${key.remoteJid} pn=${pn || '-'} ${key.id} status=${update.status}`);
      }
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
            await bots.onIncomingMessage(jid, text);
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

async function checkNumber(to) {
  if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
  const digits = normalizeDestination(to);
  if (!digits) throw new Error('Telefone de destino invalido');
  const results = await sock.onWhatsApp(digits) || [];
  const found = results.find(entry => entry?.exists && String(entry.jid || '').startsWith(digits));
  return {
    phone: digits,
    exists: Boolean(found),
    jid: found?.jid || `${digits}@s.whatsapp.net`
  };
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
  if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
  const digits = normalizeDestination(to);
  if (!digits) throw new Error('Telefone de destino invalido');
  const jid = `${digits}@s.whatsapp.net`;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Mensagem invalida (limite de 4096 caracteres)');
  }

  const result = await sock.sendMessage(jid, { text: text.trim() });
  return recordOutgoing(jid, digits, text.trim(), result?.key?.id);
}

// O Baileys 7 nao expoe "buttons" no sendMessage, mas o protocolo ainda suporta
// interactiveMessage; enviamos o protobuf diretamente pelo relay do socket.
async function sendButtons(to, text, buttons, footer) {
  if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
  const digits = normalizeDestination(to);
  if (!digits) throw new Error('Telefone de destino invalido');
  const jid = `${digits}@s.whatsapp.net`;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Mensagem invalida (limite de 4096 caracteres)');
  }
  const items = (Array.isArray(buttons) ? buttons : []).slice(0, 3).map((button, index) => ({
    id: String(button?.id || `op_${index + 1}`),
    text: String(button?.text || '').trim().slice(0, 20)
  })).filter(button => button.text);
  if (items.length < 2) throw new Error('Informe ao menos duas opções clicáveis');

  const message = proto.Message.fromObject({
    interactiveMessage: {
      body: { text: text.trim() },
      footer: { text: String(footer || OPTION_FOOTER).trim().slice(0, 60) },
      nativeFlowMessage: {
        messageVersion: 3,
        buttons: items.map(button => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: button.text, id: button.id })
        }))
      }
    }
  });

  const messageId = generateMessageIDV2(sock.user?.id);
  await sock.relayMessage(jid, message, { messageId });
  return recordOutgoing(jid, digits, text.trim(), messageId);
}

// Envia botoes reais e, se o WhatsApp nao aceitar, cai para texto com numeros.
async function sendWithOptions(to, text, buttons, footer) {
  try {
    return await sendButtons(to, text, buttons || OPTION_BUTTONS, footer);
  } catch (error) {
    console.warn('[WhatsApp] Botoes indisponiveis, enviando texto:', error.message);
    return sendMessage(to, `${String(text || '').trim()}${OPTION_FALLBACK_TEXT}\n\nResponda PARAR para deixar de receber mensagens automaticas.`);
  }
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  sendMessage,
  sendButtons,
  sendWithOptions,
  checkNumber,
  setIO
};
