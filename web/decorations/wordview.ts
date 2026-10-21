// Word-like view: with "LaTeX" off, markup is replaced away and only prose remains. The text
// is never changed; hidden ranges are atomic so the cursor skips them.
import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export const setWord = StateEffect.define<boolean>();

class Txt extends WidgetType {
  constructor(readonly text: string, readonly cls: string, readonly block = false) { super(); }
  eq(o: Txt) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { const e = document.createElement(this.block ? "div" : "span"); e.className = this.cls; e.textContent = this.text; return e; }
}

const CHIP_ENVS = /^(table\*?|figure\*?|longtable|tabular\*?|tabularx|threeparttable|equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|verbatim|lstlisting|tikzpicture)$/;
const FMT: Record<string, string> = { emph: "ltx-w-it", textit: "ltx-w-it", textsl: "ltx-w-it", textbf: "ltx-w-b", textsc: "ltx-w-sc",
  underline: "ltx-w-u", texttt: "ltx-w-tt", paragraph: "ltx-w-b", subparagraph: "ltx-w-b" };
const REF = /^(ref|eqref|autoref|cref|Cref|pageref|vref)$/;
const CITE = /^(cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|nocite)$/;
// hidden with N brace arguments
const ARGS: Record<string, number> = { label: 1, input: 1, include: 1, includegraphics: 1, lstinputlisting: 1, bibliography: 1, bibliographystyle: 1,
  usepackage: 1, documentclass: 1, url: 1, nolinkurl: 1, vspace: 1, hspace: 1, setlength: 2, setcounter: 2, addtolength: 2, thispagestyle: 1,
  pagenumbering: 1, pagestyle: 1, hypersetup: 1, geometry: 1, definecolor: 3, color: 1, pagecolor: 1, textcolor: 1, href: 1, cline: 1 };
const TOK = /(?<!\\)%.*$|\\\\(?:\[[^\]]*\])?|\\[A-Za-z@]+\*?|\\[^A-Za-z@]|\$[^$]*\$|[{}~]/g;
const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });

function groupEnd(doc: string, open: number): number {
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    const c = doc[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return doc.length;
}

function chipLabel(env: string, body: string): string {
  const m = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(body);
  if (!m) return `[${env.replace("*", "")}]`;
  const open = m.index + m[0].length - 1;
  const cap = body.slice(open + 1, groupEnd(body, open) - 1)
    .replace(/\\label\{[^}]*\}/g, "").replace(/\\[A-Za-z]+\*?/g, "").replace(/[{}~]/g, " ").replace(/\s+/g, " ").trim();
  return `[${env.replace("*", "")}: ${cap.length > 90 ? cap.slice(0, 90) + "…" : cap}]`;
}

