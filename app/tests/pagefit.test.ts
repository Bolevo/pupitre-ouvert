// The pages' layout (PageView › fitPages): whole pages as large as the area allows, the music
// above the navigator, and the place left to the track list on a wide screen.
import { describe, expect, it } from 'vitest';
import { fitPages, followTop, LIST_W, paperOf } from '../src/ui/PageView';

const box = (y1: number) => ({ mv: 'm', n: 1, sys: 0, x0: 100, x1: 400, y0: y1 - 200, y1 });
// two pages of a work: the second is taller, and its music goes lower
const pages = [
  { w: 1300, h: 1800, measures: [box(1690)] },
  { w: 1300, h: 1900, measures: [box(1810)] },
];
const paper = paperOf(pages);
const NAV = 42;

describe('paperOf', () => {
  it('takes the largest page and the lowest music of the work', () => {
    expect(paper).toEqual({ first: 1300, w: 1300, h: 1900, low: 1810, sys: 200 });
  });
  it('without placed measures, the music is taken to reach the bottom of the paper', () => {
    expect(paperOf([{ w: 1000, h: 1400, measures: [] }]).low).toBe(1400);
  });
  it('has a default page for a work without images', () => {
    expect(paperOf([])).toEqual({ first: 1300, w: 1300, h: 1900, low: 1900, sys: 0 });
  });
});

describe('fitPages', () => {
  it('a phone: one page fitted to the width, whatever the height and the list', () => {
    expect(fitPages({ w: 360, h: 400 }, paper, 0, 52)).toEqual({ narrow: true, count: 1, scale: 344 / 1300, dock: 0, room: false });
    expect(fitPages({ w: 360, h: 400 }, paper, LIST_W, 52).scale).toBe(344 / 1300);
  });

  it('a wide screen: the tallest page fits and the music of every page stays above the navigator', () => {
    const f = fitPages({ w: 1900, h: 700 }, paper, 0, NAV);
    expect(f.narrow).toBe(false);
    expect(f.count).toBe(2);
    expect(8 + 1900 * f.scale).toBeLessThanOrEqual(700 - 8 + 1e-6); // the tallest page, with its margins
    expect(8 + 1810 * f.scale).toBeCloseTo(700 - NAV, 6); // the lowest music: just above the navigator
  });

  it('the navigator costs nothing when the paper has a deep bottom margin', () => {
    const deep = paperOf([{ w: 1300, h: 1900, measures: [box(1600)] }]);
    expect(fitPages({ w: 1900, h: 700 }, deep, 0, NAV).scale).toBeCloseTo((700 - 16) / 1900, 9);
  });

  it('two pages only when both fit at that size; a single page never wider than the area', () => {
    expect(fitPages({ w: 800, h: 900 }, paper, 0, NAV).count).toBe(1);
    const tall = fitPages({ w: 760, h: 2000 }, paper, 0, NAV);
    expect(tall.count).toBe(1);
    expect(1300 * tall.scale).toBeCloseTo(720, 6);
  });

  it('the list in the margin: the pages stay centred in the whole area', () => {
    const f = fitPages({ w: 1900, h: 700 }, paper, LIST_W, NAV);
    expect(f).toMatchObject({ count: 2, dock: 0, room: true });
    expect(f.scale).toBe(fitPages({ w: 1900, h: 700 }, paper, 0, NAV).scale);
  });

  it('not enough margin: the same pages move over just as far as the list needs (12 px from it)', () => {
    const whole = fitPages({ w: 1366, h: 600 }, paper, 0, NAV);
    const f = fitPages({ w: 1366, h: 600 }, paper, LIST_W, NAV);
    expect(whole.count).toBe(2);
    expect(f).toMatchObject({ count: 2, scale: whole.scale, room: true });
    const width = 2 * 1300 * f.scale + 18;
    const left = f.dock + (1366 - f.dock - width) / 2; // centred in what `dock` leaves
    expect(left).toBeCloseTo(LIST_W + 12, 6);
    expect(1366 - left - width).toBeGreaterThanOrEqual(20); // and a margin at the right
    // a little less margin, a little more offset: no jump from one size of the line to the next
    const g = fitPages({ w: 1366, h: 610 }, paper, LIST_W, NAV);
    expect(g.dock - f.dock).toBeGreaterThan(0);
    expect(g.dock - f.dock).toBeLessThan(20);
  });

  it('fewer or smaller pages beside the list: they stay where they are, the list goes over them', () => {
    // two pages fit the area but not what the list leaves
    const two = fitPages({ w: 1000, h: 640 }, paper, 0, NAV);
    expect(two.count).toBe(2);
    expect(fitPages({ w: 1000, h: 640 }, paper, LIST_W, NAV)).toMatchObject({ count: 2, scale: two.scale, dock: 0, room: false });
    // a tablet held upright: the page fills the width
    const one = fitPages({ w: 820, h: 1400 }, paper, 0, NAV);
    expect(fitPages({ w: 820, h: 1400 }, paper, LIST_W, NAV)).toMatchObject({ count: 1, scale: one.scale, dock: 0, room: false });
  });
});

