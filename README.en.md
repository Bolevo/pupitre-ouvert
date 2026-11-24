# Pupitre Ouvert

*[Français](README.md)*

Learn your choir part with **your own score**: follow the pages, hear the voices together or one
by one, watch your line scroll, learn the text, record yourself.

- **The app**: <https://bolevo.github.io/pupitre-ouvert/?lang=en> — free, no account, offline once
  opened, on phones and computers. It opens on two examples: Bruckner's *Locus iste* and the Kyrie
  of Schubert's Mass in G, from scanned old editions. In French or in English (Settings).
- **The help**: <https://bolevo.github.io/pupitre-ouvert/help.html>
- **Adding your score**: it has to be made into a `.zip` archive. An AI that runs code can do it
  from your PDF or your photos: <https://bolevo.github.io/pupitre-ouvert/create.html>

Your scores stay on your device: nothing is sent.

## For an AI (or anyone making an archive)

| | |
|---|---|
| The method, from the scanned score to the archive | [`docs/CREATE.md`](docs/CREATE.md) (French: [`docs/CREER.md`](docs/CREER.md)) |
| What an archive holds, and the work folder | [`docs/ARCHIVE.md`](docs/ARCHIVE.md) (in French) |
| Reading a page and writing it down | [`docs/TRANSCRIBE.md`](docs/TRANSCRIBE.md), [`docs/CHT_FORMAT.md`](docs/CHT_FORMAT.md) (in French) |
| Two complete work folders, from the scan to the archive | [`scores/locus-iste/`](scores/locus-iste), [`scores/schubert-kyrie/`](scores/schubert-kyrie) |

```
pip install -r pipeline/requirements.txt
python pipeline/publish.py locus-iste        # -> packs/locus-iste.zip   OK
```

## For those who want to read or change the code

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (in French) describes the app (`app/`, Preact +
TypeScript), the pipeline (`pipeline/`, Python) and the tools (`tools/`), and says how to build and
test. [`AGENTS.md`](AGENTS.md) gives the rules of the repository. Code, identifiers, comments and
commits are in English. Reports and proposals are welcome:
[issues](https://github.com/Bolevo/pupitre-ouvert/issues), pull requests.

## Where it comes from

Pupitre was created by Alexis Michenaud-Rague for his choir, and developed with Claude,
Anthropic's artificial intelligence, and its agents. Pupitre Ouvert is its open version: the same
app, without the choir's scores, where everyone brings their own. A free, non-commercial project.

## Licence

The code, the tools and the documents of this repository are under the [MIT licence](LICENSE).
The libraries, sounds and fonts delivered with the app keep their own licences:
[`NOTICE.md`](NOTICE.md) (the “note names” sounds are for non-commercial use only).
