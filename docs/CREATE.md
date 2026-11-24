# Making the archive of a score for Pupitre Ouvert

For an AI that someone has handed a scanned score (a PDF or photos): you turn it into a **`.zip`
archive** that they will add to [Pupitre Ouvert](https://bolevo.github.io/pupitre-ouvert/?lang=en)
to follow the score, listen to the voices and learn their own.

This text is `docs/CREATE.md` of the repository [https://github.com/Bolevo/pupitre-ouvert](https://github.com/Bolevo/pupitre-ouvert). If you
are reading it through a tool that summarises web pages, take the original: it is in the kit
(below), and at [https://raw.githubusercontent.com/Bolevo/pupitre-ouvert/main/docs/CREATE.md](https://raw.githubusercontent.com/Bolevo/pupitre-ouvert/main/docs/CREATE.md).
(French version: [`CREER.md`](CREER.md). The reference documents linked below are in French.)

## The goal

An archive that `pipeline/check_pack.py` declares `OK`, and whose music is that of the page.
It holds:

- the **music** of each voice (notes, rhythms, lyrics), and the accompaniment when the score has
  one;
- the **pages** of the score, cleaned, with the place of every measure;
- optionally, the **work notes** (`fiche.md`): the sung text and its translation.

The format is described in [`ARCHIVE.md`](ARCHIVE.md). What makes the archive valuable, in this
order: the accuracy of the voices, the legibility of the pages, the accompaniment. The person
learns their part by ear from this archive: a wrong note is learnt as well as a right one.

## What you have

- **The kit**: `git clone --depth 1 https://github.com/Bolevo/pupitre-ouvert`, or
  [https://bolevo.github.io/pupitre-ouvert/kit.zip](https://bolevo.github.io/pupitre-ouvert/kit.zip)
  (2 MB; without network access, the person can attach it). Then
  `pip install -r pipeline/requirements.txt` (Python ≥ 3.10).
- **Scripts for everything mechanical**: preparing and cleaning the pages, cutting them for
  reading, checking a transcription, engraving it under the page to compare the two, compiling,
  building and checking the archive. They are short and readable; each one says what it does
  with `--help`.
- **Two complete examples**, from the scan to the archive:
  [`scores/locus-iste/`](../scores/locus-iste) (choir a cappella) and
  [`scores/schubert-kyrie/`](../scores/schubert-kyrie) (soloist, choir and piano). Each folder
  keeps its table of measures, its transcription `src/*.cht` and its work notes;
  `python pipeline/publish.py locus-iste` makes its archive.

The method is yours to choose. The path described below was used to transcribe whole works for
choir and piano: take it as it is, adapt it, or do otherwise if this score calls for it — read
the sources, change a script, write one. What counts is the result: an archive that is `OK` and
music faithful to the page.

All commands run from the root of the kit; `<id>` is the name of the work's folder.

## The proven path

### 1. The pages

```
python tools/source.py scores/<id> score.pdf              # or photos, in order: p1.jpg p2.jpg …
```

Writes one image per page (`work/source/`), `work/pages.tsv` (image → page number) and
`work/apercu.png`: every image, small, with its number. Look at it. If there is a cover, blank
pages or other pieces, or if the first page of music bears another number than 1, run again:
`--pages 3-8` keeps these images, `--first-page 12` gives the first one the number printed on
the page, `--force` replaces. That page number names everything that follows (`src/012.cht`,
`p012…`) and is the one the app shows.

### 2. work.yaml

`scores/<id>/work.yaml` — title and composer are read on the first page:

```yaml
id: faure-cantique                 # = <id>: letters, digits, hyphens
title: "Cantique de Jean Racine"
composer: "G. Fauré"
staves: [S, A, T, B, PR, PL]       # the staves of a system, top to bottom
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:
  1: {id: fr, label: "Français", lang: fr}
```

`staves`: `S A T B` are the voices, `PR PL` the two hands of the keyboard; a cappella,
`[S, A, T, B]` (other cases: “Other layouts”). One movement per separate piece (each starts
again at measure 1). Optional: `notice` (edition, rights), `defaultPart`, and per movement
`keys` and `tempo` — see [`ARCHIVE.md`](ARCHIVE.md#workyaml).

### 3. The systems and the measures

```
python tools/omr/pages.py --work scores/<id>
```

Cleans every page, finds its systems, staves and barlines, writes `work/measures.tsv` (the
measures of each system, where every number comes from) and the crops for reading. One line per
page says what was found: `p008: m1-13; 3 system(s) of 4 4 4 staves, measures 4 5 4`.

To check on `work/img/pNNN_overlay.png` (one image per page; every barline in red, with the
number of the measure it ends): does each system have its true number of measures? The numbers
printed at the start of the systems help. If not, correct and run the same command again:

- **a wrong count** (a stem taken for a barline, a faint barline missed): `systems` in
  `work/measures.tsv`. The pages are renumbered and the barlines fitted to the count (in orange,
  a barline taken from the doubtful strokes);
- **a barline no fitting finds**: `work/bars.tsv`, one line `page  system  x` (tab-separated;
  `x` is read on the ruler of the overlay);
- **staves wrongly put together into systems** (the output says `N system(s) of … staves`):
  column `staves` of `work/pages.tsv`, for instance `3,3,3,6` for three “soloist and piano”
  systems followed by one “choir and piano” system;
- **a pickup**: `first` = 0 on the first page of the movement; a new movement: column
  `movement`; a page without music has no line.

### 4. The transcription

One file `scores/<id>/src/NNN.cht` per page: a text format, one line per voice and per measure,
described in [`CHT_FORMAT.md`](CHT_FORMAT.md); what reads badly and how to write it is in
[`TRANSCRIBE.md`](TRANSCRIBE.md).

**What to read on.** `work/img/crops.txt` lists the crops, system by system:
`p008_s2_ch_m005-006.png` shows the voices of system 2 of page 8, measures 5 and 6;
`p008_s2_pf_m005-005.png`, the keyboard. Each crop carries the measure numbers at the top and,
in the margin, the **sounding** pitch of every staff line and of the first ledger lines. It is a
matter of resolution: a whole page or system, seen by a model, is reduced to the point where a
notehead on a line and one in a space can no longer be told apart, and those readings are the
ones that left the most mistakes in trials. `pNNN_sK.png`, the whole system, is an overview. For
a doubt: `python tools/omr/zoom.py <page> <measure> --staff T --work scores/<id>`.

Write each system as soon as it is read: what is written no longer depends on the images. Once
`measures.tsv` is settled, the pages are independent: if you can delegate, they can be
transcribed in parallel, each with its crops and its checks.

**Three checks**, to run page by page:

```
python pipeline/cht/check.py scores/<id> --pages <page>            # durations, syllables, ties, ranges
python pipeline/cht/heads.py scores/<id> --pages <page>            # are the noteheads of the page at the heights written?
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare    # work/render/NNN_cmp_sK.png, …_sK_pf.png
```

`check.py` finds what can be counted. `heads.py` looks for the noteheads in the picture of the
page and lists the measures where a note written has no head at its height while one stands a
step or two away: `p10 m41 A: g3 written, the head stands 1 step higher (a3?)`. These are
places to read again with the zoom, not verdicts; it judges the voices only, and not every
measure. `--compare` shows the rest: for each system, every staff of the page with, right under
it, the same staff engraved from your text, barlines aligned. A pitch, a rhythm or a syllable
that differs is seen in place. Look at every picture; the least sure readings are noteheads on
ledger lines, accidentals, and the rests of old editions. Mark `# ?` what remains uncertain.

**The accompaniment.** When the score has one, it is part of the archive: the app plays it under
the voices, it gives the key and the tempo. An order that works well: the voices of the whole
work, then steps 5 to 7 (the archive is already usable), then the keyboard, and 5 to 7 again.
Unless the person asked otherwise, the archive expected has its accompaniment; if you have to
stop at the voices, say so at the top of your message and offer the rest. Once the keyboard is
written, `python pipeline/crosscheck.py <id>` lists the sung notes that the keyboard does not
double: as many places to read again, in the voice and in the keyboard.

### 5. Compile

```
python pipeline/cht/compile.py scores/<id>                # -> mvt1.musicxml, mvt2.musicxml…
```

### 6. The app's pages

```
python tools/page_assets.py scores/<id>                   # -> pages/pNNN.webp + pages/pages.json
```

The pages are cut to what is printed, straightened and cleaned (white background, ink restored),
then every measure gets its box (`--no-frame` keeps the whole images).
`work/boxes/<id>_pNNN.png` shows the result as the app will have it: the boxes of the measures,
and in colour the staff of each voice. Look at one or two. `WARN` reports a system whose
barlines could not be matched to `measures.tsv` (same remedy as in step 3).

### 7. The archive

```
python pipeline/publish.py <id>                           # -> packs/<id>.zip
```

The last line is the verdict: `OK`, `OK with N warning(s)` (worth reading: a doubtful octave
or duration shows up there) or `FAILED` with what to correct.

### 8. The work notes (optional)

`scores/<id>/fiche.md`: the sung text, line by line, and its translation — format in
[`ARCHIVE.md`](ARCHIVE.md#fichemd-facultative). It is also what “Learn the text” uses.
`python tools/fiche_data.py <id> --words` prints, from the archive just built, the facts needed
to write it (keys, measures, durations, the words of each voice). Then run step 7 again.

## Handing over the archive

Give `packs/<id>.zip` to the person, with:

- how to add it: open [https://bolevo.github.io/pupitre-ouvert/?lang=en](https://bolevo.github.io/pupitre-ouvert/?lang=en),
  list of works at the top left → “Add a score (.zip)…”;
- what the archive covers (pages, movements, voices, accompaniment) and what it does not cover
  yet;
- what was checked, and how: the pages whose comparison you looked at, those you did not;
- the uncertain passages (`grep -n "# ?" scores/<id>/src/*.cht`), so that they can check them
  by ear, score in hand.

A fuller or corrected version replaces the earlier one in the app (same `id`). A correction is
made in `src/NNN.cht`, then steps 5 and 7; so keep the folder `scores/<id>/`.

The archive holds the images of the score: it is made for the person's own use, not to be
published if the edition is under copyright.

## Possible choices

- **Part of the work**: the pages or movements the person needs first.
- **A MusicXML already exists** (MuseScore, another source): put it in as `mvtN.musicxml` and
  skip steps 4 and 5; what it must contain is in [`ARCHIVE.md`](ARCHIVE.md).
- **Without pages**: the archive is valid without `pages/`; the app then shows the line of the
  voice.
- **A reduced accompaniment**: the bass and the chords, when the whole keyboard cannot be read.
- **An automatic draft**: `tools/omr/draft.py` (with Audiveris) gives indicative pitches;
  durations, voices and lyrics remain to be read.

## Other layouts than “four voices and piano”

The staves of a system have names: `S A T B` (voices), `PR PL` (keyboard, right and left hand).
`staves` in `work.yaml` says those of a system of the work:

| Score | `staves:` | In the `.cht` files |
|---|---|---|
| SATB choir and piano | `[S, A, T, B, PR, PL]` | voices `S A T B`, keyboard `PR PL` |
| SATB choir a cappella | `[S, A, T, B]` | no `PR`/`PL` lines |
| One voice and piano | `[S, PR, PL]` (or `T`, `B`…) | `part S "Voice"` in the header |
| Two voices and piano | `[S, A, PR, PL]` | `part S "Soprano"`, `part A "Alto"` |
| SAB and piano | `[S, A, B, PR, PL]` | voices `S A B` |
| TTBB, SSAA… | `[S, A, T, B]` | `part S "Tenor I"`, `part A "Tenor II"`… |
| Choir on 2 staves (S+A, T+B) | `[PR, PL]` | transcribe as `S A T B`; the crops are those of a keyboard |

A page whose systems differ from the rest (a soloist on a staff of their own, the piano alone):
in `work/pages.tsv`, column `staves` for the number of staves of each system (`3,3,3,6`) and
column `solo` for their names when they are not those of the work (`pipeline/cht/workdir.py`).
The margin of the crops assumes the usual clefs (`S A`: treble; `T`: treble sounding an octave
lower; `B` and `PL`: bass); elsewhere, the printed clef rules.

The CHT format covers four vocal staves and one keyboard. For more (double choir, organ with
pedals, orchestra), produce `mvtN.musicxml` by another means: steps 3, 6 and 7 stay the same.

## If a tool does not fit

Curled photos, pale pages, an unusual layout: the scripts are made to be read and adapted.
`measures.tsv` rules for the measures; where the barlines can be neither detected nor placed,
the boxes are spread evenly and the app still works. A defect in the tools or in the app can be
reported, or fixed, at
[https://github.com/Bolevo/pupitre-ouvert/issues](https://github.com/Bolevo/pupitre-ouvert/issues).

## On one page

```
python tools/source.py scores/<id> score.pdf          # look at work/apercu.png
# write scores/<id>/work.yaml
python tools/omr/pages.py --work scores/<id>          # look at work/img/pNNN_overlay.png; correct work/measures.tsv, run again
# for each page: write src/NNN.cht from the crops of work/img/crops.txt, then
python pipeline/cht/check.py scores/<id> --pages N
python pipeline/cht/heads.py scores/<id> --pages N
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare
python pipeline/cht/compile.py scores/<id>
python tools/page_assets.py scores/<id>
python pipeline/publish.py <id>                       # -> packs/<id>.zip   OK
```
