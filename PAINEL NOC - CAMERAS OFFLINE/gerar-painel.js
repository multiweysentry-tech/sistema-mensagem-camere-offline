/**
 * Gera o painel HTML local a partir do CSV exportado do NOC.
 * Uso: node gerar-painel.js "C:\caminho\para\noc.csv"
 * Sem argumento, usa o CSV padrão em Downloads.
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'C:\\Users\\Sentry\\Downloads\\noc (1).csv';
const outDir = __dirname;

// ---------- Parser CSV (separador ; com campos entre aspas) ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 && r.some(v => v.trim() !== ''));
}

// ---------- Helpers ----------
const stripAccents = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const normKey = s => stripAccents(s.toUpperCase().replace(/\s+/g, ' ').trim());

function parseOfflineMinutes(str) {
  if (!str || !str.trim()) return 0;
  let min = 0;
  const d = str.match(/(\d+)\s*d/); if (d) min += +d[1] * 1440;
  const h = str.match(/(\d+)\s*h/); if (h) min += +h[1] * 60;
  const m = str.match(/(\d+)\s*min/); if (m) min += +m[1];
  return min;
}

function parseDate(str) {
  const m = (str || '').match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

function categoriaDe(nome, marcadores) {
  const n = stripAccents(nome.toUpperCase());
  const mk = stripAccents(marcadores.toUpperCase());
  if (mk.includes('ESCOLAS') || n.startsWith('SEDUC')) return 'Escolas (SEDUC)';
  if (mk.includes('CDL') || n.startsWith('CDL')) return 'CDL (Comércio)';
  if (mk.includes('CBMMT') || n.startsWith('CBMMT')) return 'CBMMT (Bombeiros)';
  if (n.startsWith('GEFRON')) return 'GEFRON';
  if (mk.includes('SINFRA') || n.startsWith('SINFRA')) return 'SINFRA';
  if (mk.includes('AEDIC') || n.startsWith('AEDIC')) return 'AEDIC';
  if (mk.includes('CIA CENTRAL')) return 'Segurança Pública';
  return 'Municipal / Outros';
}

// ---------- Leitura e normalização ----------
const rows = parseCSV(fs.readFileSync(src, 'utf8'));
const header = rows.shift();

// Mapa de municípios: chave normalizada -> nome de exibição (prefere a versão acentuada)
const munDisplay = new Map();
const raw = rows.map(r => {
  const [id, nome, municipio, responsavel, marcadores, status, ultimo, tempo, desc, sla24, slaTotal] =
    r.map(v => (v || '').trim());
  const key = normKey(municipio.replace(/\s*-\s*MT$/i, ''));
  const hasAccent = /[À-ú]/.test(municipio);
  const prev = munDisplay.get(key);
  if (!prev || (hasAccent && !prev.hasAccent)) munDisplay.set(key, { name: municipio.replace(/\s*-\s*MT$/i, ''), hasAccent });
  return { id, nome, municipio, responsavel, marcadores, status, ultimo, tempo, desc, sla24, slaTotal, key };
});

const data = raw.map(r => ({
  id: +r.id,
  nome: r.nome.replace(/\s+/g, ' ').trim(),
  municipio: munDisplay.get(r.key).name,
  responsaveis: r.responsavel ? r.responsavel.split('|').map(s => s.trim()).filter(Boolean) : [],
  marcadores: r.marcadores,
  categoria: categoriaDe(r.nome, r.marcadores),
  status: r.status,
  ultimo: r.ultimo,
  ultimoTs: parseDate(r.ultimo),
  offlineMin: parseOfflineMinutes(r.tempo),
  offlineStr: r.tempo || (r.status === 'Online' ? '—' : 'agora'),
  desc24: +r.desc || 0,
  sla24: parseInt(r.sla24) || 0,
  slaTotal: parseInt(r.slaTotal) || 0,
}));

// ---------- Estatísticas ----------
const offline = data.filter(d => d.status !== 'Online');
const porMunicipio = {};
for (const d of data) {
  const m = porMunicipio[d.municipio] || (porMunicipio[d.municipio] = { total: 0, offline: 0, desc24: 0, slaSoma: 0, maxOfflineMin: 0 });
  m.total++; m.desc24 += d.desc24; m.slaSoma += d.slaTotal;
  if (d.status !== 'Online') { m.offline++; m.maxOfflineMin = Math.max(m.maxOfflineMin, d.offlineMin); }
}
const resumoMunicipios = Object.entries(porMunicipio)
  .map(([nome, m]) => ({ municipio: nome, ...m, slaMedio: Math.round(m.slaSoma / m.total) }))
  .sort((a, b) => b.offline - a.offline || a.municipio.localeCompare(b.municipio));

const stats = {
  total: data.length,
  offline: offline.length,
  online: data.length - offline.length,
  municipios: Object.keys(porMunicipio).length,
  municipiosAfetados: resumoMunicipios.filter(m => m.offline > 0).length,
  mais24h: offline.filter(d => d.offlineMin >= 1440).length,
  mais7d: offline.filter(d => d.offlineMin >= 10080).length,
  desc24Total: data.reduce((s, d) => s + d.desc24, 0),
  slaMedio: Math.round(data.reduce((s, d) => s + d.slaTotal, 0) / data.length),
  geradoEm: new Date().toLocaleString('pt-BR'),
  arquivoFonte: path.basename(src),
};

// ---------- Saídas ----------
// 1) CSV organizado (por município e tempo offline decrescente), com BOM p/ Excel
const csvHeader = 'ID;Nome;Município;Categoria;Responsável;Marcadores;Status;Último status;Tempo offline;Minutos offline;Desconexões 24h;SLA 24h;SLA total';
const sorted = [...data].sort((a, b) =>
  a.municipio.localeCompare(b.municipio, 'pt-BR') || b.offlineMin - a.offlineMin || a.id - b.id);
const csvLines = sorted.map(d => [
  d.id, d.nome, d.municipio, d.categoria, d.responsaveis.join(' | '), d.marcadores, d.status,
  d.ultimo, d.offlineStr, d.offlineMin, d.desc24, d.sla24 + '%', d.slaTotal + '%'
].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
fs.writeFileSync(path.join(outDir, 'noc-organizado.csv'), '﻿' + [csvHeader, ...csvLines].join('\r\n'), 'utf8');

// 2) Resumo por município em CSV
const resumoHeader = 'Município;Total de câmeras;Offline;Desconexões 24h;SLA médio;Maior tempo offline (min)';
const resumoLines = resumoMunicipios.map(m =>
  [m.municipio, m.total, m.offline, m.desc24, m.slaMedio + '%', m.maxOfflineMin].map(v => `"${v}"`).join(';'));
fs.writeFileSync(path.join(outDir, 'resumo-por-municipio.csv'), '﻿' + [resumoHeader, ...resumoLines].join('\r\n'), 'utf8');

// 3) Painel HTML autocontido (dados embutidos, funciona 100% offline)
const template = fs.readFileSync(path.join(outDir, 'painel-template.html'), 'utf8');
const payload = JSON.stringify({ stats, data, resumoMunicipios });
const html = template.replace('/*__DATA__*/null', () => payload);
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

console.log('OK! Gerado em:', outDir);
console.log(JSON.stringify(stats, null, 2));
