import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { verovioWasm } from './vite-verovio-wasm.ts';
import { appVersion } from './vite-version.ts';
import { creerPage } from './vite-creer.ts';

export default defineConfig({
  base: './',
  plugins: [
    preact(),
    appVersion(), // the commit the app is built from, in index.html (« Version » in the track list)
    creerPage(), // creer.html and create.html carry the method of docs/CREER.md and docs/CREATE.md
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        // the instrument samples (sf/, audio/: 7.6 MB) are not precached: each file is cached the
        // first time it is used (runtimeCaching below; src/offline.ts covers the very first visit)
        globPatterns: ['**/*.{js,css,html,svg,json,mei,md,wasm,webp,woff2}'], // md: the works' sheets (fiche.md)
        // packs/index.json (the list of the works that come with the app) is not precached either: from the
        // precache, a new deployment's works would only be seen one launch later (NetworkFirst below)
        globIgnores: ['sf/**', 'audio/**', 'packs/index.json'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/packs\/index\.json$/,
            handler: 'NetworkFirst',
            options: { cacheName: 'pupitre-ouvert-index', networkTimeoutSeconds: 5, cacheableResponse: { statuses: [200] } },
          },
          {
            urlPattern: /\/(?:sf|audio)\/[^?#]+\.(?:mp3|flac|json)$/,
            handler: 'CacheFirst',
            options: {
              // named after the samples' content: changed samples (same file names) go to a new
              // cache instead of being served stale forever by CacheFirst
              cacheName: `pupitre-ouvert-samples-${samplesHash()}`,
              expiration: { maxEntries: 400 }, // 185 files today; no expiry by age
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Pupitre Ouvert — apprendre sa partie, avec ses propres partitions',
        short_name: 'Pupitre Ouvert',
        description: 'Suivre la partition, entendre sa voix, mémoriser et chanter juste.',
        lang: 'fr',
        start_url: './',
        display: 'standalone',
        background_color: '#f5f3ee',
        theme_color: '#2a2c31', // the top bar
        // PNG for launchers that need them (Android, Lighthouse); the maskable one is full-bleed (the
        // SVG's rounded corners would show under a launcher's mask), its drawing inside the safe circle
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  // Verovio's WebAssembly (6.8 MB) is taken out of its script into a .wasm file, compiled while it
  // downloads (see vite-verovio-wasm.ts)
  worker: {
    format: 'es',
    plugins: () => [verovioWasm()],
    // The workers keep the same address from one version to the next (no hash in their name; the
    // service worker tells their versions apart by content: they are outside assets/, whose files
    // it takes for named by content). The page starts workers long after it was loaded (the
    // Verovio and resampling workers stop when idle), possibly after a new version has replaced
    // the files of the one it came from: a hashed name would then be gone (404).
    rolldownOptions: { output: { entryFileNames: 'workers/[name].js' } },
  },
  build: {
    target: 'es2022',
    // the app, its help (aide.html) and how to make the archive of a score (creer.html), the last
    // two also in English (help.html, create.html)
    rolldownOptions: { input: { main: 'index.html', aide: 'aide.html', creer: 'creer.html', help: 'help.html', create: 'create.html' } },
  },
  server: { host: true },
  preview: { host: true },
});

// --- service worker: name of the samples cache (imports are hoisted: kept here, next to their use)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Short hash of the instrument samples (public/sf, public/audio): names their runtime cache. */
function samplesHash(): string {
  const h = createHash('sha256');
  const walk = (rel: string) => {
    const dir = fileURLToPath(new URL(`public/${rel}`, import.meta.url));
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) walk(`${rel}${e.name}/`);
      else h.update(rel + e.name).update(readFileSync(dir + e.name));
    }
  };
  walk('sf/');
  walk('audio/');
  return h.digest('hex').slice(0, 8);
}
