const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { normalizarContato, telefoneBrasileiroValido } = require('../phone-utils');

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

async function extractPdfText(input) {
  let buffer;
  let filename = clean(input.filename || 'documento.pdf');
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (input.buffer) {
    buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
  } else if (input.base64) {
    buffer = Buffer.from(String(input.base64).replace(/^data:.*?base64,/, ''), 'base64');
  } else if (input.filePath) {
    filename = path.basename(input.filePath);
    buffer = fs.readFileSync(input.filePath);
  } else {
    throw new Error('Informe o PDF em base64, buffer ou filePath');
  }
  if (!buffer || !buffer.length) throw new Error('PDF vazio');
  if (buffer.length > 15 * 1024 * 1024) throw new Error('PDF muito grande (limite 15 MB)');

  const data = await pdfParse(buffer);
  const text = String(data.text || '').replace(/\r\n/g, '\n');
  const pages = Number(data.numpages || data.numPages || 0);
  return { filename, pages, text, info: data.info || {} };
}

function findPhones(text) {
  const matches = String(text || '').match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}/g) || [];
  const out = [];
  for (const m of matches) {
    const digits = normalizarContato(m);
    if (telefoneBrasileiroValido(digits) && !out.includes(digits)) out.push(digits);
  }
  return out;
}

function findCameraRefs(text, cameras) {
  const t = String(text || '');
  const found = new Map();
  const byId = new Map();
  const byNome = new Map();
  for (const c of cameras) {
    byId.set(String(c.id).toUpperCase(), c);
    const nome = clean(c.camera_nome).toUpperCase();
    if (nome) byNome.set(nome, c);
  }

  // IDs explícitos: NOC-123, CAM-123, ou id exato
  const idMatches = t.match(/\bNOC-\d+\b|\bCAM[-_ ]?\d+\b|\b\d{1,6}\b/g) || [];
  for (const raw of idMatches) {
    const token = raw.toUpperCase().replace(/\s+/g, '');
    let cam = byId.get(token) || byId.get(`NOC-${token}`) || byId.get(token.replace(/^CAM-?/, 'NOC-'));
    if (!cam && /^\d{1,6}$/.test(token)) cam = byId.get(`NOC-${token}`) || byId.get(token);
    if (cam) found.set(String(cam.id), { camera: cam, ref: raw, confidence: 'alta' });
  }

  // Nomes de câmera (match exato de nome longo para evitar falso positivo)
  for (const [nome, cam] of byNome.entries()) {
    if (nome.length < 6) continue;
    if (t.toUpperCase().includes(nome)) found.set(String(cam.id), { camera: cam, ref: cam.camera_nome, confidence: 'media' });
  }
  return [...found.values()];
}

function splitBlocks(text) {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map(b => b.split(/\n/).map(clean).filter(Boolean))
    .filter(b => b.length);
}

