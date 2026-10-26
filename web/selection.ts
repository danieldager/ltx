// Selection sidecar (SPEC §8, §13.3): the focused editor's selection goes to the server, which writes
// .ltxed/selection.json for Claude ("this paragraph", "the selected table"). Sent 300 ms after the
// selection settles; while typing, only after the save has gone out, so typing stays network-free.
import type { Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClientMsg, Selection } from "./protocol";
import { SAVE_DEBOUNCE_MS } from "./sync";

const ENV = /\\(begin|end)\{([^}]+)\}/g;
const arg = (s: string, cmd: string) => { const m = new RegExp(`\\\\${cmd}(?:\\[[^\\]]*\\])?\\{([^}]*)\\}`).exec(s); return m ? m[1] : null; };

/** Innermost environment around `pos` (document excluded), else the current section. */
function enclosing(text: string, pos: number): Selection["enclosing"] {
  const open: { env: string; at: number }[] = [];
  for (const m of text.slice(0, pos).matchAll(ENV)) {
    if (m[2] === "document") continue;
    if (m[1] === "begin") open.push({ env: m[2], at: m.index! });
    else { const i = open.map((o) => o.env).lastIndexOf(m[2]); if (i >= 0) open.length = i; }
  }
  const o = open[open.length - 1];
  if (o) {
    const end = text.indexOf(`\\end{${o.env}}`, pos), body = text.slice(o.at, end < 0 ? text.length : end);
    return { kind: o.env, label: arg(body, "label"), caption: arg(body, "caption") };
  }
  const heads = [...text.slice(0, pos).matchAll(/\\(section|subsection|subsubsection)\*?\{([^}]*)\}(\\label\{([^}]*)\})?/g)];
  const h = heads[heads.length - 1];
  return h ? { kind: h[1], label: h[4] ?? null, caption: h[2] } : null;
}

/** The blank-line-delimited paragraph(s) covering lines a..b. */
function paragraph(doc: Text, a: number, b: number): string {
  while (a > 1 && doc.line(a - 1).text.trim()) a--;
  while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
  return doc.sliceString(doc.line(a).from, doc.line(b).to);
}

export function selectionOf(view: EditorView, path: string): Selection {
  const { from, to } = view.state.selection.main, doc = view.state.doc;
  const line_from = doc.lineAt(from).number, line_to = doc.lineAt(to).number;
  return { file: path, from, to, line_from, line_to, text: doc.sliceString(from, to),
           paragraph_text: paragraph(doc, line_from, line_to), enclosing: enclosing(doc.toString(), from) };
}

export function selectionExtension(path: string, send: (m: ClientMsg) => void): Extension[] {
  let timer = 0, last = "";
  return [EditorView.updateListener.of((u) => {
    if (!u.view.hasFocus || !(u.selectionSet || u.docChanged || u.focusChanged)) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const s = selectionOf(u.view, path), key = JSON.stringify(s);
      if (key !== last) { last = key; send({ type: "selection", ...s }); }
    }, u.docChanged ? SAVE_DEBOUNCE_MS + 100 : 300);
  })];
}
