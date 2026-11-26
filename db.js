const { Pool } = require('pg');
const { getConfig } = require('./db-config');
const { normalizarNumeroWhatsapp, normalizarContato } = require('./phone-utils');
const { log } = require('./logger');

const config = getConfig();
const pool = new Pool({
  ...config,
  max: process.env.VERCEL ? 1 : 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});
pool.on('error', error => log('error', 'db.idle_error', { error }));

const DATA_TABLES = [
  'cameras', 'log', 'conversations', 'messages', 'message_delivery', 'consent',
  'blocklist', 'message_templates', 'bot_config', 'app_migrations', 'noc_arquivos'
];

function tenant(value) {
  return String(value || 'default');
}

// Identificadores de tenants nao-default sao prefixados internamente.
// O tenant 'default' mantem as chaves antigas intactas.
function scopedKey(value, tenantId) {
  if (value === null || value === undefined) return value;
  const t = tenant(tenantId);
  return t === 'default' ? String(value) : `${t}::${String(value)}`;
}

// Chave canonica de gravacao e chaves legadas aceitas na leitura. Assim um
// cadastro antigo salvo sem DDI continua encontrando seu consentimento.
function canonicalPhone(value) {
  return normalizarContato(value) || String(value || '');
}

function phoneKeys(value, tenantId = 'default') {
  return [...new Set([canonicalPhone(value), String(value || '')].filter(Boolean))]
    .map(phone => scopedKey(phone, tenantId));
}

