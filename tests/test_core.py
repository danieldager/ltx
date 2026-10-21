"""Unit tests: change application, disk diff, error parsing, template."""
import random
import shutil
import subprocess

from ltx.compile import parse_errors
from ltx.sync import apply_changes, diff_changes

from conftest import draft


def test_diff_roundtrip_random_edits():
    base = (draft / "tool" / "main.tex").read_text()
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
    base = (draft / "tool" / "main.tex").read_text()
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
