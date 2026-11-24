// The printed pages (photos of the choir's edition), with the current measure lit up.
// Click a measure to play from there. Pages turn by themselves while playing.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Movement, Page, PageMeasure } from '../pack/types';
import { movement, myPart, nextMovement, openMovement, playing, position, prefs, previousMovement, seekParked, startFrom, tracksOpen, tracksRoom, work } from '../state';
import { measureIndexAt, ticker } from './timing';
import { canHover, phoneLayout, reducedMotion } from './media';
import { Icon } from './Icon';
import { useDismiss } from './popover';
import { releaseFocus } from './Volume';
import { now } from './now';
import { markAt } from './timing';
import { pageRanges } from '../score/info';
import { movementNumber } from './Bars';
import { tt } from '../i18n';

const NAV_ROOM = 64; // px kept clear above the bottom of the pages (phones: the navigator's place)
const HEAD = 12; // px kept clear above the music brought into sight
const GAP = 18; // px between two pages side by side
const PAD = 8; // px above and below the pages on a wide screen (styles.css)
export const LIST_W = 388; // px: the unfolded track list on a wide screen (styles.css: --console)

/** A work's pages as the layout needs them (their own pixels): the first page's width, the largest
 *  width and height, how far down the music goes on any of them (`low`; the paper's bottom
 *  edge when the measures are not placed), and the height of the tallest system (`sys`: of the
 *  tallest measure box; 0 when the measures are not placed). */
export function paperOf(pages: Pick<Page, 'w' | 'h' | 'measures'>[]) {
  const first = pages[0] ?? { w: 1300, h: 1900 };
  let w = first.w;
  let h = first.h;
  let low = 0;
  let sys = 0;
  for (const p of pages) {
    w = Math.max(w, p.w);
    h = Math.max(h, p.h);
    for (const b of p.measures) {
      low = Math.max(low, b.y1);
      sys = Math.max(sys, b.y1 - b.y0);
    }
  }
  return { first: first.w, w, h, low: low || h, sys };
}

/** How the pages fill their area (px).
 *  The phone layout (`phone`; any area narrower than 720 px): one page fitted to its width, which
 *  scrolls. A screen lying down that shows the page alone has it across the whole screen (720 px
 *  or more), where a system of the score is taller than the area on a phone: the followed voice
 *  is then kept in sight (followTop). But where a whole system can be shown above the navigator
 *  on a page at least 60 % as wide (a tablet), the page is that size, in the middle: all the
 *  voices and the accompaniment are read at once.
 *  Wide screens: whole pages fitted to the height, two side by side when there is room. Every page of
 *  the work has the same scale (nothing changes size when a page turns): the tallest fits, and
 *  the music of each stays above the navigator, which floats over the paper's bottom margin
 *  (`nav`: px it takes above the bottom of the area).
 *  `list`: the width of the track list at the bottom left of the area (wide screens), 0 without
 *  it. Where the pages go depends on the window alone, never on the list being folded or not
 *  (folding it cannot make them larger: they would only jump). When the same pages fit beside
 *  the list (`room`), they move over just as far as it takes to clear it (`dock`: px taken from
 *  the left of the area, the pages centred in the rest; 0 while their margin holds the list).
 *  Otherwise they stay centred in the area, the list over them until it is folded. */
export function fitPages(size: { w: number; h: number }, paper: ReturnType<typeof paperOf>, list = 0, nav = 0, phone = false) {
  if (phone || size.w < 720) {
    let scale = Math.max(0, size.w - 16) / paper.first;
    if (phone && size.w >= 720 && paper.sys) {
      const whole = (size.h - NAV_ROOM - 24) / paper.sys; // 12 px above and below the system
      if (whole < scale && whole >= 0.6 * scale) scale = whole;
    }
    return { narrow: true, count: 1, scale, dock: 0, room: false };
  }
  const tall = Math.min((size.h - 2 * PAD) / paper.h, (size.h - PAD - nav) / paper.low);
  const fit = (w: number) => {
    let scale = tall;
    const count = Math.max(1, Math.min(2, Math.floor((w - 40 + GAP) / (paper.w * scale + GAP))));
    if (count === 1 && paper.w * scale > w - 40) scale = (w - 40) / paper.w;
    return { narrow: false, count, scale, width: count * paper.w * scale + (count - 1) * GAP };
  };
  const pages = fit(size.w);
  const room = !list || pages.width <= size.w - list - 40;
  // 12 px between the list and the first page
  const dock = room && list ? Math.max(0, 2 * (list + 12) - (size.w - pages.width)) : 0;
  return { ...pages, dock, room };
}

interface Spot {
  page: number; // index in the work's pages
  box: PageMeasure;
}

/** The followed voice's band inside a system of a printed page: its staff (or staves) with the room
 *  around it (ledger lines above, the lyrics below), without reaching the neighbouring staves.
 *  null when the staves of that system are not known. Page pixels. */