describe('fitPages, the phone layout', () => {
  it('a phone lying down showing the page alone: fitted to the width, however wide the area', () => {
    expect(fitPages({ w: 780, h: 254 }, paper, 0, 52, true)).toEqual({ narrow: true, count: 1, scale: 764 / 1300, dock: 0, room: false });
    expect(fitPages({ w: 932, h: 324 }, paper, 0, 52, true)).toMatchObject({ narrow: true, count: 1, scale: 916 / 1300 });
    // the same area on a wide screen: whole pages fitted to the height
    expect(fitPages({ w: 780, h: 254 }, paper, 0, 52).narrow).toBe(false);
  });
  it('an area not displayed (no size): no negative scale', () => {
    expect(fitPages({ w: 0, h: 0 }, paper, 0, 52, true).scale).toBe(0);
  });
  // a choir with piano: systems 740 px high on pages 1300 px wide (0.57 of the width)
  const choir = paperOf([{ w: 1300, h: 1800, measures: [{ ...box(900), y0: 160 }] }]);
  it('a tablet lying down showing the page alone: a whole system above the navigator, the page in the middle', () => {
    expect(choir.sys).toBe(740);
    const f = fitPages({ w: 960, h: 494 }, choir, 0, 52, true);
    expect(f).toMatchObject({ narrow: true, count: 1 });
    expect(740 * f.scale).toBeCloseTo(494 - 64 - 24, 6); // the system, 12 px above and below, over the navigator
    expect(1300 * f.scale).toBeGreaterThan(0.6 * 944);
    expect(1300 * f.scale).toBeLessThan(944);
  });
  it('a phone lying down: a whole system would make the page too small, it keeps the width', () => {
    expect(fitPages({ w: 780, h: 254 }, choir, 0, 52, true).scale).toBe(764 / 1300);
    expect(fitPages({ w: 932, h: 324 }, choir, 0, 52, true).scale).toBe(916 / 1300);
  });
  it('systems that fit at the full width, measures not placed, or half of a screen: the width', () => {
    expect(fitPages({ w: 960, h: 494 }, paper, 0, 52, true).scale).toBe(944 / 1300); // systems of 200 px
    expect(fitPages({ w: 960, h: 494 }, paperOf([{ w: 1300, h: 1800, measures: [] }]), 0, 52, true).scale).toBe(944 / 1300);
    expect(fitPages({ w: 480, h: 494 }, choir, 0, 52, true).scale).toBe(464 / 1300); // « Les deux »
    expect(fitPages({ w: 360, h: 250 }, choir, 0, 52, true).scale).toBe(344 / 1300); // a phone held upright
  });
});

