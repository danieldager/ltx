"""ltx open | new  (serve = the foreground server that `open` detaches)."""

from __future__ import annotations

import argparse
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


def cmd_open(a) -> None:
    tex = _tex(a.path)
    s = sidecar.live_session(tex.parent)
    if s and s["root_tex"] != tex.name:
        sys.exit(f"ltx: {tex.parent} is already open for {s['root_tex']} ({s['url']}); `ltx stop` it first")
    if not s:
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
    sv = sub.add_parser("serve", help="run the server in the foreground")
    sv.add_argument("path")
    sv.add_argument("--port", type=int, default=0)
    sv.set_defaults(fn=cmd_serve)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
