"""tectonic runner: single-flight background builds, plain-language errors, aux index (SPEC §5)."""

from __future__ import annotations

import asyncio
import re
import shutil
import time
from pathlib import Path

from .sidecar import now_iso, write_json

DEBOUNCE_S = 0.5
TECTONIC = shutil.which("tectonic") or "/opt/homebrew/bin/tectonic"


class Compiler:
    """At most one build at a time; requests during a build queue exactly one follow-up."""

    def __init__(self, docroot: Path, root_tex: str, on_status):
        self.docroot = docroot
        self.root_tex = root_tex
        self.stem = Path(root_tex).stem
        self.build_dir = docroot / ".ltxed" / "build"
        self.on_status = on_status  # async callable(dict)
        self.rev = 1 if (docroot / f"{self.stem}.pdf").exists() else 0
        self.last: dict | None = None
        self.index: dict | None = None
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    def request(self) -> None:
        self._wake.set()

    async def _loop(self) -> None:
        while True:
            await self._wake.wait()
            await asyncio.sleep(DEBOUNCE_S)
            self._wake.clear()
            await self.build()

    def pdf_url(self) -> str | None:
        return f"/pdf?rev={self.rev}" if self.rev else None

    async def build(self) -> dict:
        await self.on_status({"type": "compile", "state": "running", "rev": self.rev,
                              "errors": (self.last or {}).get("errors", []), "duration_ms": None})
        self.build_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            TECTONIC, "-X", "compile", self.root_tex, "--synctex", "--keep-intermediates",
            "--keep-logs", "--outdir", str(self.build_dir),
            cwd=self.docroot, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        ms = int((time.monotonic() - t0) * 1000)
        console = out.decode("utf-8", "replace")
        log_path = self.build_dir / f"{self.stem}.log"
        log = log_path.read_text("utf-8", "replace") if log_path.exists() else ""
        ok = proc.returncode == 0 and (self.build_dir / f"{self.stem}.pdf").exists()
        errors = parse_errors(console, log, ok)
        if ok:
            pdf = self.docroot / f"{self.stem}.pdf"
            tmp = pdf.with_name(f".{pdf.name}.ltxtmp")
            shutil.copyfile(self.build_dir / f"{self.stem}.pdf", tmp)
            tmp.replace(pdf)
            self.rev += 1
            self.index = build_index(self.build_dir / f"{self.stem}.aux", self.docroot / self.root_tex)
        state = "ok" if ok else "error"
        write_json(self.docroot / ".ltxed" / "compile_errors.json", {
            "version": 1, "state": state, "rev": self.rev, "finished_at": now_iso(),
            "duration_ms": ms, "root_tex": self.root_tex,
            "log_path": f".ltxed/build/{self.stem}.log", "errors": errors})
        self.last = {"type": "compile", "state": state, "rev": self.rev, "errors": errors,
                     "duration_ms": ms}
        await self.on_status(self.last)
        if ok and self.index:
            await self.on_status({"type": "index", **self.index})
        return self.last


# --- errors -------------------------------------------------------------------------------

_CONSOLE_ERR = re.compile(r"^error: (?:(?P<file>[^\s:][^:]*\.(?:tex|sty|cls|bib|ltx)):(?P<line>\d+): )?(?P<msg>.+)$")
_SKIP = ("something bad happened inside XeTeX", "the XeTeX engine had an unrecoverable error",
         "halted on potentially-recoverable error")


def _plain(msg: str, line: int | None, log: str) -> str:
    at = f" on line {line}" if line else ""
    m = re.search(r"\\begin\{(\w+\*?)\} on input line (\d+) ended by \\end\{(\w+\*?)\}", msg)
    if m:
        env, start, end = m.groups()
        if end == "document":
            return f"The {env} block opened on line {start} is never closed (add \\end{{{env}}})."
        return f"A {env} block opened on line {start} is closed by \\end{{{end}}}{at}; the begin and end do not match."
    if "Undefined control sequence" in msg:
        cmd = _undefined_cmd(log, line)
        return f"Unknown command {cmd}{at}." if cmd else f"Unknown command{at}."
    m = re.search(r"Environment (\w+\*?) undefined", msg)
    if m:
        return f"Unknown block type '{m.group(1)}'{at} (\\begin{{{m.group(1)}}} is not defined)."
    m = re.search(r"File ended while scanning use of (\\\S+)", msg)
    if m:
        return f"A {m.group(1)}{{ ... is never closed: the file ended before its closing brace."
    m = re.search(r"File [`'](.+?)' not found", msg)
    if m:
        return f"Missing file '{m.group(1)}'{at}."
    if "Missing $ inserted" in msg:
        return f"A math symbol (such as _ or ^) is used outside math{at}; wrap it in $...$ or escape it."
    if "Misplaced alignment tab character" in msg:
        return f"A stray & outside a table{at}; write \\& for an ampersand."
    if "Extra }" in msg or "Missing } inserted" in msg or "Missing { inserted" in msg:
        return f"Unbalanced braces {{ }}{at}."
    if "Not in outer par mode" in msg:
        return f"A float (table or figure) is placed inside something it cannot sit in{at}, e.g. a box or another float, or a block before it is not closed."
    if "Emergency stop" in msg or "no legal \\end found" in msg:
        return "The document ended unexpectedly; a block or brace is probably not closed."
    if "perhaps a missing \\item" in msg:
        return f"A list has text before its first \\item, or an \\item sits outside a list{at}."
    if "There's no line here to end" in msg:
        return f"A line break \\\\ with no text before it{at}."
    if "Too many }'s" in msg:
        return f"A closing brace }} without a matching {{{at}."
    return f"{msg.rstrip('.')}{at}."


