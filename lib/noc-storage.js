'use strict';

/**
 * Armazenamento dos arquivos importados pelo Painel NOC.
 *
 * Em produção o CSV fica no Postgres (tabela noc_arquivos). Quando o banco não
 * oferece os métodos próprios, usamos um fallback por instância de db apenas
 * para não quebrar testes/ambientes sem persistência.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const nocData = require('../PAINEL NOC - CAMERAS OFFLINE/backend/noc-data');

const MAX_CSV_BYTES = 12 * 1024 * 1024;
const fallbackDb = {};
const memoryByDb = new WeakMap();

function parseJson(value, fallback) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : (value || fallback);
  } catch {
    return fallback;
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    stats: parseJson(row.stats, {}),
    payload: parseJson(row.payload, null)
  };
}

function memoryStore(key) {
  const rows = new Map();
  return {
    async saveNocFile(row, tenantId = 'default') {
      const rowKey = `${String(tenantId || 'default')}::${row.id}`;
      rows.set(rowKey, { ...row, tenant_id: String(tenantId || 'default') });
      return row;
    },
    async getLatestNocFile(tenantId = 'default') {
      const t = String(tenantId || 'default');
      return [...rows.values()]
        .filter(row => String(row.tenant_id || 'default') === t)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    },
    async listNocFiles(tenantId = 'default', limit = 20) {
      const t = String(tenantId || 'default');
      return [...rows.values()]
        .filter(row => String(row.tenant_id || 'default') === t)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    },
    async deleteNocFiles(tenantId = 'default') {
      const t = String(tenantId || 'default');
      let removidos = 0;
      for (const [key, row] of rows) {
        if (String(row.tenant_id || 'default') !== t) continue;
        rows.delete(key);
        removidos++;
      }
      return removidos;
    }
  };
}

function storeFor(db) {
  if (db && typeof db.saveNocFile === 'function' && typeof db.getLatestNocFile === 'function') return db;
  const key = db && typeof db === 'object' ? db : fallbackDb;
  let store = memoryByDb.get(key);
  if (!store) {
    store = memoryStore(key);
    memoryByDb.set(key, store);
  }
  return store;
}

function buildPayload(csvText, filename, now) {
  const payload = nocData.construirPayload(csvText, {
    arquivoFonte: filename,
    geradoEm: now.toLocaleString('pt-BR')
  });
  if (!Array.isArray(payload.data) || !payload.data.length) {
    throw new Error('O arquivo não contém câmeras válidas para salvar');
  }
  if (payload.erros?.length) {
    throw new Error(payload.erros[0]);
  }
  const semMunicipio = payload.data.filter(d => !String(d.municipio || '').trim()).length;
  if (semMunicipio / payload.data.length > 0.2) {
    throw new Error('O CSV gerado está inconsistente: muitas linhas sem município. Processe o arquivo novamente antes de salvar.');
  }
  return {
    stats: payload.stats,
    data: payload.data,
    resumoMunicipios: payload.resumoMunicipios,
    erros: payload.erros
  };
}

async function saveNocFile({ db, tenantId = 'default', filename, csvText } = {}) {
  const csv = String(csvText || '').replace(/^\uFEFF/, '');
  if (!csv.trim()) throw new Error('Conteúdo CSV vazio');
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new Error('Arquivo muito grande para armazenar (limite: 12 MB)');
  }

  const now = new Date();
  const nome = path.basename(String(filename || 'noc-importado.csv')).slice(0, 200) || 'noc-importado.csv';
  const payload = buildPayload(csv, nome, now);
  const registro = {
    id: `${now.toISOString()}-${crypto.randomUUID()}`,
    tenant_id: String(tenantId || 'default'),
    nome,
    conteudo: csv,
    linhas: payload.data.length,
    stats: JSON.stringify(payload.stats),
    payload: JSON.stringify({ stats: payload.stats, data: payload.data, resumoMunicipios: payload.resumoMunicipios }),
    created_at: now.toISOString()
  };

  await storeFor(db).saveNocFile(registro, tenantId);
  return { registro: hydrate(registro), payload };
}

async function getLatestNocFile(db, tenantId = 'default') {
  return hydrate(await storeFor(db).getLatestNocFile(tenantId));
}

async function listNocFiles(db, tenantId = 'default', limit = 20) {
  const rows = await storeFor(db).listNocFiles(tenantId, limit);
  return rows.map(row => hydrate(row)).map(row => {
    const { conteudo, ...resto } = row;
    return resto;
  });
}

async function deleteNocFiles(db, tenantId = 'default') {
  const store = storeFor(db);
  if (typeof store.deleteNocFiles !== 'function') {
    throw new Error('Este armazenamento não permite excluir arquivos NOC');
  }
  return store.deleteNocFiles(tenantId);
}

module.exports = { saveNocFile, getLatestNocFile, listNocFiles, deleteNocFiles, MAX_CSV_BYTES };
