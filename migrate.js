const db = require('./db');
const fs = require('fs');
const path = require('path');

async function main() {
  await db.init();
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  for (const c of (data.cameras || [])) {
    await db.upsertCamera(c);
  }
  for (const l of (data.log || [])) {
    await db.addLog(l);
  }
  // migrate conversations/messages if present
  if (data.conversations) {
    for (const [jid, c] of Object.entries(data.conversations)) {
      await db.upsertConversation(jid, c.name, c.lastMessage, c.lastTime);
    }
  }
  if (data.messages) {
    for (const [jid, msgs] of Object.entries(data.messages)) {
      for (const m of msgs) await db.addMessage(jid, m);
    }
  }
  console.log('Migração concluída');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