export function voiceBand(sys: Page['systems'][number] | undefined, staffNums: number[]): { y0: number; y1: number } | null {
  const st = sys?.staves;
  if (!st || !staffNums.length) return null;
  const lo = Math.min(...staffNums);
  const hi = Math.max(...staffNums);
  if (lo < 1 || hi > st.length) return null;
  const first = st[lo - 1];
  const last = st[hi - 1];
  const h = first.bottom - first.top; // one staff's height
  const prev = st[lo - 2];
  const next = st[hi];
  // above: some of the gap (the lyrics in it belong to the staff above); below: the lyrics
  const y0 = first.top - (prev ? Math.min(0.6 * h, 0.4 * (first.top - prev.bottom)) : 0.6 * h);
  const y1 = next ? next.top - Math.min(0.5 * h, 0.25 * (next.top - last.bottom)) : last.bottom + 1.1 * h;
  return { y0, y1: Math.max(y1, last.bottom + 0.3 * h) };
}

/** Where to scroll (px from the top of the pages) to keep the measure being played in sight, or
 *  null when it already is. `clear`: the height of the area above the navigator; `top`, `h`: the
 *  measure's system; `band`: the followed voice's staff in it (voiceBand), when known; `choir`:
 *  the voices of that system, without the accompaniment under them, when the followed part is
 *  one of them; `head`: the room kept clear at the top of the area (enlarged pages: « Page
 *  entière » floats there, over the pages).
 *  A system that fits is shown whole, from its top. A taller one (enlarged pages, a phone lying
 *  down with the page across the screen) cannot be. The accompaniment is given up first: while
 *  the voices fit, the system is shown from its top, the end of the piano under the navigator.
 *  When they do not all fit, the followed voice is put in the middle of what is clear, without
 *  leaving the voices (a soprano sees the top of the system, a bass has its words just above
 *  the navigator); the accompanist, without leaving the system (its bottom). The followed voice
 *  comes before the room at the top: where its staff alone needs that height, the room is the
 *  usual one.
 *  `arrived`: the music has just come to this system (the next one, another page, a jump): it is
 *  placed; within a system nothing moves while the voice's staff is in sight (the page is left
 *  where the user put it). Without the staves, the top of the system, as ever. */
export function followTop(
  scrollTop: number,
  clear: number,
  top: number,
  h: number,
  band: { top: number; h: number } | null,
  arrived = false,
  choir: { top: number; h: number } | null = null,
  head = HEAD,
): number | null {
  if (band && band.h > clear - head - 2) head = HEAD;
  const fits = h <= clear - head + 2;
  if (fits || !band) return top < scrollTop + head - 2 || top + h > scrollTop + clear ? top - head : null;
  if (!arrived && band.top >= scrollTop + head - 2 && band.top + band.h <= scrollTop + clear) return null;
  let to = band.top - head; // the voice alone is taller than the area: its top
  if (band.h < clear - head + 2) {
    const middle = band.top + band.h / 2 - (clear + head - 2) / 2;
    const lo = Math.min(top, band.top) - head;
    // how far down the view may be asked to show: the followed voice and the end of its system
    // stay 12 px above what the navigator leaves clear; the last of the voices may go down to
    // the navigator itself (12 px lower: its staff ends with room for its words)
    const low = choir ? Math.max(choir.top + choir.h - 12, band.top + band.h + 12) : Math.max(top + h, band.top + band.h) + 12;
    to = Math.max(lo, Math.min(middle, low - clear)); // the top first when it all fits
  }
  return Math.abs(to - scrollTop) < 1 ? null : to;
}

/** The room above the paper in the scrolled area (px). */
const paperTop = (area: HTMLElement) => area.querySelector<HTMLElement>('.sheet')?.offsetTop ?? 0;

/** For each measure index of the movement, where it is printed. */
function spotsFor(pages: Page[], mv: Movement): (Spot | null)[] {
  const byN = new Map<number, Spot>();
  pages.forEach((p, i) => p.measures.forEach((b) => b.mv === mv.id && byN.set(b.n, { page: i, box: b })));
  return mv.measures.map((m) => byN.get(parseInt(m.n, 10)) ?? null);
}

