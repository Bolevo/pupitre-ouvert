import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { between, ficheOpen, importZip, removeOpenWork, prefs as prefsSig, setEndMode, setMetro, setMetroSub, type EndMode, movement, myModeOf, myPart, setMyMode, trackOf, openMovement, openWork, replayMine, playing, position, seekParked, setSideView, setTracksOpen, sideView, type SideView, toggle, tracksOpen, work, works } from '../state';
import { measureIndexAt } from './timing';
import { TempoControl } from './Tempo';
import { Icon } from './Icon';
import { Volume } from './Volume';
import { useDismiss } from './popover';
import { now } from './now';
import type { MetroSub } from '../audio/metronome';
import { helpPage, partLabel, tt, ttKey } from '../i18n';

/** Work and movements. */
export function TopBar() {
  const w = work.value;
  const mv = movement.value;
  const nav = useRef<HTMLElement>(null);
  // the current movement and its two neighbours in view, with the least scrolling (the tabs do not
  // move when they are already visible)
  useLayoutEffect(() => {
    const n = nav.current;
    const cur = n?.querySelector<HTMLElement>('button.on');
    if (n && cur) showWithNeighbours(n, cur);
  }, [mv?.id, w?.pack.id]);
  return (
    <header class="topbar">
      <div class="title">
        <select
          class="work-select"
          value={w?.pack.id}
          aria-label={tt('Œuvre')}
          onChange={(e) => {
            const sel = e.target as HTMLSelectElement;
            const chosen = sel.value;
            if (chosen !== IMPORT && chosen !== REMOVE) return void openWork(chosen);
            sel.value = w?.pack.id ?? ''; // the two actions of the list are not works
            if (chosen === IMPORT) pickZip();
            else if (w && confirm(tt('Retirer « {title} » de cet appareil ?\n\nSes enregistrements et la progression de son texte sont effacés aussi. Votre fichier .zip n’est pas touché : vous pourrez l’ajouter de nouveau.', { title: w.pack.title }))) void removeOpenWork();
          }}
        >
          {works.value.map((x) => (
            <option value={x.id}>{x.composer ? `${x.composer} — ${x.title}` : x.title}</option>
          ))}
          <option value={IMPORT}>{tt('Ajouter une partition (.zip)…')}</option>
          {/* only a work added here can be removed (the example comes with the app) */}
          {w?.source === 'imported' && <option value={REMOVE}>{tt('Retirer « {title} »…', { title: w.pack.title })}</option>}
        </select>
      </div>
      <MetroControl />
      <EndModeControl />
      {w && (
        <div class="mv-row">
          {w.pack.fiche && (
            <button
              class={`fiche-btn ${ficheOpen.value ? 'on' : ''}`}
              aria-pressed={ficheOpen.value}
              aria-label={tt('Fiche de l’œuvre')}
              title={tt('Fiche de l’œuvre : structure, texte et traduction')}
              onClick={() => (ficheOpen.value = !ficheOpen.value)}
            >
              <Icon name="book" size={19} />
            </button>
          )}
          {w.pack.movements.length > 1 && (
            <nav class="movements" aria-label={tt('Mouvements')} ref={nav}>
              {w.pack.movements.map((m) => (
                <button
                  class={m.id === mv?.id ? 'on' : ''}
                  aria-current={m.id === mv?.id ? 'true' : undefined}
                  onClick={() => openMovement(m.id)}
                  title={m.title}
                  aria-label={m.title}
                >
                  {/* many movements: the others show only their number, the current one its full title */}
                  {w.pack.movements.length > 4 && m.id !== mv?.id ? movementNumber(m.title) : shortTitle(m.title)}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
    </header>
  );
}

const IMPORT = '__import__';
const REMOVE = '__remove__';

/** The help page (aide.html, or help.html in English), in a tab of its own: the rehearsal stays where it is. A
 *  round button floating at the top right of the pages' area (wide screens; phones have the help
 *  in the track list), or a sentence (`text`, on the first screen). */
export function HelpLink({ text }: { text?: string }) {
  if (text)
    return (
      <a class="help-link" href={helpPage()} target="_blank" rel="noopener">
        {text}
      </a>
    );
  return (
    <a class="help-btn" href={helpPage()} target="_blank" rel="noopener" aria-label={tt('Aide : comment se servir de Pupitre Ouvert')} title={tt('Aide : comment se servir de Pupitre Ouvert')}>
      <Icon name="help" size={19} />
    </a>
  );
}

const METRO_SUBS: [MetroSub, string][] = [
  ['beat', ttKey('Les temps de la mesure')],
  ['measure', ttKey('Le 1er temps seulement')],
  ['half', ttKey('Les blanches')],
  ['quarter', ttKey('Les noires')],
  ['eighth', ttKey('Les croches')],
];

/** Metronome: the button turns it on / off, the arrow chooses what it beats. */
function MetroControl() {
  const p = prefsSig.value;
  const on = !!p.metro;
  const sub = p.metroSub ?? 'beat';
  const [open, setOpen] = useState(false);
  const [hint, flash] = useTimed<string>(1600);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false)); // a press outside or Escape closes the menu
  // the time signature where the music is (a movement may change it: Vivaldi 9 goes to 3/2)
  const mv = movement.value;
  const n = open ? now.value : null;
  const ts = mv?.measures[n && n.mv === mv ? n.i : 0]?.ts;
  return (
    <div class={`metro ${on ? 'on' : ''}`} ref={box}>
      <button
        class="metro-toggle"
        aria-pressed={on}
        aria-label={tt('Métronome')}
        title={on ? tt('Couper le métronome') : tt('Métronome')}
        onClick={() => {
          setMetro(!on);
          flash(on ? tt('Métronome coupé') : tt('Métronome'));
        }}
      >
        <Icon name="metronome" size={19} />
        <span>{tt('Métronome')}</span>
      </button>
      <button class="metro-more" aria-label={tt('Réglage du métronome')} aria-expanded={open} title={tt('Ce que bat le métronome')} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="metro-menu" role="radiogroup" aria-label={tt('Le métronome bat')}>
          <div class="metro-menu-title">{tt('Le métronome bat')}</div>
          {METRO_SUBS.map(([v, label]) => (
            <button
              role="radio"
              aria-checked={sub === v}
              class={sub === v ? 'on' : ''}
              onClick={() => {
                setMetroSub(v);
                setOpen(false);
              }}
            >
              {tt(label)}
              {v === 'beat' && ts ? <small> ({ts[0]}/{ts[1]})</small> : null}
            </button>
          ))}
        </div>
      )}
      {hint && !open && <div class="end-hint metro-hint" role="status">{hint}</div>}
    </div>
  );
}

// mode, icon, the word shown, its full name, and the same in the confirmation bubble
const END_MODES: [EndMode, string, string, string, string][] = [
  ['stop', 'end-stop', ttKey('Arrêt'), ttKey('À la fin du mouvement : s’arrêter'), ttKey('Fin du mouvement : s’arrêter')],
  ['loop', 'end-loop', ttKey('Boucle'), ttKey('À la fin du mouvement : le rejouer depuis le début'), ttKey('Fin du mouvement : le rejouer depuis le début')],
  ['next', 'end-next', ttKey('Enchaîner'), ttKey('À la fin du mouvement : enchaîner le suivant'), ttKey('Fin du mouvement : enchaîner le suivant')],
];

/** What happens at the end of a movement. */
function EndModeControl() {
  const cur = prefsSig.value.endMode ?? 'stop';
  // phones show only the icons: a choice is confirmed in words for a moment
  const [hint, setHint] = useTimed<string>(1800);
  return (
    <div class="end-mode" role="radiogroup" aria-label={tt('À la fin du mouvement')}>
      {END_MODES.map(([mode, icon, label, title, said]) => (
        <button
          role="radio"
          aria-checked={cur === mode}
          class={cur === mode ? 'on' : ''}
          title={tt(title)}
          aria-label={tt(title)}
          onClick={() => {
            setEndMode(mode);
            setHint(tt(said));
          }}
        >
          <Icon name={icon} size={18} />
          <span>{tt(label)}</span>
        </button>
      ))}
      {hint && <div class="end-hint" role="status">{hint}</div>}
    </div>
  );
}

/** Opens the file picker for a work's .zip. */
export function pickZip() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.onchange = () => input.files?.[0] && void importZip(input.files[0]);
  input.click();
}

export function movementNumber(t: string) {
  return t.match(/^([IVX]+|\d+)\./)?.[1] ?? t;
}

/** The title in its tab: "8. Domine Deus, Agnus Dei (Alto solo e coro)" -> "8 · Domine Deus, Agnus
 *  Dei" (the whole title in its tooltip); a title still too long ends in "…" (CSS). */
export function shortTitle(t: string) {
  return t.replace(/^([IVX]+|\d+)\.\s*/, '$1 · ').replace(/\s*\([^)]*\)\s*$/, '');
}

/** Scrolls the tabs so that `cur` and the tabs on either side of it are visible, as little as
 *  possible (not at all when they already are). */
function showWithNeighbours(nav: HTMLElement, cur: HTMLElement) {
  const box = nav.getBoundingClientRect();
  const a = (cur.previousElementSibling as HTMLElement | null) ?? cur;
  const b = (cur.nextElementSibling as HTMLElement | null) ?? cur;
  const left = a.getBoundingClientRect().left - box.left + nav.scrollLeft;
  const right = b.getBoundingClientRect().right - box.left + nav.scrollLeft;
  let x = nav.scrollLeft;
  if (right > x + nav.clientWidth) x = right - nav.clientWidth;
  if (left < x) x = left;
  if (x !== nav.scrollLeft) nav.scrollLeft = x;
}

/** A value shown for a moment (a confirmation bubble), then gone. */
function useTimed<T>(ms: number): [T | null, (v: T) => void] {
  const [v, setV] = useState<T | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [
    v,
    (x: T) => {
      setV(x);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setV(null), ms);
    },
  ];
}

