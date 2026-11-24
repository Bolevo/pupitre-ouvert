import { lang } from '../i18n';

/** The pitch everything sounds at: the la above middle do (la3 in French, MIDI 69), in Hz, equal
 *  temperament. The synthesized sounds are computed from it; the recorded ones (choir, strings,
 *  piano, sung note names) are tuned to it, their recordings corrected note by note (public/sf,
 *  checked by tools/check_sf.py). Shown in the header of the voice line (ui/Lane.tsx). */
export const LA_HZ = 440;

export const midiToHz = (m: number) => LA_HZ * Math.pow(2, (m - 69) / 12);

const NAMES = ['do', 'do♯', 'ré', 'mi♭', 'mi', 'fa', 'fa♯', 'sol', 'sol♯', 'la', 'si♭', 'si'];
const LETTERS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
/** The note's name in the language shown: French (la3 = 440 Hz) or English (A4 = 440 Hz: the
 *  same note, the octaves are numbered one higher). */
export function noteName(midi: number) {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return lang.value === 'en' ? `${LETTERS[pc]}${Math.floor(m / 12) - 1}` : `${NAMES[pc]}${Math.floor(m / 12) - 2}`;
}
