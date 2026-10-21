// Build the frontend into ../src/ltx/static (committed output).
import { build } from "esbuild";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const out = "../src/ltx/static";
await build({ entryPoints: ["main.ts"], bundle: true, format: "esm", target: "es2022",
  outfile: `${out}/app.js`, minify: true, sourcemap: false, logLevel: "info" });
writeFileSync(`${out}/app.css`, readFileSync("style.css", "utf8") + "\n" + readFileSync("paper.css", "utf8"));
copyFileSync("index.html", `${out}/index.html`);
copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", `${out}/pdf.worker.min.mjs`);
