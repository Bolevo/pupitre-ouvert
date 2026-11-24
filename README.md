# Pupitre Ouvert

*[English](README.en.md)*

Apprendre sa partie de chœur avec **sa propre partition** : suivre les pages, écouter les voix
ensemble ou séparément, voir défiler sa ligne, apprendre le texte, s'enregistrer.

- **L'app** : <https://bolevo.github.io/pupitre-ouvert/> — gratuite, sans compte, hors ligne une
  fois ouverte, sur téléphone et ordinateur. Elle s'ouvre sur deux exemples : le *Locus iste* de
  Bruckner et le Kyrie de la Messe en sol de Schubert, d'après des éditions anciennes numérisées.
- **L'aide** : <https://bolevo.github.io/pupitre-ouvert/aide.html>
- **Ajouter votre partition** : il faut en faire une archive `.zip`. Une IA qui exécute du code
  sait le faire à partir de votre PDF ou de vos photos :
  <https://bolevo.github.io/pupitre-ouvert/creer.html>

Vos partitions restent sur votre appareil : rien n'est envoyé. L'app est en français ou en
anglais (Réglages).

## Pour une IA (ou quiconque fabrique une archive)

| | |
|---|---|
| La méthode, de la partition numérisée à l'archive ; corriger une archive | [`docs/CREER.md`](docs/CREER.md) |
| Ce que contient une archive, et le dossier d'œuvre | [`docs/ARCHIVE.md`](docs/ARCHIVE.md) |
| Lire une page et l'écrire | [`docs/TRANSCRIBE.md`](docs/TRANSCRIBE.md), [`docs/CHT_FORMAT.md`](docs/CHT_FORMAT.md) |
| Deux dossiers d'œuvre complets, de la numérisation à l'archive | [`scores/locus-iste/`](scores/locus-iste), [`scores/schubert-kyrie/`](scores/schubert-kyrie) |

```
pip install -r pipeline/requirements.txt
python pipeline/publish.py locus-iste        # -> packs/locus-iste.zip   OK
```

## Pour qui veut lire ou changer le code

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) décrit l'app (`app/`, Preact + TypeScript), le
pipeline (`pipeline/`, Python) et les outils (`tools/`), et dit comment construire et tester.
[`AGENTS.md`](AGENTS.md) donne les règles du dépôt. Les signalements et les propositions sont les
bienvenus : [issues](https://github.com/Bolevo/pupitre-ouvert/issues), pull requests.

## D'où cela vient

Pupitre a été créé par Alexis Michenaud-Rague pour son chœur, et développé avec Claude,
l'intelligence artificielle d'Anthropic, et ses agents. Pupitre Ouvert en est la version ouverte :
la même app, sans les partitions du chœur, où chacun apporte les siennes. Projet gratuit, sans but
commercial.

## Licence

Le code, les outils et les documents de ce dépôt sont sous licence [MIT](LICENSE). Les
bibliothèques, sons et polices livrés avec l'app gardent leurs propres licences :
[`NOTICE.md`](NOTICE.md) (les sons du « nom des notes » sont réservés à un usage non commercial).
