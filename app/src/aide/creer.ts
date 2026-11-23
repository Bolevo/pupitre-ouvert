// The page « Créer l'archive » (creer.html): the sentence to give to an AI is copied in one touch.
const button = document.getElementById('copier') as HTMLButtonElement | null;
const phrase = document.getElementById('phrase');
if (button && phrase) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    const text = (phrase.textContent ?? '').replace(/\s+/g, ' ').trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copiée';
    } catch {
      // no clipboard (an old browser, a page not served over https): the sentence is selected instead
      const range = document.createRange();
      range.selectNodeContents(phrase);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      button.textContent = 'Sélectionnée : copiez-la';
    }
    setTimeout(() => (button.textContent = label), 2500);
  });
}
