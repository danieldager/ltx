// Typing " inserts LaTeX quotes (`` or ''); undo once leaves a plain ". Not in math, verbatim or comments.
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

const RAW = /^(verbatim|lstlisting|minted|equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math)$/;

function skip(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos), before = line.text.slice(0, pos - line.from);
  if (/(?<!\\)%/.test(before)) return true;
  if (((before.replace(/\\\$/g, "").match(/\$/g) ?? []).length) % 2) return true;
  const head = view.state.sliceDoc(0, pos), open: string[] = [];
  for (const m of head.matchAll(/\\(begin|end)\{([^}]+)\}|\\\[|\\\]/g)) {
    if (m[0] === "\\[") open.push("[");
    else if (m[0] === "\\]") open.pop();
    else if (m[1] === "begin") open.push(m[2]);
    else open.pop();
  }
  return open.some((e) => e === "[" || RAW.test(e));
}

export const quotes = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '"' || skip(view, from)) return false;
  if (from < to) {
    const sel = view.state.sliceDoc(from, to);
    view.dispatch({ changes: { from, to, insert: "``" + sel + "''" }, selection: { anchor: from + sel.length + 4 }, userEvent: "input.type" });
    return true;
  }
  const prev = from === view.state.doc.lineAt(from).from ? "" : view.state.sliceDoc(from - 1, from);
  const open = prev === "" || /[\s(\[{~]/.test(prev);
  view.dispatch({ changes: { from, insert: '"' }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  view.dispatch({ changes: { from, to: from + 1, insert: open ? "``" : "''" }, selection: { anchor: from + 2 }, annotations: isolateHistory.of("full") });
  return true;
});
