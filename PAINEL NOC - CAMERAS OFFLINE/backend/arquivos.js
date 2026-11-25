'use strict';

/**
 * Camada de persistência em arquivos do painel.
 * O CSV original continua sendo a fonte da verdade; os demais arquivos
 * (organizado, resumo e index.html) são derivados dele.
 */

const fs = require('fs');
const path = require('path');
const noc = require('./noc-data');

const RAIZ = path.resolve(__dirname, '..');
const cache = new Map();

function caminhos(raiz = RAIZ) {
  const base = path.resolve(raiz);
  return {
    raiz: base,
    original: path.join(base, 'noc-original.csv'),
    organizado: path.join(base, 'noc-organizado.csv'),
    resumo: path.join(base, 'resumo-por-municipio.csv'),
    template: path.join(base, 'painel-template.html'),
    index: path.join(base, 'index.html'),
    backups: path.join(base, 'backups'),
  };
}

function lerTexto(caminho) {
  return fs.readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');
}

let sequenciaTmp = 0;

/** Escrita atômica: grava em temporário e renomeia somente após sucesso. */
function escrever(caminho, conteudo) {
  const tmp = `${caminho}.tmp-${process.pid}-${++sequenciaTmp}`;
  try {
    fs.writeFileSync(tmp, conteudo, 'utf8');
    fs.renameSync(tmp, caminho);
  } catch (erro) {
    try { fs.unlinkSync(tmp); } catch {}
    throw erro;
  }
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Regenera os três artefatos derivados a partir de um texto CSV. */
function gerarArquivos(opcoes = {}) {
  const caminho = caminhos(opcoes.raiz);
  const texto = opcoes.textoCsv;
  if (typeof texto !== 'string' || !texto.trim()) {
    throw new Error('Informe o conteúdo do CSV');
  }
  // Constrói todo o conteúdo antes de gravar: uma falha de parsing ou de
  // leitura do template não pode deixar artefatos parcialmente atualizados.
  const payload = noc.construirPayload(texto, {
    arquivoFonte: opcoes.arquivoFonte || path.basename(caminho.original),
    geradoEm: opcoes.geradoEm,
  });
  const template = lerTexto(caminho.template);
  const htmlPayload = {
    stats: payload.stats,
    data: payload.data,
    resumoMunicipios: payload.resumoMunicipios,
  };
  const html = noc.renderizarHTML(template, htmlPayload);

  const saidas = [];
  if (opcoes.salvarOriginal) {
    saidas.push([caminho.original, noc.BOM + texto.replace(/^\uFEFF/, '')]);
  }
  saidas.push([caminho.organizado, noc.BOM + noc.csvOrganizado(payload)]);
  saidas.push([caminho.resumo, noc.BOM + noc.csvResumo(payload)]);
  saidas.push([caminho.index, html]);
  for (const [destino, conteudo] of saidas) escrever(destino, conteudo);

  const espelhos = [...(opcoes.espelharEm || []), ...raizesEspelho(caminho.raiz)];
  if (espelhos.length) espelhar(caminho, espelhos);

  // O cache representa noc-original.csv; a CLI com arquivo externo não deve
  // sobrescrevê-lo com dados que não estão na fonte da verdade.
  if (opcoes.salvarOriginal && opcoes.atualizarCache !== false) {
    atualizarCache(caminho.original, payload);
  }
  return { stats: payload.stats, payload, arquivos: caminho };
}

function atualizarCache(caminhoOriginal, payload) {
  try {
    const mtimeMs = fs.statSync(caminhoOriginal).mtimeMs;
    cache.set(caminhoOriginal, { mtimeMs, payload });
  } catch {
    cache.delete(caminhoOriginal);
  }
}

/** O timestamp embutido no index.html é a fonte canônica de geradoEm. */
function lerGeradoEmDoHTML(caminhoIndex) {
  try {
    const html = fs.readFileSync(caminhoIndex, 'utf8');
    const encontrado = /"geradoEm":"((?:\\.|[^"\\])*)"/.exec(html);
    return encontrado ? JSON.parse(`"${encontrado[1]}"`) : undefined;
  } catch {
    return undefined;
  }
}

