"""SynCTeX lookups (SPEC §5): source line <-> PDF page and position, from tectonic's .synctex.gz.

Records look like `(tag,line:x,y:W,H,D`; x/y are scaled points from the page's top-left corner.
Positions returned are PDF points (bp) from the top-left of the page.
"""

from __future__ import annotations

import gzip
import re
from pathlib import Path

_REC = re.compile(r"[\[(hvxkg$](\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)")
_SP_PER_BP = 65536 * 72.27 / 72


class SyncTex:
    def __init__(self, synctex: Path, docroot: Path):
        self.path, self.docroot = synctex, docroot.resolve()
        self._mtime: float | None = None
        self.recs: list[tuple[int, str, int, float, float]] = []  # page, file (docroot-relative), line, x, y

    def _load(self) -> bool:
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            return False
        if mtime == self._mtime:
            return True
        files: dict[str, str | None] = {}
        recs, page, unit = [], 0, 1.0
        with gzip.open(self.path, "rt", encoding="utf-8", errors="replace") as f:
            for ln in f:
                c = ln[:1]
                if c == "{":
                    page = int(ln[1:])
                elif c == "I" and ln.startswith("Input:"):
                    tag, _, p = ln[6:].rstrip("\n").partition(":")
                    try:
                        files[tag] = Path(p).resolve().relative_to(self.docroot).as_posix() if p else None
                    except ValueError:
                        files[tag] = None
                elif c == "U" and ln.startswith("Unit:"):
                    unit = float(ln[5:])
                elif page and (m := _REC.match(ln)) and (rel := files.get(m[1])):
                    k = unit / _SP_PER_BP
                    recs.append((page, rel, int(m[2]), int(m[3]) * k, int(m[4]) * k))
        self.recs, self._mtime = recs, mtime
        return True

    def forward(self, file: str, line: int) -> dict | None:
        """Where `file:line` starts in the PDF: the nearest line that produced output (exact first, then later, then earlier)."""
        if not self._load():
            return None
        lines = {r[2] for r in self.recs if r[1] == file}
        if not lines:
            return None
        best = min(lines, key=lambda n: (abs(n - line) + (0 if n >= line else 0.5)))
        hits = [r for r in self.recs if r[1] == file and r[2] == best]
        page = min(r[0] for r in hits)
        ys = [r[4] for r in hits if r[0] == page]
        return {"page": page, "y": min(ys), "y2": max(ys), "line": best}

    def reverse(self, page: int, x: float, y: float) -> dict | None:
        """Source line of the output nearest to (x, y) on `page`; lines (baselines) at or below y win ties."""
        if not self._load():
            return None
        on = [r for r in self.recs if r[0] == page]
        if not on:
            return None
        r = min(on, key=lambda r: (abs(r[4] - y) + (0 if r[4] >= y else 4), abs(r[3] - x)))
        return {"file": r[1], "line": r[2]}
