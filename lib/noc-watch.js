const fs = require('fs');
const path = require('path');
const { importNocFile } = require('./noc-import');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function waitStable(filePath, checks = 3, delayMs = 1000) {
  let last = -1;
  for (let i = 0; i < checks; i++) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return false; }
    if (!stat.isFile()) return false;
    if (stat.size > 0 && stat.size === last) return true;
    last = stat.size;
    await sleep(delayMs);
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size === last;
  } catch { return false; }
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function createNocWatcher(options = {}) {
  const db = options.db;
  const logger = options.logger || console;
  const dir = path.resolve(options.dir || path.join(process.cwd(), 'importacao', 'entrada'));
  const processedDir = options.processedDir || path.join(dir, '..', 'processados');
  const errorDir = options.errorDir || path.join(dir, '..', 'erros');
  const tenantId = options.tenantId || process.env.NOC_IMPORT_TENANT || 'default';
  const intervalMs = Math.max(5000, Number(options.intervalMs || process.env.NOC_WATCH_INTERVAL_MS || 60000));
  const deleteAfterImport = options.deleteAfterImport === true || process.env.NOC_WATCH_DELETE === 'true';

  let timer = null;
  let running = false;
  let importing = false;
  const status = {
    running: false,
    dir,
    processedDir: path.resolve(processedDir),
    errorDir: path.resolve(errorDir),
    tenantId,
    intervalMs,
    lastRunAt: null,
    lastFile: null,
    lastResult: null,
    lastError: null
  };

  function log(level, msg, extra) {
    const line = `[noc-watch] ${msg}`;
    if (level === 'error') logger.error ? logger.error(line, extra || '') : console.error(line, extra || '');
    else if (level === 'warn') logger.warn ? logger.warn(line, extra || '') : console.warn(line, extra || '');
    else logger.log ? logger.log(line, extra || '') : console.log(line, extra || '');
  }

  async function importFile(filePath) {
    const base = path.basename(filePath);
    log('info', `Importando ${base}...`);
    const stable = await waitStable(filePath);
    if (!stable) {
      log('warn', `Arquivo não estável ou inacessível, pulando: ${base}`);
      return null;
    }
    try {
      const result = await importNocFile({ db, filePath, tenantId });
      status.lastResult = result;
      status.lastFile = base;
      status.lastError = null;

      const reportName = `${stamp()}-${base}.json`;
      ensureDir(path.resolve(processedDir));
      fs.writeFileSync(path.join(path.resolve(processedDir), reportName), JSON.stringify(result, null, 2), 'utf8');

      if (deleteAfterImport) {
        fs.unlinkSync(filePath);
      } else {
        const dest = path.join(path.resolve(processedDir), `${stamp()}-${base}`);
        fs.renameSync(filePath, dest);
      }
      log('info', `OK ${base}: ${result.created} criadas, ${result.updated} atualizadas, ${result.unchanged} sem mudança, ${result.workflowPreserved} workflow preservado.`);
      return result;
    } catch (err) {
      status.lastError = err.message;
      log('error', `Falha ao importar ${base}: ${err.message}`);
      try {
        ensureDir(path.resolve(errorDir));
        const dest = path.join(path.resolve(errorDir), `${stamp()}-${base}`);
        fs.renameSync(filePath, dest);
        fs.writeFileSync(dest + '.erro.json', JSON.stringify({ file: base, error: err.message, stack: err.stack, at: new Date().toISOString() }, null, 2), 'utf8');
      } catch (moveErr) {
        log('error', `Não foi possível mover arquivo com erro: ${moveErr.message}`);
      }
      return null;
    }
  }

  async function scanOnce() {
    if (importing) return { skipped: 'import in progress' };
    importing = true;
    status.lastRunAt = new Date().toISOString();
    try {
      ensureDir(dir);
      ensureDir(path.resolve(processedDir));
      ensureDir(path.resolve(errorDir));
      const files = fs.readdirSync(dir)
        .filter(f => /\.(csv)$/i.test(f))
        .map(f => path.join(dir, f))
        .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } })
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

      const results = [];
      for (const file of files) {
        const r = await importFile(file);
        if (r) results.push(r);
      }
      return { imported: results.length, files: results.map(r => r.sourceFile) };
    } finally {
      importing = false;
    }
  }

  function start() {
    if (running) return status;
    ensureDir(dir);
    ensureDir(path.resolve(processedDir));
    ensureDir(path.resolve(errorDir));
    running = true;
    status.running = true;
    log('info', `Monitorando ${dir} a cada ${Math.round(intervalMs / 1000)}s (tenant=${tenantId})`);
    // primeira varredura imediata
    scanOnce().catch(err => log('error', `Erro na varredura inicial: ${err.message}`));
    timer = setInterval(() => {
      scanOnce().catch(err => log('error', `Erro na varredura: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
    return status;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
    status.running = false;
    return status;
  }

  return { start, stop, scanOnce, getStatus: () => ({ ...status }) };
}

module.exports = { createNocWatcher };
