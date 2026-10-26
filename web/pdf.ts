// PDF pane: pdf.js, lazy page rendering, new revisions swapped in place at the same scroll.
// pdf.js itself is loaded on first use (the pane is hidden by default).
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

interface Loaded { task: PDFDocumentLoadingTask; doc: PDFDocumentProxy }

let lib: Promise<typeof import("pdfjs-dist")> | null = null;
const pdfjs = () => (lib ??= import("pdfjs-dist").then((m) => { m.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.mjs"; return m; }));

const GAP = 12;

export class PdfPane {
  private pagesEl: HTMLElement | null = null;
  private loading = 0;
  private observer: IntersectionObserver | null = null;
  private cur: Loaded | null = null; // the one on screen; replaced ones are destroyed (frees their worker)
  rev = -1;
  zoom = 1; // multiplier on fit-width
  private pages: HTMLElement[] = [];
  private scale = 1; // CSS px per PDF point
  private target: { page: number; y: number; y2: number } | null = null;
  /** Double-click on a page: page number and position in PDF points from its top-left (SynCTeX reverse). */
  onPick: (page: number, x: number, y: number) => void = () => {};

  constructor(readonly scroller: HTMLElement) {
    scroller.addEventListener("dblclick", (e) => {
      const slot = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page"), i = slot ? this.pages.indexOf(slot) : -1;
      if (i < 0) return;
      const r = slot!.getBoundingClientRect();
      this.onPick(i + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
    });
  }

  /** Scroll to a spot (PDF points from the page top; y = first baseline, y2 = last) and mark it briefly. */
  reveal(page: number, y: number, y2 = y) {
    this.target = { page, y, y2 };
    if (this.pagesEl) this.applyTarget();
  }

  private applyTarget() {
    const t = this.target!, slot = this.pages[t.page - 1];
    if (!slot) return;
    this.target = null;
    const sc = this.scroller, top = slot.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + (t.y - 12) * this.scale;
    sc.scrollTop = top - sc.clientHeight / 3;
    const m = document.createElement("div");
    m.className = "pdf-mark";
    m.style.top = `${(t.y - 11) * this.scale}px`;
    m.style.height = `${(Math.min(t.y2 - t.y, 160) + 14) * this.scale}px`; // a long block: mark its start
    slot.append(m);
    window.setTimeout(() => m.remove(), 1800);
  }

  async show(url: string, rev: number, reuse = false) {
    if (rev === this.rev && this.pagesEl) return;
    const ticket = ++this.loading;
    let ld = reuse ? this.cur : null;
    if (!ld) { const task = (await pdfjs()).getDocument({ url }); ld = { task, doc: await task.promise }; }
    const L = ld, doc = L.doc;
    const drop = () => { if (L !== this.cur) L.task.destroy(); };
    if (ticket !== this.loading) return drop();
    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    const width = this.scroller.clientWidth - 2 * GAP;
    const scale = (width / pages[0].getViewport({ scale: 1 }).width) * this.zoom;
    const wrap = document.createElement("div");
    wrap.className = "pdf-pages";
    const slots = pages.map((p) => {
      const vp = p.getViewport({ scale });
      const slot = document.createElement("div");
      slot.className = "pdf-page";
      slot.style.width = `${vp.width}px`;
      slot.style.height = `${vp.height}px`;
      wrap.append(slot);
      return { p, vp, slot, done: false };
    });
    const render = async (s: (typeof slots)[number]) => {
      if (s.done) return;
      s.done = true;
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(s.vp.width * dpr);
      canvas.height = Math.floor(s.vp.height * dpr);
      await s.p.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: s.vp,
                         transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined } as any).promise;
      s.slot.append(canvas);
    };
    // render what will be on screen at the current scroll offset before swapping
    const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight;
    let y = GAP;
    const visible = slots.filter((s) => { const a = y, b = y + s.vp.height; y = b + GAP; return b >= top && a <= bottom; });
    await Promise.all(visible.map(render));
    if (ticket !== this.loading) return drop();
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) render(slots.find((s) => s.slot === e.target)!);
    }, { root: this.scroller, rootMargin: "800px 0px" });
    slots.forEach((s) => this.observer!.observe(s.slot));
    if (this.pagesEl) this.pagesEl.replaceWith(wrap); else this.scroller.append(wrap);
    this.scroller.scrollTop = top;
    this.pagesEl = wrap;
    this.pages = slots.map((x) => x.slot);
    this.scale = scale;
    this.rev = rev;
    if (this.cur !== L) this.cur?.task.destroy();
    this.cur = L;
    if (this.target) this.applyTarget();
  }

  async rezoom(url: string) {
    const r = this.rev;
    this.rev = -1;
    await this.show(url, r, true); // same revision: re-render the loaded document, no refetch
  }
}
