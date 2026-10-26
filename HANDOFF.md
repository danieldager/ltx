# HANDOFF: ltx (latex-editor)

Updated 2026-10-19, end of phases 0 and 1. Plan of record: `SPEC.md` (§0 overrides, §13 frozen
interfaces). Scope per Daniel: personal tool, this Mac only, don't over-engineer.

## Done
- Phase 0: SPEC updated (browser tool, econ-paper look, `ltx new`, scope cut, frozen ws +
  sidecar formats in §13). uv package, esbuild frontend, Latin Modern woff2 fonts extracted
  from tectonic's bundle (`src/ltx/static/fonts/`, GUST licence).
- Phase 1: server (`src/ltx/server.py`: ws hub, CAS save, watchfiles watcher → line+char
  diffs, selection/comments sidecar handlers), `sync.py` (apply/diff/atomic write),
  `compile.py` (tectonic single-flight, 0.5 s debounce, plain-language errors,
  `compile_errors.json`, aux/bib/macro index), `cli.py` (`ltx open|new|serve`), econ-paper
  template (`src/ltx/templates/econ_paper/`). Frontend (`web/`): CM6 editor, `FileSync`
  (local typing → pending ChangeSet → 400 ms save; remote changes mapped through unsaved
  typing, disk-wins-on-overlap with a "replaced" bar), paper-styled source view
  (`decorations/paper.ts`, `decorations/highlight.ts`, `paper.css`), pdf.js pane with lazy
  pages and in-place swap at the same scroll, error strip, file tabs, justify toggle.

## How to run
- `ltx` is on PATH via `uv tool install --editable /path/to/latex-editor`.
- `ltx open path/to/main.tex` starts a detached server (log: `<docroot>/.ltxed/server.log`),
  prints the URL and opens the browser; a second `open` reuses it. Stop: `kill <pid>` from
  `.ltxed/session.json` (no `ltx stop` by design).
- `ltx new path/to/paper.tex` (or a dir → `main.tex`) + `references.bib`; `--open` to open.
- Frontend rebuild after editing `web/`: `cd web && npm run build` (writes `src/ltx/static/`).
  Typecheck: `npx tsc --noEmit`.
- Tests: `uv run pytest tests -q` (45 tests, ~1–2 min; headless Chromium via Playwright; they
  copy the fixtures into pytest tmp dirs, never touching the originals).

## Test status (all pass)
- Open + save untouched, report and short fixtures: bytes and mtimes unchanged.
- Replace one word in the longest paragraph line: diff is exactly one line.
- External edit to another paragraph during unsaved typing: both survive, cursor stays
  after the typed text, undo reverts only Daniel's typing, disk ends with both.
- Same-region collision: disk wins, the lost text shows in the bar, re-insert works.
- Typing: no websocket frame while typing; first save frame only after the debounce;
  local dispatch ~1 ms per keystroke on the 900-line fixture.
- Background compile of both docs succeeds and renders; a broken copy (unclosed itemize)
  shows "The itemize block opened on line N is never closed" and keeps the last good PDF;
  fixing it clears the strip.
- `ltx open` launches server + browser (via $BROWSER) and reuses a running server;
  `ltx new` output compiles with tectonic.

## Polish round (2026-10-26)
- Perf: pdf.js and KaTeX split into lazy chunks (`static/chunks/`, content-hashed; app.js 1020 → 349 KB);
  paper decorations map through prose-only edits instead of a full rebuild (`decorations/paper.ts`
  `proseOnly`); file start numbering cached per renumber pass, not per keystroke; replaced pdf.js
  documents destroyed (one worker, not one per rebuild); server line diff trims unchanged lines first.
- Features: selection sidecar (`selection.ts`, was a stub), Outline + word counts and Comments list
  (`panels.ts`, `numbering.ts` `outline()`), outside-edit flash (`flash.ts`), SynCTeX Cmd+J and PDF
  double-click (`src/ltx/synctex.py`, `/api/synctex`), styled Cmd+F panel, « ? » help (`help.ts`: one
  `HELP` list; a test checks it names every toolbar control).

## Known issues / limits
- On launch the server compiles and overwrites `<docroot>/main.pdf` with a fresh build
  (spec intent; matters for the committed PDFs next to the sources).
- Undefined ref/cite warnings carry `file: null` (log file tracking not parsed).
- Section numbering is per file (an `\input`ed appendix restarts at its own count).
- No CRLF/BOM handling; non-BMP characters would desync offsets (docs are plain UTF-8/LF).
- Tests that set the cursor programmatically must wait two animation frames before typing
  (helper `place()` does); real clicks are unaffected.

## For the phase 2 / phase 3 agents
- Contracts: `SPEC.md` §13 (ws messages, sidecars, offsets/hashes) and `web/protocol.ts`.
- Phase 2 owns `web/decorations/**` (entry `decorationExtensions(ctx)` in `index.ts`;
  `ctx = {path, getIndex(), onIndex(cb)}` gives the label/cite/macro index), `web/paper.css`,
  `web/editor.ts`, new `web/toolbar.ts` / `web/input.ts`. Replace `highlight.ts` muting with
  hiding; keep `paper.ts` structure or fold it in.
- Phase 3 owns `web/selection.ts` (`selectionExtension(path, send)`, stub, already wired in
  `main.ts`), `web/comments.ts` (`showComments(comments)`, stub, wired), `web/errors.ts`,
  SynCTeX (`src/ltx/synctex.py` + `web/pdf.ts`), `skill/ltx.md`. Server handlers for
  `selection`, `comment_add/update/delete` and `comments.json` watching already exist.
- Shared (coordinate): `src/ltx/server.py`, `web/sync.ts`, `web/main.ts`, `web/protocol.ts`.
- Test hook: `window.__ltx = {syncs, view(path?), hold(bool)}` (`hold(true)` pauses saves).