function extractAssignmentsFromText(text, cameras) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').map(clean);
  const assignments = [];
  const warnings = [];

  function addOrMerge(assignment) {
    const existing = assignments.find(a => String(a.cameraId) === String(assignment.cameraId));
    if (!existing) { assignments.push(assignment); return; }
    for (const k of ['responsavel_nome', 'responsavel_telefone', 'local']) {
      if (!existing[k] && assignment[k]) existing[k] = assignment[k];
    }
    if (existing.action === 'detected_only' && assignment.action === 'proposed') existing.action = 'proposed';
    if (assignment.confidence === 'alta') existing.confidence = 'alta';
    else if (assignment.confidence === 'media' && existing.confidence === 'baixa') existing.confidence = 'media';
  }

  function extractFromLine(line, ref, phones) {
    const phone = phones[0] || '';
    let responsavel = '';
    const mResp = line.match(/respons[aá]vel\s*[:\-]\s*([^|;\n]+)/i);
    if (mResp) {
      responsavel = clean(mResp[1])
        .replace(/telefone\s*[:\-].*/i, '')
        .replace(/local\s*[:\-].*/i, '')
        .replace(/munic[ií]pio\s*[:\-].*/i, '')
        .replace(/destino\s*[:\-].*/i, '')
        .replace(/\(?\+?\s*55\s*\)?\s*\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}.*/g, '')
        .replace(/\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}.*/g, '')
        .trim()
        .replace(/[|;,\-\/:]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!responsavel) {
      // tenta pegar texto ao redor removendo id, telefone e rótulos conhecidos
      let maybe = line;
      if (phone) {
        const phoneRe = new RegExp(phone.split('').join('\\D*'));
        maybe = maybe.replace(phoneRe, ' ');
      }
      maybe = maybe.replace(new RegExp(String(ref.ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')
                   .replace(/\bNOC-\d+\b/gi, ' ')
                   .replace(/respons[aá]vel|telefone|local|munic[ií]pio|cidade|destino/gi, ' ')
                   .replace(/[|;:,\-]+/g, ' ')
                   .replace(/\d{2,}/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();
      if (maybe.length >= 3 && maybe.length <= 80 && /[A-Za-zÀ-ÿ]/.test(maybe)) responsavel = maybe;
    }

    const localMatch = line.match(/(?:local|munic[ií]pio|cidade|destino)\s*[:\-]\s*([^|;\n]+)/i);
    let local = localMatch ? clean(localMatch[1]).replace(/respons[aá]vel\s*[:\-].*/i, '').replace(/telefone\s*[:\-].*/i, '').trim() : '';
    local = clean(local);

    return { responsavel, phone, local };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const refsInLine = findCameraRefs(line, cameras);
    if (!refsInLine.length) continue;

    for (const ref of refsInLine) {
      const phonesInLine = findPhones(line);
      let info = extractFromLine(line, ref, phonesInLine);

      // se não achou dados úteis na linha, olha vizinhas que não tenham outras câmeras
      if (!info.phone && !info.responsavel && !info.local) {
        for (const j of [i - 1, i + 1]) {
          const adj = lines[j] || '';
          if (!adj) continue;
          const refsAdj = findCameraRefs(adj, cameras).filter(r => String(r.camera.id) !== String(ref.camera.id));
          if (refsAdj.length) continue; // evita contaminação
          const adjInfo = extractFromLine(adj, ref, findPhones(adj));
          if (!info.phone && adjInfo.phone) info.phone = adjInfo.phone;
          if (!info.responsavel && adjInfo.responsavel) info.responsavel = adjInfo.responsavel;
          if (!info.local && adjInfo.local) info.local = adjInfo.local;
        }
      }

      addOrMerge({
        cameraId: String(ref.camera.id),
        camera_nome: ref.camera.camera_nome,
        currentResponsavel: ref.camera.responsavel_nome || '',
        currentTelefone: ref.camera.responsavel_telefone || '',
        currentLocal: ref.camera.local || '',
        responsavel_nome: info.responsavel || '',
        responsavel_telefone: info.phone || '',
        local: info.local || '',
        confidence: info.phone ? (info.responsavel ? 'alta' : 'media') : (info.responsavel || info.local ? 'baixa' : 'baixa'),
        sourceLine: line.slice(0, 220),
        action: (info.phone || info.responsavel || info.local) ? 'proposed' : 'detected_only'
      });
    }
  }

  return { assignments, warnings };
}

async function scanPdfForAssignments({ db, tenantId = 'default', ...input }) {
  const { filename, pages, text } = await extractPdfText(input);
  const cameras = await db.getCameras(tenantId);
  const { assignments, warnings } = extractAssignmentsFromText(text, cameras);

  const withAction = assignments.filter(a => a.action === 'proposed');
  const detectedOnly = assignments.filter(a => a.action === 'detected_only');

  return {
    filename,
    pages,
    textLength: text.length,
    textPreview: text.slice(0, 6000),
    totalCamerasInDb: cameras.length,
    detected: assignments.length,
    proposed: withAction.length,
    detectedOnly: detectedOnly.length,
    assignments,
    warnings
  };
}

async function applyPdfAssignments({ db, tenantId = 'default', assignments = [], dryRun = false }) {
  if (!Array.isArray(assignments) || !assignments.length) {
    throw new Error('Nenhuma atribuição para aplicar');
  }
  const cameras = await db.getCameras(tenantId);
  const byId = new Map(cameras.map(c => [String(c.id), c]));
  const summary = { total: assignments.length, applied: 0, skipped: 0, errors: [], details: [] };

  for (const a of assignments) {
    const cameraId = String(a.cameraId || '');
    const current = byId.get(cameraId);
    if (!current) { summary.skipped++; summary.errors.push(`Câmera não encontrada: ${cameraId}`); continue; }

    const fields = {};
    const tel = clean(a.responsavel_telefone);
    const nome = clean(a.responsavel_nome);
    const local = clean(a.local);

    if (tel) {
      const normalized = normalizarContato(tel);
      if (!telefoneBrasileiroValido(normalized)) {
        summary.skipped++; summary.errors.push(`${cameraId}: telefone inválido (${tel})`); continue;
      }
      fields.responsavel_telefone = normalized;
    }
    if (nome) fields.responsavel_nome = nome;
    if (local) fields.local = local;

    if (!Object.keys(fields).length) { summary.skipped++; continue; }

    const changed = Object.keys(fields).some(k => String(current[k] || '') !== String(fields[k] || ''));
    if (!changed) { summary.skipped++; summary.details.push({ cameraId, action: 'unchanged' }); continue; }

    if (!dryRun) {
      await db.updateCamera(cameraId, fields, tenantId);
      await db.addLog({
        timestamp: new Date().toISOString(),
        camera_id: cameraId,
        camera_nome: current.camera_nome,
        responsavel_telefone: fields.responsavel_telefone || current.responsavel_telefone || '',
        acao: 'DESTINACAO_PDF',
        detalhe: `Atribuição por PDF: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`,
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

module.exports = { extractPdfText, scanPdfForAssignments, applyPdfAssignments, extractAssignmentsFromText };
