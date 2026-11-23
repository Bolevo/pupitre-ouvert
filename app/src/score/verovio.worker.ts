/// <reference lib="webworker" />
// Verovio runs in a worker so layout never blocks the UI. One toolkit: the app only renders the
// followed staff as a single line (`line`).
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { flattenGlyphs } from './flatten';

type Req = { id: number; kind: 'line'; mei: string; options: Record<string, unknown> };

let tk: VerovioToolkit | null = null;
const ready = createVerovioModule().then((mod: unknown) => {
  tk = new VerovioToolkit(mod as never);
});

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    await ready;
    if (req.kind === 'line') {
      // Verovio embeds its music font for text (58 kB of base64 in every SVG) for the symbols written
      // inside words: here only the note of the tempo mark, which the line does not show. Kept only
      // if such a symbol (SMuFL's private-use characters) appears elsewhere.
      const symbols = /[\uE000-\uF8FF]/.test(req.mei.replace(/<tempo\b[\s\S]*?<\/tempo>/g, ''));
      tk!.setOptions({ ...req.options, smuflTextFont: symbols ? 'embedded' : 'none' });
      tk!.loadData(req.mei);
      postMessage({ id: req.id, ok: true, svg: flattenGlyphs(tk!.renderToSVG(1)) });
    } else postMessage({ id: req.id, ok: false, error: `unknown request ${(req as { kind: string }).kind}` });
  } catch (err) {
    postMessage({ id: req.id, ok: false, error: String(err) });
  }
};
