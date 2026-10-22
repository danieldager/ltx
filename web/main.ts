// Boot and layout. Shared module (SPEC §13.4): coordinate before editing.
import type { EditorView } from "@codemirror/view";
import { EditorView as EV, keymap } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { ClientMsg, CompileMsg, IndexMsg, ServerMsg, WireFile } from "./protocol";
import { FileSync, Replaced } from "./sync";
import { createEditor } from "./editor";
import { PdfPane } from "./pdf";
import { renderErrors } from "./errors";
import { selectionExtension } from "./selection";
import { showComments, showSuggestions } from "./review";
import { flatten } from "./flatten";
import { fileStarts } from "./numbering";
import { renumber, setStartProvider } from "./decorations/paper";
import { setWord } from "./decorations/index";
import { setLabels } from "./decorations/render";
import { setMacros, visiblePos } from "./decorations/wordview";

const $ = (id: string) => document.getElementById(id)!;
const syncs = new Map<string, FileSync>();
const hosts = new Map<string, HTMLElement>();
let active = "";
let rootPath = "main.tex";
let ws: WebSocket;
let index: IndexMsg | null = null;
const indexListeners: ((i: IndexMsg) => void)[] = [(i) => { setMacros(i.macros); setLabels(i.labels); if (word) syncs.forEach((s) => s.view.dispatch({ effects: setWord.of(true) })); }];
setStartProvider((view) => {
  const texts: Record<string, string> = {};
  let path = "";
  syncs.forEach((s, p) => { texts[p] = s.view?.state.doc.toString() ?? ""; if (s.view === view) path = p; });
  return fileStarts(rootPath, texts)[path] ?? null;
});
const pdf = new PdfPane($("pdf-scroll"));
let lastCompile: CompileMsg | null = null;
let word = false; // LaTeX markup hidden
let pdfOn = false;

function send(m: ClientMsg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }

function setStatus(path: string, s: string) {
  if (path === active) $("save-state").textContent = { saved: "Saved", unsaved: "Edited", saving: "Saving…" }[s] ?? s;
}

function showReplaced(sync: FileSync, items: Replaced[]) {
  const bar = $("replaced");
  bar.replaceChildren();
  bar.hidden = !items.length;
  items.forEach((r, i) => {
    const row = document.createElement("div");
    const q = r.text.length > 80 ? r.text.slice(0, 80) + "…" : r.text;
    row.append(`Your unsaved text “${q}” was replaced by an outside edit. `);
    const mk = (label: string, fn: () => void) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; row.append(b, " "); };
    mk("copy", () => navigator.clipboard.writeText(r.text));
    mk("re-insert", () => sync.reinsert(i));
    mk("dismiss", () => sync.dismiss(i));
    bar.append(row);
  });
}

let bannerTimer = 0;
function banner(text: string) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (b.hidden = true), 2500);
}

// section numbers depend on the other files (\appendix, earlier sections): refresh the others after an edit
let renumberTimer = 0;
const lastStart = new Map<string, string>();
function scheduleRenumber(_from?: EditorView) {
  clearTimeout(renumberTimer);
  renumberTimer = window.setTimeout(() => {
    const texts: Record<string, string> = {};
    syncs.forEach((s, p) => (texts[p] = s.view.state.doc.toString()));
    const starts = fileStarts(rootPath, texts);
    syncs.forEach((s, p) => {
      const sig = JSON.stringify(starts[p] ?? null);
      if (lastStart.get(p) !== sig) { lastStart.set(p, sig); s.view.dispatch({ effects: renumber.of(null) }); }
    });
  }, 150);
}

function addFile(f: WireFile) {
  const host = document.createElement("div");
  host.className = "sheet";
  host.hidden = true;
  $("sheets").append(host);
  hosts.set(f.path, host);
  const sync = new FileSync(f.path, f.text, f.hash, send,
    (s) => setStatus(f.path, s),
    (items) => showReplaced(sync, items),
    (n) => banner(`Updated from disk (${f.path}, ${n} place${n === 1 ? "" : "s"})`));
  sync.view = createEditor({
    parent: host, path: f.path, text: f.text,
    decorations: { path: f.path, getIndex: () => index, onIndex: (cb) => indexListeners.push(cb), send },
    extra: [
      EV.updateListener.of((u) => { sync.onUpdate(u); if (u.docChanged) scheduleRenumber(u.view); }),
      EV.domEventHandlers({ blur: () => { sync.flush(); } }),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { sync.flush(); return true; } }]),
      ...selectionExtension(f.path, send),
    ],
  });
  if (word) sync.view.dispatch({ effects: setWord.of(true) });
  syncs.set(f.path, sync);
  scheduleRenumber(sync.view);
  const tab = document.createElement("button");
  tab.textContent = f.path;
  tab.dataset.path = f.path;
  tab.onclick = () => activate(f.path);
  $("tabs").append(tab);
}

