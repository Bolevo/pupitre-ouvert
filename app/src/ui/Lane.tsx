// The followed voice on one endless line that scrolls under a fixed playhead, with its lyrics.
// Touch a note to hear it (a tap plays it briefly, a long press holds it): the music pauses and
// resumes when you let go. Drag the line to look back: following resumes a few seconds later.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { airySyllables, filterMei } from '../score/meiFilter';
import { lineOptions, renderer } from '../score/renderer';
import { between, followPart, holdNote, heldNote, lyricVerses, movement, myPart, playing, position, prefs, releaseNote, startFrom, work } from '../state';
import { useDismiss } from './popover';
import { LA_HZ, noteName } from '../audio/notes';
import type { LoadedPack, Movement, PackNote } from '../pack/types';
import { measureIndexAt, ticker } from './timing';
import { lastAtOrBefore, upperBound } from '../util/search';
import { Icon } from './Icon';
import { phoneLayout, reducedMotion } from './media';
import { clefAt, clefWords, fifthsOf, keyNameAt, shortKeyName, signatureWords, keyLabel } from '../score/info';
import { ClefGlyph, SignatureGlyph } from './Glyph';
import { now } from './now';
import { NS } from '../site';
import { lang, partLabel, tt } from '../i18n';

export const LANE_SCALES = [38, 46, 56];
const PLAYHEAD = 0.3; // share of the width left of the playhead
const MANUAL_MS = 3500; // after the user moved the line, following waits this long
const TAP_MS = 170; // touch: shorter than this without moving = a tap, longer = a hold
const RESIZE_MS = 200; // the line is rendered again this long after the last change of its size (taps ~200 ms apart)

interface Pt {
  t: number;
  x: number;
}
let filtered: { w: LoadedPack; key: string; mei: string } | null = null; // the last filtered MEI (one voice)

// Wide screens: the pages take the height that the line leaves them. Before its first drawing the
// line takes the height it had the last time it was this one (same movement, voice, size): the
// pages do not open larger and shrink a moment later.
const HEIGHT_KEY = `${NS}-line-height`;
function lastHeight(key: string): number {
  try {
    const [k, h] = JSON.parse(localStorage.getItem(HEIGHT_KEY) ?? '[]');
    return k === key && h > 0 ? h : 0;
  } catch {
    return 0;
  }
}
function keepHeight(key: string, h: number) {
  try {
    localStorage.setItem(HEIGHT_KEY, JSON.stringify([key, h]));
  } catch {
    /* private mode */
  }
}
interface Index {
  pts: Pt[];
  els: Map<string, Element>;
  mine: PackNote[];
  byEl: Map<string, PackNote>;
  xs: Map<string, number>; // centre of each note's head, px from the left of the line
  on: Map<Element, Element | null>; // the notes lit now, each with its coloured copy (see light())
  hi: Element | null; // where the coloured copies go (null: the notes themselves are coloured)
  mv: Movement; // the movement it was built for
}

