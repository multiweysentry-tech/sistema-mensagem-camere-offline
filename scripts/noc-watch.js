#!/usr/bin/env node
/**
 * Bot de importação diária do NOC.
 * Monitora a pasta importacao/entrada e importa automaticamente qualquer CSV novo.
 *
 * Uso:
 *   npm run noc:watch
 *   node scripts/noc-watch.js
 *   node scripts/noc-watch.js --dir="C:\caminho\entrada" --tenant=default --interval=60000
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { createNocWatcher } = require('../lib/noc-watch');

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

async function main() {
  const db = require('../db');
  await db.init();

  const watcher = createNocWatcher({
    db,
    dir: arg('dir') || process.env.NOC_WATCH_DIR || path.join(__dirname, '..', 'importacao', 'entrada'),
    tenantId: arg('tenant') || process.env.NOC_IMPORT_TENANT || 'default',
    intervalMs: Number(arg('interval') || process.env.NOC_WATCH_INTERVAL_MS || 60000),
    logger: console
  });

  watcher.start();
  console.log('[noc-watch] Bot iniciado. Coloque arquivos .csv na pasta monitorada.');
  console.log('[noc-watch] Pressione Ctrl+C para parar.');

  const shutdown = async () => {
    console.log('\n[noc-watch] Encerrando...');
    watcher.stop();
    if (db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[noc-watch] Falha ao iniciar:', err.message);
  process.exit(1);
});
