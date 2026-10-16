import { userSession, sha, token } from "./security.mjs";
export async function privateSession(req, db) {
  const existing = await userSession(req, db);
  if (existing) return existing;
  const identity = req.headers.get("oai-authenticated-user-id");
  if (!identity) return null;
  const id = "sites:" + (await sha(identity));
  let u = await db
    .prepare("SELECT id,active,owner FROM users WHERE id=?")
    .bind(id)
    .first();
  if (!u) {
    // Sites confirms this project is owner-private before publication. First owner binding is immutable.
    await db
      .prepare(
        "INSERT INTO users(id,email,name,hash,salt,owner) SELECT ?,?,'Владелец DESERTO',?,?,1 WHERE NOT EXISTS(SELECT 1 FROM users WHERE id LIKE 'sites:%' AND owner=1) ON CONFLICT DO NOTHING",
      )
      .bind(id, id.slice(6) + "@sites.invalid", token(), token())
      .run();
    u = await db
      .prepare("SELECT id,active,owner FROM users WHERE id=?")
      .bind(id)
      .first();
  }
  if (!u?.active || !u.owner) return null;
  return {
    id,
    email: id.slice(6) + "@sites.invalid",
    name: "Владелец DESERTO",
    owner: true,
    auth_mode: "sites",
    memberships: [],
  };
}
