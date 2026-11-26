'use strict';

/**
 * Backend HTTP do Painel NOC — Node puro, sem dependências externas.
 * Uso: node backend/server.js
 *
 * Variáveis de ambiente:
 *   PAINEL_HOST        host de escuta (padrão 127.0.0.1)
 *   PAINEL_PORT        porta (padrão 3001)
 *   PAINEL_API_TOKEN   se definido, exige header x-api-key em /api/*
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const arquivos = require('./arquivos');
const noc = require('./noc-data');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function responderJSON(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

function responderTexto(res, status, texto, tipo, headers = {}) {
  res.writeHead(status, {
    'Content-Type': tipo || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(texto);
}

function erro(res, status, codigo, mensagem) {
  return responderJSON(res, status, { codigo, erro: mensagem });
}

function lerCorpo(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    let excedeu = false;
    req.on('data', parte => {
      tamanho += parte.length;
      // Descarta o excedente sem destruir o socket: o handler precisa poder
      // responder 413 antes de encerrar a conexão.
      if (tamanho > limiteBytes) { excedeu = true; return; }
      partes.push(parte);
    });
    req.on('end', () => {
      if (excedeu) {
        return reject(Object.assign(new Error('Corpo da requisição muito grande'), { codigo: 'PAYLOAD_TOO_LARGE' }));
      }
      resolve(Buffer.concat(partes).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function tokenValido(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function paramsFiltro(url) {
  const p = url.searchParams;
  const numero = (nome, padrao, min, max) => {
    const bruto = p.get(nome);
    if (bruto === null) return padrao;
    const valor = Number(bruto);
    return Number.isInteger(valor) && valor >= min && valor <= max ? valor : null;
  };
  if (numero('limite', 100, 1, 10000) === null) return { erro: 'limite deve estar entre 1 e 10000' };
  if (numero('deslocamento', 0, 0, 1000000) === null) return { erro: 'deslocamento deve estar entre 0 e 1000000' };
  return {
    filtros: {
      q: p.get('q') || '',
      municipio: p.get('municipio') || '',
      categoria: p.get('categoria') || '',
      status: p.get('status') || '',
      severidade: p.get('severidade') || '',
      ordenar: p.get('ordenar') || 'offlineMin',
      direcao: p.get('direcao') || 'desc',
    },
    limite: numero('limite', 100, 1, 10000),
    deslocamento: numero('deslocamento', 0, 0, 1000000),
  };
}

function caminhoEstatico(raiz, pathname) {
  let relativo;
  try {
    relativo = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null; // %ZZ e outras sequências inválidas não são um arquivo
  }
  if (!relativo || relativo.split(/[\\/]/).some(parte => parte === '..' || parte.startsWith('.'))) return null;
  const alvo = path.resolve(raiz, relativo);
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) return null;
  const partes = path.relative(raiz, alvo).split(path.sep);
  if (partes.includes('backend') || partes.includes('backups')) return null;
  if (!TIPOS[path.extname(alvo).toLowerCase()]) return null;
  return alvo;
}

function criarServidor(opcoes = {}) {
  const raiz = path.resolve(opcoes.raiz || arquivos.RAIZ);
  const token = String(opcoes.token ?? process.env.PAINEL_API_TOKEN ?? '');
  const limiteBytes = Number(opcoes.limiteBytes || 10 * 1024 * 1024);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rota = url.pathname;

      if (token && rota.startsWith('/api/')) {
        if (!tokenValido(req.headers['x-api-key'], token)) {
          return erro(res, 401, 'UNAUTHORIZED', 'Informe o header x-api-key');
        }
      }

      if (rota.startsWith('/api/')) return await rotaAPI(req, res, url, { raiz, limiteBytes });
      if (req.method !== 'GET' && req.method !== 'HEAD') return erro(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido');

      // O painel standalone usa a mesma regra de telefone do aplicativo.
      if (rota === '/phone-utils.js') {
        const origem = path.resolve(raiz, '..', 'phone-utils.js');
        if (!fs.existsSync(origem) || !fs.statSync(origem).isFile()) {
          return responderTexto(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
        }
        const conteudo = fs.readFileSync(origem);
        res.writeHead(200, {
          'Content-Type': TIPOS['.js'],
          'Content-Length': conteudo.length,
          'Cache-Control': 'no-store',
        });
        return res.end(req.method === 'HEAD' ? undefined : conteudo);
      }

      const alvo = caminhoEstatico(raiz, rota);
      if (!alvo || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) {
        return responderTexto(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
      }
      const conteudo = fs.readFileSync(alvo);
      res.writeHead(200, {
        'Content-Type': TIPOS[path.extname(alvo).toLowerCase()],
        'Content-Length': conteudo.length,
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : conteudo);
    } catch (falha) {
      const codigo = falha.codigo || 'INTERNAL_ERROR';
      const status = codigo === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
      if (res.headersSent) return res.end();
      return erro(res, status, codigo, falha.message || 'Erro interno do servidor');
    }
  });
}

async function rotaAPI(req, res, url, ctx) {
  const { raiz, limiteBytes } = ctx;
  const payload = () => arquivos.obterPayload({ raiz });

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const stats = payload().stats;
    return responderJSON(res, 200, {
      status: 'ok', total: stats.total, offline: stats.offline,
      fonte: stats.arquivoFonte, geradoEm: stats.geradoEm,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/painel') {
    return responderJSON(res, 200, payload());
  }

  if (req.method === 'GET' && url.pathname === '/api/estatisticas') {
    return responderJSON(res, 200, payload().stats);
  }

  if (req.method === 'GET' && url.pathname === '/api/camaras') {
    const opcoes = paramsFiltro(url);
    if (opcoes.erro) return erro(res, 400, 'VALIDATION_ERROR', opcoes.erro);
    const todos = noc.filtrar(payload().data, opcoes.filtros);
    const itens = todos.slice(opcoes.deslocamento, opcoes.deslocamento + opcoes.limite);
    return responderJSON(res, 200, {
      total: todos.length,
      limite: opcoes.limite,
      deslocamento: opcoes.deslocamento,
      itens,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/municipios') {
    const q = (url.searchParams.get('q') || '').toLocaleLowerCase('pt-BR');
    const lista = payload().resumoMunicipios
      .filter(m => !q || m.municipio.toLocaleLowerCase('pt-BR').includes(q));
    return responderJSON(res, 200, { total: lista.length, itens: lista });
  }

  if (req.method === 'GET' && url.pathname === '/api/categorias') {
    const categorias = [...new Set(payload().data.map(d => d.categoria))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return responderJSON(res, 200, categorias);
  }

  if (req.method === 'GET' && url.pathname === '/api/severidades') {
    return responderJSON(res, 200, noc.SEVERIDADES.map(({ key, label }) => ({ key, label })));
  }

  if (req.method === 'GET' && url.pathname === '/api/exportar.csv') {
    const opcoes = paramsFiltro(url);
    if (opcoes.erro) return erro(res, 400, 'VALIDATION_ERROR', opcoes.erro);
    const itens = noc.filtrar(payload().data, opcoes.filtros);
    const csv = noc.BOM + noc.csvFiltrado(itens);
    return responderTexto(res, 200, csv, 'text/csv; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="noc-filtrado.csv"',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/importar') {
    const tipo = String(req.headers['content-type'] || '').toLowerCase();
    let corpo;
    try { corpo = await lerCorpo(req, limiteBytes); }
    catch (falha) { return erro(res, falha.codigo === 'PAYLOAD_TOO_LARGE' ? 413 : 400, falha.codigo || 'IMPORT_ERROR', falha.message); }

    let textoCSV = '';
    let nomeArquivo = 'noc-original.csv';
    let dryRun = false;
    if (tipo.includes('application/json')) {
      let json;
      try { json = JSON.parse(corpo); }
      catch { return erro(res, 400, 'INVALID_JSON', 'JSON inválido'); }
      textoCSV = typeof json?.csv === 'string' ? json.csv : '';
      nomeArquivo = String(json?.nomeArquivo || json?.filename || nomeArquivo);
      dryRun = json?.dryRun === true;
    } else {
      textoCSV = corpo;
      nomeArquivo = String(url.searchParams.get('arquivo') || 'noc-original.csv');
      dryRun = url.searchParams.get('dryRun') === 'true';
    }
    try {
      const resultado = arquivos.importarCSV({ textoCSV, nomeArquivo, raiz, dryRun });
      return responderJSON(res, 200, { ok: true, ...resultado });
    } catch (falha) {
      return erro(res, 400, 'IMPORT_ERROR', falha.message);
    }
  }

  return erro(res, 404, 'NOT_FOUND', 'Rota não encontrada');
}

module.exports = { criarServidor, responderJSON, erro };

if (require.main === module) {
  const host = process.env.PAINEL_HOST || '127.0.0.1';
  const port = Number(process.env.PAINEL_PORT || 3001);
  const servidor = criarServidor();
  servidor.listen(port, host, () => {
    console.log(`Painel NOC backend: http://${host}:${port}`);
    console.log('Rotas: /api/health, /api/painel, /api/camaras, /api/municipios, /api/exportar.csv, POST /api/importar');
  });
}