export function Lane() {
  const w = work.value;
  const mv = movement.value;
  const me = myPart.value;
  const size = Math.max(0, Math.min(2, prefs.value.laneSize));
  const verses = lyricVerses.value;
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const index = useRef<Index | null>(null);
  const userScrollAt = useRef(0);
  const pendingBuild = useRef(false);
  const laneWidth = useRef(0); // the line's visible width, kept by the ResizeObserver (never read from the layout while playing)
  const entryRef = useRef<HTMLButtonElement>(null);
  const entryAt = useRef(-1); // where a touch on the entry text takes the music: a measure before my entry

  // measure as soon as the line becomes visible again (phones: the track list may hide it)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      laneWidth.current = el.clientWidth;
      if (pendingBuild.current && el.clientWidth > 0 && host.current?.firstElementChild) {
        pendingBuild.current = false;
        build();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the breath before the next movement (« Enchaîner »): the Verovio worker, stopped while idle,
  // starts now, so the next line is not kept waiting for it
  const breath = between.value && prefs.value.endMode === 'next';
  useEffect(() => {
    if (breath) renderer().warm();
  }, [breath]);

  // render the followed staff as one line
  const renderedSize = useRef(size);
  useEffect(() => {
    if (!w || !mv) return;
    let ok = true;
    setStatus('loading');
    index.current = null;
    pendingBuild.current = false;
    const render = async () => {
      const staves = mv.parts.find((p) => p.id === me)?.staves ?? [];
      // the filtered MEI (DOMParser + serialisation of a 2 MB document, on the main thread) is
      // kept: changing only the size of the line renders it again without filtering again
      const key = `${w.pack.id}|${mv.id}|${staves.join('.')}|${verses?.join(',') ?? ''}`;
      const wide = !phoneLayout();
      if (wide && host.current && !host.current.firstElementChild) host.current.style.minHeight = `${lastHeight(`${key}|${size}`)}px`;
      if (filtered?.w !== w || filtered.key !== key) filtered = { w, key, mei: airySyllables(filterMei(await w.getFile(mv.mei), staves, verses)) };
      const svg = await renderer().line(filtered.mei, lineOptions(LANE_SCALES[size], staves.length, phoneLayout()));
      if (!ok || !host.current) return;
      host.current.innerHTML = svg;
      host.current.style.minHeight = '';
      if (wide) keepHeight(`${key}|${size}`, host.current.offsetHeight);
      if (scroller.current && scroller.current.clientWidth > 0) build();
      else pendingBuild.current = true;
      setStatus('ready');
    };
    const run = () => void render().catch((e) => console.warn('lane', e));
    // a new size: wait for the last of a few quick taps on « A A A » (a render takes 0.2-0.7 s
    // in the worker and cannot be cancelled there)
    const resized = renderedSize.current !== size;
    renderedSize.current = size;
    let timer = 0;
    if (resized) timer = window.setTimeout(run, RESIZE_MS);
    else run();
    return () => {
      ok = false;
      window.clearTimeout(timer);
    };
  }, [w, mv?.id, me, size, verses?.join(',')]);

  function build() {
    const h = host.current!;
    const m = movement.value!;
    const base = h.getBoundingClientRect();
    // where a note "starts" on the line: the left edge of its symbol (accidental included)
    const leftOf = (el: Element) => {
      let x = Infinity;
      el.querySelectorAll('.notehead, .accid').forEach((g) => {
        const r = g.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) x = Math.min(x, r.left); // implied accidentals render empty
      });
      if (x === Infinity) x = el.getBoundingClientRect().left;
      return x - base.left;
    };
    const els = new Map<string, Element>();
    h.querySelectorAll('g.note').forEach((g) => els.set(g.id, g));
    const mine = m.notes.filter((n) => n.part === myPart.value).sort((a, b) => a.t - b.t);
    const byEl = new Map<string, PackNote>();
    for (const n of mine) for (const id of n.ids ?? [n.id]) byEl.set(id, n);
    const pts: Pt[] = [];
    // the first beat of each measure sits on its barline (as on the printed page)
    const mEls = new Map<string, Element>();
    h.querySelectorAll('g.measure').forEach((g) => mEls.set(g.id, g));
    const starts = new Set<number>();
    m.measures.forEach((ms, i) => {
      const el = mEls.get(ms.id);
      if (!el) return;
      const staff = el.querySelector('g.staff') ?? el;
      let x = staff.getBoundingClientRect().left - base.left;
      // a measure opening with clef / key / time signature: start after them
      let after = -Infinity;
      el.querySelectorAll('.clef, .keySig, .meterSig, .mensur').forEach((g) => (after = Math.max(after, g.getBoundingClientRect().right - base.left)));
      if (after > x) x = after + 4;
      else if (i > 0) x += 1;
      pts.push({ t: ms.t, x });
      starts.add(ms.t);
    });
    const xs = new Map<string, number>();
    for (const n of mine) {
      const el = els.get(n.id);
      if (!el) continue;
      const r = (el.querySelector('.notehead') ?? el).getBoundingClientRect();
      xs.set(n.id, r.left + r.width / 2 - base.left);
      if (starts.has(n.t)) continue; // beat 1: the barline
      if (n.moved) continue; // not played where it is drawn: its head says nothing of the time
      pts.push({ t: n.t, x: leftOf(el) });
    }
    pts.sort((a, b) => a.t - b.t || a.x - b.x);
    for (let i = 1; i < pts.length; i++) if (pts[i].x < pts[i - 1].x) pts[i].x = pts[i - 1].x;
    // the end of the music: the final barline (the line stops there, not further on)
    const lastEl = mEls.get(m.measures[m.measures.length - 1]?.id ?? '');
    const lastX = pts[pts.length - 1]?.x ?? 0;
    const endX = lastEl ? (lastEl.querySelector('g.staff') ?? lastEl).getBoundingClientRect().right - base.left : lastX + 200;
    pts.push({ t: m.durationMs, x: Math.max(lastX, endX) });
    index.current = { pts, els, mine, byEl, xs, on: new Map(), hi: overlay(h), mv: m };
  }

  // follow the music. The line glides on the compositor (a Web Animation of its transform built
  // from the time -> x map): no layout, paint or scroll on the main thread at each frame, so it
  // stays fluid on a phone. Each frame only checks the drift against the audio clock (rarely
  // corrected), which notes sound, and the entry text; the DOM is touched only when they change.
  useEffect(() => {
    let lastSt = -1;
    let lastIdx: Index | null = null;
    let anim: Animation | null = null;
    let width = 0;
    let drift = 0;
    let wasManual = false;
    let wasPlaying = false;
    let frozenAt = 0; // score time shown while the user looks around
    let unseen = false; // the line is not displayed
    let entryKey = ''; // the entry text, worked out once per measure (it reads the header's layout)
    let entryTxt = '';
    const tick = (): number => {
      const idx = index.current;
      const sc = scroller.current;
      const h = host.current;
      if (!idx || !sc || !h) return 100;
      const st = position();
      const isPlaying = playing.value;
      let moved = st !== lastSt;
      // the width comes from the ResizeObserver: reading it from the layout here made the browser
      // bring the running animations up to date on the main thread at every look (a main frame each)
      const cw = laneWidth.current;
      // not displayed (the track list in its place, or the page alone): shown again, its texts
      // are worked out anew, for its real width
      if (cw === 0) unseen = true;
      else if (unseen) {
        unseen = false;
        lastSt = -1;
        moved = true;
      }
      if (idx !== lastIdx || (cw > 0 && cw !== width)) {
        lastIdx = idx;
        width = cw;
        anim?.cancel();
        anim = follow(h, idx.pts, cw * PLAYHEAD, movement.value?.durationMs ?? 1);
        anim.currentTime = st;
        lastSt = -1;
        moved = true; // a new line (another movement or part): its entry text is computed at once
      }
      if (!anim) return 100;
      const manualLeft = MANUAL_MS - (Date.now() - userScrollAt.current);
      const manual = manualLeft > 0;
      if (manual) {
        if (!wasManual) {
          wasManual = true;
          frozenAt = Number(anim.currentTime ?? st);
          anim.pause();
        }
      } else if (wasManual && (isPlaying || moved)) {
        // back to following: glide from where the user left the line
        wasManual = false;
        panTo(offset.current + xAt(idx.pts, st) - xAt(idx.pts, frozenAt), false);
        panTo(0, true);
        anim.currentTime = st;
      }
      if (!wasManual) {
        if (isPlaying) {
          const rate = prefs.value.rate || 1;
          if (anim.playbackRate !== rate) anim.playbackRate = rate;
          if (anim.playState === 'running') {
            const off = Number(anim.currentTime) - st;
            if (Math.abs(off) > 250) {
              // a jump in the music: wait there until it is heard again
              anim.pause();
              anim.currentTime = st;
            } else if (moved) {
              // the audio clock moves in steps: smooth the difference, correct only a real drift
              drift = drift * 0.9 + off * 0.1;
              if (Math.abs(drift) > 30) {
                anim.currentTime = st;
                drift = 0;
              }
            }
          } else if (moved && wasPlaying) {
            // start with the music, once it is really heard
            anim.currentTime = st;
            anim.play();
            drift = 0;
          } else if (moved) anim.currentTime = st;
        } else {
          if (anim.playState === 'running') anim.pause();
          if (moved) anim.currentTime = st;
        }
      }
      wasPlaying = isPlaying;
      lastSt = st;
      // sounding notes (also when paused: the note under the playhead); `upper` = first note
      // starting after st, found by binary search: a few steps per frame whatever the length
      const mine = idx.mine;
      const upper = upperBound(mine, st, byT);
      let singing = false;
      let changed = false;
      const now = new Set<Element>();
      for (let i = upper - 1, k = 0; i >= 0 && k < 8; i--, k++) {
        const n = mine[i];
        if (n.t + n.d > st) {
          singing = true;
          if (isPlaying) for (const id of n.ids ?? [n.id]) {
            const el = idx.els.get(id);
            if (el) {
              now.add(el);
              if (!idx.on.has(el)) changed = true;
            }
          }
        }
      }
      if (changed || now.size !== idx.on.size) {
        for (const [el, copy] of idx.on) {
          if (now.has(el)) continue;
          if (copy) copy.remove();
          else el.classList.remove('on');
          idx.on.delete(el);
        }
        for (const el of now) if (!idx.on.has(el)) idx.on.set(el, light(idx.hi, el));
      }
      // during a real rest (at least a measure long): when do I come in? (text updated on change only)
      // the index's own movement: just after a change of movement the line of the new one is not
      // built yet, its notes and measures must not be mixed with the old ones (an error in Safari)
      const m = idx.mv;
      if (entryRef.current && m === movement.value && (moved || isPlaying)) {
        let txt = '';
        if (!singing) {
          const next = mine[upper];
          if (next) {
            const cur = measureIndexAt(m, st);
            const len = (m.measures[cur + 1]?.t ?? m.durationMs) - m.measures[cur].t;
            const k = next.m - cur;
            const nn = m.measures[next.m].n;
            if (next.t - st >= len * 0.95) {
              // the line's own width: a phone lying down gives it the screen or half of it
              const key = `${nn}:${k}:${cw}:${lang.value}`;
              if (key !== entryKey && cw > 0) {
                entryKey = key;
                entryTxt = entryText(entryRef.current, nn, k);
              }
              txt = entryTxt;
              entryAt.current = m.measures[Math.max(0, next.m - 1)].t;
            }
          } else if (mine.length) txt = tt('Fin de la partie');
        }
        if (entryRef.current.textContent !== txt) {
          entryRef.current.textContent = txt;
          const go = txt !== '' && txt !== tt('Fin de la partie'); // an entry to come: the label goes there
          entryRef.current.disabled = !go;
          entryRef.current.title = go ? tt('Aller une mesure avant mon entrée') : '';
        }
      }
      // next look: at the next change (a note starts or ends, a new measure), or soon to check
      // the drift; quickly while the music is about to start
      if (!isPlaying) return 100;
      if (anim.playState !== 'running' && !wasManual) return 16;
      let next = mine[upper]?.t ?? Infinity;
      for (let i = upper - 1, k = 0; i >= 0 && k < 8; i--, k++) {
        const e = mine[i].t + mine[i].d;
        if (e > st && e < next) next = e;
      }
      if (m) {
        const nm = m.measures[measureIndexAt(m, st) + 1];
        if (nm && nm.t > st && nm.t < next) next = nm.t;
      }
      let delay = (next - st) / (prefs.value.rate || 1) + 2;
      if (manual) delay = Math.min(delay, manualLeft + 5);
      return delay;
    };
    const stop = ticker(tick);
    return () => {
      stop();
      anim?.cancel();
    };
  }, []);

  // looking around: the line is moved by hand on top of the following (an offset in px)
  const pan = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const panTo = (x: number, glide: boolean) => {
    offset.current = x;
    const el = pan.current;
    if (!el) return;
    el.style.transition = glide && !reducedMotion() ? 'transform 0.5s ease-out' : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
  };
  const panBy = (dx: number) => {
    const idx = index.current;
    const h = host.current;
    const sc = scroller.current;
    if (!idx || !h || !sc) return;
    userScrollAt.current = Date.now();
    // keep some of the line under the playhead
    const r = h.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const head = s.left + sc.clientWidth * PLAYHEAD;
    const min = head - r.right; // the end of the line at the playhead
    const max = head - r.left; // its start at the playhead
    const d = Math.max(min, Math.min(max, dx));
    panTo(offset.current + d, false);
  };

  // ----- touching the line -----
  const pressed = useRef<Element | null>(null);
  const pending = useRef<{ timer: number; el: Element; n: PackNote; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number } | null>(null);

  const startHold = (el: Element, n: PackNote) => {
    pressed.current = el;
    el.classList.add('held');
    void holdNote(n.id, n.midi, n.sp);
  };
  const endHold = () => {
    if (!pressed.current) return;
    pressed.current.classList.remove('held');
    pressed.current = null;
    releaseNote();
  };

  const onDown = (e: PointerEvent) => {
    const idx = index.current;
    if (!idx) return;
    // a note that is drawn but not sung (the printed note kept in grey beside the one that
    // corrects it, a grace note) is not mine: the press goes to the nearest note that is
    const hit = (e.target as Element).closest('g.note');
    const g = hit && idx.byEl.has(hit.id) ? hit : nearestNote(idx, e);
    const n = g ? idx.byEl.get(g.id) : null;
    if (e.pointerType === 'mouse') {
      if (g && n) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        startHold(g, n);
      } else {
        drag.current = { x: e.clientX };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    // touch / pen: wait a little to tell a tap or a hold from a drag along the line
    drag.current = { x: e.clientX };
    if (!g || !n) return;
    const el = g;
    pending.current = {
      el,
      n,
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        if (pending.current?.el === el) {
          pending.current = null;
          startHold(el, n);
        }
      }, TAP_MS),
    };
  };
  const onMove = (e: PointerEvent) => {
    const p = pending.current;
    if (p) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 10) return;
      clearTimeout(p.timer); // it is a drag
      pending.current = null;
    }
    if (!drag.current || pressed.current) return;
    panBy(e.clientX - drag.current.x);
    drag.current.x = e.clientX;
  };
  const onUp = () => {
    drag.current = null;
    const p = pending.current;
    if (p) {
      // a tap: hear the note briefly
      clearTimeout(p.timer);
      pending.current = null;
      startHold(p.el, p.n);
      window.setTimeout(endHold, 650);
      return;
    }
    endHold();
  };
  const onCancel = () => {
    drag.current = null;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    endHold();
  };
  // leaving the screen while a note is pressed: nothing stays held or planned
  useEffect(() => onCancel, []);

  function nearestNote(idx: Index, e: PointerEvent): Element | null {
    // the heads' positions were measured once (build): only the line's current offset is read
    const h = host.current;
    if (!h) return null;
    const x = e.clientX - h.getBoundingClientRect().left;
    let best: Element | null = null;
    let bd = 34;
    for (const n of idx.mine) {
      const cx = idx.xs.get(n.id);
      if (cx === undefined) continue;
      const d = Math.abs(cx - x);
      if (d < bd) {
        bd = d;
        best = idx.els.get(n.id) ?? null;
      }
    }
    return best;
  }

  // bubble with the held note's name
  const held = heldNote.value;
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!held || !pressed.current || !scroller.current) return setBubble(null);
    const r = (pressed.current.querySelector('.notehead') ?? pressed.current).getBoundingClientRect();
    const b = scroller.current.getBoundingClientRect();
    setBubble({ x: r.left - b.left + r.width / 2, y: r.top - b.top });
  }, [held?.id]);

  const myP = mv?.parts.find((p) => p.id === me);
  const partName = partLabel(myP?.name ?? me);
  return (
    <section class="lane" aria-label={tt('Voix suivie : {name}', { name: partName })}>
      <div
        class="lane-scroll"
        ref={scroller}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerMove={onMove}
        onPointerCancel={onCancel}
        onWheel={(e) => {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!d) return;
          e.preventDefault();
          panBy(-d);
        }}
      >
        <div class="lane-pan" ref={pan}>
          <div class="lane-svg" ref={host} />
        </div>
      </div>
      <div class="playhead" style={{ left: `${PLAYHEAD * 100}%` }} />
      <div class="lane-head">
        <VoicePicker name={partName} />
        {myP && <LaneInfo staves={myP.staves} />}
        {/* when I come in (or that my part is over): at the right end of the header row */}
        <button class="lane-entry" ref={entryRef} aria-live="polite" disabled onClick={() => entryAt.current >= 0 && startFrom(entryAt.current)} />
      </div>
      {bubble && held && (
        <div class="bubble" style={{ left: `${bubble.x}px`, top: `${bubble.y}px` }}>
          {noteName(held.midi)}
        </div>
      )}
      {status === 'loading' && <div class="lane-status" role="status">{tt('Préparation de la ligne…')}</div>}
    </section>
  );
}

