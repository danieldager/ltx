// LaTeX source -> HTML for the word view: inline prose, KaTeX math, tables. Pure functions.
import katex from "katex";

export type Macros = Record<string, { nargs: number; body: string }>;
export let macros: Macros = {};
const memo = new Map<string, string | null>();
export function setMacros(m: Macros | undefined) { macros = m ?? {}; memo.clear(); }
export function cached(key: string, fn: () => string | null): string | null {
  if (!memo.has(key)) { let v: string | null = null; try { v = fn(); } catch { /* fall back */ } memo.set(key, v); }
  return memo.get(key)!;
}

export const FMT: Record<string, string> = { emph: "ltx-w-it", textit: "ltx-w-it", textsl: "ltx-w-it", textbf: "ltx-w-b", textsc: "ltx-w-sc",
  underline: "ltx-w-u", texttt: "ltx-w-tt", paragraph: "ltx-w-b", subparagraph: "ltx-w-b" };
export const REF = /^(ref|eqref|autoref|cref|Cref|pageref|vref)$/;
export const CITE = /^(cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|nocite)$/;
// hidden together with N brace arguments
export const ARGS: Record<string, number> = { label: 1, input: 1, include: 1, includegraphics: 1, lstinputlisting: 1, bibliography: 1, bibliographystyle: 1,
  usepackage: 1, documentclass: 1, url: 1, nolinkurl: 1, vspace: 1, hspace: 1, setlength: 2, setcounter: 2, addtolength: 2, thispagestyle: 1,
  pagenumbering: 1, pagestyle: 1, hypersetup: 1, geometry: 1, definecolor: 3, color: 1, pagecolor: 1, href: 1, cline: 1 };

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function groupEnd(doc: string, open: number): number {
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    const c = doc[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return doc.length;
}

export function macroColor(name: string, d = 0): string | null {
  const b = macros[name]?.body ?? "";
  const c = /\\textcolor\{([A-Za-z]+)\}/.exec(b);
  if (c) return c[1];
  const n = /^\\([A-Za-z@]+)/.exec(b);
  return n && d < 5 ? macroColor(n[1], d + 1) : null;
}

export function mathHtml(src: string, display: boolean): string | null {
  if (!src.trim()) return null;
  return cached(`${display ? "D" : "I"}${src}`, () => katex.renderToString(src, {
    displayMode: display, throwOnError: true, strict: "ignore", output: "html",
    macros: Object.fromEntries(Object.entries(macros).map(([k, v]) => ["\\" + k, v.body])),
  }));
}

const NAMED_COLOR = /^[A-Za-z]+$/;

export function inl(s: string, d = 0): string {
  let o = "", i = 0;
  const re = /\\([A-Za-z@]+)\*?/y;
  const grp = (): string | null => {
    let j = i; while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] !== "{") return null;
    const e = groupEnd(s, j); const g = s.slice(j + 1, e - 1); i = e; return g;
  };
  const opt = () => { const m = /^\s*\[[^\]]*\]/.exec(s.slice(i)); if (m) i += m[0].length; };
  while (i < s.length) {
    const c = s[i];
    if (c === "%") { const n = s.indexOf("\n", i); i = n < 0 ? s.length : n; continue; }
    if (c === "$") {
      const j = s.indexOf("$", i + 1);
      if (j > 0) { const src = s.slice(i + 1, j); o += mathHtml(src, false) ?? `<span class="ltx-math">${esc(src)}</span>`; i = j + 1; continue; }
    }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "~") { o += "&nbsp;"; i++; continue; }
    if (s.startsWith("``", i)) { o += "“"; i += 2; continue; }
    if (s.startsWith("''", i)) { o += "”"; i += 2; continue; }
    if (s.startsWith("---", i)) { o += "—"; i += 3; continue; }
    if (s.startsWith("--", i)) { o += "–"; i += 2; continue; }
    if (c !== "\\") { o += esc(c); i++; continue; }
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) {
      const x = s[i + 1] ?? "";
      if (x === "\\") { o += "<br>"; i += 2; continue; }
      o += "%&$#_{}".includes(x) && x ? esc(x) : ",;!: ".includes(x) && x ? " " : "";
      i += 2; continue;
    }
    i = re.lastIndex;
    const name = m[1];
    if (name in FMT) { const a = grp(); if (a !== null) o += `<span class="${FMT[name]}">${inl(a, d)}</span>`; }
    else if (name === "textcolor") { const c1 = grp(), a = grp(); if (a !== null) o += `<span style="color:${NAMED_COLOR.test(c1 ?? "") ? c1 : "inherit"}">${inl(a, d)}</span>`; }
    else if (REF.test(name) || CITE.test(name)) { opt(); grp(); o += `<span class="ltx-ref">[${REF.test(name) ? "ref" : "cite"}]</span>`; }
    else if (name in ARGS) { opt(); for (let k = 0; k < ARGS[name]; k++) grp(); }
    else if (name === "multicolumn") { grp(); grp(); const a = grp(); if (a !== null) o += inl(a, d); }
    else if (name === "item") o += "• ";
    else if (name === "begin" || name === "end") { grp(); opt(); }
    else if (name === "thanks") grp();
    else if (name === "tnote" || name === "textsuperscript") { const a = grp(); if (a !== null) o += `<sup>${inl(a, d)}</sup>`; }
    else if (name === "and") o += "&emsp;";
    else if (macros[name] && d < 8) {
      const args: string[] = [];
      for (let k = 0; k < macros[name].nargs; k++) args.push(grp() ?? "");
      o += inl(macros[name].body.replace(/#(\d)/g, (_, k) => args[+k - 1] ?? ""), d + 1);
    } else if (s[i] === " ") i++;
  }
  return o;
}

