// Review layer: Claude's suggestions (teal, hover toolbar: accept / reject / discuss) and
// selection comments (yellow, + button). Data comes from .ltxed sidecars via the server.
import { EditorState, Facet, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type { ClientMsg, Comment, Suggestion } from "./protocol";

export const setSuggestions = StateEffect.define<Suggestion[]>();
export const setComments = StateEffect.define<Comment[]>();
const pathFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });
let send: (m: ClientMsg) => void = () => {};
let suggestions: Suggestion[] = [];
let comments: Comment[] = [];
const views = new Set<EditorView>();

export interface Located { kind: "s" | "c"; id: string; from: number; to: number }
interface RV { located: Located[]; decos: DecorationSet }

function find(text: string, pre: string, mid: string, suf: string, line: number, lineStart: (n: number) => number): number {
  if (!mid && !pre && !suf) return -1;
  let i = text.indexOf(pre + mid + suf);
  if (i >= 0) return i + pre.length;
  if (!mid) return -1;
  const target = lineStart(line);
  let best = -1;
  for (i = text.indexOf(mid); i >= 0; i = text.indexOf(mid, i + 1)) if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i;
  return best;
}

class Del extends WidgetType {
  constructor(readonly id: string, readonly old: string) { super(); }
  eq(o: Del) { return o.id === this.id && o.old === this.old; }
  toDOM() { const e = document.createElement("span"); e.className = "ltx-del"; e.textContent = "⌫"; e.dataset.sid = this.id; e.title = this.old; return e; }
}

function build(state: EditorState): RV {
  const path = state.facet(pathFacet), doc = state.doc, text = doc.toString();
  const lineStart = (n: number) => doc.line(Math.min(Math.max(n, 1), doc.lines)).from;
  const located: Located[] = [], decos: Range<Decoration>[] = [];
  for (const s of suggestions) {
    if (s.file !== path || (s.status !== "open" && s.status !== "discuss")) continue;
    const a = s.anchor;
    const i = find(text, a.prefix, s.new, a.suffix, a.line, lineStart);
    if (i < 0) continue;
    located.push({ kind: "s", id: s.id, from: i, to: i + s.new.length });
    if (s.new) decos.push(Decoration.mark({ class: "ltx-sug" + (s.status === "discuss" ? " ltx-sug-discuss" : ""), attributes: { "data-sid": s.id } }).range(i, i + s.new.length));
    else decos.push(Decoration.widget({ widget: new Del(s.id, s.old), side: 1 }).range(i));
  }
  for (const c of comments) {
    if (c.file !== path || c.status !== "open") continue;
    const a = c.anchor;
    const i = find(text, a.prefix, a.quote, a.suffix, a.line, lineStart);
    if (i < 0 || !a.quote) continue;
    located.push({ kind: "c", id: c.id, from: i, to: i + a.quote.length });
    decos.push(Decoration.mark({ class: "ltx-cmt", attributes: { "data-cid": c.id } }).range(i, i + a.quote.length));
  }
  return { located, decos: Decoration.set(decos, true) };
}