async function init() {
  if (!config.password) {
    throw new Error('Senha do Postgres nao configurada. Defina DATABASE_URL ou PG_PASSWORD no ambiente.');
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', instance_id TEXT NOT NULL DEFAULT 'default',
      camera_nome TEXT, local TEXT, responsavel_nome TEXT, responsavel_telefone TEXT, email TEXT,
      status TEXT DEFAULT 'Pendente', tentativas INTEGER DEFAULT 0,
      ultima_cobranca TEXT, data_resolucao TEXT, observacoes TEXT
    );
    CREATE TABLE IF NOT EXISTS log (
      id SERIAL PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', instance_id TEXT NOT NULL DEFAULT 'default',
      timestamp TEXT, camera_id TEXT, camera_nome TEXT, responsavel_telefone TEXT,
      acao TEXT, detalhe TEXT, status_anterior TEXT, status_novo TEXT, trace_id TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      jid TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', instance_id TEXT NOT NULL DEFAULT 'default',
      name TEXT, last_message TEXT, last_time TEXT, unread INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', instance_id TEXT NOT NULL DEFAULT 'default',
      jid TEXT REFERENCES conversations(jid) ON DELETE CASCADE,
      direction TEXT, text TEXT, time TEXT, status TEXT DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS message_delivery (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', instance_id TEXT NOT NULL DEFAULT 'default',
      jid TEXT, camera_ids TEXT, texto TEXT, status TEXT NOT NULL DEFAULT 'pendente',
      motivo TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS consent (
      phone TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      opted_in INTEGER DEFAULT 0, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS blocklist (
      phone TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      reason TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      nome TEXT, corpo TEXT, variaveis TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      value TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY, applied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin', created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS whatsapp_instances (
      tenant_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      label TEXT, auto_connect INTEGER NOT NULL DEFAULT 0, created_at TEXT,
      PRIMARY KEY (tenant_id, instance_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      instance_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, run_at TEXT NOT NULL,
      locked_at TEXT, locked_by TEXT, last_error TEXT,
      created_at TEXT, finished_at TEXT,
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS noc_arquivos (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
      nome TEXT NOT NULL, conteudo TEXT NOT NULL, linhas INTEGER NOT NULL DEFAULT 0,
      stats TEXT NOT NULL DEFAULT '{}', payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  for (const table of DATA_TABLES) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
  }
  for (const table of ['cameras', 'log', 'conversations', 'messages']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS instance_id TEXT NOT NULL DEFAULT 'default'`);
  }
  // Bancos criados antes do suporte a status de entrega nao tinham esta coluna.
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'");
  await pool.query("UPDATE messages SET status = 'pending' WHERE status IS NULL");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cameras_tenant ON cameras(tenant_id, status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_log_tenant_action ON log(tenant_id, acao, timestamp)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_tenant_time ON messages(tenant_id, time)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_delivery_tenant_time ON message_delivery(tenant_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, run_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_noc_arquivos_tenant_data ON noc_arquivos(tenant_id, created_at DESC)');

  const tpl = await pool.query("SELECT id FROM message_templates WHERE id='cobranca_padrao' AND tenant_id='default'");
  if (tpl.rows.length === 0) {
    await pool.query(
      `INSERT INTO message_templates (id,tenant_id,nome,corpo,variaveis,created_at,updated_at) VALUES ($1,'default',$2,$3,$4,$5,$6)`,
      ['cobranca_padrao', 'Cobrança de câmeras offline',
        'Olá, {nome_cliente}!\nO Sentry identificou que estas câmeras estão offline:\n{lista_cameras}\n\nO que você prefere fazer?\n1. Estou analisando\n2. Preciso falar com técnico\n3. Já resolvi',
        'nome_cliente,lista_cameras', new Date().toISOString(), new Date().toISOString()]
    );
  }

  const cfg = await pool.query("SELECT key FROM bot_config WHERE key='billing_days_before' AND tenant_id='default'");
  if (cfg.rows.length === 0) {
    const defaults = {
      billing_days_before: '3', billing_days_after: '1,3,7', billing_hour: '9',
      maintenance_hour: '17', auto_mode: 'true', max_attempts: '3',
      business_hours_start: '8', business_hours_end: '18'
    };
    for (const [key, value] of Object.entries(defaults)) {
      await pool.query('INSERT INTO bot_config (key,tenant_id,value,updated_at) VALUES ($1,\'default\',$2,$3)', [key, value, new Date().toISOString()]);
    }
  }

  const migration = await pool.query("SELECT name FROM app_migrations WHERE name='maintenance-hour-default'");
  if (migration.rows.length === 0) {
    await pool.query("UPDATE bot_config SET value='17',updated_at=$1 WHERE key='maintenance_hour' AND tenant_id='default' AND value='18'", [new Date().toISOString()]);
    await pool.query("INSERT INTO app_migrations (name,applied_at) VALUES ('maintenance-hour-default',$1)", [new Date().toISOString()]);
  }

  const consentMigration = await pool.query("SELECT name FROM app_migrations WHERE name='registered-camera-consents'");
  if (consentMigration.rows.length === 0) {
    const cameras = await pool.query('SELECT DISTINCT responsavel_telefone,tenant_id FROM cameras WHERE responsavel_telefone IS NOT NULL');
    for (const row of cameras.rows) {
      const phone = normalizarNumeroWhatsapp(row.responsavel_telefone);
      if (phone) await ensureConsent(phone, row.tenant_id);
    }
    await pool.query("INSERT INTO app_migrations (name,applied_at) VALUES ('registered-camera-consents',$1) ON CONFLICT (name) DO NOTHING", [new Date().toISOString()]);
  }
  log('info', 'db.schema_ready');
}

async function getCameras(tenantId = 'default') {
  const r = await pool.query('SELECT * FROM cameras WHERE tenant_id=$1 ORDER BY id', [tenant(tenantId)]);
  return r.rows;
}
async function upsertCamera(cam, tenantId = 'default') {
  const t = tenant(tenantId);
  const id = scopedKey(cam.id, t);
  const existing = await pool.query('SELECT id FROM cameras WHERE id=$1 AND tenant_id=$2', [id, t]);
  const values = [cam.camera_nome, cam.local, cam.responsavel_nome, cam.responsavel_telefone,
    cam.email, cam.status, cam.tentativas, cam.ultima_cobranca, cam.data_resolucao, cam.observacoes];
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE cameras SET camera_nome=$1,local=$2,responsavel_nome=$3,responsavel_telefone=$4,email=$5,status=$6,tentativas=$7,ultima_cobranca=$8,data_resolucao=$9,observacoes=$10 WHERE id=$11 AND tenant_id=$12`,
      [...values, id, t]);
  } else {
    await pool.query(`INSERT INTO cameras (id,tenant_id,camera_nome,local,responsavel_nome,responsavel_telefone,email,status,tentativas,ultima_cobranca,data_resolucao,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, t, ...values]);
  }
}
// Grava muitas câmeras em uma única ida ao banco. O fluxo NOC pode importar
// centenas de câmeras por vez; chamadas individuais estouram o timeout do Vercel.
async function upsertCamerasBulk(cameras = [], tenantId = 'default') {
  if (!Array.isArray(cameras) || !cameras.length) return 0;
  const t = tenant(tenantId);
  const rows = cameras.map(cam => ({
    id: scopedKey(cam.id, t),
    tenant_id: t,
    instance_id: cam.instance_id || 'default',
    camera_nome: cam.camera_nome || '',
    local: cam.local || '',
    responsavel_nome: cam.responsavel_nome || '',
    responsavel_telefone: cam.responsavel_telefone || '',
    email: cam.email || '',
    status: cam.status || 'Pendente',
    tentativas: Number(cam.tentativas) || 0,
    ultima_cobranca: cam.ultima_cobranca || '',
    data_resolucao: cam.data_resolucao || '',
    observacoes: cam.observacoes || ''
  }));
  await pool.query(`
    INSERT INTO cameras (
      id, tenant_id, instance_id, camera_nome, local, responsavel_nome,
      responsavel_telefone, email, status, tentativas, ultima_cobranca,
      data_resolucao, observacoes
    )
    SELECT id, tenant_id, instance_id, camera_nome, local, responsavel_nome,
           responsavel_telefone, email, status, tentativas, ultima_cobranca,
           data_resolucao, observacoes
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, tenant_id text, instance_id text, camera_nome text, local text,
      responsavel_nome text, responsavel_telefone text, email text, status text,
      tentativas integer, ultima_cobranca text, data_resolucao text, observacoes text
    )
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      instance_id = EXCLUDED.instance_id,
      camera_nome = EXCLUDED.camera_nome,
      local = EXCLUDED.local,
      responsavel_nome = EXCLUDED.responsavel_nome,
      responsavel_telefone = EXCLUDED.responsavel_telefone,
      email = EXCLUDED.email,
      status = EXCLUDED.status,
      tentativas = EXCLUDED.tentativas,
      ultima_cobranca = EXCLUDED.ultima_cobranca,
      data_resolucao = EXCLUDED.data_resolucao,
      observacoes = EXCLUDED.observacoes
  `, [JSON.stringify(rows)]);
  return rows.length;
}

// Atualiza várias câmeras de um mesmo responsável em uma única consulta.
async function updateCamerasBulk(ids = [], fields = {}, tenantId = 'default') {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const allowed = new Set(['camera_nome','local','responsavel_nome','responsavel_telefone','email','status','tentativas','ultima_cobranca','data_resolucao','observacoes']);
  const entries = Object.entries(fields || {}).filter(([key]) => allowed.has(key));
  if (!entries.length) return 0;
  const t = tenant(tenantId);
  const scopedIds = [...new Set(ids.map(id => scopedKey(id, t)))];
  const sets = entries.map(([key], index) => `${key}=$${index + 1}`).join(',');
  const values = entries.map(([, value]) => value);
  values.push(scopedIds, t);
  const r = await pool.query(
    `UPDATE cameras SET ${sets} WHERE id = ANY($${entries.length + 1}::text[]) AND tenant_id=$${entries.length + 2}`,
    values
  );
  return r.rowCount || 0;
}

async function updateCamera(id, fields, tenantId = 'default') {
  const allowed = new Set(['camera_nome','local','responsavel_nome','responsavel_telefone','email','status','tentativas','ultima_cobranca','data_resolucao','observacoes']);
  const sets = []; const vals = []; let i = 1;
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.has(key)) continue;
    sets.push(`${key}=$${i++}`);
    vals.push(value);
  }
  if (sets.length === 0) return;
  vals.push(scopedKey(id, tenantId), tenant(tenantId));
  await pool.query(`UPDATE cameras SET ${sets.join(',')} WHERE id=$${i} AND tenant_id=$${i + 1}`, vals);
}
// Exclui várias câmeras em uma única consulta, usada pelo editor do grupo.
async function deleteCamerasBulk(ids = [], tenantId = 'default') {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const t = tenant(tenantId);
  const scopedIds = [...new Set(ids.map(id => scopedKey(id, t)))];
  const r = await pool.query(
    'DELETE FROM cameras WHERE id = ANY($1::text[]) AND tenant_id=$2',
    [scopedIds, t]
  );
  return r.rowCount || 0;
}

async function deleteCamera(id, tenantId = 'default') {
  await pool.query('DELETE FROM cameras WHERE id=$1 AND tenant_id=$2', [scopedKey(id, tenantId), tenant(tenantId)]);
}
async function addLog(entry, tenantId = 'default') {
  await pool.query(
    `INSERT INTO log (tenant_id,instance_id,timestamp,camera_id,camera_nome,responsavel_telefone,acao,detalhe,status_anterior,status_novo,trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenant(tenantId), entry.instance_id || 'default', entry.timestamp, entry.camera_id, entry.camera_nome,
      entry.responsavel_telefone, entry.acao, entry.detalhe, entry.status_anterior, entry.status_novo, entry.trace_id || null]
  );
}
async function getLog(tenantId = 'default') {
  const r = await pool.query('SELECT * FROM log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 500', [tenant(tenantId)]);
  return r.rows;
}
async function hasRecentLog(phone, actions, since, tenantId = 'default') {
  const result = await pool.query(
    `SELECT 1 FROM log
      WHERE tenant_id=$1 AND responsavel_telefone=ANY($2::text[])
        AND acao=ANY($3::text[])
        AND timestamp ~ '^\\d{4}-\\d{2}-\\d{2}T'
        AND timestamp::timestamptz >= $4::timestamptz
      LIMIT 1`,
    [tenant(tenantId), phoneKeys(phone, tenantId), actions, since]
  );
  return result.rowCount > 0;
}
async function getConversations(tenantId = 'default') {
  const r = await pool.query('SELECT * FROM conversations WHERE tenant_id=$1 ORDER BY last_time DESC', [tenant(tenantId)]);
  return r.rows.map(c => ({ jid: c.jid, name: c.name, lastMessage: c.last_message, lastTime: c.last_time, unread: c.unread, instanceId: c.instance_id }));
}
async function upsertConversation(jid, name, lastMessage, lastTime, tenantId = 'default', instanceId = 'default') {
  const t = tenant(tenantId);
  const iid = scopedKey(jid, t);
  await pool.query(
    `INSERT INTO conversations (jid,tenant_id,instance_id,name,last_message,last_time,unread) VALUES ($1,$2,$3,$4,$5,$6,0)
     ON CONFLICT (jid) DO UPDATE SET name=$4,last_message=$5,last_time=$6`,
    [iid, t, String(instanceId || 'default'), name, lastMessage, lastTime]
  );
}
async function incrementUnread(jid, tenantId = 'default', instanceId = 'default') {
  await pool.query(
    'UPDATE conversations SET unread = unread + 1 WHERE jid=$1 AND tenant_id=$2 AND instance_id=$3',
    [scopedKey(jid, tenantId), tenant(tenantId), String(instanceId || 'default')]
  );
}
async function getMessages(jid, tenantId = 'default') {
  const r = await pool.query('SELECT * FROM messages WHERE jid=$1 AND tenant_id=$2 ORDER BY time', [scopedKey(jid, tenantId), tenant(tenantId)]);
  return r.rows.map(m => ({ id: m.id, from: m.jid, text: m.text, time: m.time, direction: m.direction, status: m.status }));
}
async function addMessage(jid, msg, tenantId = 'default', instanceId = 'default') {
  const t = tenant(tenantId);
  const result = await pool.query(
    `INSERT INTO messages (id,tenant_id,instance_id,jid,direction,text,time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [scopedKey(msg.id, t), t, String(instanceId || 'default'), scopedKey(jid, t),
      msg.direction, msg.text, msg.time, msg.status || 'received']
  );
  return result.rowCount > 0;
}
async function markRead(jid, tenantId = 'default') {
  await pool.query('UPDATE conversations SET unread=0 WHERE jid=$1 AND tenant_id=$2', [scopedKey(jid, tenantId), tenant(tenantId)]);
}
async function isBlocked(phone, tenantId = 'default') {
  const r = await pool.query('SELECT phone FROM blocklist WHERE phone=ANY($1::text[]) AND tenant_id=$2', [phoneKeys(phone, tenantId), tenant(tenantId)]);
  return r.rows.length > 0;
}
async function hasConsent(phone, tenantId = 'default') {
  const r = await pool.query('SELECT opted_in FROM consent WHERE phone=ANY($1::text[]) AND tenant_id=$2', [phoneKeys(phone, tenantId), tenant(tenantId)]);
  // Se existir registro legado em sentido contrario, o opt-out prevalece.
  return r.rows.length > 0 && r.rows.every(row => Number(row.opted_in) === 1);
}
async function getConsents(tenantId = 'default') {
  const r = await pool.query('SELECT phone,opted_in,updated_at FROM consent WHERE tenant_id=$1 ORDER BY phone', [tenant(tenantId)]);
  return r.rows.map(row => ({ phone: row.phone, opted_in: Number(row.opted_in) === 1, updated_at: row.updated_at }));
}
async function setConsent(phone, optedIn, tenantId = 'default') {
  if (typeof optedIn !== 'boolean') throw new TypeError('optedIn deve ser booleano');
  const t = tenant(tenantId);
  await pool.query(
    `INSERT INTO consent (phone,tenant_id,opted_in,updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone) DO UPDATE SET opted_in=$3,updated_at=$4`,
    [scopedKey(canonicalPhone(phone), t), t, optedIn ? 1 : 0, new Date().toISOString()]
  );
}
async function ensureConsent(phone, tenantId = 'default') {
  const t = tenant(tenantId);
  const keys = phoneKeys(phone, t);
  const result = await pool.query(
    `INSERT INTO consent (phone,tenant_id,opted_in,updated_at)
     SELECT $1,$2,1,$3
     WHERE NOT EXISTS (SELECT 1 FROM consent WHERE phone=ANY($4::text[]) AND tenant_id=$2)
       AND NOT EXISTS (SELECT 1 FROM blocklist WHERE phone=ANY($4::text[]) AND tenant_id=$2)
     ON CONFLICT (phone) DO NOTHING`,
    [keys[0], t, new Date().toISOString(), keys]
  );
  return result.rowCount > 0;
}
async function block(phone, reason, tenantId = 'default') {
  const t = tenant(tenantId);
  await pool.query(
    `INSERT INTO blocklist (phone,tenant_id,reason,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (phone) DO NOTHING`,
    [scopedKey(canonicalPhone(phone), t), t, reason || '', new Date().toISOString()]
  );
}
async function unblock(phone, tenantId = 'default') {
  await pool.query('DELETE FROM blocklist WHERE phone=ANY($1::text[]) AND tenant_id=$2', [phoneKeys(phone, tenantId), tenant(tenantId)]);
}
async function getBlocklist(tenantId = 'default') {
  const r = await pool.query('SELECT * FROM blocklist WHERE tenant_id=$1 ORDER BY created_at DESC', [tenant(tenantId)]);
  return r.rows;
}
async function getTemplates(tenantId = 'default') {
  const r = await pool.query('SELECT * FROM message_templates WHERE tenant_id=$1 ORDER BY nome', [tenant(tenantId)]);
  return r.rows;
}
async function getTemplate(id, tenantId = 'default') {
  const r = await pool.query('SELECT * FROM message_templates WHERE id=$1 AND tenant_id=$2', [scopedKey(id, tenantId), tenant(tenantId)]);
  return r.rows[0] || null;
}
async function upsertTemplate(tpl, tenantId = 'default') {
  const t = tenant(tenantId);
  const id = scopedKey(tpl.id, t);
  const now = new Date().toISOString();
  const existing = await pool.query('SELECT id FROM message_templates WHERE id=$1 AND tenant_id=$2', [id, t]);
  if (existing.rows.length > 0) {
    await pool.query('UPDATE message_templates SET nome=$1,corpo=$2,variaveis=$3,updated_at=$4 WHERE id=$5 AND tenant_id=$6',
      [tpl.nome, tpl.corpo, tpl.variaveis || '', now, id, t]);
  } else {
    await pool.query(
      'INSERT INTO message_templates (id,tenant_id,nome,corpo,variaveis,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, t, tpl.nome, tpl.corpo, tpl.variaveis || '', now, now]
    );
  }
}
async function deleteTemplate(id, tenantId = 'default') {
  await pool.query('DELETE FROM message_templates WHERE id=$1 AND tenant_id=$2', [scopedKey(id, tenantId), tenant(tenantId)]);
}
function renderTemplate(corpo, vars) {
  let out = corpo;
  for (const [key, value] of Object.entries(vars || {})) out = out.split(`{${key}}`).join(String(value));
  return out;
}
async function getBotConfig(tenantId = 'default') {
  const t = tenant(tenantId);
  const r = await pool.query('SELECT key,value FROM bot_config WHERE tenant_id=$1', [t]);
  const cfg = {};
  for (const row of r.rows) {
    const prefix = t === 'default' ? null : `${t}::`;
    const key = prefix && String(row.key).startsWith(prefix) ? String(row.key).slice(prefix.length) : row.key;
    cfg[key] = row.value;
  }
  return cfg;
}
async function setBotConfig(key, value, tenantId = 'default') {
  // A chave primaria de bot_config e global; prefixamos para nao colidir entre tenants.
  await pool.query(
    `INSERT INTO bot_config (key,tenant_id,value,updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET value=$3,updated_at=$4`,
    [scopedKey(key, tenantId), tenant(tenantId), value, new Date().toISOString()]
  );
}
async function getReports(tenantId = 'default') {
  const t = tenant(tenantId);
  const [camerasR, logsR, msgsHojeR, clientesAguardandoR, entregasR] = await Promise.all([
    pool.query('SELECT * FROM cameras WHERE tenant_id=$1', [t]),
    pool.query('SELECT * FROM log WHERE tenant_id=$1', [t]),
    pool.query(`SELECT direction, COUNT(*) as c FROM messages WHERE tenant_id=$1 AND time >= to_char((NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours', 'YYYY-MM-DD"T"HH24:MI:SS') GROUP BY direction`, [t]),
    pool.query('SELECT COUNT(*) as c FROM conversations WHERE tenant_id=$1 AND unread > 0', [t]),
    pool.query('SELECT status, COUNT(*) as c FROM message_delivery WHERE tenant_id=$1 GROUP BY status', [t]).catch(() => ({ rows: [] }))
  ]);
  const cameras = camerasR.rows;
  const logs = logsR.rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const counts = { Pendente: 0, 'Aguardando resposta': 0, Verificando: 0, Suporte: 0, 'Aguardando validacao': 0, Resolvido: 0 };
  const porResponsavel = new Map();
  const temposResolucao = [];
  const agora = Date.now();

  for (const c of cameras) {
    const st = String(c.status || '').trim();
    if (counts[st] !== undefined) counts[st] += 1;
    const resp = String(c.responsavel_nome || 'Sem responsável').trim() || 'Sem responsável';
    const item = porResponsavel.get(resp) || { responsavel: resp, telefone: c.responsavel_telefone || '', total: 0, abertas: 0, resolvidas: 0, atrasadas: 0 };
    item.total += 1;
    if (st === 'Resolvido') item.resolvidas += 1;
    else {
      item.abertas += 1;
      const base = Date.parse(c.ultima_cobranca || '') || Date.parse(c.data_resolucao || '') || 0;
      if (base && agora - base > 24 * 3600000) item.atrasadas += 1;
    }
    porResponsavel.set(resp, item);

    if (st === 'Resolvido' && c.data_resolucao) {
      const fim = Date.parse(c.data_resolucao);
      const inicio = Date.parse(c.ultima_cobranca || '') || fim;
      if (Number.isFinite(fim) && Number.isFinite(inicio) && fim >= inicio) temposResolucao.push(fim - inicio);
    }
  }

  const tempoMedioHoras = temposResolucao.length
    ? Math.round((temposResolucao.reduce((a, b) => a + b, 0) / temposResolucao.length / 3600000) * 10) / 10
    : null;
  const tempoMaxHoras = temposResolucao.length ? Math.round((Math.max(...temposResolucao) / 3600000) * 10) / 10 : null;
  const tempoMinHoras = temposResolucao.length ? Math.round((Math.min(...temposResolucao) / 3600000) * 10) / 10 : null;

  const cobrancasEnviadas = logs.filter(l => l.acao === 'COBRANCA_ENVIADA').length;
  const enviosSemConfirmacao = logs.filter(l => ['ENVIO_SEM_CONFIRMACAO', 'ENVIO_AGUARDANDO_CONFIRMACAO'].includes(l.acao)).length;
  const erros = logs.filter(l => ['ERRO', 'ENVIO_FALHOU'].includes(l.acao)).length;
  const escalonamentos = logs.filter(l => l.acao === 'ESCALONAMENTO' || (l.acao === 'RESPOSTA_RECEBIDA' && l.status_novo === 'Suporte')).length;
  const respostasRecebidas = logs.filter(l => l.acao === 'RESPOSTA_RECEBIDA').length;

  let enviadasHoje = 0; let recebidasHoje = 0;
  for (const r of msgsHojeR.rows) {
    if (r.direction === 'out') enviadasHoje = Number(r.c);
    else recebidasHoje = Number(r.c);
  }

  const entregas = { pendente: 0, enviada: 0, entregue: 0, lida: 0, falhou: 0 };
  for (const r of entregasR.rows) {
    const k = String(r.status || '');
    if (entregas[k] !== undefined) entregas[k] = Number(r.c);
  }

  const responsaveisTop = [...porResponsavel.values()]
    .sort((a, b) => b.abertas - a.abertas || b.total - a.total)
    .slice(0, 10);

  const atividadesRecentes = logs.slice(0, 15).map(l => ({
    timestamp: l.timestamp,
    acao: l.acao,
    camera: l.camera_nome || l.camera_id || '',
    responsavel: l.responsavel_telefone || '',
    detalhe: l.detalhe || '',
    anterior: l.status_anterior || '',
    novo: l.status_novo || ''
  }));

  const camerasAbertasAntigas = cameras
    .filter(c => c.status !== 'Resolvido')
    .map(c => {
      const base = Date.parse(c.ultima_cobranca || '') || 0;
      return {
        id: c.id,
        nome: c.camera_nome || c.id,
        responsavel: c.responsavel_nome || '',
        status: c.status,
        horasAberta: base ? Math.round(((agora - base) / 3600000) * 10) / 10 : null
      };
    })
    .sort((a, b) => (b.horasAberta || 0) - (a.horasAberta || 0))
    .slice(0, 10);

  return {
    counts,
    total: cameras.length,
    tempoMedioHoras,
    tempoMaxHoras,
    tempoMinHoras,
    cobrancasEnviadas,
    enviosSemConfirmacao,
    erros,
    escalonamentos,
    respostasRecebidas,
    resolvidas: counts.Resolvido,
    enviadasHoje,
    recebidasHoje,
    clientesAguardando: Number(clientesAguardandoR.rows[0]?.c || 0),
    entregas,
    responsaveisTop,
    atividadesRecentes,
    camerasAbertasAntigas
  };
}

// ---- Autenticacao ----
async function listUsers() {
  const r = await pool.query('SELECT id,tenant_id,email,name,role,created_at FROM users ORDER BY email');
  return r.rows;
}
async function createUser(user) {
  await pool.query(
    'INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user.id, tenant(user.tenantId), user.email, user.name || '', user.password_hash, user.role || 'admin', new Date().toISOString()]
  );
  return getUserById(user.id);
}
async function getUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function getUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase()]);
  return r.rows[0] || null;
}
async function createSessionToken(userId, tokenHash, expiresAt) {
  await pool.query('INSERT INTO user_sessions (token_hash,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
    [tokenHash, userId, new Date().toISOString(), expiresAt]);
}
async function getSessionByToken(tokenHash) {
  const r = await pool.query(
    `SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > $2`,
    [tokenHash, new Date().toISOString()]
  );
  return r.rows[0] || null;
}
async function deleteSessionToken(tokenHash) {
  await pool.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash]);
}

// ---- Instancias WhatsApp ----
async function listInstances() {
  const r = await pool.query('SELECT * FROM whatsapp_instances ORDER BY tenant_id,instance_id');
  return r.rows;
}
async function upsertInstance(instance) {
  await pool.query(
    `INSERT INTO whatsapp_instances (tenant_id,instance_id,label,auto_connect,created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,instance_id) DO UPDATE SET label=$3,auto_connect=$4`,
    [tenant(instance.tenantId), String(instance.instanceId), instance.label || '', instance.autoConnect ? 1 : 0, new Date().toISOString()]
  );
}
async function deleteInstance(tenantId, instanceId) {
  await pool.query('DELETE FROM whatsapp_instances WHERE tenant_id=$1 AND instance_id=$2', [tenant(tenantId), String(instanceId)]);
}

// ---- Fila persistente ----
function createJob(job) {
  return pool.query(
    `INSERT INTO jobs (id,tenant_id,instance_id,kind,payload,idempotency_key,status,attempts,max_attempts,run_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',0,$7,$8,$9)
     ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [job.id, tenant(job.tenantId), String(job.instanceId || 'default'), job.kind,
      JSON.stringify(job.payload || {}), String(job.idempotencyKey), Number(job.maxAttempts || 3),
      job.runAt || new Date().toISOString(), new Date().toISOString()]
  );
}
async function claimJobs({ kinds, limit = 10, workerId } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date().toISOString();
    const worker = workerId || 'worker';
    // Cada query recebe apenas os parametros que realmente usa: o Postgres
    // nao infere tipo de parametro que nao aparece na propria query.
    const selectParams = [now];
    let where = 'status=\'pending\' AND run_at <= $1 AND (locked_at IS NULL OR locked_at < $1)';
    if (kinds && kinds.length) {
      selectParams.push(kinds);
      where += ` AND kind=ANY($${selectParams.length}::text[])`;
    }
    selectParams.push(limit);
    const limitIndex = selectParams.length;
    const r = await client.query(
      `SELECT * FROM jobs WHERE ${where} ORDER BY run_at,created_at LIMIT $${limitIndex} FOR UPDATE SKIP LOCKED`,
      selectParams
    );
    if (r.rows.length) {
      const ids = r.rows.map(row => row.id);
      await client.query('UPDATE jobs SET status=\'processing\',locked_at=$1,locked_by=$2,attempts=attempts+1 WHERE id=ANY($3::text[])',
        [now, worker, ids]);
    }
    await client.query('COMMIT');
    return r.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function finishJob(id, result = {}) {
  await pool.query("UPDATE jobs SET status='done',finished_at=$1,last_error=NULL WHERE id=$2", [new Date().toISOString(), id]);
  return result;
}
async function failJob(id, error) {
  await pool.query(
    `UPDATE jobs SET status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      last_error=$1,locked_at=NULL,locked_by=NULL,run_at=NOW()::text,
      finished_at=CASE WHEN attempts >= max_attempts THEN $2 ELSE NULL END
     WHERE id=$3`,
    [String(error?.message || error).slice(0, 1000), new Date().toISOString(), id]
  );
}
async function listJobs(tenantId = 'default', limit = 50) {
  const r = await pool.query('SELECT * FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2', [tenant(tenantId), limit]);
  return r.rows;
}

function mapDelivery(row) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    jid: row.jid,
    cameraIds: row.camera_ids ? String(row.camera_ids).split(',').filter(Boolean) : [],
    status: row.status,
    motivo: row.motivo,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function registerDelivery(entry, tenantId = 'default') {
  const t = tenant(tenantId);
  const agora = entry.createdAt || new Date().toISOString();
  await pool.query(
    `INSERT INTO message_delivery (id,tenant_id,instance_id,jid,camera_ids,texto,status,motivo,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    [scopedKey(entry.id, t), t, String(entry.instanceId || 'default'), entry.jid || null,
      (entry.cameraIds || []).join(','), entry.texto || null, entry.status || 'pendente',
      entry.motivo || null, agora, agora]
  );
}

async function updateDeliveryStatus(id, status, motivo, tenantId = 'default') {
  const t = tenant(tenantId);
  const key = scopedKey(id, t);
  const agora = new Date().toISOString();
  const resultado = await pool.query(
    `UPDATE message_delivery SET status=$1, motivo=$2, updated_at=$3 WHERE id=$4 AND tenant_id=$5 RETURNING *`,
    [status, motivo || null, agora, key, t]
  );
  await pool.query('UPDATE messages SET status=$1 WHERE id=$2 AND tenant_id=$3', [status, key, t]);
  return resultado.rows[0] ? mapDelivery(resultado.rows[0]) : null;
}

async function getDeliveries(ids = [], tenantId = 'default') {
  const t = tenant(tenantId);
  const chaves = Array.isArray(ids) && ids.length ? ids.map(id => scopedKey(id, t)) : [];
  const r = chaves.length
    ? await pool.query('SELECT * FROM message_delivery WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY created_at DESC', [t, chaves])
    : await pool.query('SELECT * FROM message_delivery WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [t]);
  return r.rows.map(mapDelivery);
}
async function findDeliveryByExternalId(id) {
  const externalId = String(id || '');
  if (!externalId) return null;
  const result = await pool.query(
    `SELECT * FROM message_delivery
      WHERE id=$1 OR right(id, length($1) + 2) = '::' || $1
      ORDER BY created_at DESC
      LIMIT 2`,
    [externalId]
  );
  return result.rows.length === 1
    ? { ...mapDelivery(result.rows[0]), tenantId: result.rows[0].tenant_id }
    : null;
}

async function saveNocFile(row, tenantId = 'default') {
  await pool.query(
    `INSERT INTO noc_arquivos (id,tenant_id,nome,conteudo,linhas,stats,payload,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       nome=EXCLUDED.nome, conteudo=EXCLUDED.conteudo, linhas=EXCLUDED.linhas,
       stats=EXCLUDED.stats, payload=EXCLUDED.payload, created_at=EXCLUDED.created_at`,
    [row.id, tenant(row.tenant_id || tenantId), row.nome, row.conteudo, Number(row.linhas) || 0,
      row.stats, row.payload, row.created_at]
  );
  return row;
}

async function getLatestNocFile(tenantId = 'default') {
  const r = await pool.query(
    'SELECT * FROM noc_arquivos WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1',
    [tenant(tenantId)]
  );
  return r.rows[0] || null;
}

async function listNocFiles(tenantId = 'default', limit = 20) {
  const r = await pool.query(
    'SELECT * FROM noc_arquivos WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',
    [tenant(tenantId), Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
  return r.rows;
}

async function deleteNocFiles(tenantId = 'default') {
  const r = await pool.query('DELETE FROM noc_arquivos WHERE tenant_id=$1', [tenant(tenantId)]);
  return r.rowCount || 0;
}

module.exports = {
  pool, init, scopedKey,
  saveNocFile, getLatestNocFile, listNocFiles, deleteNocFiles,
  registerDelivery, updateDeliveryStatus, getDeliveries, findDeliveryByExternalId,
  getCameras, upsertCamera, upsertCamerasBulk, updateCamera, updateCamerasBulk, deleteCamera, deleteCamerasBulk,
  addLog, getLog, hasRecentLog,
  getConversations, upsertConversation, incrementUnread, getMessages, addMessage, markRead,
  isBlocked, hasConsent, getConsents, setConsent, ensureConsent, block, unblock, getBlocklist,
  getTemplates, getTemplate, upsertTemplate, deleteTemplate, renderTemplate,
  getBotConfig, setBotConfig, getReports,
  listUsers, createUser, getUserById, getUserByEmail,
  createSessionToken, getSessionByToken, deleteSessionToken,
  listInstances, upsertInstance, deleteInstance,
  createJob, claimJobs, finishJob, failJob, listJobs
};
