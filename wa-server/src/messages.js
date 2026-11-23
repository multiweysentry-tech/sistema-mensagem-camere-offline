// Helpers de mensagem da API do Baileys 7.0.0-rc14 (ESM).
// Mantidos equivalentes ao wa-protocol.js do painel para não quebrar os botões.
import { randomBytes } from 'node:crypto';
import { proto, generateWAMessageFromContent } from '@whiskeysockets/baileys';

export const ACK = {
  ERRO: 0,
  PENDENTE: 1,
  ENVIADA: 2,
  ENTREGUE: 3,
  LIDA: 4,
  OUVIDA: 5
};

export function mapAckStatus(status) {
  const code = Number(status);
  if (code === ACK.ERRO) return 'erro';
  if (code === ACK.ENVIADA) return 'enviada';
  if (code === ACK.ENTREGUE) return 'entregue';
  if (code === ACK.LIDA || code === ACK.OUVIDA) return 'lida';
  return null;
}

export function textFromMessage(message = {}) {
  const content = message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;
  const response = content.interactiveResponseMessage;
  if (response) {
    const params = response.nativeFlowResponseMessage?.paramsJson;
    if (params) {
      try {
        const parsed = JSON.parse(params);
        if (parsed?.id) return String(parsed.id);
        if (parsed?.display_text) return String(parsed.display_text);
      } catch { /* formato desconhecido: cai para o texto simples */ }
    }
    if (response.body?.text) return String(response.body.text);
  }
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedId ||
    content.listResponseMessage?.title ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    '';
}

function createInteractiveMessage(texto, opcoes, rodape) {
  const itens = (Array.isArray(opcoes) ? opcoes : []).slice(0, 3).map((opcao, index) => ({
    id: String(opcao?.id || `op_${index + 1}`),
    text: String(opcao?.text || '').trim().slice(0, 20)
  })).filter(opcao => opcao.text);
  if (itens.length < 2) throw new Error('Informe ao menos duas opções clicáveis');

  return proto.Message.create({
    interactiveMessage: proto.Message.InteractiveMessage.create({
      body: { text: texto },
      footer: { text: String(rodape || 'Escolha uma opção.').trim().slice(0, 60) },
      nativeFlowMessage: {
        buttons: itens.map(opcao => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: opcao.text, id: opcao.id })
        })),
        messageParamsJson: JSON.stringify({ from: 'api', templateId: randomBytes(8).toString('hex') }),
        messageVersion: 3
      }
    })
  });
}

function interactiveRelayNodes() {
  // O nó <biz> é necessário para renderizar botões clicáveis.
  // Não enviar <bot biz_bot="1">: ele suprime o receipt de entrega.
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

export function buildOutgoing({ jid, texto, opcoes, rodape, id, userJid }) {
  if (!opcoes || opcoes.length < 2) {
    return { tipo: 'texto', conteudo: { text: texto }, opcoesEnvio: { messageId: id }, nodes: null };
  }
  const mensagem = generateWAMessageFromContent(
    jid,
    createInteractiveMessage(texto, opcoes, rodape),
    { userJid }
  );
  mensagem.key.id = id;
  return {
    tipo: 'botoes',
    conteudo: mensagem.message,
    opcoesEnvio: { messageId: id, additionalNodes: interactiveRelayNodes() },
    nodes: true
  };
}
