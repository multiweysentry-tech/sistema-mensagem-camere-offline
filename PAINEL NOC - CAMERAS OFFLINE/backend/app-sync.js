'use strict';

/**
 * Mantém a view nativa do Painel NOC no index.html do sistema sincronizada
 * com o index.html gerado pela pasta do painel.
 *
 * O painel continua gerando um HTML completo e independente (para impressão,
 * compartilhamento e compatibilidade com /painel-noc/). Aqui apenas copiamos
 * seu CSS e seu <body> para um <template> embutido no sistema, evitando
 * iframe e duplicação de lógica.
 */

const fs = require('fs');
const path = require('path');

const INICIO = '<!--__NOC_PAINEL_INICIO__-->';
const FIM = '<!--__NOC_PAINEL_FIM__-->';

function extrair(htmlPainel) {
  const estilo = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(htmlPainel);
  const corpo = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(htmlPainel);
  if (!estilo || !corpo) {
    throw new Error('index.html do painel NOC não contém <style> e <body>');
  }
  return { css: estilo[1].trim(), corpo: corpo[1].trim() };
}

function blocoTemplate(htmlPainel) {
  const { css, corpo } = extrair(htmlPainel);
  return [
    INICIO,
    '<template id="nocPainelTemplate">',
    '<style>',
    css,
    '</style>',
    corpo,
    '</template>',
    FIM,
  ].join('\n');
}

/**
 * Prepara a nova versão do index.html do sistema.
 * Retorna null quando não há sistema, marcadores ausentes ou nada mudou.
 */
function preparar(opcoes = {}) {
  const raizPainel = path.resolve(opcoes.raizPainel || path.join(__dirname, '..'));
  const indexApp = path.resolve(opcoes.indexApp || path.join(raizPainel, '..', 'index.html'));
  if (!fs.existsSync(indexApp)) return null;

  const atual = fs.readFileSync(indexApp, 'utf8');
  const inicio = atual.indexOf(INICIO);
  const fim = inicio < 0 ? -1 : atual.indexOf(FIM, inicio + INICIO.length);
  if (inicio < 0 || fim < 0) return null;

  const htmlPainel = opcoes.htmlPainel || fs.readFileSync(path.join(raizPainel, 'index.html'), 'utf8');
  const conteudo = atual.slice(0, inicio) + blocoTemplate(htmlPainel) + atual.slice(fim + FIM.length);
  if (conteudo === atual) return null;
  return { arquivo: indexApp, conteudo };
}

module.exports = { INICIO, FIM, extrair, blocoTemplate, preparar };
