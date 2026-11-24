// « Copier où j'en suis »: a small button beside the work's sheet. One press puts in the clipboard
// where one is in the score (score/where.ts), to paste to one's AI when a note sounds wrong: it
// knows at once which work, which measure, which page, and what the archive holds there.
import { useEffect, useRef, useState } from 'preact/hooks';
import { movement, myPart, position, work } from '../state';
import { placeAt, whereText } from '../score/where';
import { copyText } from '../util/clipboard';
import { Icon } from './Icon';
import { tt } from '../i18n';

export function WhereButton() {
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const w = work.value;
  const mv = movement.value;
  if (!w || !mv) return null;
  const copy = async () => {
    const t = position() + 30; // on a barline: the measure that starts
    const { n, page } = placeAt(w.pack, mv, t);
    const ok = await copyText(whereText(w.pack, mv, t, myPart.value));
    const text = !ok ? tt('Copie impossible dans ce navigateur.') : page === null ? tt('Copié : mesure {n}. À coller à votre IA.', { n }) : tt('Copié : mesure {n}, page {page}. À coller à votre IA.', { n, page });
    setSaid({ text, ok });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid(null), 4000);
  };
  return (
    <div class="where">
      <button class="where-btn" aria-label={tt('Copier où j’en suis')} title={tt('Copier où j’en suis (œuvre, mesure, page, notes) : à coller à votre IA pour lui signaler une erreur')} onClick={() => void copy()}>
        <Icon name={said?.ok ? 'check' : 'copy'} size={18} />
      </button>
      {said && (
        <div class="where-hint" role="status">
          {said.text}
        </div>
      )}
    </div>
  );
}
