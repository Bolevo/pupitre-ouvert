# Pupitre Ouvert — icône « La portée s’ouvre »
**L’idée.** La portée de Pupitre, serrée à gauche, s’ouvre vers la droite comme un soufflet de crescendo — ou les pages d’un livre qu’on écarte — et accueille une ronde, la note « ouverte » : chacun vient y poser la sienne.
**Ce qui rappelle la première.** Les mêmes ingrédients (cinq lignes, une note, l’accent d’or en haut à droite) et la même palette ; à gauche, les cinq lignes reprennent exactement les hauteurs de la portée de Pupitre (interligne 40).
**Ce qui l’en distingue.** Le jour après la nuit : fond papier au lieu du fond marine, pleins et déliés au lieu du trait uniforme, une ronde sans hampe au lieu de la croche ; les deux se séparent d’un coup d’œil, même à 48 px.
**Palette.** Papier `#f5f3ee` (fond), marine `#1f2a44` (portée), or `#e8b44a` (ronde) — rien d’autre.
**Écartée — « La blanche ».** Une grande blanche marine traversée d’une ligne d’or : la silhouette la plus forte à 48 px, mais une note de plus parmi tant d’icônes musicales, et son « ouvert » ne parle qu’aux solfégistes.
**Écartée — « Le livre ouvert ».** Une blanche qui pousse hors d’un livre ouvert : l’image est anecdotique, la portée disparaît et la note devient minuscule à 48 px.
**Variante gardée sous le coude.** La même portée sortant d’une bande marine, en contre-forme — plus affiche, moins légère.
**Fichiers.** `app/public/icon.svg` → `icon-192.png`, `icon-512.png` ; `icon-maskable.svg` (signe à 77,5 %, dans le cercle de sécurité) → `icon-maskable-512.png` ; `apple-touch-icon.svg` (signe à 92 %) → `apple-touch-icon.png`.

**Refaire les PNG** (depuis la racine du dépôt, avec `rsvg-convert`) :

```
rsvg-convert -w 192 app/public/icon.svg -o app/public/icon-192.png
rsvg-convert -w 512 app/public/icon.svg -o app/public/icon-512.png
rsvg-convert -w 512 tools/icon/icon-maskable.svg -o app/public/icon-maskable-512.png
rsvg-convert -w 180 tools/icon/apple-touch-icon.svg -o app/public/apple-touch-icon.png
```
