// The tempo, as a metronome value (♩ = 120), where the music is: the score's tempo times the
// playback speed. Touch it to change it (− / +, by metronome steps) or go back to the score's.
import { useRef, useState } from 'preact/hooks';
import { movement, prefs, setRate } from '../state';
import { RATE_MAX, RATE_MIN, stepTempo, tempoAt } from '../score/info';
import { beatWords, NoteGlyph } from './Glyph';
import { now } from './now';
import { useDismiss } from './popover';
import { tt } from '../i18n';

const EPS = 1e-4;

export function TempoControl() {
  const mv = movement.value;
  const n = now.value;
  const i = n.mv === mv ? n.i : 0;
  const rate = prefs.value.rate || 1;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  if (!mv) return null;
  const sc = tempoAt(mv, i);
  const base = sc.bpm / sc.beat; // the score's value, in its beat unit
  const shown = Math.round(base * rate);
  const changed = Math.abs(rate - 1) > EPS;
  const words = beatWords(sc.beat);
  const step = (dir: 1 | -1) => setRate(stepTempo(base * rate, dir, base) / base);
  const atMin = rate <= RATE_MIN + EPS;
  const atMax = rate >= RATE_MAX - EPS;
  return (
    <div class="tempo-box" ref={box}>
      <button
        class={`tempo-btn ${changed ? 'changed' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={changed ? tt('Tempo : {note} = {n} (partition : {base}). Changer le tempo', { note: words, n: shown, base: Math.round(base) }) : tt('Tempo : {note} = {n}. Changer le tempo', { note: words, n: shown })}
        title={tt('Tempo (toucher pour le changer)')}
        onClick={() => setOpen(!open)}
      >
        <NoteGlyph beat={sc.beat} px={19} />
        <span class="tempo-eq">=</span>
        <span class="tempo-num">{shown}</span>
      </button>
      {open && (
        <div class="pop tempo-pop" role="dialog" aria-label={tt('Tempo')}>
          <div class="pop-title">{tt('Tempo')}</div>
          <div class="tp-row">
            <button class="tp-step" aria-label={tt('Plus lent')} title={tt('Plus lent')} disabled={atMin} onClick={() => step(-1)}>
              −
            </button>
            <output class={`tp-val ${changed ? 'changed' : ''}`} aria-live="polite">
              <NoteGlyph beat={sc.beat} px={20} />
              <span>= {shown}</span>
            </output>
            <button class="tp-step" aria-label={tt('Plus vite')} title={tt('Plus vite')} disabled={atMax} onClick={() => step(1)}>
              +
            </button>
          </div>
          <p class="tp-ref">
            {tt('Tempo de la partition :')} <NoteGlyph beat={sc.beat} px={18} />
            {' '}= {Math.round(base)}
            {sc.text ? <i> · {sc.text}</i> : null}
          </p>
          {changed && (
            <p class="tp-pct">
              {tt('{n} % du tempo de la partition', { n: Math.round(rate * 100) })}
              {atMin ? ` ${tt('(le plus lent possible)')}` : atMax ? ` ${tt('(le plus rapide possible)')}` : ''}
            </p>
          )}
          <button class="pop-action" disabled={!changed} onClick={() => setRate(1)}>
            {tt('Revenir au tempo de la partition')}
          </button>
        </div>
      )}
    </div>
  );
}
