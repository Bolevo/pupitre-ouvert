# Ce que Pupitre Ouvert utilise, et sous quelles licences

Pupitre Ouvert lui-même (le code, les outils, les documents de ce dépôt) est sous licence MIT :
[`LICENSE`](LICENSE). Ce qui suit vient d'ailleurs et garde sa propre licence : des fichiers
livrés avec l'app et utilisés sur l'appareil ; aucun service en ligne.

| Bibliothèque ou fichier | Sert à | Licence |
|---|---|---|
| [Verovio](https://www.verovio.org) | dessiner la ligne de la voix ; MusicXML → MEI dans le pipeline | LGPL 3.0 ou ultérieure |
| Preact, Preact Signals | l'interface | MIT |
| fflate | ouvrir les fichiers .zip | MIT |
| idb-keyval | garder les données sur l'appareil | Apache 2.0 |
| Workbox (vite-plugin-pwa) | le fonctionnement hors ligne | MIT |
| Atkinson Hyperlegible, Tinos | les polices de caractères | SIL OFL 1.1 |
| Salamander Grand Piano V3 (Alexander Holm) — `app/public/audio/piano` | le piano | CC BY 3.0 |
| MuseScore General (S. Christian Collins, d'après FluidR3 de Frank Wen) — `app/public/sf/aahs`, `strings` | le chœur « ah », les cordes | MIT |
| Voix MBROLA fr1 (Faculté polytechnique de Mons) et fr4 (Babel Technologies) — `app/public/sf/solfege` | le nom des notes (sons produits avec MBROLA et le vocodeur WORLD) | **usage non commercial** |
| A. Bruckner, *Locus iste* (WAB 23) : première édition, Th. Rättig, Vienne, 1886 ; numérisation [IMSLP n° 437277](https://imslp.org/wiki/Locus_iste,_WAB_23_(Bruckner,_Anton)) — `scores/locus-iste` | l'œuvre d'exemple a cappella | domaine public |
| F. Schubert, Messe en sol majeur D 167, Kyrie : réduction pour piano de B. Tours, Novello, Londres ; numérisation [IMSLP n° 974289](https://imslp.org/wiki/Mass_in_G_major,_D.167_(Schubert,_Franz)) — `scores/schubert-kyrie` | l'œuvre d'exemple avec soliste et piano | domaine public |
| Corpus [music21](https://github.com/cuthbertLab/music21) | deux chorals de Bach, pour les tests (`pipeline/tests/deux-chorals`) | domaine public |
| music21, OpenCV, NumPy, CairoSVG, pypdfium2, Pillow, PyYAML | les outils (`pipeline/`, `tools/`) | BSD, Apache 2.0, LGPL (CairoSVG), HPND (Pillow), MIT |

Les sons du nom des notes ne peuvent pas servir à un usage commercial : une réutilisation
commerciale de l'app devrait les remplacer.
