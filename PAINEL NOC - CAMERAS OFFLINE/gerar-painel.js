/**
 * Gera o painel HTML local a partir do CSV exportado do NOC.
 * Uso: node gerar-painel.js "C:\caminho\para\noc.csv"
 * Sem argumento, usa o CSV padrão em Downloads.
 *
 * A lógica de parsing/normalização foi movida para backend/, para que a
 * interface (CLI) e o servidor HTTP usem exatamente as mesmas regras.
 */
const path = require('path');
const { lerTexto, gerarArquivos, RAIZ } = require('./backend/arquivos');

function main(argv = process.argv) {
  const origem = argv[2] || 'C:\\Users\\Sentry\\Downloads\\noc (1).csv';
  const resultado = gerarArquivos({
    raiz: RAIZ,
    textoCsv: lerTexto(origem),
    arquivoFonte: path.basename(origem),
  });
  console.log('OK! Gerado em:', RAIZ);
  console.log(JSON.stringify(resultado.stats, null, 2));
  return resultado;
}

if (require.main === module) main();

module.exports = { main };
