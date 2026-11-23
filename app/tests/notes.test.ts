import { describe, expect, it } from 'vitest';
import { LA_HZ, midiToHz, noteName } from '../src/audio/notes';

describe('the pitch of the sounds', () => {
  it('the la above middle do sounds at 440 Hz, the other notes in equal temperament from it', () => {
    expect(LA_HZ).toBe(440); // shown in the header of the voice line: « la 440 Hz »
    expect(noteName(69)).toBe('la3');
    expect(midiToHz(69)).toBe(LA_HZ);
    expect(midiToHz(57)).toBeCloseTo(LA_HZ / 2, 9); // an octave lower
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3); // middle do
    expect(midiToHz(70) / midiToHz(69)).toBeCloseTo(2 ** (1 / 12), 12); // a semitone
  });
});
