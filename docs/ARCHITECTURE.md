# Architecture

Pupitre Ouvert est une **application web installable (PWA)**, sans serveur ni compte : des
fichiers statiques servis par GitHub Pages, et tout le reste dans le navigateur. Le dépôt contient
trois choses qui se suivent :

```
partition numérisée ──► scores/<oeuvre>/ ──► packs/<oeuvre>.zip ──► l'app
   (PDF, photos)        dossier d'œuvre        l'archive            (navigateur)
        tools/ + pipeline/cht/       pipeline/build_pack.py     app/
        méthode : docs/CREER.md      format : docs/ARCHIVE.md
```

## Principes de l'app

- **Un seul écran, sans menu** : les pages de la partition en haut, la ligne de la voix suivie en
  bas, la barre d'écoute. Tout nouveau réglage se paie en simplicité : en ajouter le moins possible.
- **L'archive est la seule source de vérité.** L'app ne lit jamais de MusicXML : le pipeline
  prépare tout (`pack.json` + MEI), l'app affiche et joue.
- **Identifiants stables** : chaque note de `pack.json` porte l'`xml:id` d'une note du MEI ; c'est
  ce lien qui relie le son, la ligne et la page.
- **Rien ne quitte l'appareil** : œuvres importées, réglages, enregistrements et progression sont
  dans le navigateur (IndexedDB, localStorage). Pas de mesure d'audience.
- **Hors ligne** : le service worker (Workbox) précharge l'app, l'exemple et l'aide ; les sons des
  instruments sont gardés à leur première écoute.
- **Français par défaut, anglais au choix** (Réglages) : le français est dans le code, l'anglais
  dans `src/i18n-en.ts`. Code, identifiants et commits en anglais.

## L'app (`app/`, Preact + TypeScript + Vite)

| Dossier | Rôle |
|---|---|
| `src/pack/` | l'archive : contrat (`types.ts`), import d'un zip dans un worker (`unpack.ts`, `import.worker.ts`), contrôle (`validate.ts`), bibliothèque des œuvres livrées et importées (`library.ts`), stockage IndexedDB (`db.ts`) |
| `src/state.ts` | l'état (signaux Preact) : œuvre, mouvement, voix suivie, pistes, lecture, réglages gardés |
| `src/audio/` | le moteur : une horloge (`AudioContext`), une piste par partie (`engine.ts`), ce qu'il faut jouer et quand (`plan.ts`, pur et testé), instruments échantillonnés (`sfont.ts`, `instruments.ts`), nom des notes (`solfege.ts`), métronome, enregistrement de sa voix (`recorder.ts`, `take.ts`) |
| `src/score/` | la ligne de la voix : Verovio (WebAssembly) dans un worker (`verovio.worker.ts`, `renderer.ts`) dessine la seule portée suivie, tirée du MEI (`meiFilter.ts`) |
| `src/ui/` | l'écran : pages et cases des mesures (`PageView.tsx`), ligne (`Lane.tsx`), barres (`Bars.tsx`), pistes (`Tracks.tsx`), fiche et apprentissage du texte (`Fiche.tsx`, `Memo.tsx`), enregistrement (`Rec.tsx`) |
| `src/memo/` | « Apprendre le texte » : le texte de la fiche (`text.ts`), l'exercice (`drill.ts`), la progression (`store.ts`) |
| `src/site.ts` | le nom de l'app et le préfixe de tout ce qu'elle garde dans le navigateur |
| `src/i18n.ts`, `src/i18n-en.ts` | la langue : `tt('Texte en français')` rend le texte dans la langue choisie ; la table anglaise a le texte français pour clé (`tests/i18n.test.ts` vérifie qu'aucun texte n'y manque) |
| `aide.html`, `creer.html` | l'aide, et la page « Créer l'archive » (rendue de `docs/CREER.md` au build : `vite-creer.ts`) |
| `help.html`, `create.html` | les mêmes en anglais (`docs/CREATE.md`) : à tenir à jour ensemble |
| `public/sf`, `public/audio` | les sons (voir `NOTICE.md`) |

Les temps sont en millisecondes au tempo écrit ; le tempo choisi par le chanteur n'est qu'un
facteur du moteur. Les positions dans la page viennent de `pages[].measures` (cases) et la
position dans la mesure est interpolée.

## Le pipeline (`pipeline/`, Python)

- `build_pack.py` : dossier d'œuvre → `pack/` (Verovio convertit le MusicXML en MEI et donne le
  minutage ; le reste est du calcul : parties, mesures, notes, tempos, clés).
- `publish.py` : construit, zippe, contrôle ; sans argument, installe aussi les œuvres de
  `scores/` comme œuvres livrées avec l'app (`app/public/packs/`).
- `check_pack.py` : le contrôle d'une archive (mêmes règles que `app/src/pack/validate.ts`, et davantage).
- `cht/` : le format texte de transcription (`parse.py`), ses contrôles (`check.py`), son rendu
  pour la relecture (`render.py`), sa compilation en MusicXML (`compile.py`, music21),
  `measures.tsv` (`measures.py`).

## Les outils d'image (`tools/`)

- `source.py` : PDF ou photos → une image par page.
- `omr/` : détection des portées et des barres, découpes pour la lecture (`pages.py`, `zoom.py`) ;
  `draft.py` : brouillon Audiveris, facultatif.
- `page_assets.py` (+ `page_staves.py`, `page_starts.py`) : les pages de l'app et les cases des
  mesures. Une photo ou un scan y devient une page propre : fond blanc et encre rétablie
  (`omr/imgproc.py`), page redressée et aplatie (`omr/surface.py`, `omr/dewarp.py`), recadrée sur
  ce qui est imprimé (`omr/frame.py`).
- `fiche_data.py` : les faits d'une œuvre, pour écrire sa fiche.
- `make_kit.py` : le kit (`kit.zip`) servi à côté de l'app.
- `check_sf.py`, `extract_sf2.py`, `make_solfege.py`, `help/`, `icon/` : fabrication des sons,
  des images de l'aide et de l'icône de l'app.

## Construire et tester

```
pip install -r pipeline/requirements-dev.txt
python -m pytest pipeline/tests          # le pipeline et les outils
python pipeline/publish.py               # l'exemple -> app/public/packs/
python tools/make_kit.py                 # -> app/public/kit.zip
cd app && npm ci
npm test                                 # Vitest
npm run build && npm run e2e             # Playwright sur l'app construite
npm run dev                              # http://localhost:5173
```

Le déploiement (`.github/workflows/ci.yml`) rejoue ces étapes à chaque poussée sur `main` et
publie `app/dist` sur GitHub Pages.
