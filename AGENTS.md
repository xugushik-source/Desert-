# DESERTO

- SWEET HOUSE is a separate source repository. Keep its files and deployment unchanged. This checkout is the independent Desert- project.
- Use the `feature/deserto-marketplace` branch. Do not merge or deploy production implicitly.
- Runtime: Node 24 for local tools/tests; Cloudflare Worker ES modules + one dedicated D1 for deployment. No second database or production IDs in demo configuration.
- All seller data and permissions are scoped to `vendor_id`. Never accept a role or verified payment from the browser. Keep guest order capabilities and session credentials private.
- D1 prepared statements are immutable when bound. Keep LocalD1 compatible with that contract. Batch order writes atomically; use version guards, idempotency and rollback tests.
- Store money as integer minor units. Unknown costs stay null. Purchase cost, sales, cash received and profit are distinct concepts.
- Changes to order contents or price need explicit customer approval. Retain original order snapshots and events.
- Demo data are marked; no invented real prices, stock, addresses, partner claims or profit. No real payment, Telegram or Google side effects in tests.
- Preserve RU/KA/EN parity, keyboard access, responsive layout and reduced-motion behavior. Do not hide content when animation fails.
- Run `npm test` and `npm run build` after meaningful code changes. Browser QA limitations must be reported honestly.
- Never commit `.runtime`, `.wrangler`, `.dev.vars`, `.env`, credentials or customer data. The bootstrap contains a NEW demo database only, never an export of live data.
