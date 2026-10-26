---
name: ltx
description: Work with a LaTeX paper that is open in the ltx browser editor. Use when a `.ltxed/` directory sits next to the .tex file being discussed, or the user says "this paragraph", "do the comments", "fix the build", or asks to edit the paper they have open in ltx.
---

# ltx: co-editing a LaTeX paper with the user

The user edits the same `.tex` files in a browser editor (`ltx`). The editor merges your
edits into the open buffer live, and builds the PDF in the background with tectonic. Your
side of the protocol is plain files in `<docroot>/.ltxed/` (next to the root `.tex`).

## Reading the user's context

- "this paragraph", "this table", "the selected sentence", "here": read
  `.ltxed/selection.json`: `{file, line_from, line_to, from, to, text, paragraph_text,
  enclosing:{kind,label,caption}, ts}`. Lines are 1-based, `file` is relative to the docroot.
  Check `ts` is recent; if it is stale or missing, ask which text is meant.
- "fix the build" / "why does it not compile": read `.ltxed/compile_errors.json`:
  `{state:"ok"|"error", errors:[{file,line,plain,...}]}`. `plain` is a one-line explanation.
- Comments: `.ltxed/comments.json`, see below.
- Suggestions: `.ltxed/suggestions.json` if it exists, see below.

## Editing rules

- Use surgical `Edit` calls on the `.tex` files. One paragraph is one line; never rewrap,
  reflow or reformat lines you are not changing. Do not touch whitespace elsewhere.
- Keep `\toconfirm{}`, `\tc{}`, `\tbc{}` placeholders. Do not invent macros the preamble lacks
  without adding them to the preamble.
- Edits appear in the open editor within about a second; the user's unsaved typing elsewhere
  is preserved. Where you both touched the same characters, yours win and the user sees theirs
  in a "replaced" bar.
- After editing, wait a few seconds, then re-read `.ltxed/compile_errors.json`. Report the
  state (`ok` or the plain-language errors). If your edit broke the build, fix it.

## "Do the comments"

`comments.json` is `{version, comments:[{id, file, anchor:{quote,prefix,suffix,line},
instruction, status:"open"|"done"|"wontdo", reply, author, created_at, updated_at}]}`.

For each comment with `status: "open"`:
1. Find the text by `anchor.quote` (line is a hint; text may have moved) and apply `instruction`.
2. Set `status` to `done` (or `wontdo` with a reason in `reply`), put a one-sentence summary
   of what you changed in `reply`, and update `updated_at`.
3. Never delete comments. Edit only the fields above; write the file back as valid JSON
   (read, modify, write; do not drop other comments).

Optional: instead of editing in place, add a suggestion to `suggestions.json`
(`{version:1, suggestions:[{id:"s-xxxxxxxx", file, new, old, anchor:{prefix,suffix,line}, note,
source:"note"|"comment:<id>", status:"open", user_comment:null, reply:null, created_at,
updated_at}]}`) after making the edit: `new` is the text now in the file, `old` what it
replaced. The user then accepts, rejects or discusses each one in the editor. Check `status`
and `user_comment` on later turns; a `discuss` entry is a question for you.

## Monitoring comments live

To address comments as the user writes them, start a monitor that wakes you on each new open
comment. With Claude Code's Monitor tool, run (from the docroot, or pass the .tex path):

    ltx watch path/to/main.tex

It prints one line per newly opened comment (`<id> <file>:<line> <instruction>`) and nothing
otherwise. Each line is a notification: read `comments.json`, handle that comment as above,
then keep waiting. Stop the monitor when the user is done. Without the Monitor tool, run the
same command in the background and check its output when asked.
