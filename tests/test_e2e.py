"""Acceptance tests in a headless browser against scratch copies of the two dummy docs."""
import difflib
import json
import re
import os
import signal
import subprocess
import sys
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


@pytest.fixture(autouse=True)
def close_pages(request):
    """Close every page a test opened: idle pages keep rendering PDFs and starve (and unfocus) the next test."""
    yield
    if "browser" in request.fixturenames:
        for c in request.getfixturevalue("browser").contexts:
            for p in c.pages:
                p.close()


def wait_for(fn, timeout=30.0, what="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def open_page(browser, server, pdf=True):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.bring_to_front()  # an unfocused page reports hasFocus() false, which hides the selection button
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


def scrolled_to(page, pos):
    """Wait until `pos` is on screen and the editor scroller has stopped moving (a late scroll event hides the + button)."""
    page.wait_for_function("""(i) => new Promise((ok) => {
        const v = window.__ltx.view(); const sc = v.scrollDOM; let last = -1, n = 0;
        const tick = () => { const c = v.coordsAtPos(i);
            n = c && c.top > 0 && c.top < innerHeight && sc.scrollTop === last ? n + 1 : 0; last = sc.scrollTop;
            n >= 8 ? ok(true) : requestAnimationFrame(tick); };
        tick(); })""", arg=pos)


def saved(page):
    return page.locator("#save-state").inner_text() == "Saved"


def snapshot(root: Path, names):
    return {n: ((root / n).read_bytes(), (root / n).stat().st_mtime_ns) for n in names}


@pytest.mark.parametrize("name", ["report", "short"])
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
    root = copy_doc("report")
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
    root = copy_doc("report")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    page.evaluate("() => window.__ltx.hold(true)")
    text = doc(page)
    a = text.index("The threshold $0.5$")  # paragraph A (later in the file)
    place(page, a)
    page.keyboard.type("ALPHA ")
    assert cursor(page) == a + 6
    # Claude-style Edit to an earlier paragraph B while A's typing is unsaved
    disk = (root / "main.tex").read_text()
    b_old = "This document describes the survey instrument"
    assert disk.index(b_old) < a
    (root / "main.tex").write_text(disk.replace(b_old, "This report documents the survey instrument", 1))
    wait_for(lambda: "This report documents" in doc(page), what="external merge")
    d = doc(page)
    assert "ALPHA The threshold" in d
    assert d[:cursor(page)].endswith("ALPHA ")  # cursor stayed after the typed text
    assert page.locator("#replaced").is_hidden()
    page.keyboard.press("Meta+z")  # undo reverts only Daniel's typing, not the outside edit
    assert "ALPHA" not in doc(page) and "This report documents" in doc(page)
    page.keyboard.press("Meta+Shift+z")
    page.evaluate("() => window.__ltx.hold(false)")
    wait_for(lambda: "ALPHA The threshold" in (root / "main.tex").read_text(), what="save after merge")
    final = (root / "main.tex").read_text()
    assert "This report documents the survey instrument" in final
    assert final == doc(page)
    assert not page.errors


def test_same_region_collision_disk_wins_and_text_is_surfaced(browser, copy_doc, serve):
    root = copy_doc("report")
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
    root = copy_doc("report")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    frames = []
    page.on("websocket", lambda ws: ws.on("framesent", lambda f: frames.append((time.time(), f))))
    page.reload()
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    place(page, doc(page).index("The threshold $0.5$"))
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


@pytest.mark.parametrize("name", ["report", "short"])
def test_background_compile_succeeds(browser, copy_doc, serve, name):
    root = copy_doc(name)
    (root / "main.pdf").unlink(missing_ok=True)
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
    root = copy_doc("report")
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
    root = copy_doc("report")
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


def test_rendered_math_and_tables_keep_doc_identical_and_click_reveals(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    page.click("#tabs button[data-path='sec_results.tex']")
    before = doc(page, "sec_results.tex")
    page.click("#latex")
    page.wait_for_selector(".ltx-table table.ltx-tbl", state="attached")
    page.wait_for_selector(".ltx-mac", state="attached", timeout=60000)  # macros arrive with the first compile
    assert page.locator(".ltx-im .katex").count() > 0
    assert page.locator(".ltx-table td").count() > 5
    assert doc(page, "sec_results.tex") == before
    j = re.search(r"\\begin\{(long)?table", before).start()
    page.evaluate("""(j) => { const v = window.__ltx.view('sec_results.tex'); v.dispatch({effects: v.constructor.scrollIntoView(j, {y: 'start', yMargin: 100})}); }""", j)
    page.wait_for_timeout(500)
    page.locator(".sheet:not([hidden]) .ltx-table").first.click()  # click reveals the source at that block
    assert page.evaluate("() => document.body.classList.contains('word')") is False
    head = cursor(page, "sec_results.tex")
    assert re.match(r"\\begin\{(long)?table|\\begin\{tabular|\\begin\{threepart", before[head:head + 30])
    assert doc(page, "sec_results.tex") == before


def top_y(page):
    return page.evaluate("() => { const v = window.__ltx.view(); return v.coordsAtPos(v.state.selection.main.head).top; }")


def test_toggle_keeps_cursor_line_in_place(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    page.wait_for_timeout(1500)
    text = doc(page)
    i = text.index("This section describes")
    page.evaluate("""(i) => { const v = window.__ltx.view(); v.focus();
        v.dispatch({selection: {anchor: i}, effects: v.constructor.scrollIntoView(i, {y: 'start', yMargin: 300})}); }""", i)
    page.wait_for_timeout(500)
    y0 = top_y(page)
    page.click("#latex")
    page.wait_for_timeout(1500)
    y1 = top_y(page)
    page.click("#latex")
    page.wait_for_timeout(1500)
    y2 = top_y(page)
    print(y0, y1, y2)
    assert abs(y1 - y0) <= 2 and abs(y2 - y0) <= 2
    assert cursor(page) == i and doc(page) == text


def test_sliders_are_view_only(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    before = doc(page)
    page.evaluate("""() => { for (const [id, v] of [['fs', '22'], ['cw', '80']]) {
        const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); } }""")
    assert page.evaluate("() => getComputedStyle(document.querySelector('.sheet .cm-scroller')).fontSize") == "22px"
    assert page.evaluate("() => document.body.style.getPropertyValue('--col-w')") == f"{round(page.evaluate('screen.width') * .8)}px"
    assert page.evaluate("() => localStorage.getItem('ltx.fs')") == "22"
    assert doc(page) == before
    page.reload()
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    assert page.evaluate("() => document.getElementById('fs').value") == "22"


def test_pdf_error_marker_when_pane_hidden(browser, copy_doc, serve):
    root = copy_doc("short")
    s = serve(root / "main.tex")
    wait_for(lambda: (root / ".ltxed/compile_errors.json").exists(), timeout=60, what="first compile")
    page = open_page(browser, s, pdf=False)
    src = (root / "main.tex").read_text()
    (root / "main.tex").write_text(src.replace("\\end{document}", "\\begin{itemize}\n\\item x\n\\end{document}", 1))
    wait_for(lambda: s.compile_state()["state"] == "error", timeout=60, what="failed compile")
    page.wait_for_selector("#pdf-err:not([hidden])")
    assert "PDF build failed (" in page.locator("#pdf-err").inner_text()
    page.click("#pdf-err")
    assert page.locator("#pdf-pane").is_visible()
    assert page.locator("#pdf-err").is_hidden()


def test_ltx_stop_kills_server_and_clears_session(copy_doc):
    root = copy_doc("short")
    env = dict(os.environ)
    out = subprocess.run([sys.executable, "-m", "ltx.cli", "open", str(root / "main.tex"), "--no-browser"],
                         capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stderr
    sj = root / ".ltxed" / "session.json"
    pid = json.loads(sj.read_text())["pid"]
    st = subprocess.run([sys.executable, "-m", "ltx.cli", "stop", str(root)], capture_output=True, text=True, timeout=30)
    assert st.returncode == 0, st.stderr
    assert not sj.exists()
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_column_width_slider_in_screen_percent(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = browser.new_page(viewport={"width": 1400, "height": 900}, screen={"width": 1400, "height": 900})
    page.goto(s.url)
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    before = doc(page)
    w = lambda: (page.wait_for_timeout(250), page.evaluate("() => document.querySelector('.sheet:not([hidden]) .cm-content').getBoundingClientRect().width"))[1]
    setcw = lambda v: page.evaluate("(v) => { const e = document.getElementById('cw'); e.value = v; e.dispatchEvent(new Event('input')); }", v)
    for latex in (True, False):
        if not latex:
            page.click("#latex")
        setcw("100"); w100 = w()
        setcw("50"); w50 = w()
        assert abs(w50 - 700) < 1 and w100 > w50 + 100, (latex, w50, w100, page.evaluate("() => [innerWidth, screen.width, document.querySelector('.sheet:not([hidden]) .cm-scroller').clientWidth, getComputedStyle(document.body).getPropertyValue('--col-w')]"))
        page.set_viewport_size({"width": 1000, "height": 900})
        assert abs(w() - 700) < 1  # same pixel width after the window shrinks
        setcw("100")
        assert w() <= 1000
        page.set_viewport_size({"width": 600, "height": 900})  # narrower than the 50% floor
        assert abs(w() - 700) < 1
        assert page.evaluate("() => { const e = document.querySelector('.sheet:not([hidden]) .cm-scroller'); return e.scrollWidth > e.clientWidth; }")
        page.set_viewport_size({"width": 1400, "height": 900})
    assert doc(page) == before

def sugg(doc_text, new, old="OLD WORDS", sid="s-test0001", status="open", note="because"):
    i = doc_text.index(new)
    return {"id": sid, "file": "main.tex", "new": new, "old": old,
            "anchor": {"prefix": doc_text[max(0, i - 40):i], "suffix": doc_text[i + len(new):i + len(new) + 40],
                       "line": doc_text[:i].count("\n") + 1},
            "note": note, "source": "note", "status": status, "user_comment": None, "reply": None,
            "created_at": "2026-10-21T10:00:00Z", "updated_at": "2026-10-21T10:00:00Z"}


def write_sidecar(root, name, key, items):
    p = root / ".ltxed" / name
    tmp = p.with_suffix(".ltxtmp")
    tmp.write_text(json.dumps({"version": 1, key: items}))
    tmp.replace(p)


def read_sidecar(root, name, key):
    return json.loads((root / ".ltxed" / name).read_text())[key]


def review_setup(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    text = doc(page)
    body = text.index("\\begin{document}")
    m = re.search(r"\n\n([A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+)", text[body:])
    new = m.group(1)
    write_sidecar(root, "suggestions.json", "suggestions", [sugg(text, new)])  # outside write, appears live
    i = text.index(new)
    page.evaluate("""(i) => { const v = window.__ltx.view(); v.dispatch({effects: v.constructor.scrollIntoView(i, {y: 'center'})}); }""", i)
    page.wait_for_selector(".sheet:not([hidden]) .ltx-sug", state="attached", timeout=15000)
    return root, page, text, new, i


def test_suggestion_accept(browser, copy_doc, serve):
    root, page, text, new, i = review_setup(browser, copy_doc, serve)
    page.hover(".sheet:not([hidden]) .ltx-sug")
    page.wait_for_selector(".ltx-pop .ltx-ok")
    assert "because" in page.locator(".ltx-pop").inner_text()
    page.click(".ltx-pop .ltx-ok")
    wait_for(lambda: read_sidecar(root, "suggestions.json", "suggestions")[0]["status"] == "accepted", what="accepted")
    page.wait_for_function("() => !document.querySelector('.sheet:not([hidden]) .ltx-sug')")
    assert doc(page) == text


def test_suggestion_reject_restores_old_text_exactly(browser, copy_doc, serve):
    root, page, text, new, i = review_setup(browser, copy_doc, serve)
    page.hover(".sheet:not([hidden]) .ltx-sug")
    page.click(".ltx-pop .ltx-no")
    wait_for(lambda: read_sidecar(root, "suggestions.json", "suggestions")[0]["status"] == "rejected", what="rejected")
    assert doc(page) == text[:i] + "OLD WORDS" + text[i + len(new):]
    page.evaluate("() => window.__ltx.view().focus()")
    page.keyboard.press("Meta+z")  # a normal undoable edit
    assert doc(page) == text


def test_suggestion_discuss(browser, copy_doc, serve):
    root, page, text, new, i = review_setup(browser, copy_doc, serve)
    page.hover(".sheet:not([hidden]) .ltx-sug")
    page.click(".ltx-pop .ltx-plus")
    page.keyboard.type("why this wording?")
    page.keyboard.press("Enter")
    wait_for(lambda: read_sidecar(root, "suggestions.json", "suggestions")[0]["status"] == "discuss", what="discuss")
    assert read_sidecar(root, "suggestions.json", "suggestions")[0]["user_comment"] == "why this wording?"
    page.wait_for_selector(".sheet:not([hidden]) .ltx-sug-discuss", state="attached")
    assert doc(page) == text


def test_selection_comment_written_to_comments_json(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    text = doc(page)
    i = text.index("This section describes")
    page.evaluate("""(i) => { const v = window.__ltx.view(); v.dispatch({effects: v.constructor.scrollIntoView(i, {y: 'center'})}); }""", i)
    scrolled_to(page, i)
    place(page, i, i + 22)
    page.wait_for_selector(".ltx-selplus")
    page.click(".ltx-selplus")
    page.keyboard.type("tighten this")
    page.keyboard.press("Enter")
    wait_for(lambda: (root / ".ltxed/comments.json").exists(), what="comments.json")
    c = read_sidecar(root, "comments.json", "comments")[0]
    assert c["instruction"] == "tighten this" and c["anchor"]["quote"] == "This section describes"
    assert c["status"] == "open" and c["author"] == "daniel" and c["file"] == "main.tex"
    page.wait_for_selector(".sheet:not([hidden]) .ltx-cmt", state="attached")
    assert doc(page) == text


def test_typed_quote_becomes_latex_quotes(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    text = doc(page)
    i = text.index("This section describes")
    page.evaluate("(i) => { const v = window.__ltx.view(); v.dispatch({effects: v.constructor.scrollIntoView(i, {y: 'center'})}); }", i)
    place(page, i)
    page.keyboard.type('say "hello" ok')
    assert doc(page) == text[:i] + "say ``hello'' ok" + text[i:]
    page.click("#latex")  # OFF mode renders them curly at once
    place(page, i)
    page.keyboard.type('"')
    assert doc(page).startswith(text[:i] + "``say")
    page.keyboard.press("Meta+z")
    assert doc(page).startswith(text[:i] + '"say')
    page.click("#latex")
    # wrap a selection
    place(page, i + 1, i + 1 + 3)
    page.keyboard.type('"')
    assert "``" + doc(page)[i + 3:i + 6] + "''" in doc(page)[i:i + 20]
    # no conversion inside a comment
    k = text.index("\n% The text below") + 1
    place(page, k + 2)
    page.keyboard.type('"')
    assert doc(page)[k + 2] == '"'


def test_rendered_widgets_fit_the_column(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = browser.new_page(viewport={"width": 1400, "height": 900}, screen={"width": 1400, "height": 900})
    page.goto(s.url)
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    page.click("#latex")
    page.evaluate("""() => { for (const [id, v] of [['fs', '24'], ['cw', '50']]) {
        const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); } }""")
    scaled = 0
    for tab in ("sec_results.tex", "app_tables.tex", "app_pipeline.tex", "sec_design.tex"):
        page.click(f"#tabs button[data-path='{tab}']")
        text = doc(page, tab)
        for m in re.finditer(r"\\begin\{(table|longtable|equation|align)", text):
            page.evaluate("""([p, j]) => { const v = window.__ltx.view(p); v.dispatch({effects: v.constructor.scrollIntoView(j, {y: 'start', yMargin: 80})}); }""", [tab, m.start()])
            page.wait_for_timeout(250)
            res = page.evaluate("""() => { const c = document.querySelector('.sheet:not([hidden]) .cm-content').getBoundingClientRect();
                const pad = parseFloat(getComputedStyle(document.querySelector('.sheet:not([hidden]) .cm-content')).paddingRight);
                return [...document.querySelectorAll('.sheet:not([hidden]) .ltx-fit')].map(f => ({
                  over: f.getBoundingClientRect().right - (c.right - pad), floor: f.parentElement.classList.contains('ltx-fit-scroll'),
                  scaled: f.style.transform !== '' })); }""")
            for r in res:
                assert r["over"] <= 1.5 or r["floor"], (tab, r)
                scaled += r["scaled"]
    assert scaled > 0


def test_mouse_drag_selection_comment_quotes_whole_selection(browser, copy_doc, serve):
    root = copy_doc("multi")
    s = serve(root / "main.tex")
    page = open_page(browser, s)
    text = doc(page)
    i = text.index("This section describes")
    page.evaluate("(i) => { const v = window.__ltx.view(); v.dispatch({effects: v.constructor.scrollIntoView(i, {y: 'center'})}); }", i)
    scrolled_to(page, i)
    a, b = page.evaluate("([i, j]) => { const v = window.__ltx.view(); const x = v.coordsAtPos(i), y = v.coordsAtPos(j); return [[x.left + 1, x.top + 5], [y.left, y.top + 5]]; }", [i, i + 40])
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(a[0] + 50, a[1], steps=4); page.mouse.move(*b, steps=6); page.mouse.up()
    sel = page.evaluate("() => { const m = window.__ltx.view().state.selection.main; return [m.from, m.to]; }")
    assert sel[1] - sel[0] > 20
    page.wait_for_selector(".ltx-selplus")
    page.click(".ltx-selplus")
    page.keyboard.type("note")
    page.keyboard.press("Enter")
    wait_for(lambda: (root / ".ltxed/comments.json").exists(), what="comments.json")
    c = read_sidecar(root, "comments.json", "comments")[0]
    assert c["anchor"]["quote"] == text[sel[0]:sel[1]] and len(c["anchor"]["quote"]) > 20


def test_export_copies_flattened_live_buffer(browser, copy_doc, serve):
    root = copy_doc("report")
    s = serve(root / "main.tex")
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    page.goto(s.url)
    page.wait_for_function("() => window.__ltx && window.__ltx.syncs.size > 0")
    page.evaluate("""() => { const v = window.__ltx.view('main.tex');
        v.dispatch({changes: {from: 0, insert: '% UNSAVED-MARKER\\n'}}); }""")
    page.click("#export")
    page.wait_for_function("() => document.getElementById('export').textContent.startsWith('Copied')")
    clip = page.evaluate("() => navigator.clipboard.readText()")
    assert clip.startswith("% UNSAVED-MARKER")
    assert not re.search(r"^[^%\n]*\\input\{appendix_prompts", clip, re.M)
    n = len(clip.split("\n"))
    assert page.inner_text("#export") == f"Copied {n} lines"
    ctx.close()


def test_appendix_numbering_carries_into_input_file(browser, copy_doc, serve):
    root = copy_doc("report")
    s = serve(root / "main.tex")
    page = open_page(browser, s, pdf=False)
    page.click("#tabs button[data-path='appendix_prompts.tex']")
    page.wait_for_selector(".sheet:not([hidden]) .ltx-secnum")
    first = lambda: page.locator(".sheet:not([hidden]) .ltx-secnum").first.inner_text()
    wait_for(lambda: re.fullmatch(r"[A-Z]\.\d+", first()), what="appendix letter numbering")
