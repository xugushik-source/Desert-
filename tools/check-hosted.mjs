// Authorized owner-private demo QA only. Credentials arrive through hidden stdin, never arguments/files.
import readline from "node:readline";
import assert from "node:assert/strict";
console.log("Ready for hosted QA JSON on stdin (input must be hidden).");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const cfg = JSON.parse(
  await new Promise((resolve) => rl.once("line", resolve)),
);
rl.close();
process.stdin.pause();
const origin = new URL(cfg.origin).origin;
if (!origin.endsWith(".chatgpt.site")) throw Error("Unexpected QA origin");
const checks = [],
  members = [];
let ownerCookie,
  qaReady = false;
async function req(path, body, cookie = "", status = 200) {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/json",
      "X-Deserto-CSRF": "1",
      "OAI-Sites-Authorization": "Bearer " + cfg.service_token,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path === "/internal/setup"
        ? { Authorization: "Bearer " + cfg.setup_secret }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error(path + " did not return JSON; HTTP " + r.status);
  }
  assert.equal(r.status, status, path + ": " + JSON.stringify(data));
  return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] };
}
async function login(email, password) {
  return (await req("/api/login", { email, password })).cookie;
}
async function invite(role, label) {
  const token = (
      await req(
        "/api/manage/invite",
        { vendor_id: "sweet-house", role },
        ownerCookie,
      )
    ).data.invite,
    email = "demo-" + label + "-" + Date.now() + "@test.invalid",
    password = crypto.randomUUID() + crypto.randomUUID();
  await req("/api/join", {
    invite: token,
    email,
    name: "DEMO " + label,
    password,
  });
  const cookie = await login(email, password),
    u = (await req("/api/session", undefined, cookie)).data.user;
  members.push(u.id);
  return { cookie, id: u.id };
}
try {
  await req("/internal/setup", { qa_password: cfg.qa_password });
  qaReady = true;
  checks.push("Atomic demo seed in hosted D1");
  const health = (await req("/api/health")).data;
  assert.equal(health.database, true);
  assert.equal(health.bots, false);
  checks.push("Hosted Worker and D1 available; bots disabled");
  assert.equal((await req("/api/cities")).data.cities.length, 2);
  assert.equal((await req("/api/vendors?city=tbilisi")).data.vendors.length, 2);
  checks.push("Two cities and independent bakeries");
  ownerCookie = await login("qa@deserto.invalid", cfg.qa_password);
  const admin = await invite("ADMIN", "seller"),
    d1 = await invite("DRIVER", "driver1"),
    d2 = await invite("DRIVER", "driver2");
  await req(
    "/api/manage/catalog?vendor=cacao-atelier",
    undefined,
    admin.cookie,
    403,
  );
  checks.push("Seller cannot read another bakery cabinet");
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    payload = {
      idem: crypto.randomUUID(),
      vendor_id: "sweet-house",
      city_id: "akhalkalaki",
      items: [{ product_id: "sweet-house--eclair", qty: 1 }],
      fulfillment: "delivery",
      method: "cash",
      day,
      minute: 720,
      expected_total: 1000,
      customer: {
        name: "DEMO — НЕ ДОСТАВЛЯТЬ",
        phone: "+99500000000",
        address: "DEMO — НЕ ДОСТАВЛЯТЬ",
        comment: "Automated test only; no real customers or payments",
      },
    };
  let order = (await req("/api/orders", payload, "", 201)).data;
  const key = order.key,
    id = order.id;
  assert.equal((await req("/api/orders", payload, "", 201)).data.id, id);
  checks.push("Order persisted and idempotent retry returns same order");
  const refresh = async () => {
    order = (await req("/api/order/view", { id, key })).data;
  };
  const action = async (action, cookie, extra = {}) => {
    const b = {
      id,
      action,
      version: order.version,
      command_id: crypto.randomUUID(),
      ...extra,
    };
    await req("/api/manage/action", b, cookie);
    await refresh();
    return b;
  };
  await action("confirm", admin.cookie);
  await action("propose", admin.cookie, {
    items: [
      { product_id: "sweet-house--americano", qty: 2 },
      { product_id: "sweet-house--eclair", qty: 1 },
    ],
    reason: "DEMO replacement test",
  });
  assert.equal(order.total, 1000);
  assert.equal(order.proposal.total, 1600);
  await req("/api/order/approve", {
    id,
    key,
    version: order.version,
    proposal_id: order.proposal.id,
    approved: true,
  });
  await refresh();
  assert.equal(order.total, 1600);
  checks.push("Customer approves replacement before total changes");
  await action("prepare", admin.cookie);
  await action("ready", admin.cookie);
  const available = (
    await req("/api/manage/orders?vendor=sweet-house", undefined, d1.cookie)
  ).data.available.find((x) => x.id === id);
  assert.equal(available.customer, undefined);
  await action("claim", d1.cookie);
  await req(
    "/api/manage/action",
    {
      id,
      action: "claim",
      version: order.version,
      command_id: crypto.randomUUID(),
    },
    d2.cookie,
    409,
  );
  checks.push(
    "Assigned courier cannot be replaced by another courier; unassigned customer data private",
  );
  for (const a of ["pickup", "depart", "deliver"]) await action(a, d1.cookie);
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.payment, "UNPAID");
  checks.push("Courier pickup, departure and delivery; payment stays separate");
  const pay = await action("payment", admin.cookie, {
    amount: 400,
    reason: "DEMO fictitious partial payment, no real money",
  });
  assert.equal(order.payment, "PARTIAL");
  await req("/api/manage/action", pay, admin.cookie);
  await refresh();
  assert.equal(order.paid, 400);
  await action("payment", admin.cookie, {
    amount: 1200,
    reason: "DEMO fictitious remaining payment, no real money",
  });
  assert.equal(order.payment, "PAID");
  checks.push("Partial payment, replay protection and final verification");
  const summary = (
    await req("/api/manage/summary?vendor=sweet-house", undefined, admin.cookie)
  ).data;
  assert.ok(summary.revenue >= 1600);
  assert.equal(summary.gross_profit, null);
  checks.push("Revenue updates; unknown costs do not create imaginary profit");
  const second = {
    ...payload,
    idem: crypto.randomUUID(),
    vendor_id: "cacao-atelier",
    city_id: "tbilisi",
    fulfillment: "pickup",
    items: [{ product_id: "cacao-atelier--eclair", qty: 1 }],
    expected_total: 550,
  };
  const o2 = (await req("/api/orders", second, "", 201)).data;
  await req(
    "/api/manage/action",
    {
      id: o2.id,
      version: o2.version,
      action: "cancel",
      reason: "DEMO test cleanup",
      command_id: crypto.randomUUID(),
    },
    ownerCookie,
  );
  checks.push(
    "Second bakery accepts a separate order; cancellation releases its reservation",
  );
  for (const uid of members)
    await req(
      "/api/manage/revoke",
      { vendor_id: "sweet-house", user_id: uid },
      ownerCookie,
    );
  console.log(
    JSON.stringify(
      {
        ok: true,
        origin,
        order_id: id,
        checks,
        customer_data: "DEMO ONLY",
        external_messages: 0,
        real_payments: 0,
      },
      null,
      2,
    ),
  );
} finally {
  if (qaReady) {
    await req("/internal/setup", { action: "close-qa" });
    console.log("Temporary QA owner disabled; QA sessions removed.");
  }
}
