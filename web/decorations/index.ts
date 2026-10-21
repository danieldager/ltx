// Decoration layer entry point (owned by phase 2, SPEC §13.4).
import type { Extension } from "@codemirror/state";
import type { IndexMsg } from "../protocol";
import { muteMarkup } from "./highlight";
import { paperStructure } from "./paper";
import { wordView } from "./wordview";
import { reviewExtension } from "../review";
import type { ClientMsg } from "../protocol";

export { setWord } from "./wordview";

export interface DecorationContext {
  path: string;
  getIndex(): IndexMsg | null;
  onIndex(cb: (i: IndexMsg) => void): void;
  send(m: ClientMsg): void;
}

export function decorationExtensions(ctx: DecorationContext): Extension[] {
  return [reviewExtension(ctx.path, (m) => ctx.send(m)), paperStructure, muteMarkup, wordView];
}
