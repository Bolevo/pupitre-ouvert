# Pupitre Ouvert — guide pour un agent

Dépôt public d'une app d'apprentissage de partition pour choristes (PWA, sans serveur) et des
outils qui fabriquent ses archives. **Lisez d'abord ce qui concerne votre tâche, rien de plus.**

## Vous venez fabriquer l'archive d'une partition

Suivez [`docs/CREER.md`](docs/CREER.md), pas à pas. Vous n'avez pas besoin de lire l'app.
Travaillez dans `scores/<id>/` ; le résultat est `packs/<id>.zip`, et la dernière ligne de
`python pipeline/publish.py <id>` doit être `OK`.

- Ne transcrivez jamais une page d'un coup : mesure par mesure, sur les découpes, puis
  `check.py` et `render.py --compare` (`docs/TRANSCRIBE.md`).
- Les scripts font le mécanique : lancez-les plutôt que de refaire leur travail à la main.
- Dites ce qui reste douteux. Une archive fausse fait apprendre des fautes.
- Les partitions des personnes sont souvent des éditions protégées : ne les publiez pas, ne les
  ajoutez pas à ce dépôt (`scores/*/work/`, `scores/*/pack/` et `packs/` sont ignorés par git ;
  n'ajoutez pas non plus `scores/<id>/` d'une œuvre qui n'est pas libre de droits).

## Vous venez changer le code

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) : les modules, les principes, les commandes.

- **Un seul écran, sans menu.** Pas de micro hors « Enregistrer ma voix », pas de ludification.
  Avant d'ajouter une fonction ou un réglage, demandez-vous si l'app reste aussi simple.
- L'archive est la seule source de vérité de l'app ; elle ne lit jamais de MusicXML.
  Changer le contrat (`app/src/pack/types.ts`) se fait de façon compatible (version 1.x) et dans
  les trois lieux : `pipeline/build_pack.py`, `pipeline/check_pack.py` + `app/src/pack/validate.ts`,
  `docs/ARCHIVE.md`.
- Interface en français ; code, identifiants, commentaires et commits en anglais.
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
- `docs/` — `CREER.md` (méthode), `ARCHIVE.md` (format), `TRANSCRIBE.md`, `CHT_FORMAT.md`,
  `ARCHITECTURE.md`.
