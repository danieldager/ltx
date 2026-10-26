// Build the frontend into ../src/ltx/static (committed output).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = "../src/ltx/static";
// pdf.js and KaTeX are split into chunks loaded on first use (PDF pane shown, LaTeX view off);
// chunk names carry a content hash, so only app.js needs the ?v= cache-bust in index.html
rmSync(`${out}/chunks`, { recursive: true, force: true });
await build({ entryPoints: { app: "main.ts" }, bundle: true, format: "esm", target: "es2022", splitting: true,
  outdir: out, chunkNames: "chunks/[name]-[hash]", minify: true, sourcemap: false, logLevel: "info" });
writeFileSync(`${out}/app.css`, readFileSync("style.css", "utf8") + "\n" + readFileSync("paper.css", "utf8"));
copyFileSync("index.html", `${out}/index.html`);
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", `${out}/pdf.worker.min.mjs`);
mkdirSync(`${out}/katex/fonts`, { recursive: true });
copyFileSync("node_modules/katex/dist/katex.min.css", `${out}/katex/katex.min.css`);
for (const f of readdirSync("node_modules/katex/dist/fonts")) if (f.endsWith(".woff2")) copyFileSync(`node_modules/katex/dist/fonts/${f}`, `${out}/katex/fonts/${f}`);
