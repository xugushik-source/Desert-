import {extraWords, expenseKeys, eventCart} from "./marketplace.js";
import { words, categories, states } from "./i18n.js";
for (const l of ['ru','ka','en']) Object.assign(words[l],extraWords[l]);
const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const storage = {
  get(k, f) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? f;
    } catch {
      return f;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      toast(t("network"));
      return false;
    }
  },
};
const state = {
  lang: storage.get("deserto-language", "ru"),
  city: storage.get("deserto-city", ""),
  cities: [],
  vendors: [],
  vendor: null,
  products: [],
  cart: [],
  category: "all",
  query: "",
  user: null,
  adminVendors: [],
  adminVendor: "",
  adminTab: "manageOrders",
  orders: [],
  view: "home",
  undo: null,
};
if (!words[state.lang]) state.lang = "ru";
const t = (k) => words[state.lang][k] || words.ru[k] || k,
  names = (n) => n?.[state.lang] || n?.ru || n?.en || "",
  status = (s) => states[state.lang][s] || t("status"),
  cat = (c) => categories[state.lang][c] || c;
const money = (amount, currency = state.vendor?.currency || "GEL") =>
  new Intl.NumberFormat({ ru: "ru-RU", ka: "ka-GE", en: "en-GB" }[state.lang], {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount / 100);
const clock = (m) =>
    String(Math.floor(m / 60)).padStart(2, "0") +
    ":" +
    String(m % 60).padStart(2, "0"),
  minute = (s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
function dayAt(timezone = "Asia/Tbilisi", offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("on"), 4500);
}
function error(e) {
  if(["COSTS_REQUIRED","MARGIN_BELOW_MINIMUM","PROMOTION_OPTIONS"].includes(e.code)) return t("promoIssue");
  if(e.code==="PROMOTION_ACTIVE") return t("promoUnavailable");
  return (
    {
      LOGIN_FAILED: t("loginError"),
      LOGIN_REQUIRED: t("loginError"),
      PRICE_CHANGED: t("priceChanged"),
      STALE_VERSION: t("stale"),
      OUT_OF_STOCK: t("stockError"),
      CAPACITY_CHANGED: t("stockError"),
      INVALID_SLOT: t("stockError"),
      FORBIDDEN: t("denied"),
      INVALID_INPUT: t("checkFields"),
      INVALID_PHONE: t("checkFields"),
      PASSWORD_TOO_SHORT: t("joinHint"),
      CANNOT_REVOKE_SELF: t("revokeSelf"),
      NETWORK: t("network"),
    }[e.code] || t("genericError")
  );
}
async function api(path, body) {
  let r;
  try {
    r = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Deserto-CSRF": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw { code: "NETWORK" };
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw { code: "NETWORK" };
  }
  if (!r.ok) throw { code: data.error, status: r.status };
  return data;
}
const busy =
  (fn) =>
  async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      toast(error(e));
    }
  };
function header() {
  document.documentElement.lang = state.lang;
  $("language").value = state.lang;
  $("demo").textContent = t("demo");
  $("brand-caption").textContent = t("caption");
  $("city-label").textContent = t("city");
  $("my-orders").textContent = t("orders");
  $("cabinet").textContent = t("cabinet");
  $("footer-text").textContent = t("footer");
  $("credits").textContent = t("credits");
  $("city").innerHTML = state.cities
    .map((c) => `<option value="${esc(c.id)}">${esc(names(c.names))}</option>`)
    .join("");
  $("city").value = state.city;
}
function reveal() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !("IntersectionObserver" in window)) return;
  document.body.classList.add("motion");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          io.unobserve(e.target);
        }
    },
    { rootMargin: "80px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight + 80)
      el.classList.add("visible");
    else io.observe(el);
  });
  setTimeout(
    () =>
      document
        .querySelectorAll(".reveal")
        .forEach((el) => el.classList.add("visible")),
    2200,
  );
}
function vendorPhoto(v) {
  return v.id === "cacao-atelier"
    ? "/media/choco-slice.jpg"
    : v.id === "sweet-house-tbilisi"
      ? "/media/croissant.jpg"
      : "/media/medovik-slice.jpg";
}
async function home() {
  state.view = "home";
  state.vendor = null;
  state.products = [];
  state.cart = [];
  const data = await api("vendors?city=" + encodeURIComponent(state.city));
  state.vendors = data.vendors;
  header();
  $("main").innerHTML =
    `<section class="hero"><div><div class="eyebrow">${t("local")}</div><h1><span class="mask"><span>${t("hero1")}</span></span><span class="mask"><span><em>${t("hero2")}</em></span></span></h1><p>${t("heroText")}</p><div class="actions"><button class="primary" data-act="occasion">${t("occasionOpen")}</button><button class="secondary" data-act="explore">${t("explore")}</button></div></div><div class="hero-visual reveal"><img src="/media/red-velvet-slice.jpg" alt="${esc(cat("torty-kusok"))}" fetchpriority="high" width="500" height="550"><span class="hero-stamp">Deserto — ${esc(names(state.cities.find((c) => c.id === state.city)?.names))}</span></div></section><section class="section" id="shops"><div class="section-top"><div><div class="eyebrow">${esc(names(state.cities.find((c) => c.id === state.city)?.names))}</div><h2>${t("shops")}</h2></div><p class="muted small">${t("ranking")}</p></div><div class="occasion-banner"><h2>${t("occasion")}</h2><p>${t("occasionText")}</p><div class="actions">${["birthday","holiday","celebration"].map(k=>`<button class="chip" data-occasion="${k}">${t(k)}</button>`).join("")}</div></div><div class="vendor-grid">${state.vendors.map((v) => `<article class="vendor-card reveal"><a href="#vendor=${encodeURIComponent(v.id)}&city=${encodeURIComponent(v.city_id)}"><div class="vendor-photo"><img src="${vendorPhoto(v)}" alt="${esc(names(v.names))}" loading="lazy" width="500" height="400"></div><span class="pill">${t("testShop")}</span><h3>${esc(names(v.names))}</h3><p>${esc(names(v.description))}</p><div class="vendor-bottom"><span class="small">${clock(v.open_minute)}–${clock(v.close_minute)}</span><span class="secondary">${t("openShop")}</span></div></a></article>`).join("") || `<p class="empty">${t("empty")}</p>`}</div></section><section class="manifesto"><h2>${t("storyTitle")}</h2><p>${t("storyText")}</p></section>`;
  cartbar();
  reveal();
}
function cartKey() {
  return "deserto-cart:" + state.vendor.id;
}
function readCart() {
  const stored = storage.get(cartKey(), []);
  state.cart = Array.isArray(stored)
    ? stored
        .filter(
          (l) =>
            state.products.some((p) => p.id === l.product_id) &&
            Number.isInteger(l.qty) &&
            l.qty > 0 &&
            l.qty <= 20 &&
            Array.isArray(l.options) &&
            l.options.every((o) => typeof o === "string") &&
            typeof l.note === "string",
        )
        .slice(0, 30)
    : [];
}
const product = (id) => state.products.find((p) => p.id === id),
  linePrice = (l) => {
    const p = product(l.product_id);
    return p
      ? p.price +
          (l.options || []).reduce(
            (a, id) => a + (p.options.find((o) => o.id === id)?.delta || 0),
            0,
          )
      : 0;
  },
  sum = () => state.cart.reduce((a, l) => a + linePrice(l) * l.qty, 0);
