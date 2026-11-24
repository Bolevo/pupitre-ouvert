// « Apprendre le texte »: the sung text of the sheet with blanks, typed from memory, in order
// (retrieval practice). Two ways to type: the first letter of each word (« Initiales ») or the
// whole word (« Mots »). The help fades movement by movement as the text is known (vanishing cues:
// every word shown, every other word, the first word of each line, none; the same for all the lines
// of a movement, its heading says which) and comes back when it has not been practised for a
// while. By default the whole work, one movement after the other. « Épreuve »: everything hidden,
// headings without their words (the number only), a score, the lines to review.
//
// Moving around: « Recommencer » (↺, Alt+R) starts the run again; a movement's heading starts from
// that movement; a line to review starts from that line; Alt+↑ / Alt+↓ the previous / next line.
// The lines from there on are typed again; a movement not typed whole keeps its level of help.
//
// Keyboard only: a text field keeps the focus (it opens the phone's keyboard); characters are read
// from its `input` events (Android keyboards send no key codes for letters) and the field is
// emptied after each one. Nothing runs while the view is closed (no timer, no loop).
import { Component, Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cueShown, Drill, effectiveLevel, HELP, isBetter, MAX_LEVEL, MISS, nextLevel, OK, PENDING, type DrillEvent, type DrillLine, type Mode } from '../memo/drill';
import { lineText, sectionNumber, words, type Script, type Section } from '../memo/text';
import { loadSettings, loadStore, saveSettings, saveStore, type Best, type MemoStore } from '../memo/store';
import { Icon } from './Icon';
import { dropStrayCaret } from './popover';
import { reducedMotion } from './media';
import { tt } from '../i18n';

interface RunLine extends DrillLine {
  tr?: string;
  sec: number; // index in the sections
  w0: number; // place of its first word in its movement (every other word runs through the movement)
}
interface Result {
  acc: number;
  ok: number;
  total: number;
  ms: number;
  best?: Best;
  record: boolean;
  up: number; // movements with less help next time
  down: number; // … with more
  review: number[]; // lines with missed words
}
interface Run {
  lines: RunLine[];
  /** Level of help of each movement (by section index) in this run: the same for all its lines;
   *  none in « Épreuve ». */
  cue: Record<number, number>;
  /** The level of a movement once it is done in this run (its heading says it). */
  next: Record<number, number>;
  drill: Drill;
  test: boolean;
  scope: string;
  result: Result | null;
}

const mvts = (n: number) => (n > 1 ? tt('{n} mouvements', { n }) : tt('{n} mouvement', { n }));
/** What changes for the next round of learning. */
function nextSummary(res: Result, r: Run): string {
  const secs = Object.keys(r.next);
  if (secs.length === 1) {
    const l = r.next[+secs[0]];
    return l === MAX_LEVEL ? tt('Prochain tour : sans aide') : tt('Prochain tour : aide « {help} »', { help: tt(HELP[l]) });
  }
  const parts: string[] = [];
  if (res.up) parts.push(tt('moins d’aide pour {what}', { what: mvts(res.up) }));
  if (res.down) parts.push(tt('plus d’aide pour {what}', { what: mvts(res.down) }));
  return parts.length ? tt('Prochain tour : {what}', { what: parts.join(', ') }) : tt('Prochain tour : la même aide');
}

// the field is never empty: a Backspace then deletes this space, which Android keyboards report
// as an `input` event (on an empty field they may send nothing usable)
const SENTINEL = ' ';
const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pct = (x: number) => tt('{n} %', { n: Math.round(x * 100) });

/** Scrolls `scroller` so that `el` is in the part of it that is visible (above the phone's
 *  keyboard): about a third from the top when `place`, else only when it is out of view. */
