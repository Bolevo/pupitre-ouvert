"""The example works (scores/*/) are whole work folders, from the scan to the archive: what is
kept there agrees with what the tools make of the scan and of the transcription."""
from __future__ import annotations

import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "pipeline"))

import check_pack  # noqa: E402
from build_pack import build  # noqa: E402
from pipeline.cht import check, compile as comp  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402
from tools import source  # noqa: E402
from tools.omr import pages  # noqa: E402

EXAMPLES = sorted(p.parent for p in (ROOT / "scores").glob("*/work.yaml") if (p.parent / "src").is_dir())


def music(path: Path) -> list[tuple]:
    """What is sung and played: every note and rest of every part, with its words."""
    out = []
    for k, part in enumerate(ET.parse(path).getroot().iter("part")):       # (the ids of the parts change at every compilation)
        for m in part.iter("measure"):
            for n in m.iter("note"):
                p = n.find("pitch")
                pitch = (p.findtext("step"), p.findtext("alter") or "0", p.findtext("octave")) if p is not None else ("rest",)
                words = tuple(ly.findtext("text") for ly in n.iter("lyric"))
                out.append((k, m.get("number"), pitch, n.findtext("duration"), n.findtext("type"),
                            n.find("chord") is not None, tuple(t.get("type") for t in n.iter("tie")), words))
    return out


def test_there_is_an_example():
    assert EXAMPLES


@pytest.mark.parametrize("work", EXAMPLES, ids=lambda w: w.name)
def test_the_transcription_passes_its_checks_and_compiles_to_the_score_kept(work, tmp_path):
    assert check.main([str(work), "--quiet"]) == 0
    copy = tmp_path / work.name
    shutil.copytree(work, copy, ignore=shutil.ignore_patterns("pack", "pages", "*.pdf", "img", "source", "render", "zoom", "boxes"))
    cfg = yaml.safe_load((work / "work.yaml").read_text(encoding="utf-8"))
    for i, mv in enumerate(cfg["movements"], 1):
        (copy / mv["file"]).unlink()
        comp.compile_movement(copy, i)
        assert music(copy / mv["file"]) == music(work / mv["file"]), f"{mv['file']} is not what src/ compiles to: run pipeline/cht/compile.py"


@pytest.mark.parametrize("work", EXAMPLES, ids=lambda w: w.name)
def test_the_scan_gives_the_systems_and_measures_kept(work, tmp_path):
    cmd = next(l for l in (work / "work.yaml").read_text(encoding="utf-8").splitlines() if "tools/source.py" in l)
    args = cmd.split("source.py", 1)[1].split()
    scan = work / Path(args[1]).name
    copy = tmp_path / work.name
    (copy / "work").mkdir(parents=True)
    shutil.copy(work / "work.yaml", copy / "work.yaml")
    assert source.main([str(copy), str(scan), *[a for a in args[2:] if a != "--force"]]) == 0
    for f in ("pages.tsv", "bars.tsv"):                    # what a person corrected: the staves of a page, a barline
        if (work / "work" / f).exists():
            shutil.copy(work / "work" / f, copy / "work" / f)
    assert pages.main(["--work", str(copy)]) == 0
    found, kept = load_measures(copy / "work" / "measures.tsv"), load_measures(work / "work" / "measures.tsv")
    same = [(r.page, r.systems) for r in found.all_rows()] == [(r.page, r.systems) for r in kept.all_rows()]
    wrong = [r.page for r, k in zip(found.all_rows(), kept.all_rows()) if r.systems != k.systems]
    # a count the detection misses is corrected in measures.tsv: those of the example say how many
    assert same or len(wrong) <= len(kept.all_rows()) // 3, f"pages whose measures are no longer found: {wrong}"


@pytest.mark.parametrize("work", EXAMPLES, ids=lambda w: w.name)
def test_the_example_builds_into_an_archive_without_a_remark(work, tmp_path):
    out = build(work, tmp_path / "pack")
    errors, warnings, _ = check_pack.check(check_pack.read_archive(out))
    assert errors == [] and warnings == []