export const reviewField = StateField.define<RV>({
  create: (s) => build(s),
  update(v, tr) {
    if (!tr.docChanged && !tr.effects.some((e) => e.is(setSuggestions) || e.is(setComments))) return v;
    return build(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

export const reviewChanged = (tr: { effects: readonly StateEffect<unknown>[] }) => tr.effects.some((e) => e.is(setSuggestions) || e.is(setComments));

// ---- floating UI ----
const el = (tag: string, cls: string, text = "") => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
const btn = (label: string, cls: string, title: string, fn: () => void) => {
  const b = el("button", cls, label); b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = fn;
  return b;
};
let pop: HTMLElement | null = null, hideTimer = 0;
const closePop = () => { pop?.remove(); pop = null; };
function place(p: HTMLElement, r: { left: number; top: number; bottom: number }, above = true) {
  document.body.append(p);
  const h = p.offsetHeight;
  p.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`;
  p.style.top = `${above && r.top - h - 4 > 4 ? r.top - h - 4 : r.bottom + 4}px`;
}
function inputBox(onEnter: (v: string) => void, ph: string, onCancel: () => void) {
  const i = document.createElement("textarea");
  i.className = "ltx-pop-in"; i.placeholder = ph; i.rows = 1;
  const grow = () => { i.style.height = "auto"; i.style.height = `${Math.min(i.scrollHeight, 220)}px`; };
  i.oninput = grow;
  i.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && i.value.trim()) { e.preventDefault(); onEnter(i.value.trim()); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  return i;
}
const small = (t: string) => el("div", "ltx-pop-note", t);

function showFor(target: HTMLElement) {
  const sid = target.dataset.sid, cid = target.dataset.cid;
  const view = EditorView.findFromDOM(target);
  if (!view || (!sid && !cid)) return;
  closePop();
  const p = (pop = el("div", "ltx-pop"));
  p.onmouseenter = () => clearTimeout(hideTimer);
  p.onmouseleave = () => scheduleHide();
  const rect = target.getBoundingClientRect();
  if (sid) {
    const s = suggestions.find((x) => x.id === sid);
    if (!s) return;
    const row = el("div", "ltx-pop-row");
    const upd = (fields: Partial<Suggestion>) => { send({ type: "suggestion_update", id: sid, fields }); closePop(); };
    row.append(
      btn("✓", "ltx-ok", "Accept: keep the text", () => upd({ status: "accepted" })),
      btn("✗", "ltx-no", "Reject: restore the old text", () => {
        const r = view.state.field(reviewField).located.find((x) => x.kind === "s" && x.id === sid);
        if (r) view.dispatch({ changes: { from: r.from, to: r.to, insert: s.old }, userEvent: "input.revert" });
        upd({ status: "rejected" });
      }),
      btn("+", "ltx-plus", "Discuss with Claude", () => {
        row.replaceChildren(inputBox((v) => upd({ status: "discuss", user_comment: v }), "Comment for Claude, Enter to send", () => closePop()));
        (row.firstChild as HTMLInputElement).focus();
      }));
    p.append(row);
    if (s.note) p.append(small(s.note));
    if (s.status === "discuss" && s.user_comment) p.append(small(`You: ${s.user_comment}`));
    if (s.reply) p.append(small(`Claude: ${s.reply}`));
  } else {
    const c = comments.find((x) => x.id === cid);
    if (!c) return;
    const row = el("div", "ltx-pop-row");
    row.append(el("span", "ltx-pop-text", c.instruction), btn("×", "ltx-no", "Delete this comment", () => { send({ type: "comment_delete", id: c.id }); closePop(); }));
    p.append(row);
    if (c.reply) p.append(small(`Claude: ${c.reply}`));
  }
  place(p, rect);
}
const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = window.setTimeout(() => { if (!pop?.querySelector("textarea")) closePop(); }, 350); };
document.addEventListener("mouseover", (e) => {
  const t = (e.target as HTMLElement | null)?.closest?.("[data-sid],[data-cid]") as HTMLElement | null;
  if (t && t.closest(".cm-content")) { clearTimeout(hideTimer); if (!pop || (pop as any)._t !== t) { showFor(t); if (pop) (pop as any)._t = t; } }
});
document.addEventListener("mouseout", (e) => {
  const t = (e.target as HTMLElement | null)?.closest?.("[data-sid],[data-cid]");
  if (t && !(e.relatedTarget as HTMLElement | null)?.closest?.(".ltx-pop")) scheduleHide();
});

// selection "+" button
let plus: HTMLElement | null = null, plusOwner: EditorView | null = null, plusSel = { from: 0, to: 0 }, box: HTMLElement | null = null;
const hidePlus = () => { plus?.remove(); plus = null; };
function openComment(view: EditorView, from: number, to: number, r: { left: number; bottom: number }) {
  const doc = view.state.doc, text = doc.toString();
  const data = { quote: text.slice(from, to), prefix: text.slice(Math.max(0, from - 40), from), suffix: text.slice(to, to + 40), line: doc.lineAt(from).number };
  hidePlus();
  box?.remove();
  const b = (box = el("div", "ltx-pop"));
  const close = () => { b.remove(); box = null; view.focus(); };
  const i = inputBox((v) => {
    send({ type: "comment_add", comment: { file: view.state.facet(pathFacet), anchor: data, instruction: v, status: "open", author: "daniel" } });
    close();
  }, "Comment for Claude", close);
  const save = btn("Save", "ltx-save", "Save the comment (Enter)", () => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
  b.classList.add("ltx-card");
  b.append(i, el("div", "ltx-card-row", ""));
  b.lastElementChild!.append(el("span", "ltx-card-hint", "Enter saves, Shift+Enter adds a line"), btn("Cancel", "ltx-cancel", "Cancel (Esc)", close), save);
  place(b, { left: r.left, top: r.bottom, bottom: r.bottom }, false);
  i.focus();
}
const selectionPlus = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) { view.scrollDOM.addEventListener("scroll", this.hide); }
  hide = () => hidePlus();
  update(u: ViewUpdate) {
    if (!(u.selectionSet || u.focusChanged || u.geometryChanged || u.docChanged)) return;
    const view = u.view;
    view.requestMeasure({
      read: () => {
        const { from, to, empty } = view.state.selection.main;
        return empty || !view.hasFocus || box ? null : { from, to, c: view.coordsAtPos(to) };
      },
      write: (r) => {
        if (!r || !r.c) { if (plusOwner === view) hidePlus(); return; }
        plusOwner = view;
        plusSel = { from: r.from, to: r.to }; // current range, not the one when the button was created
        if (!plus) {
          plus = btn("", "ltx-selplus", "Comment on the selection (Cmd+Alt+M)", () => {});
          plus.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';
          plus.onmousedown = (e) => { e.preventDefault(); openComment(view, plusSel.from, plusSel.to, plus!.getBoundingClientRect()); };
          document.body.append(plus);
        }
        plus.style.left = `${r.c.right + 4}px`;
        plus.style.top = `${r.c.top - 22}px`;
      },
    });
  }
  destroy() { this.view.scrollDOM.removeEventListener("scroll", this.hide); hidePlus(); }
});

const registry = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) { views.add(view); }
  destroy() { views.delete(this.view); }
});

export function reviewExtension(path: string, send_: (m: ClientMsg) => void) {
  send = send_;
  const startComment = (view: EditorView) => {
    const { from, to, empty } = view.state.selection.main;
    const c = empty ? null : view.coordsAtPos(to);
    if (!c) return false;
    openComment(view, from, to, { left: c.left, bottom: c.bottom });
    return true;
  };
  return [pathFacet.of(path), reviewField, selectionPlus, registry, keymap.of([{ key: "Mod-Alt-m", preventDefault: true, run: startComment }])];
}
const push = (e: (v: any) => StateEffect<any>, v: unknown) => views.forEach((view) => view.dispatch({ effects: e(v) }));
export function showComments(c: Comment[]) { comments = c; push((v) => setComments.of(v), c); }
/** Where comment `c` sits in `view` now (the highlight's anchoring, whatever its status), or null. */
export function locateComment(view: EditorView, c: Comment): { from: number; to: number } | null {
  const doc = view.state.doc, a = c.anchor;
  const i = find(doc.toString(), a.prefix, a.quote, a.suffix, a.line, (n) => doc.line(Math.min(Math.max(n, 1), doc.lines)).from);
  return i < 0 || !a.quote ? null : { from: i, to: i + a.quote.length };
}
export function showSuggestions(s: Suggestion[]) { suggestions = s; push((v) => setSuggestions.of(v), s); }
