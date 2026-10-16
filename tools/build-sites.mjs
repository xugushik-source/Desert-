import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const target = path.resolve(process.argv[2] || ".");
const root = path.resolve(new URL("..", import.meta.url).pathname);
const assets = {};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".md": "text/plain; charset=utf-8",
};
for (const file of fs.readdirSync(path.join(root, "public"), {
  recursive: true,
})) {
  const abs = path.join(root, "public", file);
  if (fs.statSync(abs).isFile())
    assets["/" + file.replaceAll("\\", "/")] = [
      mime[path.extname(file)] || "application/octet-stream",
      fs.readFileSync(abs).toString("base64"),
    ];
}
fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".runtime/sites-assets.mjs"),
  "const assets=" +
    JSON.stringify(assets) +
    ';export async function assetFetch(req){let p;try{p=decodeURIComponent(new URL(req.url).pathname)}catch{return new Response(null,{status:400})}if(p==="/")p="/index.html";const a=assets[p];if(!a)return new Response("Not found",{status:404});return new Response(req.method==="HEAD"?null:Uint8Array.from(atob(a[1]),c=>c.charCodeAt(0)),{headers:{"Content-Type":a[0],"Cache-Control":p==="/index.html"?"no-cache":"public,max-age=300"}})}',
);
fs.mkdirSync(path.join(target, "worker"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/sites.mjs")],
  outfile: path.join(target, "worker/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
fs.mkdirSync(path.join(target, "dist/server"), { recursive: true });
fs.mkdirSync(path.join(target, "dist/.openai/drizzle/meta"), {
  recursive: true,
});
fs.copyFileSync(
  path.join(target, "worker/index.js"),
  path.join(target, "dist/server/index.js"),
);
fs.copyFileSync(
  path.join(target, ".openai/hosting.json"),
  path.join(target, "dist/.openai/hosting.json"),
);
// Preserve the deployed first migration byte-for-byte; append a second migration.
const migrationFiles=[['0001_marketplace.sql','0000_marketplace',1792108800000],['0002_promotions_settlements.sql','0001_promotions_settlements',1792152000000]];
for(const [file,tag] of migrationFiles) fs.copyFileSync(path.join(root,'migrations',file),path.join(target,'dist/.openai/drizzle',tag+'.sql'));
fs.writeFileSync(path.join(target,'dist/.openai/drizzle/meta/_journal.json'),JSON.stringify({version:'7',dialect:'sqlite',entries:migrationFiles.map(([,tag,when],idx)=>({idx,version:'6',when,tag,breakpoints:false}))}));
console.log(
  "Packaged DESERTO Worker with " +
    Object.keys(assets).length +
    " embedded assets and existing schema migration.",
);