describe('followTop: where the pages scroll to keep the measure being played in sight', () => {
  const CLEAR = 190; // a phone lying down: 254 px of pages, 64 px for the navigator
  it('a system that fits: nothing moves while it is in sight, else its top comes to the top', () => {
    expect(followTop(100, 300, 120, 200, null)).toBeNull();
    expect(followTop(100, 300, 120, 200, { top: 180, h: 40 })).toBeNull(); // its staves change nothing
    expect(followTop(100, 300, 420, 200, null)).toBe(408); // below
    expect(followTop(500, 300, 120, 200, null)).toBe(108); // above
    expect(followTop(100, 300, 220, 200, null)).toBe(208); // its bottom under the navigator
  });
  it('a taller system: the followed voice in the middle of what is clear', () => {
    // system from 1000 to 1435, the tenor's staff from 1180 to 1260
    const top = followTop(0, CLEAR, 1000, 435, { top: 1180, h: 80 })!;
    expect(top).toBe(1220 - (CLEAR + 10) / 2);
    expect(1180 - top).toBeGreaterThanOrEqual(10); // in sight, above the navigator
    expect(1260 - top).toBeLessThanOrEqual(CLEAR);
    // the next measures of that system: the staff is in sight, nothing moves
    expect(followTop(top, CLEAR, 1000, 435, { top: 1180, h: 80 })).toBeNull();
    // the user moved the page a little, the staff still in sight: left alone
    expect(followTop(top + 30, CLEAR, 1000, 435, { top: 1180, h: 80 })).toBeNull();
  });
  it('a taller system the music has just come to is placed, even with the voice already in sight', () => {
    const band = { top: 1180, h: 80 };
    const placed = followTop(0, CLEAR, 1000, 435, band)!;
    // a jump, the next system, another page: the page was left a little off
    expect(followTop(placed + 30, CLEAR, 1000, 435, band)).toBeNull();
    expect(followTop(placed + 30, CLEAR, 1000, 435, band, true)).toBe(placed);
    expect(followTop(placed, CLEAR, 1000, 435, band, true)).toBeNull(); // already there
    // a system that fits is not moved for that
    expect(followTop(100, 300, 120, 200, { top: 180, h: 40 }, true)).toBeNull();
  });
  it('the top and bottom voices do not leave their system', () => {
    // the soprano: the top of the system, as when it fits
    expect(followTop(0, CLEAR, 1000, 435, { top: 1005, h: 80 })).toBe(988);
    // the piano: the bottom of the system just above the navigator
    expect(followTop(0, CLEAR, 1000, 435, { top: 1300, h: 135 })).toBe(1435 + 12 - CLEAR);
    // a band reaching a little above its system (room for ledger lines): still in sight
    const t = followTop(0, CLEAR, 1000, 435, { top: 990, h: 80 })!;
    expect(990 - t).toBeGreaterThanOrEqual(10);
  });
  it('a voice taller than the area (two staves, enlarged): its top', () => {
    expect(followTop(0, CLEAR, 1000, 900, { top: 1400, h: 300 })).toBe(1388);
  });
  it('a taller system without its staves: its top, as before', () => {
    expect(followTop(0, CLEAR, 1000, 435, null)).toBe(988);
  });
});

