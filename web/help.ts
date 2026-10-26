// The « ? » panel: one list of every control, key and visual convention, rendered on hover/focus/tap.
// `id` ties an entry to a toolbar control; a test checks every toolbar control has one.

interface Item { term: string; desc: string; id?: string; kbd?: boolean; sample?: string }
export const HELP: { group: string; items: Item[] }[] = [
  { group: "Toolbar", items: [
    { term: "Tabs", desc: "One per .tex file of the paper (\\input and \\include files too)." },
    { term: "Saved · Edited", id: "save-state", desc: "Your typing is saved as a small patch 0.4 s after you pause." },
    { term: "Outline", id: "outline", desc: "Sections of all files with word counts; click one to go there." },
    { term: "Comments", id: "comments", desc: "Your comments for Claude, open or answered; the badge counts open ones. Click one to go to its text." },
    { term: "Justify", id: "justify", desc: "Justify paragraphs (view only)." },
    { term: "● PDF up to date", id: "compile-state", desc: "Background build: green built, pulsing building, red failed. The last good PDF stays on screen." },
    { term: "PDF build failed (n)", id: "pdf-err", desc: "Shown when the PDF is hidden and the build fails; click to see the errors." },
    { term: "Rebuild", id: "rebuild", desc: "Build the PDF now." },
    { term: "− +", id: "zoom-out zoom-in", desc: "Zoom the PDF." },
    { term: "Aa", id: "fs", desc: "Text size (view only, nothing is written)." },
    { term: "↔", id: "cw", desc: "Column width as a share of the screen (view only)." },
    { term: "Export", id: "export", desc: "Copy the whole paper as one LaTeX text, \\input files inlined, unsaved typing included." },
    { term: "LaTeX", id: "latex", desc: "On: the source, markup in small grey type. Off: a Word-like view, markup hidden, math and tables rendered." },
    { term: "PDF", id: "pdf", desc: "Show or hide the PDF beside the text. Drag the divider to resize." },
    { term: "?", id: "help", desc: "This panel." },
  ] },
  { group: "Keys", items: [
    { term: "⌘S", kbd: true, desc: "Save now." },
    { term: "⌘Z  ⇧⌘Z", kbd: true, desc: "Undo, redo your own typing (outside edits are not in your history)." },
    { term: "⌘F", kbd: true, desc: "Find and replace (Enter next, ⇧Enter previous, Esc closes)." },
    { term: "⌥⌘M", kbd: true, desc: "Comment on the selection (or click the speech bubble next to it)." },
    { term: "⌘J", kbd: true, desc: "Show the cursor's place in the PDF. Double-click the PDF to go back to the source." },
    { term: "\"", kbd: true, desc: "Types LaTeX quotes `` or ''; undo once for a plain \"." },
  ] },
  { group: "In the text", items: [
    { term: "\\cite{key}", sample: "ltx-help-grey", desc: "Grey small type: LaTeX commands and their keys (labels, citation keys, file names)." },
    { term: "[TO CONFIRM: …]", sample: "ltx-help-red", desc: "Red: placeholders such as \\toconfirm{} and \\tbc{}, coloured as in the PDF (LaTeX off). Claude keeps them." },
    { term: "[figure: caption]", sample: "ltx-chip", desc: "A block the LaTeX-off view does not draw. It is locked: the cursor steps over it; click it to edit its LaTeX." },
    { term: "x²  [ref]", sample: "ltx-help-ref", desc: "Rendered math, tables, references and citations (LaTeX off). Click one to edit its LaTeX; numbers come from the last build." },
    { term: "suggested", sample: "ltx-sug", desc: "Teal: an edit Claude suggested. Hover: ✓ keep, ✗ restore the old text, + discuss. ⌫ marks a deletion." },
    { term: "commented", sample: "ltx-cmt", desc: "Yellow: text you commented on. Hover to read Claude's reply or delete the comment." },
    { term: "changed", sample: "ltx-flash-sample", desc: "Teal fade: a line that just changed on disk (Claude, git, another tab)." },
    { term: "Your unsaved text …", sample: "ltx-help-replaced", desc: "You and an outside edit changed the same words; the file won. Copy, re-insert or dismiss your text." },
  ] },
  { group: "With Claude", items: [
    { term: "Selection", desc: "Your selection, or the paragraph with the cursor, is written to .ltxed/selection.json: say \"rewrite this paragraph\"." },
    { term: "Comments", desc: "Select, comment, then say \"do the comments\". Claude marks each done and replies; with ltx watch it picks them up as you write." },
    { term: "Suggestions", desc: "Edits Claude lists in suggestions.json appear in teal for you to review." },
    { term: "Build", desc: "Errors go to compile_errors.json: say \"fix the build\"." },
  ] },
];

export function fillHelp(p: HTMLElement) {
  for (const g of HELP) {
    const h = document.createElement("div");
    h.className = "help-group";
    h.textContent = g.group;
    const dl = document.createElement("dl");
    for (const it of g.items) {
      const dt = document.createElement("dt"), t = document.createElement(it.kbd ? "kbd" : "span");
      t.textContent = it.term;
      if (it.sample) t.className = it.sample;
      dt.append(t);
      const dd = document.createElement("dd");
      dd.textContent = it.desc;
      dl.append(dt, dd);
    }
    const sec = document.createElement("section");
    sec.append(h, dl);
    p.append(sec);
  }
}

/** Show on hover or keyboard focus; a click (or tap) pins it open until the next click elsewhere or Esc. */
export function helpButton(btn: HTMLElement, panel: HTMLElement) {
  fillHelp(panel);
  let pinned = false, t = 0;
  const show = () => { clearTimeout(t); panel.hidden = false; btn.setAttribute("aria-expanded", "true"); };
  const hide = (now = false) => {
    clearTimeout(t);
    const go = () => { if (!pinned) { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); } };
    if (now) go(); else t = window.setTimeout(go, 200);
  };
  btn.addEventListener("mouseenter", show);
  btn.addEventListener("mouseleave", () => hide());
  panel.addEventListener("mouseenter", show);
  panel.addEventListener("mouseleave", () => hide());
  btn.addEventListener("focus", show);
  btn.addEventListener("blur", () => hide());
  btn.addEventListener("click", () => { pinned = !pinned || panel.hidden === true; btn.classList.toggle("on", pinned); pinned ? show() : hide(true); });
  document.addEventListener("mousedown", (e) => {
    if (pinned && !panel.contains(e.target as Node) && !btn.contains(e.target as Node)) { pinned = false; btn.classList.remove("on"); hide(true); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { pinned = false; btn.classList.remove("on"); hide(true); } });
}
