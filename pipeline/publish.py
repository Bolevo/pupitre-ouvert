"""Make the archive of a work: build its pack, zip it, check it.

    python pipeline/publish.py <work> [<work> ...]   # scores/<work>/ -> packs/<work>.zip, checked
    python pipeline/publish.py                       # every work of scores/, and the app's own:

Without a work name, every work is also copied into app/public/packs/<work>/ with
app/public/packs/index.json ({"packs": [{id, dir, title, composer}]}): the works that come
with the app (the example). `--builtin` does the same for the works named.

The archive packs/<work>.zip is what a singer adds in the app (list of works -> « Ajouter une
partition (.zip) »). Its content is specified in docs/ARCHIVE.md and checked here with
pipeline/check_pack.py: the last line printed for each work is its verdict.
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
        out = build(wd)
        pack = json.loads((out / "pack.json").read_text(encoding="utf-8"))
        if not pack["movements"]:
            print(f"{w}: no movement yet (no MusicXML named in work.yaml exists), nothing made")
            failed = True
            continue
        archive = zips / f"{w}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    # fixed date and mode: the same pack gives the same zip, byte for byte
                    info = zipfile.ZipInfo(f.relative_to(out).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    z.writestr(info, f.read_bytes())
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
