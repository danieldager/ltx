"""Disk state of one file: wire text, hashes, compare-and-swap writes, diffs (SPEC §4, §13.1)."""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def apply_changes(base: str, changes: list[dict]) -> str:
    """Apply a §13.1 change list (offsets in base coordinates)."""
    out, pos = [], 0
    for c in changes:
        a, b = c["from"], c["to"]
        if a < pos or b < a or b > len(base):
            raise ValueError("changes not sorted / out of range")
        out.append(base[pos:a])
        out.append(c["insert"])
        pos = b
    out.append(base[pos:])
    return "".join(out)


def diff_changes(old: str, new: str) -> list[dict]:
    """Line-level diff, refined to characters inside changed line runs."""
    a_lines = old.splitlines(keepends=True)
    b_lines = new.splitlines(keepends=True)
    a_starts = [0]
    for ln in a_lines:
        a_starts.append(a_starts[-1] + len(ln))
    b_starts = [0]
    for ln in b_lines:
        b_starts.append(b_starts[-1] + len(ln))
    raw: list[tuple[int, int, str]] = []  # code-point (from, to, insert) in old
    sm = difflib.SequenceMatcher(None, a_lines, b_lines, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        a0, a1 = a_starts[i1], a_starts[i2]
        b0, b1 = b_starts[j1], b_starts[j2]
        raw.extend((a0 + f, a0 + t, ins) for f, t, ins in _char_diff(old[a0:a1], new[b0:b1]))
    return [{"from": f, "to": t, "insert": ins} for f, t, ins in raw]


def _char_diff(a: str, b: str) -> list[tuple[int, int, str]]:
    # trim common prefix/suffix, then char-level matching if the middle is small enough
    p = 0
    while p < len(a) and p < len(b) and a[p] == b[p]:
        p += 1
    s = 0
    while s < len(a) - p and s < len(b) - p and a[-1 - s] == b[-1 - s]:
        s += 1
    am, bm = a[p:len(a) - s], b[p:len(b) - s]
    if not am and not bm:
        return []
    if len(am) * len(bm) > 4_000_000:
        return [(p, p + len(am), bm)]
    out = []
    sm = difflib.SequenceMatcher(None, am, bm, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            out.append((p + i1, p + i2, bm[j1:j2]))
    return _merge_small_gaps(out, am, p)


def _merge_small_gaps(ops, am, p):
    """Merge edits separated by 1-2 unchanged chars, so 'colour'->'color' is one hunk."""
    merged: list[list] = []
    for f, t, ins in ops:
        if merged and f - merged[-1][1] <= 2:
            gap = am[merged[-1][1] - p:f - p]
            merged[-1][1] = t
            merged[-1][2] += gap + ins
        else:
            merged.append([f, t, ins])
    return [tuple(m) for m in merged]


def atomic_write(path: Path, data: bytes) -> None:
    """tmp file in the same directory + rename; keeps the mode; writes through symlinks."""
    target = path.resolve()
    mode = target.stat().st_mode & 0o7777 if target.exists() else 0o644
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".ltxtmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


@dataclass
class FileState:
    path: Path  # absolute
    rel: str  # POSIX path relative to doc root
    base_text: str = ""
    base_hash: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @classmethod
    def load(cls, path: Path, rel: str) -> FileState:
        st = cls(path=path, rel=rel)
        st.base_text = path.read_bytes().decode("utf-8")
        st.base_hash = text_hash(st.base_text)
        return st

    def read_disk(self) -> str | None:
        try:
            return self.path.read_bytes().decode("utf-8")
        except FileNotFoundError:
            return None

    def write(self, text: str) -> None:
        atomic_write(self.path, text.encode("utf-8"))
        self.base_text, self.base_hash = text, text_hash(text)

    def wire(self) -> dict:
        return {"path": self.rel, "text": self.base_text, "hash": self.base_hash}
