# Making the archive of a score for Pupitre Ouvert

For an AI that someone has handed a scanned score (a PDF or photos): you turn it into a **`.zip`
archive** that they will add to [Pupitre Ouvert](https://bolevo.github.io/pupitre-ouvert/?lang=en)
to follow the score, listen to the voices and learn their own.

(French version: [`CREER.md`](CREER.md). The reference documents linked below are in French.)

## The goal

An archive that `pipeline/check_pack.py` declares `OK`, and whose music is right. It holds:

- the **music** of each voice (notes, rhythms, lyrics), and the accompaniment if there is one;
- the **pages** of the score, cleaned, with the place of every bar;
- optionally, the **work notes** (`fiche.md`): the sung text and its translation.

The format is described in [`ARCHIVE.md`](ARCHIVE.md). What makes the archive valuable to a
choir singer, in this order: the accuracy of the voices, the legibility of the pages, the
accompaniment.

## What you have

- **The kit**: `git clone --depth 1 https://github.com/Bolevo/pupitre-ouvert`, or
  [https://bolevo.github.io/pupitre-ouvert/kit.zip](https://bolevo.github.io/pupitre-ouvert/kit.zip)
  (0.5 MB; without network access, the person can attach it). Then
  `pip install -r pipeline/requirements.txt` (Python ≥ 3.10).
- **Scripts for everything mechanical**: preparing and cleaning the pages, cutting them for
  reading, checking a transcription, engraving it to compare it with the page, compiling,
  building and checking the archive. They are short and readable.
- **A complete example**: [`scores/deux-chorals/`](../scores/deux-chorals) is a finished work
  folder; `python pipeline/publish.py deux-chorals` makes its archive.

The method is yours to choose. The path described below was used to transcribe two whole works
for choir and piano: take it as it is, adapt it, or do otherwise if this score calls for it —
read the sources, change a script, write one. What counts is the result: an archive that is
`OK` and music faithful to the page.

All commands run from the root of the kit; `<id>` is the name of the work's folder.

## The proven path

### 1. The pages

```
python tools/source.py scores/<id> score.pdf              # or photos, in order: p1.jpg p2.jpg …
```

Writes `scores/<id>/work/source/NNNN.png` and `work/pages.tsv` (image → printed page number:
`--first-page 2` if the document starts at page 2, `--pages 3-40` to leave the covers out).

### 2. work.yaml

`scores/<id>/work.yaml` — title and composer are on the first page:

```yaml
id: faure-cantique                 # = <id>: letters, digits, hyphens
title: "Cantique de Jean Racine"
composer: "G. Fauré"
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:
  1: {id: fr, label: "Français", lang: fr}
```

One movement per separate piece (each starts again at bar 1). Add `staves` if the systems are
not “S A T B + piano” (see “Other layouts”).

### 3. The bars of each page

```
python tools/omr/pages.py --work scores/<id>
python pipeline/cht/measures.py init scores/<id>          # work/measures.tsv, from the detection
```

`work/img/pNNN_overlay.png` shows the barlines detected. `work/measures.tsv` says, page by page,
how many bars each system has: correct what the detection missed (a stem taken for a barline, a
faint barline), and the movement number. A pickup is bar 0 (`first` = 0 on the movement's first
page); a page without music has no row. Then:

```
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>              # the crops now carry the real numbers
```

The bar numbers printed at the start of the systems let you check the count.

### 4. The transcription

One file `scores/<id>/src/NNN.cht` per page: a text format, one line per voice and per bar,
described in [`CHT_FORMAT.md`](CHT_FORMAT.md); the known reading traps are in
[`TRANSCRIBE.md`](TRANSCRIBE.md).

The crops `work/img/pNNN_sK_ch_mA-B.png` (voices) and `…_pf_…` (piano) show a few bars enlarged,
with the **sounding** pitch of every staff line in the margin;
`python tools/omr/zoom.py <page> <bar> --staff T --work scores/<id>` enlarges one bar further.
Reading bar by bar on these crops gives far better results than reading the whole page.

Two checks, to run whenever you like:

```
python pipeline/cht/check.py scores/<id> --pages <page>            # durations, syllables, ties, ranges
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare    # work/render/NNN_cmp_sK.png
```

`--compare` stacks, system by system, the page and your transcription engraved: it is the most
effective check, showing at a glance a pitch, a rhythm or a syllable that differs. Mark `# ?`
what remains uncertain.

### 5. Compile

```
python pipeline/cht/compile.py scores/<id>                # -> mvt1.musicxml, mvt2.musicxml…
```

### 6. The app's pages

```
python tools/page_assets.py scores/<id>                   # -> pages/pNNN.webp + pages/pages.json
python tools/page_staves.py scores/<id> --dry-run --draw scores/<id>/work/boxes
```

The pages are framed on what is printed, straightened and cleaned (white paper, faded ink
restored), then every bar gets its box (`--no-frame` keeps the images whole). The images in `work/boxes/` show the boxes and the staves found; `WARN` points
at a system whose barlines could not be matched to `measures.tsv`.

### 7. The work notes (optional)

`scores/<id>/fiche.md`: the sung text, line by line, and its translation — format in
[`ARCHIVE.md`](ARCHIVE.md#fichemd-facultative). “Learn the text” in the app uses it too.

### 8. The archive

```
python pipeline/publish.py <id>                           # -> packs/<id>.zip
```

The last line is the verdict: `OK`, `OK with N warning(s)` (worth reading: a doubtful octave
or duration shows up there) or `FAILED` with what to correct.

## Handing over the archive

Give `packs/<id>.zip` to the person, with:

- how to add it: open [https://bolevo.github.io/pupitre-ouvert/?lang=en](https://bolevo.github.io/pupitre-ouvert/?lang=en),
  list of works at the top left → “Add a score (.zip)…”;
- what the archive covers (pages, movements, voices, accompaniment);
- the uncertain passages (`grep -n "# ?" scores/<id>/src/*.cht`), so that they can check them
  by ear, score in hand.

An archive may cover only part of the work: a fuller or corrected version replaces the earlier
one in the app (same `id`). A correction is made in `src/NNN.cht`, then steps 5 and 8; so keep
the folder `scores/<id>/`.

The archive holds the images of the score: it is made for the person's own use, not to be
published if the edition is under copyright.

## Possible choices

- **The voices without the accompaniment**: without `PR`/`PL` lines, the archive is complete
  for learning one's part. The accompaniment can be added later, in full or reduced to the bass
  and the chords.
- **A MusicXML already exists** (MuseScore, another source): put it in as `mvtN.musicxml` and
  skip steps 4 and 5; what it must contain is in [`ARCHIVE.md`](ARCHIVE.md).
- **Without pages**: the archive is valid without `pages/`; the app then shows the line of the
  voice.
- **An automatic draft**: `tools/omr/draft.py` (with Audiveris) gives indicative pitches;
  durations, voices and lyrics remain to be read.

## Other layouts than “four voices and piano”

The staves of a system have names: `S A T B` (voices), `PR PL` (piano, right and left hand). By
default: 6 staves = `S A T B PR PL`, 4 = `S A T B` (a cappella), 2 = `PR PL`, 3 to 5 = the first
voices then `PR PL`. For another layout, `staves` in `work.yaml`:

| Score | `staves:` | In the `.cht` files |
|---|---|---|
| SATB choir a cappella | (nothing) | no `PR`/`PL` lines |
| One voice and piano | `[S, PR, PL]` (or `T`, `B`…) | `part S "Voice"` in the header |
| Two voices and piano (4 staves) | `[S, A]` | `part S "Soprano"`, `part A "Alto"` |
| SAB and piano | `[S, A, B, PR, PL]` | voices `S A B` |
| TTBB, SSAA… | `[S, A, T, B]` | `part S "Tenor I"`, `part A "Tenor II"`… |
| Choir on 2 staves (S+A, T+B) | `[PR, PL]` | transcribe as `S A T B`; the crops are those of a keyboard |

A page whose systems differ from the rest: column `solo` of `work/pages.tsv`
(`pipeline/cht/workdir.py`). The margin of the crops assumes the usual clefs (`S A`: treble;
`T`: treble sounding an octave lower; `B` and `PL`: bass); elsewhere, the printed clef rules.

The CHT format covers four vocal staves and one keyboard. For more (double choir, organ with
pedals, orchestra), produce `mvtN.musicxml` by another means: steps 3, 6 and 8 stay the same.

## If a tool does not fit

Curled photos, pale pages, an unusual layout: the scripts are made to be read and adapted.
`measures.tsv` rules for the bars; where the barlines cannot be detected, the boxes are spread
evenly and the app still works. A defect in the tools or in the app can be reported, or fixed,
at [https://github.com/Bolevo/pupitre-ouvert/issues](https://github.com/Bolevo/pupitre-ouvert/issues).

## On one page

```
python tools/source.py scores/<id> score.pdf
# write scores/<id>/work.yaml
python tools/omr/pages.py --work scores/<id>
python pipeline/cht/measures.py init scores/<id>      # adjust work/measures.tsv, then:
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>
# for each page: write src/NNN.cht, then
python pipeline/cht/check.py scores/<id> --pages N
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare
python pipeline/cht/compile.py scores/<id>
python tools/page_assets.py scores/<id>
python pipeline/publish.py <id>                       # -> packs/<id>.zip   OK
```
