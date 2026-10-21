import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

draft = Path("/path/to/papers")
DOCS = {"tool": ["main.tex", "appendix_prompts.tex"], "short": ["main.tex", "final20_table.tex"]}


@pytest.fixture
def copy_doc(tmp_path):
    """Scratch copy of a real doc (the originals are never touched)."""
    def make(name: str) -> Path:
        dst = tmp_path / name
        shutil.copytree(draft / name, dst, ignore=shutil.ignore_patterns(".ltxed"))
        return dst
    return make


class Server:
    def __init__(self, tex: Path):
        self.tex = tex
        self.docroot = tex.parent
        self.proc = subprocess.Popen([sys.executable, "-m", "ltx.cli", "serve", str(tex)],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(200):
            p = self.docroot / ".ltxed" / "session.json"
            if p.exists():
                self.url = json.loads(p.read_text())["url"]
                return
            time.sleep(0.05)
        raise RuntimeError("server did not start")

    def compile_state(self) -> dict:
        return json.loads((self.docroot / ".ltxed" / "compile_errors.json").read_text())

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)


@pytest.fixture
def serve():
    servers = []

    def start(tex: Path) -> Server:
        s = Server(tex)
        servers.append(s)
        return s
    yield start
    for s in servers:
        s.stop()
