# Créer l'archive d'une partition pour Pupitre Ouvert — méthode pour une IA

Vous êtes une IA à qui quelqu'un a confié sa partition numérisée (PDF ou photos). Vous allez en
faire une **archive `.zip`** qu'il ajoutera dans [Pupitre Ouvert](https://bolevo.github.io/pupitre-ouvert/)
pour suivre la partition, écouter les voix et apprendre la sienne.

Le travail a deux natures. Les **scripts** de ce dépôt font ce qui est mécanique (pages,
découpes, contrôles, compilation, archive) : lancez-les, ne les réécrivez pas. **Vous** lisez la
musique, mesure par mesure, et vous vérifiez. Tout le reste de ce document sert à ce que vous
dépensiez votre attention là, et nulle part ailleurs.

## Avant de commencer

1. **Il vous faut** : exécuter du code (Python ≥ 3.10, `pip`) et voir les images que vous
   produisez. Sans cela, dites-le simplement : on ne fabrique pas cette archive « de tête ».
2. **Le kit** (scripts, documentation, œuvre d’exemple, 0,5 Mo) :
   `git clone --depth 1 https://github.com/Bolevo/pupitre-ouvert` ou
   [https://bolevo.github.io/pupitre-ouvert/kit.zip](https://bolevo.github.io/pupitre-ouvert/kit.zip). Si votre environnement n'a pas de réseau,
   demandez à la personne de télécharger `kit.zip` et de vous le joindre.
   Puis `pip install -r pipeline/requirements.txt`.
3. **Dites à la personne ce qui l'attend** : la lecture est lente (comptez 20 à 60 minutes par
   page pour quatre voix et piano) ; une œuvre longue se fait en plusieurs séances, mouvement par
   mouvement. Proposez de commencer par les pages dont elle a besoin. **Les voix d'abord** :
   l'accompagnement peut venir ensuite, ou jamais (voir « Aller plus vite »).
4. L'archive contient les images de la partition : elle est faite pour l'usage personnel de celui
   qui possède la partition, pas pour être publiée.

Toutes les commandes se lancent depuis la racine du kit. `<id>` est le nom du dossier de l'œuvre.

## Les huit étapes

### 1. Les pages

```
python tools/source.py scores/<id> partition.pdf          # ou des photos, dans l'ordre : p1.jpg p2.jpg …
```

Écrit `scores/<id>/work/source/NNNN.png` et `work/pages.tsv` (image → numéro de page imprimé,
1, 2, 3… par défaut : `--first-page 2` si le PDF commence à la page 2, `--pages 3-40` pour laisser
les couvertures). Regardez une image : droite, lisible, une page par image.

### 2. work.yaml

`scores/<id>/work.yaml` — titre et compositeur lus sur la première page :

```yaml
id: faure-cantique                 # = <id> : lettres, chiffres, tirets
title: "Cantique de Jean Racine"
composer: "G. Fauré"
movements:
  - {file: mvt1.musicxml, id: mvt1, title: "Cantique de Jean Racine"}
lyrics:
  1: {id: fr, label: "Français", lang: fr}
```

Un mouvement par morceau séparé (chacun recommence à la mesure 1). `staves` seulement si les
systèmes ne sont pas « S A T B + piano » (voir « Autres dispositions »).

### 3. Compter les mesures

```
python tools/omr/pages.py --work scores/<id>              # ~4 s par page
python pipeline/cht/measures.py init scores/<id>          # premier work/measures.tsv, d'après la détection
```

Ouvrez chaque `work/img/pNNN_overlay.png` : barres détectées en rouge. Corrigez dans
`work/measures.tsv` la colonne `systems` (mesures **par système**, ex. `4,4,5`) là où la
détection s'est trompée (une hampe prise pour une barre, une barre pâle manquée), et la colonne
`movement`. Chaque segment entre deux barres est une mesure ; une levée est la mesure 0 (mettez
`first` à 0 sur la première page du mouvement). Une page sans musique : supprimez sa ligne. Puis :

```
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>              # les découpes portent maintenant les vrais numéros
```

`pages.py` ne doit plus signaler « local numbers ». Les numéros imprimés en début de système
sont votre preuve : ils doivent tomber juste.

### 4. Transcrire, page par page

Un fichier `scores/<id>/src/NNN.cht` par page imprimée. Le format est dans
[`CHT_FORMAT.md`](CHT_FORMAT.md) (court : lisez-le en entier), la manière de lire et les pièges
dans [`TRANSCRIBE.md`](TRANSCRIBE.md). L'essentiel :

- **Jamais une page d'un coup.** Mesure par mesure, sur les découpes
  `work/img/pNNN_sK_ch_mA-B.png` (voix) et `…_pf_…` (piano) : la marge donne la hauteur
  **réelle** de chaque ligne de portée. Au moindre doute :
  `python tools/omr/zoom.py <page> <mesure> --staff T --work scores/<id>`.
- Pour chaque mesure : comptez les temps, écrivez les notes, puis les paroles.
- Ce qui reste incertain reçoit `# ?` et sa raison. Ne devinez pas en silence.

Après chaque page, **la boucle de contrôle** :

```
python pipeline/cht/check.py scores/<id> --pages <page>            # 0 erreur exigé ; lisez chaque avertissement
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare    # work/render/NNN_cmp_sK.png
```

