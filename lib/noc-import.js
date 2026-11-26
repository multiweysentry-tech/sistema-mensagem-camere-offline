const fs = require('fs');
const path = require('path');
const { normalizarContato, telefoneBrasileiroValido } = require('../phone-utils');

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

// Uma aspas solta no CSV não pode fazer um campo crescer sem limite e engolir
// as linhas seguintes (isso já gerou um camera_nome com milhões de caracteres).
const MAX_CAMPO_CSV = 2000;

function parseDelimited(text, sep = ';') {
  text = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Cada linha é um registro: uma aspas solta nunca atravessa linhas.
    if (c === '\n') {
      inQuotes = false;
      row.push(field); rows.push(row); row = []; field = '';
      continue;
    }
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      if (field.length > MAX_CAMPO_CSV) field = field.slice(0, MAX_CAMPO_CSV);
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c !== '\r') {
      field += c;
      if (field.length > MAX_CAMPO_CSV) field = field.slice(0, MAX_CAMPO_CSV);
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
    slaTotal: pick('SLA total', 'SLA Total'),
    dataResolucao: pick('Data resolução', 'Data resolucao', 'Data da resolução', 'Data da resolucao'),
    observacao: pick('Observação', 'Observacao', 'Observações', 'Observacoes')
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

function mergeBaixaObservacoes(existing, item) {
  const comBaixa = item?.observacaoBaixa ? mergeObservacoes(existing, item.observacaoBaixa) : existing;
  return mergeObservacoes(comBaixa, item?.observacoes || '');
}

function isOfflineNocStatus(nocStatus) {
  const s = normKey(nocStatus);
  if (!s || s === 'ONLINE' || s === 'ATIVO' || s === 'UP') return false;
  // Baixa dada no Painel NOC não pode reabrir a câmera na próxima importação.
  if (s.includes('RESOLVID') || s.includes('BAIXAD') || s.includes('CONCLUÍD') || s.includes('CONCLUID')) return false;
  return true;
}

function mapNocStatus(nocStatus, existingStatus) {
  const s = normKey(nocStatus);
  if (!isOfflineNocStatus(s)) return { status: 'Resolvido', resolvido: true };
  if (existingStatus && WORKFLOW_STATUSES.has(existingStatus)) {
    return { status: existingStatus, resolvido: false, preserved: true };
  }
  return { status: 'Pendente', resolvido: false };
}

function normalizeNocRow(raw, idx) {
  const id = clean(raw.id);
  const nome = clean(raw.nome).slice(0, 500);
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
    dataResolucao: clean(raw.dataResolucao),
    observacaoBaixa: clean(raw.observacao),
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
      desconexoes: r[cols.desconexoes], sla24: r[cols.sla24], slaTotal: r[cols.slaTotal],
      dataResolucao: r[cols.dataResolucao], observacao: r[cols.observacao]
    };
    const normalized = normalizeNocRow(raw, i);
    if (normalized.error) errors.push(normalized.error);
    else items.push(normalized);
  }
  return { items, errors, totalRows: rows.length - 1 };
}

