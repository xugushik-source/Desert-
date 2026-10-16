import { DatabaseSync } from "node:sqlite";
export class LocalD1 {
  constructor(file = ":memory:") {
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }
  prepare(sql, p = []) {
    const adapter = this;
    const db = this.sqlite;
    return {
      bind(...a) {
        return adapter.prepare(sql, a);
      },
      async first() {
        return db.prepare(sql).get(...p) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...p) };
      },
      async run() {
        const r = db.prepare(sql).run(...p);
        return {
          meta: {
            changes: Number(r.changes),
            last_row_id: Number(r.lastInsertRowid),
          },
        };
      },
      _execute() {
        const r = db.prepare(sql).run(...p);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  async batch(list) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const r = list.map((s) => s._execute());
      this.sqlite.exec("COMMIT");
      return r;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  exec(sql) {
    this.sqlite.exec(sql);
  }
  close() {
    this.sqlite.close();
  }
}