def _undefined_cmd(log: str, line: int | None) -> str | None:
    if line is None:
        return None
    m = re.search(rf"! Undefined control sequence\.\n(?:.*\n)*?l\.{line} (.*)", log)
    if not m:
        return None
    cmds = re.findall(r"\\[A-Za-z@]+", m.group(1))
    return cmds[-1] if cmds else None


def _unwrap(log: str) -> str:
    # TeX wraps log lines at 79 characters; rejoin them before matching warnings
    out, buf = [], ""
    for ln in log.split("\n"):
        buf += ln
        if len(ln) != 79:
            out.append(buf)
            buf = ""
    out.append(buf)
    return "\n".join(out)


def parse_errors(console: str, log: str, ok: bool) -> list[dict]:
    errors, seen = [], set()
    for ln in console.splitlines():
        m = _CONSOLE_ERR.match(ln.strip())
        if not m or any(s in ln for s in _SKIP):
            continue
        msg = m.group("msg").lstrip("!").strip()
        f, line = m.group("file"), int(m.group("line")) if m.group("line") else None
        if (f, line, msg) in seen:
            continue
        seen.add((f, line, msg))
        errors.append({"file": f, "line": line, "msg": msg, "plain": _plain(msg, line, log),
                       "severity": "error"})
    if not ok and not errors:
        tail = "\n".join(console.strip().splitlines()[-3:])
        errors.append({"file": None, "line": None, "msg": tail,
                       "plain": "The build failed; see the log for details.", "severity": "error"})
    if ok:  # only the final pass's warnings mean anything
        flat = _unwrap(log)
        for kind, key, line in re.findall(
                r"(Reference|Citation) [`'](.+?)' on page \d+ undefined on input line (\d+)", flat):
            if (kind, key) in seen:
                continue
            seen.add((kind, key))
            what = "a label" if kind == "Reference" else "a bibliography entry"
            cmd = "\\ref" if kind == "Reference" else "\\cite"
            errors.append({"file": None, "line": int(line), "msg": f"{kind} `{key}' undefined",
                           "plain": f"{cmd}{{{key}}} on line {int(line)} points to {what} that does not exist (shows as ?? in the PDF).",
                           "severity": "warning"})
    return errors


# --- index for chips ----------------------------------------------------------------------

def _balanced_args(s: str, i: int, n: int) -> tuple[list[str], int]:
    """Read n {..} groups starting at s[i] (skipping whitespace)."""
    args = []
    for _ in range(n):
        while i < len(s) and s[i] in " \t\n":
            i += 1
        if i >= len(s) or s[i] != "{":
            break
        depth, j = 0, i
        while j < len(s):
            if s[j] == "\\":
                j += 2
                continue
            depth += {"{": 1, "}": -1}.get(s[j], 0)
            if depth == 0:
                break
            j += 1
        args.append(s[i + 1:j])
        i = j + 1
    return args, i


def build_index(aux: Path, root: Path) -> dict:
    labels, cites, macros = {}, {}, {}
    text = aux.read_text("utf-8", "replace") if aux.exists() else ""
    for m in re.finditer(r"\\newlabel\{([^}]*)\}", text):
        args, _ = _balanced_args(text, m.end(), 1)
        if args:
            inner, _ = _balanced_args(args[0], 0, 1)
            if inner and not m.group(1).endswith("@cref"):
                labels[m.group(1)] = inner[0]
    for m in re.finditer(r"\\bibcite\{([^}]*)\}", text):
        args, _ = _balanced_args(text, m.end(), 1)
        if args:
            parts, _ = _balanced_args(args[0], 0, 3)  # {num}{year}{{short authors}}
            if len(parts) == 3:
                author = parts[2].strip("{}").replace("~", " ")
                cites[m.group(1)] = f"{author} ({parts[1]})"
            elif parts:
                cites[m.group(1)] = parts[0]
    src = root.read_text("utf-8", "replace") if root.exists() else ""
    pre = src.split("\\begin{document}", 1)[0]
    for m in re.finditer(r"\\(?:re)?newcommand\*?\{?\\([A-Za-z@]+)\}?(?:\[(\d)\])?(?:\[[^\]]*\])?", pre):
        body, _ = _balanced_args(pre, m.end(), 1)
        macros[m.group(1)] = {"nargs": int(m.group(2) or 0), "body": body[0] if body else ""}
    return {"labels": labels, "cites": cites, "macros": macros}