function keepInView(scroller: HTMLElement, el: Element, place: boolean) {
  const vv = window.visualViewport;
  const r = scroller.getBoundingClientRect();
  const top = Math.max(r.top, vv ? vv.offsetTop : 0);
  const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : innerHeight);
  const h = bottom - top;
  if (h < 40) return;
  const e = el.getBoundingClientRect();
  if (!place && e.top >= top + 6 && e.bottom <= bottom - 6) return;
  const want = top + Math.max(6, Math.min(h * 0.28, h - e.height - 12));
  const dy = e.top - want;
  if (Math.abs(dy) < 2) return;
  scroller.scrollTo({ top: scroller.scrollTop + dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

interface LineProps {
  line: RunLine;
  i: number;
  state: 'done' | 'cur' | 'todo';
  marks: Uint8Array;
  cue: number;
  wi: number;
  typed: string;
  typedRight: boolean;
  /** A wrong key on the current word (its second one shows it, in « Initiales »). */
  strike: boolean;
  showTr: boolean;
}

/** One line of text: drawn again only when it is the current one, or when its state changes. */
class LineView extends Component<LineProps> {
  shouldComponentUpdate(next: LineProps) {
    const p = this.props;
    for (const k in next) if (next[k as keyof LineProps] !== p[k as keyof LineProps]) return true;
    return false;
  }
  render({ line, state, marks, cue, wi, typed, typedRight, strike, showTr }: LineProps) {
    return (
      <div class={`ml ${state}`} data-line={line.id}>
        <div class="ml-main">
          <p class="ml-text">
            {line.words.map((w, j) => {
              const m = marks[j];
              let el;
              if (m === OK) el = <span class="w ok">{w.shown}</span>;
              else if (m === MISS) el = <span class="w miss">{w.shown}</span>;
              else {
                const shown = cueShown(cue, line.w0 + j, j === 0);
                if (state === 'cur' && j === wi)
                  el = (
                    <span class={`w cur ${shown && !typed ? 'cue' : 'hid'} ${strike ? 'wrong' : ''}`}>
                      <span class="w-ghost" aria-hidden="true">
                        {w.shown}
                      </span>
                      {typed && (
                        <span class="w-typed">
                          {typedRight ? typed : Array.from(typed).slice(0, -1).join('')}
                          {!typedRight && <span class="bad-typed">{Array.from(typed).slice(-1)}</span>}
                        </span>
                      )}
                    </span>
                  );
                else
                  el = shown ? (
                    <span class="w cue">{w.shown}</span>
                  ) : (
                    <span class="w hid">
                      <span class="w-ghost" aria-hidden="true">
                        {w.shown}
                      </span>
                    </span>
                  );
              }
              return (
                <>
                  {el}{' '}
                </>
              );
            })}
          </p>
          {showTr && line.tr && <p class="ml-tr">{line.tr}</p>}
        </div>
      </div>
    );
  }
}

export function Memo({ sections, title, workId, onBack, onClose }: { sections: Section[]; title: string; workId: string; onBack: () => void; onClose: () => void }) {
  const hasPhon = sections.some((s) => s.lines.some((l) => l.phon));
  const [settings, setSettings] = useState(loadSettings);
  const script: Script = hasPhon ? settings.script : 'text';
  const mode = settings.mode;
  const [test, setTest] = useState(false);
  // the whole work by default: one movement after the other, nothing to choose
  const [scope, setScope] = useState(() => (sections.length > 1 ? 'all' : (sections[0]?.mv ?? 'all')));
  const store = useMemo<MemoStore>(() => loadStore(workId, script), [workId, script]);
  const [, setTick] = useState(0);
  const redraw = () => setTick((t) => t + 1);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const newRun = (m: Mode = mode, t = test): Run => {
    const now = Date.now();
    const lines: RunLine[] = [];
    const cue: Record<number, number> = {};
    sections.forEach((s, sec) => {
      if (scope !== 'all' && s.mv !== scope) return;
      cue[sec] = t ? MAX_LEVEL : effectiveLevel(store.sections[s.mv], now);
      let w0 = 0;
      for (const l of s.lines) {
        const ws = words(lineText(l, script));
        lines.push({ id: l.id, words: ws, tr: l.tr, sec, w0 });
        w0 += ws.length;
      }
    });
    return { lines, cue, next: {}, drill: new Drill(lines, m), test: t, scope, result: null };
  };
  const run = useRef<Run | null>(null);
  // a new run when the text changes (scope, script) or between learning and the test
  const runKey = `${scope}|${script}|${test}`;
  const lastKey = useRef('');
  if (lastKey.current !== runKey || !run.current) {
    lastKey.current = runKey;
    run.current = newRun();
  }
  const r = run.current;
  const d = r.drill;

  const focusInput = () => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.value !== SENTINEL) el.value = SENTINEL;
    el.setSelectionRange(1, 1);
  };
  useEffect(() => {
    focusInput();
    return () => dropStrayCaret();
  }, []);

  const changeSettings = (p: Partial<typeof settings>) => {
    const next = { ...settings, ...p };
    setSettings(next);
    saveSettings(next);
  };
  const setMode = (m: Mode) => {
    if (m === mode) return;
    changeSettings({ mode: m });
    // the same run goes on from the start of the current line, typed the other way (the words
    // already typed or missed stay as they are)
    const cur = run.current!;
    run.current = cur.drill.done ? newRun(m) : { ...cur, drill: new Drill(cur.lines, m, Date.now, cur.drill) };
    redraw();
  };
  const restart = () => {
    run.current = newRun();
    redraw();
    body.current?.scrollTo({ top: 0 });
  };
  /** Goes on from the start of a line (see Drill.jumpTo). */
  const jump = (li: number) => {
    const r = run.current!;
    r.drill.jumpTo(li);
    r.result = null;
    redraw();
  };
  /** Alt+↑: the start of the current line, or the line before when already there; Alt+↓: the
   *  next line. Lines without words are passed. */
  const step = (dir: -1 | 1) => {
    const d = run.current!.drill;
    const n = d.lines.length;
    const has = (i: number) => d.lines[i]?.words.length > 0;
    let i = d.done ? n : d.li;
    if (dir < 0 && !d.done && (d.wi > 0 || d.typed)) return jump(i);
    do i += dir;
    while (i >= 0 && i < n && !has(i));
    if (i >= 0 && i < n) jump(i);
  };

  /** A line is done; at the last line of a movement, the movement's level of help changes:
   *  learning, up from 95 % of its words right, down below 80 %; the test, a movement passed
   *  (95 %) needs no help any more, one failed (below 80 %) gets one level more. */
  const onLineDone = (li: number) => {
    const r = run.current!;
    const d = r.drill;
    const sec = r.lines[li].sec;
    if (r.lines[li + 1]?.sec === sec) return;
    let ok = 0;
    let n = 0;
    let skipped = false;
    r.lines.forEach((l, i) => {
      if (l.sec !== sec) return;
      n += l.words.length;
      ok += d.marks[i].reduce((k, m) => k + (m === OK ? 1 : 0), 0);
      if (d.marks[i].includes(PENDING)) skipped = true;
    });
    // started in the middle (a jump): not typed whole, its level stays
    if (skipped) return;
    const mv = sections[sec].mv;
    // the level practised in this run (in the test: the one stored, the test showing no help)
    const before = r.test ? effectiveLevel(store.sections[mv], Date.now()) : r.cue[sec];
    let after = nextLevel(before, ok, n);
    if (r.test && after > before) after = MAX_LEVEL;
    store.sections[mv] = { l: after, at: Date.now() };
    r.next[sec] = after;
    saveStore(workId, script, store);
  };
  const onEnd = () => {
    const r = run.current!;
    const d = r.drill;
    const key = `${r.scope}|${d.mode}`;
    const prev = store.best[key];
    let record = false;
    if (r.test && d.fromStart && d.count) {
      record = isBetter(d.accuracy, d.elapsed, prev);
      if (record) {
        store.best[key] = { acc: d.accuracy, ms: d.elapsed, at: Date.now() };
        saveStore(workId, script, store);
      }
    }
    r.result = {
      acc: d.accuracy,
      ok: d.ok,
      total: d.count,
      ms: d.elapsed,
      best: prev,
      record: record && !!prev,
      up: Object.keys(r.next).filter((k) => r.next[+k] > r.cue[+k]).length,
      down: Object.keys(r.next).filter((k) => r.next[+k] < r.cue[+k]).length,
      review: r.lines.map((_, i) => i).filter((i) => d.missesOf(i) > 0),
    };
  };

  const flash = () => {
    const el = body.current?.querySelector('.w.cur');
    if (!el) return;
    el.classList.remove('bad');
    void (el as HTMLElement).offsetWidth; // restart the animation
    el.classList.add('bad');
    setTimeout(() => el.classList.remove('bad'), 400);
  };

  /** One character from the field ('\b' Backspace, '\n' Enter). */
  const handle = (ch: string) => {
    const d = run.current!.drill;
    if (d.done) {
      if (ch === '\n') restart();
      return;
    }
    const li = d.li;
    let ev: DrillEvent;
    if (ch === '\b') ev = d.backspace();
    else if (ch === '\n') ev = d.submit();
    else ev = d.input(ch);
    if (ev.kind === 'none') return;
    if (ev.kind === 'wrong') flash();
    if ((ev.kind === 'ok' || ev.kind === 'miss') && ev.lineDone) {
      onLineDone(li);
      if (ev.end) onEnd();
    }
    redraw();
  };

  // reading the field
  const prev = useRef(SENTINEL);
  const reset = () => {
    const el = input.current;
    if (!el) return;
    el.value = SENTINEL;
    prev.current = SENTINEL;
    try {
      el.setSelectionRange(1, 1);
    } catch {
      /* not focusable now */
    }
  };
  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const v = el.value;
    const p = prev.current;
    let k = 0;
    while (k < p.length && k < v.length && p[k] === v[k]) k++;
    for (let n = p.length - k; n > 0; n--) handle('\b');
    for (const ch of Array.from(v.slice(k))) handle(ch);
    prev.current = v;
    // a word being composed by the keyboard (suggestions) stays in the field until it is committed
    if (!(e as InputEvent).isComposing) reset();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyR' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.code === 'KeyR') restart();
      else step(e.key === 'ArrowUp' ? -1 : 1);
      focusInput();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault();
      if (e.code === 'Digit1') setMode('initials');
      else if (e.code === 'Digit2') setMode('words');
      else setTest((t) => !t);
      focusInput();
      return;
    }
    if (e.target !== input.current) return;
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      handle('\n');
    }
  };

  // keep the current line in view (also above the phone's keyboard): placed when the line changes,
  // then the current word only if it goes out of view (a long line on a phone)
  const placed = useRef<{ run: Run | null; li: number }>({ run: null, li: -1 });
  useLayoutEffect(() => {
    const b = body.current;
    if (!b) return;
    const at = r.result ? -1 : d.li;
    const moved = placed.current.run !== r || placed.current.li !== at;
    placed.current = { run: r, li: at };
    const el = r.result ? b.querySelector('.memo-result') : moved ? b.querySelector('.ml.cur') : b.querySelector('.w.cur');
    if (el && (moved || !r.result)) keepInView(b, el, moved);
  });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const b = body.current;
      const el = b?.querySelector('.ml.cur') ?? b?.querySelector('.memo-result');
      if (b && el) keepInView(b, el, true);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const total = d.total;
  const lineCount = r.lines.length;
  const res = r.result;
  const best = store.best[`${r.scope}|${mode}`];
  /** A movement's heading: its title and its help; in the test, its number only (the title
   *  often holds the very words to find). */
  const heading = (sec: number, li: number) => {
    const num = sectionNumber(sections[sec].title, sec);
    // the heading starts the run from this movement (again, for the current one)
    const go = (label: string) => (
      <button class="memo-head-go" onMouseDown={keepFocus} title={tt('Reprendre à ce mouvement')} aria-label={tt('Reprendre au mouvement {n}', { n: num })} onClick={ctl(() => jump(li))}>
        {label}
      </button>
    );
    if (r.test) return <h3 class="memo-head">{go(String(num))}</h3>;
    const nx = r.next[sec];
    const cue = r.cue[sec];
    return (
      <h3 class="memo-head">
        {go(sections[sec].title)}
        {nx === undefined || nx === cue ? (
          <span class="memo-help-level">{tt('Aide :')} {tt(HELP[cue])}</span>
        ) : (
          <span class={`memo-help-level ${nx > cue ? 'up' : 'down'}`}>{tt('Prochain tour :')} {nx === MAX_LEVEL ? tt('sans aide') : tt(HELP[nx])}</span>
        )}
      </h3>
    );
  };
  const ctl = (fn: () => void) => () => {
    fn();
    focusInput();
  };
  /** On a button that moves in the text: the field keeps the focus (the phone's keyboard stays
   *  open, and nothing moves under the finger between press and release). */
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const help = mode === 'initials' ? tt('Tapez l’initiale de chaque mot') : tt('Tapez chaque mot, sans espace · ⌫ corrige');

  return (
    <div class={`memo ${r.test ? 'testing' : ''}`} onKeyDown={onKeyDown}>
      <header class="fiche-head">
        <button class="fiche-close memo-back" aria-label={tt('Retour à la fiche')} title={tt('Retour à la fiche')} onClick={onBack}>
          <Icon name="chevron-left" size={20} />
        </button>
        <div class="fiche-title">
          <b>{tt('Apprendre le texte')}</b>
          <span>{title}</span>
        </div>
        <button class="fiche-close" aria-label={tt('Fermer la fiche')} title={tt('Fermer (Échap)')} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div class="memo-bar">
        <select
          class="memo-scope"
          aria-label={tt('Texte à apprendre')}
          value={scope}
          onChange={(e) => {
            setScope((e.currentTarget as HTMLSelectElement).value);
            focusInput();
          }}
        >
          {sections.map((s, k) => (
            <option value={s.mv}>{r.test ? tt('Mouvement {n}', { n: sectionNumber(s.title, k) }) : s.title}</option>
          ))}
          {sections.length > 1 && <option value="all">{tt('Toute l’œuvre')}</option>}
        </select>
        <div class="seg memo-seg" role="group" aria-label={tt('Apprendre ou vérifier')}>
          <button class={!test ? 'on' : ''} aria-pressed={!test} title={tt('Apprendre : l’aide s’efface mouvement par mouvement (Alt+3)')} onClick={ctl(() => setTest(false))}>
            {tt('Apprendre')}
          </button>
          <button class={test ? 'on' : ''} aria-pressed={test} title={tt('Épreuve : tout le texte caché, un score (Alt+3)')} onClick={ctl(() => setTest(true))}>
            {tt('Épreuve')}
          </button>
        </div>
        <div class="seg memo-seg" role="group" aria-label={tt('Que taper')}>
          <button class={mode === 'initials' ? 'on' : ''} aria-pressed={mode === 'initials'} title={tt('La première lettre de chaque mot (Alt+1)')} onClick={ctl(() => setMode('initials'))}>
            {tt('Initiales')}
          </button>
          <button class={mode === 'words' ? 'on' : ''} aria-pressed={mode === 'words'} title={tt('Le mot entier (Alt+2)')} onClick={ctl(() => setMode('words'))}>
            {tt('Mots')}
          </button>
        </div>
        {hasPhon && (
          <div class="seg memo-seg" role="group" aria-label={tt('Écriture')}>
            <button class={script === 'phon' ? 'on' : ''} aria-pressed={script === 'phon'} onClick={ctl(() => changeSettings({ script: 'phon' }))}>
              {tt('Phonétique')}
            </button>
            <button class={script === 'text' ? 'on' : ''} aria-pressed={script === 'text'} onClick={ctl(() => changeSettings({ script: 'text' }))}>
              {tt('Cyrillique')}
            </button>
          </div>
        )}
      </div>
      <div class="memo-status" aria-live="off">
        <input
          ref={input}
          class="memo-input"
          type="text"
          aria-label={tt('Saisie du texte')}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          inputMode="text"
          enterKeyHint="next"
          value={SENTINEL}
          onInput={onInput}
          onCompositionEnd={() => setTimeout(reset, 0)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {r.test && <span class="memo-tag">{tt('Épreuve')}</span>}
        <span class="memo-where">
          {res ? tt('Terminé') : tt('Ligne {i}/{n}', { i: Math.min(d.li + 1, lineCount), n: lineCount })}
          <span class="memo-sep"> · </span>
          {tt('{i}/{n} mots', { i: d.position, n: total })}
        </span>
        <span class={`memo-streak ${d.streak >= 10 ? 'hot' : ''}`} title={tt('Mots d’affilée sans erreur')}>
          {tt('Série {n}', { n: d.streak })}
        </span>
        {!res && (d.count > 0 || d.li > 0) && (
          <button class="memo-restart" onMouseDown={keepFocus} aria-label={tt('Recommencer')} title={tt('Recommencer depuis le début (Alt+R)')} onClick={ctl(restart)}>
            <Icon name="replay" size={17} />
          </button>
        )}
        {!focused && !res && (
          <button class="memo-type" onClick={focusInput}>
            {tt('Toucher pour écrire')}
          </button>
        )}
        <span class="memo-progress" style={{ transform: `scaleX(${total ? d.position / total : 0})` }} aria-hidden="true" />
      </div>
      <div
        class="memo-body"
        ref={body}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button, select')) focusInput();
        }}
      >
        <div class="memo-text">
          {r.lines.map((line, i) => {
            const state = i < d.li || d.done ? 'done' : i === d.li ? 'cur' : 'todo';
            const cur = state === 'cur';
            return (
              <Fragment key={line.id}>
                {(i === 0 || r.lines[i - 1].sec !== line.sec) && heading(line.sec, i)}
                <LineView
                  line={line}
                  i={i}
                  state={state}
                  marks={d.marks[i]}
                  cue={r.cue[line.sec]}
                  wi={cur ? d.wi : -1}
                  typed={cur ? d.typed : ''}
                  typedRight={cur ? d.typedRight : true}
                  strike={cur && (d.tries > 0 || !d.typedRight)}
                  showTr={cur && !r.test}
                />
              </Fragment>
            );
          })}
          {res && (
            <section class="memo-result" aria-live="polite">
              <h3>{r.test ? tt('Épreuve terminée') : tt('Tour terminé')}</h3>
              <p class="memo-score">
                <b>{pct(res.acc)}</b>
                <span>
                  {tt('{i}/{n} mots', { i: res.ok, n: res.total })} · {res.total - res.ok > 1 ? tt('{n} erreurs', { n: res.total - res.ok }) : tt('{n} erreur', { n: res.total - res.ok })} · {fmtTime(res.ms)}
                </span>
              </p>
              {r.test ? (
                res.record ? (
                  <p class="memo-record">{tt('Nouveau record')}</p>
                ) : res.best ? (
                  <p class="memo-best">
                    {tt('Record : {pct} en {time}', { pct: pct(res.best.acc), time: fmtTime(res.best.ms) })}
                  </p>
                ) : null
              ) : (
                <p class="memo-best">{nextSummary(res, r)}</p>
              )}
              {res.review.length > 0 && (
                <div class="memo-review">
                  <h4>{tt('À revoir')}</h4>
                  <ul>
                    {res.review.map((i) => (
                      <li>
                        <button class="memo-review-line" onMouseDown={keepFocus} title={tt('Reprendre à cette ligne')} onClick={ctl(() => jump(i))}>
                          {r.lines[i].words.map((w, j) => (
                            <span class={d.marks[i][j] === MISS ? 'miss' : ''}>{w.shown} </span>
                          ))}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div class="memo-actions">
                <button class="pop-action" onClick={ctl(restart)}>
                  {r.test ? tt('Recommencer') : tt('Encore un tour')} <kbd>{tt('Entrée')}</kbd>
                </button>
                <button class="memo-alt" onClick={ctl(() => setTest(!r.test))}>
                  {r.test ? tt('Apprendre') : tt('Épreuve')}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
      <p class="memo-help">
        {help} · {tt('Entrée ou ? : voir le mot · Un titre : reprendre là · Alt+↑ ↓ ligne · Alt+R recommencer · Alt+1 Initiales · Alt+2 Mots · Alt+3 Épreuve · Échap fermer')}
        {best && !res && r.test && ` · ${tt('Record : {pct} en {time}', { pct: pct(best.acc), time: fmtTime(best.ms) })}`}
      </p>
    </div>
  );
}
