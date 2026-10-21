// Build the frontend into ../src/ltx/static (committed output).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const out = "../src/ltx/static";
await build({ entryPoints: ["main.ts"], bundle: true, format: "esm", target: "es2022",
  outfile: `${out}/app.js`, minify: true, sourcemap: false, logLevel: "info" });
writeFileSync(`${out}/app.css`, readFileSync("style.css", "utf8") + "\n" + readFileSync("paper.css", "utf8"));
copyFileSync("index.html", `${out}/index.html`);
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", `${out}/pdf.worker.min.mjs`);
mkdirSync(`${out}/katex/fonts`, { recursive: true });
copyFileSync("node_modules/katex/dist/katex.min.css", `${out}/katex/katex.min.css`);
for (const f of readdirSync("node_modules/katex/dist/fonts")) if (f.endsWith(".woff2")) copyFileSync(`node_modules/katex/dist/fonts/${f}`, `${out}/katex/fonts/${f}`);
