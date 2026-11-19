const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5433),
  user: process.env.PG_USER || 'n8n',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'n8n',
});

async function init() {
  if (!process.env.PG_PASSWORD) {
    throw new Error('PG_PASSWORD nao configurada. Defina-a no ambiente ou no arquivo local .env.');
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      camera_nome TEXT,
      local TEXT,
      responsavel_nome TEXT,
      responsavel_telefone TEXT,
      email TEXT,
      status TEXT DEFAULT 'Pendente',
      tentativas INTEGER DEFAULT 0,
      ultima_cobranca TEXT,
      data_resolucao TEXT,
      observacoes TEXT
    );
    CREATE TABLE IF NOT EXISTS log (
      id SERIAL PRIMARY KEY,
      timestamp TEXT,
      camera_id TEXT,
      camera_nome TEXT,
      responsavel_telefone TEXT,
      acao TEXT,
      detalhe TEXT,
      status_anterior TEXT,
      status_novo TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message TEXT,
      last_time TEXT,
      unread INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      jid TEXT REFERENCES conversations(jid) ON DELETE CASCADE,
      direction TEXT,
      text TEXT,
      time TEXT
    );
    CREATE TABLE IF NOT EXISTS consent (
      phone TEXT PRIMARY KEY,
      opted_in INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS blocklist (
      phone TEXT PRIMARY KEY,
      reason TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY,
      nome TEXT,
      corpo TEXT,
      variaveis TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT
    );
  `);
  // seed default template
  const tpl = await pool.query("SELECT id FROM message_templates WHERE id='cobranca_padrao'");
  if (tpl.rows.length === 0) {
    await pool.query(`INSERT INTO message_templates (id,nome,corpo,variaveis,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['cobranca_padrao', 'Cobrança de câmeras offline', 'Olá, {nome_cliente}!\nO Sentry identificou que estas câmeras estão offline:\n{lista_cameras}\n\nO que você prefere fazer?\n1. Estou analisando\n2. Preciso falar com técnico\n3. Já resolvi', 'nome_cliente,lista_cameras', new Date().toISOString(), new Date().toISOString()]);
  }
  // seed default bot config
  const cfg = await pool.query("SELECT key FROM bot_config WHERE key='billing_days_before'");
  if (cfg.rows.length === 0) {
    const defaults = { billing_days_before: '3', billing_days_after: '1,3,7', billing_hour: '9', maintenance_hour: '17', auto_mode: 'true', max_attempts: '3', business_hours_start: '8', business_hours_end: '18' };
    for (const [k,v] of Object.entries(defaults)) await pool.query('INSERT INTO bot_config (key,value,updated_at) VALUES ($1,$2,$3)', [k, v, new Date().toISOString()]);
  }
  const migration = await pool.query("SELECT name FROM app_migrations WHERE name='maintenance-hour-default'");
  if (migration.rows.length === 0) {
    await pool.query("UPDATE bot_config SET value='17',updated_at=$1 WHERE key='maintenance_hour' AND value='18'", [new Date().toISOString()]);
    await pool.query("INSERT INTO app_migrations (name,applied_at) VALUES ('maintenance-hour-default',$1)", [new Date().toISOString()]);
  }
  console.log('[DB] Schema pronto');
}

