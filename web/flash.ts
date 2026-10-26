// Lines changed by an outside edit (Claude, git, another tab) get a teal tint that fades out.
import { Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { remoteEdit } from "./sync";

export const FLASH_MS = 2500;
const clear = StateEffect.define<null>();
const deco = Decoration.line({ class: "ltx-flash" });

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    if (tr.effects.some((e) => e.is(clear))) return Decoration.none;
    v = v.map(tr.changes);
    if (!tr.annotation(remoteEdit) || tr.changes.empty) return v;
    const lines = new Set<number>(), doc = tr.state.doc;
    tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
      for (let n = doc.lineAt(fb).number, e = doc.lineAt(tb).number; n <= e; n++) lines.add(doc.line(n).from);
    });
    const add: Range<Decoration>[] = [...lines].map((p) => deco.range(p));
    return v.update({ add, sort: true });
  },
  provide: (f) => EditorView.decorations.from(f),
});

const timer = ViewPlugin.fromClass(class {
  t = 0;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!u.transactions.some((tr) => tr.annotation(remoteEdit))) return;
    clearTimeout(this.t);
    this.t = window.setTimeout(() => this.view.dispatch({ effects: clear.of(null) }), FLASH_MS);
  }
  destroy() { clearTimeout(this.t); }
});

export const externalFlash = [field, timer];
