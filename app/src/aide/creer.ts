// The page « Créer l'archive » (creer.html, create.html in English): the sentence to give to an AI
// is copied in one touch.
const en = document.documentElement.lang === 'en';
const button = document.getElementById('copier') as HTMLButtonElement | null;
const phrase = document.getElementById('phrase');
if (button && phrase) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    const text = (phrase.textContent ?? '').replace(/\s+/g, ' ').trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = en ? 'Copied' : 'Copiée';
    } catch {
      // no clipboard (an old browser, a page not served over https): the sentence is selected instead
      const range = document.createRange();
      range.selectNodeContents(phrase);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      button.textContent = en ? 'Selected: copy it' : 'Sélectionnée : copiez-la';
    }
    setTimeout(() => (button.textContent = label), 2500);
  });
}