async function getCameras() {
  const r = await pool.query('SELECT * FROM cameras ORDER BY id');
  return r.rows;
}
async function upsertCamera(cam) {
  const existing = await pool.query('SELECT id FROM cameras WHERE id=$1', [cam.id]);
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE cameras SET camera_nome=$1,local=$2,responsavel_nome=$3,responsavel_telefone=$4,email=$5,status=$6,tentativas=$7,ultima_cobranca=$8,data_resolucao=$9,observacoes=$10 WHERE id=$11`,
      [cam.camera_nome,cam.local,cam.responsavel_nome,cam.responsavel_telefone,cam.email,cam.status,cam.tentativas,cam.ultima_cobranca,cam.data_resolucao,cam.observacoes,cam.id]);
  } else {
    await pool.query(`INSERT INTO cameras (id,camera_nome,local,responsavel_nome,responsavel_telefone,email,status,tentativas,ultima_cobranca,data_resolucao,observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [cam.id,cam.camera_nome,cam.local,cam.responsavel_nome,cam.responsavel_telefone,cam.email,cam.status,cam.tentativas,cam.ultima_cobranca,cam.data_resolucao,cam.observacoes]);
  }
}
async function updateCamera(id, fields) {
  const allowed = new Set(['camera_nome','local','responsavel_nome','responsavel_telefone','email','status','tentativas','ultima_cobranca','data_resolucao','observacoes']);
  const sets = []; const vals = []; let i = 1;
  for (const [k,v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k}=$${i++}`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await pool.query(`UPDATE cameras SET ${sets.join(',')} WHERE id=$${i}`, vals);
}
async function deleteCamera(id) {
  await pool.query('DELETE FROM cameras WHERE id=$1', [id]);
}
async function addLog(entry) {
  await pool.query(`INSERT INTO log (timestamp,camera_id,camera_nome,responsavel_telefone,acao,detalhe,status_anterior,status_novo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entry.timestamp, entry.camera_id, entry.camera_nome, entry.responsavel_telefone, entry.acao, entry.detalhe, entry.status_anterior, entry.status_novo]);
}
async function getLog() {
  const r = await pool.query('SELECT * FROM log ORDER BY id DESC LIMIT 200');
  return r.rows;
}
async function hasRecentLog(phone, actions, since) {
  const result = await pool.query(
    `SELECT 1 FROM log
     WHERE responsavel_telefone=$1
       AND acao=ANY($2::text[])
       AND timestamp ~ '^\\d{4}-\\d{2}-\\d{2}T'
       AND timestamp::timestamptz >= $3::timestamptz
     LIMIT 1`,
    [phone, actions, since]
  );
  return result.rowCount > 0;
}
async function getConversations() {
  const r = await pool.query('SELECT * FROM conversations ORDER BY last_time DESC');
  return r.rows.map(c => ({ jid: c.jid, name: c.name, lastMessage: c.last_message, lastTime: c.last_time, unread: c.unread }));
}
async function upsertConversation(jid, name, lastMessage, lastTime) {
  await pool.query(`INSERT INTO conversations (jid,name,last_message,last_time,unread) VALUES ($1,$2,$3,$4,0) ON CONFLICT (jid) DO UPDATE SET name=$2,last_message=$3,last_time=$4`, [jid,name,lastMessage,lastTime]);
}
async function incrementUnread(jid) {
  await pool.query('UPDATE conversations SET unread = unread + 1 WHERE jid=$1', [jid]);
}
async function getMessages(jid) {
  const r = await pool.query('SELECT * FROM messages WHERE jid=$1 ORDER BY time', [jid]);
  return r.rows.map(m => ({ id: m.id, from: m.jid, text: m.text, time: m.time, direction: m.direction }));
}
async function addMessage(jid, msg) {
  const result = await pool.query('INSERT INTO messages (id,jid,direction,text,time) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id', [msg.id, jid, msg.direction, msg.text, msg.time]);
  return result.rowCount > 0;
}
async function markRead(jid) {
  await pool.query('UPDATE conversations SET unread=0 WHERE jid=$1', [jid]);
}
async function isBlocked(phone) {
  const r = await pool.query('SELECT phone FROM blocklist WHERE phone=$1', [phone]);
  return r.rows.length > 0;
}
async function hasConsent(phone) {
  const r = await pool.query('SELECT opted_in FROM consent WHERE phone=$1', [phone]);
  return r.rows.length > 0 && Number(r.rows[0].opted_in) === 1;
}
async function getConsents() {
  const r = await pool.query('SELECT phone,opted_in,updated_at FROM consent ORDER BY phone');
  return r.rows.map(row => ({ phone: row.phone, opted_in: Number(row.opted_in) === 1, updated_at: row.updated_at }));
}
async function setConsent(phone, optedIn) {
  if (typeof optedIn !== 'boolean') throw new TypeError('optedIn deve ser booleano');
  await pool.query(`INSERT INTO consent (phone,opted_in,updated_at) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET opted_in=$2,updated_at=$3`, [phone, optedIn?1:0, new Date().toISOString()]);
}
async function block(phone, reason) {
  await pool.query(`INSERT INTO blocklist (phone,reason,created_at) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING`, [phone, reason||'', new Date().toISOString()]);
}
async function unblock(phone) {
  await pool.query('DELETE FROM blocklist WHERE phone=$1', [phone]);
}
async function getTemplates() {
  const r = await pool.query('SELECT * FROM message_templates ORDER BY nome');
  return r.rows;
}
async function getTemplate(id) {
  const r = await pool.query('SELECT * FROM message_templates WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function upsertTemplate(tpl) {
  const now = new Date().toISOString();
  const existing = await pool.query('SELECT id FROM message_templates WHERE id=$1', [tpl.id]);
  if (existing.rows.length > 0) {
    await pool.query('UPDATE message_templates SET nome=$1,corpo=$2,variaveis=$3,updated_at=$4 WHERE id=$5', [tpl.nome, tpl.corpo, tpl.variaveis || '', now, tpl.id]);
  } else {
    await pool.query('INSERT INTO message_templates (id,nome,corpo,variaveis,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [tpl.id, tpl.nome, tpl.corpo, tpl.variaveis || '', now, now]);
  }
}
async function deleteTemplate(id) {
  await pool.query('DELETE FROM message_templates WHERE id=$1', [id]);
}
function renderTemplate(corpo, vars) {
  let out = corpo;
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}
async function getBotConfig() {
  const r = await pool.query('SELECT * FROM bot_config');
  const cfg = {};
  for (const row of r.rows) cfg[row.key] = row.value;
  return cfg;
}
async function setBotConfig(key, value) {
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO bot_config (key,value,updated_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=$3`, [key, value, now]);
}
async function getReports() {
  const cameras = await pool.query('SELECT * FROM cameras');
  const logs = await pool.query('SELECT * FROM log');
  const counts = { Pendente:0, 'Aguardando resposta':0, Verificando:0, Suporte:0, 'Aguardando validacao':0, Resolvido:0 };
  for (const c of cameras.rows) { const st = String(c.status||'').trim(); if (counts[st] !== undefined) counts[st]++; }
  const resolvidas = cameras.rows.filter(c => c.status === 'Resolvido' && c.data_resolucao);
  let tempoMedio = null;
  if (resolvidas.length > 0) {
    const total = resolvidas.reduce((acc, c) => {
      const inicio = new Date(c.ultima_cobranca || c.data_resolucao);
      const fim = new Date(c.data_resolucao);
      return acc + (fim - inicio);
    }, 0);
    tempoMedio = Math.round(total / resolvidas.length / 3600000);
  }
  const cobrancasEnviadas = logs.rows.filter(l => l.acao === 'COBRANCA_ENVIADA').length;
  const erros = logs.rows.filter(l => l.acao === 'ERRO').length;
  const escalonamentos = logs.rows.filter(l => l.acao === 'ESCALONAMENTO').length;
  return { counts, total: cameras.rows.length, tempoMedioHoras: tempoMedio, cobrancasEnviadas, erros, escalonamentos, resolvidas: resolvidas.length };
}

module.exports = { pool, init, getCameras, upsertCamera, updateCamera, deleteCamera, addLog, getLog, hasRecentLog, getConversations, upsertConversation, incrementUnread, getMessages, addMessage, markRead, isBlocked, hasConsent, getConsents, setConsent, block, unblock, getTemplates, getTemplate, upsertTemplate, deleteTemplate, renderTemplate, getBotConfig, setBotConfig, getReports };