/** Payload em memória, invalidado automaticamente quando o CSV muda no disco. */
function obterPayload(opcoes = {}) {
  const caminho = caminhos(opcoes.raiz);
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(caminho.original).mtimeMs; }
  catch (erro) { throw new Error(`CSV original não encontrado: ${caminho.original}`); }
  const entrada = cache.get(caminho.original);
  if (!opcoes.forcar && entrada && entrada.mtimeMs === mtimeMs) return entrada.payload;

  const payload = noc.construirPayload(lerTexto(caminho.original), {
    arquivoFonte: path.basename(caminho.original),
    geradoEm: lerGeradoEmDoHTML(caminho.index),
  });
  atualizarCache(caminho.original, payload);
  return payload;
}

/** Pastas irmãs que devem manter os mesmos artefatos publicados. */
function raizesEspelho(raiz) {
  if (path.resolve(raiz) !== RAIZ) return [];
  const espelho = path.resolve(__dirname, '..', '..', 'painel-noc');
  return fs.existsSync(espelho) && fs.statSync(espelho).isDirectory() ? [espelho] : [];
}

/** Copia os artefatos finais (não os intermediários) para as pastas espelho. */
function espelhar(caminho, raizes) {
  for (const raiz of raizes) {
    const base = path.resolve(raiz);
    if (base === caminho.raiz) continue;
    for (const chave of ['original', 'organizado', 'resumo', 'index']) {
      escrever(path.join(base, path.basename(caminho[chave])), fs.readFileSync(caminho[chave]));
    }
  }
}

function fazerBackup(caminho) {
  fs.mkdirSync(caminho.backups, { recursive: true });
  const selo = timestamp();
  const copiados = [];
  for (const chave of ['original', 'organizado', 'resumo', 'index']) {
    const origem = caminho[chave];
    if (!fs.existsSync(origem)) continue;
    const destino = path.join(caminho.backups, `${selo}-${path.basename(origem)}`);
    fs.copyFileSync(origem, destino);
    copiados.push(path.basename(destino));
  }
  return copiados;
}

/** Restaura os artefatos a partir dos backups criados antes da importação. */
function restaurarBackup(caminho, copiados) {
  for (const nome of copiados) {
    const alvo = path.join(caminho.raiz, nome.replace(/^\d{8}-\d{6}-/, ''));
    try { fs.copyFileSync(path.join(caminho.backups, nome), alvo); } catch {}
  }
  cache.delete(caminho.original);
}

/**
 * Importa um novo CSV. Em dryRun apenas valida e calcula as estatísticas,
 * sem gravar nada.
 */
function importarCSV(opcoes = {}) {
  const texto = String(opcoes.textoCSV || '').replace(/^\uFEFF/, '');
  if (!texto.trim()) throw new Error('Conteúdo CSV vazio');
  const caminho = caminhos(opcoes.raiz);
  const nomeArquivo = path.basename(String(opcoes.nomeArquivo || 'noc-original.csv'));

  const payload = noc.construirPayload(texto, {
    arquivoFonte: opcoes.dryRun ? nomeArquivo : path.basename(caminho.original),
  });
  if (opcoes.dryRun) {
    return { dryRun: true, stats: payload.stats, erros: payload.erros, backups: [] };
  }

  const backups = fazerBackup(caminho);
  try {
    const resultado = gerarArquivos({
      raiz: caminho.raiz,
      textoCsv: texto,
      arquivoFonte: path.basename(caminho.original),
      salvarOriginal: true,
    });
    return {
      ok: true,
      stats: resultado.stats,
      erros: payload.erros,
      backups,
      arquivoFonte: path.basename(caminho.original),
    };
  } catch (erro) {
    restaurarBackup(caminho, backups);
    const espelhos = raizesEspelho(caminho.raiz);
    if (espelhos.length) espelhar(caminho, espelhos);
    throw erro;
  }
}

module.exports = {
  RAIZ,
  BOM: noc.BOM,
  caminhos,
  lerTexto,
  escrever,
  gerarArquivos,
  obterPayload,
  lerGeradoEmDoHTML,
  espelhar,
  raizesEspelho,
  importarCSV,
  fazerBackup,
};
