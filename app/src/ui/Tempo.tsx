// The tempo, as a metronome value (♩ = 120), where the music is: the score's tempo times the
// playback speed. Touch it to change it (− / +, by metronome steps) or go back to the score's.
import { useRef, useState } from 'preact/hooks';
import { movement, prefs, setRate } from '../state';
import { RATE_MAX, RATE_MIN, stepTempo, tempoAt } from '../score/info';
import { beatWords, NoteGlyph } from './Glyph';
import { now } from './now';
import { useDismiss } from './popover';

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
        aria-label={`Tempo : ${words} = ${shown}${changed ? ` (partition : ${Math.round(base)})` : ''}. Changer le tempo`}
        title="Tempo (toucher pour le changer)"
        onClick={() => setOpen(!open)}
      >
        <NoteGlyph beat={sc.beat} px={19} />
        <span class="tempo-eq">=</span>
        <span class="tempo-num">{shown}</span>
      </button>
      {open && (
        <div class="pop tempo-pop" role="dialog" aria-label="Tempo">
          <div class="pop-title">Tempo</div>
          <div class="tp-row">
            <button class="tp-step" aria-label="Plus lent" title="Plus lent" disabled={atMin} onClick={() => step(-1)}>
              −
            </button>
            <output class={`tp-val ${changed ? 'changed' : ''}`} aria-live="polite">
              <NoteGlyph beat={sc.beat} px={20} />
              <span>= {shown}</span>
            </output>
            <button class="tp-step" aria-label="Plus vite" title="Plus vite" disabled={atMax} onClick={() => step(1)}>
              +
            </button>
          </div>
          <p class="tp-ref">
            Tempo de la partition : <NoteGlyph beat={sc.beat} px={18} />
            {' '}= {Math.round(base)}
            {sc.text ? <i> · {sc.text}</i> : null}
          </p>
          {changed && (
            <p class="tp-pct">
              {Math.round(rate * 100)} % du tempo de la partition{atMin ? ' (le plus lent possible)' : atMax ? ' (le plus rapide possible)' : ''}
            </p>
          )}
          <button class="pop-action" disabled={!changed} onClick={() => setRate(1)}>
            Revenir au tempo de la partition
          </button>
        </div>
      )}
    </div>
  );
}
