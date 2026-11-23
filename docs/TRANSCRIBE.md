# TRANSCRIRE — lire une page et l'écrire en `.cht`

Étape 4 de [`CREER.md`](CREER.md). Le format : [`CHT_FORMAT.md`](CHT_FORMAT.md).
Cette méthode a servi à transcrire deux œuvres entières (80 pages, chœur et piano) ; les pièges
ci-dessous sont ceux qui ont réellement coûté des erreurs.

Priorité de justesse : **les voix (notes, rythme, paroles)**, puis l'accompagnement.
On ne transcrit **jamais une page d'un coup** : on lit l'image, mesure par mesure.

## 1. Ce qui est déjà là

- `work/measures.tsv` : pour chaque page, le mouvement, les mesures par système, le premier et le
  dernier numéro de mesure. **C'est la source des numéros** : votre page commence à `first`.
- `work/img/` (écrit par `tools/omr/pages.py`) :
  1. `pNNN_overlay.png` — la page, barres détectées en rouge avec leur numéro : vérifiez que les
     numéros tombent sur les bonnes mesures.
  2. `pNNN_sK.png` — le système K entier : vue d'ensemble, texte, nuances, repères.
  3. `pNNN_sK_ch_mA-B.png` (voix) et `pNNN_sK_pf_mA-B.png` (piano) — quelques mesures agrandies,
     numéros de mesure en haut, et dans la marge **la hauteur réelle de chaque ligne de portée**
     (le ténor déjà à l'octave inférieure). C'est la vue de travail.
- Un doute sur une note : `python tools/omr/zoom.py <page> <mesure> --staff T --work scores/<id>`
  → `work/zoom/`. Une tête entre deux lignes se confond vite avec la ligne : zoomez plutôt que de
  supposer.

## 2. Écrire `src/NNN.cht`

En-tête (`page`, `movement`, `lyrics`, `meta key=… time=… tempo=…`), une ligne `system K` avant
la première mesure de chaque système, puis pour chaque mesure : les voix (`R` pour un silence de
mesure), les paroles sous chaque voix qui chante, le piano (`PR`, `PL`, + `PR2`/`PL2` s'il a deux
voix sur une portée).

Ordre conseillé par mesure : **compter les temps** de chaque portée → les notes → les paroles.
Tout ce qui reste incertain : `# ?` et la raison, sur la ligne.

Un exemple complet (une voix et piano, avec levée) :

```
page 1
movement 1
lyrics de
part S "Voix"
meta key=3 time=2/4 tempo=50 text="Langsam, zart"   # tempo estimated (no metronome mark)
system 1
m 0 dur=1/16
S   | r:16
PR  | c#5:16~
PL  | r:16
m 1
S   | R
PR  | c#5:4~ c#5:16 b4:16 g#5:16 f#5:16
PR2 | s:4 f#4:4
PL  | d3:16 a#3:16 b3:16 d4:16~ d4:4
PL2 | d3:4~ d3:4
system 2
m 4
S   | r:4 r:8 r:16 !p c#5:16
S.de| Im
m 5
S   | c#5:8. b4:16 b4:16 d5:16 f#4:16 g#4:16
S.de| Wun- der- schö- nen Mo- nat
```

## 3. La boucle de vérification (obligatoire)

```
python pipeline/cht/check.py scores/<id> --pages 13-20              # 0 erreur exigé (< 1 s)
python pipeline/cht/render.py scores/<id>/src/013.cht --compare      # work/render/013_cmp_sK.png
python pipeline/cht/render.py scores/<id>/src/013.cht --compare --parts T
```

`--compare` empile, système par système, la page (haut) et le rendu de votre texte (bas) :
lisez-les mesure par mesure (hauteurs, rythmes, liaisons, syllabes). Corrigez, relancez, jusqu'à
concordance. Avec `--parts T`, la page est recadrée sur la portée du ténor et ses paroles : faites-le
pour la voix de la personne. Pages sans chœur : `--parts PR,PL`.

Fini quand :

- `check.py` : 0 erreur ; chaque avertissement lu (tessiture, saut de plus d'une octave : souvent
  une erreur d'octave ou de clé) ;
- chaque système comparé ;
- `grep -n "# ?" scores/<id>/src/NNN.cht` court et justifié.

## 4. Pièges observés

- **Octave du ténor** : écrit en clé de sol, il sonne une octave plus bas : un la du 2ᵉ interligne
  s'écrit `a3`. La marge des découpes donne déjà la hauteur réelle. Tessiture usuelle c3–a4.
- **Armure** : écrire l'altération dans chaque note (en La majeur, tout fa est `f#`). Les
  **bécarres** valent jusqu'à la barre ; une altération accidentelle ne passe pas la barre, sauf
  liaison.
- **Mi♯, si♯, do♭** : `e#4`, `b#3`, `cb5` — pas `f4`, `c4`, `b4`.
- **Liaisons** : `~` seulement entre mêmes hauteurs **dans la même voix**, à la barre comme au
  changement de page (`check.py` le vérifie). Note liée = pas de syllabe. Une courbe entre
  hauteurs différentes est un legato : ne rien écrire.
- **Paroles** : une syllabe par attaque ; `_` pour une note de mélisme (nouvelle hauteur, même
  syllabe) ; un mot coupé en fin de mesure garde son `-` et continue dans la mesure suivante.
  Le texte imprimé petit se reconstitue avec le texte connu de l'œuvre (psaume, messe, poème).
- **Triolets** : le « 3 » n'est souvent imprimé qu'au début ; une mesure à 4 temps qui contient
  12 croches, ce sont des triolets.
- **Mesure à `C` barré, mesures doubles** : comptez ce que contient réellement la mesure avant
  d'écrire `time=`.
- **Levée** : `m 0 dur=1/8`, et `first` = 0 dans `measures.tsv`.
- **Clavier** : changements de clé (`clef:G`, `clef:F`) ; trois voix sur une portée → réduire à
  deux (notes tenues en accords liés) ; une tête commune à deux voix s'écrit dans une seule,
  l'autre reçoit un silence invisible `s:`. Les notes répétées identiques se recopient (vérifier
  la première, la dernière, puis le rendu).
- **Silence de mesure** d'une voix : `R` (aussi dans les pages où le chœur se tait).
- **Tempo** : sans métronome imprimé, estimer et le dire (`tempo=60  # estimated`) ;
  `meta text="…"` juste après `m N` pour une indication à cette mesure.
- **Page partagée entre deux mouvements** : deux fichiers, `009a.cht` et `009b.cht`, et deux
  lignes dans `measures.tsv` (voir `CHT_FORMAT.md`).
- **Annotations au crayon** sur les photos (respirations, accents) : à ignorer.

## 5. Ordres de grandeur

Une page de piano seul et dense (47 mesures) : environ 75 minutes de lecture attentive ; une page
de chœur et piano : 30 à 60 minutes ; quatre voix seules : bien moins. Ce temps est celui de la
justesse : une archive vite faite et fausse fait apprendre des fautes.
