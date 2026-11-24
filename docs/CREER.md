# Créer l'archive d'une partition pour Pupitre Ouvert

Pour une IA à qui quelqu'un a confié sa partition numérisée (PDF ou photos) : vous en faites une
**archive `.zip`** qu'il ajoutera dans [Pupitre Ouvert](https://bolevo.github.io/pupitre-ouvert/)
pour suivre la partition, écouter les voix et apprendre la sienne.

(English version: [`CREATE.md`](CREATE.md).)

## Le but

Une archive que `pipeline/check_pack.py` déclare `OK`, et dont la musique est juste. Elle contient :

- la **musique** de chaque voix (notes, rythmes, paroles), et l'accompagnement s'il y en a ;
- les **pages** de la partition, nettoyées, avec la place de chaque mesure ;
- facultativement, une **fiche** : le texte chanté et sa traduction.

Le format est décrit dans [`ARCHIVE.md`](ARCHIVE.md). Ce qui fait la valeur de l'archive pour un
choriste, dans l'ordre : la justesse des voix, la lisibilité des pages, l'accompagnement.

## Ce dont vous disposez

- **Le kit** : `git clone --depth 1 https://github.com/Bolevo/pupitre-ouvert`, ou
  [https://bolevo.github.io/pupitre-ouvert/kit.zip](https://bolevo.github.io/pupitre-ouvert/kit.zip)
  (0,5 Mo ; sans réseau, la personne peut vous le joindre). Puis
  `pip install -r pipeline/requirements.txt` (Python ≥ 3.10).
- **Des scripts pour tout ce qui est mécanique** : préparer et nettoyer les pages, les découper
  pour la lecture, contrôler une transcription, la graver pour la comparer à la page, compiler,
  construire et vérifier l'archive. Ils sont courts et lisibles.
- **Un exemple complet** : [`scores/deux-chorals/`](../scores/deux-chorals) est un dossier
  d'œuvre fini ; `python pipeline/publish.py deux-chorals` en fait l'archive.

Vous êtes libre de la méthode. Le chemin décrit ci-dessous a servi à transcrire deux œuvres
entières pour chœur et piano : prenez-le tel quel, adaptez-le, ou faites autrement si cette
partition s'y prête mieux — lire les sources, modifier un script, en écrire un. Ce qui compte est
le résultat : une archive `OK` et une musique fidèle à la page.

Toutes les commandes se lancent depuis la racine du kit ; `<id>` est le nom du dossier de l'œuvre.

## Le chemin éprouvé

### 1. Les pages

```
python tools/source.py scores/<id> partition.pdf          # ou des photos, dans l'ordre : p1.jpg p2.jpg …
```

Écrit `scores/<id>/work/source/NNNN.png` et `work/pages.tsv` (image → numéro de page imprimé :
`--first-page 2` si le document commence à la page 2, `--pages 3-40` pour laisser les couvertures).

### 2. work.yaml

`scores/<id>/work.yaml` — titre et compositeur se lisent sur la première page :

```yaml
id: faure-cantique                 # = <id> : lettres, chiffres, tirets
title: "Cantique de Jean Racine"
composer: "G. Fauré"
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:
  1: {id: fr, label: "Français", lang: fr}
```

Un mouvement par morceau séparé (chacun recommence à la mesure 1). Ajoutez `staves` si les
systèmes ne sont pas « S A T B + piano » (voir « Autres dispositions »).

### 3. Les mesures de chaque page

```
python tools/omr/pages.py --work scores/<id>
python pipeline/cht/measures.py init scores/<id>          # work/measures.tsv, d'après la détection
```

`work/img/pNNN_overlay.png` montre les barres détectées. `work/measures.tsv` dit, page par page,
combien de mesures compte chaque système : corrigez-y ce que la détection a manqué (une hampe
prise pour une barre, une barre pâle), et le numéro du mouvement. Une levée est la mesure 0
(`first` = 0 sur la première page du mouvement) ; une page sans musique n'a pas de ligne. Puis :

```
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>              # les découpes portent les vrais numéros
```

Les numéros imprimés en début de système permettent de vérifier le compte.

### 4. La transcription

Un fichier `scores/<id>/src/NNN.cht` par page : un format texte, une ligne par voix et par
mesure, décrit dans [`CHT_FORMAT.md`](CHT_FORMAT.md) ; les pièges de lecture connus sont dans
[`TRANSCRIBE.md`](TRANSCRIBE.md).

Les découpes `work/img/pNNN_sK_ch_mA-B.png` (voix) et `…_pf_…` (piano) montrent quelques mesures
agrandies, avec dans la marge la hauteur **réelle** de chaque ligne de portée ;
`python tools/omr/zoom.py <page> <mesure> --staff T --work scores/<id>` agrandit une mesure
davantage. Lire mesure par mesure sur ces découpes donne de bien meilleurs résultats que lire la
page entière.

Deux contrôles, à lancer quand vous voulez :

```
python pipeline/cht/check.py scores/<id> --pages <page>            # durées, syllabes, liaisons, tessitures
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare    # work/render/NNN_cmp_sK.png
```

`--compare` empile, système par système, la page et votre transcription gravée : c'est le
contrôle le plus efficace, il montre d'un coup d'œil une hauteur, un rythme ou une syllabe qui
diffèrent. Marquez `# ?` ce qui reste incertain.

### 5. Compiler

```
python pipeline/cht/compile.py scores/<id>                # -> mvt1.musicxml, mvt2.musicxml…
```

### 6. Les pages de l'app

```
python tools/page_assets.py scores/<id>                   # -> pages/pNNN.webp + pages/pages.json
python tools/page_staves.py scores/<id> --dry-run --draw scores/<id>/work/boxes
```

Les pages sont recadrées sur ce qui est imprimé, redressées et nettoyées (fond blanc, encre
rétablie), puis chaque mesure reçoit sa case (`--no-frame` garde les images entières). Les images de `work/boxes/` montrent les cases et les portées trouvées ;
`WARN` signale un système dont les barres n'ont pas pu être accordées à `measures.tsv`.

### 7. La fiche (facultative)

`scores/<id>/fiche.md` : le texte chanté, vers par vers, et sa traduction — format dans
[`ARCHIVE.md`](ARCHIVE.md#fichemd-facultative). Elle sert aussi à « Apprendre le texte ».

### 8. L'archive

```
python pipeline/publish.py <id>                           # -> packs/<id>.zip
```

La dernière ligne est le verdict : `OK`, `OK with N warning(s)` (à lire : une octave ou une
durée douteuse s'y signale) ou `FAILED` avec ce qu'il faut corriger.

## Remettre l'archive

Donnez `packs/<id>.zip` à la personne, avec :

- comment l'ajouter : ouvrir [https://bolevo.github.io/pupitre-ouvert/](https://bolevo.github.io/pupitre-ouvert/),
  liste des œuvres en haut à gauche → « Ajouter une partition (.zip)… » ;
- ce que l'archive couvre (pages, mouvements, voix, accompagnement) ;
- les passages incertains (`grep -n "# ?" scores/<id>/src/*.cht`), pour qu'elle les vérifie à
  l'écoute, partition en main.

Une archive peut ne couvrir qu'une partie de l'œuvre : une version plus complète, ou corrigée,
remplace la précédente dans l'app (même `id`). Une correction se fait dans `src/NNN.cht`, puis
étapes 5 et 8 ; gardez donc le dossier `scores/<id>/`.

L'archive contient les images de la partition : elle est faite pour l'usage personnel de la
personne, pas pour être publiée si l'édition est protégée.

## Choix possibles

- **Les voix sans l'accompagnement** : sans lignes `PR`/`PL`, l'archive est complète pour
  apprendre sa partie. L'accompagnement peut s'ajouter ensuite, entier ou réduit à la basse et aux
  accords.
- **Un MusicXML existe déjà** (MuseScore, autre source) : posez-le en `mvtN.musicxml` et passez
  les étapes 4 et 5 ; ce qu'il doit contenir est dans [`ARCHIVE.md`](ARCHIVE.md).
- **Sans pages** : l'archive est valable sans `pages/` ; l'app montre alors la ligne de la voix.
- **Un brouillon automatique** : `tools/omr/draft.py` (avec Audiveris) donne des hauteurs
  indicatives ; durées, voix et paroles restent à lire.

## Autres dispositions que « quatre voix et piano »

Les portées d'un système portent des noms : `S A T B` (voix), `PR PL` (piano, main droite et
gauche). Par défaut : 6 portées = `S A T B PR PL`, 4 = `S A T B` (a cappella), 2 = `PR PL`, 3 à 5
= les premières voix puis `PR PL`. Pour une autre disposition, `staves` dans `work.yaml` :

| Partition | `staves:` | Dans les fichiers `.cht` |
|---|---|---|
| Chœur SATB a cappella | (rien) | pas de lignes `PR`/`PL` |
| Une voix et piano | `[S, PR, PL]` (ou `T`, `B`…) | `part S "Voix"` en en-tête |
| Deux voix et piano (4 portées) | `[S, A]` | `part S "Soprano"`, `part A "Alto"` |
| SAB et piano | `[S, A, B, PR, PL]` | voix `S A B` |
| TTBB, SSAA… | `[S, A, T, B]` | `part S "Ténor I"`, `part A "Ténor II"`… |
| Chœur sur 2 portées (S+A, T+B) | `[PR, PL]` | transcrire en `S A T B` ; les découpes sont celles d'un clavier |

Une page dont les systèmes diffèrent du reste : colonne `solo` de `work/pages.tsv`
(`pipeline/cht/workdir.py`). La marge des découpes suppose les clés habituelles (`S A` : sol ;
`T` : sol octaviée ; `B` et `PL` : fa) ; ailleurs, c'est la clé imprimée qui fait foi.

Le format CHT couvre quatre portées vocales et un clavier. Pour davantage (double chœur, orgue
avec pédalier, orchestre), produisez `mvtN.musicxml` par un autre moyen : les étapes 3, 6 et 8
restent les mêmes.

## Si un outil ne convient pas

Photos gondolées, pages pâles, mise en page inhabituelle : les scripts sont faits pour être lus
et adaptés. `measures.tsv` fait foi pour les mesures ; là où les barres ne se laissent pas
détecter, les cases sont réparties régulièrement et l'app fonctionne quand même. Un défaut des
outils ou de l'app se signale, ou se corrige, sur
[https://github.com/Bolevo/pupitre-ouvert/issues](https://github.com/Bolevo/pupitre-ouvert/issues).

## En une page

```
python tools/source.py scores/<id> partition.pdf
# écrire scores/<id>/work.yaml
python tools/omr/pages.py --work scores/<id>
python pipeline/cht/measures.py init scores/<id>      # ajuster work/measures.tsv, puis :
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>
# pour chaque page : écrire src/NNN.cht, puis
python pipeline/cht/check.py scores/<id> --pages N
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare
python pipeline/cht/compile.py scores/<id>
python tools/page_assets.py scores/<id>
python pipeline/publish.py <id>                       # -> packs/<id>.zip   OK
```
