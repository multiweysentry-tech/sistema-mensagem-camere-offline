'use strict';

/**
 * Regras de negócio do painel NOC.
 * Módulo puro (sem I/O): recebe o texto do CSV e devolve os mesmos objetos
 * usados pelo index.html (stats, data, resumoMunicipios).
 */

const BOM = '\uFEFF';

const stripAccents = s => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normKey = s => stripAccents(String(s ?? ''))
  .toUpperCase().replace(/\s+/g, ' ').trim();

const limpar = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function detectSeparator(texto) {
  const primeira = String(texto || '').replace(/^\uFEFF/, '')
    .split(/\r?\n/).find(l => l.trim()) || '';
  const semis = (primeira.match(/;/g) || []).length;
  const virgulas = (primeira.match(/,/g) || []).length;
  return semis >= virgulas ? ';' : ',';
}

/** Parser de CSV com aspas duplas, separador configurável e BOM. */
function parseCSV(texto, separador) {
  const sep = separador || detectSeparator(texto);
  const fonte = String(texto || '').replace(/^\uFEFF/, '');
  const linhas = [];
  let linha = [], campo = '', dentroAspas = false;

  for (let i = 0; i < fonte.length; i++) {
    const c = fonte[i];
    if (dentroAspas) {
      if (c === '"') {
        if (fonte[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else campo += c;
    } else if (c === '"' && campo === '') dentroAspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter(r => r.length > 1 && r.some(v => String(v).trim() !== ''));
}

function mapearColunas(cabecalho) {
  const indice = {};
  cabecalho.forEach((nome, i) => { indice[normKey(nome)] = i; });
  const escolher = (...nomes) => {
    for (const nome of nomes) {
      const i = indice[normKey(nome)];
      if (i !== undefined) return i;
    }
    return -1;
  };
  return {
    id: escolher('ID', 'ID Camera', 'ID Câmera', 'Camera ID', 'Câmera ID'),
    nome: escolher('Nome', 'Camera', 'Câmera', 'Camera Nome', 'Câmera Nome', 'Nome Camera', 'Nome Câmera'),
    municipio: escolher('Município', 'Municipio', 'Local', 'Cidade'),
    responsavel: escolher('Responsável', 'Responsavel', 'Responsavel Nome'),
    marcadores: escolher('Marcadores', 'Tags'),
    status: escolher('Status'),
    ultimo: escolher('Último status', 'Ultimo status', 'Ultimo Status'),
    tempo: escolher('Tempo offline', 'Tempo Offline'),
    desc24: escolher('Desconexões 24h', 'Desconexoes 24h', 'Desconexoes', 'Desc. 24h'),
    sla24: escolher('SLA 24h'),
    slaTotal: escolher('SLA total', 'SLA Total'),
  };
}

function validarCabecalho(colunas) {
  const faltando = [];
  if (colunas.id < 0) faltando.push('ID');
  if (colunas.nome < 0) faltando.push('Nome');
  if (colunas.municipio < 0) faltando.push('Município');
  if (colunas.status < 0) faltando.push('Status');
  if (faltando.length) {
    throw new Error(`CSV do NOC inválido. Colunas obrigatórias ausentes: ${faltando.join(', ')}`);
  }
}

function parseOfflineMinutes(str) {
  if (!str || !String(str).trim()) return 0;
  let min = 0;
  const d = String(str).match(/(\d+)\s*d/i); if (d) min += Number(d[1]) * 1440;
  const h = String(str).match(/(\d+)\s*h/i); if (h) min += Number(h[1]) * 60;
  const m = String(str).match(/(\d+)\s*(?:min|m)\b/i); if (m) min += Number(m[1]);
  return min;
}

function parseDate(str) {
  const m = String(str || '').match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

function categoriaDe(nome, marcadores) {
  const n = stripAccents(String(nome || '').toUpperCase());
  const mk = stripAccents(String(marcadores || '').toUpperCase());
  if (mk.includes('ESCOLAS') || n.startsWith('SEDUC')) return 'Escolas (SEDUC)';
  if (mk.includes('CDL') || n.startsWith('CDL')) return 'CDL (Comércio)';
  if (mk.includes('CBMMT') || n.startsWith('CBMMT')) return 'CBMMT (Bombeiros)';
  if (n.startsWith('GEFRON')) return 'GEFRON';
  if (mk.includes('SINFRA') || n.startsWith('SINFRA')) return 'SINFRA';
  if (mk.includes('AEDIC') || n.startsWith('AEDIC')) return 'AEDIC';
  if (mk.includes('CIA CENTRAL')) return 'Segurança Pública';
  return 'Municipal / Outros';
}

const SEVERIDADES = [
  { key: 's0', label: 'Recente (< 1h)', min: 0, max: 60 },
  { key: 's1', label: '1h – 24h', min: 60, max: 1440 },
  { key: 's2', label: '1 – 3 dias', min: 1440, max: 4320 },
  { key: 's3', label: '3 – 7 dias', min: 4320, max: 10080 },
  { key: 's4', label: 'Crítico (> 7 dias)', min: 10080, max: Infinity },
];

function severidadeDe(camera) {
  if (!camera || camera.status === 'Online') return null;
  return SEVERIDADES.find(s => camera.offlineMin >= s.min && camera.offlineMin < s.max) || null;
}

/**
 * Normaliza as linhas do CSV para o formato consumido pelo painel.
 * @returns {{stats:object, data:Array, resumoMunicipios:Array, erros:string[]}}
 */
function normalizar(linhas, opcoes = {}) {
  if (!Array.isArray(linhas) || linhas.length < 2) {
    throw new Error('CSV vazio ou sem linhas de dados');
  }
  const colunas = mapearColunas(linhas[0]);
  validarCabecalho(colunas);
  const erros = [];
  const munDisplay = new Map();
  const data = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    const valor = indice => indice >= 0 ? limpar(linha[indice]) : '';
    const id = valor(colunas.id);
    const idTexto = id; // preserva zeros à esquerda e IDs acima de 2^53
    const nome = valor(colunas.nome);
    const municipioBruto = valor(colunas.municipio);
    if (!id || !nome) {
      erros.push(`Linha ${i + 1}: ID e Nome são obrigatórios (registro ignorado)`);
      continue;
    }
    const municipio = municipioBruto.replace(/\s*-\s*MT$/i, '');
    const key = normKey(municipio);
    const temAcento = /[À-ú]/.test(municipio);
    const anterior = munDisplay.get(key);
    if (!anterior || (temAcento && !anterior.temAcento)) {
      munDisplay.set(key, { name: municipio, temAcento });
    }
    const status = valor(colunas.status);
    const tempo = valor(colunas.tempo);
    const sla24 = valor(colunas.sla24);
    const slaTotal = valor(colunas.slaTotal);
    const ultimo = valor(colunas.ultimo);

    data.push({
      id: Number(id) || id,
      idTexto,
      nome: nome.replace(/\s+/g, ' ').trim(),
      municipio: munDisplay.get(key).name,
      responsaveis: valor(colunas.responsavel)
        ? valor(colunas.responsavel).split('|').map(s => s.trim()).filter(Boolean)
        : [],
      marcadores: valor(colunas.marcadores),
      categoria: categoriaDe(nome, valor(colunas.marcadores)),
      status,
      ultimo,
      ultimoTs: parseDate(ultimo),
      offlineMin: parseOfflineMinutes(tempo),
      offlineStr: tempo || (status === 'Online' ? '—' : 'agora'),
      desc24: Number(valor(colunas.desc24)) || 0,
      sla24: parseInt(sla24, 10) || 0,
      slaTotal: parseInt(slaTotal, 10) || 0,
    });
  }
  if (!data.length) throw new Error('Nenhuma câmera válida encontrada no CSV');

  const porMunicipio = {};
  for (const d of data) {
    const m = porMunicipio[d.municipio] || (porMunicipio[d.municipio] = {
      total: 0, offline: 0, desc24: 0, slaSoma: 0, maxOfflineMin: 0,
    });
    m.total++;
    m.desc24 += d.desc24;
    m.slaSoma += d.slaTotal;
    if (d.status !== 'Online') {
      m.offline++;
      m.maxOfflineMin = Math.max(m.maxOfflineMin, d.offlineMin);
    }
  }
  const resumoMunicipios = Object.entries(porMunicipio)
    .map(([nome, m]) => ({ municipio: nome, ...m, slaMedio: Math.round(m.slaSoma / m.total) }))
    .sort((a, b) => b.offline - a.offline || a.municipio.localeCompare(b.municipio, 'pt-BR'));

  const offline = data.filter(d => d.status !== 'Online');
  const stats = {
    total: data.length,
    offline: offline.length,
    online: data.length - offline.length,
    municipios: Object.keys(porMunicipio).length,
    municipiosAfetados: resumoMunicipios.filter(m => m.offline > 0).length,
    mais24h: offline.filter(d => d.offlineMin >= 1440).length,
    mais7d: offline.filter(d => d.offlineMin >= 10080).length,
    desc24Total: data.reduce((soma, d) => soma + d.desc24, 0),
    slaMedio: Math.round(data.reduce((soma, d) => soma + d.slaTotal, 0) / data.length),
    geradoEm: opcoes.geradoEm || new Date().toLocaleString('pt-BR'),
    arquivoFonte: opcoes.arquivoFonte || 'noc-original.csv',
  };
  return { stats, data, resumoMunicipios, erros };
}

/** Constrói o payload exato esperado pelo painel HTML. */
function construirPayload(textoCSV, opcoes = {}) {
  const linhas = parseCSV(textoCSV, opcoes.separador);
  const { stats, data, resumoMunicipios, erros } = normalizar(linhas, opcoes);
  return { stats, data, resumoMunicipios, erros };
}

const ORDENAVEIS = new Set([
  'id', 'nome', 'municipio', 'categoria', 'status', 'offlineMin',
  'ultimo', 'desc24', 'sla24', 'slaTotal',
]);

/** Aplica os mesmos filtros/ordenação da interface ao conjunto de câmeras. */
function filtrar(data, filtros = {}) {
  const q = normKey(filtros.q);
  const { municipio, categoria, status, severidade } = filtros;
  let itens = data.filter(d => {
    if (status && d.status !== status) return false;
    if (municipio && d.municipio !== municipio) return false;
    if (categoria && d.categoria !== categoria) return false;
    if (severidade) {
      const s = severidadeDe(d);
      if (!s || s.key !== severidade) return false;
    }
    if (q) {
      const texto = normKey([d.idTexto, d.nome, d.municipio, d.categoria, d.responsaveis.join(' '), d.marcadores]
        .join(' '));
      if (!texto.includes(q)) return false;
    }
    return true;
  });

  const chave = ORDENAVEIS.has(filtros.ordenar) ? filtros.ordenar : 'offlineMin';
  const dir = String(filtros.direcao || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  itens = [...itens].sort((a, b) => {
    let va = a[chave], vb = b[chave];
    if (chave === 'ultimo') { va = a.ultimoTs || 0; vb = b.ultimoTs || 0; }
    if (typeof va === 'string') return dir * va.localeCompare(vb, 'pt-BR');
    if (Array.isArray(va)) return dir * String(va).localeCompare(String(vb), 'pt-BR');
    return dir * ((Number(va) || 0) - (Number(vb) || 0));
  });
  return itens;
}

function csvOrganizado(payload) {
  const cabecalho = 'ID;Nome;Município;Categoria;Responsável;Marcadores;Status;Último status;Tempo offline;Minutos offline;Desconexões 24h;SLA 24h;SLA total';
  const linhas = [...payload.data].sort((a, b) =>
    a.municipio.localeCompare(b.municipio, 'pt-BR') || b.offlineMin - a.offlineMin || Number(a.id) - Number(b.id)
  ).map(d => [
    d.idTexto, d.nome, d.municipio, d.categoria, d.responsaveis.join(' | '), d.marcadores, d.status,
    d.ultimo, d.offlineStr, d.offlineMin, d.desc24, `${d.sla24}%`, `${d.slaTotal}%`,
  ]);
  return [cabecalho, ...linhas.map(linha => linha.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))].join('\r\n');
}

function csvResumo(payload) {
  const cabecalho = 'Município;Total de câmeras;Offline;Desconexões 24h;SLA médio;Maior tempo offline (min)';
  const linhas = payload.resumoMunicipios.map(m =>
    [m.municipio, m.total, m.offline, m.desc24, `${m.slaMedio}%`, m.maxOfflineMin]);
  return [cabecalho, ...linhas.map(linha => linha.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))].join('\r\n');
}

function csvFiltrado(itens) {
  const cabecalho = 'ID;Nome;Município;Categoria;Responsáveis;Marcadores;Status;Último status;Tempo offline;Desconexões 24h;SLA 24h;SLA total';
  const linhas = itens.map(d => [
    d.idTexto, d.nome, d.municipio, d.categoria, d.responsaveis.join(' | '), d.marcadores, d.status,
    d.ultimo, d.offlineStr, d.desc24, `${d.sla24}%`, `${d.slaTotal}%`,
  ]);
  return [cabecalho, ...linhas.map(linha => linha.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))].join('\r\n');
}

/** Serializa o payload para dentro de <script> sem permitir o fechamento da tag. */
function jsonParaScript(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderizarHTML(template, payload) {
  const marcador = '/*__DATA__*/null';
  if (!template.includes(marcador)) {
    throw new Error('Template do painel não contém o marcador /*__DATA__*/null');
  }
  return template.replace(marcador, () => jsonParaScript(payload));
}

module.exports = {
  BOM,
  SEVERIDADES,
  stripAccents,
  normKey,
  detectSeparator,
  parseCSV,
  parseOfflineMinutes,
  parseDate,
  categoriaDe,
  severidadeDe,
  normalizar,
  construirPayload,
  filtrar,
  csvOrganizado,
  csvResumo,
  csvFiltrado,
  jsonParaScript,
  renderizarHTML,
};
