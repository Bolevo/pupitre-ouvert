import { useLayoutEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

/** Closes a small popover on a press outside `box` or on Escape. */
export function useDismiss(open: boolean, box: RefObject<HTMLElement | null>, close: () => void) {
  // attached as the popover is drawn (an effect would come a frame later: an Escape pressed at
  // once, before the focus is inside the popover, was lost)
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      dropStrayCaret();
    };
  }, [open]);
}

/** A text field, or text selected in it, that goes away (a popover or the work's sheet closes)
 *  leaves the document's caret behind, in the page: Chrome then works out where that caret is at
 *  every frame of playback (measured on an emulated phone: twice the main thread's load). Drop it
 *  once the closing is done, unless the user is typing in a field. */
export function dropStrayCaret() {
  setTimeout(() => {
    const s = typeof getSelection === 'function' ? getSelection() : null;
    if (!s || s.type === 'Range') return; // text the user has just selected stays selected
    if (document.activeElement?.matches('input, textarea, select, [contenteditable]')) return;
    // removeAllRanges() alone leaves Chrome's own caret where the field was (measured): move it to
    // the start of the page first, then drop it
    s.collapse(document.body, 0);
    s.removeAllRanges();
  }, 0);
}
