const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
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

function setIO(ioInstance) {
  io = ioInstance;
}

function getStatus() {
  return { status: connectionStatus, qr: qrDataUrl, phone: phoneNumber, error: lastError };
}

function emitStatus() {
  if (io) io.emit('wa:status', getStatus());
}

function textFromMessage(message = {}) {
  const content = message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;
  return content.conversation ||
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
  if (currentSocket) await currentSocket.logout();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  connectionStatus = 'disconnected';
  qrDataUrl = null;
  phoneNumber = null;
  lastError = null;
  emitStatus();
}

async function sendMessage(to, text) {
  if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
  const destination = String(to || '');
  const digits = destination.replace(/\D/g, '');
  const jid = destination.endsWith('@s.whatsapp.net')
    ? destination
    : /^\d{10,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : '';
  if (!jid) throw new Error('Telefone de destino invalido');
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Mensagem invalida (limite de 4096 caracteres)');
  }

  const result = await sock.sendMessage(jid, { text: text.trim() });
  const entry = {
    id: result?.key?.id || `out_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    from: jid,
    text: text.trim(),
    time: new Date().toISOString(),
    direction: 'out'
  };
  await db.upsertConversation(jid, digits || jid.split('@')[0], entry.text, entry.time);
  const inserted = await db.addMessage(jid, entry);
  if (inserted && io) {
    io.emit('wa:newMessage', {
      jid,
      message: entry,
      conversation: {
        jid,
        name: digits || jid.split('@')[0],
        lastMessage: entry.text,
        lastTime: entry.time
      }
    });
  }
  return { ok: true, id: entry.id };
}

module.exports = { connect, disconnect, getStatus, sendMessage, setIO };
