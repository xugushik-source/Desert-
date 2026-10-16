import { migrateLocal } from "../tools/migrate-local.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LocalD1 } from "../tools/sqlite.mjs";
import { seed, createUser } from "../tools/seed.mjs";
import { handle } from "../src/worker.mjs";
import { localClock, slotInstant } from "../src/commerce.mjs";
const pass = "local-test-password-12345",
  key = () => crypto.randomUUID();
async function fixture() {
  const db = new LocalD1();
  migrateLocal(db);
  await seed(db);
  const owner = await createUser(db, {
    email: "owner@test.invalid",
    name: "Owner",
    password: pass,
    owner: true,
  });
  const a = await createUser(db, {
      email: "a@test.invalid",
      name: "A",
      password: pass,
      vendor_id: "sweet-house",
    }),
    b = await createUser(db, {
      email: "b@test.invalid",
      name: "B",
      password: pass,
      vendor_id: "cacao-atelier",
    });
  await createUser(db, {
    email: "d@test.invalid",
    name: "D",
    password: pass,
    vendor_id: "sweet-house",
    role: "DRIVER",
  });
  const env = {
    DB: db,
    RECOVERY_SECRET: "test-recovery-secret-more-than-32-characters",
  };
  async function req(path, body, cookie = "", headers = {}) {
    const r = await handle(
      new Request("https://deserto.test" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Deserto-CSRF": "1",
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const login = async (email = "owner@test.invalid") =>
    (await req("/api/login", { email, password: pass })).cookie;
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const payload = () => ({
    idem: key(),
    vendor_id: "sweet-house",
    city_id: "akhalkalaki",
    items: [{ product_id: "sweet-house--eclair", qty: 1 }],
    method: "cash",
    fulfillment: "pickup",
    day,
    minute: 720,
    expected_total: 500,
    customer: { name: "DEMO", phone: "+99500000000" },
  });
  return { db, env, req, login, payload, owner, a, b };
}

test("cities, sellers and catalogue are separated; costs are private", async () => {
  const f = await fixture();
  const r = await f.req("/api/vendors?city=tbilisi");
  assert.equal(r.data.vendors.length, 2);
  assert.ok(r.data.vendors.every((v) => v.city_id === "tbilisi"));
  const c = await f.req("/api/catalog?vendor=sweet-house");
  assert.equal(c.data.products.length, 36);
  assert.equal(c.data.products[0].cost, undefined);
  assert.equal(c.data.vendor.currency, "GEL");
  assert.equal((await f.req("/api/health")).data.bots, false);
  f.db.close();
});
test("order survives, retry is idempotent, posted totals are not trusted", async () => {
  const f = await fixture(),
    p = f.payload();
  const r = await f.req("/api/orders", p);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total, 500);
  assert.equal((await f.req("/api/orders", p)).data.id, r.data.id);
  assert.equal(
    (await f.req("/api/orders", { ...p, expected_total: 1 })).status,
    409,
  );
  assert.equal(
    (await f.req("/api/orders", { ...f.payload(), expected_total: 0 })).data
      .error,
    "PRICE_CHANGED",
  );
  const view = await f.req("/api/order/view", {
    id: r.data.id,
    key: r.data.key,
  });
  assert.equal(view.status, 200);
  assert.equal(view.data.customer.name, "DEMO");
  assert.equal(
    (await f.req("/api/order/view", { id: r.data.id, key: "bad" })).status,
    404,
  );
  assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM orders").get().n, 1);
  f.db.close();
});
test("city mismatch and cross-vendor item injection are rejected", async () => {
  const f = await fixture();
  assert.equal(
    (await f.req("/api/orders", { ...f.payload(), city_id: "tbilisi" })).data
      .error,
    "CITY_MISMATCH",
  );
  assert.equal(
    (
      await f.req("/api/orders", {
        ...f.payload(),
        items: [{ product_id: "cacao-atelier--eclair", qty: 1 }],
      })
    ).data.error,
    "PRODUCT_UNAVAILABLE",
  );
  f.db.close();
});
test("competing orders cannot oversell; failed batch leaves no orphan order", async () => {
  const f = await fixture();
  f.db.sqlite
    .prepare("UPDATE products SET stock=1 WHERE id=?")
    .run("sweet-house--eclair");
  const r = await Promise.all([
    f.req("/api/orders", f.payload()),
    f.req("/api/orders", f.payload()),
  ]);
  assert.equal(r.filter((x) => x.status === 201).length, 1);
  assert.equal(r.filter((x) => x.status === 409).length, 1);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM orders").get().n, 1);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT reserved FROM products WHERE id=?")
      .get("sweet-house--eclair").reserved,
    1,
  );
  f.db.close();
});
test("slot capacity is atomic and independent of another seller", async () => {
  const f = await fixture();
  f.db.sqlite
    .prepare("UPDATE vendors SET slot_capacity=1 WHERE id=?")
    .run("sweet-house");
  const r = await Promise.all([
    f.req("/api/orders", f.payload()),
    f.req("/api/orders", {
      ...f.payload(),
      items: [{ product_id: "sweet-house--americano", qty: 1 }],
      expected_total: 300,
    }),
  ]);
  assert.equal(r.filter((x) => x.status === 201).length, 1);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(reserved) n FROM products WHERE vendor_id=?")
      .get("sweet-house").n,
    1,
  );
  f.db.close();
});
test("authentication, CSRF and seller permissions are enforced on server", async () => {
  const f = await fixture();
  assert.equal(
    (await f.req("/api/manage/orders?vendor=sweet-house")).status,
    401,
  );
  const cookie = await f.login("a@test.invalid");
  assert.ok(cookie);
  assert.equal(
    (await f.req("/api/manage/orders?vendor=cacao-atelier", undefined, cookie))
      .status,
    403,
  );
  assert.equal(
    (await f.req("/api/manage/orders?vendor=sweet-house", undefined, cookie))
      .status,
    200,
  );
  assert.equal(
    (
      await f.req("/api/orders", f.payload(), "", {
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req("/api/manage/orders?vendor=sweet-house", undefined, "", {
        "oai-authenticated-user-id": f.owner,
      })
    ).status,
    401,
  );
  await f.req("/api/logout", {}, cookie);
  assert.equal(
    (await f.req("/api/manage/orders?vendor=sweet-house", undefined, cookie))
      .status,
    401,
  );
  f.db.close();
});
test("single-use employee invitation, password policy and no role spoofing", async () => {
  const f = await fixture(),
    cookie = await f.login("a@test.invalid");
  const invite = (
    await f.req(
      "/api/manage/invite",
      { vendor_id: "sweet-house", role: "STAFF" },
      cookie,
    )
  ).data.invite;
  assert.ok(invite);
  const body = {
    invite,
    email: "staff@test.invalid",
    name: "Staff",
    password: pass,
    role: "OWNER",
  };
  assert.equal((await f.req("/api/join", body)).status, 200);
  assert.equal(
    (await f.req("/api/join", { ...body, email: "other@test.invalid" })).status,
    409,
  );
  const staff = await f.login("staff@test.invalid");
  assert.equal(
    (await f.req("/api/session", undefined, staff)).data.user.owner,
    false,
  );
  assert.equal(
    (
      await f.req(
        "/api/manage/invite",
        { vendor_id: "sweet-house", role: "ADMIN" },
        staff,
      )
    ).status,
    403,
  );
  f.db.close();
});
test("full pickup flow and separate partial payments, command replay", async () => {
  const f = await fixture(),
    cookie = await f.login("a@test.invalid");
  let o = (await f.req("/api/orders", f.payload())).data;
  const customerKey = o.key;
  async function act(action, extra = {}) {
    const b = {
        id: o.id,
        action,
        version: o.version,
        command_id: key(),
        reason: "DEMO verification",
        ...extra,
      },
      r = await f.req("/api/manage/action", b, cookie);
    if (r.status === 200)
      o = (await f.req("/api/order/view", { id: o.id, key: customerKey })).data;
    return { r, b };
  }
  assert.equal((await act("ready")).r.status, 409);
  assert.equal((await act("confirm")).r.status, 200);
  const paid = await act("payment", { amount: 200 });
  assert.equal(o.payment, "PARTIAL");
  assert.equal((await f.req("/api/manage/action", paid.b, cookie)).status, 200);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM payments").get().n,
    1,
  );
  assert.equal((await act("payment", { amount: 301 })).r.status, 400);
  await act("payment", { amount: 300 });
  assert.equal(o.payment, "PAID");
  await act("prepare");
  await act("ready");
  assert.equal((await act("handover")).r.status, 200);
  assert.equal(o.status, "COMPLETED");
  assert.equal(
    f.db.sqlite
      .prepare("SELECT stock,reserved FROM products WHERE id=?")
      .get("sweet-house--eclair").reserved,
    0,
  );
  assert.equal(
    (await f.req("/api/manage/summary?vendor=sweet-house", undefined, cookie))
      .data.revenue,
    500,
  );
  f.db.close();
});
test("replacement needs buyer capability, original order retained, stale approval refused", async () => {
  const f = await fixture(),
    cookie = await f.login("a@test.invalid");
  const created = (await f.req("/api/orders", f.payload())).data;
  const r = await f.req(
    "/api/manage/action",
    {
      id: created.id,
      version: 0,
      action: "propose",
      items: [{ product_id: "sweet-house--americano", qty: 1 }],
      reason: "DEMO unavailable eclair",
      command_id: key(),
    },
    cookie,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let o = (await f.req("/api/order/view", { id: created.id, key: created.key }))
    .data;
  assert.equal(o.items[0].product_id, "sweet-house--eclair");
  const b = {
    id: o.id,
    key: created.key,
    version: o.version,
    proposal_id: o.proposal.id,
    approved: true,
  };
  assert.equal(
    (await f.req("/api/order/approve", { ...b, key: "bad" })).status,
    404,
  );
  const approved = await f.req("/api/order/approve", b);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.total, 300);
  assert.equal(approved.data.items[0].product_id, "sweet-house--americano");
  assert.equal((await f.req("/api/order/approve", b)).status, 409);
  assert.match(
    f.db.sqlite.prepare("SELECT original_items FROM orders").get()
      .original_items,
    /eclair/,
  );
  f.db.close();
});
test("cancellation releases stock, stale seller action rolls back and outbox stays internal", async () => {
  const f = await fixture(),
    cookie = await f.login("a@test.invalid");
  const o = (await f.req("/api/orders", f.payload())).data;
  const a = {
    id: o.id,
    version: 0,
    action: "cancel",
    reason: "DEMO",
    command_id: key(),
  };
  assert.equal((await f.req("/api/manage/action", a, cookie)).status, 200);
  assert.equal(
    (
      await f.req(
        "/api/manage/action",
        { ...a, action: "confirm", command_id: key() },
        cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT reserved FROM products WHERE id=?")
      .get("sweet-house--eclair").reserved,
    0,
  );
  assert.ok(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM outbox WHERE status=?")
      .get("DISABLED").n > 0,
  );
  f.db.close();
});
test("calendar conversion and whole-cake lead time cover overnight", async () => {
  assert.equal(
    new Date(slotInstant("Asia/Tbilisi", "2030-01-02", 720)).toISOString(),
    "2030-01-02T08:00:00.000Z",
  );
  const f = await fixture(),
    c = localClock("Asia/Tbilisi");
  const r = await f.req(
    "/api/slots?vendor=sweet-house&day=" + c.day + "&lead=1440",
  );
  assert.deepEqual(r.data.slots, []);
  f.db.close();
});
