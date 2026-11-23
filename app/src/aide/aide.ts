// The help page (aide.html): the contents follow the reading, and the short video stays still for
// those who asked their system for less motion.

// reduced motion: the video waits, with its controls, on its first image
const video = document.getElementById('demo-video') as HTMLVideoElement | null;
if (video && matchMedia('(prefers-reduced-motion: reduce)').matches) {
  video.removeAttribute('autoplay');
  video.pause();
  video.controls = true;
}

// the section being read is marked in the contents (and kept in view in the phones' strip)
const links = new Map<string, HTMLAnchorElement>();
for (const a of document.querySelectorAll<HTMLAnchorElement>('.toc-list a')) links.set(a.hash.slice(1), a);
const sections = [...links.keys()].map((id) => document.getElementById(id)).filter((s): s is HTMLElement => !!s);
let current = '';
const mark = () => {
  // the last section whose top is above the upper third of the screen
  const y = innerHeight / 3;
  let id = sections[0]?.id ?? '';
  for (const s of sections) if (s.getBoundingClientRect().top <= y) id = s.id;
  if (id === current) return;
  links.get(current)?.classList.remove('here');
  current = id;
  const a = links.get(id);
  if (!a) return;
  a.classList.add('here');
  const strip = a.closest('.toc-list') as HTMLElement | null;
  if (strip && strip.scrollWidth > strip.clientWidth) {
    strip.scrollTo({ left: a.offsetLeft - strip.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' });
  }
};
let queued = false;
addEventListener(
  'scroll',
  () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mark();
    });
  },
  { passive: true },
);
mark();

