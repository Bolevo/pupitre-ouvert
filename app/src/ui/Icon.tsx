const P: Record<string, string> = {
  play: 'M7 4.5l13 7.5-13 7.5z',
  pause: 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z',
  first: 'M6 5v14M19 5L9 12l10 7z',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'eye-off': 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z',
  mixer: 'M5 4v16M12 4v16M19 4v16M3 15h4M10 8h4M17 13h4',
  close: 'M6 6l12 12M18 6L6 18',
  speaker: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  'speaker-off': 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  // silence (dots) then sound (a wave): the note is heard only in its second half
  support: 'M2.5 12h.01M6.5 12h.01M10.5 12c1.4-6 3.6-6 5 0s3.6 6 5 0',
  // one singer
  solo: 'M12 3.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM5 20.5c0-4 3.1-6.8 7-6.8s7 2.8 7 6.8',
  // end of a movement: stop (play to a bar), loop, go on (two arrows)
  'end-stop': 'M5 6l8 6-8 6zM18 6v12',
  'end-loop': 'M17 3l3 3-3 3M4 12v-1a5 5 0 0 1 5-5h11M7 21l-3-3 3-3M20 12v1a5 5 0 0 1-5 5H4',
  'end-next': 'M3.5 6l7 6-7 6zM13 6l7 6-7 6z',
  // a metronome: the body and its pendulum
  metronome: 'M6.5 21h11L14.5 3.5h-5zM12 15.5l5.5-9M8.6 15.5h6.8',
  chevron: 'M6 9l6 6 6-6',
  replay: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  // an open book: the work's information sheet
  // a question in a circle: the help page
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.4 9.4a2.6 2.6 0 1 1 3.7 2.4c-.7.3-1.1.9-1.1 1.6v.5M12 16.9v.2',
  book: 'M12 6.5C10.3 5 7.8 4.5 4 4.5v13c3.8 0 6.3.5 8 2 1.7-1.5 4.2-2 8-2v-13c-3.8 0-6.3.5-8 2zM12 6.5v13',
  'chevron-left': 'M14.5 6l-6 6 6 6',
  'chevron-right': 'M9.5 6l6 6-6 6',
  // lines of text with blanks: learning the text by heart
  memo: 'M3 6.5h7M14 6.5h7M3 12h4M11 12h10M3 17.5h10M17 17.5h4',
  'mv-prev': 'M6 5v14M19 5L9 12l10 7z',
  'mv-next': 'M18 5v14M5 5l10 7-10 7z',
  // « Enregistrer ma voix »: a stop square, a sound wave (my recorded voice; crossed out: off), more
  stop: 'M6 6h12v12H6z',
  wave: 'M3 12h1.5M7 8.5v7M10.5 5v14M14 8v8M17.5 10v4M21 12h-.5',
  'wave-off': 'M3 12h1.5M7 8.5v7M10.5 5v14M14 8v8M17.5 10v4M4 4l16 16',
  // a magnifying glass with a plus: the pages' zoom
  zoom: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6M8 10.5h5M10.5 8v5',
  // a phone lying down shows: the line of my voice (a strip), the printed page, or both
  'view-line': 'M3 8.5h18v7H3zM7 12h10',
  'view-page': 'M7 3.5h10v17H7zM10.5 8.5h3M10.5 12h3M10.5 15.5h3',
  'view-both': 'M3 5h7.5v14H3zM14 8.5h7v7h-7zM16.5 12h2',
  // two sheets, one over the other: copy; a tick: done; an arrow into a tray: save a file
  copy: 'M10.5 8.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5.5 15.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  more: 'M5 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zM12 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zM19 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z',
};
const FILLED = new Set(['play', 'pause', 'stop', 'more']);

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const filled = FILLED.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={filled ? 0 : 2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}
