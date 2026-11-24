# Pupitre Ouvert — icône « La feuille »

**L'idée.** Pupitre, c'est la nuit ; Pupitre Ouvert, c'est la page. La partition que l'on apporte
est une feuille de papier clair, au coin corné, posée sur la portée de Pupitre qui dépasse des deux
côtés ; la croche y est imprimée à l'encre bleu nuit.

**Ce qui rappelle Pupitre.** La même croche, trait pour trait et à la même taille (tête, hampe,
crochet doré), la même portée pâle, le même fond bleu nuit.

**Ce qui l'en distingue.** La feuille claire : les deux icônes se séparent d'un coup d'œil sur un
écran d'accueil, même à 48 px.

**Palette.** Bleu nuit `#1f2a44` (fond, encre), papier `#f5f3ee` (feuille, portée), or `#e8b44a`
(crochet), gris `#b5b7bb` (le coin corné) — rien d'autre.

**Écartées.** « Sur le pupitre » (une partition ouverte sur un pupitre : le nom dessiné, mais trop
d'éléments à 48 px), « La partition ouverte » (un livre ouvert : dit « recueil » plus que « la
mienne »), « Le plus » (un plus doré au coin : se lit aussi comme une version payante).

**Fichiers.** `app/public/icon.svg` → `icon-192.png`, `icon-512.png` ; `icon-maskable.svg` (plein
cadre, tout le dessin dans le cercle de sécurité) → `icon-maskable-512.png` ;
`apple-touch-icon.svg` (plein cadre) → `apple-touch-icon.png`.

**Refaire les PNG** (depuis la racine du dépôt, avec `rsvg-convert`) :

```
rsvg-convert -w 192 app/public/icon.svg -o app/public/icon-192.png
rsvg-convert -w 512 app/public/icon.svg -o app/public/icon-512.png
rsvg-convert -w 512 tools/icon/icon-maskable.svg -o app/public/icon-maskable-512.png
rsvg-convert -w 180 tools/icon/apple-touch-icon.svg -o app/public/apple-touch-icon.png
```
