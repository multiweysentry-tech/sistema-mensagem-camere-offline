#!/usr/bin/env node
/**
 * Importa um CSV exportado do NOC para o banco do sistema.
 *
 * Uso:
 *   node scripts/importar-noc.js "C:\caminho\noc.csv"
 *   node scripts/importar-noc.js "C:\caminho\noc.csv" --tenant=default --dry-run
 *
 * Variáveis de ambiente: usa as mesmas do servidor (.env / PG_* / DATABASE_URL).
 */
const fs = require('fs');
const path = require('path');

// Carrega .env da raiz do projeto, igual ao server.js
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { importNocFile } = require('../lib/noc-import');

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) {
    console.error('Uso: node scripts/importar-noc.js "C:\\caminho\\arquivo.csv" [--tenant=default] [--dry-run]');
    process.exit(1);
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error('Arquivo não encontrado:', filePath);
    process.exit(1);
  }

  const tenantId = arg('tenant') || 'default';
  const dryRun = hasFlag('dry-run');

  const db = require('../db');
  await db.init();
  const summary = await importNocFile({ db, filePath, tenantId, dryRun });

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) {
    console.error(`\n${summary.errors.length} erro(s) encontrado(s).`);
  }
  console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Importação concluída: ${summary.created} criadas, ${summary.updated} atualizadas, ${summary.unchanged} sem mudança, ${summary.workflowPreserved} com workflow preservado.`);

  // Encerra pool pg se existir
  if (db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => {});
}

main().catch(err => {
  console.error('Falha na importação:', err.message);
  process.exit(1);
});
