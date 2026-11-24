# Pictures of the help page (`app/aide.html`, `app/help.html`)

The screenshots and the short video of the help show the **example work** the app opens on:
Bruckner's *Locus iste* in its first edition (1886, public domain), from its scan
(`scores/locus-iste/`). Redo them when the screen changes.

`python tools/help/before_after.py` makes the picture « a photo, and the page the app shows » of
the page « Créer l'archive » (`avant-apres.webp`), from the same scan.

From `app/`, with a Chromium (`PW_CHROMIUM`, if Playwright's own is not installed):

```sh
python ../pipeline/publish.py                     # the examples, into public/packs/
npx vite build && (npx vite preview --port 4390 --strictPort &)
node ../tools/help/shots.cjs 4390 /tmp/raw        # raw PNG; or only some: … /tmp/raw hero desk
python ../tools/help/help_images.py /tmp/raw      # WebP and MP4 into app/src/aide/img/
# the same in English, for help.html:
SHOTS_LANG=en node ../tools/help/shots.cjs 4390 /tmp/raw-en
python ../tools/help/help_images.py /tmp/raw-en src/aide/img/en
```

Then look at `aide.html` and `help.html` (phone and desktop widths). If the controls moved, the letters of the map
of the screen (`.pin`, in % of the 360 × 780 phone screenshot) may need moving: they sit on the
top-right corner of the control they name.
