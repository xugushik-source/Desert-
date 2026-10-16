// Produces a NEW demo database bootstrap. Never exports an existing database.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1 } from "./sqlite.mjs";
import { seed, createUser } from "./seed.mjs";
import { token } from "../src/security.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, ".runtime");
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const credentials = path.join(runtime, "deploy-access.json"),
  output = path.join(runtime, "bootstrap.sql");
if (fs.existsSync(credentials) || fs.existsSync(output))
  throw Error("Bootstrap already exists. Reuse it; do not reset credentials.");
const config = {
  email: "owner@deserto.local",
  password: token(),
  RECOVERY_SECRET: token(),
};
const db = new LocalD1();
db.exec(
  fs.readFileSync(path.join(root, "migrations/0001_marketplace.sql"), "utf8"),
);
await seed(db);
await createUser(db, {
  email: config.email,
  name: "Владелец DESERTO",
  password: config.password,
  owner: true,
});
const quote = (v) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
const sql = [
  "-- New DESERTO demo data only. Apply after migrations. No real customer data.",
];
for (const table of ["cities", "vendors", "products", "users"])
  for (const row of db.sqlite.prepare("SELECT * FROM " + table).all())
    sql.push(
      "INSERT INTO " +
        table +
        "(" +
        Object.keys(row).join(",") +
        ") VALUES(" +
        Object.values(row).map(quote).join(",") +
        ");",
    );
fs.writeFileSync(credentials, JSON.stringify(config, null, 2), {
  mode: 0o600,
  flag: "wx",
});
fs.writeFileSync(output, sql.join("\n"), { mode: 0o600, flag: "wx" });
db.close();
console.log(
  "Prepared new demo bootstrap: " +
    output +
    "\nOwner access and Worker secret: " +
    credentials +
    "\nThese files must never be committed or shared.",
);
