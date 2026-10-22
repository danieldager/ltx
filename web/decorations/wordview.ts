// Word-like view: with "LaTeX" off, markup is replaced away and only prose remains; math renders
// with KaTeX, tables as HTML. The text is never changed; hidden ranges are atomic so the cursor
// skips them. Clicking a rendered widget reveals its source (main.ts handles "ltx-reveal").
import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { reviewChanged, reviewField } from "../review";
import { ARGS, CITE, FMT, REF, labels, cached, esc, groupEnd, inl, macroColor, macros, mathHtml, tableHtml } from "./render";

export { setMacros } from "./render";
export const setWord = StateEffect.define<boolean>();

class Txt extends WidgetType {
  constructor(readonly text: string, readonly cls: string) { super(); }
  eq(o: Txt) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { const e = document.createElement("span"); e.className = this.cls; e.textContent = this.text; return e; }
}

class Html extends WidgetType {
  constructor(readonly html: string, readonly cls: string, readonly block: boolean) { super(); }
  eq(o: Html) { return o.html === this.html && o.cls === this.cls; }
  toDOM() {
    const e = document.createElement(this.block ? "div" : "span");
    e.className = this.cls;
    e.innerHTML = this.block && /ltx-(eq|table)/.test(this.cls) ? `<div class="ltx-fit">${this.html}</div>` : this.html;
    e.onmousedown = (ev) => { ev.preventDefault(); e.dispatchEvent(new CustomEvent("ltx-reveal", { bubbles: true })); };
    return e;
  }
  ignoreEvent() { return true; }
}

const MATH_ENVS = /^(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)$/;
const TABLE_ENVS = /^(table\*?|longtable|tabular\*?|tabularx|threeparttable)$/;
const CHIP_ENVS = /^(figure\*?|verbatim|lstlisting|tikzpicture)$/;
const TOK = /(?<!\\)%.*$|\\\\(?:\[[^\]]*\])?|\\[A-Za-z@]+\*?|\\[^A-Za-z@]|\$[^$]*\$|[{}~]|``|''|---|--/g;
const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });

function chipLabel(env: string, body: string): string {
  const m = /\\caption(?:\[[^\]]*\])?\s*\{/.exec(body);
  if (!m) return `[${env.replace("*", "")}]`;
  const open = m.index + m[0].length - 1;
  const cap = body.slice(open + 1, groupEnd(body, open) - 1)
    .replace(/\\label\{[^}]*\}/g, "").replace(/\\[A-Za-z]+\*?/g, "").replace(/[{}~]/g, " ").replace(/\s+/g, " ").trim();
  return `[${env.replace("*", "")}: ${cap.length > 90 ? cap.slice(0, 90) + "…" : cap}]`;
}

function mathSrc(env: string, body: string): string {
  let s = body.replace(/\\(label|nonumber|notag)(\{[^}]*\})?/g, "").replace(/(?<!\\)%.*$/gm, "");
  if (/^(align|eqnarray)/.test(env)) s = `\\begin{aligned}${s}\\end{aligned}`;
  else if (env.startsWith("gather")) s = `\\begin{gathered}${s}\\end{gathered}`;
  return s;
}

function titleBlock(pre: string): string {
  pre = pre.replace(/(?<!\\)%.*$/gm, "");
  const get = (k: string) => { const m = new RegExp(`\\\\${k}\\s*\\{`).exec(pre); return m ? pre.slice(m.index + m[0].length, groupEnd(pre, m.index + m[0].length - 1) - 1) : ""; };
  const t = get("title"), a = get("author"), d = get("date");
  if (!t && !a && !d) return "";
  return `${t ? `<div class="ltx-t-title">${inl(t)}</div>` : ""}${a ? `<div class="ltx-t-author">${inl(a)}</div>` : ""}${d ? `<div class="ltx-t-date">${inl(d)}</div>` : ""}`;
}

