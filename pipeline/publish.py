"""Make the archive of a work: build its pack, zip it, check it.

    python pipeline/publish.py <work> [<work> ...]   # scores/<work>/ -> packs/<work>.zip, checked
    python pipeline/publish.py                       # every work of scores/, and the app's own:

Without a work name, every work is also copied into app/public/packs/<work>/ with
app/public/packs/index.json ({"packs": [{id, dir, title, composer}]}): the works that come
with the app (the example). `--builtin` does the same for the works named.

The archive packs/<work>.zip is what a singer adds in the app (list of works -> « Ajouter une
partition (.zip) »). Its content is specified in docs/ARCHIVE.md and checked here with
pipeline/check_pack.py: the last line printed for each work is its verdict.

The archive also carries, under source/, what it was made from (work.yaml, the transcription,
the MusicXML, the tables): pipeline/reopen.py makes a work folder of it again, to correct it.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
import check_pack  # noqa: E402
from build_pack import build  # noqa: E402


def sources(wd: Path) -> list[Path]:
    """What the archive of a work carries under source/: the files it was made from, without
    which it could not be corrected (the page images and the sheet are in the archive already;
    the scan and the working pictures stay behind: large, and remade from nothing here)."""
    import yaml
    cfg = yaml.safe_load((wd / "work.yaml").read_text(encoding="utf-8")) or {}
    files = [wd / "work.yaml", *sorted((wd / "src").glob("*.cht"))]
    files += [wd / mv["file"] for mv in cfg.get("movements") or [] if mv.get("file")]
    files += [wd / "pages" / "pages.json", wd / "pages" / "staves.json"]
    files += [wd / "work" / f"{n}.tsv" for n in ("pages", "measures", "bars")]
    seen: list[Path] = []
    for f in files:
        if f.is_file() and f not in seen:
            seen.append(f)
    return seen


def write_archive(wd: Path, archive: Path) -> tuple[dict, Path]:
    """Builds the pack of the work folder `wd` (in wd/pack) and zips it as `archive`, with its
    sources under source/. -> (the content of pack.json, the pack folder). Nothing is zipped for
    a work without a movement yet."""
    out = build(wd)
    pack = json.loads((out / "pack.json").read_text(encoding="utf-8"))
    if not pack["movements"]:
        return pack, out
    entries = [(f.relative_to(out).as_posix(), f) for f in sorted(out.rglob("*")) if f.is_file()]
    entries += [("source/" + f.relative_to(wd).as_posix(), f) for f in sources(wd)]
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for name, f in entries:
            # fixed date and mode: the same work gives the same zip, byte for byte
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, f.read_bytes())
    return pack, out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("works", nargs="*", help="folder names in scores/ (default: all, and the app's built-in works)")
    ap.add_argument("--builtin", action="store_true", help="also make the named works the app's built-in works")
    a = ap.parse_args()
    works = [Path(w).name for w in a.works] or sorted(p.parent.name for p in (ROOT / "scores").glob("*/work.yaml"))
    builtin = a.builtin or not a.works
    public = ROOT / "app" / "public" / "packs"
    zips = ROOT / "packs"
    zips.mkdir(exist_ok=True)
    index, failed = [], False
    for w in works:
        wd = ROOT / "scores" / w
        if not (wd / "work.yaml").exists():
            raise SystemExit(f"no scores/{w}/work.yaml")
        archive = zips / f"{w}.zip"
        pack, out = write_archive(wd, archive)
        if not pack["movements"]:
            print(f"{w}: no movement yet (no MusicXML named in work.yaml exists), nothing made")
            failed = True
            continue
        if builtin:
            dest = public / w
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(out, dest)
            # title and composer: the app lists the works without downloading every pack.json
            index.append({"id": pack["id"], "dir": w, "title": pack["title"], "composer": pack["composer"]})
        print(f"{w}: {len(pack['movements'])} movement(s) -> packs/{w}.zip ({archive.stat().st_size / 1e6:.1f} MB)")
        failed |= check_pack.main([str(archive)]) != 0
    if builtin:
        public.mkdir(parents=True, exist_ok=True)
        (public / "index.json").write_text(json.dumps({"packs": index}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
