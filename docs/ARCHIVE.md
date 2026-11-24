# L'archive d'une œuvre — spécification

Pupitre Ouvert ouvre une œuvre à partir d'une **archive `.zip`** (un « pack »). Ce document dit
ce qu'elle contient, et comment l'obtenir à partir d'un **dossier d'œuvre** avec les outils du
dépôt. La méthode complète, de la partition numérisée à l'archive, est dans
[`CREER.md`](CREER.md).

Deux contrôles appliquent cette spécification :

- `python pipeline/check_pack.py packs/<oeuvre>.zip` — à lancer avant de remettre l'archive
  (`pipeline/publish.py` le fait) ; dernière ligne : `OK`, `OK with N warning(s)` ou `FAILED`.
- l'app, à l'import (`app/src/pack/validate.ts`) : elle refuse une archive qu'elle ne saurait
  pas montrer, en disant quoi corriger.

Le contrat exact, champ par champ, est `app/src/pack/types.ts`.

## 1. Le chemin normal : un dossier d'œuvre, puis une commande

On n'écrit pas `pack.json` à la main. On prépare un dossier, et le constructeur fait l'archive :

```
scores/<oeuvre>/
  work.yaml             titre, compositeur, mouvements
  mvt1.musicxml …       un MusicXML par mouvement (écrit par pipeline/cht/compile.py, ou apporté)
  pages/pNNN.webp       les pages de la partition         } écrits par tools/page_assets.py
  pages/pages.json      les cases des mesures sur ces pages }  (facultatifs)
  fiche.md              texte chanté et traduction (facultative)
```

```
python pipeline/publish.py <oeuvre>      # -> packs/<oeuvre>.zip, contrôlée
```

Le modèle complet est l'œuvre d'exemple, [`scores/deux-chorals/`](../scores/deux-chorals).

### work.yaml

```yaml
id: faure-cantique            # identifiant simple et stable : lettres, chiffres, tirets
title: "Cantique de Jean Racine"
composer: "G. Fauré"
notice: "Édition …, domaine public."        # facultatif (provenance, droits)
defaultPart: T                              # facultatif : la voix montrée à qui n'en a pas encore choisi
staves: [S, A, T, B, PR, PL]                # facultatif : les portées d'un système, de haut en bas (voir CREER.md)
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:                        # facultatif : le nom des lignes de paroles (couplet 1, 2…)
  1: {id: fr, label: "Français", lang: fr}
```

- `id` de l'œuvre : une archive importée **remplace** l'œuvre de même `id` déjà dans l'app ;
  garder le même `id` pour une version corrigée, en changer pour une autre œuvre.
