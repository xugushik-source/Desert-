import { rankedVendors, listPromotions, promotionAction, settlementAction } from "./marketplace.mjs";
import {
  Problem,
  fail,
  uuid,
  token,
  sha,
  passwordHash,
  constant,
  text,
  integer,
  emailValue,
  jsonParse,
  userSession,
  requireUser,
  permit,
  now,
} from "./security.mjs";
import {
  catalog,
  slots,
  createOrder,
  orderView,
  orderList,
  action,
  approve,
  vendorPublic,
  vendorRecord,
  productPublic,
} from "./commerce.mjs";
import templates from "./seed-products.json" with { type: "json" };
const q = (db, sql, ...p) => db.prepare(sql).bind(...p);
const reply = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
function names(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_INPUT");
  const result = {};
  for (const k of ["ru", "ka", "en"]) result[k] = text(value[k], 120, true);
  return JSON.stringify(result);
}
async function payload(req) {
  if (req.method !== "POST") return null;
  const origin = req.headers.get("origin");
  if (
    (origin && origin !== new URL(req.url).origin) ||
    req.headers.get("sec-fetch-site") === "cross-site" ||
    req.headers.get("X-Deserto-CSRF") !== "1"
  )
    fail("FORBIDDEN", 403);
  if (!req.headers.get("content-type")?.includes("application/json"))
    fail("INVALID_INPUT");
  if (Number(req.headers.get("content-length") || 0) > 65536)
    fail("PAYLOAD_TOO_LARGE", 413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > 65536)
    fail("PAYLOAD_TOO_LARGE", 413);
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    fail("INVALID_INPUT");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) fail("INVALID_INPUT");
  return b;
}
async function login(req, db, b) {
  const email = emailValue(b.email),
    password = text(b.password, 200, true),
    limit = await sha(
      (req.headers.get("CF-Connecting-IP") || "local") + ":" + email,
    ),
    current = await q(
      db,
      "SELECT * FROM auth_limits WHERE key=?",
      limit,
    ).first();
  if (current && current.expires > Date.now() && current.attempts >= 10)
    fail("RATE_LIMIT", 429);
  await q(
    db,
    "INSERT INTO auth_limits(key,attempts,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires<? THEN 1 ELSE attempts+1 END,expires=CASE WHEN expires<? THEN ? ELSE expires END",
    limit,
    Date.now() + 900000,
    Date.now(),
    Date.now(),
    Date.now() + 900000,
  ).run();
  const u = await q(
    db,
    "SELECT * FROM users WHERE email=? AND active=1",
    email,
  ).first();
  const hash = await passwordHash(
    password,
    u?.salt || "unknown-deserto-account",
  );
  if (!u || !constant(hash, u.hash)) fail("LOGIN_FAILED", 401);
  const value = token();
  await db.batch([
    q(db, "DELETE FROM auth_limits WHERE key=?", limit),
    q(db, "DELETE FROM sessions WHERE expires<?", Date.now()),
    q(
      db,
      "INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)",
      await sha(value),
      u.id,
      Date.now() + 8 * 3600000,
    ),
  ]);
  return reply({ ok: true }, 200, {
    "Set-Cookie": `deserto_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`,
  });
}
export async function handle(req, env) {
  try {
    const url = new URL(req.url),
      p = url.pathname;
    if (p === "/api/health")
      return reply({
        ok: true,
        brand: "DESERTO",
        database: !!env.DB,
        bots: false,
        payments: false,
      });
    if (!env.DB) fail("DATABASE_UNAVAILABLE", 503);
    const db = env.DB,
      b = await payload(req),
      user = env.PRIVATE_SITES_SESSION
        ? await env.PRIVATE_SITES_SESSION(req, db)
        : await userSession(req, db);
    if (p === "/api/session" && req.method === "GET")
      return reply({ user, bots: false });
    if (p === "/api/login" && b) return await login(req, db, b);
    if (p === "/api/logout" && b) {
      const val = (req.headers.get("cookie") || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("deserto_session="))
        ?.slice(16);
      if (val)
        await q(db, "DELETE FROM sessions WHERE hash=?", await sha(val)).run();
      return reply({ ok: true }, 200, {
        "Set-Cookie":
          "deserto_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    }
    if (p === "/api/cities" && req.method === "GET") {
      const rows = (
        await db
          .prepare("SELECT * FROM cities WHERE active=1 ORDER BY id")
          .all()
      ).results;
      return reply({
        cities: rows.map((c) => ({ ...c, names: jsonParse(c.names) })),
      });
    }
    if (p === "/api/vendors" && req.method === "GET") {
      const rows = await rankedVendors(db, url.searchParams.get("city"));
      return reply({ vendors: rows.map(vendorPublic) });
    }
    if (p === "/api/catalog" && req.method === "GET")
      return reply(await catalog(db, url.searchParams.get("vendor")));
    if (p === "/api/slots" && req.method === "GET")
      return reply({
        slots: await slots(
          db,
          url.searchParams.get("vendor"),
          url.searchParams.get("day"),
          integer(Number(url.searchParams.get("lead") || 0), 0, 10080),
        ),
      });
    if (p === "/api/orders" && b) return reply(await createOrder(env, b), 201);
    if (p === "/api/order/view" && b)
      return reply(
        await orderView(db, text(b.id, 80, true), {
          key: text(b.key, 100, true),
        }),
      );
    if (p === "/api/order/approve" && b) return reply(await approve(env, b));
    if (p === "/api/join" && b) {
      const hash = await sha(text(b.invite, 100, true)),
        invite = await q(
          db,
          "SELECT * FROM invites WHERE hash=? AND expires>? AND used=0",
          hash,
          Date.now(),
        ).first();
      if (!invite) fail("INVITE_EXPIRED", 409);
      const email = emailValue(b.email),
        name = text(b.name, 100, true),
        password = text(b.password, 200, true);
      if (password.length < 12) fail("PASSWORD_TOO_SHORT");
      const uid = uuid(),
        salt = token(),
        pw = await passwordHash(password, salt);
      try {
        await db.batch([
          q(db, "UPDATE invites SET used=1 WHERE hash=? AND used=0", hash),
          db.prepare("INSERT INTO write_guards(value) VALUES(changes())"),
          q(
            db,
            "INSERT INTO users(id,email,name,hash,salt) VALUES(?,?,?,?,?)",
            uid,
            email,
            name,
            pw,
            salt,
          ),
          q(
            db,
            "INSERT INTO memberships(user_id,vendor_id,role) VALUES(?,?,?)",
            uid,
            invite.vendor_id,
            invite.role,
          ),
          db.prepare("DELETE FROM write_guards"),
        ]);
      } catch (e) {
        if (/constraint/i.test(e.message)) fail("INVITE_OR_EMAIL_USED", 409);
        throw e;
      }
      return reply({ ok: true });
    }
    if (p === "/api/promotions" && req.method === "GET") return reply(await listPromotions(db, url.searchParams.get("vendor")));
    if (p.startsWith("/api/manage/")) {
      requireUser(user);
      if (p === "/api/manage/promotions" && req.method === "GET") return reply(await listPromotions(db,url.searchParams.get("vendor"),user));
      if (p === "/api/manage/promotion" && b) return reply(await promotionAction(db,b,user));
      if (p === "/api/manage/settlement" && b) return reply(await settlementAction(db,b,user));
      if (p === "/api/manage/settlements" && req.method === "GET") {
        if(!user.owner) fail("FORBIDDEN",403);
        const vendor=url.searchParams.get("vendor");
        const orders=(await q(db,"SELECT id,total,currency,version FROM orders WHERE vendor_id=? AND status='COMPLETED' AND payment='PAID' ORDER BY updated_at DESC",vendor).all()).results;
        const records=(await q(db,"SELECT * FROM settlements WHERE vendor_id=? ORDER BY at DESC",vendor).all()).results;
        return reply({orders,records:records.map(r=>({...r,expenses:jsonParse(r.expenses)}))});
      }
      if (p === "/api/manage/vendors" && req.method === "GET") {
        const rows = (
          await db
            .prepare(
              "SELECT v.*,c.timezone,c.currency FROM vendors v JOIN cities c ON c.id=v.city_id ORDER BY v.id",
            )
            .all()
        ).results;
        return reply({
          vendors: rows
            .filter(
              (v) =>
                user.owner ||
                user.memberships.some((m) => m.vendor_id === v.id),
            )
            .map((v) => ({
              ...vendorPublic(v),
              role: user.owner
                ? "OWNER"
                : user.memberships.find((m) => m.vendor_id === v.id).role,
            })),
        });
      }
      if (p === "/api/manage/catalog" && req.method === "GET") {
        const vendor = url.searchParams.get("vendor");
        permit(user, vendor);
        return reply(await catalog(db, vendor, true));
      }
      if (p === "/api/manage/orders" && req.method === "GET")
        return reply(await orderList(db, user, url.searchParams.get("vendor")));
      if (p === "/api/manage/action" && b)
        return reply(await action(env, b, user));
      if (p === "/api/manage/product" && b) {
        permit(user, b.vendor_id, ["ADMIN"]);
        const product = await q(
          db,
          "SELECT * FROM products WHERE id=? AND vendor_id=?",
          b.id,
          b.vendor_id,
        ).first();
        if (!product) fail("NOT_FOUND", 404);
        const activePromotion=await q(db,"SELECT id FROM promotions WHERE product_id=? AND state='ACTIVE'",product.id).first();
        if(activePromotion && b.price!==product.price) fail("PROMOTION_ACTIVE",409);
        const price = integer(b.price),
          stock = integer(b.stock, product.reserved, 100000),
          title = names(b.names),
          lead = integer(b.lead_minutes, 0, 10080);
        if (typeof b.active !== "boolean") fail("INVALID_INPUT");
        const cost = b.cost === null ? null : integer(b.cost);
        const result = await db.batch([
          q(
            db,
            "UPDATE products SET names=?,price=?,stock=?,lead_minutes=?,active=?,cost=?,version=version+1 WHERE id=? AND version=? AND reserved<=?",
            title,
            price,
            stock,
            lead,
            b.active ? 1 : 0,
            cost,
            b.id,
            integer(b.version),
            stock,
          ),
          db.prepare("INSERT INTO write_guards(value) VALUES(changes())"),
          q(
            db,
            "INSERT INTO audit(id,at,actor,vendor_id,event,data) VALUES(?,?,?,?,?,?)",
            uuid(),
            now(),
            user.id,
            b.vendor_id,
            "PRODUCT_UPDATED",
            JSON.stringify({
              id: b.id,
              price,
              stock,
              reason: text(b.reason, 300, true),
            }),
          ),
          db.prepare("DELETE FROM write_guards"),
        ]);
        return reply({ ok: true });
      }
      if (p === "/api/manage/vendor" && b) {
        permit(user, b.id, ["ADMIN"]);
        const v = await vendorRecord(db, b.id);
        const title = names(b.names),
          open = integer(b.open_minute, 0, 1439),
          close = integer(b.close_minute, 1, 1440);
        if (open >= close) fail("INVALID_INPUT");
        await db.batch([
          q(
            db,
            "UPDATE vendors SET names=?,address=?,phone=?,lead_minutes=?,open_minute=?,close_minute=?,delivery_enabled=?,delivery_fee=?,slot_capacity=? WHERE id=?",
            title,
            text(b.address, 300),
            text(b.phone, 40),
            integer(b.lead_minutes, 0, 10080),
            open,
            close,
            b.delivery_enabled === true ? 1 : 0,
            integer(b.delivery_fee),
            integer(b.slot_capacity, 1, 100),
            b.id,
          ),
          q(
            db,
            "INSERT INTO audit(id,at,actor,vendor_id,event,data) VALUES(?,?,?,?,?,?)",
            uuid(),
            now(),
            user.id,
            b.id,
            "VENDOR_UPDATED",
            "{}",
          ),
        ]);
        return reply({ ok: true });
      }
      if (p === "/api/manage/city" && b) {
        if (!user.owner) fail("FORBIDDEN", 403);
        const id = text(b.id, 80, true),
          title = names(b.names),
          timezone = text(b.timezone, 80, true);
        if (!/^[a-z0-9-]{3,80}$/.test(id) || b.currency !== "GEL")
          fail("INVALID_INPUT");
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
        } catch {
          fail("INVALID_INPUT");
        }
        await db.batch([
          q(
            db,
            "INSERT INTO cities(id,names,timezone,currency) VALUES(?,?,?,?)",
            id,
            title,
            timezone,
            "GEL",
          ),
          q(
            db,
            "INSERT INTO audit(id,at,actor,event,data) VALUES(?,?,?,?,?)",
            uuid(),
            now(),
            user.id,
            "CITY_CREATED",
            JSON.stringify({ id }),
          ),
        ]);
        return reply({ id });
      }
      if (p === "/api/manage/new-vendor" && b) {
        if (!user.owner) fail("FORBIDDEN", 403);
        const city = await q(
          db,
          "SELECT id FROM cities WHERE id=? AND active=1",
          b.city_id,
        ).first();
        if (!city) fail("NOT_FOUND", 404);
        const id = uuid(),
          title = names(b.names),
          slug = text(b.slug, 80, true);
        if (!/^[a-z0-9-]{3,80}$/.test(slug)) fail("INVALID_INPUT");
        await q(
          db,
          "INSERT INTO vendors(id,city_id,slug,names,demo) VALUES(?,?,?,?,1)",
          id,
          city.id,
          slug,
          title,
        ).run();
        return reply({ id, active: false });
      }
      if (p === "/api/manage/vendor-publish" && b) {
        if (!user.owner || typeof b.active !== "boolean")
          fail("FORBIDDEN", 403);
        await q(
          db,
          "UPDATE vendors SET active=? WHERE id=?",
          b.active ? 1 : 0,
          b.id,
        ).run();
        return reply({ ok: true });
      }
      if (p === "/api/manage/templates" && req.method === "GET") {
        permit(user, url.searchParams.get("vendor"), ["ADMIN"]);
        return reply({
          products: templates.map((p) => ({ ...p, id: "template:" + p.id })),
        });
      }
      if (p === "/api/manage/new-product" && b) {
        permit(user, b.vendor_id, ["ADMIN"]);
        const template = templates.find(
          (p) => "template:" + p.id === b.source_product_id,
        );
        const source = template
          ? {
              source_id: template.id,
              names: JSON.stringify(template.names),
              description: "{}",
              category: template.category,
              image: template.image,
              lead_minutes: template.lead_minutes,
              options: "[]",
              allergens: "[]",
            }
          : await q(
              db,
              "SELECT * FROM products WHERE id=? AND vendor_id=?",
              b.source_product_id,
              b.vendor_id,
            ).first();
        if (!source) fail("NOT_FOUND", 404);
        const id = uuid();
        await q(
          db,
          "INSERT INTO products(id,vendor_id,source_id,names,description,category,image,price,stock,lead_minutes,options,allergens,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          b.vendor_id,
          source.source_id,
          names(b.names || jsonParse(source.names)),
          source.description,
          source.category,
          source.image,
          integer(b.price),
          integer(b.stock, 0, 100000),
          source.lead_minutes,
          source.options,
          source.allergens,
          b.cost === undefined ? null : integer(b.cost),
        ).run();
        return reply({ id });
      }
      if (p === "/api/manage/invite" && b) {
        permit(user, b.vendor_id, ["ADMIN"]);
        if (!["ADMIN", "STAFF", "DRIVER"].includes(b.role))
          fail("INVALID_INPUT");
        const value = token();
        await q(
          db,
          "INSERT INTO invites(hash,vendor_id,role,expires) VALUES(?,?,?,?)",
          await sha(value),
          b.vendor_id,
          b.role,
          Date.now() + 86400000,
        ).run();
        return reply({ invite: value, expires_hours: 24 });
      }
      if (p === "/api/manage/members" && req.method === "GET") {
        const vendor = url.searchParams.get("vendor");
        permit(user, vendor, ["ADMIN"]);
        return reply({
          members: (
            await q(
              db,
              "SELECT u.id,u.name,u.email,u.active,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.vendor_id=?",
              vendor,
            ).all()
          ).results,
        });
      }
      if (p === "/api/manage/revoke" && b) {
        permit(user, b.vendor_id, ["ADMIN"]);
        if (b.user_id === user.id) fail("CANNOT_REVOKE_SELF", 409);
        await q(
          db,
          "DELETE FROM memberships WHERE user_id=? AND vendor_id=?",
          b.user_id,
          b.vendor_id,
        ).run();
        return reply({ ok: true });
      }
      if (p === "/api/manage/summary" && req.method === "GET") {
        const vendor = url.searchParams.get("vendor");
        permit(user, vendor);
        const s = await q(
          db,
          "SELECT count(*) AS orders,COALESCE(sum(CASE WHEN status='COMPLETED' THEN total ELSE 0 END),0) AS revenue,COALESCE(sum(paid),0) AS received,COALESCE(sum(CASE WHEN status='COMPLETED' THEN total-paid ELSE 0 END),0) AS debt FROM orders WHERE vendor_id=?",
          vendor,
        ).first();
        const costs = await q(
          db,
          "SELECT count(CASE WHEN i.cost IS NULL THEN 1 END) AS unknown,COALESCE(sum(i.cost*i.qty),0) AS cost FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.vendor_id=? AND o.status='COMPLETED'",
          vendor,
        ).first();
        return reply({
          ...s,
          cost: costs.unknown ? null : costs.cost,
          gross_profit: costs.unknown ? null : s.revenue - costs.cost,
          bot_status: "DISABLED",
        });
      }
    }
    fail("NOT_FOUND", 404);
  } catch (e) {
    if (e instanceof Problem) return reply({ error: e.code }, e.status);
    if (/CHECK|UNIQUE|constraint/i.test(e.message || ""))
      return reply({ error: "CONFLICT" }, 409);
    return reply({ error: "SERVER_ERROR" }, 500);
  }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handle(req, env);
    const r = await env.ASSETS.fetch(req);
    const headers = new Headers(r.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return new Response(r.body, { status: r.status, headers });
  },
};
