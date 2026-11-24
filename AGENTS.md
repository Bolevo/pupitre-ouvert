# Pupitre Ouvert — guide pour un agent

Dépôt public d'une app d'apprentissage de partition pour choristes (PWA, sans serveur) et des
outils qui fabriquent ses archives. Deux raisons d'être ici, deux lectures.

## Vous venez fabriquer l'archive d'une partition

[`docs/CREER.md`](docs/CREER.md) décrit le but, les outils et un chemin éprouvé ; l'app n'est
pas à lire pour cela. On travaille dans `scores/<id>/`, le résultat est `packs/<id>.zip`, et
`python pipeline/publish.py <id>` se termine par son verdict (`OK`).

- La méthode est libre : le chemin décrit, une variante, ou la vôtre. L'œuvre d'exemple
  (`scores/deux-chorals/`) et les sources montrent ce qui est attendu.
- Les scripts font le mécanique (pages, découpes, contrôles, compilation, archive).
- Ce qui reste incertain se dit à la personne : elle apprend sa partie sur cette archive.
- Les partitions des personnes sont souvent des éditions protégées : elles ne vont pas dans ce
  dépôt (`scores/*/work/`, `scores/*/pack/` et `packs/` sont ignorés par git).

## Vous venez changer le code

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) : les modules, les principes, les commandes.

- **Un seul écran, sans menu.** Pas de micro hors « Enregistrer ma voix », pas de ludification.
  Avant d'ajouter une fonction ou un réglage, demandez-vous si l'app reste aussi simple.
- L'archive est la seule source de vérité de l'app ; elle ne lit jamais de MusicXML.
  Changer le contrat (`app/src/pack/types.ts`) se fait de façon compatible (version 1.x) et dans
  les trois lieux : `pipeline/build_pack.py`, `pipeline/check_pack.py` + `app/src/pack/validate.ts`,
  `docs/ARCHIVE.md`.
- Interface en français, et en anglais au choix : tout texte montré passe par `tt('…')`
  (`app/src/i18n.ts`) et reçoit sa traduction dans `app/src/i18n-en.ts` ; les pages `aide.html` /
  `help.html` et `docs/CREER.md` / `docs/CREATE.md` se tiennent à jour ensemble. Code,
  identifiants, commentaires et commits en anglais.
- Chaque changement se termine par une preuve : `python -m pytest pipeline/tests`,
  `npm test`, `npm run build && npm run e2e` (dans `app/`), une capture d'écran pour l'écran.
- L'audio sur téléphone se vérifie sur un vrai téléphone : ses défauts ne se devinent pas.
- Pas de secret, pas de partition protégée dans le dépôt.

## Arborescence

- `app/` — l'app (Vite + Preact + TypeScript) ; `app/public/packs/` est généré.
- `pipeline/` — dossier d'œuvre → archive (`build_pack.py`, `publish.py`, `check_pack.py`),
  format de transcription (`cht/`).
- `tools/` — images des pages (`source.py`, `omr/`, `page_assets.py`), kit (`make_kit.py`).
- `scores/deux-chorals/` — l'œuvre d'exemple, modèle d'un dossier d'œuvre.
- `docs/` — `CREER.md` (méthode ; `CREATE.md` en anglais), `ARCHIVE.md` (format), `TRANSCRIBE.md`,
  `CHT_FORMAT.md`, `ARCHITECTURE.md`.
