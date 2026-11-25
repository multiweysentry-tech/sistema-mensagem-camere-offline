const fs = require('fs');
const path = require('path');

const CAMERA_STATUSES = new Set([
  'Pendente', 'Aguardando resposta', 'Verificando', 'Suporte', 'Aguardando validacao', 'Resolvido'
]);

// Status do sistema que indicam que alguém já está tratando a câmera.
// Em reimportação, preservamos esses estados quando a câmera continua offline no NOC.
const WORKFLOW_STATUSES = new Set(['Aguardando resposta', 'Verificando', 'Suporte', 'Aguardando validacao']);

function detectSeparator(text) {
  const firstLine = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find(l => l.trim()) || '';
  const semis = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semis >= commas ? ';' : ',';
}

function parseDelimited(text, sep = ';') {
  text = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 && r.some(v => String(v).trim() !== ''));
}

function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function canonicalCameraId(value) {
  const id = clean(value);
  if (!id) return '';
  return /^NOC-/i.test(id) ? `NOC-${id.replace(/^NOC-/i, '').trim()}`.toUpperCase() : `NOC-${id}`;
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseOfflineMinutes(str) {
  const s = clean(str);
  if (!s) return null;
  let min = 0;
  const d = s.match(/(\d+)\s*d/i); if (d) min += Number(d[1]) * 1440;
  const h = s.match(/(\d+)\s*h/i); if (h) min += Number(h[1]) * 60;
  const m = s.match(/(\d+)\s*min/i); if (m) min += Number(m[1]);
  if (!d && !h && !m) return null;
  return min;
}

function parsePercent(value) {
  const m = clean(value).match(/(-?\d+)/);
  return m ? Number(m[1]) : null;
}

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => { map[normKey(h)] = i; });
  const pick = (...names) => {
    for (const name of names) {
      const idx = map[normKey(name)];
      if (idx !== undefined) return idx;
    }
    return -1;
  };
  return {
    id: pick('ID', 'ID Camera', 'ID Câmera', 'Camera ID', 'Câmera ID'),
    nome: pick('Nome', 'Camera', 'Câmera', 'Camera Nome', 'Câmera Nome', 'Nome Camera', 'Nome Câmera'),
    municipio: pick('Município', 'Municipio', 'Local', 'Cidade'),
    responsavel: pick('Responsável', 'Responsavel', 'Responsável', 'Responsavel Nome'),
    marcadores: pick('Marcadores', 'Tags'),
    status: pick('Status'),
    ultimo: pick('Último status', 'Ultimo status', 'Ultimo Status'),
    tempo: pick('Tempo offline', 'Tempo Offline'),
    desconexoes: pick('Desconexões 24h', 'Desconexoes 24h', 'Desconexoes'),
    sla24: pick('SLA 24h'),
    slaTotal: pick('SLA total', 'SLA Total')
  };
}

function buildObservacaoNoc(row) {
  const parts = [
    row.ultimo ? `Último status NOC: ${row.ultimo}` : null,
    row.tempo ? `Tempo offline: ${row.tempo}` : null,
    row.desconexoes !== '' ? `Desconexões 24h: ${row.desconexoes}` : null,
    row.sla24 !== '' ? `SLA 24h: ${row.sla24}` : null,
    row.slaTotal !== '' ? `SLA total: ${row.slaTotal}` : null,
    row.marcadores ? `Marcadores: ${row.marcadores}` : null
  ].filter(Boolean);
  return `[NOC] ${parts.join(' | ')}`;
}

function mergeObservacoes(existing, nocObs) {
  const base = String(existing || '').replace(/\r\n/g, '\n').trim();
  if (!base) return nocObs;
  // Substitui bloco NOC anterior para não crescer infinitamente.
  const withoutNoc = base
    .replace(/^\[NOC\][^\n]*(?:\n|$)/g, '')
    .replace(/\n\[NOC\][^\n]*(?=\n|$)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return withoutNoc ? `${withoutNoc}\n${nocObs}` : nocObs;
}

function mapNocStatus(nocStatus, existingStatus) {
  const s = normKey(nocStatus);
  const isOnline = s === 'ONLINE' || s === 'ATIVO' || s === 'UP';
  if (isOnline) return { status: 'Resolvido', resolvido: true };
  // Offline no NOC
  if (existingStatus && WORKFLOW_STATUSES.has(existingStatus)) {
    return { status: existingStatus, resolvido: false, preserved: true };
  }
  return { status: 'Pendente', resolvido: false };
}

function normalizeNocRow(raw, idx) {
  const id = clean(raw.id);
  const nome = clean(raw.nome);
  const municipio = clean(raw.municipio);
  const responsavel = clean(raw.responsavel);
  const status = clean(raw.status);
  if (!id || !nome) {
    return { error: `Linha ${idx + 2}: ID e Nome são obrigatórios`, raw };
  }
  const cameraId = canonicalCameraId(id);
  const local = municipio || 'Não informado';
  const responsavelNome = responsavel || 'Sem responsável informado';
  return {
    id: cameraId,
    sourceId: id,
    camera_nome: nome,
    local,
    responsavel_nome: responsavelNome,
    marcadores: clean(raw.marcadores),
    nocStatus: status,
    ultimo: clean(raw.ultimo),
    tempo: clean(raw.tempo),
    offlineMinutes: parseOfflineMinutes(raw.tempo),
    desconexoes: clean(raw.desconexoes),
    sla24: clean(raw.sla24),
    slaTotal: clean(raw.slaTotal),
    observacoes: buildObservacaoNoc(raw)
  };
}

function parseNocCsv(text) {
  const sep = detectSeparator(text);
  const rows = parseDelimited(text, sep);
  if (!rows.length) throw new Error('CSV vazio ou inválido');
  const header = rows[0];
  const cols = mapHeaders(header);
  if (cols.id < 0 || cols.nome < 0) {
    throw new Error('CSV do NOC inválido: colunas ID e Nome são obrigatórias');
  }
  const items = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const raw = {
      id: r[cols.id], nome: r[cols.nome], municipio: r[cols.municipio],
      responsavel: r[cols.responsavel], marcadores: r[cols.marcadores],
      status: r[cols.status], ultimo: r[cols.ultimo], tempo: r[cols.tempo],
      desconexoes: r[cols.desconexoes], sla24: r[cols.sla24], slaTotal: r[cols.slaTotal]
    };
    const normalized = normalizeNocRow(raw, i);
    if (normalized.error) errors.push(normalized.error);
    else items.push(normalized);
  }
  return { items, errors, totalRows: rows.length - 1 };
}

