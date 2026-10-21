// Phase 1 markup muting: commands, braces, keys and comments small and grey; math italic.
// Phase 2 replaces this with the markup-hiding layer.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const cmd = Decoration.mark({ class: "ltx-cmd" });
const brace = Decoration.mark({ class: "ltx-brace" });
const key = Decoration.mark({ class: "ltx-key" });
const comment = Decoration.mark({ class: "ltx-comment" });
const math = Decoration.mark({ class: "ltx-math" });
const tilde = Decoration.mark({ class: "ltx-brace" });

// commands whose first {argument} is a key/path rather than prose
const KEYED = /^\\(label|ref|eqref|autoref|cref|Cref|pageref|cite|citep|citet|citealp|citeauthor|citeyear|input|include|includegraphics|lstinputlisting|bibliography|bibliographystyle|usepackage|documentclass|begin|end|path|nolinkurl|url|href)$/;

const TOKEN = /(?<!\\)%.*$|\\[A-Za-z@]+\*?|\\[%&$#_{}\\,;!]|\$[^$]*\$|[{}[\]]|~/gm;

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    let keyNext = false;
    while ((m = TOKEN.exec(text))) {
      const s = from + m.index, e = s + m[0].length, t = m[0];
      if (t[0] === "%") b.add(s, e, comment);
      else if (t[0] === "$") b.add(s, e, math);
      else if (t[0] === "\\") {
        if (/^\\[A-Za-z@]/.test(t)) { b.add(s, e, cmd); keyNext = KEYED.test(t.replace(/\*$/, "")); }
        else if (t === "\\\\") b.add(s, e, cmd);
        // escaped specials like \% read as text
      } else if (t === "~") b.add(s, e, tilde);
      else {
        b.add(s, e, brace);
        if (t === "{" && keyNext) {
          const close = text.indexOf("}", m.index);
          if (close > m.index + 1 && !text.slice(m.index + 1, close).includes("\n")) {
            b.add(e, from + close, key);
            TOKEN.lastIndex = close;
          }
        }
        if (t === "{") keyNext = false;
      }
    }
  }
  return b.finish();
}

export const muteMarkup = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
}, { decorations: (v) => v.decorations });
