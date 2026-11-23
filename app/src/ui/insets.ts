// The safe areas of an iPhone whose page is zoomed out.
//
// Safari's « Page Zoom » under 100 % (Settings › Apps › Safari, or the page menu) makes the page
// wider than the screen: at 50 %, an iPhone of 430 points lays the app out on 860 px, each px half
// a point. But the system still gives the safe areas (env(safe-area-inset-*)) in points: 59 for
// the status bar, taken by the page as 59 px, half of what is hidden. Seen on a colleague's
// iPhone, 15/11/2026: the top bar's first row was under the clock and the Dynamic Island.
// styles.css multiplies the insets by --inset-scale, set here.

/** How many px of the page a screen point is, when more than one (a page zoomed out), else 1.
 *  `screenW`, `screenH`: the screen in points, whichever way it is held (an iPhone always gives
 *  its upright size). A page narrower than the screen (an iPad's split view, a zoom above
 *  100 %) is left alone: its insets are then at least as large as needed. */
export function insetScale(innerW: number, innerH: number, screenW: number, screenH: number): number {
  if (!(innerW > 0 && screenW > 0 && screenH > 0)) return 1;
  const across = innerH >= innerW ? Math.min(screenW, screenH) : Math.max(screenW, screenH);
  const k = innerW / across;
  return k > 1.05 ? Math.round(k * 1000) / 1000 : 1;
}

/** Keeps --inset-scale up to date (the zoom, turning the phone). Apple's touch devices only:
 *  the others either have no such zoom or scale their insets with it. */
export function startInsetScale(): () => void {
  if (typeof navigator === 'undefined' || !('standalone' in navigator)) return () => {};
  const set = () => document.documentElement.style.setProperty('--inset-scale', String(insetScale(innerWidth, innerHeight, screen.width, screen.height)));
  set();
  addEventListener('resize', set);
  return () => removeEventListener('resize', set);
}
