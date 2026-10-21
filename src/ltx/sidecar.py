"""`.ltxed/*.json` sidecars (SPEC §13.3). All writes are atomic."""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime
from pathlib import Path

from .sync import atomic_write


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def live_session(docroot: Path) -> dict | None:
    s = read_json(docroot / ".ltxed" / "session.json")
    return s if s and pid_alive(s["pid"]) else None


# --- selection / comments -----------------------------------------------------------------

def write_selection(ltxed: Path, sel: dict) -> None:
    sel = {k: v for k, v in sel.items() if k != "type"}
    write_json(ltxed / "selection.json", {"version": 1, **sel, "ts": now_iso()})


def load_comments(ltxed: Path) -> list[dict]:
    return read_json(ltxed / "comments.json", {"comments": []}).get("comments", [])


def save_comments(ltxed: Path, comments: list[dict]) -> None:
    write_json(ltxed / "comments.json", {"version": 1, "comments": comments})


def apply_comment_msg(ltxed: Path, msg: dict) -> list[dict]:
    comments = load_comments(ltxed)
    t = msg["type"]
    if t == "comment_add":
        c = dict(msg["comment"])
        c.setdefault("id", "c_" + secrets.token_hex(3))
        c.setdefault("status", "open")
        c.setdefault("reply", None)
        c.setdefault("author", "daniel")
        c["created_at"] = c["updated_at"] = now_iso()
        comments.append(c)
    elif t == "comment_update":
        for c in comments:
            if c["id"] == msg["id"]:
                c.update(msg["fields"])
                c["updated_at"] = now_iso()
    elif t == "comment_delete":
        comments = [c for c in comments if c["id"] != msg["id"]]
    save_comments(ltxed, comments)
    return comments


# --- suggestions (Claude writes them, Daniel reviews) -------------------------------------

def load_suggestions(ltxed: Path) -> list[dict]:
    return read_json(ltxed / "suggestions.json", {"suggestions": []}).get("suggestions", [])


def save_suggestions(ltxed: Path, items: list[dict]) -> None:
    write_json(ltxed / "suggestions.json", {"version": 1, "suggestions": items})


def apply_suggestion_msg(ltxed: Path, msg: dict) -> list[dict]:
    items = load_suggestions(ltxed)
    for s in items:
        if s["id"] == msg["id"]:
            s.update(msg["fields"])
            s["updated_at"] = now_iso()
    save_suggestions(ltxed, items)
    return items