/** The line's movement as one compositor animation: at score time t, the point x(t) of the line
 *  sits under the playhead (`head` px from the left). Linear between the points, like xAt. */
function follow(el: HTMLElement, pts: Pt[], head: number, dur: number): Animation {
  const frames: Keyframe[] = [];
  let lastT = -1;
  for (const p of pts) {
    const t = Math.max(0, Math.min(dur, p.t));
    if (t === lastT) continue; // same instant: keep the first point (no jump)
    lastT = t;
    frames.push({ offset: t / dur, transform: `translateX(${(head - p.x).toFixed(1)}px)` });
  }
  if (!frames.length || frames[0].offset !== 0) frames.unshift({ offset: 0, transform: `translateX(${head.toFixed(1)}px)` });
  const last = frames[frames.length - 1];
  if (last.offset !== 1) frames.push({ offset: 1, transform: last.transform });
  const a = el.animate(frames, { duration: dur, fill: 'both', easing: 'linear' });
  a.pause();
  return a;
}

const byT = (p: { t: number }) => p.t;

/** An empty drawing laid over the line, in the same coordinates (Verovio's nested <svg> and its
 *  page margin, copied without their content): the notes being sung are drawn there in colour.
 *  Colouring the notes of the line itself made the browser go through the whole line again at
 *  every note (thousands of elements for a voice, 40 000 for the piano of a long movement: half
 *  of the main thread in a fast passage); the line is now painted once and kept (styles.css gives
 *  it its own cached layer). Returns the group to draw in; null if the drawing is not built as
 *  expected (the notes themselves are then coloured, as before). */