- `movements` : dans l'ordre. `title` commence de préférence par le numéro (« 2. Et in terra pax »,
  « II. Andante ») : l'app en tire l'onglet. Options par mouvement :
  `keys: [{m: 1, name: "ré majeur"}, {m: 45, name: "si mineur"}]` (le ton, par numéro de mesure,
  en français ; sans cela l'app le devine de l'armure et des notes) ; `tempo: "Allegro"` (le mot
  de tempo du début, s'il manque dans la partition).
- `parts` (facultatif) : pour nommer ou classer une partie autrement que d'après son nom, par
  exemple `parts: {"Voice": {id: S, name: "Soprano solo"}}` ou `{"Harpe": {kind: accomp}}`.

### Ce que le MusicXML doit contenir

Un fichier MusicXML 3 ou 4 (`.musicxml`, ou `.mxl`) par mouvement, partition complète :

- **Les parties** : une partie par voix (une portée chacune), l'accompagnement au clavier en une
  partie à deux portées. Le nom de la partie décide de son rôle : `Soprano`, `Alto`, `Tenor`,
  `Bass` (et `Sop.`, `Ténor`, `Basse`, `Baryton`…) deviennent les voix `S`, `A`, `T`, `B`
  (deux sopranos : `S1`, `S2`) ; `Piano`, `Orgue`, `Organ`, `Réduction`… l'accompagnement `P` ;
  tout autre nom est gardé tel quel et traité comme une voix.
  Une à quatre voix ou davantage, avec ou sans accompagnement, instruments seuls : tout est admis.
- **Hauteurs réelles.** Le ténor en clé de sol octaviée (`<clef-octave-change>-1`) : notes à
  l'octave où elles sonnent.
- **Numéros de mesure** : `number="1"`, `"2"`… comme sur la partition (levée : `0`). Ce sont eux
  que `pages.json` désigne.
- **Tempo** : au moins une indication métronomique au début (`<sound tempo="…"/>` ou
  `<metronome>`), sinon tout est joué à 120 à la noire.
- **Paroles** : `<lyric number="1">` pour la première ligne (couplet ou langue), `number="2"`
  pour la suivante ; `<syllabic>` correct (les traits d'union en dépendent).
- **Armure et mesure** à chaque changement ; liaisons de prolongation en `<tie>`.

Limites connues : les reprises ne sont pas rejouées (la musique est jouée une fois, dans l'ordre
écrit : recopier ce qui doit être réentendu) ; les notes d'ornement sont ignorées ; les trémolos
écrits en toutes notes à l'accompagnement sont joués deux fois plus lentement.

### pages/ (facultatif, mais c'est ce qui fait suivre la partition)

`tools/page_assets.py` écrit les images (`pNNN.webp`, 1300 px de large, niveaux de gris) et
`pages.json` :

```json
[{"page": 4, "img": "p004.webp", "w": 1300, "h": 1838,
  "systems": [{"top": 203, "bottom": 707, "staves": [{"top": 223, "bottom": 278}, …]}],
  "measures": [{"mv": 1, "n": 12, "sys": 0, "x0": 215, "x1": 655, "y0": 203, "y1": 707, "xn": 351}]}]
```

- `page` : numéro imprimé. `w`, `h` : taille de l'image en pixels ; toutes les coordonnées sont
  dans ces pixels.
- `systems` : les systèmes de la page, de haut en bas. `staves` (facultatif) : première et
  cinquième ligne de chaque portée, quand toutes les portées de la partition y figurent — l'app
  surligne alors la portée de la voix suivie.
- `measures` : une case par mesure. `mv` : **numéro** du mouvement dans `work.yaml` (1 = le
  premier ; dans l'archive finale, le constructeur le remplace par l'`id` du mouvement) ; `n` :
  numéro de mesure (entier) ; `sys` : indice du système dans `systems` ; `x0`–`x1`, `y0`–`y1` : la
  case. `xn` (facultatif, première mesure d'un système) : où commence la musique après la clé et
  l'armure.

Sans `pages/`, l'archive est valable : l'app montre la ligne de la voix, pas la partition imprimée.

### fiche.md (facultative)

Du Markdown, montré par le bouton « Fiche de l'œuvre », et source de « Apprendre le texte » :

```markdown
## 1 · Wachet auf, ruft uns die Stimme

[Jouer ce mouvement](#mv:choral1)

Noire = 120. Mi♭ majeur, 4/4, 18 mesures.

**Wachet auf, ruft uns die Stimme**\
*Réveillez-vous, nous crie la voix*
```

Une section `## ` par mouvement, avec un lien `(#mv:<id du mouvement>)` ; chaque vers du texte
chanté **en gras** sur sa ligne (sans les répétitions musicales), puis sa traduction *en italique*
sur la ligne suivante (une ligne ordinaire entre les deux serait lue comme une prononciation).
`python tools/fiche_data.py <oeuvre> --words` imprime les faits utiles pour l'écrire (tons,
mesures, durées, paroles de chaque voix), d'après l'archive construite : lancer
`pipeline/publish.py` avant, et de nouveau une fois la fiche écrite.

## 2. Ce que contient l'archive

À la racine du zip (ou tout dans un seul dossier) :

| Fichier | Rôle |
|---|---|
| `pack.json` | tout ce que l'app lit : œuvre, mouvements, parties, mesures, notes, pages |
| `<mouvement>.mei` | la partition du mouvement (MEI écrit par Verovio), dessinée par l'app |
| `pages/pNNN.webp` | les pages (webp, png ou jpg) |
| `fiche.md` | la fiche |

`pack.json` (UTF-8) :

```jsonc
{
  "version": 1,                       // l'app lit les versions 1.x
  "id": "bach-deux-chorals", "title": "Deux chorals", "composer": "J. S. Bach",
  "notice": "…", "defaultPart": "S", "fiche": "fiche.md",
  "movements": [{
    "id": "choral1", "title": "1. Wachet auf, ruft uns die Stimme", "mei": "choral1.mei",
    "durationMs": 34000,
    "parts": [{"id": "S", "name": "Soprano", "sourceName": "Soprano", "kind": "voice", "staves": [1], "range": [63, 79]}],
    "lyricLines": [{"n": 1, "id": "de", "label": "Allemand", "lang": "de"}],
    "measures": [{"id": "g47fd2z", "n": "1", "t": 0, "q": 0, "mark": null, "tonic": 3, "minor": false, "fifths": -3, "ts": [4, 4]}],
    "notes": [{"id": "rgaivk0", "part": "S", "m": 0, "t": 0, "d": 500, "midi": 63, "sp": "mib"}],
    "clefs": {"1": [{"m": 0, "sign": "G", "line": 2}]},
    "tempos": [{"t": 0, "m": 0, "bpm": 120}]
  }],
  "pages": [ /* comme pages.json, avec "img": "pages/p001.webp" et "mv": "choral1" */ ]
}
```

Ce qui doit être vrai (et que les deux contrôles vérifient) :

- `id` de l'œuvre et des mouvements : lettres, chiffres, `-`, `.`, `_` ; ceux des mouvements
  sont distincts.
- chaque mouvement a son fichier `mei`, des `parts` (`kind` : `voice` ou `accomp`), des
  `measures` (temps `t` en millisecondes au tempo écrit, croissants, la première à 0 ; `n` est une
  chaîne), une `durationMs` au-delà de la dernière mesure.
- chaque note : `part` = l'`id` d'une partie, `m` = **indice** de sa mesure dans `measures`
  (0 = la première), `t` et `d` en ms (`d` > 0, `t + d` ≤ `durationMs`), `midi` ; son `id` est
  l'`xml:id` d'une note du fichier MEI (`ids`, s'il y en a : toutes les notes dessinées que ce
  son recouvre, une chaîne de liaisons par exemple). C'est ce lien qui fait avancer la partition.
- chaque page : son image est dans l'archive et mesure `w` × `h` ; chaque case désigne un
  mouvement (`mv` = son `id`), un système de la page (`sys`) et une mesure qui existe.
- `fiche`, s'il est donné, nomme un fichier de l'archive.

Une archive faite autrement qu'avec `pipeline/build_pack.py` est acceptée si elle respecte cela ;
le plus sûr reste de produire le MusicXML et de laisser le constructeur écrire le reste (le MEI
et ses identifiants viennent de Verovio 6.3.0, la version que l'app embarque).

## 3. Dans l'app

- Import : liste des œuvres (en haut à gauche) → « Ajouter une partition (.zip)… ». L'œuvre est
  gardée dans le navigateur (IndexedDB) : elle reste là aux visites suivantes, hors connexion
  aussi. Elle ne quitte pas l'appareil.
- Retrait : même liste → « Retirer « … »… » (efface aussi les enregistrements et la progression
  du texte de cette œuvre).
- La voix suivie est celle que le chanteur a choisie (Ténor au départ) ; si l'œuvre ne l'a pas,
  la voix de la même famille, sinon la première.
