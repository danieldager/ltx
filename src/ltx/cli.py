"""ltx open | new  (serve = the foreground server that `open` detaches)."""

from __future__ import annotations

import argparse
import os
import signal
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from . import sidecar

TEMPLATE = Path(__file__).parent / "templates" / "econ_paper"


def _tex(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    if p.is_dir():
        p = p / "main.tex"
    if not p.is_file() or p.suffix != ".tex":
        sys.exit(f"ltx: {p} is not a .tex file (relative paths resolve from the current directory)")
    return p


def _need_tectonic() -> None:
    if not (shutil.which("tectonic") or Path("/opt/homebrew/bin/tectonic").exists()):
        sys.exit("ltx: tectonic (the LaTeX engine ltx builds PDFs with) is not installed.\n"
                 "  macOS:  brew install tectonic\n"
                 "  other:  https://tectonic-typesetting.github.io/en-US/install.html")


def cmd_open(a) -> None:
    tex = _tex(a.path)
    s = sidecar.live_session(tex.parent)
    if s and s["root_tex"] != tex.name:
        sys.exit(f"ltx: {tex.parent} is already open for {s['root_tex']} ({s['url']}); `ltx stop` it first")
    if not s:
        _need_tectonic()
        ltxed = tex.parent / ".ltxed"
        ltxed.mkdir(exist_ok=True)
        (ltxed / "session.json").unlink(missing_ok=True)
        log = open(ltxed / "server.log", "ab")
        subprocess.Popen([sys.executable, "-m", "ltx.cli", "serve", str(tex)], stdout=log,
                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
                         cwd=tex.parent)
        for _ in range(200):
            s = sidecar.live_session(tex.parent)
            if s:
                break
            time.sleep(0.05)
        else:
            sys.exit(f"ltx: server did not start; see {ltxed / 'server.log'}")
    print(s["url"])
    if not a.no_browser:
        webbrowser.open(s["url"])


def cmd_stop(a) -> None:
    p = Path(a.path).expanduser().resolve()
    root = p if p.is_dir() else p.parent
    s = sidecar.live_session(root)
    sj = root / ".ltxed" / "session.json"
    if not s:
        sj.unlink(missing_ok=True)
        sys.exit(f"ltx: no live server for {root}")
    os.kill(s["pid"], signal.SIGTERM)
    for _ in range(100):
        if not sidecar.pid_alive(s["pid"]):
            break
        time.sleep(0.05)
    sj.unlink(missing_ok=True)
    print(f"stopped {s['url']}")


def cmd_new(a) -> None:
    p = Path(a.path).expanduser().resolve()
    tex = p if p.suffix == ".tex" else p / "main.tex"
    bib = tex.parent / "references.bib"
    if tex.exists():
        sys.exit(f"ltx: {tex} already exists")
    tex.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATE / "main.tex", tex)
    if not bib.exists():
        shutil.copyfile(TEMPLATE / "references.bib", bib)
    print(tex)
    if a.open:
        a.path = str(tex)
        cmd_open(a)


SKILL_SRC = Path(__file__).parent / "skill" / "SKILL.md"
SKILL_DST = Path.home() / ".claude" / "skills" / "ltx" / "SKILL.md"


def cmd_setup_claude(a) -> None:
    if a.uninstall:
        if SKILL_DST.exists():
            SKILL_DST.unlink()
            try:
                SKILL_DST.parent.rmdir()
            except OSError:
                pass
            print(f"removed {SKILL_DST}")
        else:
            print(f"nothing to remove ({SKILL_DST} does not exist)")
        return
    new = SKILL_SRC.read_text()
    old = SKILL_DST.read_text() if SKILL_DST.exists() else None
    if old == new:
        print(f"already up to date: {SKILL_DST}")
        return
    SKILL_DST.parent.mkdir(parents=True, exist_ok=True)
    SKILL_DST.write_text(new)
    print(f"{'updated' if old is not None else 'installed'} Claude Code skill: {SKILL_DST}")


def cmd_watch(a) -> None:
    """Print one line per newly opened comment (for Claude Code's Monitor tool)."""
    p = Path(a.path).expanduser().resolve()
    f = (p if p.is_dir() else p.parent) / ".ltxed"
    seen = {c["id"] for c in sidecar.load_comments(f)} if a.skip_existing else set()
    while True:
        for c in sidecar.load_comments(f):
            if c.get("status") == "open" and c["id"] not in seen:
                seen.add(c["id"])
                line = (c.get("anchor") or {}).get("line", "?")
                print(f"{c['id']} {c.get('file')}:{line} {' '.join(str(c.get('instruction', '')).split())}", flush=True)
        time.sleep(1)


def cmd_serve(a) -> None:
    from .server import serve
    serve(_tex(a.path), a.port)


def main() -> None:
    ap = argparse.ArgumentParser(prog="ltx", description="Local browser editor for LaTeX papers.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("open", help="start (or reuse) the server for a .tex and open the browser")
    o.add_argument("path")
    o.add_argument("--no-browser", action="store_true")
    o.set_defaults(fn=cmd_open)
    n = sub.add_parser("new", help="create a new economics-paper document from the template")
    n.add_argument("path", help="a .tex path, or a directory (main.tex is created in it)")
    n.add_argument("--open", action="store_true", help="open it afterwards")
    n.add_argument("--no-browser", action="store_true")
    n.set_defaults(fn=cmd_new)
    st = sub.add_parser("stop", help="stop the server for a document folder")
    st.add_argument("path", nargs="?", default=".")
    st.set_defaults(fn=cmd_stop)
    sc = sub.add_parser("setup-claude", help="install the ltx skill into ~/.claude/skills/ltx/")
    sc.add_argument("--uninstall", action="store_true")
    sc.set_defaults(fn=cmd_setup_claude)
    w = sub.add_parser("watch", help="print a line for each new open comment (use with Claude Code's Monitor)")
    w.add_argument("path", nargs="?", default=".")
    w.add_argument("--skip-existing", action="store_true", help="ignore comments already open now")
    w.set_defaults(fn=cmd_watch)
    sv = sub.add_parser("serve", help="run the server in the foreground")
    sv.add_argument("path")
    sv.add_argument("--port", type=int, default=0)
    sv.set_defaults(fn=cmd_serve)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
