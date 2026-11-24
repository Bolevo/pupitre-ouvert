# CHT — format texte de transcription chorale

Format ligne à ligne pour transcrire (et corriger) une partition chorale à partir d'images.
Un fichier par **page imprimée** : `scores/<oeuvre>/src/<page sur 3 chiffres>.cht`
(page partagée entre deux mouvements : `009a.cht` + `009b.cht`, voir plus bas).
Compilé en MusicXML par `pipeline/cht/compile.py`, contrôlé par `pipeline/cht/check.py`.
La manière de lire la page : [`TRANSCRIBE.md`](TRANSCRIBE.md).

Principe : tout est **explicite** (hauteurs réelles, durées), pour que les contrôles automatiques
(durée des mesures, nombre de syllabes, tessiture) attrapent les erreurs.

## Structure d'un fichier

```
# commentaire libre (jusqu'à la fin de la ligne)
page 5                                   # numéro imprimé de la page
movement 1                               # mouvement (1, 2, 3…)
lyrics ru tr                             # les lignes de paroles de la page (ici russe + prononciation)
meta key=3 time=4/4 tempo=56             # OBLIGATOIRE en tête : contexte complet de la page
system 1                                 # début de système (ligne de portées) — repère pour les images
m 12 mark=2                              # mesure 12 du mouvement ; chiffre de répétition imprimé "2"
S   | R
A   | r:2 e4:4 f#4:4
A.ru| и- ду
A.tr| i- dou
T   | a3:4. b3:8 c#4:2~
T.ru| в+не- ве- до-
T.tr| vni- *vié- do-
B   | R
PR  | <c#5 e5 a5>:4 <b4 d5>:8 e5:8 <a4 c#5>:2
PL  | a2:2 e3:2
m 13
...
```

- `page`, `movement`, puis une ligne `meta` donnant **key, time, tempo** (contexte complet, même si inchangé).
- `lyrics la` (en-tête) : les lignes de paroles de la page, dans l'ordre des couplets ou des
  langues (codes de 2 à 8 lettres minuscules, à votre choix : `la`, `fr`, `de`, `v1 v2`…).
  `lyrics la` → lignes `S.la |`, `T.la |`… Une ligne `X.fr` non déclarée est une erreur. Le
  libellé montré par l'app se donne dans `work.yaml` (`lyrics: {1: {id: la, label: "Latin"}}`).
- `part S "Soprano I"` (en-tête, facultatif, une par voix S/A/T/B) : nom de la partie (solistes,
  voix d'hommes écrites dans les lignes `S A T B`…). Le nom donne aussi la clé et la tessiture
  contrôlée (`part A "Soprano II"` → soprano ; `part S "Ténor I"` → clé de sol octaviée ;
  `part T "Baryton"` → clé de fa), et signale une page où seules les voix déclarées ou utilisées
  doivent avoir une ligne à chaque mesure. Les voix attendues partout ailleurs sont celles de
  `staves` dans `work.yaml` (défaut : `S A T B`).
- Une ligne `meta` peut réapparaître pour un changement : `meta key=4`, `meta time=3/4`,
  `meta tempo=72 text="Moderato"`. `text=` = indication imprimée (`text="poco rit."` seul est permis).
  Placée **juste après `m N`** (avant les voix), elle s'applique à cette mesure ; placée ailleurs,
  à la mesure suivante. Une seule `meta` par mesure.
  - `beat=2` (ou `4.`…) : unité du métronome **imprimé** ; `tempo` reste en noires/min
    (`tempo=288 beat=2` imprime « blanche = 144 »).
  - `key` = nombre de dièses (positif) ou de bémols (négatif) : La majeur = 3, Mi majeur = 4, Fa majeur = -1.
  - `tempo` = noires par minute. Si la partition n'en donne pas, estimer et le dire en commentaire.
- `system K` (recommandé) : la mesure suivante commence le K-ième système **de la page imprimée** ;
  contrôlé contre `work/measures.tsv` ; `render.py --compare` s'en sert pour mettre chaque système
  de la page au-dessus de sa gravure.
- `m N` ouvre une mesure. N = numéro de mesure **dans le mouvement** (1 = première mesure ; chaque
  segment entre deux barres compte pour une mesure). Le premier numéro de chaque page est donné par
  `scores/<oeuvre>/work/measures.tsv` (voir `docs/TRANSCRIBE.md`).
  Options : `mark=X` (chiffre/lettre de répétition imprimé au-dessus), `dur=3/4` (mesure incomplète :
  levée, dernière mesure).
- Les lignes d'une mesure : `VOIX | contenu`. Voix : `S A T B` (chœur), `PR PL` (piano main droite /
  gauche). Deuxième voix sur une même portée (divisi, contrepoint au piano) : `S2 A2 T2 B2 PR2 PL2`.
  Une voix absente d'une mesure = silence de mesure (mais écrire `R` est préférable pour le chœur).
  Sans aucune ligne `PR`/`PL` dans un mouvement, la partition compilée n'a pas de piano (a cappella).
