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
import { showComments } from "./comments";
import { setWord } from "./decorations/index";

const $ = (id: string) => document.getElementById(id)!;
const syncs = new Map<string, FileSync>();
const hosts = new Map<string, HTMLElement>();
let active = "";
let ws: WebSocket;
let index: IndexMsg | null = null;
const indexListeners: ((i: IndexMsg) => void)[] = [];
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
    decorations: { path: f.path, getIndex: () => index, onIndex: (cb) => indexListeners.push(cb) },
    extra: [
      EV.updateListener.of((u) => sync.onUpdate(u)),
      EV.domEventHandlers({ blur: () => { sync.flush(); } }),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { sync.flush(); return true; } }]),
      ...selectionExtension(f.path, send),
    ],
  });
  if (word) sync.view.dispatch({ effects: setWord.of(true) });
  syncs.set(f.path, sync);
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
      if (!active) activate(m.root);
      if (m.index) { index = m.index; indexListeners.forEach((cb) => cb(m.index!)); }
      if (m.compile) onCompile(m.compile);
      showComments(m.comments);
      break;
    case "saved": syncs.get(m.path)?.onSaved(m.hash); break;
    case "save_conflict": syncs.get(m.path)?.onConflict(m.disk_text, m.disk_hash); break;
    case "external": syncs.get(m.path)?.applyExternal(m.base_hash, m.new_hash, m.changes); break;
    case "file": syncs.get(m.path)?.onFile(m.text, m.hash); break;
    case "file_added": if (!syncs.has(m.file.path)) addFile(m.file); break;
    case "compile": onCompile(m); break;
    case "index": index = m; indexListeners.forEach((cb) => cb(m)); break;
    case "comments": showComments(m.comments); break;
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
  set(v);
  $(btn).onclick = () => { set(!v); try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* ignore */ } };
}
toggle("justify", "ltx.justify", false, (v) => document.body.classList.toggle("justify", v));
toggle("latex", "ltx.latex", true, (v) => {
  word = !v;
  document.body.classList.toggle("word", word);
  syncs.forEach((s) => s.view.dispatch({ effects: setWord.of(word) }));
});
toggle("pdf", "ltx.pdf", false, (v) => {
  pdfOn = v;
  document.body.classList.toggle("no-pdf", !v);
  if (v && lastCompile?.pdf_url) requestAnimationFrame(() => { pdf.rev = -1; pdf.show(lastCompile!.pdf_url!, lastCompile!.rev); });
});
$("zoom-in").onclick = () => { pdf.zoom *= 1.15; if (lastCompile?.pdf_url) pdf.rezoom(lastCompile.pdf_url); };
$("zoom-out").onclick = () => { pdf.zoom /= 1.15; if (lastCompile?.pdf_url) pdf.rezoom(lastCompile.pdf_url); };
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
