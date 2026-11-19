// A tiny stand-in for Cloudflare D1, built on Node's SQLite, so tests run offline.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a; return o; },
        async first() { return st.get(...args) ?? null; },
        async all() { return { results: st.all(...args) }; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      };
      return o;
    },
  };
}
