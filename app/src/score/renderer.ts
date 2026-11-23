// Promise wrapper around the Verovio worker. The app renders one thing: the followed staff as a
// single endless line (the printed pages are photos, see PageView).

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void };

// The worker is ended after a while without a render and started again for the next one: idle, it
// holds Verovio's compiled code and memory (about 40 MB). Starting it again is not free: +0.9 s
// before the next line in a phone-like Chromium (CPU ÷ 4), measured 11/2026; and the next render
// comes when the user changes movement, followed voice, line size or lyrics, often after minutes on
// a movement. So: in the background (app hidden: memory matters there, the system may close a page
// that holds much) after a minute; on screen, after ten.
const IDLE_MS = 600_000;
const HIDDEN_IDLE_MS = 60_000;

class Renderer {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private idle: ReturnType<typeof setTimeout> | undefined;

  private start(): Worker {
    const w = new Worker(new URL('./verovio.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error));
      if (!this.pending.size) this.idleSoon();
    };
    // a worker that dies (out of memory on a phone, script not loaded) must not leave the line
    // waiting forever; the next render starts a new one
    w.onerror = (e) => this.fail(new Error(e.message || 'verovio worker error'));
    w.onmessageerror = () => this.fail(new Error('verovio worker: message error'));
    return (this.worker = w);
  }

  private idleSoon() {
    clearTimeout(this.idle);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.idle = setTimeout(() => this.pending.size || this.stop(), hidden ? HIDDEN_IDLE_MS : IDLE_MS);
  }

  /** The app went to the background or came back: the idle delay that applies changes. */
  visibilityChanged() {
    if (this.worker && !this.pending.size) this.idleSoon();
  }

  private stop() {
    this.worker?.terminate();
    this.worker = null;
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.stop();
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    clearTimeout(this.idle);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.worker ?? this.start()).postMessage({ ...msg, id });
    });
  }

  /** Starts the worker ahead of a render that is coming (the next movement, after the breath). */
  warm() {
    if (!this.worker) this.start();
    if (!this.pending.size) this.idleSoon();
  }

  /** Whole movement on a single horizontal line. */
  async line(mei: string, options: Record<string, unknown>): Promise<string> {
    return (await this.call<{ svg: string }>({ kind: 'line', mei, options })).svg;
  }
}

let instance: Renderer | null = null;
export const renderer = () => {
  if (!instance) {
    instance = new Renderer();
    const r = instance;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => r.visibilityChanged());
  }
  return instance;
};

/** Options for the scrolling lane: one endless system. Several staves (the piano's grand staff)
 *  are drawn smaller and closer; `compact` (phones): about the height of one voice with lyrics. */
export function lineOptions(scale: number, staves = 1, compact = false) {
  const multi = staves > 1;
  return {
    scale: multi ? Math.round(scale * (compact ? 0.62 : 0.72)) : scale,
    ...(multi ? { spacingStaff: 4 } : {}),
    breaks: 'none',
    pageHeight: 3000,
    pageWidth: 100000,
    adjustPageHeight: true,
    adjustPageWidth: true,
    header: 'none',
    footer: 'none',
    pageMarginLeft: 40,
    pageMarginRight: 500,
    pageMarginTop: multi ? 10 : 30,
    pageMarginBottom: 10,
    spacingLinear: 0.3,
    spacingNonLinear: 0.55,
    lyricSize: 4.3,
    lyricTopMinMargin: 3,
    lyricWordSpace: 2.5, // between words (default 1.2): where each word starts stays clear
    mnumInterval: 1,
    svgAdditionalAttribute: ['staff@n', 'measure@n'],
    svgViewBox: false,
    // no indentation: 40 % of the SVG's text, and as many empty text nodes in the page (60 000 for
    // a piano part); the drawing is the same (checked element by element)
    svgFormatRaw: true,
  };
}