`--compare` empile, système par système, la page (en haut) et votre transcription gravée (en
bas). Regardez chaque image, mesure par mesure : hauteurs, rythmes, liaisons, syllabes. Corrigez,
relancez, jusqu'à concordance. C'est ici que se joue la justesse de l'archive.

### 5. Compiler

```
python pipeline/cht/compile.py scores/<id>                # -> mvt1.musicxml, mvt2.musicxml…
```

### 6. Les pages de l'app

```
python tools/page_assets.py scores/<id>                   # -> pages/pNNN.webp + pages/pages.json
python tools/page_staves.py scores/<id> --dry-run --draw scores/<id>/work/boxes
```

Lisez le rapport (`WARN` : un système dont les barres n'ont pas pu être accordées à
`measures.tsv`), et regardez une ou deux images de `work/boxes/` : les cases grises doivent
épouser les mesures, les bandes de couleur les portées.

### 7. La fiche (facultative, appréciée)

`scores/<id>/fiche.md` : le texte chanté, vers par vers, et sa traduction française — format dans
[`ARCHIVE.md`](ARCHIVE.md#fichemd-facultative). Elle sert aussi à « Apprendre le texte ».

### 8. L'archive

```
python pipeline/publish.py <id>                           # -> packs/<id>.zip
```

La dernière ligne doit être `OK` (ou `OK with N warning(s)` : lisez-les, ce sont souvent de
vraies erreurs — une octave, une durée). `FAILED` : corrigez ce qui est dit.

**Remettez à la personne** le fichier `packs/<id>.zip`, avec :

- comment l'ajouter : ouvrir [https://bolevo.github.io/pupitre-ouvert/](https://bolevo.github.io/pupitre-ouvert/), liste des œuvres en haut
  à gauche → « Ajouter une partition (.zip)… » ;
- ce que l'archive couvre (pages, mouvements, voix, accompagnement ou non) ;
- ce qui reste douteux, mesure par mesure (`grep -n "# ?" scores/<id>/src/*.cht`), pour qu'elle
  le vérifie à l'écoute. Une archive annoncée juste et qui ne l'est pas fait apprendre des fautes.

Gardez le dossier `scores/<id>/` (ou remettez-en une copie) : une correction se fait dans
`src/NNN.cht`, puis étapes 5 et 8 ; la nouvelle archive remplace l'ancienne dans l'app.

## Aller plus vite, sans perdre la justesse

- **Les voix seules d'abord.** N'écrivez pas les lignes `PR`/`PL` : l'archive est valable sans
  accompagnement, et quatre voix se lisent bien plus vite qu'un piano. Proposez le piano ensuite.
- **Le piano, simplifié s'il est touffu** : la basse et les accords suffisent pour se repérer ;
  dites-le dans ce que vous remettez.
- **Musique répétée** : une mesure identique se recopie (vérifiez-la tout de même au rendu).
- **Un brouillon automatique** (`tools/omr/draft.py`, avec Audiveris) existe ; il se trompe
  souvent sur les durées et les voix et ne lit pas les paroles : un indice de hauteurs, rien de plus.
- **N'ouvrez que les images utiles** : la découpe de la mesure que vous lisez, pas la page entière.

## Autres dispositions que « quatre voix et piano »

Les portées d'un système portent des noms : `S A T B` (voix), `PR PL` (piano, main droite et
gauche). Par défaut : 6 portées = `S A T B PR PL`, 4 = `S A T B` (a cappella), 2 = `PR PL`, 3 à 5
= les premières voix puis `PR PL`. Si ce n'est pas votre partition, dites-le dans `work.yaml` :

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
`T` : sol octaviée ; `B` et `PL` : fa) : si la page imprime une autre clé, lisez la clé, pas la marge.

Le format CHT s'arrête à quatre portées vocales et un clavier. Au-delà (double chœur, orgue avec
pédalier, orchestre), ou si la personne a déjà un MusicXML : sautez les étapes 4 et 5 et
fournissez vous-même `mvtN.musicxml` (ce qu'il doit contenir : [`ARCHIVE.md`](ARCHIVE.md)). Les
étapes 3, 6 et 8 restent les mêmes — ou sans pages du tout : l'archive vaut aussi sans elles.

## Quand quelque chose résiste

- Les scripts sont lisibles et courts : lisez celui qui échoue, adaptez-le à cette partition.
  Vous êtes là pour cela.
- Photos gondolées, pages pâles, barres mal détectées : `measures.tsv` fait foi ; au pire, les
  cases de ce système seront réparties régulièrement (l'app marche quand même).
- Un défaut de ces outils, ou de l'app ? Signalez-le, ou proposez la correction :
  [https://github.com/Bolevo/pupitre-ouvert/issues](https://github.com/Bolevo/pupitre-ouvert/issues).

## En une page

```
python tools/source.py scores/<id> partition.pdf
# écrire scores/<id>/work.yaml
python tools/omr/pages.py --work scores/<id>
python pipeline/cht/measures.py init scores/<id>      # corriger work/measures.tsv, puis :
python pipeline/cht/measures.py renumber scores/<id>
python tools/omr/pages.py --work scores/<id>
# pour chaque page : écrire src/NNN.cht, puis
python pipeline/cht/check.py scores/<id> --pages N
python pipeline/cht/render.py scores/<id>/src/NNN.cht --compare
python pipeline/cht/compile.py scores/<id>
python tools/page_assets.py scores/<id>
python pipeline/publish.py <id>                       # -> packs/<id>.zip   OK
```
