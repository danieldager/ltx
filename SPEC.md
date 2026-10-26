# latex-editor (`ltx`): implementation spec

Status: approved 2026-10-19 with the changes in §0, which override anything below that
conflicts with them. Phases 0 and 1 built 2026-10-19 (see `HANDOFF.md`). The frozen
interfaces for the phase 2 and phase 3 agents are in §13.

## 0. Approved changes (2026-10-19, override the rest of this spec)

1. **Local interactive browser tool.** A local server plus one browser tab. All typing is
   client-side and instant: CodeMirror 6 in the browser, and the `.tex` text is the buffer.
   No keystroke ever waits on the network. Disk sync is a debounced background save
   (400 ms after typing stops). External changes (Claude editing the file) arrive over the
   websocket and are merged as change sets without moving the cursor. The tectonic compile
   runs in the background and never blocks typing or reloads the page. **No full page
   reloads, ever** (the PDF pane swaps pages in place).
2. **Economics-paper look.** The editing view reads like a standard economics working
   paper: Latin Modern serif (webfonts extracted from tectonic's bundle, GUST font
   licence, shipped in `static/fonts/`), a page-width centred column on a paper-coloured
   sheet, the title/author/date/abstract block styled as a paper front page (with the JEL
   and Keywords lines), section headings numbered like the PDF (1, 1.1, 1.1.1; A, A.1 after
   `\appendix`), footnote markers as superscript numbers, and a justified-text toggle.
   Phase 1 still shows the LaTeX source, but prose lines already render in the paper font
   and markup is visible but muted (small, grey). The full markup-hiding layer is phase 2.
3. **Template.** `ltx new <path>` creates a new document from a standard economics-paper
   template (`src/ltx/templates/econ_paper/`: article 12pt, 1in margins, `setspace`
   `\onehalfspacing`, natbib author-year, booktabs, hyperref, amsmath, graphicx,
   title/author/date/abstract with JEL codes and keywords lines, numbered sections with a
   methodology section, and a `references.bib` stub). It compiles with tectonic as is.
4. **Node** is installed (v26). The frontend is built with esbuild from `web/` and the
   output in `src/ltx/static/` is committed, so day-to-day use needs only Python/uv.
5. **Tinyleaf** was not forked. Our sync model (base-hash CAS + change-set mapping) is the
   core of the app and Tinyleaf has none of it, so starting clean was cheaper than
   adapting it (and keeps the code non-AGPL).
6. **Compile debounce** is 0.5 s (not 1.0 s), since saves are already debounced 400 ms.


## 1. Goal

"Google Docs for LaTeX, but I don't see the LaTeX." Daniel edits prose in a plain
word-processor view. Anything structural (tables, equations, figures, listings, layout)
he asks Claude for, either in the terminal as he does today or from inside the editor.
The `.tex` files on disk stay the single source of truth. They must stay
Overleaf-compatible and compile with `tectonic`. The PDF rebuilds itself and sits next to
the text.

Hard requirements:

- **R1 Surgical write-back.** If Daniel opens and saves without changing anything, the diff
  is zero bytes. Changing one word changes only the line it is on. The editor never
  reformats, rewraps, re-indents or normalises source it did not touch.
- **R2 Live external edits.** When Claude (or git, or anything else) changes a `.tex` on
  disk, the open editor shows the change within about 1 s. Daniel's cursor stays put and
  his unsaved typing is kept.
- **R3 PDF follows.** The PDF recompiles after every save and keeps its scroll position.
  If compilation fails, the error is shown in plain words and Claude can pick it up.
- **R4 Simplicity.** One local process, one browser tab, and one command to launch it.

Documents it has to handle (the test fixtures in `tests/fixtures/` are neutral stand-ins):

| Doc | Constructs the editor must survive |
|---|---|
| `report/main.tex` (+ `appendix_prompts.tex`, `references.bib`, `figures/`) | one paragraph per source line (very long lines), `\section/\subsection`, `table`+`threeparttable`+`tablenotes`, `equation` with `\label`, inline `$..$`, `\ref`/`\eqref`, `\citep`, footnotes, user macros (`\toconfirm{}` in red), `itemize`, `\includegraphics`, `\appendix` + `\input` |
| `short/main.tex` (+ `claims_table.tex`, `prompts/*.txt`) | `longtable` whose body is `\input{claims_table.tex}`, `\lstinputlisting{prompts/...}`, `itemize` with enumitem options, placeholder macros `\tc{}`/`\tbc{}` (red) |

Environment probe (2026-10-12): `tectonic` 0.17.0 is at `/opt/homebrew/bin`. `node`, `npm`,
`pandoc`, `pdflatex`, `latexmk` and `code` are all missing. `brew` and `claude` are
present. Full tectonic compiles of copies of two real papers took 1.0–2.8 s and 1.7 s. tectonic supports `--synctex`, `--keep-intermediates` and `--outdir`.

