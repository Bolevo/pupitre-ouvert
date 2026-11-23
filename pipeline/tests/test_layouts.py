"""Works of every shape go through the builder and satisfy the archive checker; the checker
refuses what the app could not show."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_pack  # noqa: E402
import layouts  # noqa: E402

EXPECTED = {
    "solo": (["T"], ["voice"]),
    "duo": (["S", "A"], ["voice", "voice"]),
    "trio": (["S", "A", "B"], ["voice", "voice", "voice"]),
    "voice-keyboard": (["S", "P"], ["voice", "accomp"]),
    "instruments": (["Violin", "Cello"], ["voice", "voice"]),
    "no-pages": (["S", "A", "T", "B"], ["voice"] * 4),
    "all": (["S", "A", "T", "B"], ["voice"] * 4),
}


@pytest.mark.parametrize("name", sorted(layouts.LAYOUTS))
def test_a_work_of_this_shape_builds_into_an_archive_the_app_takes(name, tmp_path):
    files = check_pack.read_archive(layouts.make_zip(name, tmp_path))
    errors, warnings, _ = check_pack.check(files)
    assert errors == []
    pack = json.loads(files["pack.json"])
    ids, kinds = EXPECTED[name]
    for mv in pack["movements"]:
        assert [p["id"] for p in mv["parts"]] == ids
        assert [p["kind"] for p in mv["parts"]] == kinds
        assert {n["part"] for n in mv["notes"]} == set(ids)
        assert [p["staves"] for p in mv["parts"]] == [[i + 1] for i in range(len(ids))]
    if name == "all":
        assert len(pack["pages"]) == 5 and warnings == []
    else:
        assert pack["pages"] == [] and any("page" in w for w in warnings)


@pytest.fixture(scope="module")
def example(tmp_path_factory):
    return check_pack.read_archive(layouts.make_zip("all", tmp_path_factory.mktemp("example")))


def broken(files, change):
    pack = json.loads(files["pack.json"])
    change(pack)
    return {**files, "pack.json": json.dumps(pack).encode()}


def test_the_checker_reads_a_folder_and_a_zip_with_everything_in_one_folder(example, tmp_path):
    import zipfile
    z = tmp_path / "in-folder.zip"
    with zipfile.ZipFile(z, "w") as f:
        for name, data in example.items():
            f.writestr(f"mon-oeuvre/{name}", data)
    assert check_pack.check(check_pack.read_archive(z))[0] == []
    d = tmp_path / "folder"
    for name, data in example.items():
        (d / name).parent.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)
    assert check_pack.check(check_pack.read_archive(d))[0] == []
    assert check_pack.main([str(z)]) == 0


@pytest.mark.parametrize("change, said", [
    (lambda p: p.update(version=2), "the app reads version 1"),
    (lambda p: p.update(id="Requiem de Fauré"), "id: a simple identifier"),
    (lambda p: p.update(title=""), "title is missing"),
    (lambda p: p.update(movements=[]), "no movement"),
    (lambda p: p["movements"][0].update(mei="absent.mei"), "absent.mei is not in the archive"),
    (lambda p: p["movements"][1].update(id=p["movements"][0]["id"]), "already another movement's"),
    (lambda p: p["movements"][0].update(parts=[]), "parts is empty"),
    (lambda p: p["movements"][0]["parts"][0].update(kind="choir"), "a part is badly described"),
    (lambda p: p["movements"][0].update(measures=[]), "measures is empty"),
    (lambda p: p["movements"][0]["measures"][3].update(t=0), "never go back"),
    (lambda p: p["movements"][0].update(durationMs=10), "durationMs (10) is not after"),
    (lambda p: p["movements"][0]["notes"][0].update(part="X"), "1 note(s) badly described"),
    (lambda p: p["movements"][0]["notes"][0].update(m=99), "1 note(s) badly described"),
    (lambda p: p["movements"][0]["notes"][0].update(id="nowhere"), "1 note(s) whose id is not in choral1.mei"),
    (lambda p: p["movements"][0]["notes"][-1].update(d=10 ** 6), "outside the movement"),
    (lambda p: p["pages"][0].update(img="pages/p099.webp"), "image pages/p099.webp is not in the archive"),
    (lambda p: p["pages"][0].update(w=900), "but the image is 1300"),
    (lambda p: p["pages"][0]["measures"][0].update(mv=1), "1 measure box(es) badly described"),
    (lambda p: p["pages"][0]["measures"][0].update(sys=7), "1 measure box(es) badly described"),
    (lambda p: p["pages"][0]["measures"][0].update(x1=0), "outside the page or empty"),
    (lambda p: p["pages"][0]["measures"][0].update(n=400), "measure numbers the movement does not have"),
    (lambda p: p.update(fiche="notes.md"), "fiche: 'notes.md' is not in the archive"),
])
def test_the_checker_refuses_what_the_app_could_not_show(example, change, said):
    errors, _, _ = check_pack.check(broken(example, change))
    assert any(said in e for e in errors), errors


def test_the_checker_warns_about_what_is_probably_a_mistake(example):
    def octave_up(p):
        for n in p["movements"][0]["notes"]:
            if n["part"] == "S":
                n["midi"] += 24
    def no_box(p):
        p["pages"][0]["measures"] = p["pages"][0]["measures"][1:]
    def stretched(p):
        n = next(n for n in p["movements"][0]["notes"] if n["part"] == "T" and n["t"] == 0)
        n["d"] = 4000
    for change, said in ((octave_up, "an octave or clef mistake"), (no_box, "1 measure(s) without a box"),
                         (stretched, "starting before the previous one ends"),
                         (lambda p: p["movements"][0].update(tempos=[]), "played at 120")):
        errors, warnings, _ = check_pack.check(broken(example, change))
        assert errors == [] and any(said in w for w in warnings), (said, warnings)


def test_not_an_archive(tmp_path):
    assert check_pack.check({"mvt1.mei": b"<mei/>"})[0] == ["pack.json is missing: not an archive for Pupitre"]
    assert check_pack.check({"pack.json": b"{"})[0][0].startswith("pack.json is not valid UTF-8 JSON")
    bad = tmp_path / "x.zip"
    bad.write_bytes(b"not a zip")
    assert check_pack.main([str(bad)]) == 1
