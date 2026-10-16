// Entry point ONLY for the owner-private Sites deployment. Generic Worker never trusts identity headers.
import worker from "./worker.mjs";
import { constant } from "./security.mjs";
import { privateSession } from "./sites-session.mjs";
import { seed, createUser } from "../tools/seed.mjs";
import { assetFetch } from "../.runtime/sites-assets.mjs";
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/internal/setup") {
      if (
        req.method !== "POST" ||
        !env.SETUP_SECRET ||
        !constant(
          req.headers.get("Authorization"),
          "Bearer " + env.SETUP_SECRET,
        )
      )
        return new Response("Not found", { status: 404 });
      const b = await req.json();
      if (b.action === "close-qa") {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE users SET active=0 WHERE email='qa@deserto.invalid'",
          ),
          env.DB.prepare(
            "DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE email='qa@deserto.invalid')",
          ),
        ]);
        return Response.json({ ok: true, qa_disabled: true });
      }
      await seed(env.DB);
      if (
        typeof b.qa_password === "string" &&
        b.qa_password.length >= 32 &&
        !(await env.DB.prepare(
          "SELECT id FROM users WHERE email='qa@deserto.invalid'",
        ).first())
      )
        await createUser(env.DB, {
          email: "qa@deserto.invalid",
          name: "DEMO QA",
          password: b.qa_password,
          owner: true,
        });
      return Response.json({ ok: true, seeded: true });
    }
    return worker.fetch(req, {
      ...env,
      ASSETS: { fetch: assetFetch },
      PRIVATE_SITES_SESSION: privateSession,
    });
  },
};