describe('followTop: enlarged pages, the music under « Page entière », the voices before the piano', () => {
  // an upright phone: 399 px of pages, 64 px for the navigator; « Page entière » ends 50 px under
  // the top of the pages: 56 px are kept clear
  const CLEAR = 335;
  const HEAD = 56;
  // a system from 1000: the four voices down to 1215 (the bass's words), the piano under them
  const choir = { top: 1000, h: 215 };
  const tenor = { top: 1112, h: 51 };
  it('a system that fits under the button: whole, its top under the button', () => {
    expect(followTop(0, CLEAR, 1000, 250, tenor, true, choir, HEAD)).toBe(944);
    expect(followTop(944, CLEAR, 1000, 250, tenor, false, choir, HEAD)).toBeNull(); // in place
    // left with its top under the button: brought back out
    expect(followTop(970, CLEAR, 1000, 250, tenor, false, choir, HEAD)).toBe(944);
    // without the button, the usual room
    expect(followTop(0, CLEAR, 1000, 250, tenor, true, choir)).toBe(988);
  });
  it('a system too tall whose voices fit: from its top, the piano under the navigator', () => {
    const to = followTop(0, CLEAR, 1000, 321, tenor, true, choir, HEAD)!;
    expect(to).toBe(944); // the soprano's staff clear of the button
    expect(1215 - to).toBeLessThanOrEqual(CLEAR + 12); // the bass's words above the navigator
    expect(1321 - to).toBeGreaterThan(CLEAR); // the end of the piano is not
    // whichever of the voices is followed
    expect(followTop(0, CLEAR, 1000, 321, { top: 1005, h: 51 }, true, choir, HEAD)).toBe(to);
    expect(followTop(0, CLEAR, 1000, 321, { top: 1164, h: 51 }, true, choir, HEAD)).toBe(to);
    // the user goes down to read the piano, the tenor's staff still in sight: left alone
    expect(followTop(to + 30, CLEAR, 1000, 321, tenor, false, choir, HEAD)).toBeNull();
    // the same system without the button (not enlarged: it would fit): unchanged
    expect(followTop(0, CLEAR, 1000, 321, tenor, true, choir)).toBe(988);
  });
  it('the accompanist keeps the piano: the bottom of the system', () => {
    expect(followTop(0, CLEAR, 1000, 421, { top: 1290, h: 131 }, true, null, HEAD)).toBe(1421 + 12 - CLEAR);
  });
  it('the voices just too tall: they go down to the navigator before their top goes under the button', () => {
    // the voices down to 1291: they fit between the button and the navigator itself (12 px under
    // what is kept clear for the followed voice)
    const to = followTop(0, CLEAR, 1000, 400, { top: 1150, h: 70 }, true, { top: 1000, h: 291 }, HEAD)!;
    expect(to).toBe(944);
    expect(1291 - to).toBe(CLEAR + 12);
    // 9 px more: the top of the system slips that much under the button's room
    expect(followTop(0, CLEAR, 1000, 400, { top: 1150, h: 70 }, true, { top: 1000, h: 300 }, HEAD)).toBe(953);
    // the bass followed keeps its own words clear of the navigator's room
    expect(followTop(0, CLEAR, 1000, 400, { top: 1230, h: 70 }, true, { top: 1000, h: 300 }, HEAD)).toBe(1300 + 12 - CLEAR);
  });
  it('the voices do not all fit: the followed one in the middle, without leaving the voices', () => {
    const big = { top: 1000, h: 430 }; // twice the size: the voices down to 1430, the piano to 1642
    // the soprano: the top of the system, under the button
    expect(followTop(0, CLEAR, 1000, 642, { top: 1010, h: 102 }, true, big, HEAD)).toBe(944);
    // the bass: its words just above the navigator, rather than the piano
    expect(followTop(0, CLEAR, 1000, 642, { top: 1328, h: 102 }, true, big, HEAD)).toBe(1430 + 12 - CLEAR);
    // between them: in the middle of what is clear, between the button and the navigator
    const alto = followTop(0, CLEAR, 1000, 642, { top: 1112, h: 102 }, true, { top: 1000, h: 600 }, HEAD)!;
    expect(1112 + 51 - alto).toBe((HEAD - 2 + CLEAR) / 2);
  });
  it('the followed voice comes before the room under the button', () => {
    // a phone lying down, enlarged: 186 px clear, a staff of 140 px does not fit under the button
    const to = followTop(0, 186, 1000, 900, { top: 1300, h: 140 }, true, { top: 1000, h: 600 }, HEAD)!;
    expect(1300 - to).toBeGreaterThanOrEqual(10);
    expect(1440 - to).toBeLessThanOrEqual(186); // whole above the navigator
    // as without the button
    expect(to).toBe(followTop(0, 186, 1000, 900, { top: 1300, h: 140 }, true, { top: 1000, h: 600 }));
  });
});
