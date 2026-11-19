const db = require('./db');
db.pool.query("DELETE FROM cameras WHERE id LIKE 'CAM-%'").then(() => { console.log('cleaned'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
