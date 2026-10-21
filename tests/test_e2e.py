"""Acceptance tests in a headless browser against scratch copies of the two real docs."""
import difflib
import json
import re
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

from conftest import DOCS


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def wait_for(fn, timeout=15.0, what="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def open_page(browser, server, pdf=True):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    if pdf:  # the PDF pane is hidden by default
        page.add_init_script("localStorage.setItem('ltx.pdf', '1')")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(server.url)
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    page.errors = errors
    return page


def doc(page, path="main.tex"):
    return page.evaluate("(p) => window.__ltx.view(p).state.doc.toString()", path)


def cursor(page, path="main.tex"):
    return page.evaluate("(p) => window.__ltx.view(p).state.selection.main.head", path)


def place(page, pos, head=None, path="main.tex"):
    page.evaluate("""([p, a, h]) => { const v = window.__ltx.view(p); v.focus();
        v.dispatch({selection: {anchor: a, head: h ?? a}, scrollIntoView: true}); }""", [path, pos, head])
    # let CM sync the DOM selection (a real click does this natively) before typing
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.wait_for_timeout(50)


def saved(page):
    return page.locator("#save-state").inner_text() == "Saved"


def snapshot(root: Path, names):
    return {n: ((root / n).read_bytes(), (root / n).stat().st_mtime_ns) for n in names}


@pytest.mark.parametrize("name", ["tool", "short"])
def test_open_and_save_untouched_changes_nothing(browser, copy_doc, serve, name):
    root = copy_doc(name)
    before = snapshot(root, DOCS[name])
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    for f in page.evaluate("() => [...window.__ltx.syncs.keys()]"):
        page.click(f"#tabs button[data-path='{f}']")
        page.evaluate("(p) => window.__ltx.view(p).focus()", f)
        page.keyboard.press("Meta+s")
    page.wait_for_timeout(1200)
    page.close()
    assert snapshot(root, DOCS[name]) == before
    assert not page.errors


def test_edit_one_word_is_one_line_diff(browser, copy_doc, serve):
    root = copy_doc("tool")
    orig = (root / "main.tex").read_text()
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    text = doc(page)
    line = max(text.split("\n"), key=len)
    w = [x for x in line.split(" ") if x.isalpha() and len(x) > 5][10]
    word = f" {w} "
    at = text.index(line) + line.index(word) + 1
    place(page, at, at + len(w))
    page.keyboard.type("robustness")
    wait_for(lambda: "robustness" in (root / "main.tex").read_text(), what="save")
    new = (root / "main.tex").read_text()
    changed = [l for l in difflib.unified_diff(orig.split("\n"), new.split("\n"), lineterm="", n=0)
               if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    assert len(changed) == 2  # one line out, one line in
    assert changed[1][1:] == line.replace(word, " robustness ", 1)


def test_external_edit_merges_with_unsaved_typing(browser, copy_doc, serve):
    root = copy_doc("tool")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    page.evaluate("() => window.__ltx.hold(true)")
    text = doc(page)
    a = text.index("The boundary $-4.0$")  # paragraph A (later in the file)
    place(page, a)
    page.keyboard.type("ALPHA ")
    assert cursor(page) == a + 6
    # Claude-style Edit to an earlier paragraph B while A's typing is unsaved
    disk = (root / "main.tex").read_text()
    b_old = "This document describes the commute tool"
    assert disk.index(b_old) < a
    (root / "main.tex").write_text(disk.replace(b_old, "This report documents the commute tool", 1))
    wait_for(lambda: "This report documents" in doc(page), what="external merge")
    d = doc(page)
    assert "ALPHA The boundary" in d
    assert d[:cursor(page)].endswith("ALPHA ")  # cursor stayed after the typed text
    assert page.locator("#replaced").is_hidden()
    page.keyboard.press("Meta+z")  # undo reverts only Daniel's typing, not the outside edit
    assert "ALPHA" not in doc(page) and "This report documents" in doc(page)
    page.keyboard.press("Meta+Shift+z")
    page.evaluate("() => window.__ltx.hold(false)")
    wait_for(lambda: "ALPHA The boundary" in (root / "main.tex").read_text(), what="save after merge")
    final = (root / "main.tex").read_text()
    assert "This report documents the commute tool" in final
    assert final == doc(page)
    assert not page.errors


def test_same_region_collision_disk_wins_and_text_is_surfaced(browser, copy_doc, serve):
    root = copy_doc("tool")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    page.evaluate("() => window.__ltx.hold(true)")
    text = doc(page)
    target = "considerably more costly"
    at = text.index(target) + len("consider")
    place(page, at)
    page.keyboard.type("ZZZ")
    disk = (root / "main.tex").read_text()
    (root / "main.tex").write_text(disk.replace(target, "much more costly", 1))
    wait_for(lambda: "much more costly" in doc(page), what="external")
    assert "ZZZ" not in doc(page)
    bar = page.locator("#replaced")
    assert bar.is_visible() and "ZZZ" in bar.inner_text()
    page.evaluate("() => window.__ltx.hold(false)")
    page.wait_for_timeout(800)
    assert (root / "main.tex").read_text() == doc(page)
    bar.get_by_role("button", name="re-insert").click()
    assert "ZZZ" in doc(page) and bar.is_hidden()
    assert not page.errors


def test_typing_is_local_and_fast(browser, copy_doc, serve):
    root = copy_doc("tool")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    frames = []
    page.on("websocket", lambda ws: ws.on("framesent", lambda f: frames.append((time.time(), f))))
    page.reload()
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    place(page, doc(page).index("The boundary $-4.0$"))
    t0 = time.time()
    page.keyboard.type("typing without any round trip ", delay=25)
    t1 = time.time()
    assert [f for t, f in frames if t0 <= t <= t1] == []  # nothing sent while typing
    for _ in range(100):  # sync Playwright only delivers events inside its own calls
        if frames:
            break
        page.wait_for_timeout(50)
    assert frames and json.loads(frames[0][1])["type"] == "save"
    assert frames[0][0] - t1 >= 0.3  # sent only after the 400 ms debounce
    # per-keystroke cost of the whole local path (transaction + decorations + sync bookkeeping)
    ms = page.evaluate("""() => { const v = window.__ltx.view(); const pos = v.state.selection.main.head;
        const t = performance.now();
        for (let i = 0; i < 50; i++) v.dispatch({changes: {from: pos + i, insert: 'x'}, userEvent: 'input.type'});
        return (performance.now() - t) / 50; }""")
    print(f"mean keystroke dispatch {ms:.2f} ms")
    assert ms < 16


@pytest.mark.parametrize("name", ["tool", "short"])
def test_background_compile_succeeds(browser, copy_doc, serve, name):
    root = copy_doc(name)
    (root / "main.pdf").unlink()
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    wait_for(lambda: (root / ".ltxed/compile_errors.json").exists() and s.compile_state()["state"] == "ok",
             timeout=60, what="compile")
    assert (root / "main.pdf").stat().st_size > 50000
    page.wait_for_selector(".pdf-page canvas", timeout=20000)
    assert "PDF up to date" in page.locator("#compile-state").inner_text()


def test_broken_build_keeps_last_good_pdf(browser, copy_doc, serve):
    root = copy_doc("short")
    s = serve(root / "main.tex")
    wait_for(lambda: (root / ".ltxed/compile_errors.json").exists(), timeout=60, what="first compile")
    assert s.compile_state()["state"] == "ok"
    good = (root / "main.pdf").read_bytes()
    page = open_page(browser, s)
    page.wait_for_selector(".pdf-page canvas", timeout=20000)
    src = (root / "main.tex").read_text()
    broken = src.replace("\\end{document}", "\\begin{itemize}\n\\item an unclosed list\n\\end{document}", 1)
    (root / "main.tex").write_text(broken)
    wait_for(lambda: s.compile_state()["state"] == "error", timeout=60, what="failed compile")
    err = s.compile_state()["errors"][0]
    print(err)
    strip = page.locator("#errors")
    strip.wait_for(state="visible")
    assert "The itemize block opened on line" in strip.inner_text() and "never closed" in strip.inner_text()
    assert (root / "main.pdf").read_bytes() == good
    assert page.locator(".pdf-page canvas").count() > 0  # last good PDF still shown
    (root / "main.tex").write_text(src)
    wait_for(lambda: s.compile_state()["state"] == "ok", timeout=60, what="recovery")
    page.wait_for_function("() => document.getElementById('errors').hidden")


def test_ltx_open_launches_server_and_browser(copy_doc, tmp_path):
    root = copy_doc("short")
    rec = tmp_path / "opened.txt"
    script = tmp_path / "browser.sh"
    script.write_text(f'#!/bin/sh\necho "$1" > {rec}\n')
    script.chmod(0o755)
    out = subprocess.run(["ltx", "open", str(root / "main.tex")], capture_output=True, text=True,
                         env={**os.environ, "BROWSER": f"{script} %s"})
    assert out.returncode == 0, out.stderr
    sess = json.loads((root / ".ltxed/session.json").read_text())
    try:
        url = wait_for(lambda: rec.exists() and rec.read_text().strip(), what="browser launch")
        assert url == sess["url"] == out.stdout.strip()
        import urllib.request
        assert b"app.js" in urllib.request.urlopen(url).read()
        # a second `ltx open` reuses the running server
        again = subprocess.run(["ltx", "open", "--no-browser", str(root / "main.tex")],
                               capture_output=True, text=True)
        assert again.stdout.strip() == url
    finally:
        os.kill(sess["pid"], signal.SIGTERM)


def test_pdf_hidden_by_default_then_shown_by_button(browser, copy_doc, serve):
    root = copy_doc("tool")
    s = serve(root / "main.tex")
    page = open_page(browser, s, pdf=False)
    assert not page.locator("#pdf-pane").is_visible()
    wait_for(lambda: (root / ".ltxed/compile_errors.json").exists() and s.compile_state()["state"] == "ok", timeout=60, what="compile")
    page.click("#pdf")
    assert page.locator("#pdf-pane").is_visible()
    page.wait_for_selector(".pdf-page canvas", timeout=20000)
    page.click("#pdf")
    assert not page.locator("#pdf-pane").is_visible()


def test_latex_toggle_keeps_doc_and_typing_hits_source(browser, copy_doc, serve):
    root = copy_doc("tool")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    before = doc(page)
    page.click("#latex")
    assert page.evaluate("() => document.body.classList.contains('word')")
    assert page.locator(".ltx-chip").count() > 0
    assert doc(page) == before
    # a word inside plain prose
    body = before.index("\\begin{document}")
    m = re.search(r"\n\n([A-Z][a-z]+ [a-z]+ [a-z]+ )", before[body:])
    i = body + m.end() - 1
    assert i > 0
    place(page, i)
    page.keyboard.type("QQ")
    after = doc(page)
    assert after == before[:i] + "QQ" + before[i:]
    page.keyboard.press("Backspace"); page.keyboard.press("Backspace")
    assert doc(page) == before
    page.click("#latex")
    assert doc(page) == before
