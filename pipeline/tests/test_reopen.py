"""An archive carries what it was made from, and can be opened again as a work folder: to
correct a note, one needs the archive only (pipeline/publish.py, pipeline/reopen.py)."""
from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "pipeline"))

import check_pack  # noqa: E402
import publish  # noqa: E402
import reopen  # noqa: E402
from build_pack import build  # noqa: E402
from pipeline.cht import check, compile as comp  # noqa: E402

EXAMPLE = ROOT / "scores" / "locus-iste"
KYRIE = ROOT / "scores" / "schubert-kyrie"
KEPT = shutil.ignore_patterns("pack", "img", "source", "boxes", "render", "zoom", "apercu.png", "*.pdf")


def made(tmp_path: Path) -> tuple[Path, Path]:
    """The example as the repository keeps it, and its archive."""
    work = tmp_path / "made" / "locus-iste"
    shutil.copytree(EXAMPLE, work, ignore=KEPT)
    archive = tmp_path / "locus-iste.zip"
    publish.write_archive(work, archive)
    return work, archive


def opened(tmp_path: Path, archive: Path, *more: str) -> Path:
    assert reopen.main([str(archive), "--scores", str(tmp_path / "scores"), *more]) == 0
    return tmp_path / "scores" / (more[more.index("--as") + 1] if "--as" in more else "bruckner-locus-iste")


def files_of(folder: Path, *skip: str) -> dict[str, bytes]:
    return {f.relative_to(folder).as_posix(): f.read_bytes() for f in sorted(folder.rglob("*"))
            if f.is_file() and not any(part in skip for part in f.relative_to(folder).parts)}


def test_the_archive_carries_what_it_was_made_from(tmp_path):
    work, archive = made(tmp_path)
    names = set(zipfile.ZipFile(archive).namelist())
    assert {"pack.json", "mvt1.mei", "fiche.md", "pages/p008.webp"} <= names         # what the app reads
    assert {n for n in names if n.startswith("source/")} == {
        "source/work.yaml", "source/src/008.cht", "source/src/009.cht", "source/src/010.cht", "source/mvt1.musicxml",
        "source/pages/pages.json", "source/pages/staves.json", "source/work/pages.tsv", "source/work/measures.tsv"}
    errors, warnings, info = check_pack.check(check_pack.read_archive(archive))
    assert errors == [] and warnings == []
    assert any(line.startswith("sources: 9 file(s)") for line in info)


def test_the_archive_opened_again_is_the_work_folder_and_gives_the_same_archive(tmp_path, capsys):
    work, archive = made(tmp_path)
    again = opened(tmp_path, archive)
    assert files_of(again, "work") == files_of(work, "work", "pack")
    assert files_of(again / "work", "img") == files_of(work / "work")
    said = capsys.readouterr().out
    assert "src/008.cht … 010.cht" in said and "pipeline/publish.py bruckner-locus-iste" in said
    # the pages and where their staves and measures are: what the tools that show a place read
    d = json.loads((again / "work" / "img" / "p008.json").read_text())
    assert (again / "work" / "img" / "p008.png").exists()
    assert d["numbers"] == [[1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13]] and d["staff_names"] == [["S", "A", "T", "B"]] * 3
    assert all(len(s["barlines"]) == len(n) and len(s["staves"]) == 4 for s, n in zip(d["systems"], d["numbers"]))
    assert check.main([str(again), "--quiet"]) == 0
    second = tmp_path / "second.zip"
    publish.write_archive(again, second)
    assert second.read_bytes() == archive.read_bytes()


def test_a_note_corrected_in_the_opened_archive_is_the_only_thing_that_changes(tmp_path):
    _, archive = made(tmp_path)
    again = opened(tmp_path, archive, "--as", "corrected")
    page = again / "src" / "008.cht"
    text = page.read_text(encoding="utf-8")
    assert text.count("T   | !p g3:2. g3:4") == 1                                     # measure 1, the tenor
    page.write_text(text.replace("T   | !p g3:2. g3:4", "T   | !p g3:2. a3:4"), encoding="utf-8")
    assert comp.main([str(again)]) == 0
    second = tmp_path / "corrected.zip"
    pack, _ = publish.write_archive(again, second)
    before = json.loads(zipfile.ZipFile(archive).read("pack.json"))
    assert pack["id"] == before["id"]                                                 # it takes the place of the first in the app
    sound = lambda p: [(n["part"], n["m"], n["t"], n["d"], n["midi"]) for n in p["movements"][0]["notes"]]  # noqa: E731
    changed = [(a, b) for a, b in zip(sound(before), sound(pack)) if a != b]
    assert len(sound(before)) == len(sound(pack)) and len(changed) == 1
    assert changed[0][0][:2] == ("T", 0) and changed[0][0][4] == 55 and changed[0][1][4] == 57
    assert check_pack.main([str(second)]) == 0
    assert "a3:4" in zipfile.ZipFile(second).read("source/src/008.cht").decode("utf-8")    # the next correction starts from this one


