const { Pool } = require('pg');
const pool = new Pool({ host:'127.0.0.1', port:5432, user:'n8n', password:'TROQUE_ESTA_SENHA', database:'n8n' });
pool.query('SELECT 1').then(r=>{ console.log('OK', r.rows); process.exit(0); }).catch(e=>{ console.error('ERR', e.message); process.exit(1); });
