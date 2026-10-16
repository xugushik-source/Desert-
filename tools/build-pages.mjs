import { migrateLocal } from "./migrate-local.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalD1 } from './sqlite.mjs';
import { seed } from './seed.mjs';
import { handle } from '../src/worker.mjs';
export async function buildPages(output = new URL('../dist/pages/', import.meta.url)) {
  const out = typeof output === 'string' ? output : fileURLToPath(output);
  await fs.mkdir(out, { recursive: true });
  await fs.cp(new URL('../public/', import.meta.url), out, { recursive: true });
  // Fresh synthetic data only: never export an existing database or its users/orders.
  const db = new LocalD1();
  try {
    migrateLocal(db);
    await seed(db);
    const snapshots = {};
    async function capture(route) {
      const response = await handle(new Request('https://example.invalid/api/' + route), { DB: db });
      if (!response.ok) throw new Error('Cannot build public demo: ' + route);
      snapshots[route] = await response.json();
    }
    await capture('cities');
    await capture('session');
    for (const city of snapshots.cities.cities) {
      const route = 'vendors?city=' + city.id;
      await capture(route);
      for (const vendor of snapshots[route].vendors) await capture('catalog?vendor=' + vendor.id);
    }
    const snapshot = JSON.stringify(snapshots).replaceAll('/media/', './media/');
    const adapter = `const snapshots = ${snapshot};\nexport async function pagesApi(route, body) {\n if (body !== undefined || !Object.hasOwn(snapshots, route)) throw {code:'PAGES_READ_ONLY'};\n return structuredClone(snapshots[route]);\n}\n`;
    await fs.writeFile(path.join(out, 'pages-api.js'), adapter);
  } finally { db.close(); }
  let html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  html = html.replace('href="/app.css"', 'href="./app.css"').replace('src="/app.js"', 'src="./app.js"');
  await fs.writeFile(path.join(out, 'index.html'), html);
  let app = await fs.readFile(path.join(out, 'app.js'), 'utf8');
  const notices = {
    ru: 'Витрина GitHub Pages: каталог и корзина доступны. Оформление заказов и кабинет ожидают подключения сервера.',
    ka: 'GitHub Pages: კატალოგი და კალათა ხელმისაწვდომია. შეკვეთა და კაბინეტი ელოდება სერვერის დაკავშირებას.',
    en: 'GitHub Pages: catalogue and basket available. Checkout and staff access await a connected server.'
  };
  app = `import { pagesApi } from './pages-api.js';\n` + app;
  app = app.replace('async function api(path, body) {', 'async function api(path, body) { return pagesApi(path, body);');
  app = app.replace('function header() {', `function header() { for (const [lang, text] of Object.entries(${JSON.stringify(notices)})) words[lang].demo = text;`);
  app = app.replace('async function checkout() {', 'async function checkout() { return pagesNotice();');
  app = app.replace('async function cabinet() {', 'async function cabinet() { return pagesNotice();');
  app = app.replace('function joinModal(invite) {', 'function joinModal(invite) { return pagesNotice();');
  app = app.replace('async function api(path, body)', `function pagesNotice() { modal('DESERTO', '<p>' + esc(t('demo')) + '</p>'); }\nasync function api(path, body)`);
  app = app.replaceAll('/media/', './media/');
  await fs.writeFile(path.join(out, 'app.js'), app);
  await fs.writeFile(path.join(out, '.nojekyll'), '');
  return out;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildPages());