## 2. Choice of base

### Options evaluated

**(a) Rich-text editor (TipTap/ProseMirror) over an intermediate document model parsed
from the `.tex`, with non-prose shown as locked blocks.**
- Pro: the most "Google Docs" feel, with real paragraphs, marks and a clean toolbar.
- Con: R1 is hard. The buffer is a tree, not the file, so every node needs a source-span
  map and a serializer that re-emits untouched spans byte for byte and patches only the
  edited ones. That means writing a partial LaTeX parser and keeping it lossless across
  user macros, `{,}`, `~`, comments, odd whitespace and one-paragraph lines.
- Con: R2 is harder still. Each Claude edit forces a re-parse and a rebuild of the tree.
  Keeping the cursor and unsaved text across that rebuild means mapping positions between
  two trees.
- Verdict: feasible, but most of the build effort would go into fidelity and none into
  features. **Runner-up.**

**(b) CodeMirror 6 with heavy LaTeX decorations ("Visual Editor" style). The buffer is the
source text and markup is hidden or replaced by widgets.**
- Pro: R1 holds by construction. The buffer *is* the file, so saving writes exactly what
  is there, and an edit is a text change at a known offset.
- Pro: R2 is native. A disk diff becomes a CM6 `ChangeSet`, which CM6 maps against local
  edits, the cursor and the undo history. Its transaction model was built for this.
- Pro: CM6 decorations are viewport-lazy, so 1.7k-character lines and 900-line files are
  fine. A "show source" escape hatch is a single toggle.
- Con: the "hide the LaTeX" layer is the real work: deciding per macro whether to style,
  chip or lock it, handling cursor behaviour around atomic ranges, and escaping typed
  input. It still feels slightly less like a word processor than ProseMirror.
- Precedent: Overleaf's Visual Editor is exactly this design, built on CM6 decorations
  over the source buffer.
- Verdict: **Recommended.**

**(c) pandoc LaTeX ↔ HTML/Markdown round trip.** Tested on copies of two real papers with
pandoc 3.9, fetched through `uv run --with pypandoc_binary` and not installed system-wide.
- `latex→latex`: a 907-line paper grows to 2349 lines and a 451-line one to 1214 lines.
- `latex→html→latex`: about the same.
- Concrete losses:
  - every `\ref` is hard-coded to `\hyperref[sec:x]{2}`, so all 51 refs are gone
  - `\toconfirm{..}` is expanded to literal `{[}TO CONFIRM: ..` and the red colour is lost
  - all 26 `threeparttable`s become `longtable`s and `tablenotes` are lost
  - `\input` is inlined into `main.tex`
  - `tikzpicture` and all four `\lstinputlisting`s disappear
  - the preamble is replaced and paragraphs are rewrapped
- Verdict: **Rejected.** It fails R1 completely.

**(d) Existing products.**
- *Overleaf Visual Editor + git bridge (cloud).* This is the closest thing to what Daniel
  asked for. Costs: the git bridge needs a paid plan; Claude edits a local clone, so every
  change goes through a push/pull cycle with Overleaf, and sync is manual and
  conflict-prone; nothing in the editor knows what Claude is doing; compile happens on
  their servers.
  - It is the fallback if we decide not to build anything.
- *Overleaf Community Edition, self-hosted.* AGPL, Docker plus Mongo plus Redis. It is a
  heavy stack and its project storage lives in Mongo, not on disk files, so Claude cannot
  simply edit files. (Unverified whether the CE editor includes the Visual Editor.) Its
  CM6 visual-mode source is useful as a design reference. Copying its code would make
  `ltx` AGPL, which is fine for personal use.
- *VS Code + LaTeX Workshop.* Good PDF/SyncTeX tooling, but the source is always
  visible, which is exactly what Daniel doesn't want. VS Code isn't installed either.
- *LyX / GNU TeXmacs.* Both use their own document model and import `.tex` lossily (same
  failure mode as pandoc). They fail R1 and R2.
- *Compositor (macOS).* A WYSIWYG TeX editor that edits the output and maps changes back.
  It is a paid beta, closed source and not scriptable by Claude.
- *Typst-based tools.* A different language, so not Overleaf-compatible. Out.
- *Tinyleaf (PyPI, AGPL).* A CM6 source editor with a pdf.js preview. It has no visual
  mode, but is structurally close to our Phase 1. Spend 30 min in Phase 0 judging whether
  to fork it as the skeleton or to start clean. Unverified.

### Recommendation

Build **(b)**: a small local app with CM6 and a hide-markup decoration layer over the raw
`.tex` buffer, a Python/uv server and a pdf.js pane. R1 and R2 come for free from the
buffer model, so all of the effort goes into the visual layer, which is the part Daniel
actually sees.

