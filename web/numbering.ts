// Section-number state (article class) carried across \input files, so a file included after
// \appendix starts in the appendix. No imports: tests run it under plain node.
export interface NumState { counters: number[]; appendix: boolean }
const HEADING = /^\s*\\(section|subsection|subsubsection)\s*\{/; // starred ones do not match: unnumbered
const INPUT = /\\(?:input|include)\{([^}]+)\}/g;

/** Advance `st` over one source line (comment already ignored by the caller's cut). */
export function advance(st: NumState, code: string) {
  if (/\\appendix\b/.test(code)) { st.counters = [0, 0, 0]; st.appendix = true; }
  const h = HEADING.exec(code);
  if (h) {
    const lvl = h[1] === "section" ? 1 : h[1] === "subsection" ? 2 : 3;
    st.counters[lvl - 1]++;
    for (let i = lvl; i < 3; i++) st.counters[i] = 0;
  }
}

export function numberOf(st: NumState, lvl: number): string {
  const top = st.appendix ? String.fromCharCode(64 + st.counters[0]) : String(st.counters[0]);
  return [top, ...st.counters.slice(1, lvl)].join(".");
}

/** State at the start of every file, walking the \input tree from `root` in document order. */
export function fileStarts(root: string, texts: Record<string, string>): Record<string, NumState> {
  const out: Record<string, NumState> = {};
  const st: NumState = { counters: [0, 0, 0], appendix: false };
  const walk = (path: string, stack: string[]) => {
    if (texts[path] === undefined || stack.includes(path)) return;
    if (!(path in out)) out[path] = { counters: [...st.counters], appendix: st.appendix };
    for (const line of texts[path].split("\n")) {
      const m = /(?<!\\)%/.exec(line);
      const code = m ? line.slice(0, m.index) : line;
      advance(st, code);
      for (const x of code.matchAll(INPUT)) {
        const n = x[1].trim();
        walk(n.endsWith(".tex") ? n : n + ".tex", [...stack, path]);
      }
    }
  };
  walk(root, []);
  return out;
}

export interface Heading { file: string; line: number; level: number; num: string; title: string; words: number }
const ANY_HEAD = /^\s*\\(section|subsection|subsubsection)(\*?)\s*\{/;
const SKIP_ENV = /\\(begin|end)\{(table\*?|figure\*?|longtable|tabular\*?|tabularx|threeparttable|equation\*?|align\*?|gather\*?|multline\*?|verbatim|lstlisting|tikzpicture|thebibliography)\}/g;
const KEY_ARG = /\\(label|ref|eqref|autoref|cref|Cref|pageref|cite[a-z]*|parencite|textcite|input|include|includegraphics|url|href|begin|end|vspace|hspace)\*?(\[[^\]]*\])*\{[^}]*\}/g;

/** Words of running text on one source line (math, markup and keys left out). */
export function words(code: string): number {
  const t = code.replace(/\$[^$]*\$/g, " ").replace(KEY_ARG, " ").replace(/\\[A-Za-z@]+\*?/g, " ");
  return (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** Headings in reading order across the \input tree, numbered like the editor, each with the words
 *  of its section (subsections included). Text in floats, display math and listings is not counted. */
export function outline(root: string, texts: Record<string, string>): { heads: Heading[]; words: number } {
  const heads: Heading[] = [], st: NumState = { counters: [0, 0, 0], appendix: false };
  const open: Heading[] = [];
  let inDoc = !/\\begin\{document\}/.test(texts[root] ?? ""), skip = 0, total = 0;
  const walk = (path: string, stack: string[]) => {
    if (texts[path] === undefined || stack.includes(path)) return;
    texts[path].split("\n").forEach((line, i) => {
      const m = /(?<!\\)%/.exec(line);
      const code = m ? line.slice(0, m.index) : line;
      if (/\\begin\{document\}/.test(code)) { inDoc = true; return; }
      if (/\\end\{document\}/.test(code)) inDoc = false;
      advance(st, code);
      const h = ANY_HEAD.exec(code);
      if (h && inDoc) {
        const level = h[1] === "section" ? 1 : h[1] === "subsection" ? 2 : 3;
        while (open.length && open[open.length - 1].level >= level) open.pop();
        let d = 0, j = h[0].length, title = "";
        for (; j < code.length; j++) { const c = code[j]; if (c === "{") d++; else if (c === "}" && d-- === 0) break; title += c; }
        title = title.replace(/\\[A-Za-z@]+\*?/g, "").replace(/[{}$]/g, "").replace(/~/g, " ").trim();
        const hd = { file: path, line: i + 1, level, num: h[2] ? "" : numberOf(st, level), title, words: 0 };
        heads.push(hd); open.push(hd);
      } else if (inDoc) {
        const was = skip;
        for (const e of code.matchAll(SKIP_ENV)) skip = Math.max(0, skip + (e[1] === "begin" ? 1 : -1));
        if (!was && !skip) { const w = words(code); total += w; open.forEach((o) => (o.words += w)); }
      }
      for (const x of code.matchAll(INPUT)) {
        const n = x[1].trim();
        walk(n.endsWith(".tex") ? n : n + ".tex", [...stack, path]);
      }
    });
  };
  walk(root, []);
  return { heads, words: total };
}