function build(state: EditorState): DecorationSet {
  const doc = state.doc, text = doc.toString(), out: Range<Decoration>[] = [];
  let pend: [number, number] | null = null; // consecutive fully hidden lines
  const flush = () => { if (pend) out.push(Decoration.replace({ block: true }).range(doc.line(pend[0]).from, doc.line(pend[1]).to)); pend = null; };
  const hideLine = (n: number) => { if (pend && pend[1] === n - 1) pend[1] = n; else { flush(); pend = [n, n]; } };
  const rv = state.field(reviewField, false)?.located ?? [];
  const block = (from: number, to: number, w: Html) => {
    if (rv.some((r) => r.to >= from && r.from <= to)) w = new Html(w.html, w.cls + " ltx-tint", true); // suggestion/comment inside: tint the widget
    flush(); out.push(Decoration.replace({ widget: w, block: true }).range(from, to)); };
  const chip = (label: string) => new Html(esc(label), "ltx-chip", true);

  const bd = text.search(/\\begin\{document\}/);
  let n = bd < 0 ? 1 : doc.lineAt(bd).number + 1;
  if (bd >= 0) {
    const tb = titleBlock(text.slice(0, bd));
    if (tb) block(0, doc.line(n - 1).to, new Html(tb, "ltx-titleblock", true)); else pend = [1, n - 1];
  }
  let prevBlank = true; // collapse runs of blank lines
  const lists: { enumerate: boolean; count: number }[] = [];

  for (; n <= doc.lines; n++) {
    const ln = doc.line(n), t = ln.text;
    const cb = /^\s*\\begin\{([^}]+)\}/.exec(t);
    const dm = !cb && /^\s*\\\[/.test(t);
    const env = cb?.[1];
    if (dm || (env && (MATH_ENVS.test(env) || TABLE_ENVS.test(env) || CHIP_ENVS.test(env)))) {
      let e = n;
      if (dm) { while (e < doc.lines && !doc.line(e).text.includes("\\]")) e++; }
      else {
        let depth = 0;
        const re = new RegExp(`\\\\(begin|end)\\{${env!.replace("*", "\\*")}\\}`, "g");
        for (; e <= doc.lines; e++) {
          for (const m of doc.line(e).text.matchAll(re)) depth += m[1] === "begin" ? 1 : -1;
          if (depth <= 0) break;
        }
      }
      e = Math.min(e, doc.lines);
      const to = doc.line(e).to, src = doc.sliceString(ln.from, to);
      let w: Html | null = null;
      if (dm) {
        const h = mathHtml(src.replace(/^\s*\\\[/, "").replace(/\\\]\s*$/, ""), true);
        if (h) w = new Html(h, "ltx-eq", true);
        w ??= chip("[equation]");
      } else if (MATH_ENVS.test(env!)) {
        const inner = src.slice(src.indexOf("}") + 1, src.lastIndexOf("\\end"));
        const h = mathHtml(mathSrc(env!, inner), true);
        w = h ? new Html(h, "ltx-eq", true) : chip(`[${env!.replace("*", "")}]`);
      } else if (TABLE_ENVS.test(env!)) {
        const h = cached(`T${src}`, () => tableHtml(src));
        w = h ? new Html(h, "ltx-table", true) : chip(chipLabel(env!, src));
      } else w = chip(chipLabel(env!, src));
      block(ln.from, to, w);
      n = e;
      continue;
    }

    const ranges: Range<Decoration>[] = [], hidden: [number, number][] = [];
    let widgets = 0;
    const cut = (s: number, e: number) => { hidden.push([s, e]); ranges.push(hide.range(s, e)); };
    const widget = (s: number, e: number, w: WidgetType) => { widgets++; ranges.push(Decoration.replace({ widget: w }).range(s, e)); };
    const eat = (p: number, args: number, optional = true) => { // position after optional [..] and `args` {..} groups
      const rest = () => text.slice(p, ln.to);
      const o = optional && /^\s*\[[^\]]*\]/.exec(rest());
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
      else if (tk[0] === "$") {
        const h = mathHtml(tk.slice(1, -1), false);
        if (h) widget(s, e, new Html(h, "ltx-im", false)); else ranges.push(mark("ltx-math").range(s, e));
      }
      else if (tk === "{" || tk === "}") cut(s, e);
      else if (tk === "~") widget(s, e, new Txt(" ", ""));
      else if (tk === "``" || tk === "''" || tk === "--" || tk === "---") widget(s, e, new Txt({ "``": "“", "''": "”", "--": "–", "---": "—" }[tk]!, ""));
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
          const e0 = e;
          e = eat(e, 1);
          const key = text.slice(e0, e).replace(/^\[[^\]]*\]/, "").slice(1, -1).trim();
          const num = REF.test(name) && /^(ref|eqref)$/.test(name) ? labels[key] : undefined;
          widget(s, e, new Txt(num ? (name === "eqref" ? `(${num})` : num) : REF.test(name) ? "[ref]" : "[cite]", "ltx-ref"));
        } else if (macros[name] && macros[name].nargs !== 1) {
          e = eat(e, macros[name].nargs, false);
          const src = text.slice(s, e), h = cached(`M${src}`, () => inl(src));
          if (h) widget(s, e, new Html(h, "ltx-mac", false)); else cut(s, e);
        } else if (name in ARGS) {
          e = eat(e, ARGS[name]);
          cut(s, e);
        } else if (name === "textcolor" && text[e] === "{") {
          const c = text.slice(e + 1, groupEnd(text, e) - 1);
          const e2 = eat(e, 1);
          if (/^[A-Za-z]+$/.test(c) && text[e2] === "{") ranges.push(Decoration.mark({ attributes: { style: `color:${c}` } }).range(e2 + 1, Math.max(e2 + 1, groupEnd(text, e2) - 1)));
          cut(s, e2);
          e = e2;
        } else if (name in FMT && text[e] === "{") {
          const close = groupEnd(text, e);
          ranges.push(mark(FMT[name]).range(e + 1, Math.max(e + 1, close - 1)));
          cut(s, e);
        } else {
          const col = macros[name] && text[e] === "{" ? macroColor(name) : null;
          if (col && /^[A-Za-z]+$/.test(col)) ranges.push(Decoration.mark({ attributes: { style: `color:${col}` } }).range(e + 1, Math.max(e + 1, groupEnd(text, e) - 1)));
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
    let on = v.on, hit = false;
    for (const e of tr.effects) if (e.is(setWord)) { on = e.value; hit = true; }
    if (!hit && !(on && (tr.docChanged || reviewChanged(tr)))) return v;
    return { on, decos: on ? build(tr.state) : Decoration.none };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    EditorView.atomicRanges.of((view) => view.state.field(f).decos),
  ],
});

/** Nearest visible position if `pos` sits strictly inside a hidden/replaced range. */
export function visiblePos(state: EditorState, pos: number): number {
  let r = pos;
  state.field(wordView).decos.between(pos, pos, (from, to) => { if (from < pos && pos < to) r = pos - from <= to - pos ? from : to; });
  return r;
}