// each name begins with the word shown: what is read is what is said
const SIDE_VIEWS: [SideView, string, string][] = [
  ['line', ttKey('Ligne'), ttKey('Ligne de ma voix seule')],
  ['page', ttKey('Page'), ttKey('Page seule')],
  ['both', ttKey('Les deux'), ttKey('Les deux : la page et la ligne côte à côte')],
];

/** A phone lying down: the line of my voice, the printed page, or both side by side (the bottom
 *  bar has room for it there; styles.css shows it nowhere else). */
function SideViewControl() {
  const cur = sideView.value;
  return (
    <div class="side-view" role="radiogroup" aria-label={tt('Affichage')}>
      {SIDE_VIEWS.map(([view, label, title]) => (
        <button role="radio" aria-checked={cur === view} class={cur === view ? 'on' : ''} aria-label={tt(title)} title={tt(title)} onClick={() => setSideView(view)}>
          <Icon name={`view-${view}`} size={18} />
          <span>{tt(label)}</span>
        </button>
      ))}
    </div>
  );
}

/** Play, replay, tempo, my voice, tracks (and, on computers, the general volume): the bottom bar
 *  of a phone, the block at the left of the line on a wide screen (styles.css). */
export function Transport() {
  const mv = movement.value;
  const me = mv?.parts.find((x) => x.id === myPart.value);
  const myName = me ? partLabel(me.name) : '';
  const myTrack = me ? trackOf(me) : null; // reads prefs: re-renders when the track settings change
  const myMode = myTrack ? myModeOf(myTrack) : 'on';

  // keyboard: space play/pause, arrows by measure
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      const m = movement.value;
      if (!m) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const i = measureIndexAt(m, position() + 30);
        const j = Math.max(0, Math.min(m.measures.length - 1, i + (e.code === 'ArrowRight' ? 1 : -1)));
        seekParked(m.measures[j].t);
      } else if (e.code === 'Home') seekParked(0);
      else if (e.code === 'KeyR') void replayMine();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <footer class="transport">
      <div class="t-play">
        <button
          class="ctl replay"
          aria-label={tt('Réécouter {name} seul depuis la mesure précédente, puis continuer', { name: myName })}
          title={tt('Réécouter : la mesure précédente avec {name} seul, puis la suite normalement (R)', { name: myName })}
          onClick={() => void replayMine()}
        >
          <Icon name="replay" />
        </button>
        <button class="play" aria-label={playing.value || between.value ? tt('Pause') : tt('Lecture')} title={tt('Lecture / pause (Espace)')} onClick={toggle}>
          <Icon name={playing.value || between.value ? 'pause' : 'play'} size={26} />
        </button>
        <TempoControl />
      </div>

      <SideViewControl />

      {me && (
        <div class="my-voice" role="radiogroup" aria-label={tt('Ma voix ({name})', { name: myName })}>
          <span class="my-voice-name">{myName}</span>
          {(
            [
              ['on', 'speaker', ttKey('Entendre'), ttKey('Entendre {name} normalement')],
              ['mute', 'speaker-off', ttKey('Muet'), ttKey('Couper {name} pour chanter par-dessus')],
              ['solo', 'solo', ttKey('Seul'), ttKey('{name} seul (comme S dans les réglages)')],
              ['support', 'support', ttKey('Soutien'), ttKey('Soutien : chaque note de {name} ne sonne qu’à sa seconde moitié (chanter d’abord, vérifier ensuite)')],
            ] as const
          ).map(([mode, icon, label, title]) => (
            <button
              role="radio"
              aria-checked={myMode === mode}
              class={`mv-${mode} ${myMode === mode ? 'on' : ''}`}
              aria-label={tt('{label} ma voix ({name})', { label: tt(label), name: myName })}
              title={tt(title, { name: myName })}
              onClick={() => setMyMode(me, mode)}
            >
              <Icon name={icon} size={18} />
              <span>{tt(label)}</span>
            </button>
          ))}
        </div>
      )}

      <button class={`ctl tracks-toggle ${tracksOpen.value ? 'on' : ''}`} aria-expanded={tracksOpen.value} aria-controls="pistes" aria-label={tt('Réglages')} onClick={() => setTracksOpen(!tracksOpen.value)} title={tt('Réglages : chaque voix (suivre, solo, muet, volume, instrument), affichage')}>
        <Icon name="mixer" />
        <span>{tt('Réglages')}</span>
      </button>
      <Volume />
    </footer>
  );
}
