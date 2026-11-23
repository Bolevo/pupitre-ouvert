"""The kit: what an AI needs to make the archive of a score, without the app (docs/CREER.md).

    python tools/make_kit.py [OUT.zip]        # default app/public/kit.zip (served beside the app)

Holds the method and the formats (docs/), the tools (pipeline/, tools/: pages, checks, compiler,
builder) and the example work (scores/deux-chorals/). Not the app, its sounds, nor the tools
that only serve the app's own files.
"""
from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEEP = ("README.md", "AGENTS.md", "LICENSE", "NOTICE.md", "docs/", "pipeline/", "scores/deux-chorals/",
        "tools/source.py", "tools/page_assets.py", "tools/page_staves.py", "tools/page_starts.py",
        "tools/fiche_data.py", "tools/make_kit.py", "tools/omr/")
SKIP = ("/pack/", "/work/img/", "/work/zoom/", "/work/render/", "/work/source/", "__pycache__", ".pytest_cache")


def files() -> list[Path]:
    """The files of the kit: those git knows (tracked or not ignored), else everything on disk."""
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        names = [n for n in out.splitlines() if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
    if not names:
        names = [p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file()]
    keep = [n for n in sorted(set(names))
            if any(n == k or (k.endswith("/") and n.startswith(k)) for k in KEEP) and not any(s in f"/{n}" for s in SKIP)]
    return [ROOT / n for n in keep if (ROOT / n).is_file()]


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "app" / "public" / "kit.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files():
            # one top folder, a fixed date: the same files give the same zip
            info = zipfile.ZipInfo(f"pupitre-ouvert/{f.relative_to(ROOT).as_posix()}", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, f.read_bytes())
        n = len(z.namelist())
    print(f"{out}: {n} files, {out.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
