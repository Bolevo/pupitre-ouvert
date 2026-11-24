# TRANSCRIRE — lire une page et l'écrire en `.cht`

Étape 4 de [`CREER.md`](CREER.md). Le format : [`CHT_FORMAT.md`](CHT_FORMAT.md).
Ce qui suit vient de la transcription d'œuvres entières (chœur et piano, a cappella, éditions
récentes et anciennes) : ce qui a bien marché, et les pièges qui ont réellement coûté des erreurs. À prendre comme une
expérience, pas comme un règlement.

Ce qui compte le plus : **les voix (notes, rythme, paroles)**, puis l'accompagnement. La lecture
la plus sûre se fait mesure par mesure, sur les découpes agrandies : une page lue d'un seul
regard donne des erreurs que rien ne signale.

## 1. Ce qui est déjà là

- `work/measures.tsv` : pour chaque page, le mouvement, les mesures par système, le premier et le
  dernier numéro de mesure. **C'est la source des numéros** : votre page commence à `first`.
- `work/img/` (écrit par `tools/omr/pages.py`), et `work/img/crops.txt` qui liste les découpes
  dans l'ordre de lecture :
  1. `pNNN_overlay.png` — la page, barres trouvées en rouge avec leur numéro : les numéros
     tombent-ils sur les bonnes mesures ?
  2. `pNNN_sK.png` — le système K entier : vue d'ensemble (qui chante, texte, nuances, repères).
     Trop petit pour y lire les notes.
  3. `pNNN_sK_ch_mAAA-BBB.png` (voix) et `pNNN_sK_pf_mAAA-BBB.png` (clavier, plus grand) —
     quelques mesures agrandies, numéros de mesure en haut, et dans la marge **la hauteur réelle
     de chaque ligne de portée** (le ténor déjà à l'octave inférieure) et des deux premières
     lignes supplémentaires de chaque côté, en vert. C'est la vue de travail.
- Un doute sur une note : `python tools/omr/zoom.py <page> <mesure> --staff T --work scores/<id>`
  → `work/zoom/` (plusieurs endroits d'un coup : `50,53-54,58`). Une tête entre deux lignes se
  confond vite avec la ligne : zoomez plutôt que de supposer.

## 2. Écrire `src/NNN.cht`

En-tête (`page`, `movement`, `lyrics`, `meta key=… time=… tempo=…`), une ligne `system K` avant
la première mesure de chaque système, puis pour chaque mesure : les voix (`R` pour un silence de
mesure), les paroles sous chaque voix qui chante, le piano (`PR`, `PL`, + `PR2`/`PL2` s'il a deux
voix sur une portée).

Un ordre qui marche bien, par mesure : compter les temps de chaque portée, puis les notes, puis
les paroles. Ce qui reste incertain se marque `# ?`, avec la raison, sur la ligne.

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

## 3. Vérifier

```
python pipeline/cht/check.py scores/<id> --pages 13-20              # durées, syllabes, liaisons (< 1 s)
python pipeline/cht/heads.py scores/<id> --pages 13-20              # têtes de note de la page / hauteurs écrites
python pipeline/cht/render.py scores/<id>/src/013.cht --compare      # work/render/013_cmp_sK.png, 013_cmp_sK_pf.png
python pipeline/cht/render.py scores/<id>/src/013.cht --compare --parts T
```

`--compare` écrit une image par système pour les voix, une pour le clavier : chaque portée de la
page (fond blanc) et, juste dessous, la même portée gravée d'après votre texte (fond teinté),
étirée pour que ses barres de mesure tombent sous celles de la page. On compare de haut en bas,
temps par temps : une tête plus haut ou plus bas, une valeur, une altération, une syllabe. La
gravure rappelle la clé et la mesure au début de chaque image, et ne dessine ni liaisons
d'expression ni soufflets : ce ne sont pas des différences. Avec `--parts T`, seule la portée du
ténor : utile pour la voix de la personne.

`check.py` ne peut pas voir une note de bonne durée et de mauvaise hauteur. `heads.py` en trouve
une bonne part sans regarder d'image : il repère les têtes de note de la page et liste les mesures
où une note écrite n'a pas de tête à sa hauteur (`p10 m41 A: g3 written, the head stands 1 step
higher (a3?)`). Relisez ces mesures au zoom — ce peut être une altération, un silence ou une
liaison pris pour une tête. Il ne voit ni un rythme faux ni une erreur d'octave, ne juge que les
voix, et compte sans les lister les mesures dont il n'a pas su séparer les têtes : la comparaison
reste donc à regarder, image par image, en particulier les têtes sur lignes supplémentaires, les
altérations, et les mesures où plusieurs voix ont le même rythme (une faute s'y recopie).

Pour une œuvre avec clavier, une fois l'archive construite, `python pipeline/crosscheck.py <id>`
liste les notes chantées que le clavier ne joue à aucune octave pendant qu'elles durent. Une
réduction double presque toujours le chœur : chaque ligne désigne un endroit à relire, dans la
voix et au clavier.

Une page est au point quand `check.py` ne signale plus d'erreur (ses avertissements — tessiture,
saut de plus d'une octave — désignent souvent une erreur d'octave ou de clé), que les mesures
listées par `heads.py` ont été relues, que chaque système concorde avec sa gravure, et que `grep -n "# ?" scores/<id>/src/NNN.cht` ne liste que de vrais doutes.

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
- **Clavier** : trois voix sur une portée → réduire à deux (notes tenues en accords liés) ; une
  tête commune à deux voix s'écrit dans une seule, l'autre reçoit un silence invisible `s:`. Les
  notes répétées identiques se recopient (vérifier la première, la dernière, puis la gravure).
- **Changement de clé** au clavier : `clef:G`, `clef:F` à sa place dans la voix ; il vaut jusqu'au
  suivant, au-delà de la barre et de la page. Les hauteurs s'écrivent toujours réelles : la clé ne
  change que la gravure. La marge des découpes, elle, suppose la clé habituelle de la portée : là
  où la page imprime une autre clé, lisez d'après la clé.
- **Lignes supplémentaires** : compter les lignes depuis la portée ; la marge nomme les deux
  premières. Ce sont les lectures les moins sûres : un zoom coûte moins qu'une faute.
- **Éditions anciennes** (gravures du XIXᵉ siècle) : le **soupir** y a souvent la forme d'un demi-
  soupir retourné (un « 7 » à l'envers) — compter les temps de la mesure le départage ; le
  ténor est souvent en clé de sol sans le « 8 » (il sonne quand même à l'octave inférieure) ; une
  voix en clé d'ut se lit d'après sa clé, la marge ne vaut plus pour elle.
- **Ce qui ne s'écrit pas** : liaisons d'expression, points de staccato, accents, trilles, notes
  d'ornement, doigtés, pédale. Un soufflet s'écrit `!cresc` ou `!dim` à son début, ou pas du tout.
- **Nombres imprimés** : en haut de la page, c'est le numéro de page ; au-dessus d'un système, un
  chiffre ou une lettre de répétition (`mark=`) ; en début de système, parfois le numéro de mesure.
- **Soliste sur sa propre portée** : une voix `S A T B` nommée par `part S "Soprano solo"` ; les
  pages où les systèmes changent (soliste et piano, puis chœur et piano) se décrivent dans
  `work/pages.tsv` (colonnes `staves` et `solo`).
- **Silence de mesure** d'une voix : `R` (aussi dans les pages où le chœur se tait).
- **Tempo** : sans métronome imprimé, estimer et le dire (`tempo=60  # estimated`) ;
  `meta text="…"` juste après `m N` pour une indication à cette mesure.
- **Page partagée entre deux mouvements** : deux fichiers, `009a.cht` et `009b.cht`, et deux
  lignes dans `measures.tsv` (voir `CHT_FORMAT.md`).
- **Annotations au crayon** sur les photos (respirations, accents) : à ignorer.
