// Toolbar drop-downs: Outline (sections + word counts) and Comments (list, status filter, jump).
import type { Comment } from "./protocol";
import type { Heading } from "./numbering";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
let open: { btn: HTMLElement; panel: HTMLElement } | null = null;
export function closeMenu() {
  if (!open) return;
  open.panel.remove(); open.btn.classList.remove("on"); open.btn.setAttribute("aria-expanded", "false"); open = null;
}
document.addEventListener("mousedown", (e) => { if (open && !open.panel.contains(e.target as Node) && !open.btn.contains(e.target as Node)) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { const b = open.btn; closeMenu(); b.focus(); } });

/** Clicking `btn` toggles a panel under it, filled by `fill` (called again by `refresh`). */
export function menu(btn: HTMLElement, fill: (p: HTMLElement) => void) {
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => {
    if (open?.btn === btn) return closeMenu();
    closeMenu();
    const panel = el("div", "ltx-menu");
    panel.setAttribute("role", "menu");
    document.body.append(panel);
    open = { btn, panel };
    btn.classList.add("on"); btn.setAttribute("aria-expanded", "true");
    fill(panel);
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  });
  return { refresh: () => { if (open?.btn === btn) { open.panel.replaceChildren(); fill(open.panel); } } };
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function fillOutline(p: HTMLElement, o: { heads: Heading[]; words: number }, go: (h: Heading) => void) {
  p.append(el("div", "ltx-menu-head", `${fmt(o.words)} words`));
  if (!o.heads.length) p.append(el("div", "ltx-menu-empty", "No \\section headings yet."));
  for (const h of o.heads) {
    const b = el("button", `ltx-menu-item ltx-ol${h.level}`);
    b.setAttribute("role", "menuitem");
    b.title = `${h.file}, line ${h.line}`;
    b.append(el("span", "ltx-ol-num", h.num), el("span", "ltx-ol-title", h.title || "(untitled)"), el("span", "ltx-ol-words", fmt(h.words)));
    b.onclick = () => { closeMenu(); go(h); };
    p.append(b);
  }
}

type Filter = "open" | "done" | "all";
let filter: Filter = "open";
const STATUS: Record<Comment["status"], string> = { open: "open", done: "done", wontdo: "won't do" };

export function fillComments(p: HTMLElement, comments: Comment[], go: (c: Comment) => void, redraw: () => void) {
  const n = (f: Filter) => comments.filter((c) => f === "all" || (f === "open" ? c.status === "open" : c.status !== "open")).length;
  const bar = el("div", "ltx-menu-filter");
  for (const [f, label] of [["open", "Open"], ["done", "Answered"], ["all", "All"]] as [Filter, string][]) {
    const b = el("button", f === filter ? "on" : "", `${label} ${n(f)}`);
    b.onclick = () => { filter = f; redraw(); };
    bar.append(b);
  }
  p.append(bar);
  const shown = comments.filter((c) => filter === "all" || (filter === "open" ? c.status === "open" : c.status !== "open"));
  if (!shown.length) p.append(el("div", "ltx-menu-empty", filter === "open" ? "No open comments. Select text and press Cmd+Alt+M to add one." : "None."));
  for (const c of shown) {
    const b = el("button", `ltx-menu-item ltx-cm ltx-cm-${c.status}`);
    b.setAttribute("role", "menuitem");
    const q = c.anchor.quote.replace(/\s+/g, " ");
    b.append(el("span", "ltx-cm-quote", q.length > 70 ? q.slice(0, 70) + "…" : q), el("span", "ltx-cm-text", c.instruction));
    if (c.reply) b.append(el("span", "ltx-cm-reply", `Claude: ${c.reply}`));
    b.append(el("span", "ltx-cm-meta", `${STATUS[c.status]} · ${c.file}:${c.anchor.line}`));
    b.onclick = () => { closeMenu(); go(c); };
    p.append(b);
  }
}
