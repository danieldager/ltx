"""Unit tests: change application, disk diff, error parsing, template."""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from ltx.compile import parse_errors
from ltx.sync import apply_changes, diff_changes

from conftest import FIXTURES


def test_diff_roundtrip_random_edits():
    base = (FIXTURES / "tool" / "main.tex").read_text()
    rng = random.Random(0)
    for _ in range(30):
        new = base
        for _ in range(rng.randint(1, 5)):
            i = rng.randrange(len(new))
            j = min(len(new), i + rng.randint(0, 40))
            new = new[:i] + rng.choice(["", "x", "new words ", "\n\n"]) + new[j:]
        ch = diff_changes(base, new)
        assert apply_changes(base, ch) == new


def test_diff_is_local_inside_long_line():
    base = (FIXTURES / "tool" / "main.tex").read_text()
    line = max(base.splitlines(), key=len)
    word = line.split()[20]
    new = base.replace(line, line.replace(" " + word + " ", " WORD ", 1), 1)
    ch = diff_changes(base, new)
    assert len(ch) == 1 and len(ch[0]["insert"]) < 15 and ch[0]["to"] - ch[0]["from"] < len(word) + 3


def test_plain_errors():
    console = "error: main.tex:2: LaTeX Error: \\begin{itemize} on input line 1 ended by \\end{document}.\n"
    e = parse_errors(console, "", False)
    assert e[0]["line"] == 2 and "itemize block opened on line 1 is never closed" in e[0]["plain"]
    log = "! Undefined control sequence.\nl.88 hi \\foo\n"
    e = parse_errors("error: main.tex:88: Undefined control sequence\n", log, False)
    assert e[0]["plain"] == "Unknown command \\foo on line 88."


def test_new_template_compiles(tmp_path):
    out = subprocess.run(["ltx", "new", str(tmp_path / "paper")], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    tex = tmp_path / "paper" / "main.tex"
    assert (tmp_path / "paper" / "references.bib").exists()
    r = subprocess.run([shutil.which("tectonic") or "tectonic", "-X", "compile", "main.tex"],
                       cwd=tex.parent, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (tex.parent / "main.pdf").stat().st_size > 10000
    src = tex.read_text()
    for needed in ["12pt", "margin=1in", "\\onehalfspacing", "natbib", "booktabs", "hyperref",
                   "amsmath", "graphicx", "JEL codes", "Keywords", "\\section{Methodology}"]:
        assert needed in src


def _flatten(root, texts):
    """Run web/flatten.ts under node (type stripping); skip if node is too old."""
    web = Path(__file__).parent.parent / "web" / "flatten.ts"
    js = f"import {{flatten}} from {json.dumps(web.as_uri())};" \
         f"console.log(JSON.stringify(flatten({json.dumps(root)}, {json.dumps(texts)})))"
    r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"node cannot run flatten.ts: {r.stderr[-200:]}")
    return json.loads(r.stdout)


def test_flatten_single_file_unchanged():
    assert _flatten("main.tex", {"main.tex": "a\n\\input{x}\n"}) == "a\n\\input{x}\n"


def test_flatten_nested_inputs_and_include():
    t = {"main.tex": "A\n\\input{sec/one}\nZ", "sec/one.tex": "one\n\\include{two.tex}\n", "two.tex": "two"}
    assert _flatten("main.tex", t) == "A\none\ntwo\nZ"


def test_flatten_ignores_commented_input_but_keeps_comment():
    t = {"main.tex": "% \\input{a}\nx \\input{a} % \\input{a}\nrate 5\\% \\input{a}", "a.tex": "AA"}
    assert _flatten("main.tex", t) == "% \\input{a}\nx AA % \\input{a}\nrate 5\\% AA"


def test_flatten_missing_file_and_cycle_left_as_is():
    t = {"main.tex": "\\input{gone}\n\\input{b}", "b.tex": "b\\input{main}"}
    assert _flatten("main.tex", t) == "\\input{gone}\nb\\input{main}"


def _node(expr):
    web = Path(__file__).parent.parent / "web" / "numbering.ts"
    js = f"import {{fileStarts, advance, numberOf}} from {json.dumps(web.as_uri())};console.log(JSON.stringify({expr}))"
    r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"node cannot run numbering.ts: {r.stderr[-200:]}")
    return json.loads(r.stdout)


def test_numbering_appendix_resets_to_letters_within_one_file():
    src = "\\\\section{A}\\n\\\\section{B}\\n\\\\subsection{x}\\n\\\\appendix\\n\\\\section{C}\\n\\\\subsection{D}\\n\\\\section*{E}\\n\\\\section{F}"
    out = _node(f"(()=>{{const st={{counters:[0,0,0],appendix:false}};const r=[];"
                f"for(const l of \"{src}\".split('\\n')){{advance(st,l);if(/section\\{{/.test(l))r.push(numberOf(st,l.includes('subsection')?2:1))}}return r}})()")
    assert out == ["1", "2", "2.1", "A", "A.1", "B"]  # starred \section* stays out of the count


def test_numbering_carries_appendix_into_input_file_and_ignores_commented():
    texts = {"main.tex": "\\section{a}\n% \\appendix\n\\input{mid}\n\\appendix\n\\input{app}\n",
             "mid.tex": "\\section{b}", "app.tex": "\\section{c}"}
    out = _node(f"fileStarts('main.tex', {json.dumps(texts)})")
    assert out["mid.tex"] == {"counters": [1, 0, 0], "appendix": False}
    assert out["app.tex"] == {"counters": [0, 0, 0], "appendix": True}
