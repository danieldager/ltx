// Phase 1 paper structure over the visible source: front page (title/author/date/abstract,
// JEL + keywords), numbered headings (1, 1.1, 1.1.1; A, A.1 after \appendix), footnote
// markers, muted preamble, block environments, first-line paragraph indents.
import { Range, StateEffect } from "@codemirror/state";
import { NumState, advance, numberOf } from "../numbering";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";

class Marker extends WidgetType {
  constructor(readonly text: string, readonly cls: string) { super(); }
  eq(o: Marker) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { const s = document.createElement("span"); s.className = this.cls; s.textContent = this.text; return s; }
}

const BLOCK_ENVS = /^(table\*?|figure\*?|longtable|tabular\*?|tabularx|threeparttable|equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|verbatim|lstlisting|tikzpicture|minipage|center)$/;
const HEAD = /^\s*\\(section|subsection|subsubsection|paragraph)(\*?)\s*\{/;
const LEVEL: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };
const THANKS = ["*", "†", "‡", "§", "¶"];
/** Set by main.ts: numbering state at the start of the view's file (may sit after \\appendix in the root). */
let startOf: (v: EditorView) => NumState | null = () => null;
export const renumber = StateEffect.define<null>();
export function setStartProvider(f: (v: EditorView) => NumState | null) { startOf = f; }
const line = (cls: string) => Decoration.line({ class: cls });

/** End offset (exclusive, after the closing brace) of the {group} starting at `open`. */
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

function build(view: EditorView): DecorationSet {
  const state = view.state, docText = state.doc.toString();
  const decos: Range<Decoration>[] = [];
  const lineCls = new Map<number, string>(); // line number -> class (one per line)
  let thanks = 0;

  // front matter: \title{..} \author{..} \date{..} may span lines
  for (const m of docText.matchAll(/\\(title|author|date)\s*(?=\{)/g)) {
    const open = m.index! + m[0].length, end = groupEnd(docText, open);
    const l1 = state.doc.lineAt(m.index!).number, l2 = state.doc.lineAt(end).number;
    for (let n = l1; n <= l2; n++) lineCls.set(n, `ltx-front ltx-${m[1]}`);
    for (const t of docText.slice(open, end).matchAll(/\\thanks\s*\{/g)) {
      const sym = THANKS[thanks++ % THANKS.length];
      decos.push(Decoration.widget({ widget: new Marker(sym, "ltx-fnmark"), side: -1 }).range(open + t.index!));
    }
  }

  const beginDoc = docText.search(/\\begin\{document\}/);
  const preambleEnd = beginDoc < 0 ? 0 : state.doc.lineAt(beginDoc).number;
  const st0 = startOf(view);
  const st: NumState = { counters: [...(st0?.counters ?? [0, 0, 0])], appendix: st0?.appendix ?? false };
  let inAbstract = false, blockDepth = 0, footnote = 0;
  let prevKind = "blank", lastNonBlank = "head";

  for (let n = 1; n <= state.doc.lines; n++) {
    const ln = state.doc.line(n), t = ln.text;
    if (lineCls.has(n)) { decos.push(line(lineCls.get(n)!).range(ln.from)); prevKind = "front"; continue; }
    if (n <= preambleEnd) { decos.push(line("ltx-preamble").range(ln.from)); continue; }
    const cut = /(?<!\\)%/.exec(t);
    advance(st, cut ? t.slice(0, cut.index) : t);
    if (/\\begin\{abstract\}/.test(t)) inAbstract = true;

    let cls = "", kind = "prose";
    const envs = [...t.matchAll(/\\(begin|end)\{([^}]+)\}/g)].filter((m) => BLOCK_ENVS.test(m[2]));
    const wasBlock = blockDepth > 0;
    for (const m of envs) blockDepth = Math.max(0, blockDepth + (m[1] === "begin" ? 1 : -1));
    const head = HEAD.exec(t);
    if (wasBlock || envs.length) { cls = "ltx-block"; kind = "block"; }
    else if (head) {
      const lvl = LEVEL[head[1]];
      kind = "head";
      cls = `ltx-h${lvl}`;
      if (!head[2] && lvl <= 3) {
        const num = numberOf(st, lvl);
        decos.push(Decoration.widget({ widget: new Marker(num, "ltx-secnum"), side: -1 }).range(ln.from));
      }
    } else if (!t.trim()) kind = "blank";
    else if (/^\s*%/.test(t)) { cls = "ltx-comment-line"; kind = "comment"; }
    else if (/^\s*\\(maketitle|tableofcontents|clearpage|newpage|pagenumbering|thispagestyle|appendix|bibliography|bibliographystyle|begin\{document\}|end\{document\}|label)/.test(t)) {
      cls = "ltx-control"; kind = "control";
    }
    if (inAbstract) {
      cls = /JEL|Keywords/i.test(t) ? "ltx-abstract ltx-jel" : /\\(begin|end)\{abstract\}/.test(t) ? "ltx-abstract ltx-abstract-edge" : "ltx-abstract";
    } else if (kind === "prose") {
      cls = prevKind === "blank" && lastNonBlank === "prose" ? "ltx-prose ltx-indent" : "ltx-prose";
    }
    if (/\\end\{abstract\}/.test(t)) inAbstract = false;
    if (cls) decos.push(line(cls).range(ln.from));
    if (/\\begin\{abstract\}/.test(t)) decos.push(Decoration.widget({ widget: new Marker("Abstract", "ltx-abs-head"), side: 1 }).range(ln.to));

    for (const m of t.matchAll(/\\footnote\s*\{/g)) {
      decos.push(Decoration.widget({ widget: new Marker(String(++footnote), "ltx-fnmark"), side: -1 }).range(ln.from + m.index!));
    }
    if (kind !== "blank") lastNonBlank = kind === "comment" ? lastNonBlank : kind;
    prevKind = kind;
  }
  return Decoration.set(decos, true);
}

export const paperStructure = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(renumber)))) this.decorations = build(u.view); }
}, { decorations: (v) => v.decorations });
