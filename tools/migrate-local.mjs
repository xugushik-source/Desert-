import fs from 'node:fs';
export function migrateLocal(db) {
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(x=>x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
}
