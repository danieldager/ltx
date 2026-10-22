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
