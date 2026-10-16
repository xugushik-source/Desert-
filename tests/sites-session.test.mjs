import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LocalD1 } from "../tools/sqlite.mjs";
import { seed } from "../tools/seed.mjs";
import { privateSession } from "../src/sites-session.mjs";
function database() {
  const db = new LocalD1();
  db.exec(
    fs.readFileSync(
      new URL("../migrations/0001_marketplace.sql", import.meta.url),
      "utf8",
    ),
  );
  return db;
}
test("private Sites binds one authenticated owner and cannot transfer ownership", async () => {
  const db = database();
  assert.equal(
    await privateSession(new Request("https://private.test"), db),
    null,
  );
  const req = (id) =>
    new Request("https://private.test", {
      headers: { "oai-authenticated-user-id": id },
    });
  const r = await Promise.all([
    privateSession(req("owner-1"), db),
    privateSession(req("other-identity"), db),
  ]);
  assert.equal(r.filter((x) => x?.owner).length, 1);
  assert.equal(
    db.sqlite.prepare("SELECT count(*) n FROM users WHERE owner=1").get().n,
    1,
  );
  const who = r[0] ? "owner-1" : "other-identity";
  assert.equal((await privateSession(req(who), db)).id, r.find(Boolean).id);
  db.sqlite.prepare("UPDATE users SET active=0").run();
  assert.equal(await privateSession(req(who), db), null);
  db.close();
});
test("demo bootstrap is atomic when a product cannot be inserted", async () => {
  const db = database();
  db.exec(
    "CREATE TRIGGER reject_seed BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT,'DEMO_FAIL'); END;",
  );
  await assert.rejects(seed(db), /DEMO_FAIL/);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM cities").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM vendors").get().n, 0);
  db.close();
});
