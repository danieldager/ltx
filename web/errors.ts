// Error strip above the PDF (phase 3 adds "Ask Claude to fix").
import type { CompileMsg } from "./protocol";

export function renderErrors(el: HTMLElement, msg: CompileMsg, jump: (file: string | null, line: number) => void) {
  el.replaceChildren();
  const errs = msg.errors.filter((e) => e.severity === "error");
  const warns = msg.errors.filter((e) => e.severity === "warning");
  const shown = msg.state === "error" ? errs : warns;
  el.hidden = !shown.length;
  el.className = msg.state === "error" ? "errors bad" : "errors warn";
  if (!shown.length) return;
  const head = document.createElement("div");
  head.className = "errors-head";
  head.textContent = msg.state === "error"
    ? "The PDF could not be rebuilt. Showing the last good version."
    : `${warns.length} warning${warns.length > 1 ? "s" : ""}`;
  el.append(head);
  for (const e of shown.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "error-row";
    row.textContent = e.plain;
    row.title = e.msg;
    if (e.line) {
      const b = document.createElement("button");
      b.textContent = "jump";
      b.onclick = () => jump(e.file, e.line!);
      row.append(" ", b);
    }
    el.append(row);
  }
}
