// PDF pane: pdf.js, lazy page rendering, new revisions swapped in place at the same scroll.
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.mjs";

const GAP = 12;

export class PdfPane {
  private pagesEl: HTMLElement | null = null;
  private loading = 0;
  private observer: IntersectionObserver | null = null;
  rev = -1;
  zoom = 1; // multiplier on fit-width

  constructor(readonly scroller: HTMLElement) {}

  async show(url: string, rev: number) {
    if (rev === this.rev && this.pagesEl) return;
    const ticket = ++this.loading;
    const doc = await pdfjs.getDocument({ url }).promise;
    if (ticket !== this.loading) return;
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
    if (ticket !== this.loading) return;
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) render(slots.find((s) => s.slot === e.target)!);
    }, { root: this.scroller, rootMargin: "800px 0px" });
    slots.forEach((s) => this.observer!.observe(s.slot));
    if (this.pagesEl) this.pagesEl.replaceWith(wrap); else this.scroller.append(wrap);
    this.scroller.scrollTop = top;
    this.pagesEl = wrap;
    this.rev = rev;
  }

  async rezoom(url: string) {
    const r = this.rev;
    this.rev = -1;
    await this.show(url, r);
  }
}
