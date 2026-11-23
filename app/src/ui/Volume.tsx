import { hasVolume, prefs, setVolume } from '../state';

/** A slider moved with the mouse or a finger gives the keyboard back: the space bar plays again,
 *  the arrows go from measure to measure (a slider reached with Tab keeps them, to be set). */
export const releaseFocus = (e: PointerEvent) => (e.currentTarget as HTMLElement).blur();

/** The general volume, on computers only (state.ts › hasVolume): with the track list's button on a
 *  wide screen, in the list's header in the phone layout (a narrow window). In words: the
 *  loudspeaker is « Entendre » (my voice), just below. */
export function Volume() {
  if (!hasVolume.value) return null;
  const v = prefs.value.volume ?? 1;
  return (
    <label class="volume" title={`Volume général : ${Math.round(v * 100)} %`}>
      <span>Volume</span>
      <input type="range" min={0} max={1} step={0.01} value={v} aria-label="Volume général" onInput={(e) => setVolume(+(e.target as HTMLInputElement).value)} onPointerUp={releaseFocus} />
    </label>
  );
}