function build(state: EditorState): DecorationSet {
  const doc = state.doc, text = doc.toString(), out: Range<Decoration>[] = [];
  let pend: [number, number] | null = null; // consecutive fully hidden lines
  const flush = () => { if (pend) out.push(Decoration.replace({ block: true }).range(doc.line(pend[0]).from, doc.line(pend[1]).to)); pend = null; };
  const hideLine = (n: number) => { if (pend && pend[1] === n - 1) pend[1] = n; else { flush(); pend = [n, n]; } };

  const bd = text.search(/\\begin\{document\}/);
  let n = bd < 0 ? 1 : doc.lineAt(bd).number + 1;
  if (bd >= 0) pend = [1, n - 1];
  let prevBlank = true; // collapse runs of blank lines
  const lists: { enumerate: boolean; count: number }[] = [];

  for (; n <= doc.lines; n++) {
    const ln = doc.line(n), t = ln.text;
    const cb = /^\s*\\begin\{([^}]+)\}/.exec(t);
    if (cb && CHIP_ENVS.test(cb[1])) {
      let depth = 0, e = n;
      const re = new RegExp(`\\\\(begin|end)\\{${cb[1].replace("*", "\\*")}\\}`, "g");
      for (; e <= doc.lines; e++) {
        for (const m of doc.line(e).text.matchAll(re)) depth += m[1] === "begin" ? 1 : -1;
        if (depth <= 0) break;
      }
      e = Math.min(e, doc.lines);
      flush();
      out.push(Decoration.replace({ widget: new Txt(chipLabel(cb[1], doc.sliceString(ln.from, doc.line(e).to)), "ltx-chip", true), block: true }).range(ln.from, doc.line(e).to));
      n = e;
      continue;
    }

    const ranges: Range<Decoration>[] = [], hidden: [number, number][] = [];
    let widgets = 0;
    const cut = (s: number, e: number) => { hidden.push([s, e]); ranges.push(hide.range(s, e)); };
    const widget = (s: number, e: number, w: Txt) => { widgets++; ranges.push(Decoration.replace({ widget: w }).range(s, e)); };
    const eat = (p: number, args: number) => { // position after optional [..] and `args` {..} groups
      const rest = () => text.slice(p, ln.to);
      const o = /^\s*\[[^\]]*\]/.exec(rest());
      if (o) p += o[0].length;
      for (let i = 0; i < args; i++) {
        const g = /^\s*\{/.exec(rest());
        if (!g) break;
        const end = groupEnd(text, p + g[0].length - 1);
        if (end > ln.to) break;
        p = end;
      }
      return p;
    };

    TOK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOK.exec(t))) {
      const s = ln.from + m.index, tk = m[0];
      let e = s + tk.length;
      if (tk[0] === "%") { let b = s; while (b > ln.from && /\s/.test(text[b - 1])) b--; cut(b, e); }
      else if (tk[0] === "$") ranges.push(mark("ltx-math").range(s, e));
      else if (tk === "{" || tk === "}") cut(s, e);
      else if (tk === "~") widget(s, e, new Txt(" ", ""));
      else if (tk.startsWith("\\\\")) cut(s, e);
      else if (/^\\[^A-Za-z@]/.test(tk)) {
        if (tk[1] === " ") widget(s, e, new Txt(" ", ""));
        else if (",;!:".includes(tk[1])) cut(s, e);
        else cut(s, s + 1);
      } else {
        const name = tk.slice(1).replace(/\*$/, "");
        if (name === "begin" || name === "end") {
          const env = /^\{([^}]*)\}/.exec(text.slice(e, ln.to));
          if (env && /^(itemize|enumerate)$/.test(env[1])) { if (name === "begin") lists.push({ enumerate: env[1] === "enumerate", count: 0 }); else lists.pop(); }
          e = eat(e, 1);
          cut(s, e);
        } else if (name === "item") {
          const l = lists[lists.length - 1];
          widget(s, e, new Txt(l?.enumerate ? `${++l.count}. ` : "• ", "ltx-bullet"));
          if (text[e] === " ") cut(e, ++e);
        } else if (REF.test(name) || CITE.test(name)) {
          e = eat(e, 1);
          widget(s, e, new Txt(REF.test(name) ? "[ref]" : "[cite]", "ltx-ref"));
        } else if (name in ARGS) {
          e = eat(e, ARGS[name]);
          cut(s, e);
        } else if (name in FMT && text[e] === "{") {
          const close = groupEnd(text, e);
          ranges.push(mark(FMT[name]).range(e + 1, Math.max(e + 1, close - 1)));
          cut(s, e);
        } else {
          if (/^[ \t]$/.test(text[e] ?? "")) e++;
          cut(s, e);
        }
        TOK.lastIndex = e - ln.from;
      }
    }

    // a line with nothing left to show disappears entirely
    let rest = "", p = ln.from;
    for (const [a, b] of hidden.sort((x, y) => x[0] - y[0])) { if (a > p) rest += text.slice(p, a); p = Math.max(p, b); }
    rest += text.slice(p, ln.to);
    if (hidden.length && !widgets && !rest.trim() && !/\\begin\{abstract\}/.test(t)) { hideLine(n); continue; }
    if (!t.trim() && !hidden.length) { if (prevBlank) { hideLine(n); continue; } prevBlank = true; } else prevBlank = false;
    flush();
    out.push(...ranges);
    if (lists.length && rest.trim()) out.push(Decoration.line({ class: "ltx-li" }).range(ln.from));
  }
  flush();
  return Decoration.set(out, true);
}

export const wordView = StateField.define<{ on: boolean; decos: DecorationSet }>({
  create: () => ({ on: false, decos: Decoration.none }),
  update(v, tr) {
    let on = v.on;
    for (const e of tr.effects) if (e.is(setWord)) on = e.value;
    if (on === v.on && !(on && tr.docChanged)) return v;
    return { on, decos: on ? build(tr.state) : Decoration.none };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    EditorView.atomicRanges.of((view) => view.state.field(f).decos),
  ],
});
