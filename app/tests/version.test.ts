// « Version » in the track list: what the build writes in index.html (vite-version.ts) and what the
// app reads back from it (src/version.ts).
import { describe, expect, it } from 'vitest';
import { readVersion, versionLabel } from '../src/version';
import { describeVersion } from '../vite-version';

const NOW = new Date('2026-11-10T09:30:00.000Z');
const SHA = '8e96241170f8f31aa7c54b72534461204263a2a3';

describe('the version written at build time', () => {
  it('a clean checkout: the short commit and its date', () => {
    expect(describeVersion({ sha: SHA, date: '2026-11-10T07:55:12+00:00', dirty: false }, NOW)).toBe('8e96241 2026-11-10T07:55:12+00:00');
  });
  it('files modified since the commit: a « + », and the date of the build', () => {
    expect(describeVersion({ sha: SHA, date: '2026-11-10T07:55:12+00:00', dirty: true }, NOW)).toBe('8e96241+ 2026-11-10T09:30:00.000Z');
  });
  it('outside git (a plain copy of the files): no commit, the date of the build', () => {
    expect(describeVersion({ sha: null, date: null, dirty: false }, NOW)).toBe('- 2026-11-10T09:30:00.000Z');
  });
  it('a commit known without its date (from the environment): the date of the build', () => {
    expect(describeVersion({ sha: SHA, date: null, dirty: false }, NOW)).toBe('8e96241 2026-11-10T09:30:00.000Z');
  });
});

describe('the version the app shows', () => {
  it('the commit, and its date in the time of the device', () => {
    const v = readVersion('8e96241 2026-11-10T07:55:12+00:00', 'Europe/Paris');
    expect(v).toEqual({ name: '8e96241', when: '10/11/2026 08:55' });
    expect(versionLabel(v!)).toBe('Version 8e96241 · 10/11/2026 08:55');
    expect(readVersion('8e96241 2026-11-10T07:55:12+00:00', 'UTC')!.when).toBe('10/11/2026 07:55');
    // midnight is 00, not 24
    expect(readVersion('8e96241 2026-11-10T00:05:00+01:00', 'Europe/Paris')!.when).toBe('10/11/2026 00:05');
  });
  it('reads back what the build writes', () => {
    expect(versionLabel(readVersion(describeVersion({ sha: SHA, date: '2026-07-01T22:30:00+02:00', dirty: false }, NOW), 'Europe/Paris')!)).toBe('Version 8e96241 · 01/07/2026 22:30');
    expect(versionLabel(readVersion(describeVersion({ sha: SHA, date: null, dirty: true }, NOW), 'UTC')!)).toBe('Version 8e96241+ · 10/11/2026 09:30');
    expect(versionLabel(readVersion(describeVersion({ sha: null, date: null, dirty: false }, NOW), 'UTC')!)).toBe('Version locale · 10/11/2026 09:30');
  });
  it('no date, or one that cannot be read: the commit alone', () => {
    expect(versionLabel(readVersion('8e96241')!)).toBe('Version 8e96241');
    expect(versionLabel(readVersion('8e96241 yesterday')!)).toBe('Version 8e96241');
  });
  it('a page that says nothing: no version shown', () => {
    expect(readVersion(null)).toBeNull();
    expect(readVersion(undefined)).toBeNull();
    expect(readVersion('  ')).toBeNull();
  });
});
