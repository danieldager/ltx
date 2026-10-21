"""ltx server: HTTP + websocket hub, disk watcher, compile trigger (SPEC §3, §4, §13)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import socket
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
from watchfiles import awatch

from . import sidecar
from .compile import Compiler
from .sync import FileState, apply_changes, diff_changes, text_hash

STATIC = Path(__file__).parent / "static"
_INPUT = re.compile(r"\\(?:input|include)\{([^}]+)\}")


def discover(docroot: Path, root_tex: str) -> list[str]:
    """Root .tex plus every .tex reachable through \\input / \\include (comments ignored)."""
    seen: list[str] = []
    todo = [root_tex]
    while todo:
        rel = todo.pop(0)
        if rel in seen or not (docroot / rel).is_file():
            continue
        seen.append(rel)
        text = (docroot / rel).read_text("utf-8", "replace")
        for line in text.splitlines():
            line = re.sub(r"(?<!\\)%.*", "", line)
            for name in _INPUT.findall(line):
                name = name.strip()
                cand = name if name.endswith(".tex") else name + ".tex"
                todo.append(Path(cand).as_posix())
    return seen


class Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.lock = asyncio.Lock()

    async def send(self, msg: dict) -> None:
        async with self.lock:
            with contextlib.suppress(Exception):
                await self.ws.send_text(json.dumps(msg))


class Session:
    def __init__(self, tex: Path, port: int):
        self.docroot = tex.parent.resolve()
        self.root_tex = tex.name
        self.ltxed = self.docroot / ".ltxed"
        self.ltxed.mkdir(exist_ok=True)
        self.port = port
        self.url = f"http://127.0.0.1:{port}/"
        self.files: dict[str, FileState] = {}
        for rel in discover(self.docroot, self.root_tex):
            self.files[rel] = FileState.load(self.docroot / rel, rel)
        self.clients: set[Client] = set()
        self.compiler = Compiler(self.docroot, self.root_tex, self.broadcast)
        self.comments_hash = text_hash(json.dumps(sidecar.load_comments(self.ltxed)))
        self.suggestions_hash = text_hash(json.dumps(sidecar.load_suggestions(self.ltxed)))
        self._watch_task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # --- lifecycle ---
    async def start(self) -> None:
        self.session_info = {
            "version": 1, "pid": os.getpid(), "port": self.port, "url": self.url,
            "root_tex": self.root_tex, "files": list(self.files), "started_at": sidecar.now_iso()}
        sidecar.write_json(self.ltxed / "session.json", self.session_info)
        self.compiler.start()
        self.compiler.request()
        self._watch_task = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        self._stop.set()
        await self.compiler.stop()
        with contextlib.suppress(FileNotFoundError):
            (self.ltxed / "session.json").unlink()

    # --- messaging ---
    async def broadcast(self, msg: dict, exclude: Client | None = None) -> None:
        if msg.get("type") == "compile":
            msg = {**msg, "pdf_url": self.compiler.pdf_url()}
        for c in list(self.clients):
            if c is not exclude:
                await c.send(msg)

    def hello(self) -> dict:
        last = self.compiler.last
        compile_msg = ({**last, "pdf_url": self.compiler.pdf_url()} if last else
                       {"type": "compile", "state": "running" if not self.compiler.rev else "ok",
                        "rev": self.compiler.rev, "pdf_url": self.compiler.pdf_url(),
                        "errors": [], "duration_ms": None})
        index = {"type": "index", **self.compiler.index} if self.compiler.index else None
        return {"type": "hello", "version": 1, "root": self.root_tex,
                "files": [f.wire() for f in self.files.values()], "compile": compile_msg,
                "index": index, "comments": sidecar.load_comments(self.ltxed),
                "suggestions": sidecar.load_suggestions(self.ltxed)}

    async def handle(self, client: Client, msg: dict) -> None:
        t = msg.get("type")
        if t == "save":
            await self.save(client, msg)
        elif t == "resync":
            f = self.files[msg["path"]]
            await client.send({"type": "file", "path": f.rel, "text": f.base_text, "hash": f.base_hash})
        elif t == "compile_now":
            self.compiler.request()
        elif t == "selection":
            sidecar.write_selection(self.ltxed, msg)
        elif t in ("comment_add", "comment_update", "comment_delete"):
            comments = sidecar.apply_comment_msg(self.ltxed, msg)
            self.comments_hash = text_hash(json.dumps(comments))
            await self.broadcast({"type": "comments", "comments": comments})
        elif t == "suggestion_update":
            items = sidecar.apply_suggestion_msg(self.ltxed, msg)
            self.suggestions_hash = text_hash(json.dumps(items))
            await self.broadcast({"type": "suggestions", "suggestions": items})
        else:
            await client.send({"type": "error", "msg": f"unknown message type {t!r}"})

    # --- sync ---
    async def _absorb_disk(self, f: FileState) -> bool:
        """Caller holds f.lock. If disk differs from base, push `external` and advance base."""
        d = f.read_disk()
        if d is None:
            return False
        new_hash = text_hash(d)
        if new_hash == f.base_hash:
            return False
        msg = {"type": "external", "path": f.rel, "base_hash": f.base_hash, "new_hash": new_hash,
               "changes": diff_changes(f.base_text, d)}
        f.base_text, f.base_hash = d, new_hash
        await self.broadcast(msg)
        return True

    async def save(self, client: Client, msg: dict) -> None:
        f = self.files.get(msg["path"])
        if f is None:
            await client.send({"type": "error", "msg": f"{msg['path']} is not writable"})
            return
        async with f.lock:
            await self._absorb_disk(f)
            if msg["base_hash"] != f.base_hash:
                await client.send({"type": "save_conflict", "path": f.rel,
                                   "disk_text": f.base_text, "disk_hash": f.base_hash})
                return
            try:
                new = apply_changes(f.base_text, msg["changes"])
            except (ValueError, KeyError, IndexError) as e:
                await client.send({"type": "error", "msg": f"bad save for {f.rel}: {e}"})
                return
            if text_hash(new) != msg["text_hash"]:
                await client.send({"type": "error", "msg": f"save for {f.rel} did not match its hash; not written"})
                return
            old_hash = f.base_hash
            if new != f.base_text:
                f.write(new)
            await client.send({"type": "saved", "path": f.rel, "hash": f.base_hash})
            await self.broadcast({"type": "external", "path": f.rel, "base_hash": old_hash,
                                  "new_hash": f.base_hash, "changes": msg["changes"]}, exclude=client)
        self.compiler.request()

    async def _watch(self) -> None:
        pdf = (self.docroot / f"{Path(self.root_tex).stem}.pdf").resolve()
        async for batch in awatch(self.docroot, debounce=80, step=20, stop_event=self._stop,
                                  recursive=True):
            rebuild = False
            for _, p in batch:
                path = Path(p)
                if path.name.endswith(".ltxtmp"):
                    continue
                try:
                    rel = path.resolve().relative_to(self.docroot).as_posix()
                except ValueError:
                    continue
                if rel == ".ltxed/comments.json":
                    await self._comments_changed()
                    continue
                if rel == ".ltxed/suggestions.json":
                    await self._suggestions_changed()
                    continue
                if rel.startswith(".ltxed/") or path.resolve() == pdf or "/." in "/" + rel:
                    continue
                f = self.files.get(rel)
                if f is not None:
                    async with f.lock:
                        await self._absorb_disk(f)
                rebuild = True
            if rebuild:
                await self._discover_new()
                self.compiler.request()

    async def _discover_new(self) -> None:
        for rel in discover(self.docroot, self.root_tex):
            if rel not in self.files:
                self.files[rel] = FileState.load(self.docroot / rel, rel)
                await self.broadcast({"type": "file_added", "file": self.files[rel].wire()})

    async def _comments_changed(self) -> None:
        comments = sidecar.load_comments(self.ltxed)
        h = text_hash(json.dumps(comments))
        if h != self.comments_hash:
            self.comments_hash = h
            await self.broadcast({"type": "comments", "comments": comments})

    async def _suggestions_changed(self) -> None:
        items = sidecar.load_suggestions(self.ltxed)
        h = text_hash(json.dumps(items))
        if h != self.suggestions_hash:
            self.suggestions_hash = h
            await self.broadcast({"type": "suggestions", "suggestions": items})


def make_app(session: Session) -> Starlette:
    async def index(request):
        html = (STATIC / "index.html").read_text("utf-8")
        for f in ("app.css", "app.js"):  # cache-bust so a rebuild shows on plain reload
            html = html.replace(f"/static/{f}", f"/static/{f}?v={int((STATIC / f).stat().st_mtime)}")
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def pdf(request):
        p = session.docroot / f"{Path(session.root_tex).stem}.pdf"
        if not p.exists():
            return Response(status_code=404)
        return FileResponse(p, media_type="application/pdf", headers={"Cache-Control": "no-store"})

    async def state(request):
        return JSONResponse({"root": session.root_tex, "files": list(session.files),
                             "compile": session.compiler.last})

    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        client = Client(ws)
        session.clients.add(client)
        try:
            await client.send(session.hello())
            while True:
                msg = json.loads(await ws.receive_text())
                await session.handle(client, msg)
        except WebSocketDisconnect:
            pass
        finally:
            session.clients.discard(client)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        await session.start()
        try:
            yield
        finally:
            await session.stop()

    return Starlette(routes=[
        Route("/", index), Route("/pdf", pdf), Route("/api/state", state),
        WebSocketRoute("/ws", ws_endpoint),
        Mount("/static", StaticFiles(directory=STATIC)),
    ], lifespan=lifespan)


def serve(tex: Path, port: int = 0) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    session = Session(tex, sock.getsockname()[1])
    print(f"ltx: serving {session.docroot / session.root_tex}\nltx: {session.url}", flush=True)
    config = uvicorn.Config(make_app(session), log_level="warning", ws_max_size=64 * 1024 * 1024)
    uvicorn.Server(config).run(sockets=[sock])