def test_a_musicxml_corrected_elsewhere_makes_the_archive_once_marked_as_the_source(tmp_path):
    """The score corrected in an editor (MuseScore…) and given back as MusicXML: it takes the place
    of the movement's file; `source: musicxml` in work.yaml keeps a compilation from undoing it."""
    _, archive = made(tmp_path)
    again = opened(tmp_path, archive, "--as", "by-hand")
    xml = again / "mvt1.musicxml"
    text = xml.read_text(encoding="utf-8")
    first = "<step>C</step>\n          <octave>5</octave>"                             # the soprano's first note
    assert first in text
    xml.write_text(text.replace(first, "<step>D</step>\n          <octave>5</octave>", 1), encoding="utf-8")
    cfg = again / "work.yaml"
    cfg.write_text(cfg.read_text(encoding="utf-8").replace("{file: mvt1.musicxml,", "{file: mvt1.musicxml, source: musicxml,"), encoding="utf-8")
    with pytest.raises(SystemExit, match="maintained source"):
        comp.main([str(again)])
    pack, _ = publish.write_archive(again, tmp_path / "by-hand.zip")
    before = json.loads(zipfile.ZipFile(archive).read("pack.json"))
    first_of = lambda p: next(n["midi"] for n in p["movements"][0]["notes"] if n["part"] == "S")  # noqa: E731
    assert (first_of(before), first_of(pack)) == (72, 74)
    assert check_pack.main([str(tmp_path / "by-hand.zip")]) == 0


def test_an_archive_without_its_sources_says_so_and_nothing_is_written(tmp_path, capsys):
    work = tmp_path / "made" / "locus-iste"
    shutil.copytree(EXAMPLE, work, ignore=KEPT)
    bare = shutil.make_archive(str(tmp_path / "bare"), "zip", build(work, tmp_path / "pack"))
    assert reopen.main([bare, "--scores", str(tmp_path / "scores")]) == 1
    assert "carries no sources" in capsys.readouterr().out
    assert not (tmp_path / "scores").exists()
    _, _, info = check_pack.check(check_pack.read_archive(Path(bare)))
    assert any(line.startswith("no sources") for line in info)
    assert reopen.main([str(tmp_path / "absent.zip"), "--scores", str(tmp_path / "scores")]) == 1
    assert "cannot read" in capsys.readouterr().out


def test_a_folder_that_exists_is_not_written_over_unless_asked(tmp_path, capsys):
    _, archive = made(tmp_path)
    again = opened(tmp_path, archive)
    (again / "src" / "008.cht").write_text("mine", encoding="utf-8")
    assert reopen.main([str(archive), "--scores", str(tmp_path / "scores")]) == 1
    assert "--as" in capsys.readouterr().out and (again / "src" / "008.cht").read_text(encoding="utf-8") == "mine"
    assert reopen.main([str(archive), "--scores", str(tmp_path / "scores"), "--force"]) == 0
    assert (again / "src" / "008.cht").read_text(encoding="utf-8") != "mine"
    assert reopen.main([str(archive), "--scores", str(tmp_path / "scores"), "--as", "../outside"]) == 1


def test_a_file_name_that_would_leave_the_folder_is_not_written(tmp_path):
    pack = json.dumps({"id": "w", "pages": [], "fiche": "fiche.md"}).encode()
    files = {"pack.json": pack, "fiche.md": b"# w", "source/work.yaml": b"id: w\n", "source/../../escaped.txt": b"x",
             "source//etc/absolute.txt": b"x", "source/C:\\absolute.txt": b"x", "source/src/001.cht": b"page 1\n"}
    assert reopen.restore(files, tmp_path / "in" / "w") == ["fiche.md", "src/001.cht", "work.yaml"]
    assert sorted(p.name for p in tmp_path.rglob("*.txt")) == []


def test_the_sources_of_another_work_are_remarked(tmp_path):
    _, archive = made(tmp_path)
    files = check_pack.read_archive(archive)
    files["source/work.yaml"] = files["source/work.yaml"].replace(b"id: bruckner-locus-iste", b"id: another-work")
    _, warnings, _ = check_pack.check(files)
    assert len(warnings) == 1 and "another work" in warnings[0]


def test_the_staves_of_an_opened_page_are_those_recorded_and_never_guessed_wrong(tmp_path):
    """Page 3 of the Kyrie: three systems of a soloist and the piano, then the choir (work/pages.tsv:
    3,3,3,6). The right hand, under dense chords, is not found by looking at the page."""
    again = tmp_path / "kyrie"
    shutil.copytree(KYRIE, again, ignore=KEPT)
    assert reopen.layouts(again) == []
    d = json.loads((again / "work" / "img" / "p003.json").read_text())
    assert d["staff_names"] == [["S", "PR", "PL"]] * 3 + [["S", "A", "T", "B", "PR", "PL"]]
    assert d["numbers"][0] == [31, 32, 33, 34, 35] and d["first_measure"] == 31
    recorded = json.loads((again / "pages" / "staves.json").read_text())[2]["systems"][0]
    assert [[st["lines"][0], st["lines"][4]] for st in d["systems"][0]["staves"]] == recorded
    # an archive whose pages were made before the staves were recorded: a system whose staves are
    # not all found is shown whole, not under the names of other staves
    (again / "pages" / "staves.json").unlink()
    remarks = reopen.layouts(again)
    d = json.loads((again / "work" / "img" / "p003.json").read_text())
    assert d["staff_names"][3] == ["S", "A", "T", "B", "PR", "PL"]
    for k, names in enumerate(d["staff_names"][:3]):
        assert names == ["S", "PR", "PL"] or (names == ["st1"] and any(f"p3 s{k + 1}:" in r for r in remarks))
    assert any(names == ["st1"] for names in d["staff_names"][:3])
