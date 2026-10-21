// Decoration layer entry point (owned by phase 2, SPEC §13.4).
import type { Extension } from "@codemirror/state";
import type { IndexMsg } from "../protocol";
import { muteMarkup } from "./highlight";
import { paperStructure } from "./paper";
import { wordView } from "./wordview";

export { setWord } from "./wordview";

export interface DecorationContext {
  path: string;
  getIndex(): IndexMsg | null;
  onIndex(cb: (i: IndexMsg) => void): void;
}

export function decorationExtensions(_ctx: DecorationContext): Extension[] {
  return [paperStructure, muteMarkup, wordView];
}