export function PageView() {
  const w = work.value;
  const mv = movement.value;
  const pages = w?.pack.pages ?? [];
  const spots = useMemo(() => (mv ? spotsFor(pages, mv) : []), [w, mv]);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // false while the area is not displayed (a phone lying down that shows the line alone)
  const [shown, setShown] = useState(true);
  const shownRef = useRef(true);
  const cameBack = useRef(false); // it has just come back: the next look goes straight to the measure
  const turned = useRef(-1); // the first page shown when the measure was last looked for
  const [first, setFirst] = useState(0); // first visible page index
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // the point under the fingers stays under them while zooming (applied after the new layout)
  const anchor = useRef<{ u: number; v: number; cx: number; cy: number; slot: number } | null>(null);
  const manualAt = useRef(0);
  const [hover, setHover] = useState<{ page: number; box: PageMeasure } | null>(null);

  // the area of the pages is there only for a work that has pages: what is attached to it is
  // attached when it comes (a work without pages may be the first one opened), detached when it goes
  const hasPages = pages.length > 0;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // Wide screens: the area's outer size, scroll bars included. Enlarged pages bring scroll bars,
    // which take 10 to 17 px from the inner size on a computer: fitted to it, the pages made a
    // loop at the zoom where they just fill the width (a horizontal bar comes, the area is less
    // high, the pages are fitted smaller and no longer need the bar, it goes, they grow...: they
    // trembled between two sizes, at every frame). Phones: the inner size, as ever (their scroll
    // bars take no room; in a narrow window on a computer the page fits beside the bar).
    const ro = new ResizeObserver(() => {
      const [w, h] = phoneLayout() ? [el.clientWidth, el.clientHeight] : [el.offsetWidth, el.offsetHeight];
      // not displayed: the last size is kept (nothing is laid out for a size of 0), and the pages
      // go on following the music, so that the right one is there when they come back
      if (!w && !h) {
        shownRef.current = false;
        return setShown(false);
      }
      if (!shownRef.current) cameBack.current = true;
      shownRef.current = true;
      setShown(true);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasPages]);

  // when the movement changes, show its first page
  useEffect(() => {
    const s = spots.find((x) => x);
    if (s) setFirst(s.page);
  }, [mv?.id]);

  // layout: whole pages fitted to the height; two side by side when there is room (fitPages)
  const gap = GAP;
  const paper = useMemo(() => paperOf(pages), [w]);
  const wide = !phoneLayout();
  // the navigator's place above the bottom of the area: thinner under a mouse (styles.css)
  const { narrow, count, scale: fit, dock, room } = fitPages(size, paper, wide ? LIST_W : 0, canHover() ? 42 : 52, !wide);
  // the navigator is centred under the pages; where the list is over them, it comes out from
  // under it when what is left can hold it
  const aside = dock || (wide && !room && tracksOpen.value && size.w - LIST_W >= 400 ? LIST_W : 0);
  // until the user folds or unfolds the track list: unfolded where it is not over the pages
  useEffect(() => {
    if (wide && (size.w > 0 || !pages.length)) tracksRoom(room || !pages.length);
  }, [wide, room, size.w > 0, pages.length]);
  // the pages' own zoom (pinch, Ctrl + wheel): only the pages grow, the rest of the screen stays
  const scale = fit * zoom;
  const start = Math.max(0, Math.min(first, pages.length - count));
  const visible = pages.slice(start, start + count).map((p, k) => ({ p, idx: start + k }));

  const flip = (d: number) => {
    manualAt.current = Date.now();
    setFirst((f) => Math.max(0, Math.min(pages.length - count, f + d * count)));
    if (host.current) host.current.scrollTop = 0; // phones: top of the new page
  };

  const flipRef = useRef(flip);
  flipRef.current = flip;

  // « Aller à » : a printed page (browsed, like a page turn) or a measure (the music goes there)
  const [goto, setGoto] = useState(false);
  const navBox = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useDismiss(goto, navBox, () => setGoto(false));
  const showPage = (k: number) => {
    manualAt.current = Date.now();
    setFirst(Math.max(0, Math.min(pages.length - count, k)));
    if (host.current) host.current.scrollTop = 0;
  };
  const goMeasure = (t: number) => {
    manualAt.current = 0; // the pages follow the music there at once
    seekParked(t);
  };

  // zoom with two fingers (phones, tablets), Ctrl or ⌘ + wheel, a trackpad pinch or the slider
  // at the right of the pages (computers)
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const dockRef = useRef(dock);
  dockRef.current = dock;
  // wide screens: the zoom was made at a point (wheel, pinch): the view stays on it, instead of
  // going to the measure being played as it does after the slider
  const pointed = useRef(false);
  /** Zooms to `z`, the point of the pages under (cx, cy) (the middle of the area when not given)
   *  staying where it is on the screen, as far as the area scrolls. */
  const zoomAt = (z: number, cx?: number, cy?: number) => {
    const el = host.current;
    if (!el) return;
    z = Math.max(1, Math.min(3, z)); // beyond 3x the photos (1300 px wide) only get blurrier
    if (Math.abs(z - zoomRef.current) < 0.005) return;
    const r = el.getBoundingClientRect();
    pointed.current = cx !== undefined && !narrowRef.current;
    cx ??= r.left + (r.width + dockRef.current) / 2; // of what the track list leaves
    cy ??= r.top + r.height / 2;
    if (narrowRef.current) {
      // phones: the page fills the width, the area scrolls from its top left corner; above the
      // paper, a room that is larger once the pages are enlarged (styles.css: « Page entière »)
      anchor.current = { u: (el.scrollLeft + cx - r.left) / scaleRef.current, v: (el.scrollTop + cy - r.top - paperTop(el)) / scaleRef.current, cx: cx - r.left, cy: cy - r.top, slot: -1 };
    } else {
      // whole pages, centred while they fit, beside the track list: the point is kept as a place
      // on the page it is on (or the nearest), 0..1 across and down
      const rects = [...el.querySelectorAll('.sheet')].map((e) => e.getBoundingClientRect());
      const off = (q: DOMRect) => Math.max(q.left - cx!, cx! - q.right, 0);
      const slot = rects.reduce((best, q, k) => (off(q) < off(rects[best]) ? k : best), 0);
      const q = rects[slot];
      if (q) anchor.current = { u: (cx - q.left) / q.width, v: (cy - q.top) / q.height, cx, cy, slot };
    }
    setZoom(z);
  };
  useLayoutEffect(() => {
    const el = host.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    const q = a.slot >= 0 ? el.querySelectorAll('.sheet')[a.slot]?.getBoundingClientRect() : null;
    if (q) {
      // as far as the area scrolls: pages that still fit in the width stay in its middle, as
      // in any reader of documents
      el.scrollLeft += q.left + a.u * q.width - a.cx;
      el.scrollTop += q.top + a.v * q.height - a.cy;
    } else if (a.slot < 0) {
      el.scrollLeft = a.u * scale - a.cx;
      el.scrollTop = paperTop(el) + a.v * scale - a.cy;
    }
  }, [zoom]);
  // a mouse drags the enlarged pages about, as a finger does (a press without moving still
  // plays from the measure under it: onClick)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const draggedAt = useRef(0);
  const onDragStart = (e: PointerEvent) => {
    const el = host.current;
    if (!el || e.pointerType !== 'mouse' || e.button !== 0 || zoomRef.current <= 1.01) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  };
  const onDragMove = (e: PointerEvent) => {
    const el = host.current;
    const d = drag.current;
    if (!el || !d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      el.setPointerCapture(e.pointerId); // followed outside the pages too
      el.classList.add('dragged');
    }
    el.scrollLeft = d.left - dx;
    el.scrollTop = d.top - dy;
  };
  const onDragEnd = () => {
    if (drag.current?.moved) {
      draggedAt.current = Date.now();
      host.current?.classList.remove('dragged');
    }
    drag.current = null;
  };
  // Touch: one finger scrolls (the browser alone, never waiting for JS: every listener here is
  // passive), a quick swipe turns the page, two fingers zoom. Only during a pinch is a blocking
  // touchmove listener attached, so that the browser does not also scroll or zoom the screen.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let swipe: { x: number; y: number; t: number } | null = null;
    let pinch: { d0: number; z0: number } | null = null;
    let raf = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onPinchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault(); // the browser must not zoom the whole screen
      const t = e.touches;
      const z = (pinch.z0 * dist(t)) / pinch.d0;
      const cx = (t[0].clientX + t[1].clientX) / 2;
      const cy = (t[0].clientY + t[1].clientY) / 2;
      cancelAnimationFrame(raf); // one layout per frame at most
      raf = requestAnimationFrame(() => zoomAt(z, cx, cy));
    };
    const endPinch = () => {
      if (!pinch) return;
      pinch = null;
      el.removeEventListener('touchmove', onPinchMove);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches;
      swipe = t.length === 1 ? { x: t[0].clientX, y: t[0].clientY, t: Date.now() } : null; // two fingers: not a swipe
      if (t.length === 2) {
        if (!pinch) el.addEventListener('touchmove', onPinchMove, { passive: false });
        pinch = { d0: dist(t), z0: zoomRef.current };
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) endPinch();
      const s0 = swipe;
      swipe = null;
      if (e.type !== 'touchend' || !s0 || zoomRef.current > 1.01) return; // zoomed in: a swipe moves around the page
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s0.x;
      const dy = t.clientY - s0.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.6 * Math.abs(dy) && Date.now() - s0.t < 700) flipRef.current(dx < 0 ? 1 : -1);
    };
    const onWheel = (e: WheelEvent) => {
      // Ctrl (or ⌘ on a Mac) + wheel, or a trackpad pinch. The wheel alone is left to moving
      // around the enlarged pages: a trackpad's two-finger scroll sends the same events
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // a pinch sends many small steps; a mouse wheel one large step per notch (100 px or more,
      // or 3 lines): at most 22 % per event, where a notch used to jump to the largest size
      const d = Math.max(-20, Math.min(20, e.deltaY * (e.deltaMode === 1 ? 33 : 1)));
      zoomAt(zoomRef.current * Math.exp(-d * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      endPinch();
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [hasPages]);

  // live highlight + page following
  const lit = useRef<HTMLDivElement>(null);
  const litVoice = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null); // « Page entière », over the top of enlarged pages
  const me = myPart.value;
  const live = useRef({ start, count, scale, narrow, zoomed: zoom > 1.01 });
  live.current = { start, count, scale, narrow, zoomed: zoom > 1.01 };
  useEffect(() => {
    let lastIdx = -2;
    // not '' : the highlight may still show where the previous run of this effect put it (a page
    // turned during playback re-runs it): the first look hides it if its measure is not shown
    let lastKey = 'previous';
    let lastSt = -1;
    let anim: Animation | null = null;
    let reveal = false; // the music was moved (a jump while parked): bring its measure into sight once
    let quiet = pointed.current; // just zoomed at a point: the view stays there
    pointed.current = false;
    // straight to the measure, without gliding there: the area was hidden, or the page has just
    // turned (a glide would cross the whole of the new page)
    let jump = cameBack.current || turned.current !== start;
    cameBack.current = false;
    turned.current = start;
    let lastSys = ''; // the system of the measure last placed
    // Where each visible sheet sits among the sheets, read once (this effect starts again whenever
    // the pages shown or their size change): reading it at every look made the browser bring the
    // running animations up to date on the main thread each time (a main frame per look).
    const placed = new Map<number, { el: HTMLElement; ox: number; oy: number }>();
    const sheetAt = (slot: number) => {
      let p = placed.get(slot);
      if (!p) {
        const el = host.current?.querySelectorAll<HTMLElement>('.sheet')[slot];
        if (!el) return null;
        placed.set(slot, (p = { el, ox: el.offsetLeft, oy: el.offsetTop }));
      }
      return p;
    };
    const hide = () => {
      lit.current!.style.opacity = '0';
      if (litVoice.current) litVoice.current.style.opacity = '0';
      line.current!.style.opacity = '0';
      anim?.cancel();
      anim = null;
      lastKey = '';
    };
    const tick = (): number => {
      const m = movement.value;
      if (!m || !lit.current || !line.current) return 100;
      const st = position();
      const moved = st !== lastSt;
      if (!moved && !playing.value && anim?.playState !== 'running') return 100;
      lastSt = st;
      if (moved) reveal = true;
      const i = measureIndexAt(m, st);
      const spot = spots[i];
      const { start: s0, count: c, scale: sc } = live.current;
      if (!spot) {
        if (lastKey) hide();
        return 100;
      }
      // follow the music when it leaves the visible pages (not right after a manual flip)
      if ((spot.page < s0 || spot.page >= s0 + c) && Date.now() - manualAt.current > 4000) {
        setFirst(spot.page);
        return 30;
      }
      const slot = spot.page - s0;
      const at = slot >= 0 && slot < c ? sheetAt(slot) : null;
      if (!at) {
        // the current measure is on a page not shown (the user is browsing other pages)
        if (lastKey) hide();
        lastIdx = -2;
        return 100;
      }
      const { el: sheet, ox, oy } = at;
      const b = spot.box;
      const next = m.measures[i + 1];
      const t0 = m.measures[i].t;
      const t1 = next ? next.t : m.durationMs;
      const isPlaying = playing.value;
      const key = `${i}|${ox}|${oy}|${sc}`;
      if (key !== lastKey) {
        // shown again after being hidden, or the pages changed (turned, zoomed): straight to its
        // place; from one measure to the next: a short glide
        const transition = lastKey === '' || lastKey === 'previous' ? 'none' : '';
        lastKey = key;
        // moved by a transform (their own compositor layers): going to the next measure repaints
        // nothing of the page under them and their short glide does not run on the main thread
        Object.assign(lit.current.style, {
          transition,
          transform: `translate(${ox + b.x0 * sc}px, ${oy + b.y0 * sc}px)`,
          width: `${(b.x1 - b.x0) * sc}px`,
          height: `${(b.y1 - b.y0) * sc}px`,
          opacity: '1',
        });
        // the followed voice inside the measure, in its own colour
        const part = m.parts.find((p) => p.id === me);
        const system = pages[spot.page]?.systems[b.sys];
        const band = part ? voiceBand(system, part.staves) : null;
        if (litVoice.current) {
          if (band)
            Object.assign(litVoice.current.style, {
              transition,
              transform: `translate(${ox + b.x0 * sc}px, ${oy + band.y0 * sc}px)`,
              width: `${(b.x1 - b.x0) * sc}px`,
              height: `${(band.y1 - band.y0) * sc}px`,
              opacity: '1',
            });
          else litVoice.current.style.opacity = '0';
        }
        lit.current.classList.toggle('with-voice', !!band);
        // the navigator fades when the current measure passes under it (wide screens: the pages
        // do not scroll there)
        const nav = navRef.current;
        const sheets = lit.current.parentElement;
        if (nav && sheets && !live.current.narrow) {
          const sr = sheets.getBoundingClientRect();
          const nr = nav.getBoundingClientRect();
          const l = sr.left + ox + b.x0 * sc;
          const t = sr.top + oy + (band ? band.y0 : b.y0) * sc;
          const r = sr.left + ox + b.x1 * sc;
          const btm = sr.top + oy + (band ? band.y1 : b.y1) * sc;
          nav.classList.toggle('dodge', l < nr.right && r > nr.left && t < nr.bottom && btm > nr.top);
        } else nav?.classList.remove('dodge');
        line.current.style.height = `${(b.y1 - b.y0) * sc}px`;
        // the line crosses the measure on the compositor: nothing to redraw at each frame. The
        // first beat is on the barline; in the first measure of a system the clef and the key
        // signature stand between the barline and the notes: it starts after them (xn)
        anim?.cancel();
        const y = oy + b.y0 * sc;
        anim = line.current.animate(
          [{ transform: `translate(${ox + (b.xn ?? b.x0) * sc}px, ${y}px)` }, { transform: `translate(${ox + b.x1 * sc}px, ${y}px)` }],
          { duration: Math.max(1, t1 - t0), fill: 'both', easing: 'linear' },
        );
        anim.pause();
        anim.currentTime = st - t0;
        if (i !== lastIdx && shown && (live.current.narrow || live.current.zoomed) && (isPlaying || (reveal && !quiet))) {
          // keep the current measure in sight (phones, zoomed pages), also after « Aller à » a
          // measure while parked: it would otherwise stay where it is, possibly under the navigator
          const box = host.current!;
          const r = box.getBoundingClientRect();
          const sr = sheet.getBoundingClientRect();
          const y = box.scrollTop + sr.top - r.top; // the sheet's top in the scrolled area
          const top = y + b.y0 * sc;
          const left = box.scrollLeft + sr.left - r.left + b.x0 * sc;
          const h = (b.y1 - b.y0) * sc;
          const w = (b.x1 - b.x0) * sc;
          const to: ScrollToOptions = { behavior: jump || reducedMotion() ? 'auto' : 'smooth' };
          // the page navigator floats over the bottom of the pages: the measure stays above it
          const clear = box.clientHeight - NAV_ROOM; // px of the area above the navigator
          const sys = `${spot.page}:${b.sys}`;
          // the voices of the system, without the accompaniment: what is kept in sight when the
          // system is taller than the area
          const choir = part?.kind === 'voice' && band ? voiceBand(system, m.parts.filter((p) => p.kind === 'voice').flatMap((p) => p.staves)) : null;
          // enlarged pages: « Page entière » floats over their top, the music is brought under it
          const btn = resetRef.current?.getBoundingClientRect();
          const head = btn?.height ? btn.bottom - r.top + 6 : HEAD;
          const place = followTop(
            box.scrollTop,
            clear,
            top,
            h,
            band && { top: y + band.y0 * sc, h: (band.y1 - band.y0) * sc },
            sys !== lastSys,
            choir && { top, h: y + choir.y1 * sc - top },
            head,
          );
          lastSys = sys;
          jump = false;
          if (place !== null) to.top = place;
          if (left < box.scrollLeft + 10 || left + w > box.scrollLeft + box.clientWidth - 10) to.left = left - 24;
          if (to.top !== undefined || to.left !== undefined) box.scrollTo(to);
        }
        lastIdx = i;
        reveal = false;
        quiet = false;
      }
      const op = isPlaying ? '1' : '0.55';
      if (line.current.style.opacity !== op) line.current.style.opacity = op;
      if (!anim) return 100;
      if (isPlaying) {
        const rate = prefs.value.rate || 1;
        if (anim.playbackRate !== rate) anim.playbackRate = rate;
        if (anim.playState !== 'running') {
          anim.currentTime = st - t0;
          if (moved) anim.play();
        } else if (moved && Math.abs(Number(anim.currentTime) - (st - t0)) > 40) anim.currentTime = st - t0;
      } else {
        if (anim.playState === 'running') anim.pause();
        if (moved) anim.currentTime = st - t0;
        return 100;
      }
      // next look: when the measure ends (or soon, while waiting for the music to start)
      if (anim.playState !== 'running') return 16;
      return (t1 - st) / (prefs.value.rate || 1) + 2;
    };
    const stop = ticker(tick);
    return () => {
      stop();
      anim?.cancel();
    };
  }, [spots, start, count, scale, me, shown]);

  // the next and previous pages are fetched ahead: a page turned during playback appears at once
  useEffect(() => {
    if (!w) return;
    for (const i of [start + count, start - 1]) {
      const p = pages[i];
      if (p) new Image().src = w.url(p.img);
    }
  }, [w, start, count]);

  // keyboard page turns
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      if (e.code === 'PageDown') (e.preventDefault(), flip(1));
      if (e.code === 'PageUp') (e.preventDefault(), flip(-1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pages.length, count]);

  const boxAt = (p: Page, e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / scale;
    const y = (e.clientY - r.top) / scale;
    return p.measures.find((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) ?? null;
  };

  const onClick = (p: Page, e: MouseEvent) => {
    if (Date.now() - draggedAt.current < 250) return; // the end of a drag, not a press
    const b = boxAt(p, e);
    if (!b || !w) return;
    if (b.mv !== mv?.id) openMovement(b.mv);
    const m = w.pack.movements.find((x) => x.id === b.mv)!;
    const i = m.measures.findIndex((x) => parseInt(x.n, 10) === b.n);
    if (i >= 0) {
      manualAt.current = 0;
      startFrom(m.measures[i].t);
    }
  };

  if (!pages.length) return <div class="pages-wrap empty-pages">{tt('Pas d’images de pages pour cette œuvre.')}</div>;

  const pageLabel = [...new Set(visible.map((v) => v.p.page))].join('–');
  const atStart = start === 0;
  const atEnd = start + count >= pages.length;
  return (
    <div class={`pages-wrap ${narrow ? 'narrow' : ''}`} style={aside ? { '--list': `${aside}px` } : undefined}>
    <div
      class={`pages ${narrow ? 'narrow' : ''} ${zoom > 1.01 ? 'zoomed' : ''}`}
      ref={host}
      style={dock ? { paddingLeft: `${dock}px` } : undefined}
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      <div class="sheets" style={{ gap: `${gap}px` }}>
        {visible.map(({ p, idx }) => (
          <div
            class="sheet"
            key={idx}
            style={{ width: `${p.w * scale}px`, height: `${p.h * scale}px` }}
            onClick={(e) => onClick(p, e)}
            onPointerMove={(e) => {
              // a mouse only: after a tap, the emulated mouse events would leave the box behind
              if (e.pointerType !== 'mouse' || !canHover()) return;
              const b = boxAt(p, e);
              // re-render only when the measure under the mouse changes, not at every move
              setHover((h) => (h?.box === b && h?.page === idx ? h : b ? { page: idx, box: b } : null));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <img src={w!.url(p.img)} alt={tt('Page {n}', { n: p.page })} draggable={false} decoding="async" />
            {hover && hover.page === idx && (
              <div
                class="hover-box"
                style={{
                  left: `${hover.box.x0 * scale}px`,
                  top: `${hover.box.y0 * scale}px`,
                  width: `${(hover.box.x1 - hover.box.x0) * scale}px`,
                  height: `${(hover.box.y1 - hover.box.y0) * scale}px`,
                }}
              >
                <span>▶ {tt('mes.')} {hover.box.n}</span>
              </div>
            )}
          </div>
        ))}
        <div class="lit" ref={lit} />
        <div class="lit-voice" ref={litVoice} />
        <div class="playline" ref={line} />
      </div>
    </div>
      {zoom > 1.01 && (
        <button class="zoom-reset" ref={resetRef} onClick={() => setZoom(1)} title={tt('Revenir à la page entière')}>
          {tt('Page entière')}
        </button>
      )}
      {wide && canHover() && (
        // computers: the zoom within reach of the mouse (fingers pinch)
        <label class="zoom" title={tt('Agrandir les pages : {n} % (aussi Ctrl + molette)', { n: Math.round(zoom * 100) })}>
          <Icon name="zoom" size={18} />
          <input type="range" min={1} max={3} step={0.05} value={zoom} aria-label={tt('Agrandir les pages')} onInput={(e) => zoomAt(+(e.target as HTMLInputElement).value)} onPointerUp={releaseFocus} />
        </label>
      )}
      <div class={`page-nav-box ${narrow ? 'narrow' : ''}`} ref={navBox}>
        <nav class="page-nav" ref={navRef} aria-label={tt('Pages et mesures')}>
          <MvSkip dir={-1} />
          <button class="pn-turn" aria-label={tt('Page précédente')} title={tt('Page précédente (Page préc.)')} disabled={atStart} onClick={() => flip(-1)}>
            <Icon name="chevron-left" size={20} />
          </button>
          <button
            class="pn-where"
            aria-haspopup="dialog"
            aria-expanded={goto}
            title={tt('Aller à une page ou à une mesure')}
            onClick={() => setGoto((g) => !g)}
          >
            <span class="pn-page">
              {narrow ? tt('p.') : count > 1 ? tt('Pages') : tt('Page')} {pageLabel}
            </span>
            <NavMeasure short={narrow} />
          </button>
          <button class="pn-turn" aria-label={tt('Page suivante')} title={tt('Page suivante (Page suiv.)')} disabled={atEnd} onClick={() => flip(1)}>
            <Icon name="chevron-right" size={20} />
          </button>
          <MvSkip dir={1} />
        </nav>
        {goto && mv && <GoTo pages={pages} mv={mv} onPage={showPage} onMeasure={goMeasure} onClose={() => setGoto(false)} />}
      </div>
    </div>
  );
}

/** At the ends of the navigator: ⏮ back to the start of the movement (already there: the
 *  previous movement), ⏭ the next movement. Re-rendered alone, at each new measure. */
function MvSkip({ dir }: { dir: 1 | -1 }) {
  const w = work.value;
  const mv = movement.value;
  const n = now.value;
  if (!w || !mv) return null;
  const list = w.pack.movements;
  const k = list.findIndex((m) => m.id === mv.id);
  if (dir > 0) {
    const next = list[k + 1];
    return (
      <button class="pn-mv" aria-label={tt('Mouvement suivant')} title={next ? tt('Mouvement suivant : {title}', { title: next.title }) : tt('Dernier mouvement')} disabled={!next} onClick={nextMovement}>
        <Icon name="mv-next" size={18} />
      </button>
    );
  }
  const atStart = (n.mv === mv ? n.i : 0) === 0 && position() < 2000;
  const prev = list[k - 1];
  const label = atStart && prev ? tt('Mouvement précédent') : tt('Début du mouvement');
  return (
    <button class="pn-mv" aria-label={label} title={atStart && prev ? tt('Mouvement précédent : {title}', { title: prev.title }) : tt('Début du mouvement (encore : le mouvement précédent)')} disabled={atStart && !prev} onClick={previousMovement}>
      <Icon name="mv-prev" size={18} />
    </button>
  );
}

/** The current measure in the page navigator (re-rendered alone, at each new measure). */
function NavMeasure({ short }: { short: boolean }) {
  const mv = movement.value;
  const n = now.value;
  const i = n.mv === mv ? n.i : 0;
  const m = mv?.measures[i];
  if (!mv || !m) return null;
  const mark = short ? null : markAt(mv, i);
  return (
    <span class="pn-measure">
      <span class="pn-sep" aria-hidden="true">
        ·
      </span>
      {short ? tt('mes.') : tt('Mesure')} <b class="pn-n">{m.n}</b>
      {mark && <span class="pn-mark"> · {tt('repère')} {mark}</span>}
    </span>
  );
}

/** « Aller à » : two number fields, a printed page and a measure of the current movement. */
function GoTo({ pages, mv, onPage, onMeasure, onClose }: { pages: Page[]; mv: Movement; onPage: (k: number) => void; onMeasure: (t: number) => void; onClose: () => void }) {
  const [pg, setPg] = useState('');
  const [ms, setMs] = useState('');
  const [bad, setBad] = useState<'page' | 'measure' | null>(null);
  const msInput = useRef<HTMLInputElement>(null);
  // a keyboard at hand (computer): straight into the measure field; a phone: no keyboard popping up
  useEffect(() => {
    if (canHover()) msInput.current?.focus();
  }, []);
  const nums = pages.map((p) => p.page);
  const gaps = pageRanges(pages).includes(',');
  const first = mv.measures[0]?.n ?? '1';
  const last = mv.measures[mv.measures.length - 1]?.n ?? '1';
  const goPage = (e: Event) => {
    e.preventDefault();
    const k = nums.indexOf(parseInt(pg, 10));
    if (k < 0) return setBad('page');
    onPage(k);
    onClose();
  };
  const goMeasure = (e: Event) => {
    e.preventDefault();
    const i = mv.measures.findIndex((m) => parseInt(m.n, 10) === parseInt(ms, 10));
    if (i < 0) return setBad('measure');
    onMeasure(mv.measures[i].t);
    onClose();
  };
  return (
    <div
      class="pop goto"
      role="dialog"
      aria-label={tt('Aller à une page ou une mesure')}
      // Escape inside the popover closes it at once (the document listener comes one render later)
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div class="pop-title">{tt('Aller à')}</div>
      <form class={`goto-row ${bad === 'page' ? 'bad' : ''}`} onSubmit={goPage}>
        <label for="goto-page">{tt('Page')}</label>
        <input
          id="goto-page"
          type="number"
          inputMode="numeric"
          enterKeyHint="go"
          placeholder={`${Math.min(...nums)}–${Math.max(...nums)}`}
          value={pg}
          onInput={(e) => (setPg((e.target as HTMLInputElement).value), setBad(null))}
        />
        <button type="submit" class="pop-go">
          {tt('Aller')}
        </button>
        {(bad === 'page' || gaps) && (
          <small>
            {bad === 'page' ? `${tt('Pas de page {n}.', { n: pg })} ` : ''}{tt('Pages :')} {pageRanges(pages)}
          </small>
        )}
      </form>
      <form class={`goto-row ${bad === 'measure' ? 'bad' : ''}`} onSubmit={goMeasure}>
        <label for="goto-measure">{tt('Mesure')}</label>
        <input
          id="goto-measure"
          ref={msInput}
          type="number"
          inputMode="numeric"
          enterKeyHint="go"
          min={first}
          max={last}
          placeholder={`${first}–${last}`}
          value={ms}
          onInput={(e) => (setMs((e.target as HTMLInputElement).value), setBad(null))}
        />
        <button type="submit" class="pop-go">
          {tt('Aller')}
        </button>
        <small>
          {bad === 'measure' ? `${tt('Pas de mesure {n}.', { n: ms })} ` : ''}
          {movementNumber(mv.title) !== mv.title ? tt('Mouvement {mv}, mesures {first} à {last}', { mv: movementNumber(mv.title), first, last }) : tt('Mesures {first} à {last}', { first, last })}
        </small>
      </form>
    </div>
  );
}
