// FileSync: keeps one CM6 view in step with its file on disk (SPEC §4, §13).
// Typing never touches the network: local transactions only compose into `pending`;
// a debounced save sends them later. Remote changes are mapped through unsaved typing.
import { Annotation, ChangeSet, Text, Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { Change, ClientMsg } from "./protocol";

export const remoteEdit = Annotation.define<boolean>();
export const SAVE_DEBOUNCE_MS = 400;

export interface Replaced { text: string; pos: number }

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toList(cs: ChangeSet): Change[] {
  const out: Change[] = [];
  cs.iterChanges((fromA, toA, _fb, _tb, ins) => out.push({ from: fromA, to: toA, insert: ins.toString() }));
  return out;
}

function overlaps(a: Change, b: Change): boolean {
  if (Math.max(a.from, b.from) < Math.min(a.to, b.to)) return true;
  if (a.from === a.to && b.from < a.from && a.from < b.to) return true;
  if (b.from === b.to && a.from < b.from && b.from < a.to) return true;
  return false;
}

// prefix/suffix diff, only for the rare resync fallback
function simpleDiff(a: string, b: string): Change[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return p === a.length && p === b.length ? [] : [{ from: p, to: a.length - s, insert: b.slice(p, b.length - s) }];
}

export class FileSync {
  view!: EditorView;
  private base: Text;
  private baseHash: string;
  private inflight: ChangeSet | null = null; // sent, not yet acked (from base)
  private pending: ChangeSet; // unsaved, from base+inflight
  private timer: number | undefined;
  holdSaves = false; // test hook
  replaced: Replaced[] = []; // unsaved text that lost to a disk edit (shown in a bar)

  constructor(readonly path: string, text: string, hash: string,
              private send: (m: ClientMsg) => void,
              readonly onStatus: (s: "saved" | "unsaved" | "saving") => void,
              readonly onReplaced: (r: Replaced[]) => void,
              readonly onExternal: (n: number) => void) {
    this.base = Text.of(text.split("\n"));
    this.baseHash = hash;
    this.pending = ChangeSet.empty(this.base.length);
  }

  // called from the view's updateListener
  onUpdate(u: ViewUpdate) {
    if (!u.docChanged) return;
    for (const tr of u.transactions) {
      if (this.replaced.length) this.replaced = this.replaced.map((r) => ({ ...r, pos: tr.changes.mapPos(r.pos) }));
      if (tr.annotation(remoteEdit)) continue;
      this.pending = this.pending.compose(tr.changes);
    }
    if (!this.pending.empty) {
      this.onStatus("unsaved");
      this.schedule();
    }
  }

  schedule(ms = SAVE_DEBOUNCE_MS) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), ms);
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.holdSaves || this.inflight || this.pending.empty) return;
    const changes = this.pending;
    this.inflight = changes;
    this.pending = ChangeSet.empty(changes.newLength);
    this.onStatus("saving");
    const text = changes.apply(this.base).toString();
    this.send({ type: "save", path: this.path, base_hash: this.baseHash, text_hash: await sha256(text), changes: toList(changes) });
  }

  onSaved(hash: string) {
    if (!this.inflight) return;
    this.base = this.inflight.apply(this.base);
    this.baseHash = hash;
    this.inflight = null;
    if (this.pending.empty) this.onStatus("saved");
    else this.schedule(0);
  }

  onConflict(diskText: string, diskHash: string) {
    // the server always sends `external` first, so normally inflight is already folded in
    if (this.inflight) {
      this.pending = this.inflight.compose(this.pending);
      this.inflight = null;
    }
    if (diskHash !== this.baseHash) this.applyExternal(this.baseHash, diskHash, simpleDiff(this.base.toString(), diskText));
    this.schedule(0);
  }

  // after a reconnect: anything in flight may be lost, fold it back and catch up with disk
  resume(text: string, hash: string) {
    if (this.inflight) {
      this.pending = this.inflight.compose(this.pending);
      this.inflight = null;
    }
    if (hash !== this.baseHash) this.onFile(text, hash);
    else if (!this.pending.empty) this.schedule(0);
  }

  onFile(text: string, hash: string) {
    this.applyExternal(this.baseHash, hash, simpleDiff(this.base.toString(), text));
  }

  applyExternal(baseHash: string, newHash: string, changes: Change[]) {
    if (baseHash !== this.baseHash) {
      this.send({ type: "resync", path: this.path });
      return;
    }
    const B = ChangeSet.of(changes, this.base.length);
    const A = this.inflight ? this.inflight.compose(this.pending) : this.pending;
    this.inflight = null; // its save will come back as save_conflict
    const local = toList(A);
    const keep = local.filter((a) => !changes.some((b) => overlaps(a, b)));
    const drop = local.filter((a) => changes.some((b) => overlaps(a, b)));
    let tr: ChangeSet;
    let newPending: ChangeSet;
    let lost: Replaced[] = [];
    if (!drop.length) {
      tr = B.map(A, true);
      newPending = A.map(B);
    } else {
      // disk wins where it overlaps unsaved typing: revert those local hunks, keep the rest
      const keepCs = ChangeSet.of(keep, this.base.length);
      const dropCs = ChangeSet.of(drop, this.base.length).map(keepCs);
      const docKeep = keepCs.apply(this.base);
      tr = dropCs.invert(docKeep).compose(B.map(keepCs, true));
      newPending = keepCs.map(B);
      lost = drop.filter((d) => d.insert).map((d) => ({ text: d.insert, pos: newPending.mapPos(B.mapPos(d.from, 1), 1) }));
    }
    this.base = B.apply(this.base);
    this.baseHash = newHash;
    this.pending = newPending;
    this.view.dispatch({ changes: tr, annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)] });
    if (lost.length) {
      this.replaced = [...this.replaced, ...lost];
      this.onReplaced(this.replaced);
    }
    this.onExternal(changes.length);
    if (!this.pending.empty) this.schedule();
  }

  reinsert(i: number) {
    const r = this.replaced[i];
    this.dismiss(i);
    this.view.dispatch({ changes: { from: r.pos, insert: r.text }, userEvent: "input" });
  }

  dismiss(i: number) {
    this.replaced = this.replaced.filter((_, j) => j !== i);
    this.onReplaced(this.replaced);
  }

  get dirty() { return !this.pending.empty || this.inflight !== null; }
}
