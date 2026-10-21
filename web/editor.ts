// CM6 editor for one file. The buffer is the .tex text; all typing is local.
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { quotes } from "./quotes";
import { decorationExtensions, DecorationContext } from "./decorations/index";

export interface EditorOpts {
  parent: HTMLElement;
  path: string;
  text: string;
  decorations: DecorationContext;
  extra?: Extension[]; // sync listener, save keymap, selection hooks
}

export function createEditor(o: EditorOpts): EditorView {
  return new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        quotes,
        decorationExtensions(o.decorations),
        ...(o.extra ?? []),
      ],
    }),
  });
}
