// Phase 3: selection sidecar. Stub: exports the hook main.ts wires in.
import type { Extension } from "@codemirror/state";
import type { ClientMsg } from "./protocol";

export function selectionExtension(_path: string, _send: (m: ClientMsg) => void): Extension[] {
  return [];
}
