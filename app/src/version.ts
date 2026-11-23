// Which version of the app is running on this device: the commit it was built from and when, as
// index.html carries it (written at build time: vite-version.ts). Shown, small, in the footer of
// the track list.

export interface AppVersion {
  /** the commit, 7 characters (« 8e96241 ») ; with a « + » when the app was built with changes not
   *  committed ; « locale » when it was built outside git */
  name: string;
  /** « 10/11/2026 08:55 », in the device's time: the commit's date, or the build's (« + », locale);
   *  '' when unknown */
  when: string;
}

/** From the content of the page's <meta name="pupitre-version">
 *  ("8e96241 2026-11-10T07:55:12+00:00"); null when the page says nothing. */
export function readVersion(content: string | null | undefined, timeZone?: string): AppVersion | null {
  const [commit, iso] = (content ?? '').trim().split(/\s+/);
  if (!commit) return null;
  const name = commit === '-' ? 'locale' : commit;
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return { name, when: '' };
  // put together by hand: the separators of a formatted date and time vary between browsers
  const p: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(d)) p[type] = value;
  return { name, when: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` };
}

/** « Version 8e96241 · 10/11/2026 08:55 » */
export const versionLabel = (v: AppVersion): string => `Version ${v.name}${v.when ? ` · ${v.when}` : ''}`;

/** The version of the page that is running (null in a page without the <meta>). */
export const appVersion = (): AppVersion | null => (typeof document === 'undefined' ? null : readVersion(document.querySelector('meta[name="pupitre-version"]')?.getAttribute('content')));
