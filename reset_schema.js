const db = require('./db');
async function main() {
  await db.pool.query('DROP TABLE IF EXISTS messages CASCADE');
  await db.pool.query('DROP TABLE IF EXISTS conversations CASCADE');
  await db.pool.query('DROP TABLE IF EXISTS log CASCADE');
  await db.pool.query('DROP TABLE IF EXISTS cameras CASCADE');
  await db.pool.query('DROP TABLE IF EXISTS consent CASCADE');
  await db.pool.query('DROP TABLE IF EXISTS blocklist CASCADE');
  await db.init();
  console.log('Schema resetado');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