function saveCart() {
  storage.set(cartKey(), state.cart);
  cartbar();
}
function cartbar() {
  const bar = $("cartbar");
  if (!state.vendor || !state.cart.length || state.view === "admin") {
    bar.hidden = true;
    return;
  }
  const n = state.cart.reduce((a, l) => a + l.qty, 0);
  bar.hidden = false;
  bar.innerHTML = `<span>${n} · ${money(sum())}<small>${esc(names(state.vendor.names))}</small></span><button data-act="cart">${t("cart")}</button>`;
}
async function shop(id) {
  state.view = "shop";
  state.category = "all";
  state.query = "";
  const c = await api("catalog?vendor=" + encodeURIComponent(id));
  state.vendor = c.vendor;
  state.products = c.products;
  state.city = c.vendor.city_id;
  storage.set("deserto-city", state.city);
  readCart();
  header();
  $("main").innerHTML =
    `<section class="shop-head"><button class="quiet back" data-act="home">${t("back")}</button><div><span class="pill">${t("testShop")}</span></div><h1>${esc(names(c.vendor.names))}</h1><p>${esc(names(c.vendor.description))}</p><div class="shop-meta"><span>${t("hours")}: ${clock(c.vendor.open_minute)}–${clock(c.vendor.close_minute)}</span><span>${esc(c.vendor.address || t("addressUnknown"))}</span><span>${t("pickup")}${c.vendor.delivery_enabled ? " · " + t("delivery") : ""}</span></div></section><div class="catalog-controls"><div class="cats">${["all", ...new Set(c.products.map((p) => p.category))].map((catId) => `<button class="chip${catId === "all" ? " on" : ""}" data-cat="${esc(catId)}">${catId === "all" ? t("all") : esc(cat(catId))}</button>`).join("")}</div><input id="search" type="search" placeholder="${t("search")}" aria-label="${t("search")}"></div><section class="section"><div class="product-grid" id="products"></div></section>`;
  renderProducts();
  cartbar();
}
function renderProducts() {
  const rows = state.products.filter(
    (p) =>
      (state.category === "all" || p.category === state.category) &&
      names(p.names)
        .toLocaleLowerCase()
        .includes(state.query.toLocaleLowerCase()),
  );
  $("products").innerHTML =
    rows
      .map(
        (p) =>
          `<article class="product reveal${!p.available ? " unavailable" : ""}"><button class="product-image" data-product="${esc(p.id)}" aria-label="${esc(names(p.names))}"><img src="${esc(p.image)}" alt="${esc(names(p.names))}" width="400" height="420" loading="lazy"></button><h3>${esc(names(p.names))}</h3>${p.promotion?`<p class="pill">${esc(names(p.promotion.titles))}${p.promotion.kind==="GIFT"?" · "+esc(names(p.promotion.gift)):" · −"+p.promotion.discount_bps/100+"%"}</p>`:""}<div class="category">${esc(cat(p.category))}</div><div class="product-bottom"><span class="price">${money(p.price)}</span><button class="add" data-product="${esc(p.id)}" aria-label="${t("choose")} ${esc(names(p.names))}" ${!p.available ? "disabled" : ""}>+</button></div>${!p.available ? `<small>${t("unavailable")}</small>` : ""}</article>`,
      )
      .join("") || `<div class="empty">${t("empty")}</div>`;
  reveal();
}
let lastFocus,
  modalGeneration = 0;