function overlay(host: HTMLElement): Element | null {
  host.querySelector(':scope > .lane-hi')?.remove();
  const root = host.querySelector(':scope > svg');
  const inner = root?.querySelector(':scope > svg');
  const margin = inner?.querySelector(':scope > g');
  if (!root || !inner || !margin) return null;
  const top = root.cloneNode(false) as Element;
  top.removeAttribute('id');
  const g = margin.cloneNode(false) as Element;
  top.appendChild(inner.cloneNode(false)).appendChild(g);
  const box = document.createElement('div');
  box.className = 'lane-hi';
  box.setAttribute('aria-hidden', 'true');
  // exactly over the line, whatever padding the host has (both boxes move together: only their
  // difference is read)
  const r = root.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  box.style.cssText = `left:${r.left - h.left}px;top:${r.top - h.top}px`;
  box.appendChild(top);
  host.appendChild(box);
  return g;
}

/** Lights a note: its coloured copy in the overlay (without the ids, which stay the line's own);
 *  without an overlay, the note itself. Returns the copy (null: the note itself was coloured). */
function light(hi: Element | null, el: Element): Element | null {
  if (!hi) {
    el.classList.add('on');
    return null;
  }
  const copy = el.cloneNode(true) as Element;
  copy.removeAttribute('id');
  copy.removeAttribute('class'); // not a « g.note »: it is never touched, found or measured
  for (const d of copy.querySelectorAll('[id]')) d.removeAttribute('id');
  hi.appendChild(copy);
  return copy;
}

