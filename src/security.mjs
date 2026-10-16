export const uuid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export class Problem extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function fail(code, status = 400) {
  throw new Problem(code, status);
}
export const hex = (a) =>
  Array.from(new Uint8Array(a), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const sha = async (s) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export function constant(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
export async function passwordHash(password, salt) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 100000,
        salt: new TextEncoder().encode(salt),
      },
      k,
      256,
    ),
  );
}
export function text(v, max = 200, required = false) {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    fail("INVALID_INPUT");
  return v.trim();
}
export function integer(v, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail("INVALID_NUMBER");
  return v;
}
export const jsonParse = (v, fallback = null) => {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
export const emailValue = (v) => {
  const s = text(v, 200, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail("INVALID_EMAIL");
  return s;
};
export async function userSession(req, db) {
  const value = (req.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("deserto_session="))
    ?.slice(16);
  if (!value) return null;
  const u = await db
    .prepare(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.active=1",
    )
    .bind(await sha(value), Date.now())
    .first();
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    owner: !!u.owner,
    memberships: (
      await db
        .prepare("SELECT vendor_id,role FROM memberships WHERE user_id=?")
        .bind(u.id)
        .all()
    ).results,
  };
}
export function requireUser(user) {
  if (!user) fail("LOGIN_REQUIRED", 401);
  return user;
}
export function permit(user, vendor, roles = ["ADMIN", "STAFF"]) {
  requireUser(user);
  if (user.owner) return "OWNER";
  const role = user.memberships.find((m) => m.vendor_id === vendor)?.role;
  if (!roles.includes(role)) fail("FORBIDDEN", 403);
  return role;
}
