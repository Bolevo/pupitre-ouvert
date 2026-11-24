// The work's information sheet (fiche.md in the pack): per movement, one line (tempo, key, meter), the text to learn and its translation.
// It opens over the pages only: the line of my voice and the transport stay usable, the music
// may go on. It opens at the current movement's section; links « #mv:<id> » play a movement.
// « Apprendre le texte » turns the panel into the text-learning view (Memo), from the same text.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ficheOpen, movement, playMovement, work } from '../state';
import { renderMarkdown } from '../util/markdown';
import type { LoadedPack, Movement } from '../pack/types';
import { Icon } from './Icon';
import { movementNumber } from './Bars';
import { dropStrayCaret } from './popover';
import { parseFiche } from '../memo/text';
import { Memo } from './Memo';
import { tt } from '../i18n';

const texts = new WeakMap<LoadedPack, Promise<string>>();
function ficheText(w: LoadedPack): Promise<string> {
  let p = texts.get(w);
  if (!p) texts.set(w, (p = w.getFile(w.pack.fiche!)));
  return p;
}

/** The `##` section about movement `mv`: the one linking to it (#mv:<id>), else the one whose
 *  heading starts with its number (« 2 · Et in terra pax », « II · Andante »). */
export function sectionOf(root: HTMLElement, mv: Movement): HTMLElement | null {
  const heads = Array.from(root.querySelectorAll<HTMLElement>('h2'));
  for (const h of heads) {
    for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
      if (el.querySelector(`a[data-mv="${CSS.escape(mv.id)}"]`)) return h;
    }
  }
  const num = movementNumber(mv.title);
  const re = new RegExp(`^\\s*(n°\\s*)?${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
  return heads.find((h) => re.test(h.textContent ?? '')) ?? null;
}

export function Fiche() {
  const w = work.value;
  const mv = movement.value;
  const [html, setHtml] = useState<string | null>(null);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const [memo, setMemo] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const memoBtn = useRef<HTMLButtonElement>(null);
  const sections = useMemo(() => (src ? parseFiche(src) : []), [src]);

  useEffect(() => {
    if (!w?.pack.fiche) return;
    let ok = true;
    setHtml(null);
    setFailed(false);
    setMemo(false);
    ficheText(w)
      .then((t) => {
        if (!ok) return;
        setSrc(t);
        setHtml(t.trim() ? renderMarkdown(t) : '');
      })
      .catch(() => ok && setFailed(true));
    return () => {
      ok = false;
    };
  }, [w]);

  // at the current movement's section once the text is there
  useEffect(() => {
    const el = body.current;
    if (!el || html === null || !mv || memo) return;
    const h = sectionOf(el, mv);
    el.scrollTop = h ? h.offsetTop - 8 : 0;
  }, [html, memo]);

  // Escape closes (popovers catch their own Escape first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ficheOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    closeBtn.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      dropStrayCaret(); // text selected in the sheet would leave a caret behind
    };
  }, []);

  const content = useMemo(() => (html ? { __html: html } : null), [html]);
  if (!w?.pack.fiche) return null;
  const close = () => (ficheOpen.value = false);
  if (memo && sections.length)
    return (
      <section class="fiche" role="dialog" aria-label={tt('Fiche de l’œuvre')}>
        <Memo
          sections={sections}
          workId={w.pack.id}
          title={`${w.pack.composer} — ${w.pack.title}`}
          onClose={close}
          onBack={() => {
            setMemo(false);
            setTimeout(() => memoBtn.current?.focus({ preventScroll: true }), 0);
          }}
        />
      </section>
    );
  return (
    <section class="fiche" role="dialog" aria-label={tt('Fiche de l’œuvre')}>
      <header class="fiche-head">
        <Icon name="book" size={18} />
        <div class="fiche-title">
          <b>{tt('Fiche de l’œuvre')}</b>
          <span>
            {w.pack.composer} — {w.pack.title}
          </span>
        </div>
        {sections.length > 0 && (
          <button class="fiche-memo" ref={memoBtn} aria-label={tt('Apprendre le texte')} title={tt('Apprendre le texte par cœur : texte à trous, au clavier')} onClick={() => setMemo(true)}>
            <Icon name="memo" size={18} />
            <span>
              {tt('Apprendre')}<span class="fiche-memo-long"> {tt('le texte')}</span>
            </span>
          </button>
        )}
        <button class="fiche-close" ref={closeBtn} aria-label={tt('Fermer la fiche')} title={tt('Fermer (Échap)')} onClick={close}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div
        class="fiche-body"
        ref={body}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a');
          if (!a) return;
          const id = a.getAttribute('data-mv');
          if (id) {
            e.preventDefault();
            if (w.pack.movements.some((m) => m.id === id)) {
              playMovement(id);
              close();
            }
          } else if (a.getAttribute('href')?.startsWith('#')) {
            // a heading of the sheet itself
            e.preventDefault();
            const t = body.current?.querySelector<HTMLElement>(`[id="${CSS.escape(a.getAttribute('href')!.slice(1))}"]`);
            if (t && body.current) body.current.scrollTop = t.offsetTop - 8;
          }
        }}
      >
        {failed ? (
          <p class="fiche-empty">{tt('La fiche n’a pas pu être lue.')}</p>
        ) : html === null ? (
          <p class="fiche-empty">{tt('Chargement…')}</p>
        ) : html === '' ? (
          <p class="fiche-empty">{tt('La fiche n’est pas disponible sur cet appareil : rechargez la page.')}</p>
        ) : (
          <article class="md" dangerouslySetInnerHTML={content!} />
        )}
      </div>
    </section>
  );
}
