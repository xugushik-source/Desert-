import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPages } from '../tools/build-pages.mjs';
test('Pages exports public synthetic catalogues only and refuses all writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deserto-pages-'));
  try {
    await buildPages(dir);
    const { pagesApi } = await import(pathToFileURL(path.join(dir, 'pages-api.js')));
    assert.equal((await pagesApi('cities')).cities.length, 2);
    assert.equal((await pagesApi('session')).user, null);
    for (const city of (await pagesApi('cities')).cities) {
      for (const vendor of (await pagesApi('vendors?city=' + city.id)).vendors) {
        const catalog = await pagesApi('catalog?vendor=' + vendor.id);
        assert.equal(catalog.products.length, 36);
        assert.ok(catalog.products.every(p => p.vendor_id === vendor.id && p.image.startsWith('./media/')));
      }
    }
    await assert.rejects(pagesApi('orders', {phone:'never-send'}), {code:'PAGES_READ_ONLY'});
    await assert.rejects(pagesApi('cities', {}), {code:'PAGES_READ_ONLY'});
    await assert.rejects(pagesApi('manage/orders'), {code:'PAGES_READ_ONLY'});
    const html = await fs.readFile(path.join(dir,'index.html'),'utf8');
    assert.match(html,/src="\.\/app\.[a-f0-9]{16}\.js"/);
    const app = await fs.readFile(path.join(dir,'app.js'),'utf8');
    assert.ok(app.includes('async function checkout() { return pagesNotice();'));
    assert.ok(app.includes('async function cabinet() { return pagesNotice();'));
  } finally { await fs.rm(dir, {recursive:true,force:true}); }
});