async function syncNocCameras({ db, csvText, tenantId = 'default', sourceFile = '', dryRun = false }) {
  const { items, errors, totalRows } = parseNocCsv(csvText);
  const existing = await db.getCameras(tenantId);
  const byId = new Map();
  for (const camera of existing) {
    byId.set(String(camera.id), camera);
    byId.set(canonicalCameraId(camera.id), camera);
  }

  const summary = {
    sourceFile: sourceFile ? path.basename(sourceFile) : '',
    tenantId,
    totalRows,
    parsed: items.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    online: 0,
    offline: 0,
    workflowPreserved: 0,
    semTelefone: 0,
    errors: [...errors],
    details: []
  };

  for (const item of items) {
    const current = byId.get(item.id) || byId.get(canonicalCameraId(item.sourceId));
    const mapped = mapNocStatus(item.nocStatus, current?.status);
    if (mapped.resolvido) summary.online++; else summary.offline++;
    if (mapped.preserved) summary.workflowPreserved++;
    const tel = current?.responsavel_telefone || '';
    if (!String(tel).replace(/\D/g, '')) summary.semTelefone++;

    const obs = mergeObservacoes(current?.observacoes, item.observacoes);
    if (!current) {
      const cam = {
        id: item.id,
        camera_nome: item.camera_nome,
        local: item.local,
        responsavel_nome: item.responsavel_nome,
        responsavel_telefone: '',
        email: '',
        status: mapped.status,
        tentativas: 0,
        ultima_cobranca: '',
        data_resolucao: mapped.resolvido ? new Date().toISOString() : '',
        observacoes: obs
      };
      if (!dryRun) await db.upsertCamera(cam, tenantId);
      byId.set(item.id, cam);
      summary.created++;
      summary.details.push({ id: item.id, action: 'created', status: mapped.status });
      continue;
    }

    const next = {
      camera_nome: item.camera_nome,
      local: item.local,
      responsavel_nome: item.responsavel_nome !== 'Sem responsável informado'
        ? item.responsavel_nome
        : (current.responsavel_nome || item.responsavel_nome),
      responsavel_telefone: current.responsavel_telefone || '',
      email: current.email || '',
      status: mapped.status,
      tentativas: Number(current.tentativas) || 0,
      ultima_cobranca: current.ultima_cobranca || '',
      data_resolucao: mapped.resolvido ? (current.data_resolucao || new Date().toISOString()) : (mapped.status === 'Pendente' ? '' : current.data_resolucao || ''),
      observacoes: obs
    };

    // Se voltou a ficar offline depois de resolvida, zera tentativas para novo ciclo.
    if (!mapped.resolvido && current.status === 'Resolvido') {
      next.tentativas = 0;
      next.ultima_cobranca = '';
    }

    const changed = Object.keys(next).some(k => String(next[k] ?? '') !== String(current[k] ?? ''));
    if (!changed) {
      summary.unchanged++;
      continue;
    }
    if (!dryRun) await db.updateCamera(item.id, next, tenantId);
    byId.set(item.id, { ...current, ...next });
    summary.updated++;
    summary.details.push({ id: item.id, action: 'updated', from: current.status, to: next.status });
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

async function importNocFile({ db, filePath, tenantId = 'default', dryRun = false }) {
  const csvText = fs.readFileSync(filePath, 'utf8');
  return syncNocCameras({ db, csvText, tenantId, sourceFile: filePath, dryRun });
}

module.exports = {
  parseNocCsv,
  syncNocCameras,
  importNocFile,
  mapNocStatus,
  mergeObservacoes,
  normalizeNocRow
};
