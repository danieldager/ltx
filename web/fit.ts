// Fit-to-width for rendered display math and tables: scale down to the column (floor 0.6, then the widget scrolls).
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const FLOOR = 0.6;

function fitAll(root: HTMLElement) {
  for (const w of root.querySelectorAll<HTMLElement>(".ltx-eq, .ltx-table")) {
    const inner = w.firstElementChild as HTMLElement | null;
    if (!inner?.classList.contains("ltx-fit")) continue;
    inner.style.cssText = ""; w.style.height = ""; w.classList.remove("ltx-fit-scroll");
    const avail = w.clientWidth, natural = w.scrollWidth;
    if (!avail || natural <= avail + 0.5) continue;
    const s = Math.max(FLOOR, avail / natural), h = inner.offsetHeight;
    const floor = avail / natural < FLOOR;
    inner.style.width = `${natural}px`;
    inner.style.transformOrigin = "top left";
    inner.style.transform = `translateX(${floor ? 0 : (avail - natural * s) / 2}px) scale(${s})`;
    w.style.height = `${h * s + (floor ? 12 : 0)}px`;
    w.classList.toggle("ltx-fit-scroll", floor);
  }
}

export const fitWidgets = ViewPlugin.fromClass(class {
  raf = 0;
  ro: ResizeObserver;
  on = () => this.schedule();
  constructor(readonly view: EditorView) {
    this.ro = new ResizeObserver(this.on);
    this.ro.observe(view.scrollDOM);
    window.addEventListener("ltx-fit", this.on);
    this.schedule();
  }
  schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { fitAll(this.view.contentDOM); this.view.requestMeasure(); });
  }
  update(_u: ViewUpdate) { this.schedule(); }
  destroy() { this.ro.disconnect(); window.removeEventListener("ltx-fit", this.on); cancelAnimationFrame(this.raf); }
});
