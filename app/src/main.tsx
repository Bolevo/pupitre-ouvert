import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './fonts.css'; // Tinos, the score's text (see there)
import './styles.css';
import { boot, booted, error, ficheOpen, hiddenExamples, libraryOpen, restoreExamples, setTracksOpen, sideView, tracksOpen, work } from './state';
import { PageView } from './ui/PageView';
import { Lane } from './ui/Lane';
import { HelpLink, pickZip, TopBar, Transport } from './ui/Bars';
import { Tracks } from './ui/Tracks';
import { RecPanel } from './ui/Rec';
import { Fiche } from './ui/Fiche';
import { Library } from './ui/Library';
import { startNow } from './ui/now';
import { startMediaKeys } from './mediaKeys';
import { startInsetScale } from './ui/insets';
import { tt } from './i18n';

startInsetScale(); // before the first render: the bars clear of the status bar from the start

// only the scanned pages zoom (the app does it, see PageView): the browser must not zoom the whole
// screen (iOS Safari ignores user-scalable=no, its own pinch gesture is cancelled here)
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

function App() {
  useEffect(() => {
    void boot();
    const stopNow = startNow(); // the measure being played, for the navigator, the line's header, the tempo
    const stopKeys = startMediaKeys(); // the headset's play/pause button
    // keep the screen awake during practice
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        lock = (await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request('screen')) ?? null;
      } catch {
        /* unsupported */
      }
    };
    void req();
    const onVis = () => document.visibilityState === 'visible' && void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopNow();
      stopKeys();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    // side-…, fiche-open: what a phone lying down shows between the bars (styles.css)
    <div class={`app side-${sideView.value}${ficheOpen.value ? ' fiche-open' : ''}`} onContextMenu={(e) => (e.target as HTMLElement).closest('input') || e.preventDefault()}>
      <TopBar />
      {/* « Mes partitions » open: it says itself what went wrong (it covers this line) */}
      {error.value && !libraryOpen.value && (
        <div class="error" role="alert">
          {error.value}
          <button class="ctl wide" onClick={() => (error.value = null)}>
            {tt('Fermer')}
          </button>
        </div>
      )}
      {work.value ? (
        <>
          <div class="stage">
            <PageView />
            {ficheOpen.value && <Fiche />}
            <HelpLink />
          </div>
          <div class={`deck ${tracksOpen.value ? 'tracks-open' : ''}`}>
            <Tracks onClose={() => setTracksOpen(false)} />
            <Lane />
          </div>
          <Transport />
          <RecPanel />
        </>
      ) : (
        <div class="loading">
          {!booted.value ? (
            tt('Chargement de la partition…')
          ) : (
            <>
              <p>{tt('Aucune partition dans cette app pour l’instant.')}</p>
              <button class="ctl wide" onClick={() => pickZip()}>
                {tt('Ajouter une partition (.zip)')}
              </button>
              {hiddenExamples.value.length > 0 && (
                <button class="ctl wide" onClick={() => void restoreExamples()}>
                  {tt('Remettre les exemples')}
                </button>
              )}
              <p>
                <HelpLink text={tt('Comment se servir de Pupitre Ouvert ?')} />
              </p>
            </>
          )}
        </div>
      )}
      {libraryOpen.value && <Library />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