// ---- tables ----

const RULES = /\\(toprule|midrule|bottomrule|hline|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\}|addlinespace(?:\[[^\]]*\])?|endhead|endfirsthead|endfoot|endlastfoot)(?![A-Za-z])/g;

function specAligns(spec: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if ("@><!".includes(c) && spec[i + 1] === "{") i = groupEnd(spec, i + 1) - 1;
    else if ("lcr".includes(c)) out.push(c);
    else if ("pmbXS".includes(c)) { out.push("l"); if (spec[i + 1] === "{") i = groupEnd(spec, i + 1) - 1; }
  }
  return out;
}

function splitRows(s: string): string[][] {
  const rows: string[][] = [[]];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "\\" && depth === 0) { rows[rows.length - 1].push(cur); cur = ""; rows.push([]); i++; const o = /^\[[^\]]*\]/.exec(s.slice(i + 1)); if (o) i += o[0].length; continue; }
      cur += c + (s[++i] ?? ""); continue;
    }
    if (c === "{") depth++; else if (c === "}") depth--;
    if (c === "&" && depth === 0) { rows[rows.length - 1].push(cur); cur = ""; continue; }
    cur += c;
  }
  rows[rows.length - 1].push(cur);
  return rows;
}

function grid(full: string, env: string): { spec: string; body: string } | null {
  const b = new RegExp(`\\\\begin\\{${env.replace("*", "\\*")}\\}`).exec(full);
  if (!b) return null;
  let p = b.index + b[0].length;
  const take = (): string => { const m = /^\s*\{/.exec(full.slice(p)); if (!m) throw 0; const o = p + m[0].length - 1; const e = groupEnd(full, o); p = e; return full.slice(o + 1, e - 1); };
  if (env === "tabular*" || env === "tabularx") { take(); }
  const o = /^\s*\[[^\]]*\]/.exec(full.slice(p)); if (o) p += o[0].length;
  const spec = take();
  const end = full.indexOf(`\\end{${env}}`, p);
  return { spec, body: full.slice(p, end < 0 ? full.length : end) };
}

const clean = (s: string) => s.replace(/(?<!\\)%.*$/gm, "");

export function tableHtml(full: string): string | null {
  full = clean(full);
  const nm = /\\begin\{tablenotes\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{tablenotes\}/.exec(full);
  const notesSrc = nm ? nm[1] : "";
  if (nm) full = full.replace(nm[0], "");
  const env = (/\\begin\{(longtable|tabular\*|tabularx|tabular)\}/.exec(full) ?? [])[1];
  if (!env) return null;
  const g = grid(full, env);
  if (!g) return null;
  let body = g.body, cap = "";
  const cm = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(full);
  if (cm) {
    const o = cm.index + cm[0].length - 1;
    cap = full.slice(o + 1, groupEnd(full, o) - 1);
    const m = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(body);
    if (m) body = body.slice(0, m.index) + body.slice(groupEnd(body, m.index + m[0].length - 1));
  }
  body = body.replace(/\\label\{[^}]*\}/g, "");
  if (/\\endfirsthead/.test(body)) body = body.replace(/\\endfirsthead[\s\S]*?\\endhead/, "\\endhead");
  body = body.replace(/\\endhead[\s\S]*?\\endlastfoot/, "").replace(/\\endhead[\s\S]*?\\endfoot[\s\S]*?(?=\\midrule|\\toprule|\\hline|$)/, "");
  body = body.replace(RULES, "\u0001");
  const aligns = specAligns(g.spec);
  const rows = splitRows(body).map((cells) => ({ rule: cells[0].trim().startsWith("\u0001"), cells: cells.map((c) => c.replace(/\u0001/g, "").trim()) }))
    .filter((r) => r.cells.some((c) => c));
  if (!rows.length) return null;
  const first = rows.findIndex((r, i) => i > 0 && r.rule);
  const headRows = first > 0 ? first : 0;
  let html = "";
  rows.forEach((r, ri) => {
    const tag = ri < headRows ? "th" : "td";
    let col = 0;
    html += "<tr>" + r.cells.map((c) => {
      let span = 1, al = aligns[col] ?? "l", txt = c;
      const mc = /^\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*\{([\s\S]*)\}$/.exec(c);
      if (mc) { span = +mc[1]; al = specAligns(mc[2])[0] ?? al; txt = mc[3]; }
      col += span;
      return `<${tag}${span > 1 ? ` colspan="${span}"` : ""} style="text-align:${{ l: "left", c: "center", r: "right" }[al]}">${inl(txt)}</${tag}>`;
    }).join("") + "</tr>";
  });
  const notes = notesSrc.replace(/\\(footnotesize|scriptsize|small)\b/g, "").split(/\\item\s*(?:\[([^\]]*)\])?/);
  let nh = notes[0].trim() ? `<div>${inl(notes[0])}</div>` : "";
  for (let k = 1; k < notes.length; k += 2) if (notes[k + 1]?.trim() || notes[k]) nh += `<div>${notes[k] ? inl(notes[k]) + " " : ""}${inl(notes[k + 1] ?? "")}</div>`;
  return `<div class="ltx-tblwrap">${cap ? `<div class="ltx-tcap">${inl(cap)}</div>` : ""}<table class="ltx-tbl${headRows ? " has-head" : ""}"><tbody>${html}</tbody></table>${nh ? `<div class="ltx-tnotes">${nh}</div>` : ""}</div>`;
}
