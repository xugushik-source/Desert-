import { migrateLocal } from "./migrate-local.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1 } from "./sqlite.mjs";
import { seed, createUser } from "./seed.mjs";
import { token } from "../src/security.mjs";
import worker from "../src/worker.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
const db = new LocalD1(path.join(root, ".runtime", "deserto.sqlite"));
migrateLocal(db);
await seed(db);
const file = path.join(root, ".runtime", "local-access.json");
let config;
if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file));
else {
  config = {
    email: "owner@deserto.local",
    password: token(),
    RECOVERY_SECRET: token(),
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}
if (
  !(await db
    .prepare("SELECT id FROM users WHERE email=?")
    .bind(config.email)
    .first())
)
  await createUser(db, {
    email: config.email,
    name: "Владелец DESERTO",
    password: config.password,
    owner: true,
  });
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const env = {
  DB: db,
  RECOVERY_SECRET: config.RECOVERY_SECRET,
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      let name;
      try {
        name = decodeURIComponent(u.pathname);
      } catch {
        return new Response("Bad path", { status: 400 });
      }
      if (name.includes(".."))
        return new Response("Forbidden", { status: 403 });
      if (!path.extname(name)) name = "/index.html";
      const target = path.join(root, "public", name);
      try {
        return new Response(fs.readFileSync(target), {
          headers: {
            "Content-Type":
              types[path.extname(target)] || "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
};
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 65536) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(c);
    }
    const bytes = Buffer.concat(chunks);
    const r = await worker.fetch(
      new Request("http://127.0.0.1:" + (process.env.PORT || 5173) + req.url, {
        method: req.method,
        headers: req.headers,
        ...(bytes.length ? { body: bytes } : {}),
      }),
      env,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("Local development error");
  }
});
server.listen(Number(process.env.PORT || 5173), "127.0.0.1", () =>
  console.log(
    "DESERTO: http://127.0.0.1:" +
      (process.env.PORT || 5173) +
      "\nЛокальный доступ владельца: " +
      file +
      "\nТолько тестовые данные. Боты и реальные платежи отключены.",
  ),
);
