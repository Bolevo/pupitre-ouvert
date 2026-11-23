// Offline use of the instrument samples (app/public/sf, app/public/audio). They are not precached
// by the service worker (7.6 MB for every instrument, most never used): the worker caches each
// file the first time the app fetches it (CacheFirst, see vite.config.ts), so an instrument used
// once online keeps working offline.
//
// On the very first visit, the instruments of the current tracks are fetched at start-up, before
// the service worker is installed and controls the page: it never sees those requests. When it
// takes control, they are requested again through it (normally answered by the HTTP cache,
// without network), so that a rehearsal started online on a new device also works offline later.

const SAMPLE = /\/(?:sf|audio)\/[^?#]+\.(?:mp3|flac|json)$/;

export function cacheEarlySamples() {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw || sw.controller) return; // already controlled: every sample request goes through it
  try {
    performance.setResourceTimingBufferSize(1000); // default 250: an instrument has up to 58 files
  } catch {
    /* ignore */
  }
  sw.addEventListener(
    'controllerchange',
    () => {
      const urls = new Set<string>();
      for (const e of performance.getEntriesByType('resource')) {
        try {
          const u = new URL(e.name);
          if (u.origin === location.origin && SAMPLE.test(u.pathname)) urls.add(u.href);
        } catch {
          /* not a URL */
        }
      }
      for (const u of urls) void fetch(u).catch(() => {});
    },
    { once: true },
  );
}
