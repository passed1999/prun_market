// 把 src/services 打包后在 node 里跑，fetch 指向 fixtures/，输出 out/ts_*.json 供比对。
//   node scripts/check_port/run_ts.mjs
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const FIX = resolve(HERE, "fixtures");
const OUT = resolve(HERE, "out");
mkdirSync(OUT, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(HERE, "entry.ts")],
  bundle: true, format: "esm", platform: "node", target: "es2022",
  outfile: resolve(OUT, "bundle.mjs"),
  alias: { "vue": resolve(HERE, "vue-stub.ts"), "@services": resolve(ROOT, "src/services") },
});

globalThis.fetch = async (url) => {
  const path = String(url).replace(/\?.*$/, "");
  let file, m;
  if ((m = path.match(/^\/api\/fio(\/.*)$/))) file = `${FIX}/fio${m[1]}`;
  else if (path === "/api/pp/data/exchanges/") file = `${FIX}/pp/data/exchanges/index.json`;
  else if ((m = path.match(/^\/api\/stats\/(.*)$/))) file = `${FIX}/stats/${m[1]}`;
  else throw new Error("unexpected " + path);
  return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
};

const mod = await import(pathToFileURL(resolve(OUT, "bundle.mjs")).href);
const out = await mod.run(process.env.CHECK_MONTH || "sep26");
for (const [name, value] of Object.entries(out)) {
  writeFileSync(resolve(OUT, `ts_${name}.json`), JSON.stringify(value, null, 1));
}
console.log("ts done:", Object.keys(out).join(", "));