- Divisi chantés en accords simples (même rythme) : un accord `<a3 c#4>:4` dans la voix suffit.

### Solistes

Les solistes s'écrivent dans les voix `S A T B` existantes, nommées par `part` :

| Cas | Voix | En-tête |
|---|---|---|
| Soprano solo | `S` | `part S "Soprano solo"` |
| Soprano I et II | `S`, `A` | `part S "Soprano I"` + `part A "Soprano II"` |
| Alto solo | `A` | `part A "Alto solo"` |
| Alto solo **sur la portée d'alto du chœur** (« Solo »/« Tutti ») | `A` | aucun `part` ; `# Solo` / `# Tutti` en commentaire de la ligne `A` |
| Soliste sur **sa propre portée**, le chœur se taisant | la voix de son nom (`S` pour un soprano) | `part S "Soprano solo"` sur ces pages ; leurs systèmes dans `work/pages.tsv` (`staves`, `solo`) |

Le nom du soliste peut aussi figurer en commentaire. Une voix qui ne chante dans aucune mesure du
mouvement n'apparaît pas dans le MusicXML compilé.

### Page partagée entre deux mouvements

Fin d'un mouvement et début du suivant sur la même page : **deux fichiers**,
`009a.cht` (`page 9`, `movement 1`) puis `009b.cht` (`page 9`, `movement 2`). Chacun a son en-tête
complet ; les lignes `system K` gardent la numérotation de la page (009b commence à `system 2`).
`work/measures.tsv` a alors une ligne par mouvement pour cette page (systèmes dans l'ordre de la page).

## Notes

`hauteur:durée[modificateurs]`

- **Hauteur réelle (sonore)**, altérations de l'armure et accidentelles déjà appliquées :
  en La majeur, un « fa » écrit s'écrit `f#4`. `c4` = do central. Altérations : `#`, `##`, `b`, `bb`.
  - **Ténor** : la clé de sol octaviée sonne une octave plus bas que l'écrit. Un la écrit dans le 2ᵉ
    interligne (la4 écrit) s'écrit `a3`.
- Durée : `1` ronde, `2` blanche, `4` noire, `8` croche, `16`, `32` ; points : `4.`, `2..`.
- Silence `r:4` ; silence de mesure `R` ; silence invisible (remplissage d'une 2ᵉ voix) `s:4`.
- Accord : `<a3 c#4 e4>:4`.
- Modificateurs (après la durée, dans cet ordre) : `~` liaison de prolongation vers la note suivante
  de même hauteur (même à travers la barre de mesure) ; `^` point d'orgue.
  Dans un accord, `~` après la durée lie toutes les notes ; `<a3~ c#4>:2` ne lie que `a3`.
  Une liaison relie deux notes **de la même voix** (`PR` → `PR`, pas `PR2` → `PR`).
- N-olets : `{3 a3:8 b3:8 c#4:8}` = triolet (3 dans le temps de 2) ; `{6 …}`, `{5 …}` idem ;
  `{6:4 …}` donne explicitement le temps normal. Espace obligatoire après `{3`.
- Nuances optionnelles, avant la note : `!ppp !pp !p !mp !mf !f !ff !fff !sf !sfz !fz !fp !cresc !dim`
  (un soufflet : `!cresc` ou `!dim` à son début, ou rien).
- Changement de clé (piano) : jeton `clef:G`, `clef:F` (ou `clef:G8`) à sa place dans la voix ; il
  vaut jusqu'au jeton suivant, d'une mesure et d'une page à l'autre. Les hauteurs restent réelles.
- Ne s'écrivent pas : liaisons d'expression, staccatos, accents, trilles, doigtés, pédale.
- Plus de deux voix sur une portée : réduire à deux (`PR`, `PR2`) ; une note tenue sous des notes
  mobiles s'écrit en accords liés (`<b3 f#4~>:4 <d4 f#4~>:4 …`).
- Notes d'ornement (appoggiatures) : ignorées.

## Paroles

Une ligne par code déclaré (`lyrics`) sous la voix : `T.la |` (latin tel qu'imprimé, coupures
`Glo- ri- a`, `ex- cel- sis` ; deux voyelles imprimées sous une seule note s'écrivent avec `+`) ;
pour un texte en cyrillique avec sa prononciation imprimée, `T.ru |` et `T.tr |`. Une syllabe par
**attaque chantée**, dans l'ordre : on saute les silences et les notes qui continuent une liaison `~`.

- `-` en fin de syllabe : le mot continue (`i- dou`).
- `_` : la note prolonge la syllabe précédente (mélisme), pas de nouvelle syllabe.
- `+` dans une syllabe = espace affichée (élision : `в+не-`).
- `*` en tête d'une syllabe de `.tr` : syllabe **soulignée** dans la partition (accent tonique) :
  `*vié-`. Garder les apostrophes et graphies imprimées (`pout'`, `grouts'`).
- Lettres en exposant imprimées (`poutᶜʰ`) : les garder en caractères Unicode exposants.
- Un texte imprimé petit ou dans une orthographe ancienne se reconstitue avec le texte connu de
  l'œuvre (cyrillique d'avant 1918 → orthographe moderne : `ъ` final supprimé, `і`→`и`, `ѣ`→`е`).
- Les syllabes d'une mesure appartiennent aux notes de cette mesure (un mot peut se poursuivre dans la
  mesure suivante : `vni-` en fin de mesure, `vié-` au début de la suivante).
- Nombre de syllabes (y compris `_`) = nombre d'attaques chantées de la mesure — vérifié par `check.py`.

## Lecture douteuse

Toute hauteur ou durée incertaine reçoit un commentaire `# ?` (avec la cause) sur sa ligne :
`grep -n "# ?" scores/*/src/*.cht` donne la liste à relire.

## Contrôles (check.py)

Erreurs : syntaxe ; durée de chaque voix ≠ durée de la mesure ; nombre de syllabes ≠ attaques ;
liaison vers une hauteur différente (ou vers un silence) ; numéros de mesure non consécutifs entre
fichiers ; paroles sans ligne de voix ; premier numéro / nombre de mesures ≠ `work/measures.tsv`.
Avertissements : note hors tessiture (S c4–b5, A f3–e5, T c3–a4, B e2–e4) ; saut > octave dans une
voix chantée ; voix attendue sans ligne (`R` explicite) ; lignes `system` ≠ `measures.tsv` ; `meta`
de tête différente du contexte courant de la page précédente.

## Sortie (compile.py)

Parties `Soprano`, `Alto`, `Tenor` (clé de sol octaviée, hauteurs réelles), `Bass` (ou le nom donné par
`part`), `Piano` (une partie, deux portées ; voix 1-2 en haut, 5-6 en bas) ; `compile.py` n'inclut que
les voix qui chantent dans le mouvement, et le piano seulement s'il y joue. Paroles : un couplet par
code de `lyrics`, dans l'ordre, `name` = le code (`la`, `ru`), sauf `tr` → `name="translit"`
(libellés via `work.yaml` → `lyrics`). Syllabe marquée `*` préfixée de `ˈ` (U+02C8).
