// Ciclo de vida da conexão Baileys. Uma única sessão por processo, pensada para
// rodar 24h com SESSION_DIR em volume persistente.
import fs from 'node:fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { mapAckStatus, textFromMessage } from './messages.js';
import { maskNumber } from './phone.js';

const isPhoneJid = jid => /^\d+@(s\.whatsapp\.net|c\.us)$/.test(String(jid || ''));

export function createConnection({ sessionDir, logger, onEvent }) {
  let socket = null;
  let status = 'desconectado';
  let qrDataUrl = null;
  let phone = null;
  let generation = 0;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let stopping = false;

  // ids enviados pelo painel + último ACK já repassado (evita webhooks duplicados).
  const rastreados = new Map();
  const ultimoStatus = new Map();

  function publicarStatus() {
    logger.info({ event: 'connection.status', status, phone: phone ? maskNumber(phone) : null });
  }

  function limparSessao() {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    logger.warn({ event: 'session.cleared', sessionDir, motivo: 'logged_out' });
  }

  function agendarReconexao(delayMs) {
    if (stopping) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect().catch(error => logger.error({ event: 'connect.failed', erro: error.message }));
    }, delayMs);
  }

  async function connect() {
    if (socket || stopping) return;
    const minhaGeracao = ++generation;
    fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conexao = makeWASocket({
      auth: state,
      logger: logger.child({ componente: 'baileys' }),
      printQRInTerminal: true,
      browser: ['Multiwey Sentry', 'Chrome', '1.0.0']
    });
    socket = conexao;
    logger.info({ event: 'connect.start', sessionDir });

    conexao.ev.on('creds.update', () => {
      saveCreds().catch(error => logger.error({ event: 'creds.save_failed', erro: error.message }));
    });

    conexao.ev.on('connection.update', async update => {
      if (minhaGeracao !== generation) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          if (minhaGeracao !== generation) return;
          qrDataUrl = dataUrl;
          status = 'aguardando_qr';
          publicarStatus();
          logger.info({ event: 'qr.ready', dica: 'GET /qr com x-api-key para escanear' });
        } catch (error) {
          logger.error({ event: 'qr.failed', erro: error.message });
        }
      }

      if (connection === 'open') {
        status = 'conectado';
        qrDataUrl = null;
        reconnectAttempts = 0;
        phone = String(conexao.user?.id || '').split(':')[0] || null;
        publicarStatus();
        return;
      }

      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = codigo === DisconnectReason.loggedOut;
        if (socket === conexao) socket = null;
        status = 'desconectado';
        qrDataUrl = null;
        phone = null;
        ultimoStatus.clear();

        if (loggedOut) {
          logger.error({
            event: 'session.logged_out',
            codigo,
            erro: 'Sessão encerrada pelo WhatsApp. Credenciais apagadas; será necessário escanear um novo QR.'
          });
          limparSessao();
          status = 'aguardando_qr';
          reconnectAttempts = 0;
          agendarReconexao(1000);
        } else {
          const delay = Math.min(30000, 2000 * (2 ** reconnectAttempts++));
          logger.warn({ event: 'connection.close', codigo: codigo ?? null, reconnectMs: delay });
          agendarReconexao(delay);
        }
        publicarStatus();
      }
    });

    conexao.ev.on('messages.update', async updates => {
      for (const { key, update } of updates || []) {
        const id = key?.id;
        if (!id || !rastreados.has(id)) continue;
        const textoStatus = mapAckStatus(update?.status);
        if (!textoStatus || ultimoStatus.get(id) === textoStatus) continue;
        ultimoStatus.set(id, textoStatus);
        const motivo = update?.error ? JSON.stringify(update.error).slice(0, 500) : undefined;
        await onEvent({
          tipo: 'status',
          id,
          status: textoStatus,
          ...(motivo ? { motivo } : {}),
          jid: key.remoteJid || rastreados.get(id)?.jid || null,
          timestamp: new Date().toISOString(),
          metadata: rastreados.get(id)?.metadata || null
        });
      }
    });

    conexao.ev.on('messages.upsert', async event => {
      for (const message of event.messages || []) {
        if (message.key?.fromMe) continue;
        const jid = message.key?.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const texto = textFromMessage(message.message);
        if (!texto) continue;
        await onEvent({
          tipo: 'mensagem',
          id: message.key.id || `in_${Date.now()}`,
          remetente: jid,
          texto: String(texto).slice(0, 4096),
          timestamp: new Date(Number(message.messageTimestamp || Date.now() / 1000) * 1000).toISOString()
        });
      }
    });
  }

  function getSocket() {
    if (!socket || status !== 'conectado') {
      const error = new Error('WhatsApp desconectado no servidor Baileys');
      error.status = 503;
      error.codigo = 'WA_DESCONECTADO';
      throw error;
    }
    return socket;
  }

  async function findOnWhatsApp(numero) {
    const resultados = await getSocket().onWhatsApp(numero) || [];
    const existentes = resultados.filter(item => item?.exists);
    const preferido = existentes.find(item => isPhoneJid(item.jid)) || existentes[0] || null;
    if (!preferido) {
      const error = new Error('Número não possui WhatsApp');
      error.status = 400;
      error.codigo = 'WA_NUMERO_INVALIDO';
      throw error;
    }
    return preferido.jid;
  }

  function track(id, metadata, jid) {
    rastreados.set(id, { metadata: metadata || null, jid: jid || null, criadoEm: Date.now() });
    if (rastreados.size > 2000) {
      const corte = Date.now() - 24 * 3600000;
      for (const [key, value] of rastreados) if (value.criadoEm < corte) rastreados.delete(key);
    }
  }

  function stop() {
    stopping = true;
    clearTimeout(reconnectTimer);
  }

  return {
    start: () => { connect().catch(error => logger.error({ event: 'connect.failed', erro: error.message })); },
    stop,
    track,
    getSocket,
    findOnWhatsApp,
    getStatus: () => status,
    getInfo: () => ({ status, phone: phone ? maskNumber(phone) : null, qrDisponivel: Boolean(qrDataUrl) }),
    getQR: () => qrDataUrl
  };
}