async function syncNocCameras({ db, csvText, tenantId = 'default', sourceFile = '', dryRun = false, preserveDraftNames = false }) {
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
    jaCadastradas: 0,
    duplicatasNoArquivo: 0,
    errors: [...errors],
    details: []
  };

  // Acumula as alterações e persiste tudo de uma vez. No Vercel, fazer ~855
  // consultas individuais ao Postgres estoura o limite de tempo da função.
  const writesById = new Map();
  const queueWrite = (id, cam, fields, mode) => {
    writesById.set(String(id), { id, cam, fields, mode });
  };

  const vistosNoArquivo = new Set();
  for (const item of items) {
    const chaveArquivo = canonicalCameraId(item.sourceId || item.id);
    if (vistosNoArquivo.has(chaveArquivo)) {
      summary.duplicatasNoArquivo++;
      continue;
    }
    vistosNoArquivo.add(chaveArquivo);
    const current = byId.get(item.id) || byId.get(canonicalCameraId(item.sourceId));
    if (current) summary.jaCadastradas++;
    const mapped = mapNocStatus(item.nocStatus, current?.status);
    if (mapped.resolvido) summary.online++; else summary.offline++;
    if (mapped.preserved) summary.workflowPreserved++;
    const tel = current?.responsavel_telefone || '';
    if (!String(tel).replace(/\D/g, '')) summary.semTelefone++;

    const obs = mergeBaixaObservacoes(current?.observacoes, item);
    if (!current) {
      const cam = {
        id: item.id,
        instance_id: 'default',
        camera_nome: item.camera_nome,
        local: item.local,
        responsavel_nome: item.responsavel_nome,
        responsavel_telefone: '',
        email: '',
        status: mapped.status,
        tentativas: 0,
        ultima_cobranca: '',
        data_resolucao: mapped.resolvido ? (item.dataResolucao || new Date().toISOString().slice(0, 10)) : '',
        observacoes: obs
      };
      if (!dryRun) queueWrite(item.id, cam, null, 'upsert');
      byId.set(item.id, cam);
      summary.created++;
      summary.details.push({ id: item.id, action: 'created', status: mapped.status });
      continue;
    }

    // Rascunhos preenchidos manualmente na aba Offline não devem perder o nome
    // quando o bot NOC é executado novamente.
    const isDraft = !String(tel).replace(/\D/g, '');
    const manualDraftName = preserveDraftNames && isDraft && current.responsavel_nome &&
      current.responsavel_nome !== 'Sem responsável informado';
    const next = {
      camera_nome: item.camera_nome,
      local: item.local,
      responsavel_nome: manualDraftName
        ? current.responsavel_nome
        : (item.responsavel_nome !== 'Sem responsável informado'
          ? item.responsavel_nome
          : (current.responsavel_nome || item.responsavel_nome)),
      responsavel_telefone: current.responsavel_telefone || '',
      email: current.email || '',
      status: mapped.status,
      tentativas: Number(current.tentativas) || 0,
      ultima_cobranca: current.ultima_cobranca || '',
      data_resolucao: mapped.resolvido ? (item.dataResolucao || current.data_resolucao || new Date().toISOString().slice(0, 10)) : (mapped.status === 'Pendente' ? '' : current.data_resolucao || ''),
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
    if (!dryRun) {
      queueWrite(item.id, {
        ...current,
        ...next,
        id: item.id,
        instance_id: current.instance_id || 'default'
      }, next, 'update');
    }
    byId.set(item.id, { ...current, ...next });
    summary.updated++;
    summary.details.push({ id: item.id, action: 'updated', from: current.status, to: next.status });
  }

  if (writesById.size) {
    const writes = [...writesById.values()];
    if (typeof db.upsertCamerasBulk === 'function') {
      await db.upsertCamerasBulk(writes.map(write => write.cam), tenantId);
    } else {
      // Compatibilidade com db mocks/versões antigas que não têm escrita em lote.
      for (const write of writes) {
        if (write.mode === 'update' && typeof db.updateCamera === 'function') {
          await db.updateCamera(write.id, write.fields, tenantId);
        } else if (typeof db.upsertCamera === 'function') {
          await db.upsertCamera(write.cam, tenantId);
        }
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

async function importNocFile({ db, filePath, tenantId = 'default', dryRun = false }) {
  const csvText = fs.readFileSync(filePath, 'utf8');
  return syncNocCameras({ db, csvText, tenantId, sourceFile: filePath, dryRun });
}

// Monta a relação de câmeras offline do NOC para destinação progressiva na aba Offline.
// Nunca gera envio: telefone vazio continua como rascunho para o usuário preencher.
function buildNocAssignments({ csvText = '', items, cameras = [] } = {}) {
  let parsedItems = [];
  const errors = [];
  if (Array.isArray(items)) {
    parsedItems = items;
  } else if (String(csvText || '').trim()) {
    const parsed = parseNocCsv(csvText);
    parsedItems = parsed.items;
    errors.push(...parsed.errors);
  }

  const byId = new Map();
  for (const camera of cameras || []) {
    const id = String(camera?.id || '');
    if (!id) continue;
    byId.set(id, camera);
    byId.set(canonicalCameraId(id), camera);
  }

  const assignments = [];
  const vistos = new Set();
  for (const item of parsedItems) {
    if (!isOfflineNocStatus(item.nocStatus)) continue;
    const chave = canonicalCameraId(item.sourceId || item.id);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const current = byId.get(item.id) || null;
    const currentNome = clean(current?.responsavel_nome);
    const currentTel = clean(current?.responsavel_telefone);
    const currentLocal = clean(current?.local);
    const proposedNome = currentNome && currentNome !== 'Sem responsável informado'
      ? currentNome
      : (clean(item.responsavel_nome) || 'Sem responsável informado');
    const proposedLocal = currentLocal && currentLocal !== 'Não informado'
      ? currentLocal
      : clean(item.local);

    assignments.push({
      cameraId: item.id,
      camera_nome: clean(current?.camera_nome || item.camera_nome),
      responsavel_nome: proposedNome,
      responsavel_telefone: currentTel,
      local: proposedLocal,
      origem: 'NOC',
      currentResponsavel: currentNome,
      currentTelefone: currentTel,
      currentLocal,
      currentStatus: clean(current?.status),
      nocStatus: clean(item.nocStatus),
      tempoOffline: clean(item.tempo),
      observacoes: clean(current?.observacoes || item.observacoes),
      action: !current ? 'novo' : (currentTel ? 'revisar' : 'rascunho')
    });
  }

  return {
    assignments,
    offline: assignments.length,
    semTelefone: assignments.filter(a => !a.responsavel_telefone).length,
    errors
  };
}

async function applyNocAssignments({ db, tenantId = 'default', assignments = [], dryRun = false } = {}) {
  if (!Array.isArray(assignments) || !assignments.length) {
    throw new Error('Nenhuma atribuição NOC para aplicar');
  }
  const cameras = await db.getCameras(tenantId);
  const byId = new Map(cameras.map(c => [String(c.id), c]));
  const summary = { total: assignments.length, applied: 0, skipped: 0, errors: [], details: [] };

  for (const assignment of assignments) {
    const cameraId = String(assignment?.cameraId || '');
    const current = byId.get(cameraId);
    if (!current) {
      summary.skipped++;
      summary.errors.push(`Câmera não encontrada: ${cameraId}`);
      continue;
    }

    const fields = {};
    const nome = clean(assignment.responsavel_nome);
    const local = clean(assignment.local);
    const telefone = clean(assignment.responsavel_telefone);
    if (nome) fields.responsavel_nome = nome;
    if (local) fields.local = local;
    if (telefone) {
      const normalized = normalizarContato(telefone);
      if (!telefoneBrasileiroValido(normalized)) {
        summary.skipped++;
        summary.errors.push(`${cameraId}: telefone inválido (${telefone})`);
        continue;
      }
      fields.responsavel_telefone = normalized;
    }
    if (!Object.keys(fields).length) {
      summary.skipped++;
      continue;
    }

    const changed = Object.keys(fields).some(k => String(current[k] || '') !== String(fields[k] || ''));
    if (!changed) {
      summary.skipped++;
      summary.details.push({ cameraId, action: 'unchanged' });
      continue;
    }

    if (!dryRun) {
      await db.updateCamera(cameraId, fields, tenantId);
      await db.addLog({
        timestamp: new Date().toISOString(),
        camera_id: cameraId,
        camera_nome: current.camera_nome,
        responsavel_telefone: fields.responsavel_telefone || current.responsavel_telefone || '',
        acao: 'DESTINACAO_NOC',
        detalhe: `Destinação NOC: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        status_anterior: current.status || '',
        status_novo: current.status || '',
        trace_id: null
      }, tenantId).catch(() => {});
    }
    summary.applied++;
    summary.details.push({ cameraId, action: 'applied', fields });
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

// Aplica os grupos montados no Painel NOC: várias IDs para um mesmo responsável,
// escolhido entre os existentes ou digitado pelo usuário. Nunca envia WhatsApp.
async function applyNocGroups({ db, tenantId = 'default', groups = [], dryRun = false } = {}) {
  const cameras = await db.getCameras(tenantId);
  const byId = new Map();
  for (const camera of cameras || []) {
    const id = String(camera?.id || '');
    if (!id) continue;
    byId.set(id, camera);
    byId.set(canonicalCameraId(id), camera);
  }

  const summary = { grupos: 0, aplicadas: 0, ignoradas: 0, erros: [], detalhes: [] };
  for (const group of Array.isArray(groups) ? groups : []) {
    const nome = clean(group?.responsavel_nome);
    const idsBrutos = Array.isArray(group?.cameraIds)
      ? group.cameraIds
      : String(group?.ids || '').split(/[\s,;]+/);
    const ids = [...new Set(idsBrutos.map(id => clean(id)).filter(Boolean))];
    if (!nome || !ids.length) {
      summary.ignoradas++;
      summary.erros.push('Grupo sem responsável ou sem IDs');
      continue;
    }
    summary.grupos++;

    const fields = { responsavel_nome: nome };
    const telefoneBruto = clean(group?.responsavel_telefone);
    if (telefoneBruto) {
      const telefone = normalizarContato(telefoneBruto);
      if (!telefoneBrasileiroValido(telefone)) {
        summary.ignoradas++;
        summary.erros.push(`${nome}: telefone inválido (${telefoneBruto})`);
        continue;
      }
      fields.responsavel_telefone = telefone;
    }

    const confirmadas = [];
    for (const idBruto of ids) {
      const cameraId = canonicalCameraId(idBruto);
      const current = byId.get(idBruto) || byId.get(cameraId) || byId.get(String(idBruto));
      if (!current) {
        summary.ignoradas++;
        summary.erros.push(`Câmera não encontrada: ${idBruto}`);
        continue;
      }
      if (current.status === 'Resolvido') {
        summary.ignoradas++;
        continue;
      }
      const mudou = Object.keys(fields).some(k => String(current[k] || '') !== String(fields[k] || ''));
      if (mudou) confirmadas.push(cameraId);
      else summary.ignoradas++;
      byId.set(cameraId, { ...current, ...fields });
    }

    if (!confirmadas.length || dryRun) continue;
    if (typeof db.updateCamerasBulk === 'function') {
      await db.updateCamerasBulk(confirmadas, fields, tenantId);
    } else {
      for (const cameraId of confirmadas) await db.updateCamera(cameraId, fields, tenantId);
    }
    summary.aplicadas += confirmadas.length;
    summary.detalhes.push({ responsavel_nome: nome, cameraIds: confirmadas, fields });
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

// Converte os itens já carregados no Painel NOC para o CSV canônico de importação.
function serializeNocItemsToCsv(items = []) {
  const header = 'ID;Nome;Município;Responsável;Marcadores;Status;Data resolução;Observação;Último status;Tempo offline;Desconexões 24h;SLA 24h;SLA total';
  const cell = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const rows = (items || []).map(item => [
    item.idTexto || item.id || item.ID || '',
    item.nome || item.Nome || '',
    item.municipio || item.Município || '',
    Array.isArray(item.responsaveis) ? item.responsaveis.join(' | ') : (item.responsavel || item.Responsável || ''),
    Array.isArray(item.marcadores) ? item.marcadores.join(' | ') : (item.marcadores || ''),
    item.status || item.Status || '',
    item.dataResolucao || item['Data resolução'] || '',
    item.observacao || item.Observação || '',
    item.ultimo || item['Último status'] || '',
    item.offlineStr || item.tempo || item['Tempo offline'] || '',
    item.desc24 ?? item['Desconexões 24h'] ?? '',
    item.sla24 ?? item['SLA 24h'] ?? '',
    item.slaTotal ?? item['SLA total'] ?? ''
  ].map(cell).join(';'));
  return [header, ...rows].join('\n');
}

// O bot usa os itens do Painel NOC, um CSV enviado ou o export padrão em disco.
function readNocCsvSource(options = {}) {
  const csv = typeof options.csv === 'string' ? options.csv : '';
  if (csv.trim()) return { csvText: csv, sourceFile: clean(options.filename || 'upload.csv') };
  if (Array.isArray(options.items) && options.items.length) {
    return { items: options.items, sourceFile: clean(options.filename || 'painel-noc') };
  }

  const dirs = [];
  if (String(process.env.NOC_WATCH_DIR || '').trim()) dirs.push(path.resolve(process.env.NOC_WATCH_DIR));
  dirs.push(path.resolve(__dirname, '..', 'importacao', 'entrada'));
  dirs.push(path.join(process.cwd(), 'importacao', 'entrada'));

  const candidates = [];
  if (options.filePath) candidates.push(String(options.filePath));
  if (options.filename) {
    const base = path.basename(String(options.filename));
    for (const dir of dirs) candidates.push(path.join(dir, base));
  }
  for (const dir of dirs) candidates.push(path.join(dir, 'noc-original.csv'));

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      return { csvText: fs.readFileSync(filePath, 'utf8'), sourceFile: path.basename(filePath) };
    } catch (error) {
      // Tenta a próxima origem.
    }
  }
  throw new Error('Nenhum CSV do NOC encontrado. Envie body.csv ou coloque noc-original.csv em importacao/entrada.');
}

async function prepareNocDrafts({ db, csvText, items, tenantId = 'default', sourceFile = '', dryRun = false, preserveDraftNames = true } = {}) {
  const effectiveCsv = String(csvText || '').trim()
    ? csvText
    : (Array.isArray(items) && items.length ? serializeNocItemsToCsv(items) : '');
  const sync = await syncNocCameras({ db, csvText: effectiveCsv, tenantId, sourceFile, dryRun, preserveDraftNames });
  const cameras = await db.getCameras(tenantId);
  const built = buildNocAssignments({ csvText: effectiveCsv, cameras });
  return {
    sourceFile: sync.sourceFile,
    sync,
    created: sync.created,
    updated: sync.updated,
    unchanged: sync.unchanged,
    semTelefone: sync.semTelefone,
    assignments: built.assignments,
    drafts: built.semTelefone,
    offline: built.offline,
    errors: [...sync.errors, ...built.errors],
    finishedAt: new Date().toISOString()
  };
}

async function runNocDraftBot({ db, tenantId = 'default', options = {} } = {}) {
  const source = readNocCsvSource(options);
  const prepared = await prepareNocDrafts({
    db,
    csvText: source.csvText,
    items: source.items,
    tenantId,
    sourceFile: source.sourceFile,
    dryRun: options.dryRun === true
  });
  const grupos = Array.isArray(options.groups) && options.groups.length
    ? await applyNocGroups({ db, tenantId, groups: options.groups, dryRun: options.dryRun === true })
    : { grupos: 0, aplicadas: 0, ignoradas: 0, erros: [], detalhes: [] };
  return { ...prepared, grupos };
}

module.exports = {
  parseNocCsv,
  syncNocCameras,
  importNocFile,
  mapNocStatus,
  mergeObservacoes,
  normalizeNocRow,
  isOfflineNocStatus,
  buildNocAssignments,
  applyNocAssignments,
  applyNocGroups,
  serializeNocItemsToCsv,
  readNocCsvSource,
  prepareNocDrafts,
  runNocDraftBot
};