## 3. Architecture

### Process layout

```
browser tab  ──ws──  ltx server (Python, uv, 127.0.0.1, one per doc root)
  CM6 editor            ├─ file sync (watchfiles + compare-and-swap writes)
  pdf.js pane           ├─ compiler (tectonic subprocess, single-flight)
  comments UI           ├─ sidecars (.ltxed/: session, selection, comments, errors)
                        └─ optional: claude -p runner (Phase 4)
Claude Code (terminal) ── reads/writes .tex + .ltxed/*.json directly (no API needed)
```

- **Server:** Python 3.12+, `uv` package with Starlette + uvicorn (HTTP + websocket) and
  `watchfiles`. It has no database. It binds to `127.0.0.1` on a free port, and a random
  token in the URL guards the websocket.
- **Frontend:** TypeScript, CM6 (`@codemirror/state`, `view`, `commands`, `search`,
  `language`, plus `codemirror-lang-latex` or a small stream parser), pdf.js and KaTeX
  for inline math previews. It is built once with esbuild into `src/ltx/static/` and that
  output is **committed**, so runtime needs only Python.
- **Node:** needed at build time only (`cd web && npm install && npm run build`).
  Installed as of 2026-10-19.

### File layout (as built: see `HANDOFF.md`; the tree below is the original plan)

```
/path/to/latex-editor/
  SPEC.md
  pyproject.toml            # package "latex-editor", console script "ltx"
  src/ltx/
    cli.py                  # ltx open | status | stop
    server.py               # routes, websocket hub, session file
    sync.py                 # disk state, base hashes, CAS write, 3-way merge helper
    watch.py                # watchfiles loop → diff → ws push
    compile.py              # tectonic runner, log → plain-language errors, aux/bib index
    sidecar.py              # .ltxed/*.json read/write (atomic rename)
    claude_runner.py        # Phase 4 only
    static/                 # built frontend (committed)
  web/                      # frontend source
    main.ts  editor.ts  sync.ts  input.ts  toolbar.ts
    decorations/ inline.ts  blocks.ts  chips.ts  catalog.ts
    pdf.ts   comments.ts    selection.ts
  tests/
    fidelity/  sync/  compile/  e2e/   # pytest + python-playwright (uv), no node at test time
  skill/ltx.md              # Claude Code skill text (sidecar protocol), symlinked into ~/.claude/skills
```

Add a row to `dev/tools/README.md` when the first version lands.

### Launch and discovery

- `ltx open papers/report/main.tex`
  - starts the server (or reuses one already serving that doc root)
  - opens the browser at `http://127.0.0.1:<port>/?t=<token>`
  - prints the URL
