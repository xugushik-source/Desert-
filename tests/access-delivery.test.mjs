import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LocalD1 } from "../tools/sqlite.mjs";
import { seed, createUser } from "../tools/seed.mjs";
import { handle } from "../src/worker.mjs";
const pass = "test-password-123456789";
async function fixture() {
  const db = new LocalD1();
  db.exec(
    fs.readFileSync(
      new URL("../migrations/0001_marketplace.sql", import.meta.url),
      "utf8",
    ),
  );
  await seed(db);
  const users = {};
  for (const [email, role] of [
    ["owner", "OWNER"],
    ["admin", "ADMIN"],
    ["driver1", "DRIVER"],
    ["driver2", "DRIVER"],
  ])
    users[email] = await createUser(db, {
      email: email + "@test.invalid",
      name: email,
      password: pass,
      owner: role === "OWNER",
      ...(role === "OWNER" ? {} : { vendor_id: "sweet-house", role }),
    });
  const env = {
    DB: db,
    RECOVERY_SECRET: "test-secret-over-thirty-two-characters",
  };
  async function req(path, body, cookie) {
    const r = await handle(
      new Request("https://deserto.test/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Deserto-CSRF": "1",
          ...(cookie ? { cookie } : {}),
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
  const login = async (email) =>
    (await req("login", { email: email + "@test.invalid", password: pass }))
      .cookie;
  const payload = () => ({
    idem: crypto.randomUUID(),
    vendor_id: "sweet-house",
    city_id: "akhalkalaki",
    items: [{ product_id: "sweet-house--eclair", qty: 1 }],
    method: "cash",
    fulfillment: "pickup",
    day: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    minute: 720,
    expected_total: 500,
    customer: { name: "DEMO", phone: "+99500000000" },
  });
  return { db, req, login, payload, users };
}
test("delivery assignment is atomic, private and cannot be stolen", async () => {
  const f = await fixture(),
    admin = await f.login("admin"),
    d1 = await f.login("driver1"),
    d2 = await f.login("driver2");
  let o = (
    await f.req("orders", {
      ...f.payload(),
      fulfillment: "delivery",
      expected_total: 1000,
      customer: {
        name: "DEMO",
        phone: "+99500000000",
        address: "DEMO ADDRESS",
      },
    })
  ).data;
  const key = o.key;
  const act = async (action, cookie, extra = {}) => {
    const r = await f.req(
      "manage/action",
      {
        id: o.id,
        version: o.version,
        action,
        command_id: crypto.randomUUID(),
        ...extra,
      },
      cookie,
    );
    o = (await f.req("order/view", { id: o.id, key })).data;
    return r;
  };
  for (const a of ["confirm", "prepare", "ready"])
    assert.equal((await act(a, admin)).status, 200);
  const available = (
    await f.req("manage/orders?vendor=sweet-house", undefined, d1)
  ).data.available[0];
  assert.equal(available.version, o.version);
  assert.equal(available.customer, undefined);
  const b = { id: o.id, version: o.version, action: "claim" };
  const race = await Promise.all([
    f.req("manage/action", { ...b, command_id: crypto.randomUUID() }, d1),
    f.req("manage/action", { ...b, command_id: crypto.randomUUID() }, d2),
  ]);
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  const winner = race[0].status === 200 ? d1 : d2,
    loser = winner === d1 ? d2 : d1;
  o = (await f.req("order/view", { id: o.id, key })).data;
  assert.equal((await act("claim", loser)).status, 409);
  assert.equal(
    (await f.req("manage/orders?vendor=sweet-house", undefined, loser)).data
      .orders.length,
    0,
  );
  for (const a of ["pickup", "depart", "deliver"])
    assert.equal((await act(a, winner)).status, 200);
  assert.equal(o.status, "COMPLETED");
  assert.equal(o.payment, "UNPAID");
  await act("payment", admin, { amount: 1000, reason: "DEMO cash verified" });
  assert.equal(o.payment, "PAID");
  f.db.close();
});
test("replacement price changes require a new proposal", async () => {
  const f = await fixture(),
    cookie = await f.login("admin"),
    created = (await f.req("orders", f.payload())).data;
  await f.req(
    "manage/action",
    {
      id: created.id,
      version: 0,
      action: "propose",
      items: [{ product_id: "sweet-house--americano", qty: 1 }],
      reason: "DEMO",
      command_id: crypto.randomUUID(),
    },
    cookie,
  );
  const o = (await f.req("order/view", { id: created.id, key: created.key }))
    .data;
  assert.ok(o.proposal.items[0].title.ru);
  f.db.sqlite
    .prepare("UPDATE products SET price=price+100,version=version+1 WHERE id=?")
    .run("sweet-house--americano");
  const r = await f.req("order/approve", {
    id: o.id,
    key: created.key,
    version: o.version,
    proposal_id: o.proposal.id,
    approved: true,
  });
  assert.equal(r.data.error, "PRICE_CHANGED");
  assert.equal(
    f.db.sqlite.prepare("SELECT total FROM orders").get().total,
    500,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT reserved FROM products WHERE id=?")
      .get("sweet-house--eclair").reserved,
    1,
  );
  f.db.close();
});
test("only owner creates cities, hidden shops; access revocation is immediate", async () => {
  const f = await fixture(),
    owner = await f.login("owner"),
    admin = await f.login("admin"),
    names = { ru: "Батуми", ka: "ბათუმი", en: "Batumi" },
    city = { id: "batumi", names, timezone: "Asia/Tbilisi", currency: "GEL" };
  assert.equal((await f.req("manage/city", city, admin)).status, 403);
  assert.equal(
    (await f.req("manage/city", { ...city, timezone: "Bogus/Zone" }, owner))
      .status,
    400,
  );
  assert.equal((await f.req("manage/city", city, owner)).status, 200);
  const v = (
    await f.req(
      "manage/new-vendor",
      { city_id: "batumi", names, slug: "demo-batumi" },
      owner,
    )
  ).data;
  assert.ok(v.id);
  assert.equal((await f.req("vendors?city=batumi")).data.vendors.length, 0);
  await f.req("manage/vendor-publish", { id: v.id, active: true }, owner);
  assert.equal((await f.req("vendors?city=batumi")).data.vendors.length, 1);
  assert.equal(
    (
      await f.req(
        "manage/revoke",
        { vendor_id: "sweet-house", user_id: f.users.admin },
        owner,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.req("manage/orders?vendor=sweet-house", undefined, admin)).status,
    403,
  );
  f.db.close();
});
test("all language keys and original photographs are present", async () => {
  const { words } = await import("../public/i18n.js");
  for (const lang of ["ka", "en"])
    assert.deepEqual(
      Object.keys(words[lang]).sort(),
      Object.keys(words.ru).sort(),
      lang,
    );
  const source = JSON.parse(
    fs.readFileSync(new URL("../src/seed-products.json", import.meta.url)),
  );
  for (const p of source)
    assert.ok(
      fs.statSync(new URL("../public" + p.image, import.meta.url)).size > 0,
    );
});

test("failed login returns JSON and repeated attempts are limited", async () => {
  const f = await fixture();
  const body = { email: "admin@test.invalid", password: "wrong-password" };
  for (let i = 0; i < 10; i++) {
    const r = await f.req("login", body);
    assert.equal(r.status, 401);
    assert.equal(r.data.error, "LOGIN_FAILED");
  }
  assert.equal((await f.req("login", body)).status, 429);
  f.db.close();
});
test("empty new bakery can add its own first product from public demo templates", async () => {
  const f = await fixture(),
    owner = await f.login("owner");
  const names = { ru: "Демо", ka: "დემო", en: "Demo" };
  const v = (
    await f.req(
      "manage/new-vendor",
      { city_id: "tbilisi", names, slug: "first-product" },
      owner,
    )
  ).data;
  const invite = (
    await f.req("manage/invite", { vendor_id: v.id, role: "ADMIN" }, owner)
  ).data.invite;
  await f.req("join", {
    invite,
    email: "new@test.invalid",
    name: "DEMO",
    password: pass,
  });
  const seller = (
    await f.req("login", { email: "new@test.invalid", password: pass })
  ).cookie;
  const templates = await f.req(
    "manage/templates?vendor=" + v.id,
    undefined,
    seller,
  );
  assert.equal(templates.status, 200);
  assert.equal(templates.data.products.length, 36);
  const r = await f.req(
    "manage/new-product",
    {
      vendor_id: v.id,
      source_product_id: templates.data.products[0].id,
      names,
      stock: 7,
      price: 900,
    },
    seller,
  );
  assert.equal(r.status, 200);
  const products = (
    await f.req("manage/catalog?vendor=" + v.id, undefined, seller)
  ).data.products;
  assert.equal(products.length, 1);
  assert.equal(products[0].available, 7);
  assert.equal(products[0].cost, null);
  assert.equal(
    (
      await f.req(
        "manage/new-product",
        {
          vendor_id: v.id,
          source_product_id: "sweet-house--eclair",
          names,
          stock: 1,
          price: 500,
        },
        seller,
      )
    ).status,
    404,
  );
  f.db.close();
});
test("zero price products do not require a fictitious payment", async () => {
  const f = await fixture(),
    admin = await f.login("admin");
  f.db.sqlite
    .prepare("UPDATE products SET price=0 WHERE id=?")
    .run("sweet-house--eclair");
  const o = (
    await f.req("orders", {
      ...f.payload(),
      method: "transfer",
      expected_total: 0,
    })
  ).data;
  assert.equal(o.total, 0);
  assert.equal(o.payment, "PAID");
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM payments").get().n,
    0,
  );
  f.db.close();
});
