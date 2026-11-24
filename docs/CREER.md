# Créer l'archive d'une partition pour Pupitre Ouvert

Pour une IA à qui quelqu'un a confié sa partition numérisée (PDF ou photos) : vous en faites une
**archive `.zip`** qu'il ajoutera dans [Pupitre Ouvert](https://bolevo.github.io/pupitre-ouvert/)
pour suivre la partition, écouter les voix et apprendre la sienne.

Ce texte est `docs/CREER.md` du dépôt [https://github.com/Bolevo/pupitre-ouvert](https://github.com/Bolevo/pupitre-ouvert). Si vous le lisez
à travers un outil qui résume les pages web, prenez l'original : il est dans le kit (ci-dessous),
et à [https://raw.githubusercontent.com/Bolevo/pupitre-ouvert/main/docs/CREER.md](https://raw.githubusercontent.com/Bolevo/pupitre-ouvert/main/docs/CREER.md).
(English version: [`CREATE.md`](CREATE.md).)

## Le but

Une archive que `pipeline/check_pack.py` déclare `OK`, et dont la musique est celle de la page.
Elle contient :

- la **musique** de chaque voix (notes, rythmes, paroles), et l'accompagnement quand la partition
  en a un ;
- les **pages** de la partition, nettoyées, avec la place de chaque mesure ;
- facultativement, une **fiche** : le texte chanté et sa traduction.

Le format est décrit dans [`ARCHIVE.md`](ARCHIVE.md). Ce qui fait la valeur de l'archive, dans
l'ordre : la justesse des voix, la lisibilité des pages, l'accompagnement. La personne apprend sa
partie à l'oreille sur cette archive : une note fausse s'y apprend aussi bien qu'une juste.

## Ce dont vous disposez

- **Le kit** : `git clone --depth 1 https://github.com/Bolevo/pupitre-ouvert`, ou
  [https://bolevo.github.io/pupitre-ouvert/kit.zip](https://bolevo.github.io/pupitre-ouvert/kit.zip)
  (2 Mo ; sans réseau, la personne peut vous le joindre). Puis
  `pip install -r pipeline/requirements.txt` (Python ≥ 3.10).
- **Des scripts pour tout ce qui est mécanique** : préparer et nettoyer les pages, les découper
  pour la lecture, contrôler une transcription, la graver sous la page pour les comparer,
  compiler, construire et vérifier l'archive. Ils sont courts et lisibles ; chacun dit ce qu'il
  fait avec `--help`.
- **Deux exemples complets**, de la numérisation à l'archive :
  [`scores/locus-iste/`](../scores/locus-iste) (chœur a cappella) et
  [`scores/schubert-kyrie/`](../scores/schubert-kyrie) (soliste, chœur et piano). Chaque dossier
  garde sa table des mesures, sa transcription `src/*.cht` et sa fiche ;
  `python pipeline/publish.py locus-iste` en fait l'archive.

Vous êtes libre de la méthode. Le chemin décrit ci-dessous a servi à transcrire des œuvres
entières pour chœur et piano : prenez-le tel quel, adaptez-le, ou faites autrement si cette
partition s'y prête mieux — lire les sources, modifier un script, en écrire un. Ce qui compte est
le résultat : une archive `OK` et une musique fidèle à la page.

Toutes les commandes se lancent depuis la racine du kit ; `<id>` est le nom du dossier de l'œuvre.

## Le chemin éprouvé

### 1. Les pages

```
python tools/source.py scores/<id> partition.pdf          # ou des photos, dans l'ordre : p1.jpg p2.jpg …
```

Écrit une image par page (`work/source/`), `work/pages.tsv` (image → numéro de page) et
`work/apercu.png` : toutes les images en petit, numérotées. Regardez-la. S'il y a une couverture,
des pages blanches ou d'autres morceaux, ou si la première page de musique porte un autre numéro
que 1, relancez : `--pages 3-8` garde ces images, `--first-page 12` donne à la première le numéro
imprimé sur la page, `--force` remplace. Ce numéro de page nomme tout ce qui suit
(`src/012.cht`, `p012…`) et c'est celui que l'app montre.

### 2. work.yaml

`scores/<id>/work.yaml` — titre et compositeur se lisent sur la première page :

```yaml
id: faure-cantique                 # = <id> : lettres, chiffres, tirets
title: "Cantique de Jean Racine"
composer: "G. Fauré"
staves: [S, A, T, B, PR, PL]       # les portées d'un système, de haut en bas
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:
  1: {id: fr, label: "Français", lang: fr}
```

`staves` : `S A T B` sont les voix, `PR PL` les deux mains du clavier ; a cappella, `[S, A, T, B]`
(autres cas : « Autres dispositions »). Un mouvement par morceau séparé (chacun recommence à la
mesure 1). Facultatifs : `notice` (édition, droits), `defaultPart`, et par mouvement `keys` et
`tempo` — voir [`ARCHIVE.md`](ARCHIVE.md#workyaml).

### 3. Les systèmes et les mesures

```
python tools/omr/pages.py --work scores/<id>
```

Nettoie chaque page, y trouve les systèmes, les portées et les barres de mesure, écrit
`work/measures.tsv` (les mesures de chaque système, d'où viennent tous les numéros) et les
découpes de lecture. Une ligne par page dit ce qui a été trouvé :
`p008: m1-13; 3 system(s) of 4 4 4 staves, measures 4 5 4`.

À vérifier sur `work/img/pNNN_overlay.png` (une image par page ; chaque barre en rouge, avec le
numéro de la mesure qu'elle ferme) : chaque système a-t-il son vrai nombre de mesures ? Les
numéros imprimés en début de système aident. Sinon, corrigez et relancez la même commande :

- **un compte faux** (une hampe prise pour une barre, une barre pâle manquée) : `systems` dans
  `work/measures.tsv`. Les pages sont renumérotées et les barres ajustées au compte (en orange,
  une barre prise parmi les traits douteux) ;
- **une barre qu'aucun ajustement ne trouve** : `work/bars.tsv`, une ligne `page  système  x`
  (séparés par des tabulations ; `x` se lit sur la règle graduée de l'overlay) ;
- **des portées mal réparties en systèmes** (la sortie dit `N system(s) of … staves`) : colonne
  `staves` de `work/pages.tsv`, par exemple `3,3,3,6` pour trois systèmes « soliste et piano »
  puis un système « chœur et piano » ;
- **une levée** : `first` = 0 sur la première page du mouvement ; un nouveau mouvement : colonne
  `movement` ; une page sans musique n'a pas de ligne.

### 4. La transcription

Un fichier `scores/<id>/src/NNN.cht` par page : un format texte, une ligne par voix et par
mesure, décrit dans [`CHT_FORMAT.md`](CHT_FORMAT.md) ; ce qui se lit mal et comment l'écrire est
dans [`TRANSCRIBE.md`](TRANSCRIBE.md).

**Sur quoi lire.** `work/img/crops.txt` liste les découpes, système par système :
`p008_s2_ch_m005-006.png` montre les voix du système 2 de la page 8, mesures 5 et 6 ;
`p008_s2_pf_m005-005.png`, le clavier. Chaque découpe porte en haut les numéros de mesure et dans
la marge la hauteur **réelle** de chaque ligne de portée et des premières lignes supplémentaires.
C'est une question de résolution : une page ou un système entier, vus par un modèle, sont réduits
au point qu'une tête sur la ligne et une tête dans l'interligne ne se distinguent plus, et ces
lectures-là sont celles qui ont laissé le plus de fautes lors des essais. `pNNN_sK.png`, le
système entier, sert de vue d'ensemble. Pour un doute :
`python tools/omr/zoom.py <page> <mesure> --staff T --work scores/<id>`.

Écrivez chaque système dès qu'il est lu : ce qui est écrit ne dépend plus des images. Une fois
`measures.tsv` établi, les pages sont indépendantes : si vous pouvez déléguer, elles se
transcrivent en parallèle, chacune avec ses découpes et ses contrôles.

**Trois contrôles**, à lancer page par page :

```
python pipeline/cht/check.py scores/<id> --pages <page>            # durées, syllabes, liaisons, tessitures
python pipeline/cht/heads.py scores/<id> --pages <page>            # les têtes de note de la page sont-elles à la hauteur écrite ?
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare    # work/render/NNN_cmp_sK.png, …_sK_pf.png
```

`check.py` trouve ce qui se compte. `heads.py` cherche les têtes de note sur l'image de la page
et liste les mesures où une note écrite n'a pas de tête à sa hauteur alors qu'il y en a une à un
ou deux degrés : `p10 m41 A: g3 written, the head stands 1 step higher (a3?)`. Ce sont des
endroits à relire au zoom, pas des verdicts ; il ne juge que les voix, et pas toutes les mesures.
`--compare` montre le reste : pour chaque système, chaque portée de la page avec, juste dessous,
la même portée gravée d'après votre texte, barres de mesure alignées. Une hauteur, un rythme ou
une syllabe qui diffèrent s'y voient en place. Regardez chaque image ; les lectures les moins
sûres sont les têtes sur lignes supplémentaires, les altérations et les silences des éditions
anciennes. Marquez `# ?` ce qui reste incertain.

**L'accompagnement.** Quand la partition en a un, il fait partie de l'archive : l'app le joue
sous les voix, il donne le ton et le tempo. Un ordre qui marche bien : les voix de toute l'œuvre,
puis étapes 5 à 7 (l'archive est déjà utilisable), puis le clavier, et de nouveau 5 à 7. Sauf
demande de la personne, l'archive attendue a son accompagnement ; si vous devez vous arrêter aux
voix, dites-le en tête de votre message et proposez la suite. Une fois le clavier écrit,
`python pipeline/crosscheck.py <id>` liste les notes chantées que le clavier ne double pas :
autant d'endroits à relire, dans la voix et au clavier.

### 5. Compiler

```
python pipeline/cht/compile.py scores/<id>                # -> mvt1.musicxml, mvt2.musicxml…
```

### 6. Les pages de l'app

```
python tools/page_assets.py scores/<id>                   # -> pages/pNNN.webp + pages/pages.json
```

Les pages sont recadrées sur ce qui est imprimé, redressées et nettoyées (fond blanc, encre
rétablie), puis chaque mesure reçoit sa case (`--no-frame` garde les images entières).
`work/boxes/<id>_pNNN.png` montre le résultat tel que l'app l'aura : les cases des mesures, et en
couleur la portée de chaque voix. Regardez-en une ou deux. `WARN` signale un système dont les
barres n'ont pas pu être accordées à `measures.tsv` (même remède qu'à l'étape 3).

### 7. L'archive

```
python pipeline/publish.py <id>                           # -> packs/<id>.zip
```

La dernière ligne est le verdict : `OK`, `OK with N warning(s)` (à lire : une octave ou une
durée douteuse s'y signale) ou `FAILED` avec ce qu'il faut corriger.

### 8. La fiche (facultative)

`scores/<id>/fiche.md` : le texte chanté, vers par vers, et sa traduction — format dans
[`ARCHIVE.md`](ARCHIVE.md#fichemd-facultative). Elle sert aussi à « Apprendre le texte ».
`python tools/fiche_data.py <id> --words` imprime, d'après l'archive construite, les faits utiles
pour l'écrire (tons, mesures, durées, paroles de chaque voix). Puis relancez l'étape 7.

## Remettre l'archive

Donnez `packs/<id>.zip` à la personne, avec :

- comment l'ajouter : ouvrir [https://bolevo.github.io/pupitre-ouvert/](https://bolevo.github.io/pupitre-ouvert/),
  liste des œuvres en haut à gauche → « Ajouter une partition (.zip)… » ;
- ce que l'archive couvre (pages, mouvements, voix, accompagnement) et ce qu'elle ne couvre pas
  encore ;
- ce qui a été vérifié, et comment : les pages dont vous avez regardé la comparaison, celles que
  vous n'avez pas regardées ;
- les passages incertains (`grep -n "# ?" scores/<id>/src/*.cht`), pour qu'elle les vérifie à
  l'écoute, partition en main.

Une version plus complète, ou corrigée, remplace la précédente dans l'app (même `id`). Une
correction se fait dans `src/NNN.cht`, puis étapes 5 et 7 ; gardez donc le dossier `scores/<id>/`.

L'archive contient les images de la partition : elle est faite pour l'usage personnel de la
personne, pas pour être publiée si l'édition est protégée.

## Choix possibles

- **Une partie de l'œuvre** : les pages ou les mouvements dont la personne a besoin d'abord.
- **Un MusicXML existe déjà** (MuseScore, autre source) : posez-le en `mvtN.musicxml` et passez
  les étapes 4 et 5 ; ce qu'il doit contenir est dans [`ARCHIVE.md`](ARCHIVE.md).
- **Sans pages** : l'archive est valable sans `pages/` ; l'app montre alors la ligne de la voix.
- **Un accompagnement réduit** : la basse et les accords, quand le clavier entier ne se lit pas.
- **Un brouillon automatique** : `tools/omr/draft.py` (avec Audiveris) donne des hauteurs
  indicatives ; durées, voix et paroles restent à lire.

## Autres dispositions que « quatre voix et piano »

Les portées d'un système portent des noms : `S A T B` (voix), `PR PL` (clavier, main droite et
gauche). `staves` dans `work.yaml` dit celles d'un système de l'œuvre :

| Partition | `staves:` | Dans les fichiers `.cht` |
|---|---|---|
| Chœur SATB et piano | `[S, A, T, B, PR, PL]` | voix `S A T B`, clavier `PR PL` |
| Chœur SATB a cappella | `[S, A, T, B]` | pas de lignes `PR`/`PL` |
| Une voix et piano | `[S, PR, PL]` (ou `T`, `B`…) | `part S "Voix"` en en-tête |
| Deux voix et piano | `[S, A, PR, PL]` | `part S "Soprano"`, `part A "Alto"` |
| SAB et piano | `[S, A, B, PR, PL]` | voix `S A B` |
| TTBB, SSAA… | `[S, A, T, B]` | `part S "Ténor I"`, `part A "Ténor II"`… |
| Chœur sur 2 portées (S+A, T+B) | `[PR, PL]` | transcrire en `S A T B` ; les découpes sont celles d'un clavier |

Une page dont les systèmes diffèrent du reste (un soliste sur sa portée, le piano seul) : dans
`work/pages.tsv`, colonne `staves` pour le nombre de portées de chaque système (`3,3,3,6`) et
colonne `solo` pour leurs noms quand ce ne sont pas ceux de l'œuvre (`pipeline/cht/workdir.py`).
La marge des découpes suppose les clés habituelles (`S A` : sol ; `T` : sol octaviée ; `B` et
`PL` : fa) ; ailleurs, c'est la clé imprimée qui fait foi.

Le format CHT couvre quatre portées vocales et un clavier. Pour davantage (double chœur, orgue
avec pédalier, orchestre), produisez `mvtN.musicxml` par un autre moyen : les étapes 3, 6 et 7
restent les mêmes.

## Si un outil ne convient pas

Photos gondolées, pages pâles, mise en page inhabituelle : les scripts sont faits pour être lus
et adaptés. `measures.tsv` fait foi pour les mesures ; là où les barres ne se laissent ni
détecter ni placer, les cases sont réparties régulièrement et l'app fonctionne quand même. Un
défaut des outils ou de l'app se signale, ou se corrige, sur
[https://github.com/Bolevo/pupitre-ouvert/issues](https://github.com/Bolevo/pupitre-ouvert/issues).

## En une page

```
python tools/source.py scores/<id> partition.pdf      # regarder work/apercu.png
# écrire scores/<id>/work.yaml
python tools/omr/pages.py --work scores/<id>          # regarder work/img/pNNN_overlay.png ; corriger work/measures.tsv, relancer
# pour chaque page : écrire src/NNN.cht d'après les découpes de work/img/crops.txt, puis
python pipeline/cht/check.py scores/<id> --pages N
python pipeline/cht/heads.py scores/<id> --pages N
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare
python pipeline/cht/compile.py scores/<id>
python tools/page_assets.py scores/<id>
python pipeline/publish.py <id>                       # -> packs/<id>.zip   OK
```