- The doc root is the directory of the root `.tex`. `ltx` creates `<docroot>/.ltxed/`
  there (and offers to add it to the repo's `.gitignore`).
- `<docroot>/.ltxed/session.json` holds `{pid, port, token, root_tex, files, started_at}`.
  It is deleted on clean exit, and a stale pid counts as not running.
- A global registry at `~/.ltx/sessions.json` lets `ltx status` list every open doc with
  its URL and current selection.
- How Claude finds it: the `ltx` skill, plus one line in the global CLAUDE.md: "if a
  `.ltxed/` dir sits next to a .tex you are asked about, follow the ltx skill". Claude
  needs no port or API. It reads and writes files only.

### Websocket messages (summary; the frozen contract is §13)

| Direction | Message | Purpose |
|---|---|---|
| server → client | `hello{files:[{path, text, hash}], pdf_url, index}` | initial load |
| client → server | `save{path, base_hash, text_hash, changes:[{from,to,insert}]}` | autosave |
| server → client | `saved{path, hash}` / `save_conflict{path, disk_text, disk_hash}` | ack / CAS failure |
| server → client | `external{path, base_hash, new_hash, changes:[...]}` | disk changed by someone else |
| server → client | `compile{state: running\|ok\|error, pdf_rev, errors:[{file,line,msg,plain}]}` | build status |
| server → client | `index{labels:{key:"3.2"}, cites:{key:"Smith (2020)"}, macros:{...}}` | for chips, from `.aux`/`.bib`/preamble |
| client → server | `selection{path, from, to, line, text, context}` | selection sidecar |
| client ↔ server | `comment_add / comment_update / comments{...}` | comments sidecar |
| client → server | `ask_claude{instruction, selection}` (Phase 4) | in-app command box |

## 4. Sync model

The disk is authoritative, and the editor holds a fast-forwarding copy of it.

- **Per-file state on the server:** `base_text` and `base_hash`, the last content both
  sides agree on.
- **Autosave:** the client batches CM6 changes and sends them 400 ms after typing stops,
  and also on blur, on file switch and on `Cmd-S`. The message carries the `base_hash` it
  was built on.
  - If the disk hash still equals `base_hash`, the server applies the changes to
    `base_text`. If the result hashes to `text_hash`, it writes atomically (tmp file plus
    rename, same mode, no newline normalisation) and acks.
  - Otherwise it replies `save_conflict` and the client merges as below, then retries.
- **External change** (watcher event, ignoring our own writes by hash):
  1. The server diffs `base_text` against the new disk text with a line-then-character
     diff, which is enough for Claude's `Edit` patches.
  2. It sends `external{changes}`.
  3. The client builds a CM6 `ChangeSet` from the changes and maps it through any unsaved
     local changes (`ChangeSet.map`). It dispatches the result as one transaction tagged
     `remote`, so it doesn't enter Daniel's undo history as his own edit.
  4. The cursor, selection and unsaved text are kept automatically.
- **Overlap rule:** this applies only when an external hunk touches characters Daniel
  changed and has not yet saved, a window of at most about 400 ms.
  - Disk wins for that hunk.
  - Daniel's overwritten fragment goes into a dismissible "Your unsaved text here was
    replaced by an outside edit: [copy] [re-insert]" bar.
  - Nothing is ever silently lost.
  - No locking. CAS plus mapping makes a "Claude is editing" lock unnecessary.
- **Activity cue:** when an external change arrives, a soft banner shows "Updated from
  disk (main.tex, 3 places)" and the changed ranges flash for 2 s, so Daniel sees what
  Claude did.
- **Byte fidelity rules:**
  - Read and write as UTF-8 bytes, preserving a BOM if present.
  - Never strip trailing whitespace, never add or remove the final newline, never convert
    tabs or CRLF.
  - If nothing changed, the client sends no save at all.

## 5. PDF

- **Trigger:** compile after each successful save or external change. Debounce 1.0 s.
  Only one compile runs at a time; changes that arrive mid-compile queue exactly one
  follow-up run.
- **Command:**
  `tectonic -X compile main.tex --synctex --keep-intermediates --keep-logs --outdir .ltxed/build`.
  Keeping intermediates means the `.aux` is reused, so refs settle without extra passes.
  Measured time is 1–3 s for these docs.
- **Output:** on success, copy `.ltxed/build/main.pdf` to `<docroot>/main.pdf`, so the
  committed PDF stays current. A failed build never overwrites the last good PDF.
- **Pane:** pdf.js viewer on the right, with a draggable split. On reload it keeps the
  current page and vertical offset and swaps pages in without flicker. It also has zoom
  and fit-width.
- **SynCTeX (Phase 3):**
  - Click a paragraph, then `Cmd-J`: jumps the PDF to that spot.
  - Double-click the PDF: moves the editor cursor to the matching source line.
  - Implementation: parse the gzipped `.synctex` text format in Python. It is a small,
    well-documented format and needs no `synctex` binary.
- **Errors:**
  - Parse `! ...` lines and `l.<n>` lines from the log, plus undefined-reference and
    citation warnings, into `{file, line, msg, plain}`.
  - `plain` comes from a short lookup table, for example "A table or list was opened but
    never closed near line 214" or "Unknown command \foo on line 88".
  - Show them as a red strip above the PDF, with "jump" and "Ask Claude to fix".
  - Always write the errors to `.ltxed/compile_errors.json`, so in the terminal "fix the
    build" works with no copying.
- **Index for chips:** after each good compile, read `.aux` for label → number and
  bibitem → author-year, and the preamble for `\newcommand` definitions. Push the result
  as `index`.

## 6. What Daniel sees and can edit

The buffer is the `.tex`. Every construct is classified in `decorations/catalog.ts`, which
is built by auditing every macro and environment in both docs (see the inventory in §1).
Classes:

| Class | Rendering | Editable by hand | Examples |
|---|---|---|---|
| prose | plain text | yes | paragraph text |
| style | text styled, markup hidden | yes (inside) | `\emph`, `\textit`, `\textbf`, `\texttt`, `\section{}`→H1, `\subsection{}`→H2, `\paragraph{}`→bold run-in |
| typography | shown as the glyph, source hidden | yes (typing the glyph inserts the source) | `~`→nbsp, `{,}`→`,`, `--`→–, `---`→—, ``` `` '' ```→“ ”, `\%`→%, `\&`→& |
| chip | non-editable pill, atomic | delete only; hover shows target | `\ref`/`\eqref` → "Section 3", `\citep`/`\citet` → "Smith (2020)", `\path`/`\nolinkurl`/`\url` → monospace link, `\ci{a}{b}`→"[a, b]" |
| placeholder | red highlight pill showing its text, inner text editable | yes (text); "Resolve" asks Claude | any macro whose preamble definition contains `\textcolor{red}` (`\toconfirm`, `\tc`, `\tbc`) |
| inline math | KaTeX-rendered, atomic | no (ask Claude) | `$S(c)\le -4.0$` |
| list | bullets/numbers, `\item` hidden | yes; Enter adds `\item`, Tab/Shift-Tab nests | `itemize`, `enumerate` (options kept verbatim) |
| locked block | card: kind + caption/label + small preview, atomic | no (ask Claude) | `table`, `longtable`, `figure` (thumbnail of the PNG), `equation`/`\[\]` (KaTeX), `verbatim`, `tikzpicture`, `\lstinputlisting` (file name + first lines), `\input` of a non-prose file, `\tableofcontents`, `\maketitle` |
| hidden | not shown | no | preamble (everything before `\begin{document}`), `%` comment lines (shown as a faint margin dot) |
| unknown | grey monospace chip with the raw macro, atomic | no | anything not in the catalog, so it is never silently mangled |

- **Typing and paste:** an input filter escapes LaTeX specials typed or pasted as text
  (`% & $ # _ { } ~ ^ \`) to their source forms. Paste is plain text only. Paragraph
  breaks become blank lines.
- **Toolbar and shortcuts:**
  - **Bold** (`Cmd-B` wraps the selection in `\textbf{}`) and *Italic* (`Cmd-I` wraps it
    in `\emph{}`). Pressing the shortcut again removes the wrapper.
  - Heading level dropdown: Body, Section, Subsection, Paragraph.
  - Bullet list and numbered list.
  - Undo and redo (CM6 history, local edits only).
  - Find and replace (CM6 search, run over the visible text).
  - "Show source" toggle as the escape hatch.
  - "Comment for Claude" (Phase 3) and "Ask Claude" (Phase 4).
- **Not in v1:**
  - Footnotes. Neither doc uses them. They would be added as a chip plus popover if
    needed.
  - Editing captions and `tablenotes` text inside locked blocks. This is a Phase 2
    stretch goal: render caption text as an editable prose range inside the card.
  - Fonts, colours, spacing and page layout. Those are Claude's job.
- **Not editable by hand, by design:** tables, equations and inline math, figures,
  listings, TikZ, and the preamble. Daniel selects or clicks the block and either says
  "change this table so…" in the terminal (Claude reads the selection sidecar) or leaves a
  Comment for Claude.

## 7. Multi-file documents

- **Sidebar:** a file list built from the root `.tex` by following `\input`, `\include`,
  `\lstinputlisting`, `\includegraphics` and `\bibliography`. Each `.tex` is a separate CM6
  buffer with its own sync state. The server watches the whole doc root.
- **`\input{x}`:**
  - If `x` is mostly prose, as `appendix_prompts.tex` is (headings plus verbatim), the
    card shows "Appendix: prompts (appendix_prompts.tex) [open]", which opens it in a tab.
  - If it is table rows (`claims_table.tex`), it is locked and shown inside its parent
    table card.
  - The heuristic: the file contains `&`/`\\` row syntax and no paragraphs.
  - v1 does not splice inputs into one continuous view. Splicing would break the
    one-buffer-equals-one-file rule.
- **`\lstinputlisting{prompts/...}`:** a locked card that shows the file. The `.txt`
  files are not editable in the editor; ask Claude.
- **`.bib`:** not shown. Citations appear as chips resolved through the index.

## 8. Claude integration

Options:

1. **Terminal, zero integration.** Claude edits files and the app live-reloads (§4). This
   works from Phase 1.
2. **In-app command box.**
   - The server runs `claude -p "<instruction + selection context>" --output-format stream-json --allowedTools Read,Edit,Write,Grep,Glob`
     with `cwd=<docroot>`, keeps its session id, and uses `--resume` for follow-ups. It
     streams progress into a side panel.
   - Pro: Daniel never leaves the tab.
   - Con: it is a second Claude thread that lacks the terminal session's project context,
     and its cost and usage are less visible.
3. **Comment for Claude.**
   - Daniel selects text, writes an instruction, and it is stored in
     `.ltxed/comments.json` as
     `{id, file, anchor:{quote, prefix, suffix, line}, instruction, status:open|done|wontdo, reply}`.
   - The comment shows as a margin highlight.
   - In the terminal, "do the comments" makes Claude apply each one, set
     `status`/`reply`, and the editor shows the replies.
   - Anchors re-attach by quote plus context after edits, the same way as the existing
     artifact-comments workflow.

Plus a **selection sidecar**: the client writes `.ltxed/selection.json` with
`{file, line_from, line_to, from, to, text, enclosing:{kind, label, caption}, paragraph_text, ts}`
on every selection change (throttled to 300 ms). This lets "this paragraph", "this table"
or "the selected sentence" mean something in the terminal.

**Recommendation:** ship option 1 with the selection sidecar and compile-error sidecar in
Phase 1–3, and add option 3 in Phase 3. This delivers "I talk to you whenever I want"
through the Claude session Daniel already uses, with full project context, and costs no
extra machinery.

Option 2 is Phase 4 and optional. Build it only if Daniel finds himself switching windows
too much. It is about 150 lines, because `claude -p` does the work.

**`ltx` skill (Claude-side protocol, `skill/ltx.md`):**
- Before acting on deictic requests, read `.ltxed/selection.json`.
- For "do the comments", read `comments.json`, apply each comment, and write the reply and
  status back.
- For "fix the build", read `compile_errors.json`.
- Edit `.tex` with surgical `Edit` calls. Never rewrap or reformat untouched lines, and
  keep one paragraph per line.
- After editing, wait for `.ltxed/build/` to show a fresh compile, report the compile
  state, and fix anything the edit broke.
- Keep placeholders as `\toconfirm{}`/`\tc{}`/`\tbc{}`. Never invent macros the preamble
  lacks without adding them.

## 9. Risks

1. **Quality of the visual layer.** Hiding markup over arbitrary LaTeX is the bulk of the
   work and the main source of bugs: cursor movement across atomic chips, Backspace at a
   style boundary, nested braces, `\paragraph{}` run-ins, `{,}` inside numbers, and
   escaping on input.
   - Mitigations:
     - a catalog audit that fails CI if any macro or environment in the corpus is
       unclassified
     - an "unknown = locked chip" default
     - the "show source" escape hatch
     - a Playwright suite of keystroke scripts
2. **Concurrent-edit merge.** Losing Daniel's keystrokes would kill trust.
   - Mitigations:
     - CAS writes
     - `ChangeSet.map` rebasing
     - the visible "replaced" bar for overlaps
     - a stress test that types continuously while a script performs 200 random external
       edits, then asserts no character is lost from non-overlapping regions
3. **Toolchain and scope.** Node is not installed. CM6 must be bundled as a single copy.
   The temptation is to grow toward a full ProseMirror-like experience.
   - Mitigations:
     - Phase 0 settles Node
     - the built frontend is committed
     - v1 features are frozen at §6
     - captions and footnotes stay in the stretch list

Lesser risks:
- **Compile churn.** Single-flight compiles plus debounce handle it, and the measured
  1–3 s is fine.
- **Long lines.** 1.7k-character paragraph lines are fine in CM6, but they make git diffs
  whole-paragraph. Recommend `git diff --word-diff` in the skill.
- **AGPL.** Applies only if Overleaf or Tinyleaf code is copied, which is fine for
  personal use.

## 10. Test plan

- **Fidelity:** for every `.tex` reachable from both roots (tool `main.tex` and
  `appendix_prompts.tex`; short `main.tex` and `claims_table.tex`):
  - Open, idle, then close leaves zero bytes changed and no writes (mtime unchanged).
  - Open, then type a character and delete it: the content is byte-identical.
  - Replace one word in a 1.7k-character paragraph: `git diff --numstat` reports exactly
    1 line changed.
  - Typing `50% & $x_1$` as text produces `50\% \& \$x\_1\$`.
  - Cmd-B on a word produces exactly `\textbf{word}`.
  - New bullet in `itemize[nosep]` adds one `\item` line and leaves the options untouched.
  - Every one of these docs still compiles with tectonic after each scripted edit.
- **Sync:**
  - A Claude-style `Edit` to paragraph B while Daniel types in paragraph A: both survive,
    the cursor stays in A, and undo does not revert B.
  - An external edit in the same paragraph as unsaved typing: the "replaced" bar appears
    and its re-insert works.
  - An external full-file rewrite (git checkout): the buffer equals disk and the cursor is
    clamped.
  - A save racing an external write produces `save_conflict`, a merge and a correct final
    file.
- **Compile:**
  - An injected unclosed `\begin{table}` shows the plain-language error with the right
    line, keeps the last good PDF, and writes `compile_errors.json`.
  - Fixing the error clears the error strip.
  - The PDF scroll position is kept across 10 consecutive rebuilds.
- **Catalog audit:** a script extracts every `\macro` and `\begin{env}` from the corpus.
  Each must map to a class, otherwise the test fails.
- **Scale:**
  - Open a 900-line paper in under 1 s.
  - Typing latency under 16 ms per keystroke with all decorations on.
  - Synthetic 5k-line doc stays usable.
- **Claude loop (manual acceptance):** in a terminal Claude session, with ltx open on
  a paper, run
  - "make this table's last column narrower" with the table selected
  - "do the comments" with 3 comments
  - "fix the build" after a deliberate break

  Each must land in the editor and PDF without Daniel touching anything.

## 11. Build plan

Phases 0 and 1 are done (2026-10-19). File ownership for phases 2 and 3 is in §13.6; it
replaces the A/B/C split below.


| Phase | Content | Effort (agent-days) | Usable result |
|---|---|---|---|
| 0 | Approve `brew install node` (or the vendored-ESM fallback). Tinyleaf fork-or-not (30 min). Scaffold the uv package and esbuild. Freeze the ws/sidecar schemas from §3/§8 | 0.5 | skeleton |
| 1 | Server (session, CAS save, watcher, external diffs), CM6 source-mode editor, autosave, remote-change mapping, tectonic single-flight, pdf.js pane with scroll keep, error strip, `ltx open/status`, fidelity + sync tests | 2 | Daniel and Claude co-edit live with the PDF, source visible |
| 2 | Visual layer: catalog + audit, style/typography/chip/placeholder/list decorations, locked block cards (KaTeX, thumbnails), input escaping, toolbar, file sidebar, "show source". Stretch: caption editing | 3 | The "no LaTeX visible" editor |
| 3 | Claude glue: selection sidecar, comments (UI + anchoring + sidecar), compile-errors sidecar, `ltx` skill + CLAUDE.md line, SynCTeX both ways, change flash/banner | 1.5 | Full recommended workflow |
| 4 (optional) | In-app "Ask Claude" box via `claude -p --resume`, streaming panel | 0.5–1 | No terminal needed |

**Parallelisation:** after Phase 0 freezes the schemas, use 3 Opus agents with disjoint
file ownership.

- **Agent A, backend:** `src/ltx/*.py`, `tests/fidelity`, `tests/sync`, `tests/compile`.
  Phases 1 and 3 server side: sync, watcher, compile, index, sidecars, synctex parser,
  CLI.
- **Agent B, editor:** `web/editor.ts`, `web/sync.ts`, `web/input.ts`, `web/toolbar.ts`,
  `web/decorations/*`. The CM6 core in Phase 1, then the entire Phase 2 visual layer
  (the long pole).
- **Agent C, panes and e2e:** `web/pdf.ts`, `web/comments.ts`, `web/selection.ts`,
  `tests/e2e` (python-playwright), and `skill/ltx.md`.

A runs ahead on a mock client and B and C against a mock ws server, both generated from
the frozen schema. One integration pass by the main thread or Agent A at the end of each
phase. Phase 4, if wanted, goes to Agent A.

## 12. Daniel's workflow

1. In a terminal: `ltx open papers/report/main.tex`. A tab opens with the text on
   the left and the PDF on the right. No backslashes are visible.
2. He fixes wording by typing. Bold, italics, headings and lists come from the toolbar.
   Refs and citations are chips and red placeholders stand out. It autosaves, and the PDF
   refreshes within about 2 s at the same scroll position.
3. For anything bigger, he selects it (a table, a paragraph) and tells Claude in the
   terminal: "split this table into two" or "resolve the TO CONFIRM here from the clog".
   Claude knows what "this" is from the selection sidecar.
4. Claude edits the `.tex`. The editor shows the change in place with a brief highlight,
   without moving his cursor or losing his typing, and the PDF rebuilds.
5. While reading, he leaves "Comment for Claude" notes. Later he says "do the comments",
   and replies appear next to each one.
6. If the build breaks, a plain-language error appears over the PDF and he says "fix the
   build".
7. He commits as usual. The diffs are surgical, and the `.tex` stays Overleaf-ready.

## 13. Frozen interfaces (phase 0, 2026-10-19)

Scope (Daniel, 2026-10-19): a personal tool for this one Mac. Single user, localhost only,
no auth token, no registry, no packaging, no CRLF/BOM handling (the docs are UTF-8, LF).
Where §3–§12 describe more machinery than this, this section wins.

These are the contracts the phase 2 and phase 3 agents build against. Changes must be
additive (new optional fields, new message types). The TypeScript mirror is
`web/protocol.ts`; the Python side is `src/ltx/server.py` and `src/ltx/sidecar.py`.

### 13.1 Text, offsets, hashes

- **Paths** are POSIX, relative to the doc root (the directory of the root `.tex`).
- **Text** is the file decoded as UTF-8. **Offsets** are string offsets into it (JS and
  Python agree because the docs have no characters outside the BMP).
- **Hash** = hex SHA-256 of the UTF-8 text.
- **Change list** `changes: [{from, to, insert}]`: offsets in the coordinates of the base
  text, sorted, non-overlapping. Equals CM6 `ChangeSet.of(changes, baseLength)`.

### 13.2 Websocket `ws://127.0.0.1:<port>/ws`, JSON objects with a `type` field

Server → client:

| type | fields | when |
|---|---|---|
| `hello` | `version: 1, root, files: [{path, text, hash}], compile, index, comments, suggestions` | on connect |
| `saved` | `path, hash` | save written; `hash` is the new base |
| `save_conflict` | `path, disk_text, disk_hash` | save's `base_hash` was stale; the matching `external` was always sent first, so the client merges it and re-sends |
| `external` | `path, base_hash, new_hash, changes` | file changed on disk (Claude, git, another tab) |
| `file` | `path, text, hash` | reply to `resync` |
| `file_added` | `file: {path, text, hash}` | a new `\input` target appeared |
| `compile` | `state: running\|ok\|error, rev, pdf_url, errors, duration_ms` | build status; `pdf_url` = `/pdf?rev=<rev>`, always the last good PDF |
| `index` | `labels: {key: "3.2"}, cites: {key: "Smith et al. (2020)"}, macros: {name: {nargs, body}}` | after each good build |
| `comments` | `comments: [comment]` | after any change to `comments.json` |
| `suggestions` | `suggestions: [suggestion]` | after any change to `suggestions.json` (additive, round 3) |
| `error` | `msg` | protocol error |

Error objects: `{file, line, msg, plain, severity: "error"|"warning"}` (`file`/`line` may be
null; `plain` is the sentence shown to Daniel).

Client → server: `save {path, base_hash, text_hash, changes}`, `resync {path}`,
`compile_now {}`, `selection {<selection.json fields>}`, `comment_add {comment}`,
`comment_update {id, fields}`, `comment_delete {id}`, `suggestion_update {id, fields}`.

Ordering: one file's events are handled in order. If the disk changed under a save the
server sends `external` (to all clients) before `save_conflict`. After a successful save,
`saved` goes to the saver and `external` to the other clients.

### 13.3 Sidecars in `<docroot>/.ltxed/` (atomic tmp+rename writes)

- `session.json` (lock/port file; deleted on clean exit; dead `pid` = stale):
  `{version, pid, port, url, root_tex, files, started_at}`.
- `compile_errors.json` (after every build):
  `{version, state: "ok"|"error", rev, finished_at, duration_ms, root_tex, log_path, errors: [error]}`.
- `selection.json` (server writes it from the client's `selection` message, client throttles
  to 300 ms): `{version, file, from, to, line_from, line_to, text, paragraph_text,
  enclosing: {kind, label, caption} | null, ts}`. Lines 1-based.
- `comments.json` (server and Claude both write it; server watches it):
  `{version, comments: [{id, file, anchor: {quote, prefix, suffix, line}, instruction,
  status: "open"|"done"|"wontdo", reply, author, created_at, updated_at}]}`.
- `suggestions.json` (Claude writes it, server watches it, Daniel's client updates `status`,
  `user_comment` through `suggestion_update`): `{version: 1, suggestions: [{id: "s-xxxxxxxx", file,
  new, old, anchor: {prefix, suffix, line}, note, source: "note"|"comment:<id>",
  status: "open"|"accepted"|"rejected"|"discuss", user_comment, reply, created_at, updated_at}]}`.
  `new` is the text now in the file (may be "" for a deletion), `old` the text it replaced;
  `prefix`/`suffix` are ~40 chars around `new`. Only open/discuss ones are shown.
- `build/`: tectonic output. On success the PDF is copied to `<docroot>/<stem>.pdf`.
- `server.log`: the detached server's output.

HTTP: `GET /` app, `GET /static/*` assets, `GET /pdf` last good PDF, `GET /api/state`,
`GET /api/synctex?file=&line=` → `{page, y, y2, line}` and `?page=&x=&y=` → `{file, line}`
(additive, 2026-10-26; positions in PDF points from the page's top-left, from
`.ltxed/build/<stem>.synctex.gz`; 404 when there is no match).

### 13.4 Frontend modules (`web/`) and ownership

| Module | Owner |
|---|---|
| `protocol.ts` | frozen (additive edits only) |
| `main.ts` (boot, layout, tabs, toggles), `sync.ts` (`FileSync`: base, unsaved ChangeSet, CAS save, remote merge; remote transactions carry the exported `remoteEdit` annotation and `addToHistory: false`) | shared, coordinate before editing |
| `editor.ts` (`createEditor({parent, path, text, decorations})`), `decorations/**` (`index.ts` exports `decorationExtensions(ctx)`, `ctx = {path, getIndex(), onIndex(cb)}`), `paper.css`, new `toolbar.ts`, `input.ts` | **phase 2** |
| `selection.ts`, `comments.ts`, `errors.ts` ("Ask Claude to fix"), `pdf.ts` SynCTeX hooks + `src/ltx/synctex.py`, `skill/ltx.md` | **phase 3** (server handlers for selection/comments/compile_errors already exist) |

Build: `cd web && npm run build` writes `src/ltx/static/app.js` plus `static/chunks/` (pdf.js and
KaTeX, loaded on first use); rebuild after any web change.