function xAt(pts: Pt[], t: number): number {
  if (!pts.length) return 0;
  const lo = lastAtOrBefore(pts, t, byT);
  const a = pts[lo];
  const b = pts[lo + 1];
  if (!b || b.t <= a.t) return a.x;
  return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
}

/** The followed part's name, top left of the line: touch it to follow another part (the same as
 *  the eye in the track list). */
function VoicePicker({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  const mv = movement.value;
  const me = myPart.value;
  const parts = mv?.parts ?? [];
  return (
    <div class="voice-pick" ref={box}>
      <button
        class="lane-voice"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={tt('Voix suivie : {name}. Choisir une autre voix', { name })}
        title={tt('Choisir la voix suivie')}
        disabled={parts.length < 2}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="eye" size={15} />
        {name}
        {parts.length > 1 && <Icon name="chevron" size={13} />}
      </button>
      {open && (
        <div class="voice-menu" role="radiogroup" aria-label={tt('Voix suivie')}>
          {parts.map((p) => (
            <button
              role="radio"
              aria-checked={p.id === me}
              class={p.id === me ? 'on' : ''}
              onClick={() => {
                if (p.id !== me) followPart(p.id);
                setOpen(false);
              }}
            >
              {partLabel(p.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** « Entrée mesure 17 (dans 7 mesures) », or a shorter form, the longest one that fits in the
 *  header row beside the voice and the score's information (the key's name stays visible). */
function entryText(el: HTMLElement, nn: number | string, k: number): string {
  const forms = [
    k >= 2 ? tt('Entrée mesure {n} (dans {k} mesures)', { n: nn, k }) : tt('Entrée mesure {n}', { n: nn }),
    k >= 2 ? tt('Entrée mes. {n} (dans {k})', { n: nn, k }) : tt('Entrée mes. {n}', { n: nn }),
    tt('Entrée mes. {n}', { n: nn }),
    tt('→ mes. {n}', { n: nn }),
  ];
  const head = el.parentElement;
  if (!head) return forms[1];
  // the room left in the row (read only when the text is to change: once a measure at most)
  let used = 0;
  for (const c of head.children) if (c !== el) used += (c as HTMLElement).offsetWidth + 10;
  const room = head.clientWidth - used - 14; // the label's own padding
  return forms.find((f) => f.length * 7.3 <= room) ?? forms[forms.length - 1];
}

/** What the score says where the music is, for the followed part: its clef(s), the key signature,
 *  the time signature and the key's name when known; under the key's name, small, the pitch the
 *  app's sounds are tuned to (it takes no room in the row). Re-rendered alone at each new measure. */
function LaneInfo({ staves }: { staves: number[] }) {
  const mv = movement.value;
  const n = now.value;
  const i = n.mv === mv ? n.i : 0;
  const m = mv?.measures[i];
  if (!mv || !m) return null;
  const clefs = staves.map((st) => clefAt(mv, st, i)).filter((c) => c !== null);
  const fifths = fifthsOf(m);
  const key = keyNameAt(mv, i);
  const name = key && keyLabel(key); // in the language shown
  const [num, den] = m.ts;
  const said = [...clefs.map(clefWords), tt('armure : {sig}', { sig: signatureWords(fifths) }), tt('mesure à {num}/{den}', { num, den }), name ? tt('ton : {name}', { name }) : '', tt('diapason : la {hz} Hz', { hz: LA_HZ })]
    .filter(Boolean)
    .join(', ');
  return (
    <span class="lane-info" role="note" aria-label={said}>
      {clefs.length > 0 && (
        <span class={`li-clefs ${clefs.length > 1 ? 'two' : ''}`}>
          {clefs.map((c) => (
            <ClefGlyph clef={c} px={clefs.length > 1 ? 11 : 14} />
          ))}
        </span>
      )}
      <SignatureGlyph fifths={fifths} px={24} />
      <span class="li-ts" aria-hidden="true">
        <b>{num}</b>
        <b>{den}</b>
      </span>
      <span class="li-tone" aria-hidden="true">
        {name && (
          <span class="li-key">
            <span class="long">{name}</span>
            <span class="short">{shortKeyName(name)}</span>
          </span>
        )}
        <span class="li-pitch" title={tt('Diapason : le la3 sonne à {hz} Hz', { hz: LA_HZ })}>
          {tt('la {hz} Hz', { hz: LA_HZ })}
        </span>
      </span>
    </span>
  );
}
