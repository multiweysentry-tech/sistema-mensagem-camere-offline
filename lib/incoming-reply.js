// Processamento de respostas do WhatsApp sem dependencias de sessao local.
// Este modulo e usado no Vercel, onde o Baileys nao pode ser importado.
const { normalizarContato, chaveComparacaoTelefone } = require('../phone-utils');

function normalizePhone(value) {
  return normalizarContato(value);
}

function contactKey(value) {
  return chaveComparacaoTelefone(value) || normalizePhone(value);
}

function normalizeText(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function parseReply(text) {
  const normalized = normalizeText(text);
  if (/^(parar|sair|cancelar|stop|unsubscribe)$/.test(normalized)) return { intent: 'opt_out' };
  if (/^(1|analisar|estou analisando|verificando|estou verificando)$/.test(normalized)) {
    return {
      intent: 'investigating',
      status: 'Verificando',
      reply: 'Obrigado! Registramos que voce esta verificando as cameras.'
    };
  }
  if (/^(2|suporte|tecnico|preciso de suporte|preciso falar com tecnico)$/.test(normalized)) {
    return {
      intent: 'support',
      status: 'Suporte',
      reply: 'Sua solicitacao foi encaminhada para a equipe de suporte.'
    };
  }
  if (/^(3|resolvi|resolvido|ja resolvi)$/.test(normalized)) {
    return {
      intent: 'resolved',
      status: 'Aguardando validacao',
      reply: 'Obrigado! Registramos a resolucao e vamos validar o retorno das cameras.'
    };
  }
  if (/^(oi|ola|bom dia|boa tarde|boa noite|ajuda|menu)$/.test(normalized)) {
    return {
      intent: 'help',
      reply: 'Para atualizar as cameras, responda: 1 para estou verificando, 2 para suporte ou 3 para ja resolvi. Para parar mensagens automaticas, responda PARAR.'
    };
  }
  return null;
}

function createIncomingReplyHandler({ db, wa, resolveWa = null } = {}) {
  if (!db || !wa) throw new Error('db e wa sao obrigatorios para processar respostas');

  function waFor({ tenantId, instanceId }) {
    return typeof resolveWa === 'function'
      ? resolveWa({ tenantId, instanceId })
      : wa;
  }

  return async function onIncomingMessage(jid, text, options = {}) {
    const tenantId = options.tenantId || 'default';
    const instanceId = options.instanceId || 'default';
    const instance = waFor({ tenantId, instanceId });
    const phone = normalizePhone(jid);
    const key = contactKey(jid);
    if (!phone || !key) return;

    const action = parseReply(text);
    const cameras = (await db.getCameras(tenantId))
      .filter(camera => contactKey(camera.responsavel_telefone) === key);
    // O JID recebido pode vir sem o 9º digito; responda pelo numero cadastrado
    // quando disponivel para nao perder a mensagem no provedor.
    const replyPhone = cameras.length
      ? (normalizePhone(cameras[0].responsavel_telefone) || phone)
      : phone;
    const phones = [...new Set([
      phone,
      ...cameras.map(camera => normalizePhone(camera.responsavel_telefone)).filter(Boolean)
    ])];

    if (action?.intent === 'opt_out') {
      for (const target of phones) {
        await db.setConsent(target, false, tenantId);
        await db.block(target, 'Opt-out solicitado por WhatsApp', tenantId);
      }
      await instance.sendMessage(replyPhone, 'Tudo certo. Voce nao recebera mais mensagens automaticas. Para voltar a receber, entre em contato com a equipe.');
      return;
    }

    for (const target of phones) {
      if (await db.isBlocked(target, tenantId)) return;
    }
    const config = await db.getBotConfig(tenantId);
    if (!cameras.length) return;
    if (!action) return;

    if (action.status) {
      const active = cameras.filter(camera => camera.status !== 'Resolvido');
      if (!active.length) {
        await instance.sendMessage(replyPhone, 'No momento, nao ha cameras pendentes vinculadas a este numero.');
        return;
      }
      const previousStatus = [...new Set(active.map(camera => camera.status || ''))].join(',');
      const timestamp = new Date().toISOString();
      for (const camera of active) {
        await db.updateCamera(camera.id, {
          status: action.status,
          observacoes: [camera.observacoes, `Resposta WhatsApp: ${String(text).slice(0, 300)}`].filter(Boolean).join(' | '),
          ...(action.status === 'Aguardando validacao' ? { data_resolucao: timestamp.slice(0, 10) } : {})
        }, tenantId);
      }
      await db.addLog({
        timestamp,
        camera_id: active.map(camera => camera.id).join(','),
        camera_nome: active.map(camera => camera.camera_nome).join(','),
        responsavel_telefone: replyPhone,
        acao: 'RESPOSTA_RECEBIDA',
        detalhe: String(text).slice(0, 500),
        status_anterior: previousStatus,
        status_novo: action.status,
        instance_id: instanceId
      }, tenantId);
    }

    if (action.reply && String(config.auto_mode) !== 'false') {
      await instance.sendMessage(replyPhone, action.reply);
    }
  };
}

module.exports = { parseReply, createIncomingReplyHandler };
