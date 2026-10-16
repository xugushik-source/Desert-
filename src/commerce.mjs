import { listPromotions, orderEconomics } from "./marketplace.mjs";
import {
  fail,
  integer,
  text,
  uuid,
  now,
  sha,
  jsonParse,
  permit,
  constant,
} from "./security.mjs";
const q = (db, sql, ...params) => db.prepare(sql).bind(...params);
const guard = (db) =>
  db.prepare("INSERT INTO write_guards(value) VALUES(changes())");
export function localClock(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date),
    v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: `${v.year}-${v.month}-${v.day}`,
    minute: Number(v.hour) * 60 + Number(v.minute),
  };
}
export async function vendorRecord(db, id) {
  const v = await q(
    db,
    "SELECT v.*,c.timezone,c.currency,c.active AS city_active FROM vendors v JOIN cities c ON c.id=v.city_id WHERE v.id=?",
    id,
  ).first();
  if (!v) fail("NOT_FOUND", 404);
  return v;
}
export function vendorPublic(v) {
  return {
    id: v.id,
    city_id: v.city_id,
    slug: v.slug,
    names: jsonParse(v.names, {}),
    description: jsonParse(v.description, {}),
    address: v.address,
    phone: v.phone,
    demo: !!v.demo,
    delivery_enabled: !!v.delivery_enabled,
    delivery_fee: v.delivery_fee,
    lead_minutes: v.lead_minutes,
    open_minute: v.open_minute,
    close_minute: v.close_minute,
    slot_capacity: v.slot_capacity,
    currency: v.currency,
    timezone: v.timezone,
    active: !!v.active,
  };
}
export function productPublic(p, admin = false) {
  const value = {
    id: p.id,
    vendor_id: p.vendor_id,
    names: jsonParse(p.names, {}),
    description: jsonParse(p.description, {}),
    category: p.category,
    image: p.image,
    price: p.price,
    available: Math.max(0, p.stock - p.reserved),
    active: !!p.active,
    lead_minutes: p.lead_minutes,
    options: jsonParse(p.options, []),
    allergens: jsonParse(p.allergens, []),
  };
  if (admin)
    Object.assign(value, {
      stock: p.stock,
      reserved: p.reserved,
      cost: p.cost,
      version: p.version,
    });
  return value;
}
export async function catalog(db, id, admin = false) {
  const v = await vendorRecord(db, id);
  if (!admin && (!v.active || !v.city_active)) fail("NOT_FOUND", 404);
  const rows = (
    await q(
      db,
      "SELECT * FROM products WHERE vendor_id=? " +
        (admin ? "" : "AND active=1") +
        " ORDER BY category,id",
      id,
    ).all()
  ).results;
  const {promotions}=await listPromotions(db,id);
  return {
    vendor: vendorPublic(v),
    products: rows.map((p) => ({...productPublic(p, admin), promotion:promotions.find(x=>x.product_id===p.id)||null})),
  };
}
function validateDay(v, day) {
  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day + "T12:00:00Z"))
  )
    fail("INVALID_SLOT");
  const clock = localClock(v.timezone),
    max = new Date(Date.parse(clock.day + "T12:00:00Z") + 14 * 86400000)
      .toISOString()
      .slice(0, 10);
  if (day < clock.day || day > max) fail("INVALID_SLOT");
  return clock;
}
export function slotInstant(timezone, day, minute) {
  const target = Date.parse(day + "T00:00:00Z") + minute * 60000;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const c = localClock(timezone, new Date(guess));
    const rendered = Date.parse(c.day + "T00:00:00Z") + c.minute * 60000;
    guess += target - rendered;
  }
  const check = localClock(timezone, new Date(guess));
  if (check.day !== day || check.minute !== minute) fail("INVALID_SLOT", 409);
  return guess;
}
function validateSlot(v, day, minute, lead) {
  validateDay(v, day);
  integer(minute, 0, 1439);
  if (
    minute % 30 ||
    minute < v.open_minute ||
    minute >= v.close_minute ||
    slotInstant(v.timezone, day, minute) < Date.now() + lead * 60000
  )
    fail("INVALID_SLOT", 409);
}
export async function slots(db, vendor, day, lead = 0) {
  const v = await vendorRecord(db, vendor);
  if (!v.active || !v.city_active) fail("NOT_FOUND", 404);
  validateDay(v, day);
  const used = (
    await q(
      db,
      "SELECT minute,capacity,reserved FROM slots WHERE vendor_id=? AND day=?",
      vendor,
      day,
    ).all()
  ).results;
  const result = [];
  for (
    let minute = Math.ceil(v.open_minute / 30) * 30;
    minute < v.close_minute;
    minute += 30
  ) {
    try {
      validateSlot(v, day, minute, Math.max(v.lead_minutes, lead));
      const row = used.find((r) => r.minute === minute);
      result.push({
        minute,
        available: Math.max(
          0,
          (row?.capacity || v.slot_capacity) - (row?.reserved || 0),
        ),
      });
    } catch {}
  }
  return result;
}
export async function orderKey(env, id) {
  if (!env.RECOVERY_SECRET || env.RECOVERY_SECRET.length < 32)
    fail("SERVER_CONFIG", 503);
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(env.RECOVERY_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode("deserto-order:" + id),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
async function priceLines(db, vendor, items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30)
    fail("INVALID_ITEMS");
  const lines = [],
    counts = new Map(),
    versions = new Map();
  for (const row of items) {
    const p = await q(
      db,
      "SELECT * FROM products WHERE id=? AND vendor_id=? AND active=1",
      row.product_id,
      vendor,
    ).first();
    if (!p) fail("PRODUCT_UNAVAILABLE", 409);
    versions.set(p.id, p.version);
    const qty = integer(row.qty, 1, 20),
      options = row.options || [];
    if (!Array.isArray(options) || options.length > 5) fail("INVALID_OPTIONS");
    const defs = jsonParse(p.options, []),
      chosen = [],
      seen = new Set();
    let price = p.price;
    for (const value of options) {
      if (typeof value !== "string" || seen.has(value)) fail("INVALID_OPTIONS");
      const option = defs.find((x) => x.id === value);
      if (!option) fail("INVALID_OPTIONS");
      seen.add(value);
      price += option.delta;
      chosen.push(value);
    }
    chosen.sort();
    const campaign=await q(db,"SELECT * FROM promotions WHERE product_id=? AND state='ACTIVE'",p.id).first();
    if(campaign && (p.price!==campaign.sale_price || options.length)) fail("PRICE_CHANGED",409);
    const gift=campaign?.kind==='GIFT' ? " [Подарок: "+(jsonParse(campaign.gift,{}).ru||'')+"]" : '';
    const rawNote=row.note===undefined?'':row.note;
    const baseNote=gift && typeof rawNote==='string' && rawNote.endsWith(gift)?rawNote.slice(0,-gift.length):rawNote;
    const note = text(baseNote,120)+gift,
      key = JSON.stringify([p.id, chosen, note]);
    const existing = lines.find((l) => l.key === key);
    if (existing) {
      existing.qty += qty;
      integer(existing.qty, 1, 20);
    } else
      lines.push({
        key,
        product_id: p.id,
        vendor_id: vendor,
        title: p.names,
        qty,
        price,
        cost: p.cost,
        options: chosen,
        note,
        lead_minutes: p.lead_minutes,
      });
    counts.set(p.id, (counts.get(p.id) || 0) + qty);
    if (counts.get(p.id) > p.stock - p.reserved) fail("OUT_OF_STOCK", 409);
  }
  return {
    lines,
    counts,
    versions,
    total: lines.reduce((a, l) => a + l.price * l.qty, 0),
    lead: Math.max(...lines.map((l) => l.lead_minutes)),
  };
}
function customerData(b, fulfillment) {
  const c = b || {},
    result = {
      name: text(c.name, 80, true),
      phone: text(c.phone, 40, true),
      address: text(c.address || "", 300, fulfillment === "delivery"),
      recipient: text(c.recipient || "", 80),
      recipient_phone: text(c.recipient_phone || "", 40),
      comment: text(c.comment || "", 500),
      surprise: c.surprise === true,
    };
  if (
    !/^[+0-9 ()-]{5,40}$/.test(result.phone) ||
    (result.recipient_phone &&
      !/^[+0-9 ()-]{5,40}$/.test(result.recipient_phone))
  )
    fail("INVALID_PHONE");
  return result;
}
const addEvent = (db, statements, id, actor, event, data = {}) => {
  const eventId = uuid(),
    at = now();
  statements.push(
    q(
      db,
      "INSERT INTO order_events(id,order_id,at,actor,event,data) VALUES(?,?,?,?,?,?)",
      eventId,
      id,
      at,
      actor,
      event,
      JSON.stringify(data),
    ),
    q(
      db,
      "INSERT INTO outbox(id,order_id,event,at) VALUES(?,?,?,?)",
      eventId,
      id,
      event,
      at,
    ),
  );
};
export async function orderView(db, id, { key, user } = {}) {
  const o = await q(db, "SELECT * FROM orders WHERE id=?", id).first();
  if (!o) fail("NOT_FOUND", 404);
  let role = "CUSTOMER";
  if (key) {
    if (!constant(o.key_hash, await sha(key))) fail("NOT_FOUND", 404);
  } else {
    role = permit(user, o.vendor_id, ["ADMIN", "STAFF", "DRIVER"]);
    if (role === "DRIVER" && o.driver_id !== user.id) fail("FORBIDDEN", 403);
  }
  const lines = (
    await q(
      db,
      "SELECT * FROM order_items WHERE order_id=? ORDER BY product_id",
      id,
    ).all()
  ).results;
  const events = (
    await q(
      db,
      "SELECT * FROM order_events WHERE order_id=? ORDER BY at,id",
      id,
    ).all()
  ).results;
  const vendor = await vendorRecord(db, o.vendor_id);
  const out = {
    id: o.id,
    vendor_id: o.vendor_id,
    vendor: vendorPublic(vendor),
    city_id: o.city_id,
    created_at: o.created_at,
    status: o.status,
    payment: o.payment,
    method: o.method,
    fulfillment: o.fulfillment,
    day: o.day,
    minute: o.minute,
    currency: o.currency,
    total: o.total,
    items_total: o.items_total,
    delivery_fee: o.delivery_fee,
    paid: o.paid,
    version: o.version,
    driver_id: o.driver_id,
    customer: jsonParse(o.customer),
    items: lines.map((l) => ({
      product_id: l.product_id,
      title: jsonParse(l.title),
      qty: l.qty,
      price: l.price,
      options: jsonParse(l.options),
      note: l.note,
    })),
    events: events.map((e) => ({
      at: e.at,
      event: e.event,
      ...(role === "CUSTOMER" ? {} : { actor: e.actor }),
      data: jsonParse(e.data),
    })),
    proposal: jsonParse(o.proposal),
  };
  if (out.proposal) delete out.proposal.actor;
  return out;
}
export async function createOrder(env, b) {
  const db = env.DB;
  const idem = text(b.idem, 80, true);
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(idem)) fail("INVALID_IDEMPOTENCY");
  const v = await vendorRecord(db, text(b.vendor_id, 80, true));
  if (!v.active || !v.city_active) fail("NOT_FOUND", 404);
  if (b.city_id !== v.city_id) fail("CITY_MISMATCH", 409);
  if (
    !["cash", "transfer"].includes(b.method) ||
    !["pickup", "delivery"].includes(b.fulfillment)
  )
    fail("INVALID_INPUT");
  if (b.fulfillment === "delivery" && !v.delivery_enabled)
    fail("DELIVERY_UNAVAILABLE", 409);
  const customer = customerData(b.customer, b.fulfillment),
    fp = await sha(
      JSON.stringify({
        vendor: v.id,
        city: b.city_id,
        items: b.items,
        method: b.method,
        fulfillment: b.fulfillment,
        day: b.day,
        minute: b.minute,
        expected_total: b.expected_total,
        customer,
      }),
    );
  let prior = await q(
    db,
    "SELECT id,fingerprint FROM orders WHERE idem=?",
    idem,
  ).first();
  if (prior) {
    if (prior.fingerprint !== fp) fail("IDEMPOTENCY_CONFLICT", 409);
    return {
      ...(await orderView(db, prior.id, {
        key: await orderKey(env, prior.id),
      })),
      key: await orderKey(env, prior.id),
    };
  }
  const priced = await priceLines(db, v.id, b.items);
  validateSlot(v, b.day, b.minute, Math.max(v.lead_minutes, priced.lead));
  const expected =
    priced.total + (b.fulfillment === "delivery" ? v.delivery_fee : 0);
  if (integer(b.expected_total) !== expected) fail("PRICE_CHANGED", 409);
  const pricingCheck=await orderEconomics(db,v,priced.total,b.fulfillment==='delivery'?v.delivery_fee:0,priced.lines);
  const id = "DS-" + uuid().replaceAll("-", "").slice(0, 16).toUpperCase(),
    key = await orderKey(env, id),
    at = now(),
    delivery = b.fulfillment === "delivery" ? v.delivery_fee : 0;
  const statements = [
    q(
      db,
      "INSERT INTO slots(vendor_id,day,minute,capacity,reserved) VALUES(?,?,?,?,0) ON CONFLICT DO NOTHING",
      v.id,
      b.day,
      b.minute,
      v.slot_capacity,
    ),
    q(
      db,
      "UPDATE slots SET reserved=reserved+1 WHERE vendor_id=? AND day=? AND minute=?",
      v.id,
      b.day,
      b.minute,
    ),
  ];
  if(pricingCheck) statements.push(q(db,'UPDATE vendor_terms SET version=version WHERE vendor_id=? AND version=?',v.id,pricingCheck.terms_version),guard(db));
  for (const [pid, qty] of priced.counts)
    statements.push(
      q(
        db,
        "UPDATE products SET reserved=reserved+? WHERE id=? AND vendor_id=? AND active=1 AND version=?",
        qty,
        pid,
        v.id,
        priced.versions.get(pid),
      ),
      guard(db),
    );
  statements.push(
    q(
      db,
      "INSERT INTO orders(id,vendor_id,city_id,created_at,updated_at,method,fulfillment,day,minute,currency,items_total,delivery_fee,total,customer,key_hash,idem,fingerprint,original_items,payment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      v.id,
      v.city_id,
      at,
      at,
      b.method,
      b.fulfillment,
      b.day,
      b.minute,
      v.currency,
      priced.total,
      delivery,
      priced.total + delivery,
      JSON.stringify(customer),
      await sha(key),
      idem,
      fp,
      JSON.stringify(priced.lines),
      expected === 0 ? "PAID" : "UNPAID",
    ),
  );
  if(pricingCheck) statements.push(q(db,'INSERT INTO order_pricing_checks(order_id,vendor_id,terms_version,revenue,expenses,net,required_net) VALUES(?,?,?,?,?,?,?)',id,v.id,pricingCheck.terms_version,expected,JSON.stringify(pricingCheck.expenses),pricingCheck.net,pricingCheck.required_net));
  for (const l of priced.lines)
    statements.push(
      q(
        db,
        "INSERT INTO order_items(order_id,vendor_id,product_id,title,qty,price,cost,options,note) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        v.id,
        l.product_id,
        l.title,
        l.qty,
        l.price,
        l.cost,
        JSON.stringify(l.options),
        l.note,
      ),
    );
  addEvent(db, statements, id, "CUSTOMER", "CREATED");
  statements.push(db.prepare("DELETE FROM write_guards"));
  try {
    await db.batch(statements);
  } catch (e) {
    prior = await q(
      db,
      "SELECT id,fingerprint FROM orders WHERE idem=?",
      idem,
    ).first();
    if (prior && prior.fingerprint === fp)
      return {
        ...(await orderView(db, prior.id, {
          key: await orderKey(env, prior.id),
        })),
        key: await orderKey(env, prior.id),
      };
    if (prior) fail("IDEMPOTENCY_CONFLICT", 409);
    if (/CHECK|constraint/i.test(e.message)) fail("CAPACITY_CHANGED", 409);
    throw e;
  }
  return { ...(await orderView(db, id, { key })), key };
}
export async function orderList(db, user, vendor) {
  const role = permit(user, vendor, ["ADMIN", "STAFF", "DRIVER"]);
  const rows = (
    await q(
      db,
      "SELECT id,driver_id,status,fulfillment,day,minute,total,currency,version FROM orders WHERE vendor_id=? ORDER BY created_at DESC LIMIT 100",
      vendor,
    ).all()
  ).results;
  if (role === "DRIVER") {
    const own = rows.filter((o) => o.driver_id === user.id);
    return {
      orders: await Promise.all(own.map((o) => orderView(db, o.id, { user }))),
      available: rows
        .filter(
          (o) =>
            !o.driver_id &&
            o.fulfillment === "delivery" &&
            o.status === "READY",
        )
        .map((o) => ({
          id: o.id,
          day: o.day,
          minute: o.minute,
          version: o.version,
        })),
    };
  }
  return {
    orders: await Promise.all(rows.map((o) => orderView(db, o.id, { user }))),
    available: [],
  };
}
export async function action(env, b, user) {
  const db = env.DB,
    id = text(b.id, 80, true),
    o = await q(db, "SELECT * FROM orders WHERE id=?", id).first();
  if (!o) fail("NOT_FOUND", 404);
  const role = permit(user, o.vendor_id, ["ADMIN", "STAFF", "DRIVER"]),
    command = text(b.command_id, 80, true);
  if (!/^[\w-]{20,80}$/.test(command)) fail("INVALID_IDEMPOTENCY");
  const fp = await sha(JSON.stringify([user.id, b])),
    prior = await q(db, "SELECT * FROM commands WHERE id=?", command).first();
  if (prior) {
    if (prior.fingerprint !== fp || prior.actor !== user.id)
      fail("IDEMPOTENCY_CONFLICT", 409);
    return jsonParse(prior.result);
  }
  const version = integer(b.version),
    statements = [],
    reason = text(b.reason || "", 300);
  if (version !== o.version) fail("STALE_VERSION", 409);
  const manager = role !== "DRIVER";
  let next = o.status,
    payment = o.payment,
    driver = o.driver_id;
  const transitions = {
    confirm: ["NEW", "CONFIRMED"],
    prepare: ["CONFIRMED", "PREPARING"],
    ready: ["PREPARING", "READY"],
    pickup: ["READY", "PICKED_UP"],
    depart: ["PICKED_UP", "OUT_FOR_DELIVERY"],
    deliver: ["OUT_FOR_DELIVERY", "COMPLETED"],
    handover: ["READY", "COMPLETED"],
  };
  if (b.action === "claim") {
    if (
      o.fulfillment !== "delivery" ||
      o.status !== "READY" ||
      (driver && driver !== user.id)
    )
      fail("NOT_AVAILABLE", 409);
    driver = user.id;
  } else if (b.action === "cancel") {
    if (
      !manager ||
      !reason ||
      ["COMPLETED", "CANCELLED", "PICKED_UP", "OUT_FOR_DELIVERY"].includes(
        o.status,
      )
    )
      fail("INVALID_TRANSITION", 409);
    next = "CANCELLED";
    if (o.paid > 0) payment = "REFUND_REVIEW";
    const rows = (
      await q(
        db,
        "SELECT product_id,qty FROM order_items WHERE order_id=?",
        id,
      ).all()
    ).results;
    for (const l of rows) {
      const made = ["PREPARING", "READY"].includes(o.status);
      statements.push(
        q(
          db,
          "UPDATE products SET reserved=reserved-?,stock=stock-? WHERE id=?",
          l.qty,
          made ? l.qty : 0,
          l.product_id,
        ),
        guard(db),
      );
      if (made)
        statements.push(
          q(
            db,
            "INSERT INTO inventory_movements(id,product_id,at,actor,delta,reason) VALUES(?,?,?,?,?,?)",
            uuid(),
            l.product_id,
            now(),
            user.id,
            -l.qty,
            "CANCELLED_AFTER_PREPARATION: " + reason,
          ),
        );
    }
    statements.push(
      q(
        db,
        "UPDATE slots SET reserved=reserved-1 WHERE vendor_id=? AND day=? AND minute=?",
        o.vendor_id,
        o.day,
        o.minute,
      ),
    );
  } else if (transitions[b.action]) {
    const [from, to] = transitions[b.action];
    if (o.status !== from) fail("INVALID_TRANSITION", 409);
    if (["pickup", "depart", "deliver"].includes(b.action)) {
      if (o.fulfillment !== "delivery" || o.driver_id !== user.id)
        fail("NOT_ASSIGNED", 403);
    } else if (!manager) fail("FORBIDDEN", 403);
    if (b.action === "handover" && o.fulfillment !== "pickup")
      fail("INVALID_TRANSITION", 409);
    if (
      ["pickup", "handover"].includes(b.action) &&
      o.method === "transfer" &&
      o.payment !== "PAID"
    )
      fail("PAYMENT_REQUIRED", 409);
    next = to;
    if (to === "COMPLETED") {
      for (const l of (
        await q(
          db,
          "SELECT product_id,qty FROM order_items WHERE order_id=?",
          id,
        ).all()
      ).results)
        statements.push(
          q(
            db,
            "UPDATE products SET stock=stock-?,reserved=reserved-? WHERE id=?",
            l.qty,
            l.qty,
            l.product_id,
          ),
          guard(db),
        );
    }
  } else if (b.action === "payment") {
    if (
      !manager ||
      !reason ||
      ["CANCELLED", "NEW", "AWAITING_APPROVAL"].includes(o.status)
    )
      fail("INVALID_TRANSITION", 409);
    const amount = integer(b.amount, 1, o.total - o.paid);
    payment = o.paid + amount === o.total ? "PAID" : "PARTIAL";
    statements.push(
      q(
        db,
        "UPDATE orders SET paid=paid+? WHERE id=? AND version=?",
        amount,
        id,
        version,
      ),
      guard(db),
      q(
        db,
        "INSERT INTO payments(id,order_id,at,actor,amount,currency,reason,command) VALUES(?,?,?,?,?,?,?,?)",
        uuid(),
        id,
        now(),
        user.id,
        amount,
        o.currency,
        reason,
        command,
      ),
    );
  } else if (b.action === "propose") {
    if (!manager || !reason || !["NEW", "CONFIRMED"].includes(o.status))
      fail("INVALID_TRANSITION", 409);
    const existing = (
        await q(
          db,
          "SELECT product_id,qty FROM order_items WHERE order_id=?",
          id,
        ).all()
      ).results,
      credits = new Map();
    for (const l of existing)
      credits.set(l.product_id, (credits.get(l.product_id) || 0) + l.qty);
    const priced = await priceReplacement(db, o.vendor_id, b.items, credits);
    next = "AWAITING_APPROVAL";
    const proposal = {
      id: uuid(),
      items: priced.lines.map((l) => ({
        product_id: l.product_id,
        title: jsonParse(l.title),
        qty: l.qty,
        options: l.options,
        note: l.note,
      })),
      total: priced.total + o.delivery_fee,
      reason,
      actor: user.id,
      at: now(),
    };
    statements.push(
      q(
        db,
        "UPDATE orders SET proposal=?,previous_status=? WHERE id=? AND version=?",
        JSON.stringify(proposal),
        o.status,
        id,
        version,
      ),
      guard(db),
    );
  } else fail("INVALID_ACTION");
  const result = { ok: true, id, status: next, version: version + 1 };
  statements.push(
    q(
      db,
      "UPDATE orders SET status=?,payment=?,driver_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status=?",
      next,
      payment,
      driver,
      now(),
      id,
      version,
      o.status,
    ),
    guard(db),
  );
  addEvent(db, statements, id, user.id, b.action.toUpperCase(), {
    reason,
    ...(b.action === "payment" ? { amount: b.amount } : {}),
  });
  statements.push(
    q(
      db,
      "INSERT INTO commands(id,actor,fingerprint,result) VALUES(?,?,?,?)",
      command,
      user.id,
      fp,
      JSON.stringify(result),
    ),
    db.prepare("DELETE FROM write_guards"),
  );
  try {
    await db.batch(statements);
  } catch (e) {
    const replay = await q(
      db,
      "SELECT * FROM commands WHERE id=?",
      command,
    ).first();
    if (replay?.fingerprint === fp && replay.actor === user.id)
      return jsonParse(replay.result);
    if (/CHECK|UNIQUE/i.test(e.message)) fail("STALE_VERSION", 409);
    throw e;
  }
  return result;
}
export async function approve(env, b) {
  const db = env.DB,
    key = text(b.key, 100, true),
    view = await orderView(db, b.id, { key }),
    o = await q(db, "SELECT * FROM orders WHERE id=?", b.id).first();
  if (
    o.status !== "AWAITING_APPROVAL" ||
    o.version !== b.version ||
    o.proposal === null
  )
    fail("STALE_VERSION", 409);
  const proposal = jsonParse(o.proposal);
  if (proposal.id !== b.proposal_id || typeof b.approved !== "boolean")
    fail("INVALID_INPUT");
  const statements = [];
  let total = o.total,
    items = o.items_total,
    payment = o.payment;
  if (b.approved) {
    const old = (
      await q(
        db,
        "SELECT product_id,qty FROM order_items WHERE order_id=?",
        o.id,
      ).all()
    ).results;
    for (const l of old)
      statements.push(
        q(
          db,
          "UPDATE products SET reserved=reserved-? WHERE id=?",
          l.qty,
          l.product_id,
        ),
        guard(db),
      );
    // Quote against available stock plus this order's own reservations.
    const credits = new Map();
    for (const l of old)
      credits.set(l.product_id, (credits.get(l.product_id) || 0) + l.qty);
    const priced = await priceReplacement(
      db,
      o.vendor_id,
      proposal.items,
      credits,
    );
    if (priced.total + o.delivery_fee !== proposal.total)
      fail("PRICE_CHANGED", 409);
    const v = await vendorRecord(db, o.vendor_id);
    const economicsCheck=await orderEconomics(db,v,priced.total,o.delivery_fee,priced.lines);
    if(economicsCheck)statements.push(q(db,'UPDATE vendor_terms SET version=version WHERE vendor_id=? AND version=?',v.id,economicsCheck.terms_version),guard(db),q(db,'INSERT INTO order_pricing_checks(order_id,vendor_id,terms_version,revenue,expenses,net,required_net) VALUES(?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET terms_version=excluded.terms_version,revenue=excluded.revenue,expenses=excluded.expenses,net=excluded.net,required_net=excluded.required_net',o.id,v.id,economicsCheck.terms_version,priced.total+o.delivery_fee,JSON.stringify(economicsCheck.expenses),economicsCheck.net,economicsCheck.required_net));
    validateSlot(v, o.day, o.minute, Math.max(v.lead_minutes, priced.lead));
    for (const [pid, qty] of priced.counts)
      statements.push(
        q(
          db,
          "UPDATE products SET reserved=reserved+? WHERE id=? AND active=1 AND version=?",
          qty,
          pid,
          priced.versions.get(pid),
        ),
        guard(db),
      );
    statements.push(q(db, "DELETE FROM order_items WHERE order_id=?", o.id));
    for (const l of priced.lines)
      statements.push(
        q(
          db,
          "INSERT INTO order_items(order_id,vendor_id,product_id,title,qty,price,cost,options,note) VALUES(?,?,?,?,?,?,?,?,?)",
          o.id,
          o.vendor_id,
          l.product_id,
          l.title,
          l.qty,
          l.price,
          l.cost,
          JSON.stringify(l.options),
          l.note,
        ),
      );
    items = priced.total;
    total = items + o.delivery_fee;
    if (o.paid > total) payment = "REFUND_REVIEW";
    else
      payment = o.paid === total ? "PAID" : o.paid > 0 ? "PARTIAL" : "UNPAID";
  }
  statements.push(
    q(
      db,
      "UPDATE orders SET status=?,proposal=NULL,previous_status=NULL,items_total=?,total=?,payment=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status=?",
      o.previous_status,
      items,
      total,
      payment,
      now(),
      o.id,
      b.version,
      "AWAITING_APPROVAL",
    ),
    guard(db),
  );
  addEvent(
    db,
    statements,
    o.id,
    "CUSTOMER",
    b.approved ? "PROPOSAL_APPROVED" : "PROPOSAL_REJECTED",
    { proposal_id: proposal.id },
  );
  statements.push(db.prepare("DELETE FROM write_guards"));
  try {
    await db.batch(statements);
  } catch (e) {
    if (/CHECK|constraint/i.test(e.message)) fail("CAPACITY_CHANGED", 409);
    throw e;
  }
  return orderView(db, o.id, { key });
}
async function priceReplacement(db, vendor, items, credits) {
  const proxy = {
    prepare(sql) {
      let stmt = db.prepare(sql);
      return {
        bind(...params) {
          stmt = stmt.bind(...params);
          return this;
        },
        async first() {
          const p = await stmt.first();
          if (p && p.stock !== undefined)
            p.reserved = Math.max(0, p.reserved - (credits.get(p.id) || 0));
          return p;
        },
      };
    },
  };
  return priceLines(proxy, vendor, items);
}
