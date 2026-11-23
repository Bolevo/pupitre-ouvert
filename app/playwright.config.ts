import { defineConfig } from '@playwright/test';
// PW_PORT: several checkouts can run their e2e at the same time, each on its own port
const port = Number(process.env.PW_PORT) || 4180;

const chromiumLaunch = {
  executablePath: process.env.PW_CHROMIUM || undefined,
  // a UTF-8 locale: under the C locale Chromium names a download with accents « download »
  env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } as Record<string, string>,
  // a fake microphone (a beeping tone) granted without a prompt: « Enregistrer ma voix »
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
};

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/setup.ts', // the archives the tests add to the app
  // on GitHub: failures as annotations of the run (readable without downloading the logs), one retry
  // to tell a flaky timing on the shared runner from a real failure
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined, // the tests play music and watch its timing
  webServer: { command: `npx vite preview --port ${port} --strictPort`, port, reuseExistingServer: true },
  use: { baseURL: `http://localhost:${port}/` },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, launchOptions: chromiumLaunch } }],
});