function activate(path: string) {
  if (active && active !== path) syncs.get(active)?.flush();
  active = path;
  hosts.forEach((h, p) => (h.hidden = p !== path));
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.path === path));
  setStatus(path, syncs.get(path)!.dirty ? "unsaved" : "saved");
}

function jump(file: string | null, line: number) {
  const path = file && syncs.has(file) ? file : active;
  activate(path);
  const v = syncs.get(path)!.view;
  const pos = v.state.doc.line(Math.min(line, v.state.doc.lines)).from;
  v.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
  v.focus();
}

function onCompile(m: CompileMsg) {
  lastCompile = m;
  const st = $("compile-state");
  st.textContent = m.state === "running" ? "Building PDF…" : m.state === "ok" ? `PDF up to date${m.duration_ms ? ` (${(m.duration_ms / 1000).toFixed(1)} s)` : ""}` : "PDF build failed";
  st.className = `compile-${m.state}`;
  if (m.state !== "running") renderErrors($("errors"), m, jump);
  updateErr();
  if (m.pdf_url && m.state !== "running" && pdfOn) pdf.show(m.pdf_url, m.rev);
}

function onMessage(m: ServerMsg) {
  switch (m.type) {
    case "hello":
      for (const f of m.files) {
        const s = syncs.get(f.path);
        if (!s) addFile(f);
        else s.resume(f.text, f.hash);
      }
      rootPath = m.root;
      if (!active) activate(m.root);
      if (m.index) { index = m.index; indexListeners.forEach((cb) => cb(m.index!)); }
      if (m.compile) onCompile(m.compile);
      showComments(m.comments);
      showSuggestions(m.suggestions ?? []);
      break;
    case "saved": syncs.get(m.path)?.onSaved(m.hash); break;
    case "save_conflict": syncs.get(m.path)?.onConflict(m.disk_text, m.disk_hash); break;
    case "external": syncs.get(m.path)?.applyExternal(m.base_hash, m.new_hash, m.changes); break;
    case "file": syncs.get(m.path)?.onFile(m.text, m.hash); break;
    case "file_added": if (!syncs.has(m.file.path)) addFile(m.file); break;
    case "compile": onCompile(m); break;
    case "index": index = m; indexListeners.forEach((cb) => cb(m)); break;
    case "comments": showComments(m.comments); break;
    case "suggestions": showSuggestions(m.suggestions); break;
    case "error": banner(`Problem: ${m.msg}`); break;
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onopen = () => ($("conn").hidden = true);
  ws.onclose = () => { $("conn").hidden = false; setTimeout(connect, 1000); };
}

// toggles and split
function toggle(btn: string, key: string, dflt: boolean, apply: (v: boolean) => void) {
  let v = dflt;
  try { const s = localStorage.getItem(key); if (s !== null) v = s === "1"; } catch { /* ignore */ }
  const set = (x: boolean) => { v = x; $(btn).classList.toggle("on", x); apply(x); };
  const user = (x: boolean) => { set(x); try { localStorage.setItem(key, x ? "1" : "0"); } catch { /* ignore */ } };
  set(v);
  $(btn).onclick = () => user(!v);
  return user;
}

// Keep the cursor line (or, off-screen, the top visible line) at the same viewport offset across `fn`.
function anchored(view: EditorView | undefined, fn: () => void) {
  if (!view) return fn();
  const sc = view.scrollDOM, top = sc.getBoundingClientRect().top, head = view.state.selection.main.head;
  const y = (p: number) => { const c = view.coordsAtPos(p); return (c ? c.top : view.documentTop + view.lineBlockAt(p).top) - top; };
  let pos = head, off = y(head);
  if (off < 0 || off > sc.clientHeight) {
    const r = sc.getBoundingClientRect();
    pos = view.posAtCoords({ x: r.left + r.width / 2, y: top + 4 }, false);
    off = y(pos);
  }
  fn();
  const fix = (k: number) => view.requestMeasure({
    read: () => y(pos) - off,
    write: (dy: number) => { if (Math.abs(dy) > 0.5) sc.scrollTop += dy; if (k > 0) fix(k - 1); },
  });
  fix(6);
}

function setLatex(show: boolean) {
  word = !show;
  document.body.classList.toggle("word", word);
  const act = syncs.get(active)?.view;
  syncs.forEach((s) => {
    const run = () => {
      s.view.dispatch({ effects: setWord.of(word) });
      if (word) {
        const h = s.view.state.selection.main.head, v = visiblePos(s.view.state, h);
        if (v !== h) s.view.dispatch({ selection: EditorSelection.cursor(v) });
      }
    };
    s.view === act ? anchored(act, run) : run();
  });
}
const setLatexUser = toggle("latex", "ltx.latex", true, setLatex);
const setPdfUser = toggle("pdf", "ltx.pdf", false, (v) => {
  pdfOn = v;
  document.body.classList.toggle("no-pdf", !v);
  updateErr();
  if (v && lastCompile?.pdf_url) requestAnimationFrame(() => { pdf.rev = -1; pdf.show(lastCompile!.pdf_url!, lastCompile!.rev); });
});
toggle("justify", "ltx.justify", false, (v) => document.body.classList.toggle("justify", v));
$("pdf-err").onclick = () => setPdfUser(true);
function updateErr() {
  const n = lastCompile?.state === "error" ? lastCompile.errors.filter((e) => e.severity === "error").length : 0;
  $("pdf-err").hidden = pdfOn || lastCompile?.state !== "error";
  $("pdf-err").textContent = `PDF build failed (${n})`;
}

// view-only sliders: font size and text column width
function slider(id: string, key: string, css: string, conv: (v: number) => string) {
  const el = $(id) as HTMLInputElement;
  try { const s = localStorage.getItem(key); if (s) el.value = s; } catch { /* ignore */ }
  const apply = () => { document.body.style.setProperty(css, conv(+el.value)); syncs.forEach((s) => s.view.requestMeasure()); window.dispatchEvent(new Event("ltx-fit")); };
  el.oninput = () => { apply(); try { localStorage.setItem(key, el.value); } catch { /* ignore */ } };
  apply();
}
slider("fs", "ltx.fs", "--fs", (v) => `${v}px`);
document.body.style.setProperty("--col-min", `${Math.round(window.screen.width / 2)}px`); // floor: never narrower than 50% of the screen
slider("cw", "ltx.cw2", "--col-w", (v) => `${Math.round(window.screen.width * v / 100)}px`); // % of the physical screen, capped by max-width:100%

// click a rendered block/inline widget: show the LaTeX and put the cursor at its source
$("sheets").addEventListener("ltx-reveal", (ev) => {
  const v = EV.findFromDOM(ev.target as HTMLElement);
  if (!v) return;
  const pos = v.posAtDOM(ev.target as HTMLElement);
  v.dispatch({ selection: EditorSelection.cursor(pos) });
  setLatexUser(true);
  v.focus();
});
$("zoom-in").onclick = () => { pdf.zoom *= 1.15; if (lastCompile?.pdf_url) pdf.rezoom(lastCompile.pdf_url); };
$("zoom-out").onclick = () => { pdf.zoom /= 1.15; if (lastCompile?.pdf_url) pdf.rezoom(lastCompile.pdf_url); };
// Export: copy the whole document as one LaTeX text, using the live (unsaved) buffers.
async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); return; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("clipboard unavailable");
}
let exportTimer = 0;
$("export").onclick = async () => {
  const texts: Record<string, string> = {};
  syncs.forEach((s, p) => (texts[p] = s.view.state.doc.toString()));
  const out = flatten(rootPath, texts);
  const btn = $("export"), label = "Export";
  clearTimeout(exportTimer);
  try { await copyText(out); btn.textContent = `Copied ${out.split("\n").length} lines`; }
  catch { btn.textContent = "Copy failed"; }
  exportTimer = window.setTimeout(() => (btn.textContent = label), 2000);
};
$("rebuild").onclick = () => send({ type: "compile_now" });
$("split").onmousedown = (e) => {
  e.preventDefault();
  const move = (ev: MouseEvent) => document.body.style.setProperty("--pdf-w", `${Math.max(240, window.innerWidth - ev.clientX)}px`);
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); if (lastCompile?.pdf_url) pdf.rezoom(lastCompile.pdf_url); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};
window.addEventListener("beforeunload", () => syncs.forEach((s) => s.flush()));

// test hook (e2e tests drive the editor through this)
(window as any).__ltx = {
  syncs, view: (p?: string) => syncs.get(p ?? active)!.view as EditorView,
  hold: (v: boolean) => syncs.forEach((s) => { s.holdSaves = v; if (!v) s.flush(); }),
};
connect();