function closeModal() {
  modalGeneration++;
  $("modal-root").innerHTML = "";
  document.body.style.overflow = "";
  lastFocus?.focus?.();
}
function modal(title, html) {
  closeModal();
  lastFocus = document.activeElement;
  modalGeneration++;
  $("modal-root").innerHTML =
    `<div class="overlay" id="overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="sheet-top"><h2 id="modal-title">${esc(title)}</h2><button class="close" data-act="close" aria-label="${t("cancel")}">×</button></div>${html}</section></div>`;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => $("overlay")?.classList.add("open"));
  $("modal-root").querySelector("button,input,select")?.focus();
}
function recommend(seed) {
  const drinks = ["kofe", "chai2", "holodnye2"];
  const included = new Set(state.cart.map((l) => l.product_id));
  return state.products
    .filter(
      (p) =>
        p.id !== seed.id &&
        p.available > 0 &&
        !included.has(p.id) &&
        (drinks.includes(seed.category)
          ? ["pirozhnye", "pechenye", "torty-kusok"].includes(p.category)
          : drinks.includes(p.category)),
    )
    .slice(0, 3);
}
function detail(id) {
  const p = product(id);
  if (!p) return;
  const recs = recommend(p);
  modal(
    names(p.names),
    `<img class="detail-photo" src="${esc(p.image)}" alt="${esc(names(p.names))}"><p class="muted">${esc(cat(p.category))}</p><p class="notice">${esc(names(p.description) || t("ingredients"))}</p><form id="add-product" data-id="${esc(p.id)}"><div class="options">${p.options.map((o) => `<label><input type="checkbox" name="option" value="${esc(o.id)}"> ${esc(names(o.names))} +${money(o.delta)}</label>`).join("")}</div><label class="field">${t("note")}<input name="note" maxlength="120" placeholder="${t("noteHint")}"></label><button class="primary full" ${!p.available ? "disabled" : ""}>${t("add")} · ${money(p.price)}</button></form>${recs.length ? `<h3>${t("pairs")}</h3><div class="recommendations">${recs.map((r) => `<article class="rec"><img src="${esc(r.image)}" alt="${esc(names(r.names))}" loading="lazy"><strong>${esc(names(r.names))}</strong><p>${["kofe", "chai2", "holodnye2"].includes(p.category) ? t("pairSweet") : t("pairCoffee")}</p><span>${money(r.price)}</span><button data-quick="${esc(r.id)}">${t("add")}</button></article>`).join("")}</div>` : ""}`,
  );
}
function add(id, options = [], note = "") {
  const p = product(id);
  if (!p?.available) return toast(t("unavailable"));
  const current = state.cart
    .filter((l) => l.product_id === id)
    .reduce((a, l) => a + l.qty, 0);
  if (current >= p.available) return toast(t("stockError"));
  const k = JSON.stringify([id, [...options].sort(), note]),
    line = state.cart.find((l) => l.key === k);
  if ((line && line.qty >= 20) || (!line && state.cart.length >= 30))
    return toast(t("stockError"));
  if (line) line.qty++;
  else
    state.cart.push({
      key: k,
      product_id: id,
      qty: 1,
      options: [...options].sort(),
      note,
    });
  saveCart();
  toast(t("added"));
}
function cartLines() {
  return state.cart
    .map((l, i) => {
      const p = product(l.product_id);
      return `<div class="line"><img src="${esc(p.image)}" alt=""><div class="line-content"><h4>${esc(names(p.names))}</h4><small>${money(linePrice(l) * l.qty)}${l.note ? " · " + esc(l.note) : ""}</small>${l.options.length ? `<small>${l.options.map((o) => esc(names(p.options.find((x) => x.id === o)?.names))).join(", ")}</small>` : ""}</div><div class="qty"><button data-qty="${i}" data-delta="-1" aria-label="−">−</button><span>${l.qty}</span><button data-qty="${i}" data-delta="1" aria-label="+">+</button></div></div>`;
    })
    .join("");
}
function cartModal() {
  modal(
    t("cart"),
    `<p class="small muted">${esc(names(state.vendor.names))} · ${t("cartSaved")}</p>${state.cart.length ? cartLines() + `<div class="total-row final"><span>${t("total")}</span><strong>${money(sum())}</strong></div><button class="primary full" data-act="checkout">${t("continue")}</button><button class="quiet" data-act="clear">${t("clear")}</button>` : `<p class="empty">${t("empty")}</p>`}${state.undo?.vendor === state.vendor.id ? `<button class="secondary" data-act="undo">${t("undo")}</button>` : ""}`,
  );
}
let checkoutRequest = null;
async function checkout() {
  if (!state.cart.length) return;
  const latest = await api(
    "catalog?vendor=" + encodeURIComponent(state.vendor.id),
  );
  state.products = latest.products;
  state.vendor = latest.vendor;
  const valid = state.cart.filter((l) => {
    const p = product(l.product_id);
    return (
      p &&
      p.available >=
        state.cart
          .filter((x) => x.product_id === l.product_id)
          .reduce((a, x) => a + x.qty, 0) &&
      l.options.every((id) => p.options.some((o) => o.id === id))
    );
  });
  if (valid.length !== state.cart.length) {
    state.cart = valid;
    saveCart();
    cartModal();
    toast(t("stockError"));
    return;
  }
  const v = state.vendor,
    today = dayAt(v.timezone),
    max = dayAt(v.timezone, 14),
    event = storage.get('deserto-occasion',{}),
    day = event.day >= today && event.day <= max && state.cart.some(l=>l.note.endsWith(event.day)) ? event.day : today;
  modal(
    t("checkout"),
    `<div class="notice">${t("paymentNotice")}</div><form id="checkout-form"><div class="form-grid"><label class="field">${t("name")}<input name="name" autocomplete="name" maxlength="80" required></label><label class="field">${t("phone")}<input name="phone" type="tel" autocomplete="tel" maxlength="40" required></label><label class="field">${t("fulfillment")}<select name="fulfillment" id="fulfillment"><option value="pickup">${t("pickup")}</option>${v.delivery_enabled ? `<option value="delivery">${t("delivery")} · ${money(v.delivery_fee)}</option>` : ""}</select></label><label class="field">${t("method")}<select name="method"><option value="cash">${t("cash")}</option><option value="transfer">${t("transfer")}</option></select></label><label class="field">${t("day")}<input name="day" id="checkout-day" type="date" value="${day}" min="${day}" max="${max}" required></label><label class="field">${t("time")}<select name="minute" id="checkout-slot" required></select></label><label class="field span2" id="address-wrap" hidden>${t("address")}<input name="address" id="checkout-address" maxlength="300"></label><label class="field">${t("recipient")}<input name="recipient" maxlength="80"></label><label class="field">${t("recipientPhone")}<input name="recipient_phone" type="tel" maxlength="40"></label><label class="field span2">${t("comment")}<textarea name="comment" maxlength="500"></textarea></label></div><label class="small"><input type="checkbox" name="surprise"> ${t("surprise")}</label><div class="total-row"><span>${t("products")}</span><span>${money(sum())}</span></div><div class="total-row final"><span>${t("total")}</span><strong id="checkout-total">${money(sum())}</strong></div><p id="checkout-error" class="error" hidden></p><button class="primary full" id="checkout-submit">${t("submit")}</button></form>`,
  );
  await updateSlots();
}
async function updateSlots() {
  const generation = modalGeneration,
    day = $("checkout-day")?.value;
  if (!day) return;
  const lead = Math.max(
      state.vendor.lead_minutes,
      ...state.cart.map((l) => product(l.product_id)?.lead_minutes || 0),
    ),
    r = await api(
      `slots?vendor=${encodeURIComponent(state.vendor.id)}&day=${day}&lead=${lead}`,
    );
  if (generation !== modalGeneration || !$("checkout-slot")) return;
  const rows = r.slots.filter((s) => s.available > 0);
  $("checkout-slot").innerHTML = rows.length
    ? rows
        .map((s) => `<option value="${s.minute}">${clock(s.minute)}</option>`)
        .join("")
    : `<option value="">${t("noSlots")}</option>`;
  $("checkout-submit").disabled = !rows.length;
}
async function submitOrder(form) {
  if (!form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form)),
    fulfillment = fields.fulfillment,
    delivery = fulfillment === "delivery" ? state.vendor.delivery_fee : 0;
  const body = {
    vendor_id: state.vendor.id,
    city_id: state.vendor.city_id,
    items: state.cart.map(({ product_id, qty, options, note }) => ({
      product_id,
      qty,
      options,
      note,
    })),
    method: fields.method,
    fulfillment,
    day: fields.day,
    minute: Number(fields.minute),
    expected_total: sum() + delivery,
    customer: {
      name: fields.name,
      phone: fields.phone,
      address: fields.address || "",
      recipient: fields.recipient || "",
      recipient_phone: fields.recipient_phone || "",
      comment: fields.comment || "",
      surprise: fields.surprise === "on",
    },
  };
  const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body)),
    ),
    fingerprint = Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
  checkoutRequest = storage.get("deserto-pending-order", null);
  if (!checkoutRequest || checkoutRequest.fingerprint !== fingerprint)
    checkoutRequest = { fingerprint, idem: crypto.randomUUID() };
  storage.set("deserto-pending-order", checkoutRequest);
  $("checkout-submit").disabled = true;
  try {
    const o = await api("orders", { ...body, idem: checkoutRequest.idem });
    const refs = storage.get("deserto-orders", []);
    const ok = storage.set("deserto-orders", [
      { id: o.id, key: o.key },
      ...refs.filter((r) => r.id !== o.id),
    ]);
    if (!ok) {
      modal(
        t("saved"),
        `<p>${esc(o.id)}</p><p>${t("orderKeys")}</p><textarea readonly>${esc(o.key)}</textarea>`,
      );
      return;
    }
    state.cart = [];
    saveCart();
    checkoutRequest = null;
    storage.set("deserto-pending-order", null);
    closeModal();
    await myOrders();
  } catch (e) {
    if ($("checkout-error")) {
      $("checkout-error").hidden = false;
      $("checkout-error").textContent = error(e);
    }
    if ($("checkout-submit")) $("checkout-submit").disabled = false;
  }
}
function orderCard(o, admin = false) {
  const role = admin
      ? state.adminVendors.find((v) => v.id === state.adminVendor)?.role
      : null,
    manager = role && role !== "DRIVER";
  const actionButton = (action, label) =>
    `<button class="secondary" data-order-action="${action}" data-order-id="${o.id}">${t(label)}</button>`;
  let buttons = "";
  if (admin) {
    if (manager) {
      if (o.status === "NEW")
        buttons += actionButton("confirm", "confirmOrder");
      if (o.status === "CONFIRMED")
        buttons += actionButton("prepare", "prepare");
      if (o.status === "PREPARING") buttons += actionButton("ready", "ready");
      if (o.status === "READY" && o.fulfillment === "pickup")
        buttons += actionButton("handover", "handover");
      if (
        !["NEW", "CANCELLED", "AWAITING_APPROVAL"].includes(o.status) &&
        o.paid < o.total
      )
        buttons += actionButton("payment", "recordPayment");
      if (["NEW", "CONFIRMED"].includes(o.status))
        buttons += actionButton("propose", "propose");
      if (["NEW", "CONFIRMED", "PREPARING", "READY"].includes(o.status))
        buttons += actionButton("cancel", "cancelOrder");
    }
    if (o.fulfillment === "delivery") {
      if (!o.driver_id && o.status === "READY")
        buttons += actionButton("claim", "claim");
      if (o.driver_id === state.user.id) {
        if (o.status === "READY") buttons += actionButton("pickup", "take");
        if (o.status === "PICKED_UP")
          buttons += actionButton("depart", "depart");
        if (o.status === "OUT_FOR_DELIVERY")
          buttons += actionButton("deliver", "deliver");
      }
    }
  }
  return `<article class="admin-card"><span class="status">${esc(status(o.status))}</span><h3>${esc(names(o.vendor.names))}</h3><p class="small">${esc(o.id)} · ${o.day} · ${clock(o.minute)} · ${t(o.fulfillment)}</p><p>${o.items.map((l) => `${esc(names(l.title))} × ${l.qty}${l.note ? " · " + esc(l.note) : ""}`).join("<br>")}</p><p><strong>${money(o.total, o.currency)}</strong> · ${status(o.payment)} · ${t("paid")}: ${money(o.paid, o.currency)}</p>${admin ? `<p>${esc(o.customer.name)} · ${esc(o.customer.phone)}<br>${esc(o.customer.address)}${o.customer.recipient ? "<br>" + t("recipient") + ": " + esc(o.customer.recipient) : ""}${o.customer.surprise ? "<br>" + t("surprise") : ""}</p>` : ""}${o.proposal ? `<div class="order-approval"><h4>${t("proposal")}</h4><p>${esc(o.proposal.reason)}</p><p>${o.proposal.items.map((l) => esc(names(l.title) || names(product(l.product_id)?.names) || l.product_id) + " × " + l.qty).join("<br>")}</p><strong>${money(o.proposal.total, o.currency)}</strong>${!admin ? `<p class="small">${t("proposalNotice")}</p><div class="actions"><button class="primary" data-review="${o.id}" data-accept="yes">${t("approve")}</button><button class="secondary" data-review="${o.id}" data-accept="no">${t("reject")}</button></div>` : ""}</div>` : ""}<div class="actions">${buttons}</div><details><summary>${t("history")}</summary><div class="history">${o.events.map((e) => `<p>${new Date(e.at).toLocaleString(state.lang)} · ${status(e.event)}${e.data?.reason ? " · " + esc(e.data.reason) : ""}</p>`).join("")}</div></details></article>`;
}
async function myOrders() {
  const refs = storage.get("deserto-orders", []);
  const rows = await Promise.allSettled(refs.map((r) => api("order/view", r)));
  state.orders = rows
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  modal(
    t("orders"),
    `<p class="small muted">${t("orderKeys")}</p><button class="secondary" data-act="orders">${t("refresh")}</button>${state.orders.map((o) => orderCard(o)).join("") || `<p class="empty">${t("emptyOrders")}</p>`}`,
  );
}
async function cabinet() {
  closeModal();
  state.view = "admin";
  state.user = (await api("session")).user;
  header();
  cartbar();
  if (!state.user) {
    $("main").innerHTML =
      `<section class="login"><div class="eyebrow">DESERTO</div><h2 class="page-title">${t("login")}</h2><p class="small muted">${t("loginHint")}</p><form id="login-form"><label class="field">${t("email")}<input name="email" type="email" autocomplete="username" required></label><label class="field">${t("password")}<input name="password" type="password" autocomplete="current-password" required></label><button class="primary full">${t("signin")}</button></form></section>`;
    return;
  }
  state.adminVendors = (await api("manage/vendors")).vendors;
  if (!state.adminVendors.some((v) => v.id === state.adminVendor))
    state.adminVendor = state.adminVendors[0]?.id || "";
  await renderCabinet();
}
async function renderCabinet() {
  if (!state.adminVendor) {
    $("main").innerHTML =
      `<section class="section"><h1 class="page-title">${t("cabinet")}</h1><p>${t("empty")}</p>${state.user.owner ? `<button class="primary" data-act="new-vendor">${t("createVendor")}</button>` : ""}<button class="quiet" data-act="logout">${t("logout")}</button></section>`;
    return;
  }
  const v = state.adminVendors.find((v) => v.id === state.adminVendor),
    role = v.role;
  const allowed =
    role === "DRIVER"
      ? ["manageOrders"]
      : role === "STAFF"
        ? ["manageOrders", "summary"]
        : [
            "manageOrders",
            "manageCatalog",
            "promotions",
            ...(state.user.owner ? ["settlements"] : []),
            "settings",
            "team",
            "summary",
            ...(state.user.owner ? ["platform"] : []),
          ];
  if (!allowed.includes(state.adminTab)) state.adminTab = "manageOrders";
  $("main").innerHTML =
    `<section class="section"><div class="admin-top"><div><div class="eyebrow">DESERTO · ${status(role)}</div><h1 class="page-title">${t("cabinet")}</h1></div><select id="admin-vendor">${state.adminVendors.map((v) => `<option value="${esc(v.id)}">${esc(names(v.names))}</option>`).join("")}</select><button class="quiet" data-act="logout">${t("logout")}</button></div><nav class="admin-nav">${allowed.map((a) => `<button class="chip${state.adminTab === a ? " on" : ""}" data-tab="${a}">${t(a)}</button>`).join("")}</nav><p class="small muted">${t("bots")}</p><div id="admin-content"></div></section>`;
  $("admin-vendor").value = state.adminVendor;
  const area = $("admin-content");
  if (state.adminTab === "manageOrders") {
    const data = await api("manage/orders?vendor=" + encodeURIComponent(v.id));
    state.orders = data.orders;
    area.innerHTML = `<button class="secondary" data-act="admin-refresh">${t("refresh")}</button>${data.available.length ? `<h3>${t("availableDeliveries")}</h3>${data.available.map((o) => `<article class="admin-card">${esc(o.id)} · ${o.day} ${clock(o.minute)}<button class="secondary" data-claim="${o.id}">${t("claim")}</button></article>`).join("")}` : ""}${data.orders.map((o) => orderCard(o, true)).join("") || `<p class="empty">${t("emptyOrders")}</p>`}`;
  }
  if (state.adminTab === "promotions") await renderPromotions(v,area);
  if (state.adminTab === "settlements") await renderSettlements(v,area);
  if (state.adminTab === "manageCatalog") {
    const c = await api("manage/catalog?vendor=" + encodeURIComponent(v.id));
    state.products = c.products;
    area.innerHTML = `<button class="secondary" data-act="new-product">${t("add")} · ${t("products")}</button>${c.products.map((p) => `<article class="admin-card"><div class="line"><img src="${esc(p.image)}" alt=""><div class="line-content"><h3>${esc(names(p.names))}</h3><p>${money(p.price)} · ${t("stock")}: ${p.available}</p></div><button class="secondary" data-edit-product="${esc(p.id)}">${t("settings")}</button></div></article>`).join("")}`;
  }
  if (state.adminTab === "settings") {
    area.innerHTML = `<form id="vendor-settings" class="admin-card"><div class="form-grid">${["ru", "ka", "en"].map((l) => `<label class="field">${t("title" + l[0].toUpperCase() + l.slice(1))}<input name="name_${l}" value="${esc(v.names[l])}" required maxlength="120"></label>`).join("")}<label class="field span2">${t("address")}<input name="address" value="${esc(v.address)}" maxlength="300"></label><label class="field">${t("phone")}<input name="phone" value="${esc(v.phone)}" maxlength="40"></label><label class="field">${t("open")}<input name="open" type="time" value="${clock(v.open_minute)}" required></label><label class="field">${t("close")}<input name="close" type="time" value="${clock(v.close_minute)}" required></label><label class="field">${t("lead")}<input name="lead_minutes" type="number" min="0" max="10080" value="${v.lead_minutes}" required></label><label class="field">${t("capacity")}<input name="slot_capacity" type="number" min="1" max="100" value="${v.slot_capacity || 8}" required></label><label class="field">${t("deliveryFee")}<input name="delivery_fee" type="number" min="0" step="0.01" value="${v.delivery_fee / 100}" required></label></div><p><label><input name="delivery_enabled" type="checkbox" ${v.delivery_enabled ? "checked" : ""}> ${t("deliveryEnabled")}</label></p><button class="primary">${t("save")}</button></form>`;
  }
  if (state.adminTab === "team") {
    const data = await api("manage/members?vendor=" + encodeURIComponent(v.id));
    area.innerHTML = `<form class="admin-card" id="invite-form"><label class="field">${t("role")}<select name="role"><option value="ADMIN">${status("ADMIN")}</option><option value="STAFF">${status("STAFF")}</option><option value="DRIVER">${status("DRIVER")}</option></select></label><button class="primary">${t("invite")}</button><div id="invite-result"></div></form>${data.members.map((m) => `<article class="admin-card"><h3>${esc(m.name)}</h3><p>${esc(m.email)} · ${status(m.role)}</p><button class="secondary" data-revoke="${esc(m.id)}">${t("remove")}</button></article>`).join("")}`;
  }
  if (state.adminTab === "summary") {
    const data = await api("manage/summary?vendor=" + encodeURIComponent(v.id));
    area.innerHTML = `<p class="notice">${t("localOnly")}</p><div class="metrics">${[
      ["manageOrders", data.orders],
      ["revenue", money(data.revenue)],
      ["paid", money(data.received)],
      ["debt", money(data.debt)],
      [
        "profit",
        data.gross_profit === null ? t("unknown") : money(data.gross_profit),
      ],
    ]
      .map(
        ([k, v]) =>
          `<article class="metric"><span class="small">${t(k)}</span><strong>${v}</strong></article>`,
      )
      .join("")}</div>`;
  }
  if (state.adminTab === "platform")
    area.innerHTML = `<div class="actions"><button class="primary" data-act="new-vendor">${t("createVendor")}</button><button class="secondary" data-act="new-city">${t("add")} · ${t("city")}</button></div>${state.adminVendors.map((v) => `<article class="admin-card"><h3>${esc(names(v.names))}</h3><p>${esc(names(state.cities.find((c) => c.id === v.city_id)?.names))}</p><button class="secondary" data-publish="${esc(v.id)}" data-active="${v.active ? "no" : "yes"}">${v.active ? t("hide") : t("publish")}</button></article>`).join("")}`;
}
function productEdit(id) {
  const p = state.products.find((p) => p.id === id);
  modal(
    names(p.names),
    `<form id="product-edit" data-id="${esc(p.id)}"><div class="form-grid">${["ru", "ka", "en"].map((l) => `<label class="field">${l.toUpperCase()}<input name="name_${l}" value="${esc(p.names[l])}" required maxlength="120"></label>`).join("")}<label class="field">${t("price")}, ₾<input name="price" type="number" min="0" step="0.01" value="${p.price / 100}" required></label><label class="field">${t("stock")}<input name="stock" type="number" min="${p.reserved}" value="${p.stock}" required></label><label class="field">${t("cost")}, ₾<input name="cost" type="number" min="0" step="0.01" value="${p.cost === null ? "" : p.cost / 100}"></label><label class="field">${t("lead")}<input name="lead_minutes" type="number" min="0" max="10080" value="${p.lead_minutes}" required></label><label class="field span2">${t("reason")}<input name="reason" maxlength="300" required></label></div><p><label><input name="active" type="checkbox" ${p.active ? "checked" : ""}> ${t("active")}</label></p><button class="primary full">${t("save")}</button></form>`,
  );
}
function nameFields() {
  return ["ru", "ka", "en"]
    .map(
      (l) =>
        `<label class="field">${l.toUpperCase()}<input name="name_${l}" required maxlength="120"></label>`,
    )
    .join("");
}
function newVendor() {
  modal(
    t("createVendor"),
    `<form id="new-vendor-form">${nameFields()}<label class="field">${t("city")}<select name="city_id">${state.cities.map((c) => `<option value="${esc(c.id)}">${esc(names(c.names))}</option>`).join("")}</select></label><label class="field">${t("slug")}<input name="slug" pattern="[a-z0-9-]{3,80}" required></label><button class="primary full">${t("save")}</button></form>`,
  );
}
function newCity() {
  modal(
    t("add") + " · " + t("city"),
    `<form id="new-city-form">${nameFields()}<label class="field">${t("slug")}<input name="id" pattern="[a-z0-9-]{3,80}" required></label><label class="field">${t("timezone")}<input name="timezone" value="Asia/Tbilisi" required></label><label class="field">${t("currency")}<input name="currency" value="GEL" pattern="[A-Z]{3}" required></label><button class="primary full">${t("save")}</button></form>`,
  );
}
async function newProduct() {
  const own = (
    await api("manage/catalog?vendor=" + encodeURIComponent(state.adminVendor))
  ).products;
  const templates = (
    await api(
      "manage/templates?vendor=" + encodeURIComponent(state.adminVendor),
    )
  ).products;
  const source = [...own, ...templates];
  modal(
    t("add") + " · " + t("products"),
    `<form id="new-product-form"><label class="field">${t("products")}<select name="source_product_id" id="source-product">${source.map((p) => `<option value="${esc(p.id)}">${esc(names(p.names))}</option>`).join("")}</select></label>${nameFields()}<label class="field">${t("price")}, ₾<input name="price" type="number" min="0" step="0.01" required></label><label class="field">${t("stock")}<input name="stock" type="number" min="0" required></label><button class="primary full" ${!source.length ? "disabled" : ""}>${t("save")}</button></form>`,
  );
}
function proposalModal(o) {
  const choices = (id, extra = false) =>
    (extra ? `<option value="">${t("noExtra")}</option>` : "") +
    state.products
      .filter((p) => p.active)
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === id ? "selected" : ""}>${esc(names(p.names))} · ${money(p.price)}</option>`,
      )
      .join("");
  modal(
    t("propose"),
    `<p class="small">${t("proposalNotice")}</p><form id="proposal-form" data-id="${o.id}">${[...o.items, { product_id: "", qty: 0, note: "" }].map((l, i) => `<fieldset><legend>${i === o.items.length ? t("extraLine") : esc(names(l.title))}</legend><label class="field">${t("products")}<select name="product_${i}">${choices(l.product_id, i === o.items.length)}</select></label><label class="field">${t("quantity")}<input name="qty_${i}" type="number" min="0" max="20" value="${l.qty}" required></label><label class="field">${t("note")}<input name="note_${i}" maxlength="120" value="${esc(l.note)}"></label></fieldset>`).join("")}<label class="field">${t("reason")}<input name="reason" maxlength="300" required></label><button class="primary full">${t("propose")}</button></form>`,
  );
}
function paymentModal(o) {
  modal(
    t("recordPayment"),
    `<p class="notice">${t("paymentNotice")}</p><form id="payment-form" data-id="${o.id}"><label class="field">${t("amount")}<input name="amount" type="number" min="0.01" step="0.01" max="${(o.total - o.paid) / 100}" required></label><label class="field">${t("reason")}<input name="reason" maxlength="300" required></label><button class="primary full">${t("save")}</button></form>`,
  );
}
async function adminAction(id, action, extra = {}) {
  const o = state.orders.find((o) => o.id === id);
  if (!o) return;
  await api("manage/action", {
    id,
    action,
    version: o.version,
    command_id: crypto.randomUUID(),
    ...extra,
  });
  closeModal();
  await renderCabinet();
}
function joinModal(invite) {
  modal(
    t("join"),
    `<p>${t("joinHint")}</p><form id="join-form" data-invite="${esc(invite)}"><label class="field">${t("name")}<input name="name" required maxlength="100"></label><label class="field">${t("email")}<input name="email" type="email" autocomplete="username" required></label><label class="field">${t("password")}<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label><button class="primary full">${t("join")}</button></form>`,
  );
}
document.addEventListener(
  "submit",
  busy(async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!form.reportValidity()) return;
    const b = Object.fromEntries(new FormData(form)),
      ns = { ru: b.name_ru, ka: b.name_ka, en: b.name_en };
    switch (form.id) {
      case "promotion-form":
        await api('manage/promotion',{command:crypto.randomUUID(),action:'propose',vendor_id:state.adminVendor,product_id:b.product_id,kind:b.kind,discount_bps:Math.round(Number(b.discount)*100),titles:Object.fromEntries(['ru','ka','en'].map(l=>[l,b['title_'+l]])),gift:Object.fromEntries(['ru','ka','en'].map(l=>[l,b['gift_'+l]]))});
        closeModal();await renderCabinet();break;
      case "promo-budget":
      case "settlement-form": {
        const expenses=Object.fromEntries(expenseKeys.map(k=>[k,Math.round(Number(b[k])*100)]));
        const promo=form.id==='promo-budget';
        await api(promo?'manage/promotion':'manage/settlement',{command:crypto.randomUUID(),vendor_id:state.adminVendor,action:'publish',id:form.dataset.id,order_id:form.dataset.order,version:Number(form.dataset.version),expenses,costs_confirmed:b.confirmed==='on',evidence:b.evidence});
        closeModal();await renderCabinet();break;
      }
      case "add-product":
        add(
          form.dataset.id,
          new FormData(form).getAll("option"),
          b.note.trim(),
        );
        closeModal();
        break;
      case "checkout-form":
        await submitOrder(form);
        break;
      case "login-form":
        await api("login", { email: b.email, password: b.password });
        await cabinet();
        break;
      case "join-form":
        await api("join", { ...b, invite: form.dataset.invite });
        closeModal();
        toast(t("joined"));
        await cabinet();
        break;
      case "product-edit": {
        const p = state.products.find((p) => p.id === form.dataset.id);
        await api("manage/product", {
          id: p.id,
          vendor_id: state.adminVendor,
          names: ns,
          price: Math.round(Number(b.price) * 100),
          stock: Number(b.stock),
          cost: b.cost === "" ? null : Math.round(Number(b.cost) * 100),
          lead_minutes: Number(b.lead_minutes),
          active: b.active === "on",
          version: p.version,
          reason: b.reason,
        });
        closeModal();
        await renderCabinet();
        break;
      }
      case "vendor-settings":
        await api("manage/vendor", {
          id: state.adminVendor,
          names: ns,
          address: b.address,
          phone: b.phone,
          lead_minutes: Number(b.lead_minutes),
          open_minute: minute(b.open),
          close_minute: minute(b.close),
          delivery_enabled: b.delivery_enabled === "on",
          delivery_fee: Math.round(Number(b.delivery_fee) * 100),
          slot_capacity: Number(b.slot_capacity),
        });
        await cabinet();
        toast(t("notReady"));
        break;
      case "invite-form": {
        const r = await api("manage/invite", {
          vendor_id: state.adminVendor,
          role: b.role,
        });
        $("invite-result").innerHTML =
          `<label class="field">${t("copy")}<textarea readonly>${esc(location.origin + "/#invite=" + r.invite)}</textarea></label>`;
        break;
      }
      case "new-vendor-form": {
        const r = await api("manage/new-vendor", {
          city_id: b.city_id,
          names: ns,
          slug: b.slug,
        });
        state.adminVendor = r.id;
        state.adminTab = "manageCatalog";
        closeModal();
        await cabinet();
        toast(t("vendorAdded"));
        break;
      }
      case "new-city-form":
        await api("manage/city", { ...b, names: ns });
        state.cities = (await api("cities")).cities;
        closeModal();
        await cabinet();
        break;
      case "new-product-form":
        await api("manage/new-product", {
          vendor_id: state.adminVendor,
          source_product_id: b.source_product_id,
          names: ns,
          price: Math.round(Number(b.price) * 100),
          stock: Number(b.stock),
        });
        closeModal();
        await renderCabinet();
        break;
      case "proposal-form": {
        const o = state.orders.find((o) => o.id === form.dataset.id),
          items = [...o.items, {}]
            .map((old, i) => ({
              product_id: b["product_" + i],
              qty: Number(b["qty_" + i]),
              note: b["note_" + i],
              options: b["product_" + i] === old.product_id ? old.options : [],
            }))
            .filter((l) => l.product_id && l.qty > 0);
        if (!items.length) return toast(t("checkFields"));
        await adminAction(o.id, "propose", { items, reason: b.reason });
        break;
      }
      case "payment-form":
        await adminAction(form.dataset.id, "payment", {
          amount: Math.round(Number(b.amount) * 100),
          reason: b.reason,
        });
        break;
    }
  }),
);
document.addEventListener(
  "click",
  busy(async (e) => {
    if (e.target.id === "overlay") {
      closeModal();
      return;
    }
    const target = e.target.closest("button");
    if (!target) return;
    const d = target.dataset;
    if(d.occasion) {storage.set('deserto-occasion',{...storage.get('deserto-occasion',{}),type:d.occasion});await occasionPage();return;}
    if(d.eventOne) {addEventCakes(d.eventOne);return;}
    if(d.eventCart) {closeModal();await shop(d.eventCart);history.replaceState(null,'',location.pathname+'#vendor='+encodeURIComponent(d.eventCart));cartModal();return;}
    if(d.promoApprove) {expenseForm('promo-budget',promotionRows.find(p=>p.id===d.promoApprove));return;}
    if(d.promoStop) {const p=promotionRows.find(p=>p.id===d.promoStop);await api('manage/promotion',{command:crypto.randomUUID(),vendor_id:state.adminVendor,id:p.id,version:p.version,action:'stop'});await renderCabinet();return;}
    if(d.settle) {const o=settlementRows.find(o=>o.id===d.settle);expenseForm('settlement-form',{...o,version:o.record?.version||0});return;}
    if (d.product) {
      detail(d.product);
      return;
    }
    if (d.quick) {
      add(d.quick);
      return;
    }
    if (d.cat) {
      state.category = d.cat;
      document
        .querySelectorAll("[data-cat]")
        .forEach((b) => b.classList.toggle("on", b.dataset.cat === d.cat));
      renderProducts();
      return;
    }
    if (d.qty !== undefined) {
      const l = state.cart[Number(d.qty)];
      const n = l.qty + Number(d.delta);
      if (n > 20) return;
      if (
        n > 0 &&
        state.cart
          .filter((x) => x.product_id === l.product_id)
          .reduce((a, l) => a + l.qty, 0) +
          Number(d.delta) >
          product(l.product_id).available
      )
        return toast(t("stockError"));
      if (n <= 0) state.cart.splice(Number(d.qty), 1);
      else l.qty = n;
      saveCart();
      cartModal();
      return;
    }
    if (d.tab) {
      state.adminTab = d.tab;
      await renderCabinet();
      return;
    }
    if (d.editProduct) {
      productEdit(d.editProduct);
      return;
    }
    if (d.orderAction) {
      const o = state.orders.find((o) => o.id === d.orderId);
      if (d.orderAction === "payment") return paymentModal(o);
      if (d.orderAction === "propose") {
        state.products = (
          await api(
            "manage/catalog?vendor=" + encodeURIComponent(state.adminVendor),
          )
        ).products;
        return proposalModal(o);
      }
      if (d.orderAction === "cancel") {
        const reason = prompt(t("reason"));
        if (!reason) return;
        await adminAction(o.id, "cancel", { reason });
        return;
      }
      await adminAction(o.id, d.orderAction);
      return;
    }
    if (d.claim) {
      const list = await api(
        "manage/orders?vendor=" + encodeURIComponent(state.adminVendor),
      );
      const o = list.available.find((o) => o.id === d.claim);
      if (!o) return;
      await api("manage/action", {
        id: o.id,
        action: "claim",
        version: o.version,
        command_id: crypto.randomUUID(),
      });
      await renderCabinet();
      return;
    }
    if (d.review) {
      const o = state.orders.find((o) => o.id === d.review),
        ref = storage.get("deserto-orders", []).find((r) => r.id === o.id);
      await api("order/approve", {
        ...ref,
        proposal_id: o.proposal.id,
        version: o.version,
        approved: d.accept === "yes",
      });
      await myOrders();
      return;
    }
    if (d.revoke) {
      await api("manage/revoke", {
        vendor_id: state.adminVendor,
        user_id: d.revoke,
      });
      await renderCabinet();
      return;
    }
    if (d.publish) {
      await api("manage/vendor-publish", {
        id: d.publish,
        active: d.active === "yes",
      });
      await cabinet();
      return;
    }
    switch (d.act) {
      case 'occasion': await occasionPage();break;
      case 'event-all': addEventCakes();break;
      case 'new-promotion': promoForm();break;
      case "explore":
        $("shops").scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        break;
      case "home":
        location.hash = "";
        await home();
        break;
      case "close":
        closeModal();
        break;
      case "cart":
        cartModal();
        break;
      case "checkout":
        await checkout();
        break;
      case "clear":
        state.undo = {
          vendor: state.vendor.id,
          cart: structuredClone(state.cart),
        };
        state.cart = [];
        saveCart();
        cartModal();
        toast(t("clearDone"));
        break;
      case "undo":
        if (state.cart.length) return toast(t("undoConflict"));
        if (state.undo?.vendor === state.vendor.id) {
          state.cart = state.undo.cart;
          state.undo = null;
          saveCart();
          cartModal();
        }
        break;
      case "orders":
        await myOrders();
        break;
      case "admin-refresh":
        await renderCabinet();
        break;
      case "logout":
        if (state.user?.auth_mode === "sites") {
          location.assign("/signout-with-chatgpt?return_to=/");
          return;
        }
        await api("logout", {});
        state.user = null;
        await cabinet();
        break;
      case "new-vendor":
        newVendor();
        break;
      case "new-city":
        newCity();
        break;
      case "new-product":
        await newProduct();
        break;
    }
  }),
);
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.query = e.target.value;
    renderProducts();
  }
});
document.addEventListener(
  "change",
  busy(async (e) => {
    if (['occasion-date','occasion-type'].includes(e.target.id)) storage.set('deserto-occasion',{type:$('occasion-type').value,day:$('occasion-date').value});
    if (e.target.id === 'promo-kind') {
      const gift=e.target.value==='GIFT';$('gift-fields').hidden=!gift;$('discount-fields').hidden=gift;
      document.querySelectorAll('#gift-fields input').forEach(i=>i.required=gift);
    }
    if (e.target.matches('[data-event-choice]')) {
      const c=occasionCatalogs.find(c=>c.vendor.id===e.target.dataset.eventChoice),p=c.products.find(p=>p.id===e.target.value),img=e.target.closest('article').querySelector('img');img.src=p.image;img.alt=names(p.names);
    }
    if (e.target.id === "checkout-day") await updateSlots();
    if (e.target.id === "fulfillment") {
      $("address-wrap").hidden = e.target.value !== "delivery";
      $("checkout-address").required = e.target.value === "delivery";
      $("checkout-total").textContent = money(
        sum() + (e.target.value === "delivery" ? state.vendor.delivery_fee : 0),
      );
    }
    if (e.target.id === "admin-vendor") {
      state.adminVendor = e.target.value;
      await renderCabinet();
    }
  }),
);
document.addEventListener("keydown", (e) => {
  const overlay = $("overlay");
  if (!overlay) return;
  if (e.key === "Escape") closeModal();
  if (e.key === "Tab") {
    const nodes = [
        ...overlay.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        ),
      ].filter((n) => n.getClientRects().length),
      first = nodes[0],
      last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
$("city").addEventListener(
  "change",
  busy(async (e) => {
    state.city = e.target.value;
    storage.set("deserto-city", state.city);
    history.replaceState(null, "", location.pathname);
    await home();
  }),
);
$("language").addEventListener(
  "change",
  busy(async (e) => {
    state.lang = e.target.value;
    storage.set("deserto-language", state.lang);
    header();
    closeModal();
    if (state.view === "occasion") await occasionPage();
    else if (state.view === "admin") await cabinet();
    else if (state.vendor) await shop(state.vendor.id);
    else await home();
  }),
);
$("my-orders").onclick = busy(myOrders);
$("cabinet").onclick = busy(async () => {
  history.replaceState(null, "", location.pathname + "#cabinet=1");
  await cabinet();
});
document.querySelector(".brand").addEventListener(
  "click",
  busy(async (e) => {
    e.preventDefault();
    closeModal();
    history.replaceState(null, "", location.pathname);
    await home();
  }),
);
$("credits").onclick = () =>
  modal(
    t("credits"),
    `<p>${esc(t("localOnly"))}</p><p>${esc(t("photoInfo"))}</p>`,
  );
async function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has("occasion")) {await occasionPage();return;}
  if (params.has("cabinet")) {
    await cabinet();
    return;
  }
  if (params.get("invite")) {
    const value = params.get("invite");
    history.replaceState(null, "", location.pathname);
    joinModal(value);
    return;
  }
  if (params.get("vendor")) {
    await shop(params.get("vendor"));
    if (params.get("product")) detail(params.get("product"));
    return;
  }
  await home();
}
window.addEventListener("hashchange", busy(route));
let occasionCatalogs=[], promotionRows=[];
async function occasionPage() {
  closeModal();
  state.view='occasion'; state.vendor=null; cartbar();
  history.replaceState(null,'',location.pathname+'#occasion=1');
  const vendors=(await api('vendors?city='+encodeURIComponent(state.city))).vendors;
  occasionCatalogs=await Promise.all(vendors.map(v=>api('catalog?vendor='+encodeURIComponent(v.id))));
  const event=storage.get('deserto-occasion',{});
  $('main').innerHTML=`<section class="section"><button class="quiet" data-act="home">${t('back')}</button><h1 class="page-title">${t('occasion')}</h1><p>${t('occasionText')}</p><p class="small muted">${t('ranking')}</p><div class="form-grid"><label class="field">${t('occasion')}<select id="occasion-type">${['birthday','holiday','celebration'].map(k=>`<option value="${k}" ${event.type===k?'selected':''}>${t(k)}</option>`).join('')}</select></label><label class="field">${t('eventDate')}<input id="occasion-date" type="date" min="${dayAt('Asia/Tbilisi')}" max="${dayAt('Asia/Tbilisi',14)}" value="${esc(event.day||'')}" required></label></div><div class="vendor-grid">${occasionCatalogs.map(c=>{const cakes=c.products.filter(p=>p.category==='torty-celye'&&p.available>0);return `<article class="vendor-card"><h2>${esc(names(c.vendor.names))}</h2>${cakes.length?`<img class="event-photo" src="${esc(cakes[0].image)}" alt="${esc(names(cakes[0].names))}" loading="lazy"><label class="field">${t('products')}<select data-event-choice="${esc(c.vendor.id)}">${cakes.map(p=>`<option value="${esc(p.id)}">${esc(names(p.names))} · ${money(p.price,c.vendor.currency)}</option>`).join('')}</select></label><button class="primary" data-event-one="${esc(c.vendor.id)}">${t('eventOne')}</button>`:`<p>${t('noCakes')}</p>`}</article>`}).join('')}</div><div class="actions"><button class="primary" data-act="event-all">${t('oneEach')}</button></div><p class="notice">${t('eventCarts')}</p></section>`;
  header();
}
function addEventCakes(vendorId) {
  const date=$('occasion-date');
  if(!date.reportValidity()) return;
  const type=$('occasion-type').value,day=date.value;
  storage.set('deserto-occasion',{type,day});
  const chosen=[];
  for(const c of occasionCatalogs.filter(x=>!vendorId||x.vendor.id===vendorId)) {
    const select=document.querySelector(`[data-event-choice="${CSS.escape(c.vendor.id)}"]`);
    const p=c.products.find(x=>x.id===select?.value&&x.available>0);
    if(!p) continue;
    const note=(t(type)+' · '+day).slice(0,120),key='deserto-cart:'+c.vendor.id;
    if(storage.set(key,eventCart(storage.get(key,[]),p,note))) chosen.push(c);
  }
  modal(t('eventAdded'),`<p>${t('eventCarts')}</p>${chosen.map(c=>`<p><button class="secondary" data-event-cart="${esc(c.vendor.id)}">${esc(names(c.vendor.names))} · ${t('cart')}</button></p>`).join('')}`);
}
function promoForm() {
 const eligible=state.products.filter(p=>p.active&&!p.options.length&&p.price>0);
 modal(t('promoNew'),`<p class="notice">${t('promoHint')}</p><form id="promotion-form"><label class="field">${t('products')}<select name="product_id">${eligible.map(p=>`<option value="${esc(p.id)}">${esc(names(p.names))} · ${money(p.price)}</option>`).join('')}</select></label><label class="field">${t('promotions')}<select name="kind" id="promo-kind"><option value="DISCOUNT">${t('discount')}</option><option value="GIFT">${t('gift')}</option></select></label>${['ru','ka','en'].map(l=>`<label class="field">${t('promoTitle')} · ${l.toUpperCase()}<input name="title_${l}" maxlength="160" required></label>`).join('')}<div id="discount-fields"><label class="field">${t('discountPercent')}<input name="discount" type="number" min="0.01" max="90" step="0.01" value="5"></label></div><div id="gift-fields" hidden>${['ru','ka','en'].map(l=>`<label class="field">${t('giftTitle')} · ${l.toUpperCase()}<input name="gift_${l}" maxlength="160"></label>`).join('')}</div><button class="primary" ${eligible.length?'':'disabled'}>${t('promoNew')}</button></form>`);
}
function expenseForm(id,data) {
 const promo=id==='promo-budget';
 modal(t(promo?'budget':'actualCosts'),`<p class="notice">${t('marginHint')}</p><p>${promo?money(data.sale_price):money(data.total)}</p><form id="${id}" data-id="${esc(data.id)}" data-version="${data.version}" data-order="${esc(data.order_id||data.id)}"><div class="form-grid">${expenseKeys.map(k=>`<label class="field">${t(k)}, ₾<input name="${k}" type="number" min="0" max="1000000" step="0.01" required></label>`).join('')}</div><label class="field">${t('evidence')}<textarea name="evidence" maxlength="1000" required></textarea></label><p><label><input name="confirmed" type="checkbox" required> ${t('costsConfirmed')}</label></p><button class="primary">${t(promo?'approvePromo':'closeSettlement')}</button></form>`);
}
async function renderPromotions(v,area) {
 const [data,c]=await Promise.all([api('manage/promotions?vendor='+encodeURIComponent(v.id)),api('manage/catalog?vendor='+encodeURIComponent(v.id))]);
 promotionRows=data.promotions;state.products=c.products;
 area.innerHTML=`<p class="notice">${t('promoHint')}</p><div class="actions"><button class="primary" data-act="new-promotion">${t('promoNew')}</button></div><p class="small">${t('discount')}: 5%, 10% · ${t('gift')}: ${t('giftTitle')}. ${t('marginHint')}</p>${data.promotions.map(p=>`<article class="admin-card"><span class="pill">${t(p.state==='ACTIVE'?'activePromo':p.state==='STOPPED'?'stopped':'proposed')}</span><h3>${esc(names(p.titles))}</h3><p>${p.kind==='DISCOUNT'?`${t('discount')} ${p.discount_bps/100}%`:`${t('gift')}: ${esc(names(p.gift))}`} · ${money(p.sale_price)}</p>${p.state==='PROPOSED'&&state.user.owner?`<button class="primary" data-promo-approve="${esc(p.id)}">${t('approvePromo')}</button>`:''}${p.state!=='STOPPED'?`<button class="secondary" data-promo-stop="${esc(p.id)}">${t('stopPromo')}</button>`:''}${p.budget?`<p>${t('forecast')}: ${money(p.budget.net)} · ${t('requiredNet')}: ${money(p.budget.required_net)}</p>`:''}</article>`).join('')}`;
}
let settlementRows=[];
async function renderSettlements(v,area) {
 const data=await api('manage/settlements?vendor='+encodeURIComponent(v.id));
 settlementRows=data.orders.map(o=>({...o,record:data.records.find(r=>r.order_id===o.id)}));
 area.innerHTML=`<p class="notice">${t('marginHint')}</p>${settlementRows.map(o=>`<article class="admin-card"><h3>${esc(o.id)} · ${money(o.total)}</h3>${o.record?`<p>${t(o.record.state==='CLOSED'?'closedSettlement':'shortfall')}</p><p>${t('net')}: ${money(o.record.net)} · ${t('requiredNet')}: ${money(o.record.required_net)}</p>`:''}${o.record?.state==='CLOSED'?'':`<button class="primary" data-settle="${esc(o.id)}">${t('closeSettlement')}</button>`}</article>`).join('')||`<p>${t('noSettlements')}</p>`}`;
}

async function boot() {
  const [cities, session] = await Promise.all([api("cities"), api("session")]);
  state.cities = cities.cities;
  state.user = session.user;
  if (!state.cities.some((c) => c.id === state.city))
    state.city = state.cities[0]?.id || "";
  header();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    try {
      if (!sessionStorage.getItem("deserto-intro")) {
        document.querySelector(".curtain").classList.add("play");
        sessionStorage.setItem("deserto-intro", "1");
      }
    } catch {}
  }
  await route();
}
boot().catch((e) => {
  $("main").innerHTML =
    `<section class="section"><p class="error">${error(e)}</p><button class="primary" id="retry">${t("refresh")}</button></section>`;
  $("retry").onclick = () => location.reload();
});
