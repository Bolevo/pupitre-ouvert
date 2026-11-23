// Media queries read at the moment they matter (a preference can change while the app is open).
// Each query is parsed once; reading `.matches` costs no layout.

const lists = new Map<string, MediaQueryList>();
const list = (q: string) => {
  if (typeof matchMedia !== 'function') return null;
  let l = lists.get(q);
  if (!l) lists.set(q, (l = matchMedia(q)));
  return l;
};
const media = (q: string) => list(q)?.matches ?? false;

const HOVER = '(hover: hover)';
/** The main pointer can hover (a mouse), unlike a finger. */
export const canHover = () => media(HOVER);
/** Called when the main pointer changes (a tablet taking or leaving its keyboard cover). */
export const onHoverChange = (fn: () => void) => list(HOVER)?.addEventListener('change', fn);

/** The user asked the system for less motion: jump instead of gliding. */
export const reducedMotion = () => media('(prefers-reduced-motion: reduce)');

// A screen lying down too low for the wide layout, whose bars and controls take 270 px or more
// of the height: a phone (500 px at most), and a small tablet or an unfolded phone, touched,
// up to 760 px (wide, its pages would be smaller than on a phone held upright). A computer's
// short window keeps the wide layout: its pages are enlarged with the mouse.
const LOW = '(max-height: 500px)';
const SIDEWAYS = `(orientation: landscape) and ${LOW}, (orientation: landscape) and (max-height: 760px) and (hover: none)`;
// A touched screen narrower than 9:16: a phone held upright, however many px wide its page is
// (zoomed out by the browser: an iPhone at Safari's « Page Zoom » 50 % is 860 px wide).
const TALL = '(hover: none) and (max-aspect-ratio: 9/16)';
const PHONE = `(max-width: 720px), ${SIDEWAYS}, ${TALL}`;
/** The phone layout of styles.css (a narrow screen, a low one lying down, a phone's shape): the
 *  track list takes the line's place while open, the piano's two staves are drawn smaller. Any
 *  other screen has the wide layout (styles.css › wide screens). The same conditions as in
 *  styles.css. */
export const phoneLayout = () => media(PHONE);
/** Called when the window passes from one layout to the other. */
export const onLayoutChange = (fn: () => void) => list(PHONE)?.addEventListener('change', fn);
/** A phone's height lying down (500 px at most): side by side, the page and the line of my
 *  voice are small there (state.ts › sideView). */
export const lowScreen = () => media(LOW);
/** Called when the screen becomes that low or no longer is. */
export const onLowScreenChange = (fn: () => void) => list(LOW)?.addEventListener('change', fn);
