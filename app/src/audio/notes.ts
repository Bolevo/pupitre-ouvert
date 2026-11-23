/** The pitch everything sounds at: the la above middle do (la3 in French, MIDI 69), in Hz, equal
 *  temperament. The synthesized sounds are computed from it; the recorded ones (choir, strings,
 *  piano, sung note names) are tuned to it, their recordings corrected note by note (public/sf,
 *  checked by tools/check_sf.py). Shown in the header of the voice line (ui/Lane.tsx). */
export const LA_HZ = 440;

export const midiToHz = (m: number) => LA_HZ * Math.pow(2, (m - 69) / 12);

const NAMES = ['do', 'do♯', 'ré', 'mi♭', 'mi', 'fa', 'fa♯', 'sol', 'sol♯', 'la', 'si♭', 'si'];
/** French note name, la3 = 440 Hz. */
export function noteName(midi: number) {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`;
}
