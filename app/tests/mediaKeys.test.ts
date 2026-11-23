import { describe, expect, it } from 'vitest';
import { silentWav } from '../src/mediaKeys';

describe('the silent media that holds the headset buttons', () => {
  it('is a valid 10 s WAV of pure silence (8 kHz, 16-bit, the most widely read form)', async () => {
    const b = new Uint8Array(await silentWav().arrayBuffer());
    const txt = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
    expect([txt(0), txt(8), txt(12), txt(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    const v = new DataView(b.buffer);
    expect([v.getUint32(24, true), v.getUint16(34, true), v.getUint16(32, true)]).toEqual([8000, 16, 2]);
    expect(v.getUint32(40, true)).toBe(160000); // 10 s: media sessions ignore very short media
    expect(b.length).toBe(44 + 160000);
    expect(b.subarray(44).every((x) => x === 0)).toBe(true);
  });
});
