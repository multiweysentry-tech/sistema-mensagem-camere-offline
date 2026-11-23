// Gerenciador de ciclo de vida de UMA instancia WhatsApp.
// Multiplas instancias sao criadas por session-manager.js.
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const protocol = require('./wa-protocol');
const { normalizarContato } = require('./phone-utils');
const { log } = require('./logger');

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

function sanitizeId(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function createSession(options = {}) {
  const instanceId = String(options.instanceId || 'default');
  const tenantId = String(options.tenantId || 'default');
  const authDir = options.authDir || (
    instanceId === 'default'
      ? path.join(__dirname, 'auth_info')
      : path.join(__dirname, 'auth_info', sanitizeId(instanceId))
  );
  const logger = options.logger || pino({ level: 'silent' });
  const db = options.db || require('./db');
  let io = options.io || null;

  let sock = null;
  let connectionStatus = 'disconnected';
  let qrDataUrl = null;
  let phoneNumber = null;
  let lastError = null;
  let connectionPromise = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let manuallyDisconnected = false;
  let socketGeneration = 0;

  function getStatus() {
    return {
      instanceId,
      tenantId,
      status: connectionStatus,
      qr: qrDataUrl,
      phone: phoneNumber,
      error: lastError,
      reconnectAttempts
    };
  }

  function emitStatus() {
    if (io) io.emit('wa:status', getStatus());
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (manuallyDisconnected || reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        lastError = 'Limite de reconexoes automaticas atingido. Reconecte manualmente.';
        connectionStatus = 'disconnected';
        emitStatus();
        log('warn', 'wa.reconnect_limit', { instanceId, tenantId, attempts: reconnectAttempts });
      }
      return;
    }
    const backoff = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * (2 ** reconnectAttempts));
    const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
    reconnectAttempts += 1;
    connectionStatus = 'reconnecting';
    emitStatus();
    log('info', 'wa.reconnect_scheduled', { instanceId, tenantId, attempt: reconnectAttempts, delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(error => log('error', 'wa.reconnect_failed', { instanceId, tenantId, error }));
    }, delay);
  }

  async function connect() {
    if (connectionStatus === 'open' || connectionStatus === 'qr') return getStatus();
    if (connectionPromise) return connectionPromise;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      throw new Error('Limite de reconexoes atingido. Use a reconexao manual.');
    }

    manuallyDisconnected = false;
    lastError = null;
    connectionStatus = 'connecting';
    emitStatus();
    log('info', 'wa.connecting', { instanceId, tenantId, attempt: reconnectAttempts });

    connectionPromise = (async () => {
      fs.mkdirSync(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
        saveCreds().catch(error => log('error', 'wa.creds_save_failed', { instanceId, error }));
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
            log('info', 'wa.qr_ready', { instanceId, tenantId });
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
          reconnectAttempts = 0;
          const connectedId = String(socket.user?.id || '').split(':')[0];
          phoneNumber = normalizarContato(connectedId) || null;
          emitStatus();
          log('info', 'wa.open', { instanceId, tenantId, phone: phoneNumber });
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const shouldReconnect = !manuallyDisconnected && !loggedOut;
          if (sock === socket) sock = null;
          connectionStatus = 'disconnected';
          qrDataUrl = null;
          phoneNumber = null;
          if (loggedOut) lastError = 'A sessao foi encerrada. Gere um novo QR Code.';
          emitStatus();
          log('warn', 'wa.close', { instanceId, tenantId, statusCode: statusCode ?? null, loggedOut, shouldReconnect });
          if (shouldReconnect) scheduleReconnect();
        }
      });

      socket.ev.on('messages.update', async updates => {
        for (const { key, update } of updates || []) {
          if (!protocol.shouldProcessStatusUpdate(key, update)) continue;
          protocol.handleDeliveryStatus(key.id, update.status);
          log('debug', 'wa.ack', {
            instanceId,
            tenantId,
            jid: key.remoteJid,
            fromMe: key.fromMe,
            messageId: key.id,
            status: update.status
          });
        }
      });

      socket.ws?.on?.('CB:receipt', node => {
        const id = node?.attrs?.id;
        const status = protocol.statusFromReceiptNode(node);
        if (!id || status === null) return;
        protocol.handleDeliveryStatus(id, status);
        log('debug', 'wa.receipt', { instanceId, tenantId, messageId: id, status, jid: node.attrs.from });
      });

      socket.ev.on('messages.upsert', async event => {
        for (const message of event.messages || []) {
          if (!message.message) continue;
          const jid = message.key?.remoteJid;
          if (!jid || jid === 'status@broadcast') continue;
          const text = protocol.textFromMessage(message.message);
          const timestamp = new Date(Number(message.messageTimestamp || Date.now() / 1000) * 1000).toISOString();
          const entry = {
            id: message.key.id || `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            from: jid,
            text,
            time: timestamp,
            direction: message.key.fromMe ? 'out' : 'in'
          };
          try {
            await db.upsertConversation(jid, message.pushName || normalizarContato(jid), text, timestamp, tenantId, instanceId);
            const inserted = await db.addMessage(jid, entry, tenantId, instanceId);
            if (!inserted) continue;
            if (!message.key.fromMe) await db.incrementUnread(jid, tenantId, instanceId);
            if (io) {
              io.emit('wa:newMessage', {
                instanceId,
                tenantId,
                jid,
                message: entry,
                conversation: {
                  jid,
                  name: message.pushName || normalizarContato(jid),
                  lastMessage: text,
                  lastTime: timestamp
                }
              });
            }
            if (!message.key.fromMe && !jid.endsWith('@g.us') && text) {
              const bots = typeof options.resolveBots === 'function'
                ? options.resolveBots({ tenantId, instanceId })
                : (options.bots || require('./bots'));
              const phoneJid = await protocol.resolveDirectPhoneJid(message.key, socket.signalRepository?.lidMapping);
              if (phoneJid) await bots.onIncomingMessage(phoneJid, text, { tenantId, instanceId });
            }
            log('info', 'wa.message', { instanceId, tenantId, jid, direction: entry.direction, messageId: entry.id });
          } catch (error) {
            log('error', 'wa.message_failed', { instanceId, tenantId, jid, error });
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
      log('error', 'wa.connect_failed', { instanceId, tenantId, error });
      throw error;
    } finally {
      connectionPromise = null;
    }
  }

  // Desconexao manual preserva credenciais; logout=true apaga a sessao.
  async function disconnect({ logout = false } = {}) {
    manuallyDisconnected = true;
    socketGeneration += 1;
    clearReconnectTimer();
    const currentSocket = sock;
    sock = null;
    try {
      if (currentSocket) {
        currentSocket.ev?.removeAllListeners?.();
        if (logout) await currentSocket.logout();
        else currentSocket.ws?.close?.();
      }
    } catch (error) {
      lastError = `Falha ao encerrar a sessao: ${error.message}`;
    } finally {
      if (logout) fs.rmSync(authDir, { recursive: true, force: true });
      connectionStatus = 'disconnected';
      qrDataUrl = null;
      phoneNumber = null;
      reconnectAttempts = 0;
      emitStatus();
      log('info', logout ? 'wa.logout' : 'wa.paused', { instanceId, tenantId });
    }
  }

  // Forca um novo QR sem apagar as credenciais existentes.
  async function refreshQR() {
    await disconnect({ logout: false });
    reconnectAttempts = 0;
    return connect();
  }

  function assertConnected() {
    if (!sock || connectionStatus !== 'open') throw new Error('WhatsApp nao conectado');
    return sock;
  }

  async function checkNumber(to) {
    const socket = assertConnected();
    const digits = protocol.normalizeDestination(to);
    if (!digits) throw new Error('Telefone de destino invalido');
    const results = await socket.onWhatsApp(digits) || [];
    const found = protocol.findExistingNumber(results);
    return { phone: digits, exists: Boolean(found), jid: found?.jid || `${digits}@s.whatsapp.net` };
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
    await db.upsertConversation(jid, label || normalizarContato(jid), entry.text, entry.time, tenantId, instanceId);
    const inserted = await db.addMessage(jid, entry, tenantId, instanceId);
    if (inserted && io) {
      io.emit('wa:newMessage', { instanceId, tenantId, jid, message: entry });
    }
    return { ok: true, id: entry.id };
  }

  async function sendMessage(to, text) {
    const socket = assertConnected();
    const { phone: digits, jid } = await resolveDestination(to);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Mensagem invalida (limite de 4096 caracteres)');
    }
    const result = await socket.sendMessage(jid, { text: text.trim() });
    return recordOutgoing(jid, digits, text.trim(), result?.key?.id);
  }

  async function sendButtons(to, text, buttons, footer) {
    const socket = assertConnected();
    const { phone: digits, jid } = await resolveDestination(to);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Mensagem invalida (limite de 4096 caracteres)');
    }
    const userJid = socket.user?.id;
    if (!userJid) throw new Error('Sessao do WhatsApp sem identificador do remetente');
    const generated = generateWAMessageFromContent(
      jid,
      protocol.createInteractiveMessage(text, buttons, footer),
      { userJid }
    );
    const messageId = generated.key.id;
    const delivery = protocol.waitForDeliveryAck(messageId);
    try {
      await socket.relayMessage(jid, generated.message, {
        messageId,
        additionalNodes: protocol.interactiveRelayNodes()
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

  async function sendWithOptions(to, text, buttons, footer) {
    return sendButtons(to, text, buttons || protocol.OPTION_BUTTONS, footer);
  }

  function setIO(ioInstance) {
    io = ioInstance;
  }

  return {
    instanceId,
    tenantId,
    authDir,
    setIO,
    getStatus,
    connect,
    disconnect,
    refreshQR,
    checkNumber,
    resolveDestination,
    sendMessage,
    sendButtons,
    sendWithOptions
  };
}

module.exports = { createSession, sanitizeId, MAX_RECONNECT_ATTEMPTS };
