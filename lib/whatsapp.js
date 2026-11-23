// Cliente servidor-only para o servidor Baileys persistente.
// Nunca importar este módulo do navegador: WA_API_KEY não pode vazar para o client.
const { normalizarContato } = require('../phone-utils');

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text.replace(/\/+$/, '');
}

function isRemoteConfigured(env = process.env) {
  return Boolean(cleanUrl(env.WA_SERVER_URL) && String(env.WA_API_KEY || '').trim());
}

function mapStatus(status) {
  if (status === 'conectado') return 'open';
  if (status === 'aguardando_qr') return 'qr';
  return 'disconnected';
}

function createRemoteWhatsapp(options = {}) {
  const baseUrl = cleanUrl(options.url || process.env.WA_SERVER_URL);
  const apiKey = String(options.apiKey || process.env.WA_API_KEY || '').trim();
  if (!baseUrl || !apiKey) throw new Error('WA_SERVER_URL e WA_API_KEY são obrigatórios');
  const timeoutMs = Number(options.timeoutMs || process.env.WA_TIMEOUT_MS || 12000);

  async function request(caminho, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${baseUrl}${caminho}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const failure = new Error(`Servidor Baileys indisponível: ${error.message}`);
      failure.codigo = 'WA_INDISPONIVEL';
      throw failure;
    }
    const texto = await response.text();
    let data = {};
    try { data = texto ? JSON.parse(texto) : {}; } catch { data = { erro: texto }; }
    if (!response.ok) {
      const failure = new Error(data.erro || data.error || `HTTP ${response.status}`);
      failure.status = response.status;
      failure.codigo = response.status === 503 ? 'WA_DESCONECTADO'
        : response.status === 400 ? 'WA_NUMERO_INVALIDO' : 'WA_HTTP_ERROR';
      throw failure;
    }
    return data;
  }

  async function send(to, texto, botoes, rodape, metadata) {
    const numero = normalizarContato(to);
    if (!/^\d{10,15}$/.test(numero)) throw new Error('Telefone de destino inválido');
    const body = {
      numero,
      texto: String(texto).trim(),
      ...(Array.isArray(botoes) && botoes.length >= 2 ? { opcoes: botoes, rodape } : {}),
      ...(metadata ? { metadata } : {})
    };
    const resultado = await request('/enviar', { method: 'POST', body });
    return {
      ok: true,
      id: resultado.id,
      queueId: resultado.queueId,
      numero: resultado.numero || numero,
      jid: resultado.jid || `${numero}@s.whatsapp.net`,
      remote: true,
      // A fila devolve antes do envio real; entrega só é confirmada pelo webhook.
      deliveryStatus: 'pendente'
    };
  }

  return {
    remote: true,
    serverUrl: baseUrl,
    setIO() {},
    async getHealth() {
      return request('/status');
    },
    async getStatus() {
      try {
        const remoto = await request('/status');
        const status = mapStatus(remoto.status);
        return {
          status,
          remoteStatus: remoto.status,
          qr: null,
          phone: null,
          remote: true,
          error: status === 'open'
            ? null
            : 'WhatsApp desconectado no servidor persistente. Escaneie o QR em GET /qr do servidor Baileys.'
        };
      } catch (error) {
        return {
          status: 'disconnected',
          remoteStatus: 'erro',
          qr: null,
          phone: null,
          remote: true,
          error: error.message
        };
      }
    },
    async checkNumber(to) {
      const numero = normalizarContato(to);
      if (!/^\d{10,15}$/.test(numero)) throw new Error('Telefone inválido');
      const resultado = await request('/verificar', { method: 'POST', body: { numero } });
      return {
        phone: resultado.numero || numero,
        exists: resultado.existe === true,
        jid: resultado.jid || `${numero}@s.whatsapp.net`
      };
    },
    sendMessage: (to, texto, metadata) => send(to, texto, null, undefined, metadata),
    sendButtons: (to, texto, botoes, rodape, metadata) => send(to, texto, botoes, rodape, metadata),
    sendWithOptions: (to, texto, botoes, rodape, metadata) => send(to, texto, botoes, rodape, metadata),
    async connect() {
      throw new Error('Conexão remota: escanee o QR Code no servidor Baileys (GET /qr).');
    },
    async disconnect() {
      throw new Error('Desconexão remota não disponível pelo painel; use o servidor Baileys.');
    },
    async refreshQR() {
      throw new Error('Gere o QR Code no servidor Baileys (GET /qr).');
    }
  };
}

module.exports = { isRemoteConfigured, createRemoteWhatsapp, mapStatus, cleanUrl };
